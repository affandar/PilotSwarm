import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, existsSync, rmSync, mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConsoleReporter } from "../src/reporters/console.js";
import { JsonlReporter } from "../src/reporters/jsonl.js";
import { PRCommentReporter } from "../src/reporters/pr-comment.js";
import type { Reporter } from "../src/reporters/types.js";
import type { EvalTask, CaseResult, RunResult, CIGateResult, RegressionResult } from "../src/types.js";

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
    observed: { toolCalls: [], finalResponse: "done", sessionId: "sess", latencyMs: 5 },
    durationMs: 42,
    ...overrides,
  };
}

function makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    schemaVersion: 1,
    runId: "run-1",
    taskId: "task-1",
    taskVersion: "1.0.0",
    startedAt: "2024-01-01T00:00:00.000Z",
    finishedAt: "2024-01-01T00:00:01.000Z",
    summary: { total: 1, passed: 1, failed: 0, errored: 0, passRate: 1 },
    cases: [makeCaseResult()],
    ...overrides,
  };
}

describe("ConsoleReporter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function output(spy: ReturnType<typeof vi.spyOn>): string {
    return spy.mock.calls.map((c) => c.join(" ")).join("\n");
  }

  it("implements the Reporter interface and prints task header on onRunStart", () => {
    const reporter: Reporter = new ConsoleReporter();
    expect(typeof reporter.onRunStart).toBe("function");
    expect(typeof reporter.onCaseResult).toBe("function");
    expect(typeof reporter.onRunComplete).toBe("function");

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    reporter.onRunStart(makeTask(), "run-1");
    const out = output(spy);
    expect(out).toContain("Task One");
    expect(out).toContain("1.0.0");
    expect(out).toContain("run-1");
  });

  it("onCaseResult prints ✅/❌/⚠️ icons with reason or error message", () => {
    const reporter = new ConsoleReporter();

    const sPass = vi.spyOn(console, "log").mockImplementation(() => {});
    reporter.onCaseResult(makeCaseResult({ pass: true }));
    expect(output(sPass)).toContain("✅");
    expect(output(sPass)).toContain("s1");
    sPass.mockRestore();

    const sFail = vi.spyOn(console, "log").mockImplementation(() => {});
    reporter.onCaseResult(
      makeCaseResult({
        pass: false,
        scores: [{ name: "tool-selection", value: 0, pass: false, reason: "missing tool foo" }],
      }),
    );
    const failOut = output(sFail);
    expect(failOut).toContain("❌");
    expect(failOut).toContain("missing tool foo");
    sFail.mockRestore();

    const sErr = vi.spyOn(console, "log").mockImplementation(() => {});
    reporter.onCaseResult(makeCaseResult({ pass: false, scores: [], infraError: "driver crashed" }));
    const errOut = output(sErr);
    expect(errOut).toContain("⚠️");
    expect(errOut).toContain("driver crashed");
  });

  it("onRunComplete prints summary using quality denominator when infra errors are present", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const reporter = new ConsoleReporter();
    reporter.onRunComplete(
      makeRunResult({
        summary: { total: 10, passed: 5, failed: 0, errored: 5, passRate: 1 },
        cases: [],
      }),
    );
    const out = output(spy);
    expect(out).toContain("5/5 quality passed (100.0%)");
    expect(out).toContain("5 infra errors");
    expect(out).not.toContain("5/10 passed (100.0%)");
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

  it("writes JSONL with run/sample/summary lines, creates output dir, and emits failure artifact JSON for failed cases", () => {
    const dir = tempDir();
    const reporter: Reporter = new JsonlReporter(join(dir, "nested", "deeper"));
    const task = makeTask();
    const failed = makeCaseResult({
      caseId: "bad-case",
      pass: false,
      scores: [{ name: "tool-selection", value: 0, pass: false, reason: "nope" }],
    });
    const runResult = makeRunResult({
      summary: { total: 1, passed: 0, failed: 1, errored: 0, passRate: 0 },
      cases: [failed],
    });
    reporter.onRunStart(task, runResult.runId);
    reporter.onCaseResult(failed);
    reporter.onRunComplete(runResult);

    const filePath = join(dir, "nested", "deeper", `${runResult.runId}.jsonl`);
    expect(existsSync(filePath)).toBe(true);
    const lines = readFileSync(filePath, "utf8").trim().split("\n");
    const types = lines.map((l) => JSON.parse(l).type);
    expect(types).toContain("run");
    expect(types).toContain("sample");
    expect(types).toContain("summary");

    const artifactPath = join(dir, "nested", "deeper", runResult.runId, "bad-case.json");
    expect(existsSync(artifactPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(artifactPath, "utf8"));
    expect(parsed.caseId).toBe("bad-case");
    expect(parsed.pass).toBe(false);
  });

  it("streams: writes header on onRunStart, appends a sample line per onCaseResult, writes failure artifact immediately", () => {
    const dir = tempDir();
    const reporter = new JsonlReporter(dir);
    reporter.onRunStart(makeTask(), "run-stream");
    const filePath = join(dir, "run-stream.jsonl");
    const sizeAfterStart = readFileSync(filePath, "utf8").length;
    const headerLine = JSON.parse(readFileSync(filePath, "utf8").trim().split("\n")[0]);
    expect(headerLine.type).toBe("run");
    expect(headerLine.runId).toBe("run-stream");

    reporter.onCaseResult(makeCaseResult({ caseId: "c1" }));
    const sizeAfter1 = readFileSync(filePath, "utf8").length;
    expect(sizeAfter1).toBeGreaterThan(sizeAfterStart);

    const failed = makeCaseResult({
      caseId: "early-fail",
      pass: false,
      scores: [{ name: "x", value: 0, pass: false, reason: "boom" }],
    });
    reporter.onCaseResult(failed);
    expect(existsSync(join(dir, "run-stream", "early-fail.json"))).toBe(true);

    const samples = readFileSync(filePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((p) => p.type === "sample");
    expect(samples).toHaveLength(2);
  });

  it("sanitizes unsafe runId and caseId so writes cannot escape the run artifact dir", () => {
    const dir = tempDir();
    const reporter = new JsonlReporter(dir);
    reporter.onRunStart(makeTask(), "../../evil-run");
    expect(readdirSync(join(dir, "..")).some((e) => e === "evil-run.jsonl")).toBe(false);

    reporter.onRunStart(makeTask(), "run-traversal");
    const failed = makeCaseResult({
      caseId: "../../escape/evil",
      pass: false,
      scores: [{ name: "x", value: 0, pass: false, reason: "boom" }],
    });
    reporter.onCaseResult(failed);
    expect(existsSync(join(dir, "..", "escape", "evil.json"))).toBe(false);
    const artifactDir = join(dir, "run-traversal");
    expect(existsSync(artifactDir)).toBe(true);
    const entries = readdirSync(artifactDir);
    expect(entries.length).toBe(1);
    expect(entries[0]).not.toContain("/");
    expect(entries[0]).not.toContain("..");
  });
});

describe("PRCommentReporter", () => {
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
    const dir = mkdtempSync(join(tmpdir(), "eval-pr-"));
    created.push(dir);
    return dir;
  }

  function makeGate(overrides: Partial<CIGateResult> = {}): CIGateResult {
    return { pass: true, reasons: ["pass rate met"], passRate: 0.95, regressionCount: 0, ...overrides };
  }

  it("writeGateResult overwrites stale prior file on first call, then appends on subsequent calls", () => {
    const dir = tempDir();
    const path = join(dir, "pr.md");
    writeFileSync(path, "## STALE PRIOR RUN\nshould-not-survive\n", "utf8");

    const reporter = new PRCommentReporter(path);
    reporter.writeGateResult(makeGate({ reasons: ["FIRST GATE"] }));
    let out = readFileSync(path, "utf8");
    expect(out).not.toContain("STALE PRIOR RUN");
    expect(out).not.toContain("should-not-survive");
    expect(out.startsWith("## CI Gate:")).toBe(true);
    expect(out).toContain("FIRST GATE");

    reporter.writeGateResult(makeGate({ reasons: ["SECOND GATE"] }));
    out = readFileSync(path, "utf8");
    expect(out).toContain("FIRST GATE");
    expect(out).toContain("SECOND GATE");
    expect(out.indexOf("FIRST GATE")).toBeLessThan(out.indexOf("SECOND GATE"));
  });

  it("writeGateResult shows adjustedPValue (with bh header) when correction is applied; raw pValue when correction='none'", () => {
    const dir = tempDir();
    const adjPath = join(dir, "adj.md");
    const adjReporter = new PRCommentReporter(adjPath);
    const adj: RegressionResult = {
      sampleId: "s1",
      baselinePassRate: 0.9,
      currentPassRate: 0.6,
      pValue: 0.0098,
      adjustedPValue: 0.2,
      correction: "bh",
      significant: false,
      direction: "regressed",
    };
    adjReporter.writeGateResult(makeGate({ pass: false, reasons: ["regression"] }), [adj]);
    const adjOut = readFileSync(adjPath, "utf8");
    const adjRow = adjOut.split("\n").find((l) => l.includes("| s1 |"))!;
    expect(adjRow).toContain("0.2000");
    expect(adjRow).not.toContain("0.0098");
    expect(adjOut).toMatch(/p-value \(adjusted, bh\)/);

    const rawPath = join(dir, "raw.md");
    const rawReporter = new PRCommentReporter(rawPath);
    const raw: RegressionResult = {
      sampleId: "s2",
      baselinePassRate: 0.9,
      currentPassRate: 0.6,
      pValue: 0.0098,
      adjustedPValue: 0.0098,
      correction: "none",
      significant: true,
      direction: "regressed",
    };
    rawReporter.writeGateResult(makeGate({ pass: false, reasons: ["regression"] }), [raw]);
    const rawOut = readFileSync(rawPath, "utf8");
    const rawRow = rawOut.split("\n").find((l) => l.includes("| s2 |"))!;
    expect(rawRow).toContain("0.0098");
    expect(rawOut).not.toMatch(/p-value \(adjusted/);
  });

  it("writeGateResult falls back to raw pValue when adjustedPValue is undefined", () => {
    const dir = tempDir();
    const path = join(dir, "pr.md");
    const reporter = new PRCommentReporter(path);
    const reg: RegressionResult = {
      sampleId: "s3",
      baselinePassRate: 0.9,
      currentPassRate: 0.6,
      pValue: 0.0123,
      significant: true,
      direction: "regressed",
    };
    reporter.writeGateResult(makeGate({ pass: false, reasons: ["regression"] }), [reg]);
    const out = readFileSync(path, "utf8");
    const sampleRow = out.split("\n").find((l) => l.includes("| s3 |"));
    expect(sampleRow).toBeDefined();
    expect(sampleRow!).toContain("0.0123");
  });
});
