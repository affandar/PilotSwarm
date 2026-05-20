import type { Driver } from "../registry.js";

export function chaosDriverFactory(): Driver {
  return {
    async run(scenario) {
      return {
        scenarioId: scenario.id,
        finalResponse: "",
        toolCalls: [],
        cmsEvents: [],
        latencyMs: 0,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        terminalState: "unsupported",
        errored: true,
        metadata: {
          driver: "chaos",
          reason: "Chaos scenarios run through the managed live driver so the harness can own worker restarts and collect CMS evidence.",
        }
      };
    }
  };
}
