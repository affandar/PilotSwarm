import { DEFAULT_EVAL_DRIVER, DEFAULT_EVAL_MAX_CELLS, DEFAULT_EVAL_TIMEOUT_MS } from "../defaults.js";
import type { RunConfig, Scenario } from "../types.js";

type DriverConfig = Partial<RunConfig> & { driver?: string };

export function materializeEffectiveRunConfig(config: RunConfig): RunConfig {
  return {
    ...config,
    defaults: {
      models: [],
      trials: 1,
      isolation: "shared-worker",
      concurrent: 1,
      driver: DEFAULT_EVAL_DRIVER,
      timeoutMs: DEFAULT_EVAL_TIMEOUT_MS,
      maxCells: DEFAULT_EVAL_MAX_CELLS,
      ...(config.defaults ?? {}),
    },
    gates: {
      failOnInfraError: false,
      ...(config.gates ?? {}),
    },
    requirements: {
      onUnsupported: "error",
      ...(config.requirements ?? {}),
    },
    output: {
      reportsDir: ".eval-results",
      ...(config.output ?? {}),
    },
    filters: {
      includeTags: [],
      excludeTags: [],
      ...(config.filters ?? {}),
    },
    llmJudge: {
      enabled: false,
      applyTo: "explicit",
      defaultCheck: {},
      onMissingProvider: "skip-with-warning",
      ...(config.llmJudge ?? {}),
    },
    postRun: {
      trajectorySummaryEnabled: false,
      ...(config.postRun ?? {}),
    },
  };
}

export function effectiveDriver(
  config?: DriverConfig,
  forcedDriver?: string,
): string {
  return forcedDriver ?? config?.driver ?? config?.defaults?.driver ?? DEFAULT_EVAL_DRIVER;
}

export function effectiveTimeoutMs(scenario: Scenario, config?: Partial<RunConfig>): number {
  return scenario.runs?.timeoutMs ?? config?.defaults?.timeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS;
}

export function effectiveTrials(scenario: Scenario, config?: Partial<RunConfig>): number {
  const metaTrials = "trials" in scenario && typeof scenario.trials === "number" ? scenario.trials : undefined;
  return metaTrials ?? config?.defaults?.trials ?? 1;
}

export function effectiveMaxCells(scenario: Scenario, config?: Partial<RunConfig>): number {
  return scenario.runs?.maxCells ?? config?.defaults?.maxCells ?? DEFAULT_EVAL_MAX_CELLS;
}

export function unsupportedRequirementPolicy(config?: Partial<RunConfig>): "error" | "skip" {
  return config?.requirements?.onUnsupported ?? "error";
}
