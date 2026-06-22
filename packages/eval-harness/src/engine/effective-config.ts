import { DEFAULT_EVAL_DRIVER, DEFAULT_EVAL_TIMEOUT_MS } from "../defaults.js";
import type { RunConfig, Scenario } from "../types.js";

type DriverConfig = Partial<RunConfig> & { driver?: string };

export function materializeEffectiveRunConfig(config: RunConfig): RunConfig {
  const defaults = config.defaults ?? {};
  return {
    ...config,
    defaults: {
      isolation: "shared-worker",
      concurrent: 1,
      driver: DEFAULT_EVAL_DRIVER,
      timeoutMs: DEFAULT_EVAL_TIMEOUT_MS,
      ...(defaults.isolation ? { isolation: defaults.isolation } : {}),
      ...(defaults.concurrent ? { concurrent: defaults.concurrent } : {}),
      ...(defaults.driver ? { driver: defaults.driver } : {}),
      ...(defaults.timeoutMs ? { timeoutMs: defaults.timeoutMs } : {}),
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
