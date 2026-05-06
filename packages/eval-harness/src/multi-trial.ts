import { randomUUID } from "node:crypto";
import { EvalRunner } from "./runner.js";
import type { Driver } from "./drivers/types.js";
import type { Reporter } from "./reporters/types.js";
import type {
  EvalTask,
  RunResult,
  MultiTrialResult,
  SampleTrialResult,
} from "./types.js";
import { passAtK, meanStddev, wilsonInterval } from "./stats.js";

export interface MultiTrialRunnerOptions {
  driverFactory: () => Driver;
  reporters?: Reporter[];
  // Factory for per-trial reporter instances. Required when concurrency > 1
  // if reporters are stateful (e.g. JsonlReporter). When concurrency > 1 and
  // no factory is provided, per-trial reporters are dropped to avoid
  // cross-trial state corruption.
  reporterFactory?: () => Reporter[];
  trials: number;
  concurrency?: number;
  passAtKValues?: number[];
  // V2: scores always use exclude policy. Zero-fill deferred to V3.
  gitSha?: string;
  model?: string;
}

const DEFAULT_PASS_AT_K = [1, 5, 10];

export class MultiTrialRunner {
  private driverFactory: () => Driver;
  private reporters: Reporter[];
  private reporterFactory?: () => Reporter[];
  private trials: number;
  private concurrency: number;
  private passAtKValues: number[];
  private gitSha?: string;
  private model?: string;
  private concurrencyReporterWarningLogged = false;

  constructor(options: MultiTrialRunnerOptions) {
    if (typeof options !== "object" || options === null) {
      throw new Error("MultiTrialRunner: options must be a non-null object");
    }
    if (typeof options.driverFactory !== "function") {
      throw new Error("MultiTrialRunner: driverFactory must be a function");
    }
    if (!Number.isInteger(options.trials) || options.trials < 1) {
      throw new Error(
        `MultiTrialRunner: trials must be an integer >= 1 (got ${options.trials})`,
      );
    }
    if (options.trials > Number.MAX_SAFE_INTEGER) {
      throw new Error("MultiTrialRunner: trials exceeds MAX_SAFE_INTEGER");
    }
    const concurrency = options.concurrency ?? 1;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(
        `MultiTrialRunner: concurrency must be an integer >= 1 (got ${concurrency})`,
      );
    }
    if (options.passAtKValues !== undefined) {
      if (!Array.isArray(options.passAtKValues)) {
        throw new Error("MultiTrialRunner: passAtKValues must be an array");
      }
      for (const k of options.passAtKValues) {
        if (!Number.isInteger(k) || k < 1) {
          throw new Error(
            `MultiTrialRunner: passAtKValues entries must be integers >= 1 (got ${k})`,
          );
        }
      }
    }
    if (options.gitSha !== undefined && typeof options.gitSha !== "string") {
      throw new Error("MultiTrialRunner: gitSha must be a string when provided");
    }
    if (options.model !== undefined && typeof options.model !== "string") {
      throw new Error("MultiTrialRunner: model must be a string when provided");
    }
    this.driverFactory = options.driverFactory;
    this.reporters = options.reporters ?? [];
    this.reporterFactory = options.reporterFactory;
    this.trials = options.trials;
    this.concurrency = concurrency;
    this.passAtKValues = options.passAtKValues ?? DEFAULT_PASS_AT_K;
    this.gitSha = options.gitSha;
    this.model = options.model;
  }

  async runTask(task: EvalTask): Promise<MultiTrialResult> {
    const runId = randomUUID();
    const startedAt = new Date().toISOString();

    const rawRuns: RunResult[] = new Array(this.trials);

    if (this.concurrency <= 1) {
      for (let i = 0; i < this.trials; i++) {
        rawRuns[i] = await this.runOneTrial(task);
      }
    } else {
      let next = 0;
      const workers: Promise<void>[] = [];
      const pool = Math.min(this.concurrency, this.trials);
      for (let w = 0; w < pool; w++) {
        workers.push(
          (async () => {
            while (true) {
              const i = next++;
              if (i >= this.trials) return;
              rawRuns[i] = await this.runOneTrial(task);
            }
          })(),
        );
      }
      await Promise.all(workers);
    }

    const samples = task.samples.map((s) =>
      this.aggregateSample(s.id, rawRuns),
    );

    // Task-level summary
    const passRates = samples
      .map((s) => s.passRate)
      .filter((rate): rate is number => rate !== undefined);
    const meanStats =
      passRates.length > 0 ? meanStddev(passRates) : { mean: 0, stddev: 0, n: 0 };
    const totalPasses = samples.reduce((acc, s) => acc + s.passCount, 0);
    const totalNonError = samples.reduce(
      (acc, s) => acc + (this.trials - s.errorCount),
      0,
    );
    const pooledPassRateCI = wilsonInterval(totalPasses, totalNonError);
    const totalInfraErrors = samples.reduce((acc, s) => acc + s.errorCount, 0);
    const plannedTrials = samples.length * this.trials;
    const meanPassRate = passRates.length > 0 ? meanStats.mean : undefined;

    const finishedAt = new Date().toISOString();
    const result: MultiTrialResult = {
      schemaVersion: 1,
      runId,
      taskId: task.id,
      taskVersion: task.version,
      gitSha: this.gitSha,
      model: this.model,
      trials: this.trials,
      startedAt,
      finishedAt,
      summary: {
        total: samples.length,
        trials: this.trials,
        ...(meanPassRate === undefined ? {} : { meanPassRate }),
        ...(meanPassRate === undefined ? { noQualitySignal: true } : {}),
        infraErrorRate: plannedTrials > 0 ? totalInfraErrors / plannedTrials : 0,
        stddevPassRate: Number.isFinite(meanStats.stddev) ? meanStats.stddev : 0,
        passRateCI: pooledPassRateCI,
        pooledPassRateCI,
      },
      samples,
      rawRuns,
    };

    return result;
  }

  private async runOneTrial(task: EvalTask): Promise<RunResult> {
    const driver = this.driverFactory();
    // Per-trial reporters:
    // - concurrency === 1: share the user-provided reporters (safe; fully sequential)
    // - concurrency > 1 + reporterFactory: fresh reporters per trial (isolated state)
    // - concurrency > 1 + no factory: pass NO reporters (stateful reporters like
    //   JsonlReporter would corrupt each other if shared). Warn once.
    let trialReporters: Reporter[];
    if (this.concurrency <= 1) {
      trialReporters = this.reporters;
    } else if (this.reporterFactory) {
      trialReporters = this.reporterFactory();
    } else {
      if (this.reporters.length > 0 && !this.concurrencyReporterWarningLogged) {
        this.concurrencyReporterWarningLogged = true;
        console.warn(
          "MultiTrialRunner: reporters are shared across concurrent trials, which can corrupt stateful reporters (e.g. JsonlReporter). Provide `reporterFactory` to create per-trial reporter instances. Per-trial reporters dropped for concurrency > 1.",
        );
      }
      trialReporters = [];
    }
    const inner = new EvalRunner({
      driver,
      reporters: trialReporters,
      gitSha: this.gitSha,
      model: this.model,
    });
    try {
      return await inner.runTask(task);
    } finally {
      if (driver.dispose) {
        try {
          await driver.dispose();
        } catch {
          // ignore dispose errors
        }
      }
    }
  }

  private aggregateSample(
    sampleId: string,
    rawRuns: RunResult[],
  ): SampleTrialResult {
    const trials = this.trials;
    let passCount = 0;
    let failCount = 0;
    let errorCount = 0;
    // passResults includes only trials that actually ran (pass or fail).
    // Infra errors are excluded so passAtK uses the same denominator as passRate.
    const passResults: boolean[] = [];
    // Score aggregation: group by name across non-infra-error cases that emitted the score.
    const valuesByName = new Map<string, number[]>();

    for (const run of rawRuns) {
      const c = run.cases.find((x) => x.caseId === sampleId);
      if (!c) {
        // F14: a trial with no case result for this sample is treated as an
        // infrastructure error (lost trial). Without this, passCount + failCount
        // + errorCount could be < trials and the result would fail
        // SampleTrialResultSchema on round-trip.
        errorCount++;
        continue;
      }
      if (c.infraError) {
        errorCount++;
        continue;
      }
      if (c.pass) {
        passCount++;
        passResults.push(true);
      } else {
        failCount++;
        passResults.push(false);
      }
      for (const s of c.scores) {
        let arr = valuesByName.get(s.name);
        if (!arr) {
          arr = [];
          valuesByName.set(s.name, arr);
        }
        arr.push(s.value);
      }
    }

    const nonError = trials - errorCount;
    const passRate = nonError > 0 ? passCount / nonError : undefined;

    // passAtK per k (skip k > trials)
    const passAtKMap: Record<number, number> = {};
    if (passResults.length > 0) {
      for (const k of this.passAtKValues) {
        if (!Number.isInteger(k) || k <= 0) continue;
        if (k > passResults.length) continue;
        passAtKMap[k] = passAtK(passResults, k);
      }
    }

    const scores: Record<
      string,
      { mean: number; stddev: number; n: number; values: number[] }
    > = {};
    for (const [name, values] of valuesByName) {
      const ms = meanStddev(values);
      scores[name] = {
        mean: Number.isFinite(ms.mean) ? ms.mean : 0,
        stddev: Number.isFinite(ms.stddev) ? ms.stddev : 0,
        n: ms.n,
        values,
      };
    }

    const wilsonCI = wilsonInterval(passCount, nonError);

    return {
      sampleId,
      trials,
      passCount,
      failCount,
      errorCount,
      ...(passRate === undefined ? {} : { passRate }),
      ...(passRate === undefined ? { noQualitySignal: true } : {}),
      passAtK: passAtKMap,
      scores,
      wilsonCI,
    };
  }
}
