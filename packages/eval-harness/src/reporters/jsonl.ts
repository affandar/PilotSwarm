import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { EvalTask, CaseResult, RunResult } from "../types.js";
import type { Reporter } from "./types.js";

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

function sanitizeFileId(id: string, fallback: string): string {
  if (!id) return fallback;
  if (SAFE_ID_RE.test(id)) return id;
  const cleaned = id.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned : fallback;
}

export class JsonlReporter implements Reporter {
  private outputDir: string;
  private runId = "";
  private filePath = "";
  private artifactDir = "";

  constructor(outputDir: string) {
    this.outputDir = outputDir;
  }

  onRunStart(task: EvalTask, runId: string): void {
    this.runId = sanitizeFileId(runId, "run");
    mkdirSync(this.outputDir, { recursive: true });
    this.filePath = join(this.outputDir, `${this.runId}.jsonl`);
    this.artifactDir = join(this.outputDir, this.runId);
    const header =
      JSON.stringify({
        type: "run",
        runId: this.runId,
        task: task.id,
        version: task.version,
        startedAt: new Date().toISOString(),
      }) + "\n";
    writeFileSync(this.filePath, header, "utf8");
  }

  onCaseResult(result: CaseResult): void {
    const line =
      JSON.stringify({
        type: "sample",
        runId: this.runId,
        caseId: result.caseId,
        pass: result.pass,
        scores: result.scores,
        observed: result.observed,
        infraError: result.infraError,
        durationMs: result.durationMs,
      }) + "\n";
    appendFileSync(this.filePath, line, "utf8");

    if (!result.pass) {
      mkdirSync(this.artifactDir, { recursive: true });
      const safeCaseId = sanitizeFileId(result.caseId, "case");
      writeFileSync(
        join(this.artifactDir, `${safeCaseId}.json`),
        JSON.stringify(result, null, 2),
        "utf8",
      );
    }
  }

  onRunComplete(result: RunResult): void {
    const summary =
      JSON.stringify({
        type: "summary",
        runId: this.runId,
        total: result.summary.total,
        passed: result.summary.passed,
        failed: result.summary.failed,
        errored: result.summary.errored,
        passRate: result.summary.passRate,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
      }) + "\n";
    appendFileSync(this.filePath, summary, "utf8");
  }
}
