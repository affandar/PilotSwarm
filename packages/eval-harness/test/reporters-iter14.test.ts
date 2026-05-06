import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonlReporter } from "../src/reporters/jsonl.js";
import { escapeMarkdownCell } from "../src/reporters/util.js";
import type { EvalTask, RunResult, CaseResult } from "../src/types.js";

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

describe("JsonlReporter — F9 full RunSummary shape", () => {
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
    const dir = mkdtempSync(join(tmpdir(), "eval-jsonl-iter14-"));
    created.push(dir);
    return dir;
  }

  it("summary line spreads every RunSummary field plus run-level taskId/taskVersion/gitSha/model when present, omits gitSha/model when absent", () => {
    const dir = tempDir();
    const reporter = new JsonlReporter(dir);
    const task = makeTask();
    const runResult: RunResult = {
      schemaVersion: 1,
      runId: "run-summary-shape",
      taskId: "task-1",
      taskVersion: "1.2.3",
      gitSha: "abc1234",
      model: "gpt-test",
      startedAt: "2024-01-01T00:00:00.000Z",
      finishedAt: "2024-01-01T00:00:01.000Z",
      summary: {
        total: 3,
        passed: 1,
        failed: 1,
        errored: 1,
        passRate: 0.5,
        noQualitySignal: false,
        infraErrorRate: 0.3333,
      },
      cases: [
        makeCaseResult({ caseId: "s1", pass: true }),
        makeCaseResult({ caseId: "s2", pass: false, scores: [{ name: "x", value: 0, pass: false, reason: "no" }] }),
        makeCaseResult({ caseId: "s3", pass: false, scores: [], infraError: "boom" }),
      ],
    };

    reporter.onRunStart(task, runResult.runId);
    for (const c of runResult.cases) reporter.onCaseResult(c);
    reporter.onRunComplete(runResult);

    const summary = readFileSync(join(dir, `${runResult.runId}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((p) => p.type === "summary");
    expect(summary).toBeDefined();
    for (const k of ["total", "passed", "failed", "errored", "passRate", "noQualitySignal", "infraErrorRate"]) {
      expect(summary).toHaveProperty(k);
    }
    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.errored).toBe(1);
    expect(summary.passRate).toBe(0.5);
    expect(summary.infraErrorRate).toBeCloseTo(0.3333);
    expect(summary.taskId).toBe("task-1");
    expect(summary.taskVersion).toBe("1.2.3");
    expect(summary.gitSha).toBe("abc1234");
    expect(summary.model).toBe("gpt-test");

    // Without gitSha/model on RunResult, those keys must not be emitted.
    const dir2 = tempDir();
    const r2 = new JsonlReporter(dir2);
    const minimal: RunResult = {
      schemaVersion: 1,
      runId: "run-no-optional",
      taskId: "task-1",
      taskVersion: "1.0.0",
      startedAt: "2024-01-01T00:00:00.000Z",
      finishedAt: "2024-01-01T00:00:01.000Z",
      summary: { total: 1, passed: 1, failed: 0, errored: 0, passRate: 1 },
      cases: [makeCaseResult()],
    };
    r2.onRunStart(task, minimal.runId);
    r2.onCaseResult(minimal.cases[0]);
    r2.onRunComplete(minimal);
    const minimalSummary = readFileSync(join(dir2, `${minimal.runId}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((p) => p.type === "summary");
    expect("gitSha" in minimalSummary).toBe(false);
    expect("model" in minimalSummary).toBe(false);
  });
});

describe("escapeMarkdownCell — F23 control-char filter & F24 line-ending normalization", () => {
  it("strips C0/C1, zero-width, and bidi format characters; treats CR / LF / CRLF identically", () => {
    const dangerous =
      "before\u202Eevil\u200Bzwsp\u0007bell\u007Fdel\u009Fc1\u200Czwj\u2066rtl\uFEFFbom-after";
    const out = escapeMarkdownCell(dangerous);
    expect(out).toContain("before");
    expect(out).toContain("bom-after");
    for (const ch of ["\u0000", "\u001F", "\u007F", "\u200B", "\u202E", "\u2066", "\uFEFF"]) {
      expect(out.includes(ch)).toBe(false);
    }
    expect(escapeMarkdownCell("plain text 123")).toBe("plain text 123");
    expect(escapeMarkdownCell("a\rb")).toBe("a b");
    expect(escapeMarkdownCell("a\r\nb")).toBe("a b");
    expect(escapeMarkdownCell("a\nb")).toBe("a b");
  });
});
