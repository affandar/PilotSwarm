import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConsoleReporter } from "../src/reporters/console.js";
import { JsonlReporter } from "../src/reporters/jsonl.js";
import type { Reporter } from "../src/reporters/types.js";
import type { EvalTask, CaseResult, RunResult } from "../src/types.js";

function makeTask(): EvalTask {
  return {
    schemaVersion: 1,
    id: "task-1",
    name: "Task One",
    description: "desc",
    version: "1.0.0",
    samples: [
      {
        id: "s1",
        description: "sample",
        input: { prompt: "hi" },
        expected: { toolSequence: "unordered" },
        timeoutMs: 120000,
      },
    ],
  };
}

function makeCaseResult(overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    caseId: "s1",
    pass: true,
    scores: [{ name: "tool-selection", value: 1, pass: true, reason: "ok" }],
    observed: {
      toolCalls: [],
      finalResponse: "done",
      sessionId: "sess",
      latencyMs: 5,
    },
    durationMs: 42,
    ...overrides,
  };
}

function makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
  const caseResult = makeCaseResult();
  return {
    schemaVersion: 1,
    runId: "run-1",
    taskId: "task-1",
    taskVersion: "1.0.0",
    startedAt: "2024-01-01T00:00:00.000Z",
    finishedAt: "2024-01-01T00:00:01.000Z",
    summary: { total: 1, passed: 1, failed: 0, errored: 0, passRate: 1 },
    cases: [caseResult],
    ...overrides,
  };
}

describe("ConsoleReporter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("implements the Reporter interface", () => {
    const reporter: Reporter = new ConsoleReporter();
    expect(typeof reporter.onRunStart).toBe("function");
    expect(typeof reporter.onCaseResult).toBe("function");
    expect(typeof reporter.onRunComplete).toBe("function");
  });

  it("onRunStart prints task name and runId", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const reporter = new ConsoleReporter();
    reporter.onRunStart(makeTask(), "run-1");
    const output = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Task One");
    expect(output).toContain("1.0.0");
    expect(output).toContain("run-1");
  });

  it("onCaseResult prints pass icon and caseId", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const reporter = new ConsoleReporter();
    reporter.onCaseResult(makeCaseResult({ pass: true }));
    const output = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("✅");
    expect(output).toContain("s1");
  });

  it("onCaseResult prints fail icon and failed score reasons", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const reporter = new ConsoleReporter();
    reporter.onCaseResult(
      makeCaseResult({
        pass: false,
        scores: [
          { name: "tool-selection", value: 0, pass: false, reason: "missing tool foo" },
        ],
      }),
    );
    const output = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("❌");
    expect(output).toContain("missing tool foo");
  });

  it("onCaseResult prints warning icon and error message for infraError", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const reporter = new ConsoleReporter();
    reporter.onCaseResult(
      makeCaseResult({ pass: false, scores: [], infraError: "driver crashed" }),
    );
    const output = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("⚠️");
    expect(output).toContain("driver crashed");
  });

  it("onRunComplete prints summary with counts and pass rate", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const reporter = new ConsoleReporter();
    reporter.onRunComplete(makeRunResult());
    const output = spy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toMatch(/1\s*\/\s*1/);
    expect(output).toContain("100");
  });
});

describe("JsonlReporter", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const p of created.splice(0)) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "eval-jsonl-"));
    created.push(dir);
    return dir;
  }

  it("implements the Reporter interface", () => {
    const reporter: Reporter = new JsonlReporter(tempDir());
    expect(typeof reporter.onRunStart).toBe("function");
    expect(typeof reporter.onCaseResult).toBe("function");
    expect(typeof reporter.onRunComplete).toBe("function");
  });

  it("writes a JSONL file containing run, sample, and summary lines", () => {
    const dir = tempDir();
    const reporter = new JsonlReporter(dir);
    const task = makeTask();
    const runResult = makeRunResult();
    reporter.onRunStart(task, runResult.runId);
    reporter.onCaseResult(runResult.cases[0]);
    reporter.onRunComplete(runResult);

    const filePath = join(dir, `${runResult.runId}.jsonl`);
    expect(existsSync(filePath)).toBe(true);
    const lines = readFileSync(filePath, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const parsed = lines.map((l) => JSON.parse(l));
    const types = parsed.map((p) => p.type);
    expect(types).toContain("run");
    expect(types).toContain("sample");
    expect(types).toContain("summary");
  });

  it("creates the output directory if it does not exist", () => {
    const base = tempDir();
    const nested = join(base, "nested", "deeper");
    const reporter = new JsonlReporter(nested);
    const task = makeTask();
    const runResult = makeRunResult();
    reporter.onRunStart(task, runResult.runId);
    reporter.onCaseResult(runResult.cases[0]);
    reporter.onRunComplete(runResult);
    expect(existsSync(nested)).toBe(true);
    expect(existsSync(join(nested, `${runResult.runId}.jsonl`))).toBe(true);
  });

  it("writes failure artifact JSON for each failed case", () => {
    const dir = tempDir();
    const reporter = new JsonlReporter(dir);
    const failed = makeCaseResult({
      caseId: "bad-case",
      pass: false,
      scores: [{ name: "tool-selection", value: 0, pass: false, reason: "nope" }],
    });
    const runResult = makeRunResult({
      summary: { total: 1, passed: 0, failed: 1, errored: 0, passRate: 0 },
      cases: [failed],
    });
    reporter.onRunStart(makeTask(), runResult.runId);
    reporter.onCaseResult(failed);
    reporter.onRunComplete(runResult);

    const artifactPath = join(dir, runResult.runId, "bad-case.json");
    expect(existsSync(artifactPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(artifactPath, "utf8"));
    expect(parsed.caseId).toBe("bad-case");
    expect(parsed.pass).toBe(false);
  });

  it("writes header line on onRunStart (before onRunComplete) — survives crash", () => {
    const dir = tempDir();
    const reporter = new JsonlReporter(dir);
    const task = makeTask();
    reporter.onRunStart(task, "run-streaming");
    const filePath = join(dir, "run-streaming.jsonl");
    expect(existsSync(filePath)).toBe(true);
    const lines = readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe("run");
    expect(parsed.runId).toBe("run-streaming");
  });

  it("writes case line on each onCaseResult (file grows incrementally)", () => {
    const dir = tempDir();
    const reporter = new JsonlReporter(dir);
    const task = makeTask();
    reporter.onRunStart(task, "run-grow");
    const filePath = join(dir, "run-grow.jsonl");
    const sizeAfterStart = readFileSync(filePath, "utf8").length;

    reporter.onCaseResult(makeCaseResult({ caseId: "c1" }));
    const sizeAfter1 = readFileSync(filePath, "utf8").length;
    expect(sizeAfter1).toBeGreaterThan(sizeAfterStart);

    reporter.onCaseResult(makeCaseResult({ caseId: "c2" }));
    const sizeAfter2 = readFileSync(filePath, "utf8").length;
    expect(sizeAfter2).toBeGreaterThan(sizeAfter1);

    const lines = readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.filter((p) => p.type === "sample")).toHaveLength(2);
  });

  it("writes failure artifact immediately on failed onCaseResult (before onRunComplete)", () => {
    const dir = tempDir();
    const reporter = new JsonlReporter(dir);
    reporter.onRunStart(makeTask(), "run-fail-immediate");
    const failed = makeCaseResult({
      caseId: "early-fail",
      pass: false,
      scores: [{ name: "x", value: 0, pass: false, reason: "boom" }],
    });
    reporter.onCaseResult(failed);
    const artifactPath = join(dir, "run-fail-immediate", "early-fail.json");
    expect(existsSync(artifactPath)).toBe(true);
  });

  it("sanitizes unsafe caseId in artifact path (no traversal)", () => {
    const dir = tempDir();
    const reporter = new JsonlReporter(dir);
    reporter.onRunStart(makeTask(), "run-traversal");
    const failed = makeCaseResult({
      caseId: "../../escape/evil",
      pass: false,
      scores: [{ name: "x", value: 0, pass: false, reason: "boom" }],
    });
    reporter.onCaseResult(failed);
    // Must NOT have written outside the run artifact dir.
    const escaped = join(dir, "..", "escape", "evil.json");
    expect(existsSync(escaped)).toBe(false);
    // The artifact must be present *inside* the run artifact dir under a sanitized name.
    const artifactDir = join(dir, "run-traversal");
    expect(existsSync(artifactDir)).toBe(true);
    const entries = require("node:fs").readdirSync(artifactDir);
    expect(entries.length).toBe(1);
    expect(entries[0]).not.toContain("/");
    expect(entries[0]).not.toContain("..");
  });

  it("sanitizes unsafe runId in jsonl filename (no traversal)", () => {
    const dir = tempDir();
    const reporter = new JsonlReporter(dir);
    // Pass a runId that would escape if used raw.
    reporter.onRunStart(makeTask(), "../../evil-run");
    // The reporter should not have created any file outside `dir`.
    const escapedDirParent = join(dir, "..");
    const before = require("node:fs").readdirSync(escapedDirParent);
    expect(before.some((e: string) => e === "evil-run.jsonl")).toBe(false);
  });
});
