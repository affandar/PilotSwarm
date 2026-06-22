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

export function scenarioReportEntries(result: RunManifestResult): ScenarioReportEntry[] {
  return result.scenarios.map((scenario) => {
    return {
      result: scenario,
      status: scenario.observed.terminalState === "skipped" ? "SKIP" : scenario.infraError ? "INFRA ERROR" : scenario.passed ? "PASS" : "FAIL",
    };
  });
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

export function redactForArtifact<T>(value: T): T {
  return redactValue(value) as T;
}
