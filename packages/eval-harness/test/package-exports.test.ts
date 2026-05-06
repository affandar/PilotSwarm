import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import * as pkg from "pilotswarm-eval-harness";

describe("package root exports", () => {
  it("exposes the published runtime surface from dist", () => {
    expect(typeof pkg.OpenAIJudgeClient).toBe("function");
    expect(typeof pkg.LLMJudgeGrader).toBe("function");
    expect(typeof pkg.EvalRunner).toBe("function");
    expect(typeof pkg.MultiTrialRunner).toBe("function");
    expect(typeof pkg.MatrixRunner).toBe("function");
    expect(typeof pkg.TrajectoryRunner).toBe("function");
    expect(typeof pkg.CIGate).toBe("function");
    expect(typeof pkg.RegressionDetector).toBe("function");
    expect(typeof pkg.ConsoleAggregateReporter).toBe("function");
    expect(typeof pkg.MarkdownReporter).toBe("function");
    expect(typeof pkg.PRCommentReporter).toBe("function");
    expect(typeof pkg.JsonlReporter).toBe("function");
    expect(typeof pkg.FakeDriver).toBe("function");
    expect(typeof pkg.LiveDriver).toBe("function");
    expect(typeof pkg.DurabilityFixtureDriver).toBe("function");
    expect(typeof pkg.FakeMultiTurnDriver).toBe("function");
    expect(typeof pkg.FakeJudgeClient).toBe("function");
    expect(typeof pkg.InMemoryJudgeCache).toBe("function");
    expect(typeof pkg.loadEvalTask).toBe("function");
    expect(typeof pkg.saveBaseline).toBe("function");
    expect(typeof pkg.loadBaseline).toBe("function");

    const rates: pkg.OpenAIJudgeCostRates = {
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 1,
    };
    expect(rates.inputUsdPerMillionTokens).toBe(1);
  });

  it("keeps dist package-root mannWhitneyU exact p-values symmetric", () => {
    const forward = pkg.mannWhitneyU([10, 11, 12], [1, 2, 3]);
    const reverse = pkg.mannWhitneyU([1, 2, 3], [10, 11, 12]);
    expect(forward.pValue).toBeCloseTo(reverse.pValue, 12);
    expect(forward.pValue).toBeCloseTo(0.1, 12);
  });

  it("does not eagerly load pilotswarm-sdk from the package root", () => {
    const loaderPath = join(process.cwd(), "test/fixtures/deny-pilotswarm-sdk-loader.mjs");
    const registerLoader = `data:text/javascript,${encodeURIComponent(
      `import { register } from "node:module"; import { pathToFileURL } from "node:url"; register(${JSON.stringify(loaderPath)}, pathToFileURL("./"));`,
    )}`;
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        registerLoader,
        "--input-type=module",
        "--eval",
        "const pkg = await import('pilotswarm-eval-harness'); new pkg.LiveDriver(); console.log('ok');",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(output.trim()).toBe("ok");
  });
});
