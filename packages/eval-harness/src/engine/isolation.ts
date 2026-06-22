import type { Scenario } from "../types.js";

export type IsolationMode = "shared-worker" | "fresh-worker";

export function requiredIsolation(scenario: Scenario, configured: IsolationMode = "shared-worker"): IsolationMode {
  if (scenario.requirements?.isolation === "fresh-worker") return "fresh-worker";
  if (scenario.chaos) return "fresh-worker";
  return configured;
}
