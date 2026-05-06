import type { EvalTask, CaseResult, RunResult } from "../types.js";
import type { Reporter } from "./types.js";
import { formatRate } from "./format.js";

export class ConsoleReporter implements Reporter {
  onRunStart(task: EvalTask, runId: string): void {
    console.log(`━━━ Eval: ${task.name} v${task.version} ━━━`);
    console.log(`Run ID: ${runId}`);
  }

  onCaseResult(result: CaseResult): void {
    if (result.infraError) {
      console.log(`  ⚠️  ${result.caseId} (${result.durationMs}ms)`);
      console.log(`      error: ${result.infraError}`);
      return;
    }
    const icon = result.pass ? "✅" : "❌";
    console.log(`  ${icon} ${result.caseId} (${result.durationMs}ms)`);
    if (!result.pass) {
      for (const score of result.scores) {
        if (!score.pass) {
          console.log(`      - ${score.name}: ${score.reason}`);
        }
      }
    }
  }

  onRunComplete(result: RunResult): void {
    const { total, passed, errored, passRate } = result.summary;
    const formatted = passRate === undefined ? "n/a" : formatRate(passRate, 1);
    const pct = formatted === "n/a" ? "n/a" : formatted.slice(0, -1);
    if (errored > 0) {
      const nonError = total - errored;
      console.log(`━━━ Results: ${passed}/${nonError} quality passed (${pct}%) ━━━`);
      console.log(`${errored} infra errors`);
    } else {
      console.log(`━━━ Results: ${passed}/${total} passed (${pct}%) ━━━`);
    }
    const startMs = Date.parse(result.startedAt);
    const endMs = Date.parse(result.finishedAt);
    if (!Number.isNaN(startMs) && !Number.isNaN(endMs)) {
      console.log(`Duration: ${endMs - startMs}ms`);
    }
  }
}
