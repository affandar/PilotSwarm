import type { RunConfig, Scenario, ScenarioResult } from "../types.js";

export async function applyPostRunAnalysis(
  result: ScenarioResult,
  scenario: Scenario,
  config: RunConfig,
): Promise<ScenarioResult> {
  const summary = scenario.postRun?.trajectorySummary;
  if (!config.postRun?.trajectorySummaryEnabled || !summary) return result;

  const eventTypes = result.observed.cmsEvents.map((event) => event.type);
  const toolNames = result.observed.toolCalls.map((call) => call.name);
  const notes = [
    `Trajectory summary (deterministic): ${summary.rubric}`,
    `Terminal state: ${result.observed.terminalState ?? "unknown"}.`,
    `Observed ${eventTypes.length} CMS event(s): ${eventTypes.slice(0, 12).join(", ") || "none"}.`,
    `Observed ${toolNames.length} tool call(s): ${toolNames.slice(0, 12).join(", ") || "none"}.`,
    result.passed ? "Gate result: passed." : `Gate result: failed (${result.failureMessage ?? "no failure message"}).`,
  ].join("\n");

  return {
    ...result,
    trajectoryNotes: notes,
    metadata: {
      ...(result.metadata ?? {}),
      postRun: {
        ...((result.metadata?.postRun as Record<string, unknown> | undefined) ?? {}),
        trajectorySummary: {
          provider: "deterministic",
          rubric: summary.rubric,
          costUsd: 0,
          eventCount: eventTypes.length,
          toolCallCount: toolNames.length,
        },
      },
    },
  };
}
