import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunManifestResult, ScenarioResult } from "../types.js";

export type ReporterEmitOptions = {
  reportsDir?: string;
  runOutputDir?: string;
  startedAt?: string;
  finishedAt?: string;
  generatedAt?: string;
};

export type ScenarioReportEntry = {
  result: ScenarioResult;
  directoryName: string;
  status: "PASS" | "FAIL" | "INFRA ERROR" | "SKIP";
};

export function safePathSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    || "item";
}

export function formatRunStamp(date = new Date()): string {
  const iso = date.toISOString();
  return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
}

export function runOutputDirectory(result: RunManifestResult, options?: ReporterEmitOptions): string {
  return options?.runOutputDir
    ?? join(String(options?.reportsDir ?? ".eval-results"), `${formatRunStamp()}-${safePathSegment(result.runId)}`);
}

export function scenarioReportEntries(result: RunManifestResult): ScenarioReportEntry[] {
  const seen = new Map<string, number>();
  return result.scenarios.map((scenario) => {
    const baseName = safePathSegment(scenario.scenarioId);
    const nextCount = (seen.get(baseName) ?? 0) + 1;
    seen.set(baseName, nextCount);
    return {
      result: scenario,
      directoryName: nextCount === 1 ? baseName : `${baseName}-${nextCount}`,
      status: scenario.observed.terminalState === "skipped" ? "SKIP" : scenario.infraError ? "INFRA ERROR" : scenario.passed ? "PASS" : "FAIL",
    };
  });
}

export function runSummary(result: RunManifestResult, options?: ReporterEmitOptions): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: result.runId,
    generatedAt: options?.generatedAt ?? new Date().toISOString(),
    startedAt: result.startedAt ?? options?.startedAt,
    finishedAt: result.finishedAt ?? options?.finishedAt,
    durationMs: result.durationMs,
    passed: result.passed,
    failed: result.failed,
    infraErrors: result.infraErrors,
    skipped: result.skipped,
    totals: {
      scenarios: result.scenarios.length,
      discoveredScenarios: result.configuration.discoveredScenarioCount,
      executionCells: result.configuration.executionCellCount,
      passed: result.passed,
      failed: result.failed,
      infraErrors: result.infraErrors,
      skipped: result.skipped,
      passRate: passRate(result),
    },
    budget: result.budget,
    scenarios: scenarioReportEntries(result).map((entry) => ({
      scenarioId: entry.result.scenarioId,
      kind: entry.result.kind,
      status: entry.status,
      passed: entry.result.passed,
      infraError: Boolean(entry.result.infraError),
      failureMessage: entry.result.failureMessage,
      latencyMs: entry.result.observed.latencyMs,
      costUsd: entry.result.observed.costUsd,
      terminalState: entry.result.observed.terminalState,
      checks: checkCounts(entry.result),
      directory: `scenarios/${entry.directoryName}`,
    })),
  };
}

export function runConfigArtifact(result: RunManifestResult, options?: ReporterEmitOptions): Record<string, unknown> {
  return redactForArtifact({
    schemaVersion: 1,
    runId: result.runId,
    generatedAt: options?.generatedAt ?? new Date().toISOString(),
    configuration: result.configuration,
  });
}

export function redactForArtifact<T>(value: T): T {
  return redactValue(value) as T;
}

export async function writeSummaryJson(
  result: RunManifestResult,
  options?: ReporterEmitOptions,
): Promise<void> {
  const runDir = runOutputDirectory(result, options);
  await mkdir(runDir, { recursive: true });
  await Promise.all([
    writeFile(join(runDir, "summary.json"), `${JSON.stringify(runSummary(result, options), null, 2)}\n`),
    writeFile(join(runDir, "run-config.json"), `${JSON.stringify(runConfigArtifact(result, options), null, 2)}\n`),
  ]);
}

export function passRate(result: RunManifestResult): number {
  const total = result.scenarios.length;
  return total === 0 ? 0 : result.passed / total;
}

export function checkCounts(scenario: ScenarioResult): {
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
} {
  return {
    passed: scenario.checks.filter((check) => check.pass && !check.errored && !check.skipped).length,
    failed: scenario.checks.filter((check) => !check.pass && !check.errored && !check.skipped).length,
    errored: scenario.checks.filter((check) => check.errored).length,
    skipped: scenario.checks.filter((check) => check.skipped).length,
  };
}

export function markdownEscape(value: unknown): string {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\n", "<br>");
}

export function truncate(value: unknown, maxLength = 600): string {
  const text = String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

const REDACTED_VALUE = "[redacted]";
const REDACTED_KEYS = new Set([
  "authorization",
  "cookie",
  "setcookie",
  "apikey",
  "githubtoken",
  "password",
  "secret",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "store",
  "databaseurl",
  "connectionstring",
  "connstring",
  "dsn",
  "pgpassword",
  "pguser",
  "pgconnstring",
  "postgresurl",
  "dburl",
]);
const SECRET_KEY_PATTERNS = [
  "apikey",
  "token",
  "secret",
  "password",
  "authorization",
  "cookie",
  "credential",
  "connectionstring",
  "databaseurl",
];
const NON_SECRET_TOKEN_KEYS = new Set([
  "inputtokens",
  "outputtokens",
  "tokensin",
  "tokensout",
]);
const OMITTED_KEYS = new Set([
  "encryptedcontent",
  "reasoningopaque",
  "reasoningid",
  "apicallid",
  "providercallid",
  "quotasnapshots",
]);

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (!value || typeof value !== "object") return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = normalizeArtifactKey(key);
    if (OMITTED_KEYS.has(normalizedKey)) continue;
    redacted[key] = shouldRedactKey(normalizedKey) ? REDACTED_VALUE : redactValue(child);
  }
  return redacted;
}

function normalizeArtifactKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function shouldRedactKey(normalizedKey: string): boolean {
  if (NON_SECRET_TOKEN_KEYS.has(normalizedKey)) return false;
  return REDACTED_KEYS.has(normalizedKey)
    || SECRET_KEY_PATTERNS.some((pattern) => normalizedKey.includes(pattern));
}
