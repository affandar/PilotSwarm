#!/usr/bin/env node
// packages/eval-harness/bin/report.mjs
//
// Aggregate a `.eval-results/<ts>/` directory into a single Markdown
// report. Works on partial runs (some tasks may still be writing) so
// it's safe to invoke mid-flight or after vitest completes.
//
// Usage
// -----
//   bin/report.mjs                          # latest dir under .eval-results/
//   bin/report.mjs <reports-dir>            # specific dir
//   bin/report.mjs --out <path>             # explicit output path
//   bin/report.mjs --stdout                 # write Markdown to stdout
//
// Output: REPORT-<ts>.md in the reports dir (or --out path).
//
// The report layout (in order):
//
//   1. TOC + run header (env fingerprint, suite gates, judge models, wall)
//   2. Top-line totals + ASCII pass-rate bar
//   3. Suite breakdown (FUNCTIONAL / DURABILITY / ABLATIONS / LLM-JUDGE /
//      PERFORMANCE / SAFETY / PROMPT-TESTING / OTHER) with per-suite
//      pass-rate bars and case tables
//   4. Performance highlights (slowest cases, latency p50/p95/p99 by suite,
//      cost-aggregate when present)
//   5. Failures grouped by category, each with reasons + observed response
//      excerpt + key CMS events + raw-artifact pointer
//   6. LLM-judge scores (criterion aggregate + non-pass details)
//   7. Prompt-testing variant matrix (collapsed pt-cell-* rollup)
//   8. "How to read this" + "What to do next" actionable block

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve, basename, join, relative, dirname } from "node:path";

// -------------------------------------------------------------------
// Repo / package layout resolution
// -------------------------------------------------------------------
//
// The script lives at packages/eval-harness/bin/report.mjs. From its
// own URL we walk up two levels to the eval-harness package root and
// three to the repo root. Resolved once at module load — every render
// path goes through these so nothing is hand-typed.

const SCRIPT_PATH = new URL(import.meta.url).pathname;
const PKG_ROOT = resolve(SCRIPT_PATH, "../../"); // packages/eval-harness/
const REPO_ROOT = resolve(PKG_ROOT, "../../"); // monorepo root

/**
 * Render an absolute path inside a backtick code span. If `mustExist`,
 * verifies the path exists on disk and renders `path-not-found:<abs>`
 * when it doesn't, so a broken pointer in the report can never silently
 * mislead a reader.
 */
function renderPath(abs, { mustExist = false } = {}) {
  const a = String(abs);
  if (mustExist && !existsSync(a)) {
    return `\`path-not-found:${a}\``;
  }
  return `\`${a}\``;
}

function repoPath(...parts) {
  return resolve(REPO_ROOT, ...parts);
}

function pkgPath(...parts) {
  return resolve(PKG_ROOT, ...parts);
}

function parseArgs(argv) {
  const opts = { dir: "", out: "", stdout: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") {
      opts.out = argv[++i] ?? "";
    } else if (a === "--out=" || a.startsWith("--out=")) {
      opts.out = a.slice("--out=".length);
    } else if (a === "--stdout") {
      opts.stdout = true;
    } else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else if (!opts.dir) {
      opts.dir = a;
    } else {
      console.error(`unexpected arg: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

function printHelp() {
  console.log(
    "Usage: report.mjs [<reports-dir>] [--out <path>] [--stdout]\n" +
      "Defaults to the most recent dir under packages/eval-harness/.eval-results/.",
  );
}

function findLatestReportsDir() {
  const root = pkgPath(".eval-results");
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  if (dirs.length === 0) return null;
  const sorted = dirs
    .map((name) => {
      const full = join(root, name);
      let mtime;
      try {
        mtime = statSync(full).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { name, full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return sorted[0]?.full ?? null;
}

function readJsonl(path) {
  const lines = [];
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return lines;
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      lines.push(JSON.parse(t));
    } catch {
      // skip malformed line — happens when the writer crashed mid-line
    }
  }
  return lines;
}

// -------------------------------------------------------------------
// Suite mapping
// -------------------------------------------------------------------
//
// taskId is too coarse (every functional/perf/ablation/regression case
// is `tool-call-correctness`). Use a layered classifier on caseId +
// taskId + runId to land each sample in the right capability suite.
// Order matters; first match wins.

const SUITES = [
  "FUNCTIONAL",
  "DURABILITY",
  "ABLATIONS",
  "LLM-JUDGE",
  "PERFORMANCE",
  "SAFETY",
  "PROMPT-TESTING",
  "OTHER",
];

// Each suite header lists the test file(s) that drive it so the reader
// can jump straight from a failing suite to the source. Paths are
// pkg-relative; resolved to absolute via pkgPath() at render time and
// rendered as `path-not-found:` if the file moved.
const SUITE_TEST_FILES = {
  FUNCTIONAL: ["test/live-driver-live.test.ts"],
  DURABILITY: ["test/durability-live.test.ts"],
  ABLATIONS: ["test/ablations-live.test.ts"],
  "LLM-JUDGE": ["test/llm-judge-live.test.ts"],
  PERFORMANCE: [
    "test/performance-live.test.ts",
    "test/perf-resource-live.test.ts",
    "test/perf-cold-warm-live.test.ts",
    "test/perf-concurrency-live.test.ts",
    "test/perf-durability-live.test.ts",
  ],
  SAFETY: ["test/safety-live.test.ts"],
  "PROMPT-TESTING": ["test/prompt-testing-live.test.ts"],
  OTHER: [],
};

function classifySuite({ taskId, caseId, runId }) {
  const tid = String(taskId ?? "");
  const cid = String(caseId ?? "");
  const rid = String(runId ?? "");
  if (tid.startsWith("pt-cell-") || cid.includes("::")) return "PROMPT-TESTING";
  if (tid.startsWith("safety-") || /^(direct|indirect|output|tool-abuse|subjective)\./.test(cid))
    return "SAFETY";
  if (/^perf\./.test(cid) || rid.includes("performance")) return "PERFORMANCE";
  if (/^ablation\./.test(cid)) return "ABLATIONS";
  if (rid === "live-llm-judge" || rid.includes("llm-judge")) return "LLM-JUDGE";
  if (rid.includes("durability") || /durability|chaos|handoff/.test(cid))
    return "DURABILITY";
  if (
    /^live\.functional\./.test(cid) ||
    /^live\.subagent\./.test(cid) ||
    rid.startsWith("live-functional") ||
    rid.startsWith("live-subagent") ||
    rid.startsWith("live-parallel") ||
    rid.startsWith("live-tool-registration")
  )
    return "FUNCTIONAL";
  // Fallback: a bare `single.add.basic` case from `tool-call-correctness`
  // most likely came from an unnamed multi-trial run — treat as FUNCTIONAL
  // smoke unless we have a more specific signal.
  if (cid === "single.add.basic" && tid === "tool-call-correctness") return "FUNCTIONAL";
  return "OTHER";
}

function classifyFailure(sample) {
  if (sample.errored) return "infra";
  if (sample.infraErrorMessage) return "infra";
  for (const s of sample.scores ?? []) {
    if (s.infraError === true) return "infra";
  }
  for (const s of sample.scores ?? []) {
    if (typeof s.name === "string" && s.name.startsWith("judge/")) {
      return "model-quality (judge-graded)";
    }
  }
  for (const s of sample.scores ?? []) {
    if (
      typeof s.reason === "string" &&
      /observed\s+\d+\s*>\s*budget|over budget|peakConnections|dbQueries/.test(
        s.reason,
      )
    ) {
      return "sdk-perf";
    }
  }
  return "model-quality (deterministic grader)";
}

// -------------------------------------------------------------------
// Formatting helpers
// -------------------------------------------------------------------

function fmtDur(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function pct(n, d) {
  if (!d) return "—";
  return `${((n / d) * 100).toFixed(1)}%`;
}

function escapeCell(s) {
  if (s == null) return "";
  return String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function bar(passed, total, width = 24) {
  if (!total) return "·".repeat(width);
  const filled = Math.round((passed / total) * width);
  const empty = width - filled;
  return `${"█".repeat(filled)}${"░".repeat(empty)}`;
}

function pctNum(n, d) {
  if (!d) return 0;
  return (n / d) * 100;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function truncate(s, n) {
  if (typeof s !== "string") return "";
  if (s.length <= n) return s;
  return `${s.slice(0, n).trimEnd()}…`;
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// -------------------------------------------------------------------
// Environment fingerprint (best-effort, no secrets)
// -------------------------------------------------------------------

function dbHost(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.host || null;
  } catch {
    // Plain `host:port/db` strings — grab anything between // and / or @ and /
    const m = String(url).match(/@([^/?]+)/);
    return m ? m[1] : null;
  }
}

// Try to read RUN-META.json (written by bin/run-live.sh before vitest)
// from the reports dir. Falls back to empty meta if not present.
function readRunMeta(reportsDir) {
  try {
    const raw = readFileSync(join(reportsDir, "RUN-META.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function envFingerprint(reportsDir) {
  const meta = reportsDir ? readRunMeta(reportsDir) : null;
  const e = process.env;
  // Precedence per field: meta value if non-empty, else process.env, else
  // null. RUN-META.json is the authoritative record of what gates were
  // active for the actual vitest run; process.env at report-generation
  // time may be stale (post-vitest) or missing (running report.mjs from
  // a fresh shell).
  const pick = (metaVal, envVal) => {
    if (metaVal !== undefined && metaVal !== null && metaVal !== "") return metaVal;
    if (envVal !== undefined && envVal !== null && envVal !== "") return envVal;
    return null;
  };
  const g = meta?.gates ?? {};
  const m = meta?.models ?? {};
  const i = meta?.infra ?? {};
  return {
    LIVE: pick(g.LIVE, e.LIVE),
    LIVE_JUDGE: pick(g.LIVE_JUDGE, e.LIVE_JUDGE),
    PERF_HEAVY: pick(g.PERF_HEAVY, e.PERF_HEAVY),
    PERF_HEAVY_N8: pick(g.PERF_HEAVY_N8, e.PERF_HEAVY_N8),
    PERF_DURABILITY: pick(g.PERF_DURABILITY, e.PERF_DURABILITY),
    PG_STAT_STATEMENTS_ENABLED: pick(g.PG_STAT_STATEMENTS_ENABLED, e.PG_STAT_STATEMENTS_ENABLED),
    PROMPT_TESTING: pick(g.PROMPT_TESTING, e.PROMPT_TESTING),
    PS_EVAL_FILE_PARALLELISM: pick(g.PS_EVAL_FILE_PARALLELISM, e.PS_EVAL_FILE_PARALLELISM),
    LIVE_JUDGE_MODEL: pick(m.LIVE_JUDGE_MODEL, e.LIVE_JUDGE_MODEL),
    LIVE_JUDGE_MODEL_A: pick(m.LIVE_JUDGE_MODEL_A, e.LIVE_JUDGE_MODEL_A),
    LIVE_JUDGE_MODEL_B: pick(m.LIVE_JUDGE_MODEL_B, e.LIVE_JUDGE_MODEL_B),
    LIVE_MATRIX_MODELS: pick(m.LIVE_MATRIX_MODELS, e.LIVE_MATRIX_MODELS),
    LIVE_ABLATION_MODELS: pick(m.LIVE_ABLATION_MODELS, e.LIVE_ABLATION_MODELS),
    PROMPT_TESTING_MODELS: pick(m.PROMPT_TESTING_MODELS, e.PROMPT_TESTING_MODELS),
    DATABASE_HOST: pick(i.DATABASE_HOST, dbHost(e.DATABASE_URL)),
    GITHUB_TOKEN_PRESENT:
      i.GITHUB_TOKEN_PRESENT ?? (e.GITHUB_TOKEN ? "yes" : "no"),
    OPENAI_API_KEY_PRESENT:
      i.OPENAI_API_KEY_PRESENT ?? (e.OPENAI_API_KEY ? "yes" : "no"),
    PS_MODEL_PROVIDERS_PATH: pick(i.PS_MODEL_PROVIDERS_PATH, e.PS_MODEL_PROVIDERS_PATH),
    _metaSource: meta ? "RUN-META.json" : "process.env (no RUN-META.json found)",
  };
}

// -------------------------------------------------------------------
// Aggregation
// -------------------------------------------------------------------

function aggregate(dir) {
  const entries = readdirSync(dir);
  const jsonl = entries.filter((n) => n.endsWith(".jsonl"));

  const samples = []; // enriched
  const summaries = [];
  const failureDetailFiles = new Set(
    entries.filter((n) => {
      const full = join(dir, n);
      try {
        return statSync(full).isDirectory();
      } catch {
        return false;
      }
    }),
  );

  let earliestRun = null;
  let latestSummary = null;

  for (const name of jsonl) {
    const lines = readJsonl(join(dir, name));
    const runLine = lines.find((l) => l.type === "run");
    const summaryLine = lines.find((l) => l.type === "summary");
    const sampleLines = lines.filter((l) => l.type === "sample");

    const runId =
      runLine?.runId ?? summaryLine?.runId ?? basename(name, ".jsonl");
    const taskId =
      summaryLine?.taskId ?? runLine?.task ?? basename(name, ".jsonl").slice(0, 8);

    if (runLine?.startedAt) {
      const t = new Date(runLine.startedAt).getTime();
      if (!earliestRun || t < earliestRun) earliestRun = t;
    }
    if (summaryLine?.finishedAt) {
      const t = new Date(summaryLine.finishedAt).getTime();
      if (!latestSummary || t > latestSummary) latestSummary = t;
    }
    if (summaryLine) {
      summaries.push({ ...summaryLine, runId, taskId, jsonlFile: name });
    }

    for (const s of sampleLines) {
      const suite = classifySuite({
        taskId,
        caseId: s.caseId,
        runId,
      });
      // Determine failure-detail file path (relative to dir) if present
      let failDetail = null;
      if (s.pass === false || s.errored === true) {
        // EvalRunner writes <dir>/<runId>/<sanitizedCaseId>.json. Try a
        // few sanitization variants — the runner has shifted between
        // keeping `.` and replacing it.
        const variants = [
          String(s.caseId ?? "").replace(/[^A-Za-z0-9._-]/g, "_"),
          String(s.caseId ?? "").replace(/[^A-Za-z0-9_-]/g, "_"),
        ];
        for (const v of variants) {
          const rel = join(runId, `${v}.json`);
          if (existsSync(join(dir, rel))) {
            failDetail = rel;
            break;
          }
        }
        if (!failDetail && failureDetailFiles.has(runId)) {
          // Fall back to a single matching file in the runId dir
          try {
            const files = readdirSync(join(dir, runId));
            const json = files.find((f) => f.endsWith(".json"));
            if (json) failDetail = join(runId, json);
          } catch {
            // ignore
          }
        }
      }
      // `infraError` may be a string error message (preserved by EvalRunner
      // for driver timeouts / transport errors). Capture it for the failure
      // renderer; treat it as infra in classifyFailure().
      const infraErrorMessage =
        typeof s.infraError === "string" && s.infraError.length > 0
          ? s.infraError
          : null;
      samples.push({
        runId,
        taskId,
        suite,
        caseId: s.caseId,
        pass: s.pass,
        errored: s.errored === true,
        infraErrorMessage,
        scores: s.scores ?? [],
        observed: s.observed ?? {},
        durationMs: s.durationMs,
        latencyMs: s.observed?.latencyMs,
        failDetail,
        jsonlFile: name,
      });
    }
  }

  return {
    dir,
    earliestRun,
    latestSummary,
    summaries,
    samples,
  };
}

function summariseSuites(samples, summaries) {
  const bySuite = new Map();
  for (const s of SUITES) {
    bySuite.set(s, {
      suite: s,
      total: 0,
      passed: 0,
      failed: 0,
      errored: 0,
      latencies: [],
      cases: new Map(), // caseId -> {runs, passed, failed, errored, latencies}
      runIds: new Set(),
    });
  }
  for (const sample of samples) {
    const b = bySuite.get(sample.suite);
    b.total += 1;
    const isInfra = sample.errored || sample.infraErrorMessage;
    if (isInfra) b.errored += 1;
    else if (sample.pass) b.passed += 1;
    else b.failed += 1;
    if (typeof sample.latencyMs === "number") b.latencies.push(sample.latencyMs);
    b.runIds.add(sample.runId);
    const caseKey = sample.caseId ?? "(no caseId)";
    if (!b.cases.has(caseKey)) {
      b.cases.set(caseKey, {
        caseId: caseKey,
        runs: 0,
        passed: 0,
        failed: 0,
        errored: 0,
        latencies: [],
      });
    }
    const c = b.cases.get(caseKey);
    c.runs += 1;
    if (isInfra) c.errored += 1;
    else if (sample.pass) c.passed += 1;
    else c.failed += 1;
    if (typeof sample.latencyMs === "number") c.latencies.push(sample.latencyMs);
  }
  // Compute percentiles
  for (const b of bySuite.values()) {
    const sorted = [...b.latencies].sort((a, b) => a - b);
    b.p50 = percentile(sorted, 0.5);
    b.p95 = percentile(sorted, 0.95);
    b.p99 = percentile(sorted, 0.99);
    for (const c of b.cases.values()) {
      const cs = [...c.latencies].sort((a, b) => a - b);
      c.p50 = percentile(cs, 0.5);
      c.p95 = percentile(cs, 0.95);
    }
  }
  return bySuite;
}

// -------------------------------------------------------------------
// CMS event filtering — pull a few key event types per failure to
// explain "what the agent actually did" without dumping the full log.
// -------------------------------------------------------------------

const KEY_CMS_EVENTS = new Set([
  "user.message",
  "session.turn_started",
  "session.turn_completed",
  "tool.user_requested",
  "tool.executed",
  "tool.failed",
  "guardrail.decision",
  "session.error",
  "session.refused",
  "session.assistant_message",
  "subagent.spawned",
  "subagent.completed",
]);

function summariseCmsEvents(events, max = 6) {
  if (!Array.isArray(events) || events.length === 0) return [];
  const picked = events.filter((e) => KEY_CMS_EVENTS.has(e?.eventType));
  // Always include first user.message + last turn_completed + any tool.*
  // events even if total exceeds `max` — prioritize tool.* because that's
  // where the actionable signal lives.
  const ordered = [];
  const seen = new Set();
  const push = (ev) => {
    const k = `${ev.seq}-${ev.eventType}`;
    if (seen.has(k)) return;
    seen.add(k);
    ordered.push(ev);
  };
  for (const ev of picked) {
    if (ev.eventType?.startsWith("tool.")) push(ev);
  }
  for (const ev of picked) {
    if (ev.eventType === "guardrail.decision") push(ev);
  }
  for (const ev of picked) {
    if (
      ev.eventType === "session.turn_started" ||
      ev.eventType === "session.turn_completed"
    )
      push(ev);
  }
  for (const ev of picked) push(ev);
  ordered.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return ordered.slice(0, max);
}

function fmtCmsEvent(ev) {
  const t = ev.eventType;
  const data = ev.data ?? {};
  if (t === "tool.user_requested" || t === "tool.executed" || t === "tool.failed") {
    const tool = data.toolName ?? data.name ?? "?";
    const args =
      data.args && typeof data.args === "object"
        ? JSON.stringify(data.args).slice(0, 100)
        : "";
    return `\`${t}\` → ${tool}${args ? ` ${args}` : ""}`;
  }
  if (t === "guardrail.decision") {
    return `\`${t}\` → ${data.action ?? "?"} (${truncate(data.reason ?? "", 60)})`;
  }
  if (t === "session.turn_completed" || t === "session.turn_started") {
    return `\`${t}\` (turn ${data.iteration ?? "?"})`;
  }
  if (t === "user.message") {
    return `\`${t}\` ${truncate(String(data.content ?? ""), 80)}`;
  }
  return `\`${t}\``;
}

// -------------------------------------------------------------------
// Markdown rendering
// -------------------------------------------------------------------

function renderMarkdown(agg) {
  const out = [];
  const totals = { total: 0, passed: 0, failed: 0, errored: 0 };
  for (const s of agg.samples) {
    totals.total += 1;
    if (s.errored || s.infraErrorMessage) totals.errored += 1;
    else if (s.pass) totals.passed += 1;
    else totals.failed += 1;
  }
  const wallMs =
    agg.earliestRun && agg.latestSummary
      ? agg.latestSummary - agg.earliestRun
      : null;
  const reportTs = new Date().toISOString();
  const env = envFingerprint(agg.dir);
  const bySuite = summariseSuites(agg.samples, agg.summaries);

  // -----------------------------------------------------------------
  // Header
  // -----------------------------------------------------------------
  out.push(`# Eval Harness Report — ${basename(agg.dir)}`);
  out.push("");
  out.push(
    `Generated \`${reportTs}\` by \`packages/eval-harness/bin/report.mjs\`. Source: \`${agg.dir}\`.`,
  );
  out.push("");

  // Stamp: in-flight vs complete (best effort — partial run if any sample
  // file lacks a summary line)
  const samplesWithoutSummary = agg.samples.filter(
    (s) => !agg.summaries.some((su) => su.runId === s.runId),
  ).length;
  const inFlight = samplesWithoutSummary > 0;
  if (inFlight) {
    out.push(
      `> **In-flight:** ${samplesWithoutSummary} sample(s) seen without a matching summary line — vitest may still be writing. Re-run \`bin/report.mjs\` to refresh.`,
    );
    out.push("");
  }

  // -----------------------------------------------------------------
  // TOC
  // -----------------------------------------------------------------
  out.push("## Contents");
  out.push("");
  out.push("- [Run context](#run-context)");
  out.push("- [Paths](#paths)");
  out.push("- [Top-line totals](#top-line-totals)");
  out.push("- [Suite breakdown](#suite-breakdown)");
  for (const suite of SUITES) {
    const b = bySuite.get(suite);
    if (b.total === 0) continue;
    out.push(`  - [${suite}](#suite-${slug(suite)})`);
  }
  out.push("- [Performance highlights](#performance-highlights)");
  out.push("- [Failures](#failures)");
  out.push("- [LLM-judge scores](#llm-judge-scores)");
  out.push("- [Prompt-testing variants](#prompt-testing-variants)");
  out.push("- [How to read this](#how-to-read-this)");
  out.push("- [What to do next](#what-to-do-next)");
  out.push("- [Where to look next](#where-to-look-next)");
  out.push("");

  // -----------------------------------------------------------------
  // Run context
  // -----------------------------------------------------------------
  out.push('<a id="run-context"></a>');
  out.push("## Run context");
  out.push("");
  out.push("| Setting | Value |");
  out.push("|---|---|");
  out.push(`| Wall clock (run window) | ${wallMs ? fmtDur(wallMs) : "in progress / unknown"} |`);
  if (agg.earliestRun)
    out.push(`| Earliest run start | \`${new Date(agg.earliestRun).toISOString()}\` |`);
  if (agg.latestSummary)
    out.push(`| Latest summary write | \`${new Date(agg.latestSummary).toISOString()}\` |`);
  out.push(`| Tasks (jsonl files seen) | ${agg.summaries.length} |`);
  out.push(`| Samples observed | ${agg.samples.length} |`);
  out.push("");
  out.push(`**Suite gates** (source: ${env._metaSource}):`);
  out.push("");
  out.push("| Gate | Value |");
  out.push("|---|---|");
  for (const k of [
    "LIVE",
    "LIVE_JUDGE",
    "PERF_HEAVY",
    "PERF_HEAVY_N8",
    "PERF_DURABILITY",
    "PG_STAT_STATEMENTS_ENABLED",
    "PROMPT_TESTING",
    "PS_EVAL_FILE_PARALLELISM",
  ]) {
    out.push(`| ${k} | ${env[k] ?? "—"} |`);
  }
  out.push("");
  out.push("**Models / credentials** (presence-only for secrets):");
  out.push("");
  out.push("| Var | Value |");
  out.push("|---|---|");
  for (const k of [
    "LIVE_JUDGE_MODEL",
    "LIVE_JUDGE_MODEL_A",
    "LIVE_JUDGE_MODEL_B",
    "LIVE_MATRIX_MODELS",
    "LIVE_ABLATION_MODELS",
    "PROMPT_TESTING_MODELS",
    "DATABASE_HOST",
    "GITHUB_TOKEN_PRESENT",
    "OPENAI_API_KEY_PRESENT",
    "PS_MODEL_PROVIDERS_PATH",
  ]) {
    out.push(`| ${k} | ${env[k] ?? "—"} |`);
  }
  out.push("");

  // -----------------------------------------------------------------
  // Paths — every absolute path the reader might want to open, in one
  // place, all verified with existsSync at render time.
  // -----------------------------------------------------------------
  out.push('<a id="paths"></a>');
  out.push("## Paths");
  out.push("");
  out.push("All paths absolute. Open in your editor / `cd`-able directly. Missing paths render as `path-not-found:<abs>`.");
  out.push("");
  out.push("| What | Path |");
  out.push("|---|---|");
  out.push(`| Reports dir (this run) | ${renderPath(agg.dir, { mustExist: true })} |`);
  out.push(`| Repo root | ${renderPath(REPO_ROOT, { mustExist: true })} |`);
  out.push(`| Eval-harness package | ${renderPath(PKG_ROOT, { mustExist: true })} |`);
  out.push(
    `| System prompt under test | ${renderPath(repoPath("packages/sdk/plugins/system/agents/default.agent.md"), { mustExist: true })} |`,
  );
  out.push(`| Live test root | ${renderPath(pkgPath("test"), { mustExist: true })} |`);
  out.push(`| Source root | ${renderPath(pkgPath("src"), { mustExist: true })} |`);
  out.push(`| Datasets dir | ${renderPath(pkgPath("datasets"), { mustExist: true })} |`);
  const goldensDir = pkgPath("datasets/goldens");
  if (existsSync(goldensDir)) {
    out.push(`| Goldens dir | ${renderPath(goldensDir, { mustExist: true })} |`);
  } else {
    out.push(
      `| Goldens dir | _(not yet captured — see \`packages/eval-harness/docs/PROMPT-ITERATION.md\` § Golden-snapshot regression flow)_ |`,
    );
  }
  out.push(`| Run-live wrapper | ${renderPath(pkgPath("bin/run-live.sh"), { mustExist: true })} |`);
  out.push(`| Report generator | ${renderPath(pkgPath("bin/report.mjs"), { mustExist: true })} |`);
  out.push("");

  // -----------------------------------------------------------------
  // Top-line totals
  // -----------------------------------------------------------------
  out.push('<a id="top-line-totals"></a>');
  out.push("## Top-line totals");
  out.push("");
  const passRate = pctNum(totals.passed, totals.total);
  out.push("```");
  out.push(
    `Pass rate  ${bar(totals.passed, totals.total, 32)}  ${passRate.toFixed(1)}%   (${totals.passed}/${totals.total})`,
  );
  out.push(
    `Quality    fail=${totals.failed}    Infra err=${totals.errored}    Wall=${
      wallMs ? fmtDur(wallMs) : "—"
    }`,
  );
  out.push("```");
  out.push("");
  out.push("| metric | value |");
  out.push("|---|---:|");
  out.push(`| Total cases | ${totals.total} |`);
  out.push(`| Passed | ${totals.passed} |`);
  out.push(`| Failed (quality) | ${totals.failed} |`);
  out.push(`| Errored (infra) | ${totals.errored} |`);
  out.push(`| Pass rate | ${pct(totals.passed, totals.total)} |`);
  out.push(`| Infra error rate | ${pct(totals.errored, totals.total)} |`);
  out.push("");

  // -----------------------------------------------------------------
  // Suite breakdown
  // -----------------------------------------------------------------
  out.push('<a id="suite-breakdown"></a>');
  out.push("## Suite breakdown");
  out.push("");
  out.push("| Suite | Cases | Pass | Fail | Err | Pass rate | Bar | p50 | p95 |");
  out.push("|---|---:|---:|---:|---:|---:|---|---:|---:|");
  for (const suite of SUITES) {
    const b = bySuite.get(suite);
    if (b.total === 0) continue;
    out.push(
      `| [${suite}](#suite-${slug(suite)}) | ${b.total} | ${b.passed} | ${b.failed} | ${b.errored} | ${pct(b.passed, b.total)} | \`${bar(b.passed, b.total, 12)}\` | ${fmtDur(b.p50)} | ${fmtDur(b.p95)} |`,
    );
  }
  out.push("");

  for (const suite of SUITES) {
    const b = bySuite.get(suite);
    if (b.total === 0) continue;
    out.push(`<a id="suite-${slug(suite)}"></a>`);
    out.push(`### ${suite}`);
    out.push("");
    out.push(
      `\`${bar(b.passed, b.total, 24)}\` ${pct(b.passed, b.total)}  (${b.passed}/${b.total} pass, ${b.failed} fail, ${b.errored} infra-err)`,
    );
    out.push("");
    const testFiles = SUITE_TEST_FILES[suite] ?? [];
    if (testFiles.length > 0) {
      out.push(
        `_Test file${testFiles.length === 1 ? "" : "s"}:_ ${testFiles
          .map((rel) => renderPath(pkgPath(rel), { mustExist: true }))
          .join(", ")}`,
      );
      out.push("");
    }
    if (suite === "PROMPT-TESTING") {
      // Collapsed roll-up — full detail in the Prompt-testing variants section
      out.push(
        `_Per-cell detail in [Prompt-testing variants](#prompt-testing-variants). ${b.cases.size} variant cell(s) across ${b.runIds.size} run(s)._`,
      );
      out.push("");
      continue;
    }
    out.push("| Case | Runs | Pass | Fail | Err | Pass rate | p50 | p95 |");
    out.push("|---|---:|---:|---:|---:|---:|---:|---:|");
    const sortedCases = [...b.cases.values()].sort((a, b) =>
      String(a.caseId).localeCompare(String(b.caseId)),
    );
    for (const c of sortedCases) {
      out.push(
        `| ${escapeCell(c.caseId)} | ${c.runs} | ${c.passed} | ${c.failed} | ${c.errored} | ${pct(c.passed, c.runs)} | ${fmtDur(c.p50)} | ${fmtDur(c.p95)} |`,
      );
    }
    out.push("");
  }

  // -----------------------------------------------------------------
  // Performance highlights
  // -----------------------------------------------------------------
  out.push('<a id="performance-highlights"></a>');
  out.push("## Performance highlights");
  out.push("");
  out.push("**Latency percentiles by suite** (across all sample latencies):");
  out.push("");
  out.push("| Suite | n | p50 | p95 | p99 |");
  out.push("|---|---:|---:|---:|---:|");
  for (const suite of SUITES) {
    const b = bySuite.get(suite);
    if (!b.latencies.length) continue;
    out.push(
      `| ${suite} | ${b.latencies.length} | ${fmtDur(b.p50)} | ${fmtDur(b.p95)} | ${fmtDur(b.p99)} |`,
    );
  }
  out.push("");

  // Top-N slowest
  const slowest = [...agg.samples]
    .filter((s) => typeof s.latencyMs === "number")
    .sort((a, b) => (b.latencyMs ?? 0) - (a.latencyMs ?? 0))
    .slice(0, 10);
  if (slowest.length > 0) {
    out.push("**Top-10 slowest cases:**");
    out.push("");
    out.push("| # | Suite | Case | Latency | Pass |");
    out.push("|---:|---|---|---:|:---:|");
    slowest.forEach((s, i) => {
      out.push(
        `| ${i + 1} | ${s.suite} | ${escapeCell(s.caseId)} | ${fmtDur(s.latencyMs)} | ${s.errored || s.infraErrorMessage ? "ERR" : s.pass ? "✓" : "✗"} |`,
      );
    });
    out.push("");
  }

  // Most-failing cases (by caseId across runs)
  const failuresByCase = new Map();
  for (const s of agg.samples) {
    if (s.pass === false || s.errored) {
      const k = `${s.suite}::${s.caseId}`;
      if (!failuresByCase.has(k)) {
        failuresByCase.set(k, { suite: s.suite, caseId: s.caseId, count: 0 });
      }
      failuresByCase.get(k).count += 1;
    }
  }
  const topFailing = [...failuresByCase.values()]
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  if (topFailing.length > 0) {
    out.push("**Top-10 most-failing cases:**");
    out.push("");
    out.push("| # | Suite | Case | Failures |");
    out.push("|---:|---|---|---:|");
    topFailing.forEach((f, i) => {
      out.push(`| ${i + 1} | ${f.suite} | ${escapeCell(f.caseId)} | ${f.count} |`);
    });
    out.push("");
  }

  // Cost aggregate (only render if any sample carries it)
  const costed = agg.samples
    .map((s) => s.observed?.actualCostUsd)
    .filter((x) => typeof x === "number" && Number.isFinite(x));
  if (costed.length > 0) {
    const total = costed.reduce((a, b) => a + b, 0);
    out.push(`**Total observed cost:** \`$${total.toFixed(4)}\` across ${costed.length} sample(s).`);
    out.push("");
  } else {
    out.push(
      "_Cost aggregate: n/a — no sample carried `observed.actualCostUsd`. Live judge runs would surface this via `JudgeCost.estimatedCostUsd`; deterministic samples would need a cost tracker wired through `EvalRunner`._",
    );
    out.push("");
  }

  out.push(
    "_DB-budget signal (peakConnections, dbQueries) is not written through `EvalRunner` to the jsonl stream; check the vitest console log directly for `LatencyTracker` / `DbTracker` / `PgActivityPoller` output during `--pg-stat` runs._",
  );
  out.push("");

  // -----------------------------------------------------------------
  // Failures
  // -----------------------------------------------------------------
  const fails = agg.samples.filter((s) => s.pass === false || s.errored);
  out.push('<a id="failures"></a>');
  out.push(`## Failures (${fails.length})`);
  out.push("");
  if (fails.length === 0) {
    out.push("_No failures recorded._");
    out.push("");
  } else {
    const byCat = new Map();
    for (const f of fails) {
      const cat = classifyFailure(f);
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push(f);
    }
    const order = [
      "infra",
      "sdk-perf",
      "model-quality (deterministic grader)",
      "model-quality (judge-graded)",
    ];
    const seenCats = [...byCat.keys()].sort((a, b) => {
      const ai = order.indexOf(a);
      const bi = order.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
    for (const cat of seenCats) {
      const items = byCat.get(cat);
      out.push(`### ${cat} (${items.length})`);
      out.push("");
      for (const f of items) {
        const failingScores = (f.scores ?? []).filter((sc) => sc.pass === false);
        const grouped = new Map();
        for (const sc of failingScores) {
          const baseName = String(sc.name).split(":")[0]; // collapse `tool-args:test_add` → `tool-args`
          if (!grouped.has(baseName)) grouped.set(baseName, []);
          grouped.get(baseName).push(sc);
        }
        const header =
          `**[${f.suite}] ${escapeCell(f.caseId)}** ` +
          `(${fmtDur(f.durationMs)} dur, ${fmtDur(f.latencyMs)} latency, run \`${f.runId}\`)`;
        out.push(`- ${header}`);
        if (f.infraErrorMessage) {
          out.push(
            `  - **infraError:** ${escapeCell(truncate(f.infraErrorMessage, 240))}`,
          );
        }
        for (const [name, scs] of grouped) {
          if (scs.length === 1) {
            out.push(`  - **${name}**: ${escapeCell(scs[0].reason ?? "(no reason)")}`);
          } else {
            out.push(`  - **${name}** (${scs.length} variant(s)):`);
            for (const sc of scs) {
              out.push(
                `    - \`${sc.name}\`: ${escapeCell(sc.reason ?? "(no reason)")}`,
              );
            }
          }
        }
        const resp = f.observed?.finalResponse;
        if (typeof resp === "string" && resp.length > 0) {
          out.push(
            `  - _observed response (${resp.length} chars, truncated):_ ${"`"}${escapeCell(truncate(resp, 240))}${"`"}`,
          );
        }
        // Tool-call summary (compact, complements cmsEvents)
        const tcalls = f.observed?.toolCalls;
        if (Array.isArray(tcalls) && tcalls.length > 0) {
          const summary = tcalls
            .slice(0, 5)
            .map(
              (t) =>
                `${t.name ?? "?"}(${
                  t.args ? truncate(JSON.stringify(t.args), 60) : ""
                })`,
            )
            .join(", ");
          const more = tcalls.length > 5 ? ` +${tcalls.length - 5} more` : "";
          out.push(`  - _tool calls (${tcalls.length}):_ ${summary}${more}`);
        }
        // Key CMS events
        const evts = summariseCmsEvents(f.observed?.cmsEvents);
        if (evts.length > 0) {
          out.push(`  - _key CMS events:_`);
          for (const ev of evts) {
            out.push(`    - seq=${ev.seq} ${fmtCmsEvent(ev)}`);
          }
        }
        // Absolute paths for every artifact + a re-run command
        out.push(
          `  - _raw jsonl:_ ${renderPath(join(agg.dir, f.jsonlFile), { mustExist: true })}`,
        );
        if (f.failDetail) {
          out.push(
            `  - _failure detail:_ ${renderPath(join(agg.dir, f.failDetail), { mustExist: true })}`,
          );
        }
        const suiteFiles = SUITE_TEST_FILES[f.suite] ?? [];
        if (suiteFiles.length > 0) {
          out.push(
            `  - _test file${suiteFiles.length === 1 ? "" : "s"}:_ ${suiteFiles
              .map((rel) => renderPath(pkgPath(rel), { mustExist: true }))
              .join(", ")}`,
          );
          // Re-run hint — first test file gets the full command; the
          // user picks `-t '<token>'` from runId or caseId. Prefer a
          // human-readable runId (e.g. `live-functional-spawn-agent` →
          // `spawn-agent`) when it exists; fall back to caseId. Skip
          // GUID-shaped runIds — vitest's `-t` would never match them.
          const guidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/.test(
            String(f.runId ?? ""),
          );
          const filterToken =
            !guidLike && typeof f.runId === "string" && /^[a-z]/.test(f.runId)
              ? f.runId.replace(/^(live-|safety-)/, "")
              : String(f.caseId ?? "");
          out.push(
            `  - _re-run:_ \`${pkgPath("bin/run-live.sh")} -- ${pkgPath(suiteFiles[0])} -t '${filterToken}'\``,
          );
        }
        out.push("");
      }
    }
  }

  // -----------------------------------------------------------------
  // LLM-judge scores
  // -----------------------------------------------------------------
  const judgeScores = [];
  for (const s of agg.samples) {
    for (const sc of s.scores ?? []) {
      if (typeof sc.name === "string" && sc.name.startsWith("judge/")) {
        judgeScores.push({
          suite: s.suite,
          taskId: s.taskId,
          caseId: s.caseId,
          runId: s.runId,
          jsonlFile: s.jsonlFile,
          criterion: sc.name.replace(/^judge\//, ""),
          value: sc.value,
          pass: sc.pass,
          infraError: sc.infraError === true,
          reason: sc.reason ?? "",
          metadata: sc.metadata ?? null,
        });
      }
    }
  }
  out.push('<a id="llm-judge-scores"></a>');
  out.push("## LLM-judge scores");
  out.push("");
  // Always show the judge-source paths so the user can debug judge
  // behavior independently of whether this run produced any scores.
  const judgeClientOpenAI = pkgPath("src/graders/openai-judge-client.ts");
  const judgeClientPS = pkgPath("src/graders/pilotswarm-judge-client.ts");
  const judgeClientsDoc = pkgPath("docs/JUDGE-CLIENTS.md");
  out.push("**Judge source paths:**");
  out.push("");
  out.push(`- OpenAI judge client: ${renderPath(judgeClientOpenAI, { mustExist: true })}`);
  out.push(`- PilotSwarm judge client: ${renderPath(judgeClientPS, { mustExist: true })}`);
  out.push(`- Selection precedence + cost-rate contract: ${renderPath(judgeClientsDoc, { mustExist: true })}`);
  out.push("");
  if (judgeScores.length === 0) {
    out.push(
      `_No \`judge/*\` scores in this run. LLM-judge tests require \`LIVE_JUDGE=1\` and credentials; see ${renderPath(pkgPath("docs/SUITES.md"), { mustExist: true })} § LLM-JUDGE._`,
    );
    out.push("");
  } else {
    const byCrit = new Map();
    for (const j of judgeScores) {
      if (!byCrit.has(j.criterion))
        byCrit.set(j.criterion, { total: 0, pass: 0, infra: 0, sumValue: 0, n: 0 });
      const c = byCrit.get(j.criterion);
      c.total += 1;
      if (j.pass) c.pass += 1;
      if (j.infraError) c.infra += 1;
      if (typeof j.value === "number" && Number.isFinite(j.value)) {
        c.sumValue += j.value;
        c.n += 1;
      }
    }
    out.push("| Criterion | Calls | Pass | Infra err | Mean value | Pass rate |");
    out.push("|---|---:|---:|---:|---:|---:|");
    for (const [crit, c] of [...byCrit.entries()].sort()) {
      const mean = c.n > 0 ? (c.sumValue / c.n).toFixed(3) : "—";
      out.push(
        `| ${escapeCell(crit)} | ${c.total} | ${c.pass} | ${c.infra} | ${mean} | ${pct(c.pass, c.total)} |`,
      );
    }
    out.push("");
    const interesting = judgeScores.filter((j) => !j.pass || j.infraError);
    if (interesting.length > 0) {
      out.push("### Non-pass / infra judge calls");
      out.push("");
      for (const j of interesting) {
        const tag = j.infraError ? "infra-error" : "fail";
        const value =
          typeof j.value === "number" ? j.value.toFixed(3) : "—";
        out.push(
          `- _[${tag}]_ **[${j.suite}] ${escapeCell(j.caseId)} / ${escapeCell(j.criterion)}** (value=${value})`,
        );
        out.push(`  - **reason:** ${escapeCell(truncate(j.reason, 400))}`);
        if (j.metadata?.prompt_excerpt) {
          out.push(
            `  - **prompt_excerpt:** ${escapeCell(truncate(String(j.metadata.prompt_excerpt), 200))}`,
          );
        }
        if (j.jsonlFile) {
          out.push(
            `  - _raw jsonl:_ ${renderPath(join(agg.dir, j.jsonlFile), { mustExist: true })}`,
          );
        }
        out.push(`  - _reports dir:_ ${renderPath(agg.dir, { mustExist: true })}`);
      }
      out.push("");
    }
  }

  // -----------------------------------------------------------------
  // Prompt-testing variants
  // -----------------------------------------------------------------
  out.push('<a id="prompt-testing-variants"></a>');
  out.push("## Prompt-testing variants");
  out.push("");
  const ptSamples = agg.samples.filter((s) => s.suite === "PROMPT-TESTING");
  if (ptSamples.length === 0) {
    out.push("_No `pt-cell-*` samples in this run._");
    out.push("");
  } else {
    // Parse cell key out of taskId: `pt-cell-<base>::<variant>::<model>`
    const cells = new Map();
    for (const s of ptSamples) {
      const tid = String(s.taskId);
      const stripped = tid.startsWith("pt-cell-") ? tid.slice("pt-cell-".length) : tid;
      const [base, variant = "?", model = "?"] = stripped.split("::");
      const key = `${base}::${variant}::${model}`;
      if (!cells.has(key)) {
        cells.set(key, {
          base,
          variant,
          model,
          total: 0,
          passed: 0,
          failed: 0,
          errored: 0,
          latencies: [],
        });
      }
      const c = cells.get(key);
      c.total += 1;
      if (s.errored) c.errored += 1;
      else if (s.pass) c.passed += 1;
      else c.failed += 1;
      if (typeof s.latencyMs === "number") c.latencies.push(s.latencyMs);
    }
    out.push("| Base case | Variant | Model | Trials | Pass | Pass rate | p50 |");
    out.push("|---|---|---|---:|---:|---:|---:|");
    const sortedCells = [...cells.values()].sort(
      (a, b) =>
        a.base.localeCompare(b.base) ||
        a.variant.localeCompare(b.variant) ||
        a.model.localeCompare(b.model),
    );
    for (const c of sortedCells) {
      const sorted = [...c.latencies].sort((a, b) => a - b);
      const p50 = percentile(sorted, 0.5);
      out.push(
        `| ${escapeCell(c.base)} | ${escapeCell(c.variant)} | ${escapeCell(c.model)} | ${c.total} | ${c.passed} | ${pct(c.passed, c.total)} | ${fmtDur(p50)} |`,
      );
    }
    out.push("");
    out.push(
      "_To compute variant-vs-baseline delta directly, see `computeAblationDelta` in `src/prompt-testing/index.ts`._",
    );
    out.push("");
  }

  // -----------------------------------------------------------------
  // How to read this
  // -----------------------------------------------------------------
  out.push('<a id="how-to-read-this"></a>');
  out.push("## How to read this");
  out.push("");
  out.push(
    "- **infra** failures = harness / driver / transport problem; usually a harness bug to fix before chasing model behavior.",
  );
  out.push(
    "- **sdk-perf** failures = budget overrun on a perf assertion; usually real PilotSwarm SDK signal worth profiling.",
  );
  out.push(
    "- **model-quality (deterministic grader)** = the model called the wrong tool / produced disallowed output / missed a required string.",
  );
  out.push(
    "- **model-quality (judge-graded)** = a rubric criterion failed; check the judge reason for whether the verdict is calibrated.",
  );
  out.push("");
  out.push(
    `Suites map by case-id prefix: \`live.functional.*\`/\`live.subagent.*\` → FUNCTIONAL, \`perf.*\` → PERFORMANCE, \`ablation.*\` → ABLATIONS, \`direct.*\`/\`indirect.*\`/\`output.*\`/\`tool-abuse.*\`/\`subjective.*\` → SAFETY, \`*::*::*\` (or \`pt-cell-*\` task) → PROMPT-TESTING. See ${renderPath(pkgPath("docs/SUITES.md"), { mustExist: true })} for the canonical list.`,
  );
  out.push("");

  // -----------------------------------------------------------------
  // What to do next
  // -----------------------------------------------------------------
  out.push('<a id="what-to-do-next"></a>');
  out.push("## What to do next");
  out.push("");
  out.push(
    "All commands below are copy-pasteable from the repo root (" +
      renderPath(REPO_ROOT, { mustExist: true }) +
      ").",
  );
  out.push("");
  // Build action list off observed failure categories
  const haveCats = new Set(fails.map((f) => classifyFailure(f)));
  const runLive = renderPath(pkgPath("bin/run-live.sh"), { mustExist: true });
  const agentMd = repoPath("packages/sdk/plugins/system/agents/default.agent.md");
  const promptTestingFile = renderPath(pkgPath("test/prompt-testing-live.test.ts"), {
    mustExist: true,
  });
  const ablationsFile = renderPath(pkgPath("test/ablations-live.test.ts"), {
    mustExist: true,
  });
  const judgeFile = renderPath(pkgPath("test/llm-judge-live.test.ts"), {
    mustExist: true,
  });
  const troubleshootingDoc = renderPath(pkgPath("docs/TROUBLESHOOTING.md"), {
    mustExist: true,
  });
  if (haveCats.has("infra")) {
    out.push(
      `- **Infra failures present.** Don't chase prompts yet. Inspect each failing case's raw artifact JSON (paths inline in the [Failures](#failures) section), then re-run the single suite — \`${pkgPath("bin/run-live.sh")} -- <test-file> -t '<test name>'\`. See ${troubleshootingDoc}.`,
    );
  }
  if (haveCats.has("sdk-perf")) {
    out.push(
      `- **SDK perf budget overrun.** Profile PilotSwarm directly with \`${pkgPath("bin/run-live.sh")} --pg-stat --heavy\` and inspect \`LatencyTracker\` / \`DbTracker\` console output. The jsonl doesn't carry the budget delta — re-run with vitest's reporter visible.`,
    );
  }
  if (haveCats.has("model-quality (deterministic grader)")) {
    out.push(
      `- **Deterministic grader fails (tool-call / response containment).** Most often: prompt iteration. Edit ${renderPath(agentMd, { mustExist: true })}, then \`${pkgPath("bin/run-live.sh")} --prompt-testing -- ${pkgPath("test/prompt-testing-live.test.ts")} -t '<test name>'\` to confirm. Use ablations (\`${pkgPath("bin/run-live.sh")} -- ${pkgPath("test/ablations-live.test.ts")}\`) to identify which section of the prompt is load-bearing.`,
    );
  }
  if (haveCats.has("model-quality (judge-graded)")) {
    out.push(
      `- **Judge-graded fails.** Re-run with the judge sub-suite: \`${pkgPath("bin/run-live.sh")} --judge -- ${pkgPath("test/llm-judge-live.test.ts")} -t '<test name>'\`. If the judge reasoning looks miscalibrated, swap \`LIVE_JUDGE_MODEL\` and re-run for cross-judge agreement.`,
    );
  }
  if (fails.length === 0) {
    out.push(
      `- **All green.** If this was a smoke / single-trial pass, bump \`PROMPT_TESTING_TRIALS=5\` (or run \`${pkgPath("bin/run-live.sh")} --all\`) before treating it as conclusive — single LIVE trials are stochastic.`,
    );
  }
  out.push(
    "- **Drill into a failing case:** every failure entry above lists the absolute jsonl path, the failure-detail JSON path (when present), the test file, and a copy-pasteable re-run command.",
  );
  out.push(
    `- **Compare across runs:** there is no automatic baseline diff in this report — compare two \`REPORT-*.md\` outputs side-by-side, or roll up the jsonl across dirs (recipe in ${renderPath(pkgPath("docs/PROMPT-ITERATION.md"), { mustExist: true })} § Reading the LIVE reports).`,
  );
  out.push("");
  out.push(
    `Raw artifacts live alongside this report at ${renderPath(agg.dir, { mustExist: true })}: one \`<runId>.jsonl\` per task plus \`<runId>/<caseId>.json\` for any failing case. Re-run \`${pkgPath("bin/report.mjs")}\` against the same dir to refresh after additional jsonl writes.`,
  );
  out.push("");

  // -----------------------------------------------------------------
  // Where to look next — doc index, every entry an absolute path so the
  // reader can `cat` / open without searching.
  // -----------------------------------------------------------------
  out.push('<a id="where-to-look-next"></a>');
  out.push("## Where to look next");
  out.push("");
  out.push("| Doc | What's in here |");
  out.push("|---|---|");
  const docs = [
    [
      "docs/PROMPT-ITERATION.md",
      "Day-to-day loop for editing the system prompt and getting fast LIVE signal back; report layout reference.",
    ],
    [
      "docs/TROUBLESHOOTING.md",
      "First-stop when you see infra failures or driver timeouts.",
    ],
    [
      "docs/SUITES.md",
      "Canonical inventory of every test suite, its gating env, and what it covers.",
    ],
    [
      "docs/JUDGE-CLIENTS.md",
      "OpenAI vs PilotSwarm judge client selection precedence and cost-rate contract.",
    ],
    [
      "docs/DRIVERS.md",
      "FakeDriver / LiveDriver / ChaosDriver contracts and when to use which.",
    ],
    [
      "docs/PERF.md",
      "LatencyTracker / CostTracker / DB-budget signal; how budgets gate.",
    ],
    [
      "docs/CI-INTEGRATION.md",
      "How to wire eval-harness into CI, gating, and report archival.",
    ],
    [
      "docs/CONTRIBUTING.md",
      "Adding new graders / suites / datasets without breaking the runner contract.",
    ],
    [
      "docs/INVARIANT-COVERAGE.md",
      "Which SDK invariants are exercised by which tests; coverage gaps.",
    ],
    [
      "docs/PROMPT-TESTING-SPEC-DRIFT.md",
      "Schema drift between the v1 path-suffixed goldens and the v2 internal schema.",
    ],
  ];
  for (const [rel, blurb] of docs) {
    const abs = pkgPath(rel);
    out.push(`| ${renderPath(abs, { mustExist: true })} | ${blurb} |`);
  }
  out.push("");
  out.push("");

  return out.join("\n");
}

// -------------------------------------------------------------------
// Main
// -------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let dir = opts.dir ? resolve(opts.dir) : findLatestReportsDir();
  if (!dir) {
    console.error(
      "no reports dir found — pass an explicit path or run vitest with EVAL_REPORTS_DIR set.",
    );
    process.exit(1);
  }
  let s;
  try {
    s = statSync(dir);
  } catch (err) {
    console.error(`cannot stat ${dir}: ${err.message}`);
    process.exit(1);
  }
  if (!s.isDirectory()) {
    console.error(`not a directory: ${dir}`);
    process.exit(1);
  }
  const agg = aggregate(dir);
  const md = renderMarkdown(agg);
  if (opts.stdout) {
    process.stdout.write(md);
    return;
  }
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const outPath = opts.out ? resolve(opts.out) : join(dir, `REPORT-${ts}.md`);
  writeFileSync(outPath, md, "utf8");
  console.log(outPath);
}

main();
