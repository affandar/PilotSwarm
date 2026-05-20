import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { reporters } from "../registry.js";
import { formatRunStamp, redactForArtifact, safePathSegment } from "../reporters/output.js";
import { RunConfigSchema } from "../schema/config.js";
import { discoverScenarios } from "./discover.js";
import { effectiveDriver, materializeEffectiveRunConfig } from "./effective-config.js";
import { runManagedLiveScenarios } from "./managed-live-runner.js";
import { expandExecutionScenarios } from "./meta-scenarios.js";
import { applyPostRunAnalysis } from "./post-run.js";
import { runScenario } from "./run-scenario.js";
import type { RunConfig, RunManifestResult, ScenarioResult } from "../types.js";

export type RunManifestOptions = {
  runId?: string;
  configPath?: string;
  manifestPath?: string;
  scenariosPath?: string;
  scenarioPaths?: string[];
  driver?: string;
  fake?: boolean;
  reporters?: string[];
  reportsDir?: string;
};

export async function runManifest(options: RunManifestOptions = {}): Promise<RunManifestResult> {
  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();
  const fileConfig = options.configPath
    ? JSON.parse(await readFile(resolve(options.configPath), "utf8")) as Record<string, unknown>
    : {};
  const forcedFake = options.fake || options.driver === "fake";
  const cliOverrides = runConfigCliOverrides(options);
  const outputReportsDir =
    options.reportsDir
    ?? ((fileConfig.output as Record<string, unknown> | undefined)?.reportsDir as string | undefined)
    ?? (fileConfig.reportsDir as string | undefined);
  const parsedConfig = RunConfigSchema.parse({
    ...fileConfig,
    id: options.runId ?? fileConfig.id ?? "wave-a",
    defaults: {
      ...((fileConfig.defaults as Record<string, unknown> | undefined) ?? {}),
      ...(forcedFake ? { driver: "fake" } : options.driver ? { driver: options.driver } : {}),
    },
    ...("reporters" in fileConfig || options.reporters ? { reporters: options.reporters ?? fileConfig.reporters } : {}),
    reportsDir: outputReportsDir,
    output: {
      ...((fileConfig.output as Record<string, unknown> | undefined) ?? {}),
      ...(outputReportsDir ? { reportsDir: outputReportsDir } : {}),
    },
    ...(forcedFake
      ? {
        requirements: {
          ...((fileConfig.requirements as Record<string, unknown> | undefined) ?? {}),
          onUnsupported: "skip",
        },
        llmJudge: {
          ...((fileConfig.llmJudge as Record<string, unknown> | undefined) ?? {}),
          enabled: false,
          onMissingProvider: "skip-with-warning",
        },
        postRun: {
          ...((fileConfig.postRun as Record<string, unknown> | undefined) ?? {}),
          trajectorySummaryEnabled: false,
        },
      }
      : {}),
  });
  const config = materializeEffectiveRunConfig({
    ...parsedConfig,
    ...(options.configPath ? { configPath: resolve(options.configPath) } : {}),
  });
  for (const name of config.reporters ?? []) {
    if (!reporters.has(name)) throw new Error(`Unknown reporter "${name}".`);
  }
  const discoveredScenarios = await discoverScenarios(options);
  const effectiveConfig = config;
  const scenarios = await expandExecutionScenarios(discoveredScenarios, effectiveConfig);
  const rawResults = await runScenariosByDriver(scenarios, effectiveConfig, forcedFake ? "fake" : undefined);
  const results = await Promise.all(rawResults.map((scenarioResult, index) => (
    applyPostRunAnalysis(scenarioResult, scenarios[index]!, effectiveConfig)
  )));
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
  const reportsDir = config.output?.reportsDir ?? config.reportsDir;
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
  if (options.fake) overrides.fake = true;
  if (options.reporters) overrides.reporters = options.reporters;
  if (options.reportsDir) overrides.reportsDir = options.reportsDir;
  return overrides;
}

async function runScenariosByDriver(
  scenarios: Awaited<ReturnType<typeof discoverScenarios>>,
  config: RunConfig,
  forcedDriver?: string,
) {
  const results = new Array<ScenarioResult>(scenarios.length);
  const managedLiveItems: Array<{ scenario: (typeof scenarios)[number]; index: number }> = [];

  for (const [index, scenario] of scenarios.entries()) {
    const driver = effectiveDriver(config, forcedDriver);
    if (driver === "live" || driver === "managed-live") {
      managedLiveItems.push({ scenario, index });
      continue;
    }

    results[index] = await runScenario(scenario, {
      ...config,
      ...(forcedDriver ? { driver: forcedDriver } : {}),
    });
  }

  if (managedLiveItems.length > 0) {
    const liveResults = await runManagedLiveScenarios(managedLiveItems.map((item) => item.scenario), config);
    for (const [resultIndex, item] of managedLiveItems.entries()) {
      results[item.index] = liveResults[resultIndex]!;
    }
  }

  return results;
}

function runBudget(results: ScenarioResult[]): RunManifestResult["budget"] {
  return {
    llmJudgeSpentUsd: sumNumbers(results.flatMap((result) => (
      result.checks.map((check) => nestedNumber(check.metadata, ["judge", "costUsd"]) ?? nestedNumber(check.metadata, ["judge", "estimatedCostUsd"]))
    ))),
    trajectorySummaryCostUsd: sumNumbers(results.map((result) => nestedNumber(result.metadata, ["postRun", "trajectorySummary", "costUsd"]))),
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
