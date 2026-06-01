import { registerDriver } from "../../src/index.js";
import type { Driver } from "../../src/registry.js";
import type { CmsObservedEvent, ObservedResult, ObservedToolCall, Scenario } from "../../src/types.js";

/**
 * Test-only fake driver. Synthesizes an ObservedResult from a scenario's
 * `metadata.fake` block so the engine can be exercised end-to-end without
 * Postgres, a worker, or model credentials. Not shipped in the package — the
 * production surface is the live (managed) driver. Registered via the public
 * `registerDriver` API to exercise the same plugin path downstream uses.
 */

type FakeBlock = {
  finalResponse?: string;
  toolCalls?: ObservedToolCall[];
  cmsEvents?: CmsObservedEvent[];
  terminalState?: string;
  latencyMs?: number;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  errored?: boolean;
  metadata?: Record<string, unknown>;
};

function fakeBlock(scenario: Scenario): FakeBlock {
  const meta = scenario.metadata?.fake;
  return (meta && typeof meta === "object" ? meta : {}) as FakeBlock;
}

function promptOf(scenario: Scenario): string {
  if ("input" in scenario && scenario.input && typeof scenario.input === "object") {
    return String((scenario.input as { prompt?: unknown }).prompt ?? "");
  }
  if ("turns" in scenario && Array.isArray(scenario.turns)) {
    return scenario.turns.map((turn) => String(turn.input?.prompt ?? "")).join("\n");
  }
  return scenario.description ?? "";
}

export function fakeObserved(scenario: Scenario): ObservedResult {
  const block = fakeBlock(scenario);
  const prompt = promptOf(scenario);
  const finalResponse = block.finalResponse ?? "";
  return {
    scenarioId: scenario.id,
    finalResponse,
    toolCalls: block.toolCalls ?? [],
    cmsEvents: block.cmsEvents ?? [],
    latencyMs: block.latencyMs ?? 1,
    costUsd: block.costUsd ?? 0,
    tokensIn: block.tokensIn ?? prompt.split(/\s+/).filter(Boolean).length,
    tokensOut: block.tokensOut ?? finalResponse.split(/\s+/).filter(Boolean).length,
    terminalState: block.terminalState ?? "completed",
    errored: block.errored ?? false,
    metadata: { driver: "fake", ...(block.metadata ?? {}) },
  };
}

export function fakeDriverFactory(): Driver {
  return {
    async run(scenario) {
      return fakeObserved(scenario);
    }
  };
}

let registered = false;

/** Idempotently register the fake driver under the given name (default "fake"). */
export function useFakeDriver(name = "fake"): void {
  if (registered) return;
  registerDriver(name, { factory: fakeDriverFactory });
  registered = true;
}
