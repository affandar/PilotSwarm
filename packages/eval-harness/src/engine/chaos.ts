import type { Scenario } from "../types.js";

export function requiresChaosDriver(scenario: Scenario): boolean {
  return Boolean(scenario.chaos);
}

export function validateChaosPlaceholder(scenario: Scenario): string[] {
  return scenario.chaos ? ["chaos execution requires the managed live driver"] : [];
}
