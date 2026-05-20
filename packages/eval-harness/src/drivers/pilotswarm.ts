import type { Driver } from "../registry.js";
import type { ObservedResult, RunConfig, Scenario } from "../types.js";
import { effectiveTimeoutMs } from "../engine/effective-config.js";
import {
  normalizeCmsEvents,
  promptsForScenario,
  selectedModel,
  stripProviderPrefix,
  toolCallsFromCmsEvents
} from "./observations.js";

type AnyCtor = new (options: Record<string, unknown>) => any;

export type PilotSwarmDriverDeps = {
  ClientCtor?: AnyCtor;
};

type DriverRunOptions = {
  config?: Partial<RunConfig>;
};

export function createPilotSwarmDriver(deps: PilotSwarmDriverDeps = {}): Driver {
  return {
    async run(scenario, options) {
      return runAgainstRunningPilotSwarm(scenario, options as DriverRunOptions | undefined, deps);
    }
  };
}

export function pilotSwarmDriverFactory(): Driver {
  return createPilotSwarmDriver();
}

async function runAgainstRunningPilotSwarm(
  scenario: Scenario,
  options: DriverRunOptions | undefined,
  deps: PilotSwarmDriverDeps,
): Promise<ObservedResult> {
  const startedAt = Date.now();
  let client: any;
  let session: any;
  let sessionId = "";
  const turnResponses: string[] = [];

  try {
    const store = process.env.DATABASE_URL;
    if (!store && !deps.ClientCtor) throw new Error("DATABASE_URL is required for the attach driver.");

    const ClientCtor = deps.ClientCtor ?? await resolveClientCtor();
    client = new ClientCtor({
      store,
      cmsFactsDatabaseUrl: process.env.PILOTSWARM_CMS_FACTS_DATABASE_URL || undefined,
      useManagedIdentity: ["1", "true", "yes", "on"].includes(
        (process.env.PILOTSWARM_USE_MANAGED_IDENTITY || "").trim().toLowerCase(),
      ),
      aadDbUser: process.env.PILOTSWARM_DB_AAD_USER || undefined,
    });
    await client.start();

    const sessionConfig: Record<string, unknown> = {};
    if (scenario.systemMessage) sessionConfig.systemMessage = scenario.systemMessage;
    if (scenario.tools.length > 0) sessionConfig.toolNames = scenario.tools;
    const model = selectedModel(scenario, options?.config);
    if (model) sessionConfig.model = stripProviderPrefix(model);

    session = await client.createSession(sessionConfig);
    sessionId = session.sessionId;

    const timeoutMs = effectiveTimeoutMs(scenario, options?.config);
    for (const prompt of promptsForScenario(scenario)) {
      const response = await session.sendAndWait(prompt, timeoutMs);
      turnResponses.push(String(response ?? ""));
    }

    const [info, messages] = await Promise.all([
      session.getInfo?.().catch(() => undefined),
      session.getMessages?.(2000).catch(() => []) ?? [],
    ]);
    const cmsEvents = normalizeCmsEvents(messages);

    return {
      scenarioId: scenario.id,
      finalResponse: turnResponses.at(-1) ?? "",
      toolCalls: toolCallsFromCmsEvents(cmsEvents),
      cmsEvents,
      latencyMs: Date.now() - startedAt,
      costUsd: 0,
      tokensIn: promptsForScenario(scenario).join("\n").split(/\s+/).filter(Boolean).length,
      tokensOut: turnResponses.join("\n").split(/\s+/).filter(Boolean).length,
      terminalState: info?.status ?? info?.state ?? "completed",
      errored: false,
      metadata: { driver: "attach", legacyDriver: "pilotswarm", sessionId, turnResponses },
    };
  } catch (error) {
    return {
      scenarioId: scenario.id,
      finalResponse: turnResponses.at(-1) ?? "",
      toolCalls: [],
      cmsEvents: [],
      latencyMs: Date.now() - startedAt,
      costUsd: 0,
      tokensIn: promptsForScenario(scenario).join("\n").split(/\s+/).filter(Boolean).length,
      tokensOut: turnResponses.join("\n").split(/\s+/).filter(Boolean).length,
      terminalState: "error",
      errored: true,
      metadata: {
        driver: "attach",
        legacyDriver: "pilotswarm",
        sessionId,
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    await client?.stop?.();
  }
}

async function resolveClientCtor(): Promise<AnyCtor> {
  const sdk = await import("pilotswarm-sdk");
  return sdk.PilotSwarmClient as unknown as AnyCtor;
}
