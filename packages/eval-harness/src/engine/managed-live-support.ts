import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRegistration } from "../registry.js";
import type { ObservedToolCall } from "../types.js";

type AnyCtor = new (options: Record<string, unknown>) => any;

export type LiveRunnerDeps = {
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

export async function resolveSdk(deps: LiveRunnerDeps): Promise<{
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

export async function resolveCreateEnv(createEnv?: LiveRunnerDeps["createEnv"]): Promise<NonNullable<LiveRunnerDeps["createEnv"]>> {
  if (createEnv) return createEnv;
  return createDefaultLiveEnv;
}

function createDefaultLiveEnv(suiteName = "eval"): ReturnType<NonNullable<LiveRunnerDeps["createEnv"]>> {
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
  },
): unknown {
  return defineTool(tool.name, {
    description: tool.description ?? tool.name,
    parameters: tool.parameters ?? { type: "object", additionalProperties: true },
    handler: async (args: unknown) => {
      const result = await tool.handler(args);
      const call = {
        name: tool.name,
        args,
        result,
        turnIndex: options.turnIndex?.() ?? 0,
      };
      observedToolCalls.push(call);
      return result;
    },
  });
}

export function safeSchemaLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "scenario";
}
