import { randomUUID } from "node:crypto";
import type { Driver } from "./drivers/types.js";
import type { EvalTask, EvalSample, CaseResult, RunResult, Score } from "./types.js";
import type { Reporter } from "./reporters/types.js";
import { JsonlReporter } from "./reporters/jsonl.js";
import { gradeEvalCase } from "./graders/index.js";
import { normalizeObservedResult } from "./validation/normalize-result.js";

export interface RunnerOptions {
  driver: Driver;
  reporters?: Reporter[];
  runId?: string;
  gitSha?: string;
  model?: string;
  /**
   * When false (default), the runner rejects observed results that have no
   * tool calls AND an empty/whitespace-only finalResponse when the sample
   * expects `noToolCall: true`. This guards against the F7 hollow-turn
   * false-positive where a silent driver yields a quality "pass" against a
   * `noToolCall: true` expectation despite producing zero observable evidence
   * of model behavior. Set to `true` only for evals that legitimately verify
   * a "say nothing and call no tools" behavior (rare).
   */
  allowHollowResults?: boolean;
  /**
   * iter18 WS-I: when true, a thrown reporter rethrows out of the runner
   * (fail-loud — recommended for CI environments where a silent reporter
   * regression is itself a defect). When false (default), the runner logs
   * `console.warn(...)` and continues so a single buggy reporter cannot
   * blow up an entire run.
   */
  failOnReporterError?: boolean;
  /**
   * G8: explicit per-runner reports directory. When provided, the runner
   * appends a `JsonlReporter(reportsDir)` to the reporter list (unless the
   * caller already supplied one). This is the programmatic equivalent of
   * the `EVAL_REPORTS_DIR` env var; the explicit option wins over the env
   * var when both are present.
   */
  reportsDir?: string;
}

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * F18 / F7 (iter14): hollow-turn guard predicate. `String.prototype.trim()` does
 * NOT strip zero-width, format, or bidi-control characters, so a buggy or
 * evasive driver could return one of those and bypass the hollow check —
 * scoring 100% against a `noToolCall:true` expectation despite producing zero
 * observable evidence of model behavior. Treat any string composed entirely of
 * whitespace and/or invisible characters as visually empty.
 *
 * Covered ranges (Unicode format / zero-width / bidi controls that render to
 * nothing in normal text):
 *   - \s (standard whitespace, including \n, \r, \t, NBSP, etc.)
 *   - U+00AD soft hyphen
 *   - U+180E mongolian vowel separator
 *   - U+200B-U+200F zero-width space, ZWNJ, ZWJ, LRM, RLM
 *   - U+202A-U+202E bidi embedding/override controls (LRE/RLE/PDF/LRO/RLO)
 *   - U+2060-U+206F word joiner, FSI, LRI, RLI, PDI, etc.
 *   - U+FE00-U+FE0F variation selectors
 *   - U+FEFF BOM / zero-width no-break space
 *   - U+115F / U+1160 / U+3164 / U+FFA0 Hangul fillers (render to nothing but
 *     occupy a glyph cell — historically used to fake "blank" content)
 *   - U+FFFC OBJECT REPLACEMENT CHARACTER
 *   - Anything with the Unicode `Default_Ignorable_Code_Point` property
 *     (covers all of the above except OBJECT REPLACEMENT CHARACTER and is
 *     forward-compatible with future Unicode revisions)
 *
 * Boundary: emoji base codepoints (e.g. 😀 U+1F600), skin-tone modifiers
 * (U+1F3FB-U+1F3FF), and other visible characters are NOT default-ignorable,
 * so a string containing any of them is treated as visible. A bare variation
 * selector (e.g. U+FE0F) on its own is still considered empty — same as
 * before — because it has no base character to attach to.
 */
export function isVisuallyEmpty(s: string | undefined | null): boolean {
  if (s === undefined || s === null) return true;
  return /^[\s\uFFFC\p{Default_Ignorable_Code_Point}]*$/u.test(s);
}

function sanitizeId(id: string): string {
  if (!id) return "run";
  if (SAFE_ID_RE.test(id)) return id;
  // Replace any character outside the safe set; collapse runs; trim.
  const cleaned = id.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned : "run";
}

/**
 * H7 (iter19): observer-isolation freeze. Recursively `Object.freeze` so
 * neither reporter callbacks nor downstream consumers can mutate the canonical
 * RunResult after EvalRunner returns.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

export class EvalRunner {
  private driver: Driver;
  private reporters: Reporter[];
  private fixedRunId?: string;
  private runId: string;
  private gitSha?: string;
  private model?: string;
  private allowHollowResults: boolean;
  private failOnReporterError: boolean;

  constructor(options: RunnerOptions) {
    this.driver = options.driver;
    // G8: optional auto-wiring of `JsonlReporter` from a per-runner option
    // (`reportsDir`) or the `EVAL_REPORTS_DIR` env var. Caller-supplied
    // reporters are always kept; the auto-reporter is appended ONLY if no
    // `JsonlReporter` is already present (so a caller can override with
    // a custom output dir or suppress auto-wiring by passing their own
    // instance). Explicit option wins over env var when both are set.
    const callerReporters = options.reporters ?? [];
    const explicitDir = options.reportsDir;
    const envDir =
      explicitDir === undefined
        ? process.env.EVAL_REPORTS_DIR && process.env.EVAL_REPORTS_DIR.length > 0
          ? process.env.EVAL_REPORTS_DIR
          : undefined
        : undefined;
    const autoDir = explicitDir ?? envDir;
    const hasJsonl = callerReporters.some((r) => r instanceof JsonlReporter);
    this.reporters =
      autoDir && !hasJsonl
        ? [...callerReporters, new JsonlReporter(autoDir)]
        : callerReporters;
    this.fixedRunId = options.runId !== undefined ? sanitizeId(options.runId) : undefined;
    this.runId = this.fixedRunId ?? sanitizeId(randomUUID());
    this.gitSha = options.gitSha;
    this.model = options.model;
    this.allowHollowResults = options.allowHollowResults ?? false;
    this.failOnReporterError = options.failOnReporterError ?? false;
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
        if (this.failOnReporterError) {
          throw err instanceof Error
            ? err
            : new Error(`reporter ${String(method)} threw: ${msg}`);
        }
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
    // Infra errors are harness/provider failures, not model quality failures.
    const qualityDenominator = cases.length - errored;
    const passRate = qualityDenominator > 0 ? passed / qualityDenominator : undefined;

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
        ...(passRate === undefined ? {} : { passRate }),
        ...(passRate === undefined ? { noQualitySignal: true } : {}),
        infraErrorRate: cases.length > 0 ? errored / cases.length : 0,
      },
      cases,
    };

    // H7 (iter19): pass a deeply-frozen clone to reporters so a buggy or
    // hostile observer cannot mutate the canonical RunResult. Freeze the
    // canonical returned result too — downstream consumers expect immutable
    // structured data.
    const frozenForReporters = deepFreeze(structuredClone(result));
    await this.safeReporter("onRunComplete", frozenForReporters);
    return deepFreeze(structuredClone(result));
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
        const rawObserved = await Promise.race([
          this.driver.run(sample, {
            timeout: timeoutMs,
            signal: controller.signal,
            model: this.model,
          }),
          timeoutPromise,
        ]);
        // Driver→runner trust boundary: validate ObservedResult shape via
        // central normalizer. On failure the runner records an infra outage
        // (excluded from passRate) instead of fail-closing the case as a
        // quality fail.
        const normalized = normalizeObservedResult(rawObserved);
        if (!normalized.ok) {
          return {
            caseId: sample.id,
            pass: false,
            scores: [normalized.infraScore],
            observed: {
              toolCalls: [],
              finalResponse: "",
              sessionId: "",
              latencyMs: 0,
            },
            infraError: normalized.infraScore.reason ?? "driver-output-shape",
            durationMs: Date.now() - start,
          };
        }
        observed = normalized.data;
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }

      let scores: Score[];
      // F7 hollow-turn guard: when a sample expects `noToolCall: true` and the
      // observed result has no tool calls AND no non-whitespace response,
      // there is zero evidence of model behavior. Treating this as a quality
      // pass would let a silent or broken driver score 100% against a
      // noToolCall expectation. Hoist to runner-level infraError instead so
      // it is excluded from passRate.
      if (
        !this.allowHollowResults &&
        sample.expected.noToolCall === true &&
        observed.toolCalls.length === 0 &&
        isVisuallyEmpty(observed.finalResponse)
      ) {
        return {
          caseId: sample.id,
          pass: false,
          scores: [],
          observed,
          infraError:
            "runner: hollow observed result (no tool calls and empty/whitespace-only response) cannot validate a noToolCall:true expectation",
          durationMs: Date.now() - start,
        };
      }
      try {
        scores = gradeEvalCase(observed, sample.expected);
      } catch (graderErr) {
        const msg = graderErr instanceof Error ? graderErr.message : String(graderErr);
        const stack = graderErr instanceof Error && graderErr.stack ? "\n" + graderErr.stack : "";
        return {
          caseId: sample.id,
          pass: false,
          scores: [],
          observed,
          infraError: `grader: ${msg}${stack}`,
          durationMs: Date.now() - start,
        };
      }
      const infraScores = scores.filter((s) => s.infraError);
      if (infraScores.length > 0) {
        return {
          caseId: sample.id,
          pass: false,
          scores,
          observed,
          infraError: infraScores.map((s) => `${s.name}: ${s.reason}`).join("; "),
          durationMs: Date.now() - start,
        };
      }
      const allPass = scores.length > 0 && scores.every((s) => s.pass);
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
    return result.summary.passRate !== undefined && result.summary.passRate >= floor;
  }
}
