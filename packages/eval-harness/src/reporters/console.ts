import type { Reporter } from "../registry.js";
import type { CheckResult } from "../types.js";
import { checkCounts, passRate, scenarioReportEntries, truncate } from "./output.js";

type JudgeMetadata = {
  provider?: unknown;
  model?: unknown;
  verdict?: unknown;
  confidence?: unknown;
  reason?: unknown;
  evidence?: unknown;
  issues?: unknown;
};

export const consoleReporter: Reporter = {
  emit(result) {
    const lines: string[] = [];
    lines.push(`\nEval run ${result.runId} — ${(passRate(result) * 100).toFixed(1)}% pass`);
    lines.push(`${result.passed} passed, ${result.failed} failed, ${result.infraErrors} infra errors, ${result.skipped} skipped`);
    lines.push("");

    for (const entry of scenarioReportEntries(result)) {
      const counts = checkCounts(entry.result);
      lines.push(`${statusIcon(entry.status)} ${entry.status.padEnd(11)} ${entry.result.scenarioId}  (${counts.passed}/${entry.result.checks.length} checks)`);
      if (entry.result.failureMessage && entry.status !== "PASS") {
        lines.push(`     ${truncate(entry.result.failureMessage, 200)}`);
      }
      for (const judge of judgeBlocks(entry.result.checks)) {
        lines.push(`     judge ${String(judge.verdict ?? "?")} (${String(judge.confidence ?? "?")}): ${truncate(judge.reason, 200)}`);
        for (const item of stringList(judge.evidence)) lines.push(`       + ${truncate(item, 160)}`);
        for (const item of stringList(judge.issues)) lines.push(`       - ${truncate(item, 160)}`);
      }
    }
    lines.push("");
    console.log(lines.join("\n"));
  }
};

function statusIcon(status: ScenarioStatus): string {
  if (status === "PASS") return "✓";
  if (status === "FAIL") return "✗";
  if (status === "INFRA ERROR") return "!";
  return "·";
}

type ScenarioStatus = ReturnType<typeof scenarioReportEntries>[number]["status"];

function judgeBlocks(checks: CheckResult[]): JudgeMetadata[] {
  return checks
    .map((check) => check.metadata?.judge)
    .filter((judge): judge is JudgeMetadata => Boolean(judge) && typeof judge === "object" && !Array.isArray(judge));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}
