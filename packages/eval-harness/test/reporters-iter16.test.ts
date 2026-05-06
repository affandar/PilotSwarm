import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PRCommentReporter } from "../src/reporters/pr-comment.js";
import { MarkdownReporter } from "../src/reporters/markdown.js";
import { formatPValue } from "../src/reporters/util.js";
import type {
  CIGateResult,
  MultiTrialResult,
  RegressionResult,
  SampleTrialResult,
} from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRATCH_ROOT = join(__dirname, ".scratch-iter16");

function makeScratchDir(prefix: string): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  return mkdtempSync(join(SCRATCH_ROOT, prefix));
}

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

function makeSample(): SampleTrialResult {
  return {
    sampleId: "s",
    trials: 10,
    passCount: 0,
    failCount: 10,
    errorCount: 0,
    passRate: 0,
    passAtK: { 1: 0 },
    scores: {},
    wilsonCI: { lower: 0, upper: 0.3, point: 0, z: 1.96 },
  };
}

function makeMultiTrial(opts: Partial<MultiTrialResult> = {}): MultiTrialResult {
  const sample = makeSample();
  return {
    schemaVersion: 1,
    runId: "run-iter16",
    taskId: "task-iter16",
    taskVersion: "1.0.0",
    gitSha: "abc123def",
    model: "test-model",
    trials: 10,
    startedAt: "2025-01-01T00:00:00.000Z",
    finishedAt: "2025-01-01T00:00:05.000Z",
    summary: {
      total: 1,
      trials: 10,
      meanPassRate: 0,
      stddevPassRate: 0,
      passRateCI: { lower: 0, upper: 0.3, point: 0, z: 1.96 },
    },
    samples: [sample],
    rawRuns: [],
    ...opts,
  };
}

describe("formatPValue (F13)", () => {
  it("renders NaN as em-dash", () => {
    expect(formatPValue(Number.NaN)).toBe("—");
  });
  it("renders Infinity as em-dash", () => {
    expect(formatPValue(Number.POSITIVE_INFINITY)).toBe("—");
  });
  it("renders -Infinity as em-dash", () => {
    expect(formatPValue(Number.NEGATIVE_INFINITY)).toBe("—");
  });
  it("renders a valid p-value with 4 decimals", () => {
    expect(formatPValue(0.01)).toBe("0.0100");
  });
  it("renders 0 as 0.0000", () => {
    expect(formatPValue(0)).toBe("0.0000");
  });
});

describe("PRCommentReporter — F13 NaN/Infinity p-values", () => {
  it("does NOT render 'NaN' in the regression table", () => {
    const dir = makeScratchDir("pr-nan-");
    created.push(dir);
    const out = join(dir, "pr.md");
    const reporter = new PRCommentReporter(out);

    const gate: CIGateResult = {
      pass: false,
      reasons: ["regression detected"],
      regressionCount: 1,
    } as CIGateResult;

    const reg: RegressionResult = {
      sampleId: "s",
      baselinePassRate: 1,
      currentPassRate: 0,
      pValue: Number.NaN as unknown as number,
      adjustedPValue: Number.NaN as unknown as number,
      significant: true,
      direction: "regressed",
    };

    reporter.writeGateResult(gate, [reg]);
    const text = readFileSync(out, "utf8");
    expect(text).not.toMatch(/\bNaN\b/);
    // Em-dash present in the row's p-value cell.
    expect(text).toMatch(/\| s \| 100\.0% \| 0\.0% \| -100\.0pp \| — \| regressed \|/);
  });

  it("renders Infinity p-values as em-dash", () => {
    const dir = makeScratchDir("pr-inf-");
    created.push(dir);
    const out = join(dir, "pr.md");
    const reporter = new PRCommentReporter(out);

    const gate: CIGateResult = {
      pass: false,
      reasons: ["regression"],
      regressionCount: 1,
    } as CIGateResult;

    const reg: RegressionResult = {
      sampleId: "s",
      baselinePassRate: 1,
      currentPassRate: 0,
      pValue: Number.POSITIVE_INFINITY as unknown as number,
      significant: true,
      direction: "regressed",
    };

    reporter.writeGateResult(gate, [reg]);
    const text = readFileSync(out, "utf8");
    expect(text).not.toMatch(/Infinity/);
    expect(text).toContain("| — |");
  });

  it("still renders valid p-values with 4 decimals", () => {
    const dir = makeScratchDir("pr-ok-");
    created.push(dir);
    const out = join(dir, "pr.md");
    const reporter = new PRCommentReporter(out);

    const gate: CIGateResult = {
      pass: false,
      reasons: ["regression"],
      regressionCount: 1,
    } as CIGateResult;

    const reg: RegressionResult = {
      sampleId: "s",
      baselinePassRate: 1,
      currentPassRate: 0,
      pValue: 0.01,
      adjustedPValue: 0.01,
      significant: true,
      direction: "regressed",
    };

    reporter.writeGateResult(gate, [reg]);
    const text = readFileSync(out, "utf8");
    expect(text).toContain("0.0100");
  });
});

describe("MarkdownReporter — F27 provenance section", () => {
  it("includes runId, gitSha, model, startedAt, finishedAt and harness version", () => {
    const dir = makeScratchDir("md-prov-");
    created.push(dir);
    const out = join(dir, "report.md");
    const reporter = new MarkdownReporter(out);
    const result = makeMultiTrial({
      runId: "r",
      gitSha: "abc123",
      model: "m",
      startedAt: "a",
      finishedAt: "b",
    });

    reporter.onMultiTrialComplete(result);
    expect(existsSync(out)).toBe(true);
    const text = readFileSync(out, "utf8");

    // Read harness package version
    const pkgPath = join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
    expect(pkg.version).toBeTruthy();

    expect(text).toMatch(/^### Provenance$/m);
    expect(text).toMatch(/^- \*\*Run ID:\*\* r$/m);
    expect(text).toMatch(/^- \*\*Git SHA:\*\* abc123$/m);
    expect(text).toMatch(/^- \*\*Model:\*\* m$/m);
    expect(text).toMatch(/^- \*\*Started:\*\* a$/m);
    expect(text).toMatch(/^- \*\*Finished:\*\* b$/m);
    expect(text).toMatch(
      new RegExp(
        `^- \\*\\*Harness Version:\\*\\* ${pkg.version.replace(/[.+*?^$()[\]{}|\\]/g, "\\$&")}$`,
        "m",
      ),
    );
    // Provenance must be a clearly labelled section.
    expect(text).toMatch(/Provenance/i);
  });

  it("omits gitSha and model lines when undefined", () => {
    const dir = makeScratchDir("md-prov-min-");
    created.push(dir);
    const out = join(dir, "report.md");
    const reporter = new MarkdownReporter(out);
    const result = makeMultiTrial({
      runId: "r2",
      gitSha: undefined,
      model: undefined,
      startedAt: "s",
      finishedAt: "f",
    });

    reporter.onMultiTrialComplete(result);
    const text = readFileSync(out, "utf8");
    expect(text).toMatch(/^- \*\*Run ID:\*\* r2$/m);
    expect(text).toMatch(/^- \*\*Started:\*\* s$/m);
    expect(text).toMatch(/^- \*\*Finished:\*\* f$/m);
    // No "Git SHA:" or "Model:" provenance lines when fields are undefined.
    expect(text).not.toMatch(/\*\*Git SHA:\*\*/);
    expect(text).not.toMatch(/\*\*Model:\*\*\s+undefined/);
    expect(text).not.toMatch(/\*\*Model:\*\*/);
  });
});
