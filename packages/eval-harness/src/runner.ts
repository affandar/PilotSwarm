import { randomUUID } from "node:crypto";
import type { Driver } from "./drivers/types.js";
import type { EvalTask, EvalSample, CaseResult, RunResult, Score } from "./types.js";
import type { Reporter } from "./reporters/types.js";
import { gradeEvalCase } from "./graders/index.js";

export interface RunnerOptions {
  driver: Driver;
  reporters?: Reporter[];
  runId?: string;
  gitSha?: string;
  model?: string;
}

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

function sanitizeId(id: string): string {
  if (!id) return "run";
  if (SAFE_ID_RE.test(id)) return id;
  // Replace any character outside the safe set; collapse runs; trim.
  const cleaned = id.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned : "run";
}

export class EvalRunner {
  private driver: Driver;
  private reporters: Reporter[];
  private fixedRunId?: string;
  private runId: string;
  private gitSha?: string;
  private model?: string;

  constructor(options: RunnerOptions) {
    this.driver = options.driver;
    this.reporters = options.reporters ?? [];
    this.fixedRunId = options.runId !== undefined ? sanitizeId(options.runId) : undefined;
    this.runId = this.fixedRunId ?? sanitizeId(randomUUID());
    this.gitSha = options.gitSha;
    this.model = options.model;
  }

  private async safeReporter<K extends keyof Reporter>(
    method: K,
    ...args: Parameters<Reporter[K]>
  ): Promise<void> {
    for (const r of this.reporters) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ret = (r[method] as any).apply(r, args);
        if (ret && typeof (ret as Promise<unknown>).then === "function") {
          await ret;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[EvalRunner] reporter ${String(method)} threw: ${msg}`);
      }
    }
  }

  async runTask(task: EvalTask): Promise<RunResult> {
    // Generate a fresh runId per runTask call when none was fixed in the constructor.
    // This prevents successive runTask invocations from overwriting each other's JSONL
    // output and artifact directories.
    this.runId = this.fixedRunId ?? sanitizeId(randomUUID());

    const startedAt = new Date().toISOString();
    await this.safeReporter("onRunStart", task, this.runId);

    const cases: CaseResult[] = [];
    for (const sample of task.samples) {
      const caseResult = await this.runCase(sample);
      cases.push(caseResult);
      await this.safeReporter("onCaseResult", caseResult);
    }

    const passed = cases.filter((c) => c.pass).length;
    const errored = cases.filter((c) => !!c.infraError).length;
    const failed = cases.filter((c) => !c.pass && !c.infraError).length;

    const result: RunResult = {
      schemaVersion: 1,
      runId: this.runId,
      taskId: task.id,
      taskVersion: task.version,
      gitSha: this.gitSha,
      model: this.model,
      startedAt,
      finishedAt: new Date().toISOString(),
      summary: {
        total: cases.length,
        passed,
        failed,
        errored,
        passRate: cases.length > 0 ? passed / cases.length : 0,
      },
      cases,
    };

    await this.safeReporter("onRunComplete", result);
    return result;
  }

  private async runCase(sample: EvalSample): Promise<CaseResult> {
    const start = Date.now();
    const timeoutMs = sample.timeoutMs;
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          controller.abort();
          reject(new Error(`Driver timeout after ${timeoutMs}ms for sample "${sample.id}"`));
        }, timeoutMs);
      });
      let observed;
      try {
        observed = await Promise.race([
          this.driver.run(sample, { timeout: timeoutMs, signal: controller.signal }),
          timeoutPromise,
        ]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }

      let scores: Score[];
      try {
        scores = gradeEvalCase(observed, sample.expected);
      } catch (graderErr) {
        const msg = graderErr instanceof Error ? graderErr.message : String(graderErr);
        scores = [
          {
            name: "grader-error",
            value: 0,
            pass: false,
            reason: `grader threw: ${msg}`,
          },
        ];
      }
      const allPass = scores.length === 0 || scores.every((s) => s.pass);
      return {
        caseId: sample.id,
        pass: allPass,
        scores,
        observed,
        durationMs: Date.now() - start,
      };
    } catch (error: unknown) {
      // Make sure we abort any in-flight driver work even if the failure path
      // wasn't the timeout itself (e.g. driver threw synchronously).
      if (!controller.signal.aborted) controller.abort();
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error && error.stack ? "\n" + error.stack : "";
      return {
        caseId: sample.id,
        pass: false,
        scores: [],
        observed: {
          toolCalls: [],
          finalResponse: "",
          sessionId: "",
          latencyMs: 0,
        },
        infraError: message + stack,
        durationMs: Date.now() - start,
      };
    }
  }

  checkPassRateFloor(result: RunResult, floor: number): boolean {
    return result.summary.passRate >= floor;
  }
}
