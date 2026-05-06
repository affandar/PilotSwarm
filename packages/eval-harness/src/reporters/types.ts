import type { EvalTask, CaseResult, RunResult } from "../types.js";

export interface Reporter {
  onRunStart(task: EvalTask, runId: string): void | Promise<void>;
  onCaseResult(result: CaseResult): void | Promise<void>;
  onRunComplete(result: RunResult): void | Promise<void>;
}
