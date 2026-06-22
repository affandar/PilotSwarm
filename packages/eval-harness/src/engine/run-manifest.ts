import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { reporters } from "../registry.js";
import { formatRunStamp, redactForArtifact, safePathSegment } from "../reporters/output.js";
import { RunConfigSchema } from "../schema/config.js";
import { discoverScenarios } from "./discover.js";
import { effectiveDriver, materializeEffectiveRunConfig } from "./effective-config.js";
import { runManagedLiveScenarios } from "./managed-live-runner.js";
import { runScenario } from "./run-scenario.js";
import type { RunConfig, RunManifestResult, ScenarioResult } from "../types.js";

export type RunManifestOptions = {
  runId?: string;
  configPath?: string;
  manifestPath?: string;
  scenariosPath?: string;
  scenarioPaths?: string[];
  driver?: string;
  reporters?: string[];
  reportsDir?: string;
  onProgress?: (event: EvalProgressEvent) => void | Promise<void>;
};

export type EvalProgressEvent = {
  phase: "discover" | "start" | "finish";
  completed: number;
  total: number;
  scenarioId: string;
  status?: "pass" | "fail" | "infra_error" | "skip";
};

export async function runManifest(options: RunManifestOptions = {}): Promise<RunManifestResult> {
  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();
  const fileConfig = options.configPath
    ? JSON.parse(await readFile(resolve(options.configPath), "utf8")) as Record<string, unknown>
    : {};
  const cliOverrides = runConfigCliOverrides(options);
  const outputReportsDir =
    options.reportsDir
    ?? ((fileConfig.output as Record<string, unknown> | undefined)?.reportsDir as string | undefined);
  const parsedConfig = RunConfigSchema.parse({
    ...fileConfig,
    id: options.runId ?? fileConfig.id ?? "wave-a",
    defaults: {
      ...((fileConfig.defaults as Record<string, unknown> | undefined) ?? {}),
      ...(options.driver ? { driver: options.driver } : {}),
    },
    ...("reporters" in fileConfig || options.reporters ? { reporters: options.reporters ?? fileConfig.reporters } : {}),
    output: {
      ...((fileConfig.output as Record<string, unknown> | undefined) ?? {}),
      ...(outputReportsDir ? { reportsDir: outputReportsDir } : {}),
    },
  });
  const config = materializeEffectiveRunConfig({
    ...parsedConfig,
    ...(options.configPath ? { configPath: resolve(options.configPath) } : {}),
  });
  for (const name of config.reporters ?? []) {
    if (!reporters.has(name)) throw new Error(`Unknown reporter "${name}".`);
  }
  const discoveredScenarios = await discoverScenarios(options);
  for (const [index, scenario] of discoveredScenarios.entries()) {
    await options.onProgress?.({
      phase: "discover",
      completed: index + 1,
      total: discoveredScenarios.length,
      scenarioId: scenario.id,
    });
  }
  const effectiveConfig = config;
  const scenarios = discoveredScenarios;
  const results = await runScenariosByDriver(scenarios, effectiveConfig, options.driver, options.onProgress);
  const finishedAtDate = new Date();
  const finishedAt = finishedAtDate.toISOString();
  const result: RunManifestResult = {
    runId: config.id,
    startedAt,
    finishedAt,
    durationMs: finishedAtDate.getTime() - startedAtDate.getTime(),
    passed: results.filter((scenario) => scenario.passed).length,
    failed: results.filter((scenario) => !scenario.passed && !scenario.infraError && scenario.observed.terminalState !== "skipped").length,
    infraErrors: results.filter((scenario) => scenario.infraError).length,
    skipped: results.filter((scenario) => scenario.observed.terminalState === "skipped").length,
    scenarios: results,
    configuration: {
      ...(options.configPath ? { configPath: resolve(options.configPath) } : {}),
      cliOverrides,
      effectiveRunConfig: redactForArtifact(effectiveConfig) as Record<string, unknown>,
      discoveredScenarioCount: discoveredScenarios.length,
      executionCellCount: scenarios.length,
    },
    budget: runBudget(results)
  };
  const reportsDir = config.output?.reportsDir;
  const runOutputDir = join(reportsDir ?? ".eval-results", `${formatRunStamp(startedAtDate)}-${safePathSegment(result.runId)}`);
  for (const name of options.reporters ?? config.reporters ?? []) {
    const reporter = reporters.get(name);
    if (!reporter) throw new Error(`Unknown reporter "${name}".`);
    await reporter.emit(result, { reportsDir, runOutputDir, startedAt, finishedAt, generatedAt: finishedAt });
  }
  return result;
}

function runConfigCliOverrides(options: RunManifestOptions): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  if (options.runId) overrides.runId = options.runId;
  if (options.driver) overrides.driver = options.driver;
  if (options.reporters) overrides.reporters = options.reporters;
  if (options.reportsDir) overrides.reportsDir = options.reportsDir;
  return overrides;
}

async function runScenariosByDriver(
  scenarios: Awaited<ReturnType<typeof discoverScenarios>>,
  config: RunConfig,
  forcedDriver?: string,
  onProgress?: RunManifestOptions["onProgress"],
) {
  const results = new Array<ScenarioResult>(scenarios.length);
  const managedLiveItems: Array<{ scenario: (typeof scenarios)[number]; index: number }> = [];
  let completed = 0;

  for (const [index, scenario] of scenarios.entries()) {
    const driver = effectiveDriver(config, forcedDriver);
    if (driver === "live") {
      managedLiveItems.push({ scenario, index });
      continue;
    }

    await onProgress?.({ phase: "start", completed, total: scenarios.length, scenarioId: scenario.id });
    results[index] = await runScenario(scenario, {
      ...config,
      ...(forcedDriver ? { driver: forcedDriver } : {}),
    });
    completed += 1;
    await onProgress?.({
      phase: "finish",
      completed,
      total: scenarios.length,
      scenarioId: scenario.id,
      status: progressStatus(results[index]!),
    });
  }

  if (managedLiveItems.length > 0) {
    const liveResults = await runManagedLiveScenarios(
      managedLiveItems.map((item) => item.scenario),
      config,
      {},
      {
        onScenarioStart: async (scenario) => {
          await onProgress?.({ phase: "start", completed, total: scenarios.length, scenarioId: scenario.id });
        },
        onScenarioComplete: async (scenario, result) => {
          completed += 1;
          await onProgress?.({
            phase: "finish",
            completed,
            total: scenarios.length,
            scenarioId: scenario.id,
            status: progressStatus(result),
          });
        },
      },
    );
    for (const [resultIndex, item] of managedLiveItems.entries()) {
      results[item.index] = liveResults[resultIndex]!;
    }
  }

  return results;
}

function progressStatus(result: ScenarioResult): NonNullable<EvalProgressEvent["status"]> {
  if (result.observed.terminalState === "skipped") return "skip";
  if (result.infraError) return "infra_error";
  return result.passed ? "pass" : "fail";
}

function runBudget(results: ScenarioResult[]): RunManifestResult["budget"] {
  return {
    llmJudgeReservedUsd: sumNumbers(results.flatMap((result) => (
      result.checks.map((check) => nestedNumber(check.metadata, ["judge", "costUsd"]) ?? nestedNumber(check.metadata, ["judge", "reservedCostUsd"]))
    ))),
  };
}

function sumNumbers(values: Array<number | undefined>): number {
  return values.reduce<number>((sum, value) => (
    sum + (typeof value === "number" && Number.isFinite(value) ? value : 0)
  ), 0);
}

function nestedNumber(value: unknown, path: string[]): number | undefined {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "number" ? current : undefined;
}
