import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { readFileSync, existsSync, rmSync, mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MatrixRunner } from "../src/matrix.js";
import { ConsoleAggregateReporter } from "../src/reporters/console-aggregate.js";
import { MarkdownReporter } from "../src/reporters/markdown.js";
import { PRCommentReporter } from "../src/reporters/pr-comment.js";
import type { Driver } from "../src/drivers/types.js";
import type {
  EvalSample,
  EvalTask,
  MultiTrialResult,
  MatrixResult,
  MatrixCell,
  SampleTrialResult,
} from "../src/types.js";

type WilsonCI = { lower: number; upper: number; point: number; z: number };

function makeCI(point: number, lower = Math.max(0, point - 0.1), upper = Math.min(1, point + 0.1)): WilsonCI {
  return { lower, upper, point, z: 1.96 };
}

function makeSample(
  sampleId: string,
  passCount: number,
  trials: number,
  passAtK: Record<number, number> = {},
  errorCount = 0,
): SampleTrialResult {
  const nonErrorTrials = trials - errorCount;
  const passRate = nonErrorTrials === 0 ? 0 : passCount / nonErrorTrials;
  return {
    sampleId,
    trials,
    passCount,
    failCount: nonErrorTrials - passCount,
    errorCount,
    passRate,
    passAtK,
    scores: {},
    wilsonCI: makeCI(passRate),
  };
}

function makeMultiTrial(
  taskId: string,
  trials: number,
  samples: SampleTrialResult[],
  opts: { gitSha?: string; model?: string; taskVersion?: string } = {},
): MultiTrialResult {
  const meanPassRate = samples.length === 0 ? 0 : samples.reduce((a, s) => a + s.passRate, 0) / samples.length;
  return {
    schemaVersion: 1,
    runId: "run-1",
    taskId,
    taskVersion: opts.taskVersion ?? "1.0.0",
    gitSha: opts.gitSha,
    model: opts.model,
    trials,
    startedAt: "2025-01-01T00:00:00.000Z",
    finishedAt: "2025-01-01T00:00:05.000Z",
    summary: {
      total: samples.length,
      trials,
      meanPassRate,
      stddevPassRate: 0.05,
      passRateCI: makeCI(meanPassRate),
    },
    samples,
    rawRuns: [],
  };
}

function makeCell(model: string, configId: string, configLabel: string, passRate: number, trials = 100): MatrixCell {
  const passCount = Math.round(passRate * trials);
  const sample = makeSample("sample-1", passCount, trials, { 1: passRate });
  return {
    model,
    configId,
    configLabel,
    result: makeMultiTrial("task-1", trials, [sample], { model }),
  };
}

function makeMatrixTask(): EvalTask {
  return {
    schemaVersion: 1,
    id: "matrix-infra-task",
    name: "Matrix Infra Task",
    description: "matrix reporter infra visibility",
    version: "1.0.0",
    samples: [
      {
        id: "s1",
        description: "sample",
        input: { prompt: "call add" },
        expected: { toolCalls: [{ name: "add", args: { a: 1, b: 2 }, match: "subset" }], toolSequence: "unordered" },
        timeoutMs: 5000,
      },
    ] as EvalSample[],
  };
}

async function makeMatrixRunnerInfraResult(): Promise<MatrixResult> {
  let calls = 0;
  class SometimesInfraDriver implements Driver {
    async run() {
      calls += 1;
      if (calls === 2) throw new Error("judge 503");
      return {
        toolCalls: [{ name: "add", args: { a: 1, b: 2 }, order: 0 }],
        finalResponse: "ok",
        sessionId: `session-${calls}`,
        latencyMs: 1,
      };
    }
  }

  const runner = new MatrixRunner({
    driverFactory: () => new SometimesInfraDriver(),
    models: ["model-a"],
    configs: [
      { id: "infra", label: "infra", overrides: {} },
      { id: "clean", label: "clean", overrides: {} },
    ],
    trials: 2,
  });
  return runner.runTask(makeMatrixTask());
}

function makeMatrix(cells: MatrixCell[]): MatrixResult {
  const byRate = [...cells].sort((a, b) => a.result.summary.meanPassRate - b.result.summary.meanPassRate);
  const worst = byRate[0]!;
  const best = byRate[byRate.length - 1]!;
  const models = Array.from(new Set(cells.map((c) => c.model)));
  const configIds = Array.from(new Set(cells.map((c) => c.configId)));
  const configs = configIds.map((id) => {
    const c = cells.find((x) => x.configId === id)!;
    return { id, label: c.configLabel, overrides: {} };
  });
  return {
    schemaVersion: 1,
    runId: "run-matrix-1",
    taskId: "task-1",
    taskVersion: "1.0.0",
    gitSha: "abc123",
    startedAt: "2025-01-01T00:00:00.000Z",
    finishedAt: "2025-01-01T00:00:10.000Z",
    models,
    configs,
    cells,
    summary: {
      totalCells: cells.length,
      bestPassRate: { model: best.model, configId: best.configId, passRate: best.result.summary.meanPassRate },
      worstPassRate: { model: worst.model, configId: worst.configId, passRate: worst.result.summary.meanPassRate },
    },
  };
}

describe("ConsoleAggregateReporter", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function output(): string {
    return logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
  }

  it("renders multi-trial summary with thresholded icons (✅/⚠️/❌) and pass@k metrics", async () => {
    const reporter = new ConsoleAggregateReporter();
    const result = makeMultiTrial("task-1", 10, [
      makeSample("sample-1", 10, 10, { 1: 1.0, 5: 1.0 }),
      makeSample("sample-2", 7, 10, { 1: 0.7, 5: 0.99 }),
      makeSample("sample-3", 0, 10, { 1: 0.0, 5: 0.0 }),
    ]);
    await reporter.onMultiTrialComplete(result);
    const out = output();
    expect(out).toContain("Multi-Trial: task-1");
    expect(out).toContain("10 trials");
    expect(out).toContain("✅");
    expect(out).toContain("⚠️");
    expect(out).toContain("❌");
    expect(out).toContain("pass@1=1.00");
    expect(out).toContain("pass@5=0.99");
    expect(out).toContain("Duration:");

    const lines = out.split("\n");
    expect(lines.find((l) => l.includes("sample-1"))).toContain("✅");
    expect(lines.find((l) => l.includes("sample-2"))).toContain("⚠️");
    expect(lines.find((l) => l.includes("sample-3"))).toContain("❌");
  });

  it("renders infra-error counts with the quality denominator (multi-trial)", async () => {
    const reporter = new ConsoleAggregateReporter();
    await reporter.onMultiTrialComplete(makeMultiTrial("task-infra", 10, [makeSample("infra", 5, 10, {}, 5)]));
    const out = output();
    expect(out).toContain("100.0% (5/5 quality, 5 infra errors)");
    expect(out).not.toContain("(5/10)");
  });

  it("renders matrix table with best/worst, dimensions, and per-cell pass rates (single + multi-cell)", async () => {
    const reporter = new ConsoleAggregateReporter();
    const matrix = makeMatrix([
      makeCell("gpt-4o", "default", "default", 0.85),
      makeCell("gpt-4o", "strict-prompt", "strict-prompt", 0.92),
      makeCell("claude-sonnet", "default", "default", 0.78),
      makeCell("claude-sonnet", "strict-prompt", "strict-prompt", 0.88),
    ]);
    await reporter.onMatrixComplete(matrix);
    const out = output();
    expect(out).toContain("Matrix: task-1");
    expect(out).toContain("2×2");
    expect(out).toContain("gpt-4o");
    expect(out).toContain("claude-sonnet");
    expect(out).toContain("85.0%");
    expect(out).toContain("92.0%");
    expect(out).toContain("Best:");
    expect(out).toContain("Worst:");

    logSpy.mockClear();
    await reporter.onMatrixComplete(makeMatrix([makeCell("gpt-4o", "default", "default", 0.7)]));
    const single = output();
    expect(single).toContain("1×1");
    expect(single).toContain("70.0%");
  });

  it("renders matrix cell infra-error counts from real runner output", async () => {
    const reporter = new ConsoleAggregateReporter();
    await reporter.onMatrixComplete(await makeMatrixRunnerInfraResult());
    const out = output();
    expect(out).toContain("100.0%");
    expect(out).toContain("1 infra errors");
    expect(out).not.toContain("0 infra errors");
  });
});

describe("MarkdownReporter", () => {
  let tmp: string;

  beforeEach(() => {
    const root = join(process.cwd(), ".vitest-tmp");
    mkdirSync(root, { recursive: true });
    tmp = mkdtempSync(join(root, "md-reporter-"));
  });

  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("writes multi-trial markdown with task header, trials, table, and per-sample rows", async () => {
    const outPath = join(tmp, "multi.md");
    const reporter = new MarkdownReporter(outPath);
    await reporter.onMultiTrialComplete(
      makeMultiTrial("task-1", 10, [
        makeSample("sample-1", 10, 10, { 1: 1.0, 5: 1.0, 10: 1.0 }),
        makeSample("sample-2", 7, 10, { 1: 0.7, 5: 0.99 }),
      ]),
    );
    const md = readFileSync(outPath, "utf8");
    expect(md).toContain("## Multi-Trial: task-1");
    expect(md).toContain("**Trials:** 10");
    expect(md).toContain("Mean Pass Rate");
    expect(md).toContain("| Sample |");
    expect(md).toContain("sample-1");
    expect(md).toContain("sample-2");
  });

  it("renders infra-error suffix only when present (markdown + PR comment)", async () => {
    const zeroPath = join(tmp, "zero.md");
    await new MarkdownReporter(zeroPath).onMultiTrialComplete(
      makeMultiTrial("task-zero", 5, [makeSample("sample-1", 5, 5)]),
    );
    const zero = readFileSync(zeroPath, "utf8");
    expect(zero).toContain("100.0% (5/5)");
    expect(zero).not.toContain("infra errors");

    const mdPath = join(tmp, "infra.md");
    const prPath = join(tmp, "infra-pr.md");
    const result = makeMultiTrial("task-infra", 10, [makeSample("sample-1", 5, 10, {}, 5)]);
    await new MarkdownReporter(mdPath).onMultiTrialComplete(result);
    await new PRCommentReporter(prPath).onMultiTrialComplete(result);
    for (const p of [mdPath, prPath]) {
      const txt = readFileSync(p, "utf8");
      expect(txt).toContain("100.0% (5/5 quality, 5 infra errors)");
      expect(txt).not.toContain("(5/10)");
    }
  });

  it("writes matrix markdown with header, CI, best/worst, infra counts in markdown + PR comment", async () => {
    const matrix = makeMatrix([
      makeCell("gpt-4o", "default", "default", 0.85),
      makeCell("gpt-4o", "strict-prompt", "strict-prompt", 0.92),
      makeCell("claude-sonnet", "default", "default", 0.78),
      makeCell("claude-sonnet", "strict-prompt", "strict-prompt", 0.88),
    ]);
    const mdPath = join(tmp, "matrix.md");
    await new MarkdownReporter(mdPath).onMatrixComplete(matrix);
    const md = readFileSync(mdPath, "utf8");
    expect(md).toContain("## Eval Matrix: task-1");
    expect(md).toContain("**Task:** task-1 v1.0.0");
    expect(md).toContain("**Git SHA:** abc123");
    expect(md).toContain("| Model | default | strict-prompt |");
    expect(md).toContain("85.0%");
    expect(md).toContain("CI:");
    expect(md).toContain("**Best:**");
    expect(md).toContain("**Worst:**");

    const infraMatrix = await makeMatrixRunnerInfraResult();
    const infraMdPath = join(tmp, "infra-matrix.md");
    const infraPrPath = join(tmp, "infra-matrix-pr.md");
    await new MarkdownReporter(infraMdPath).onMatrixComplete(infraMatrix);
    await new PRCommentReporter(infraPrPath).onMatrixComplete(infraMatrix);
    for (const p of [infraMdPath, infraPrPath]) {
      const txt = readFileSync(p, "utf8");
      expect(txt).toContain("1 infra errors");
      expect(txt).not.toContain("0 infra errors");
    }
  });

  it("includes per-sample collapsible details in matrix output", async () => {
    const outPath = join(tmp, "details.md");
    await new MarkdownReporter(outPath).onMatrixComplete(
      makeMatrix([
        makeCell("gpt-4o", "default", "default", 0.85),
        makeCell("gpt-4o", "strict-prompt", "strict-prompt", 0.92),
      ]),
    );
    const md = readFileSync(outPath, "utf8");
    expect(md).toContain("<details>");
    expect(md).toContain("<summary>");
    expect(md).toContain("</details>");
    expect(md).toContain("gpt-4o × default");
    expect(md).toContain("| Sample | Pass Rate |");
  });

  it("uses dash for passAtK where k > trials and handles empty samples without throwing", async () => {
    const dashPath = join(tmp, "dash.md");
    await new MarkdownReporter(dashPath).onMultiTrialComplete(
      makeMultiTrial("task-small", 3, [makeSample("s1", 2, 3, { 1: 0.67, 5: 0 })]),
    );
    expect(readFileSync(dashPath, "utf8")).toContain("—");

    const emptyPath = join(tmp, "empty.md");
    const cell: MatrixCell = {
      model: "gpt-4o",
      configId: "default",
      configLabel: "default",
      result: makeMultiTrial("task-1", 0, [], { model: "gpt-4o" }),
    };
    await new MarkdownReporter(emptyPath).onMatrixComplete(makeMatrix([cell]));
    const empty = readFileSync(emptyPath, "utf8");
    expect(empty).toContain("## Eval Matrix: task-1");
    expect(empty).toContain("gpt-4o");
  });

  it("creates output directory if needed", async () => {
    const outPath = join(tmp, "nested", "deep", "output.md");
    await new MarkdownReporter(outPath).onMultiTrialComplete(
      makeMultiTrial("task-1", 1, [makeSample("s1", 1, 1, { 1: 1.0 })]),
    );
    expect(existsSync(outPath)).toBe(true);
  });

  it("escapes Markdown table cells in user-controlled strings (samples, headers, matrix labels)", async () => {
    const outPath = join(tmp, "escaped.md");
    await new MarkdownReporter(outPath).onMultiTrialComplete(
      makeMultiTrial("task|`x`", 1, [makeSample("sample|`reason`", 1, 1, { 1: 1.0 })]),
    );
    const md = readFileSync(outPath, "utf8");
    expect(md).toContain("task\\|\\`x\\`");
    expect(md).toContain("sample\\|\\`reason\\`");
    expect(md).not.toContain("| sample|`reason` |");

    const headersPath = join(tmp, "escaped-headers.md");
    const cell = makeCell("m|`<model>`", "cfg", "c|`<label>`", 1);
    const matrix = makeMatrix([cell]);
    matrix.taskVersion = "v|`<tag>`";
    matrix.gitSha = "sha|`<git>`";
    await new MarkdownReporter(headersPath).onMatrixComplete(matrix);
    const headers = readFileSync(headersPath, "utf8");
    expect(headers).toContain("v\\|\\`&lt;tag&gt;\\`");
    expect(headers).toContain("sha\\|\\`&lt;git&gt;\\`");
    expect(headers).toContain("m\\|\\`&lt;model&gt;\\`");
    expect(headers).toContain("c\\|\\`&lt;label&gt;\\`");
  });

  it("neutralizes Markdown links, images, emphasis, strikethrough, and mentions", async () => {
    const outPath = join(tmp, "markdown-injection.md");
    const prPath = join(tmp, "markdown-injection-pr.md");
    const reporter = new MarkdownReporter(outPath);
    const prReporter = new PRCommentReporter(prPath);
    const result = makeMultiTrial(
      "**bold injection**",
      1,
      [makeSample("[click](https://evil.com)", 1, 1, { 1: 1.0 })],
      { model: "_underscore_emphasis_" },
    );

    await reporter.onMultiTrialComplete(result);
    await prReporter.onMultiTrialComplete(result);
    prReporter.writeGateResult({ pass: false, reasons: ["![attack](url)", "@everyone", "~strike~"] });

    const md = readFileSync(outPath, "utf8");
    const prMd = readFileSync(prPath, "utf8");
    expect(md).toContain("\\*\\*bold injection\\*\\*");
    expect(md).toContain("\\[click\\]\\(https://evil.com\\)");
    expect(prMd).toContain("\\_underscore\\_emphasis\\_");
    expect(prMd).toContain("\\!\\[attack\\]\\(url\\)");
    expect(prMd).toContain("&#64;everyone");
    expect(prMd).toContain("\\~strike\\~");
    expect(md).not.toMatch(/(?<!\\)\[[^\]]+\]\([^)]*\)/);
    expect(prMd).not.toMatch(/(?<!\\)!\[[^\]]*\]\([^)]*\)/);
    expect(prMd).not.toContain("@everyone");
  });
});
