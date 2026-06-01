import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { evaluateChecks } from "./check-runner.js";
import { effectiveTimeoutMs } from "./effective-config.js";
import { requiredIsolation, type IsolationMode } from "./isolation.js";
import {
  assertSupportedLiveChaos,
  createChaosController,
  isChaosSkipError,
  type ChaosController
} from "./chaos-controller.js";
import {
  resolveCreateEnv,
  resolveSdk,
  safeSchemaLabel,
  selectedSdkTools,
  type LiveRunnerDeps
} from "./managed-live-support.js";
import {
  mergeToolCalls,
  normalizeCmsEvents,
  promptsForScenario,
  toolCallsFromCmsEvents
} from "../drivers/observations.js";
import { tools } from "../registry.js";
import type { ObservedResult, ObservedToolCall, RunConfig, Scenario, ScenarioResult } from "../types.js";

type AnyCtor = new (options: Record<string, unknown>) => any;

type ManagedLiveSdk = {
  WorkerCtor: AnyCtor;
  ClientCtor: AnyCtor;
  defineTool: (name: string, config: Record<string, unknown>) => unknown;
};

type ManagedLiveEnv = {
  store: string;
  duroxideSchema: string;
  cmsSchema: string;
  factsSchema: string;
  sessionStateDir: string;
  cleanup?: () => Promise<void>;
};

type ManagedLiveRuntime = {
  env: ManagedLiveEnv;
  workers: any[];
  client: any;
  sdk: ManagedLiveSdk;
  workerCount: number;
  replaceWorker: (index: number, sessionId: string, sessionConfig: Record<string, unknown>, sdkTools: unknown[]) => Promise<void>;
  close: () => Promise<void>;
};

export type ManagedLiveRunnerDeps = LiveRunnerDeps;

export type ManagedLiveRunnerOptions = {
  onScenarioStart?: (scenario: Scenario, index: number) => void | Promise<void>;
  onScenarioComplete?: (scenario: Scenario, result: ScenarioResult, index: number) => void | Promise<void>;
};

export async function runManagedLiveScenarios(
  scenarios: Scenario[],
  config: RunConfig,
  deps: ManagedLiveRunnerDeps = {},
  options: ManagedLiveRunnerOptions = {},
): Promise<ScenarioResult[]> {
  if (scenarios.length === 0) return [];
  if (!deps.WorkerCtor && !process.env.GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN is required for managed live evals.");
  }

  const concurrency = Math.max(1, config.defaults?.concurrent ?? 1);
  const configuredIsolation = config.defaults?.isolation ?? "shared-worker";
  const sharedScenarios = scenarios.filter((scenario) => requiredIsolation(scenario, configuredIsolation) === "shared-worker");
  const sharedRuntime = sharedScenarios.length
    ? await createManagedLiveRuntime("eval_live_shared", config, deps, concurrency)
    : undefined;
  const results = new Array<ScenarioResult>(scenarios.length);

  try {
    await mapLimit(scenarios.map((scenario, index) => ({ scenario, index })), concurrency, async ({ scenario, index }) => {
      await options.onScenarioStart?.(scenario, index);
      const isolation = requiredIsolation(scenario, configuredIsolation);
      if (isolation === "shared-worker") {
        if (!sharedRuntime) throw new Error("Shared live runtime was not initialized.");
        results[index] = await runManagedLiveScenarioWithChecks(scenario, config, sharedRuntime, isolation);
        await options.onScenarioComplete?.(scenario, results[index]!, index);
        return;
      }

      const runtime = await createManagedLiveRuntime(`eval_live_${safeSchemaLabel(scenario.id)}`, config, deps, 1);
      try {
        results[index] = await runManagedLiveScenarioWithChecks(scenario, config, runtime, isolation);
        await options.onScenarioComplete?.(scenario, results[index]!, index);
      } finally {
        await runtime.close();
      }
    });
  } finally {
    await sharedRuntime?.close();
  }

  return results;
}

async function createManagedLiveRuntime(
  label: string,
  config: RunConfig,
  deps: ManagedLiveRunnerDeps,
  workerCount: number,
): Promise<ManagedLiveRuntime> {
  const [sdk, createEnv] = await Promise.all([
    resolveSdk(deps),
    resolveCreateEnv(deps.createEnv),
  ]);
  const env = createEnv(label);
  const globalTools = await selectedSdkTools([...tools.keys()], sdk.defineTool, []);
  const createWorker = () => {
    const worker = new sdk.WorkerCtor({
      store: env.store,
      githubToken: process.env.GITHUB_TOKEN,
      duroxideSchema: env.duroxideSchema,
      cmsSchema: env.cmsSchema,
      factsSchema: env.factsSchema,
      sessionStateDir: env.sessionStateDir,
      workerNodeId: `eval-${randomBytes(4).toString("hex")}`,
      disableManagementAgents: config.worker?.disableManagementAgents ?? true,
      pluginDirs: resolveWorkerPaths(config, config.worker?.pluginDirs),
      customAgents: config.worker?.customAgents,
      skillDirectories: resolveWorkerPaths(config, config.worker?.skillDirectories),
      logLevel: process.env.DUROXIDE_LOG_LEVEL || "error",
    });
    if (globalTools.sdkTools.length > 0) worker.registerTools?.(globalTools.sdkTools);
    return worker;
  };
  const workers = Array.from({ length: workerCount }, () => createWorker());

  for (const worker of workers) await worker.start();

  const client = new sdk.ClientCtor({
    store: env.store,
    duroxideSchema: env.duroxideSchema,
    cmsSchema: env.cmsSchema,
    factsSchema: env.factsSchema,
    dehydrateThreshold: 0,
  });
  await client.start();

  return {
    env,
    workers,
    client,
    sdk,
    workerCount,
    async replaceWorker(index, sessionId, sessionConfig, sdkTools) {
      const current = workers[index];
      await current?.stop?.();
      const replacement = createWorker();
      await replacement.start();
      replacement.setSessionConfig?.(sessionId, { ...sessionConfig, tools: sdkTools });
      workers[index] = replacement;
    },
    async close() {
      await client?.stop?.();
      for (const worker of [...workers].reverse()) await worker?.stop?.();
      await env.cleanup?.();
    },
  };
}

function resolveWorkerPaths(config: RunConfig, paths?: string[]): string[] | undefined {
  if (!paths) return undefined;
  const baseDir = config.configPath ? dirname(config.configPath) : process.cwd();
  return paths.map((path) => isAbsolute(path) ? path : resolve(baseDir, path));
}

async function runManagedLiveScenarioWithChecks(
  scenario: Scenario,
  config: RunConfig,
  runtime: ManagedLiveRuntime,
  isolation: IsolationMode,
): Promise<ScenarioResult> {
  const observed = await runManagedLiveScenario(scenario, config, runtime, isolation);
  if (observed.terminalState === "skipped") {
    return {
      scenarioId: scenario.id,
      kind: scenario.kind,
      passed: false,
      observed,
      checks: [],
      infraError: false,
      metadata: {
        driver: "live",
        isolation,
        managedWorkerCount: runtime.workerCount,
        ...(observed.metadata?.chaos ? { chaos: observed.metadata.chaos } : {}),
      },
    };
  }
  const checks = await evaluateChecks(scenario, observed, config);
  const passed = !observed.errored && checks.every((check) => check.skipped || (check.pass && !check.errored));
  const failureMessage = passed
    ? undefined
    : (observed.errored ? observed.metadata?.reason as string | undefined : undefined)
      ?? checks.find((check) => !check.pass || check.errored)?.message
      ?? "scenario failed";

  return {
    scenarioId: scenario.id,
    kind: scenario.kind,
    passed,
    failureMessage,
    observed,
    checks,
    infraError: Boolean(observed.errored),
    metadata: {
      driver: "live",
      isolation,
      managedWorkerCount: runtime.workerCount,
      ...(observed.metadata?.chaos ? { chaos: observed.metadata.chaos } : {}),
    },
  };
}

async function runManagedLiveScenario(
  scenario: Scenario,
  config: RunConfig,
  runtime: ManagedLiveRuntime,
  isolation: IsolationMode,
): Promise<ObservedResult> {
  const startedAt = Date.now();
  const handlerToolCalls: ObservedToolCall[] = [];
  const turnResponses: string[] = [];
  let sessionId = "";
  let session: any;
  let turnIndex = 0;
  let chaos: ChaosController | undefined;

  try {
    assertSupportedLiveChaos(scenario);
    const localChaos = createChaosController(scenario, runtime);
    chaos = localChaos;
    const { sdkTools, toolNames } = await selectedSdkTools(
      scenario.tools ?? [],
      runtime.sdk.defineTool,
      handlerToolCalls,
      {
        turnIndex: () => turnIndex,
      },
    );
    const sessionConfig = sessionConfigForScenario(scenario, config, toolNames);
    session = await runtime.client.createSession(sessionConfig);
    sessionId = session.sessionId;
    localChaos.setSessionContext(
      () => sessionId,
      sessionConfig,
      sdkTools,
      async () => session.getMessages?.(2000).catch(() => []) ?? [],
    );
    for (const worker of runtime.workers) {
      worker.setSessionConfig?.(sessionId, { ...sessionConfig, tools: sdkTools });
    }

    const timeoutMs = effectiveTimeoutMs(scenario, config);
    const prompts = promptsForScenario(scenario);
    for (let index = 0; index < prompts.length; index += 1) {
      turnIndex = index;
      await localChaos.beforeTurn(prompts[index]);
      const response = await session.sendAndWait(prompts[index], timeoutMs);
      turnResponses.push(String(response ?? ""));
      await localChaos.afterTurn();
    }
    await localChaos.flush();

    const [info, messages] = await Promise.all([
      session.getInfo?.().catch(() => undefined),
      session.getMessages?.(2000).catch(() => []) ?? [],
    ]);
    const cmsEvents = normalizeCmsEvents(messages);
    const cmsToolCalls = toolCallsFromCmsEvents(cmsEvents);

    return {
      scenarioId: scenario.id,
      finalResponse: turnResponses.at(-1) ?? "",
      toolCalls: mergeToolCalls(cmsToolCalls, handlerToolCalls),
      cmsEvents,
      latencyMs: Date.now() - startedAt,
      terminalState: info?.status ?? info?.state ?? "completed",
      errored: false,
      metadata: {
        driver: "live",
        managed: true,
        isolation,
        sessionId,
        turnResponses,
        workerCount: runtime.workerCount,
        ...(localChaos.metadata() ? { chaos: localChaos.metadata() } : {}),
      },
    };
  } catch (error) {
    await chaos?.cancel();
    const skipped = isChaosSkipError(error);
    const [info, messages] = session
      ? await Promise.all([
        session.getInfo?.().catch(() => undefined),
        session.getMessages?.(2000).catch(() => []) ?? [],
      ])
      : [undefined, []];
    const cmsEvents = normalizeCmsEvents(messages);
    const chaosMetadata = chaos?.metadata();
    return {
      scenarioId: scenario.id,
      finalResponse: turnResponses.at(-1) ?? "",
      toolCalls: mergeToolCalls(toolCallsFromCmsEvents(cmsEvents), handlerToolCalls),
      cmsEvents,
      latencyMs: Date.now() - startedAt,
      terminalState: skipped ? "skipped" : info?.status ?? info?.state ?? "error",
      errored: !skipped,
      metadata: {
        driver: "live",
        managed: true,
        isolation,
        sessionId,
        reason: error instanceof Error ? error.message : String(error),
        ...(skipped ? { skipped: true } : {}),
        ...(chaosMetadata
          ? { chaos: chaosMetadata }
          : scenario.chaos
            ? { chaos: { injected: false, type: scenario.chaos.type, injectAt: scenario.chaos.injectAt } }
            : {}),
      },
    };
  }
}

function sessionConfigForScenario(scenario: Scenario, config: RunConfig, toolNames: string[]): Record<string, unknown> {
  const sessionConfig: Record<string, unknown> = {};
  if (toolNames.length > 0) sessionConfig.toolNames = toolNames;
  if (scenario.systemMessage) sessionConfig.systemMessage = scenario.systemMessage;
  if (scenario.kind === "durable-trajectory") sessionConfig.waitThreshold = 0;
  if (scenario.agent && scenario.agent !== "default") {
    sessionConfig.agentId = scenario.agent;
    sessionConfig.boundAgentName = scenario.agent;
    sessionConfig.promptLayering = { kind: "app-agent" };
  }
  return sessionConfig;
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await fn(items[index]);
    }
  }));
}
