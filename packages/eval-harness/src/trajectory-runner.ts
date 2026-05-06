import { randomUUID } from "node:crypto";
import type { MultiTurnDriver } from "./drivers/multi-turn-types.js";
import type {
  TrajectoryTask,
  TrajectorySample,
  TrajectoryCaseResult,
  TrajectoryRunResult,
  TrajectoryScore,
  ObservedTrajectory,
} from "./types.js";
import { gradeTrajectory } from "./graders/trajectory.js";
import { isVisuallyEmpty } from "./runner.js";

export interface TrajectoryReporter {
  onRunStart?(task: TrajectoryTask, runId: string): void | Promise<void>;
  onCaseResult?(result: TrajectoryCaseResult): void | Promise<void>;
  onRunComplete?(result: TrajectoryRunResult): void | Promise<void>;
}

export interface TrajectoryRunnerOptions {
  driver: MultiTurnDriver;
  reporters?: TrajectoryReporter[];
  runId?: string;
  gitSha?: string;
  model?: string;
  /**
   * When false (default), the trajectory runner rejects observed turns that
   * have no tool calls AND an empty/whitespace-only response when the
   * corresponding sample turn expects `noToolCall: true`. Mirrors the F7
   * hollow-turn guard in `EvalRunner`. Set to `true` only for evals that
   * legitimately verify a "say nothing and call no tools" turn (rare).
   */
  allowHollowResults?: boolean;
}

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

function sanitizeId(id: string): string {
  if (!id) return "run";
  if (SAFE_ID_RE.test(id)) return id;
  const cleaned = id.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned : "run";
}

function allScoresPass(score: TrajectoryScore): boolean {
  const turnOk = score.turnScores.every((ts) => ts.every((s) => s.pass));
  const crossOk = score.crossTurnScores.every((s) => s.pass);
  const holisticOk = score.holisticScores.every((s) => s.pass);
  return turnOk && crossOk && holisticOk;
}

function infraScoreMessages(score: TrajectoryScore): string[] {
  return [
    ...score.turnScores.flat(),
    ...score.crossTurnScores,
    ...score.holisticScores,
  ]
    .filter((s) => s.infraError)
    .map((s) => `${s.name}: ${s.reason}`);
}

export class TrajectoryRunner {
  private driver: MultiTurnDriver;
  private reporters: TrajectoryReporter[];
  private fixedRunId?: string;
  private runId: string;
  private gitSha?: string;
  private model?: string;
  private allowHollowResults: boolean;

  constructor(options: TrajectoryRunnerOptions) {
    this.driver = options.driver;
    this.reporters = options.reporters ?? [];
    this.fixedRunId = options.runId !== undefined ? sanitizeId(options.runId) : undefined;
    this.runId = this.fixedRunId ?? sanitizeId(randomUUID());
    this.gitSha = options.gitSha;
    this.model = options.model;
    this.allowHollowResults = options.allowHollowResults ?? false;
  }

  private async safeReporter<K extends keyof TrajectoryReporter>(
    method: K,
    ...args: Parameters<NonNullable<TrajectoryReporter[K]>>
  ): Promise<void> {
    for (const r of this.reporters) {
      const fn = r[method];
      if (typeof fn !== "function") continue;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ret = (fn as any).apply(r, args);
        if (ret && typeof (ret as Promise<unknown>).then === "function") {
          await ret;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[TrajectoryRunner] reporter ${String(method)} threw: ${msg}`);
      }
    }
  }

  async runTask(task: TrajectoryTask): Promise<TrajectoryRunResult> {
    this.runId = this.fixedRunId ?? sanitizeId(randomUUID());

    const startedAt = new Date().toISOString();
    await this.safeReporter("onRunStart", task, this.runId);

    const cases: TrajectoryCaseResult[] = [];
    for (const sample of task.samples) {
      const caseResult = await this.runCase(sample);
      cases.push(caseResult);
      await this.safeReporter("onCaseResult", caseResult);
    }

    const passed = cases.filter((c) => c.pass).length;
    const errored = cases.filter((c) => !!c.infraError).length;
    const failed = cases.filter((c) => !c.pass && !c.infraError).length;
    const qualityDenominator = cases.length - errored;
    const passRate = qualityDenominator > 0 ? passed / qualityDenominator : undefined;

    const result: TrajectoryRunResult = {
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
        ...(passRate === undefined ? {} : { passRate }),
        ...(passRate === undefined ? { noQualitySignal: true } : {}),
        infraErrorRate: cases.length > 0 ? errored / cases.length : 0,
      },
      cases,
    };

    await this.safeReporter("onRunComplete", result);
    return result;
  }

  private async runCase(sample: TrajectorySample): Promise<TrajectoryCaseResult> {
    const start = Date.now();
    const timeoutMs = sample.timeoutMs;
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          controller.abort();
          reject(
            new Error(`Driver timeout after ${timeoutMs}ms for sample "${sample.id}"`),
          );
        }, timeoutMs);
      });
      let observed: ObservedTrajectory;
      try {
        observed = await Promise.race([
          this.driver.runTrajectory(sample, {
            timeout: timeoutMs,
            signal: controller.signal,
            model: this.model,
          }),
          timeoutPromise,
        ]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }

      // F7 hollow-turn guard: if any observed turn paired with a
      // `noToolCall: true` expected turn has no tool calls AND no
      // non-whitespace response, hoist to case-level infraError. A silent
      // turn yields zero evidence of model behavior and would falsely score
      // a quality pass against the `noToolCall` expectation.
      if (!this.allowHollowResults) {
        const limit = Math.min(observed.turns.length, sample.turns.length);
        for (let i = 0; i < limit; i++) {
          const expectedTurn = sample.turns[i].expected;
          const observedTurn = observed.turns[i];
          if (
            expectedTurn.noToolCall === true &&
            observedTurn.toolCalls.length === 0 &&
            isVisuallyEmpty(observedTurn.response)
          ) {
            return {
              caseId: sample.id,
              pass: false,
              trajectoryScore: { turnScores: [], crossTurnScores: [], holisticScores: [] },
              observed,
              infraError: `runner: hollow observed turn ${i} (no tool calls and empty/whitespace-only response) cannot validate a noToolCall:true expectation`,
              durationMs: Date.now() - start,
            };
          }
        }
      }

      let trajectoryScore: TrajectoryScore;
      try {
        trajectoryScore = gradeTrajectory(observed, sample);
      } catch (graderErr) {
        const msg = graderErr instanceof Error ? graderErr.message : String(graderErr);
        const stack = graderErr instanceof Error && graderErr.stack ? "\n" + graderErr.stack : "";
        return {
          caseId: sample.id,
          pass: false,
          trajectoryScore: { turnScores: [], crossTurnScores: [], holisticScores: [] },
          observed,
          infraError: `grader: ${msg}${stack}`,
          durationMs: Date.now() - start,
        };
      }

      const infraScores = infraScoreMessages(trajectoryScore);
      if (infraScores.length > 0) {
        return {
          caseId: sample.id,
          pass: false,
          trajectoryScore,
          observed,
          infraError: infraScores.join("; "),
          durationMs: Date.now() - start,
        };
      }

      return {
        caseId: sample.id,
        pass: allScoresPass(trajectoryScore),
        trajectoryScore,
        observed,
        durationMs: Date.now() - start,
      };
    } catch (error: unknown) {
      if (!controller.signal.aborted) controller.abort();
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error && error.stack ? "\n" + error.stack : "";
      return {
        caseId: sample.id,
        pass: false,
        trajectoryScore: { turnScores: [], crossTurnScores: [], holisticScores: [] },
        observed: {
          turns: [],
          sessionId: "",
          totalLatencyMs: 0,
        },
        infraError: message + stack,
        durationMs: Date.now() - start,
      };
    }
  }

  checkPassRateFloor(result: TrajectoryRunResult, floor: number): boolean {
    return result.summary.passRate !== undefined && result.summary.passRate >= floor;
  }
}
