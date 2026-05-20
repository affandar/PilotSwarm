import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver, ToolRegistration } from "../registry.js";
import type { ObservedResult, ObservedToolCall, RunConfig, Scenario } from "../types.js";
import { effectiveTimeoutMs } from "../engine/effective-config.js";
import {
  mergeToolCalls,
  normalizeCmsEvents,
  promptForScenario,
  promptsForScenario,
  selectedModel,
  stripProviderPrefix,
  toolCallsFromCmsEvents
} from "./observations.js";

type AnyCtor = new (options: Record<string, unknown>) => any;

export type LiveDriverDeps = {
  createEnv?: (suiteName: string) => {
    store: string;
    duroxideSchema: string;
    cmsSchema: string;
    factsSchema: string;
    sessionStateDir: string;
    cleanup?: () => Promise<void>;
  };
  WorkerCtor?: AnyCtor;
  ClientCtor?: AnyCtor;
};

type LiveDriverRunOptions = {
  config?: Partial<RunConfig>;
};

export function createLiveDriver(deps: LiveDriverDeps = {}): Driver {
  return {
    async run(scenario, options) {
      return runLiveScenario(scenario, options as LiveDriverRunOptions | undefined, deps);
    }
  };
}

export function liveDriverFactory(): Driver {
  return createLiveDriver();
}

async function runLiveScenario(
  scenario: Scenario,
  options: LiveDriverRunOptions | undefined,
  deps: LiveDriverDeps,
): Promise<ObservedResult> {
  const startedAt = Date.now();
  const requestedTools = scenario.tools ?? [];
  const observedToolCalls: ObservedToolCall[] = [];
  const turnResponses: string[] = [];
  let env: Awaited<ReturnType<NonNullable<LiveDriverDeps["createEnv"]>>> | undefined;
  let worker: any;
  let client: any;
  let sessionId = "";

  try {
    if (!deps.WorkerCtor && !process.env.GITHUB_TOKEN) {
      throw new Error("GITHUB_TOKEN is required for live evals.");
    }

    const [{ WorkerCtor, ClientCtor, defineTool }, createEnv] = await Promise.all([
      resolveSdk(deps),
      resolveCreateEnv(deps.createEnv),
    ]);
    env = createEnv(`eval_${safeSchemaLabel(scenario.id)}`);
    let turnIndex = 0;
    const { sdkTools, toolNames } = await selectedSdkTools(requestedTools, defineTool, observedToolCalls, {
      turnIndex: () => turnIndex,
    });

    worker = new WorkerCtor({
      store: env.store,
      githubToken: process.env.GITHUB_TOKEN,
      duroxideSchema: env.duroxideSchema,
      cmsSchema: env.cmsSchema,
      factsSchema: env.factsSchema,
      sessionStateDir: env.sessionStateDir,
      workerNodeId: `eval-${randomBytes(4).toString("hex")}`,
      disableManagementAgents: true,
      logLevel: process.env.DUROXIDE_LOG_LEVEL || "error",
    });
    if (sdkTools.length > 0) worker.registerTools(sdkTools);
    await worker.start();

    client = new ClientCtor({
      store: env.store,
      duroxideSchema: env.duroxideSchema,
      cmsSchema: env.cmsSchema,
      factsSchema: env.factsSchema,
    });
    await client.start();

    const sessionConfig: Record<string, unknown> = {};
    if (toolNames.length > 0) sessionConfig.toolNames = toolNames;
    if (scenario.systemMessage) sessionConfig.systemMessage = scenario.systemMessage;
    const model = selectedModel(scenario, options?.config);
    if (model) sessionConfig.model = stripProviderPrefix(model);

    const session = await client.createSession(sessionConfig);
    sessionId = session.sessionId;
    worker.setSessionConfig?.(sessionId, { ...sessionConfig, tools: sdkTools });

    const timeoutMs = effectiveTimeoutMs(scenario, options?.config);
    const prompts = promptsForScenario(scenario);
    for (let index = 0; index < prompts.length; index += 1) {
      turnIndex = index;
      const response = await session.sendAndWait(prompts[index], timeoutMs);
      turnResponses.push(String(response ?? ""));
    }
    const finalResponse = turnResponses.at(-1) ?? "";
    const [info, messages] = await Promise.all([
      session.getInfo?.().catch(() => undefined),
      session.getMessages?.(1000).catch(() => []) ?? [],
    ]);
    const cmsEvents = normalizeCmsEvents(messages);

    return {
      scenarioId: scenario.id,
      finalResponse,
      toolCalls: mergeToolCalls(toolCallsFromCmsEvents(cmsEvents), observedToolCalls),
      cmsEvents,
      latencyMs: Date.now() - startedAt,
      costUsd: 0,
      tokensIn: promptForScenario(scenario).split(/\s+/).filter(Boolean).length,
      tokensOut: turnResponses.join("\n").split(/\s+/).filter(Boolean).length,
      terminalState: info?.status ?? info?.state ?? "completed",
      errored: false,
      metadata: { driver: "live", sessionId, turnResponses },
    };
  } catch (error) {
    return {
      scenarioId: scenario.id,
      finalResponse: turnResponses.at(-1) ?? "",
      toolCalls: observedToolCalls,
      cmsEvents: [],
      latencyMs: Date.now() - startedAt,
      costUsd: 0,
      tokensIn: promptForScenario(scenario).split(/\s+/).filter(Boolean).length,
      tokensOut: turnResponses.join("\n").split(/\s+/).filter(Boolean).length,
      terminalState: "error",
      errored: true,
      metadata: {
        driver: "live",
        sessionId,
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    await client?.stop?.();
    await worker?.stop?.();
    await env?.cleanup?.();
  }
}

export async function resolveSdk(deps: LiveDriverDeps): Promise<{
  WorkerCtor: AnyCtor;
  ClientCtor: AnyCtor;
  defineTool: (name: string, config: Record<string, unknown>) => unknown;
}> {
  if (deps.WorkerCtor && deps.ClientCtor) {
    return {
      WorkerCtor: deps.WorkerCtor,
      ClientCtor: deps.ClientCtor,
      defineTool: (name, config) => ({ name, ...(config as { handler?: unknown }) }),
    };
  }
  const sdk = await import("pilotswarm-sdk");
  return {
    WorkerCtor: sdk.PilotSwarmWorker as unknown as AnyCtor,
    ClientCtor: sdk.PilotSwarmClient as unknown as AnyCtor,
    defineTool: sdk.defineTool as unknown as (name: string, config: Record<string, unknown>) => unknown,
  };
}

export async function resolveCreateEnv(createEnv?: LiveDriverDeps["createEnv"]): Promise<NonNullable<LiveDriverDeps["createEnv"]>> {
  if (createEnv) return createEnv;
  return createDefaultLiveEnv;
}

function createDefaultLiveEnv(suiteName = "eval"): ReturnType<NonNullable<LiveDriverDeps["createEnv"]>> {
  const runId = randomBytes(4).toString("hex");
  const label = safeSchemaLabel(suiteName);
  const baseDir = mkdtempSync(join(tmpdir(), `pilotswarm-eval-${runId}-`));
  const sessionStateDir = join(baseDir, "session-state");
  mkdirSync(sessionStateDir, { recursive: true });
  const store = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/pilotswarm";

  const schemas = {
    duroxideSchema: `ps_eval_duroxide_${label}_${runId}`,
    cmsSchema: `ps_eval_cms_${label}_${runId}`,
    factsSchema: `ps_eval_facts_${label}_${runId}`,
  };

  return {
    store,
    ...schemas,
    sessionStateDir,
    async cleanup() {
      try {
        await dropSchemas(store, schemas);
      } catch {
        // Cleanup should not mask the live eval result. Schemas are unique if a local DB is unavailable.
      } finally {
        rmSync(baseDir, { recursive: true, force: true });
      }
    },
  };
}

async function dropSchemas(
  connectionString: string,
  schemas: { duroxideSchema: string; cmsSchema: string; factsSchema: string },
): Promise<void> {
  const pg = await import("pg");
  const client = new pg.default.Client({ connectionString });
  try {
    await client.connect();
    for (const schema of [schemas.duroxideSchema, schemas.cmsSchema, schemas.factsSchema]) {
      await client.query(`DROP SCHEMA IF EXISTS "${schema.replaceAll("\"", "\"\"")}" CASCADE`);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function selectedSdkTools(
  requestedTools: string[],
  defineTool: (name: string, config: Record<string, unknown>) => unknown,
  observedToolCalls: ObservedToolCall[],
  options: {
    turnIndex?: () => number;
    afterToolCall?: (call: ObservedToolCall, count: number) => Promise<void> | void;
  } = {},
): Promise<{ sdkTools: unknown[]; toolNames: string[] }> {
  const { tools } = await import("../registry.js");
  const missing = requestedTools.filter((name) => !tools.has(name));
  if (missing.length > 0) throw new Error(`Unknown eval tool(s): ${missing.join(", ")}`);

  const selected = requestedTools
    .map((name) => tools.get(name))
    .filter((tool): tool is ToolRegistration => Boolean(tool));
  return {
    toolNames: selected.map((tool) => tool.name),
    sdkTools: selected.map((tool) => toSdkTool(tool, defineTool, observedToolCalls, options)),
  };
}

function toSdkTool(
  tool: ToolRegistration,
  defineTool: (name: string, config: Record<string, unknown>) => unknown,
  observedToolCalls: ObservedToolCall[],
  options: {
    turnIndex?: () => number;
    afterToolCall?: (call: ObservedToolCall, count: number) => Promise<void> | void;
  },
): unknown {
  let callCount = 0;
  return defineTool(tool.name, {
    description: tool.description ?? tool.name,
    parameters: parametersForTool(tool),
    handler: async (args: unknown) => {
      const result = await tool.handler(args);
      callCount += 1;
      const call = {
        name: tool.name,
        args,
        result,
        turnIndex: options.turnIndex?.() ?? 0,
      };
      observedToolCalls.push(call);
      await options.afterToolCall?.(call, callCount);
      return result;
    },
  });
}

function parametersForTool(tool: ToolRegistration): Record<string, unknown> {
  const schemaParameters = zodSchemaToJsonSchema(tool.schema);
  if (schemaParameters) return schemaParameters;
  const { name } = tool;
  if (name === "test_add" || name === "test_multiply") {
    return {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a", "b"],
      additionalProperties: false,
    };
  }
  if (name === "test_weather") {
    return {
      type: "object",
      properties: {
        city: { type: "string" },
      },
      required: ["city"],
      additionalProperties: false,
    };
  }
  return { type: "object", additionalProperties: true };
}

function zodSchemaToJsonSchema(schema: unknown): Record<string, unknown> | undefined {
  const unwrapped = unwrapZod(schema);
  const def = zodDef(unwrapped);
  if (!def) return undefined;
  if (!zodKindIs(def, "ZodObject", "object")) {
    return zodTypeToJsonSchema(unwrapped) ?? { type: "object", additionalProperties: true };
  }

  const rawShape = zodObjectShape(def);
  if (!rawShape || typeof rawShape !== "object") return undefined;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(rawShape as Record<string, unknown>)) {
    properties[key] = zodTypeToJsonSchema(value) ?? {};
    if (!isOptionalZod(value)) required.push(key);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function zodTypeToJsonSchema(schema: unknown): Record<string, unknown> | undefined {
  const unwrapped = unwrapZod(schema);
  const def = zodDef(unwrapped);
  if (!def) return undefined;
  let jsonSchema: Record<string, unknown> | undefined;
  if (zodKindIs(def, "ZodString", "string")) jsonSchema = { type: "string" };
  else if (zodKindIs(def, "ZodNumber", "number")) {
    jsonSchema = { type: zodNumberIsInteger(def) ? "integer" : "number" };
  } else if (zodKindIs(def, "ZodBoolean", "boolean")) jsonSchema = { type: "boolean" };
  else if (zodKindIs(def, "ZodEnum", "ZodNativeEnum", "enum")) jsonSchema = { type: "string", enum: zodEnumValues(def) };
  else if (zodKindIs(def, "ZodLiteral", "literal")) {
    const values = Array.isArray(def.values) ? def.values : [def.value];
    jsonSchema = values.length === 1 ? { const: values[0] } : { enum: values };
  } else if (zodKindIs(def, "ZodArray", "array")) {
    jsonSchema = { type: "array", items: zodTypeToJsonSchema(zodArrayElement(def)) ?? {} };
  } else if (zodKindIs(def, "ZodObject", "object")) jsonSchema = zodSchemaToJsonSchema(unwrapped);
  else if (zodKindIs(def, "ZodRecord", "record")) jsonSchema = { type: "object", additionalProperties: true };
  if (jsonSchema && zodAllowsNull(schema)) return { anyOf: [jsonSchema, { type: "null" }] };
  return jsonSchema;
}

function unwrapZod(schema: unknown): unknown {
  let current = schema;
  for (let depth = 0; depth < 8; depth += 1) {
    const def = zodDef(current);
    if (!def) return current;
    if (zodKindIs(def, "ZodOptional", "ZodNullable", "ZodDefault", "optional", "nullable", "default")) {
      current = def.innerType;
      continue;
    }
    if (zodKindIs(def, "ZodEffects", "effects")) {
      current = def.schema;
      continue;
    }
    if (zodKindIs(def, "ZodPipeline", "pipe")) {
      current = def.in;
      continue;
    }
    return current;
  }
  return current;
}

function isOptionalZod(schema: unknown): boolean {
  let current = schema;
  for (let depth = 0; depth < 8; depth += 1) {
    const def = zodDef(current);
    if (!def) return false;
    if (zodKindIs(def, "ZodOptional", "ZodDefault", "optional", "default")) return true;
    if (zodKindIs(def, "ZodNullable", "nullable")) {
      current = def.innerType;
      continue;
    }
    if (zodKindIs(def, "ZodEffects", "effects")) {
      current = def.schema;
      continue;
    }
    if (zodKindIs(def, "ZodPipeline", "pipe")) {
      current = def.in;
      continue;
    }
    return false;
  }
  return false;
}

function zodDef(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const def = (schema as { _def?: unknown; def?: unknown })._def ?? (schema as { def?: unknown }).def;
  return def && typeof def === "object" ? def as Record<string, unknown> : undefined;
}

function zodKind(def: Record<string, unknown>): string | undefined {
  const kind = def.typeName ?? def.type;
  return typeof kind === "string" ? kind : undefined;
}

function zodKindIs(def: Record<string, unknown>, ...kinds: string[]): boolean {
  const kind = zodKind(def);
  return Boolean(kind && kinds.includes(kind));
}

function zodObjectShape(def: Record<string, unknown>): Record<string, unknown> | undefined {
  const shape = typeof def.shape === "function" ? def.shape() : def.shape;
  return shape && typeof shape === "object" && !Array.isArray(shape)
    ? shape as Record<string, unknown>
    : undefined;
}

function zodNumberIsInteger(def: Record<string, unknown>): boolean {
  const checks = Array.isArray(def.checks) ? def.checks : [];
  return checks.some((check) => {
    if (!check || typeof check !== "object") return false;
    const entry = check as Record<string, unknown>;
    const nested = entry.def && typeof entry.def === "object" ? entry.def as Record<string, unknown> : {};
    return entry.kind === "int"
      || entry.isInt === true
      || nested.format === "safeint"
      || nested.format === "int32"
      || nested.format === "int64";
  });
}

function zodEnumValues(def: Record<string, unknown>): unknown[] | undefined {
  if (Array.isArray(def.values)) return def.values;
  if (def.entries && typeof def.entries === "object") return Object.values(def.entries);
  return undefined;
}

function zodArrayElement(def: Record<string, unknown>): unknown {
  return def.element ?? (typeof def.type === "string" ? undefined : def.type);
}

function zodAllowsNull(schema: unknown): boolean {
  let current = schema;
  for (let depth = 0; depth < 8; depth += 1) {
    const def = zodDef(current);
    if (!def) return false;
    if (zodKindIs(def, "ZodNullable", "nullable")) return true;
    if (zodKindIs(def, "ZodOptional", "ZodDefault", "optional", "default")) {
      current = def.innerType;
      continue;
    }
    if (zodKindIs(def, "ZodEffects", "effects")) {
      current = def.schema;
      continue;
    }
    if (zodKindIs(def, "ZodPipeline", "pipe")) {
      current = def.in;
      continue;
    }
    return false;
  }
  return false;
}

export function safeSchemaLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "scenario";
}
