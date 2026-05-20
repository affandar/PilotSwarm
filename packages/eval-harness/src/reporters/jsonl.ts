import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Reporter } from "../registry.js";
import { redactForArtifact, runOutputDirectory, writeSummaryJson } from "./output.js";

export const jsonlReporter: Reporter = {
  async emit(result, options) {
    const reportsDir = runOutputDirectory(result, options);
    const machineDir = join(reportsDir, "machine");
    await mkdir(machineDir, { recursive: true });
    const lines = result.scenarios.map((scenario) => JSON.stringify(redactForArtifact({
      runId: result.runId,
      scenarioId: scenario.scenarioId,
      kind: scenario.kind,
      passed: scenario.passed,
      infraError: scenario.infraError,
      failureMessage: scenario.failureMessage,
      latencyMs: scenario.observed.latencyMs,
      costUsd: scenario.observed.costUsd,
      terminalState: scenario.observed.terminalState,
      checks: scenario.checks,
    })));
    await Promise.all([
      writeSummaryJson(result, options),
      writeFile(join(machineDir, "results.jsonl"), `${lines.join("\n")}\n`),
    ]);
  }
};
