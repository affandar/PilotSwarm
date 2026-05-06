import { randomUUID } from "node:crypto";
import { MultiTrialRunner } from "./multi-trial.js";
import type { Driver } from "./drivers/types.js";
import type {
  EvalTask,
  MatrixCell,
  MatrixConfig,
  MatrixConfigOverrides,
  MatrixPassRateRefSchema,
  MatrixResult,
  MatrixSummary,
} from "./types.js";
import { normalizeMatrixConfig } from "./validation/normalize-result.js";
import type { z } from "zod";

type MatrixPassRateRef = z.infer<typeof MatrixPassRateRefSchema>;

export interface MatrixRunnerOptions {
  driverFactory: () => Driver;
  models: string[];
  configs: MatrixConfig[];
  trials: number;
  passAtKValues?: number[];
  // V2: scores always use exclude policy. Zero-fill deferred to V3.
  gitSha?: string;
  maxCells?: number;
  dryRun?: boolean;
}

export class MatrixRunner {
  private driverFactory: () => Driver;
  private models: string[];
  private configs: MatrixConfig[];
  private trials: number;
  private passAtKValues?: number[];
  private gitSha?: string;
  private maxCells: number;
  private dryRun: boolean;

  constructor(options: MatrixRunnerOptions) {
    if (typeof options !== "object" || options === null) {
      throw new Error("MatrixRunner: options must be a non-null object");
    }
    if (typeof options.driverFactory !== "function") {
      throw new Error("MatrixRunner: driverFactory must be a function");
    }
    if (!Array.isArray(options.models) || options.models.length === 0) {
      throw new Error("MatrixRunner: models must be a non-empty array");
    }
    for (const m of options.models) {
      if (typeof m !== "string" || m.length === 0) {
        throw new Error("MatrixRunner: each model must be a non-empty string");
      }
    }
    if (!Array.isArray(options.configs) || options.configs.length === 0) {
      throw new Error("MatrixRunner: configs must be a non-empty array");
    }
    // B3 (iter19): route every config through MatrixConfigSchema /
    // normalizeMatrixConfig so schema-invalid configs (missing overrides,
    // extra keys, timeoutMs:0/Infinity, etc.) are rejected at construction.
    // We store ONLY the normalized copies so downstream `applyOverrides`
    // cannot encounter an undefined `overrides` slot.
    const normalizedConfigs: MatrixConfig[] = [];
    for (let i = 0; i < options.configs.length; i++) {
      try {
        normalizedConfigs.push(normalizeMatrixConfig(options.configs[i]));
      } catch (err) {
        throw new Error(
          `MatrixRunner: configs[${i}] failed schema validation: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const uniqueModels = new Set(options.models);
    if (uniqueModels.size !== options.models.length) {
      throw new Error("MatrixRunner: duplicate model names");
    }
    const uniqueConfigIds = new Set(normalizedConfigs.map((c) => c.id));
    if (uniqueConfigIds.size !== normalizedConfigs.length) {
      throw new Error("MatrixRunner: duplicate config IDs");
    }
    if (!Number.isInteger(options.trials) || options.trials < 1) {
      throw new Error(
        `MatrixRunner: trials must be an integer >= 1 (got ${options.trials})`,
      );
    }
    if (options.trials > Number.MAX_SAFE_INTEGER) {
      throw new Error("MatrixRunner: trials exceeds MAX_SAFE_INTEGER");
    }
    if (options.passAtKValues !== undefined) {
      if (!Array.isArray(options.passAtKValues)) {
        throw new Error("MatrixRunner: passAtKValues must be an array");
      }
      for (const k of options.passAtKValues) {
        if (!Number.isInteger(k) || k < 1) {
          throw new Error(
            `MatrixRunner: passAtKValues entries must be integers >= 1 (got ${k})`,
          );
        }
      }
    }
    if (options.gitSha !== undefined && typeof options.gitSha !== "string") {
      throw new Error("MatrixRunner: gitSha must be a string when provided");
    }
    this.driverFactory = options.driverFactory;
    this.models = options.models;
    this.configs = normalizedConfigs;
    this.trials = options.trials;
    this.passAtKValues = options.passAtKValues;
    this.gitSha = options.gitSha;
    const maxCellsRaw = options.maxCells ?? 1000;
    if (
      !Number.isFinite(maxCellsRaw) ||
      !Number.isInteger(maxCellsRaw) ||
      maxCellsRaw < 1 ||
      maxCellsRaw > Number.MAX_SAFE_INTEGER
    ) {
      throw new Error(
        `MatrixRunner: maxCells must be a positive safe integer (got ${maxCellsRaw})`,
      );
    }
    this.maxCells = maxCellsRaw;
    this.dryRun = options.dryRun ?? false;
  }

  async runTask(task: EvalTask): Promise<MatrixResult> {
    const runId = randomUUID();
    const startedAt = new Date().toISOString();

    const cells: MatrixCell[] = [];
    const fullCells = this.models.length * this.configs.length * this.trials * task.samples.length;
    if (fullCells > this.maxCells) {
      throw new Error(
        `MatrixRunner: planned matrix size ${fullCells} (models × configs × trials × samples) exceeds maxCells ${this.maxCells}.`,
      );
    }
    for (const model of this.models) {
      for (const config of this.configs) {
        const overriddenTask = applyOverrides(task, config.overrides);
        if (this.dryRun) {
          cells.push({
            model,
            configId: config.id,
            configLabel: config.label,
            result: createDryRunResult(runId, overriddenTask, this.trials, model, this.gitSha, startedAt),
          });
          continue;
        }
        const inner = new MultiTrialRunner({
          driverFactory: this.driverFactory,
          trials: this.trials,
          passAtKValues: this.passAtKValues,
          gitSha: this.gitSha,
          model,
        });
        const result = await inner.runTask(overriddenTask);
        cells.push({
          model,
          configId: config.id,
          configLabel: config.label,
          result,
        });
      }
    }

    const summary = computeSummary(cells);
    const finishedAt = new Date().toISOString();

    return {
      schemaVersion: 1,
      runId,
      taskId: task.id,
      taskVersion: task.version,
      gitSha: this.gitSha,
      startedAt,
      finishedAt,
      models: [...this.models],
      configs: this.configs.map((c) => ({ ...c, overrides: { ...c.overrides } })),
      cells,
      summary,
      ...(this.dryRun ? { dryRun: true } : {}),
    };
  }
}

function createDryRunResult(
  runId: string,
  task: EvalTask,
  trials: number,
  model: string,
  gitSha: string | undefined,
  startedAt: string,
) {
  const ci = { lower: 0, upper: 1, point: 0, z: 1.959964 };
  return {
    schemaVersion: 1 as const,
    runId,
    taskId: task.id,
    taskVersion: task.version,
    gitSha,
    model,
    dryRun: true,
    trials,
    startedAt,
    finishedAt: new Date().toISOString(),
    summary: {
      total: task.samples.length,
      trials,
      noQualitySignal: true,
      stddevPassRate: 0,
      passRateCI: ci,
      pooledPassRateCI: ci,
    },
    samples: task.samples.map((s) => ({
      sampleId: s.id,
      trials,
      passCount: 0,
      failCount: 0,
      errorCount: trials,
      noQualitySignal: true,
      passAtK: {},
      scores: {},
      wilsonCI: ci,
    })),
    rawRuns: [],
  };
}

function applyOverrides(
  task: EvalTask,
  overrides: MatrixConfigOverrides,
): EvalTask {
  const cloned = structuredClone(task);
  for (const sample of cloned.samples) {
    if (overrides.systemMessage !== undefined) {
      sample.input.systemMessage = overrides.systemMessage;
    }
    if (overrides.timeoutMs !== undefined) {
      sample.timeoutMs = overrides.timeoutMs;
    }
  }
  return cloned;
}

function computeSummary(cells: MatrixCell[]): MatrixSummary {
  if (cells.length === 0) {
    throw new Error("MatrixRunner: cannot compute summary with zero cells");
  }

  let best: MatrixPassRateRef = {
    model: cells[0]!.model,
    configId: cells[0]!.configId,
    passRate: cells[0]!.result.summary.meanPassRate,
  };
  let worst: MatrixPassRateRef = { ...best };

  for (let i = 1; i < cells.length; i++) {
    const cell = cells[i]!;
    const rate = cell.result.summary.meanPassRate;
    if ((rate ?? -1) > (best.passRate ?? -1)) {
      best = { model: cell.model, configId: cell.configId, passRate: rate };
    }
    if ((rate ?? 2) < (worst.passRate ?? 2)) {
      worst = { model: cell.model, configId: cell.configId, passRate: rate };
    }
  }

  return {
    totalCells: cells.length,
    bestPassRate: best,
    worstPassRate: worst,
  };
}
