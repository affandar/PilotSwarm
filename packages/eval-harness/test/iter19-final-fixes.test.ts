// iter19 — keep only the four genuinely unique trust cases (per audit
// recommendation). Other iter19 tests duplicated the invariant matrix,
// numeric helpers, or reporter formatting and were dropped.
//
// Kept tests cover:
//   - Matrix Cartesian incompleteness (B2)
//   - LLM judge concurrent budget cap (H4)
//   - Reporter cannot mutate canonical RunResult (H7)
//   - rawRuns/trials coherence (H9)

import { describe, it, expect } from "vitest";
import {
  MatrixResultSchema,
  MultiTrialResultSchema,
} from "../src/types.js";
import { LLMJudgeGrader } from "../src/graders/llm-judge.js";
import type {
  JudgeClient,
  JudgeRequest,
  JudgeResponse,
} from "../src/graders/judge-types.js";
import { EvalRunner } from "../src/runner.js";
import type { Driver } from "../src/drivers/types.js";
import { makeMatrixCell, makeMultiTrialResult } from "./fixtures/builders.js";

describe("iter19 B2: MatrixResultSchema Cartesian completeness", () => {
  it("rejects 2x2 matrix with only 3 cells (Cartesian incompleteness)", () => {
    const cell = (model: string, configId: string) =>
      makeMatrixCell({
        model,
        configId,
        configLabel: "L",
        result: { ...makeMultiTrialResult(), model } as never,
      });
    const r = MatrixResultSchema.safeParse({
      schemaVersion: 1,
      runId: "r",
      taskId: "t",
      taskVersion: "1",
      startedAt: "a",
      finishedAt: "b",
      models: ["m1", "m2"],
      configs: [
        { id: "c1", label: "C1", overrides: {} },
        { id: "c2", label: "C2", overrides: {} },
      ],
      cells: [cell("m1", "c1"), cell("m1", "c2"), cell("m2", "c1")],
      summary: {
        totalCells: 3,
        bestPassRate: { model: "m1", configId: "c1", passRate: 0 },
        worstPassRate: { model: "m1", configId: "c1", passRate: 0 },
      },
    });
    expect(r.success).toBe(false);
  });
});

describe("iter19 H4: LLMJudgeGrader budget hard cap under concurrency", () => {
  it("does not exceed cap when concurrent grades reconcile actual cost", async () => {
    const calls: number[] = [];
    let invocations = 0;
    const client: JudgeClient = {
      cacheIdentity: () => "test-client",
      estimateCost: () => 0.05,
      judge: async (_req: JudgeRequest): Promise<JudgeResponse> => {
        invocations++;
        await new Promise((r) => setTimeout(r, 30));
        calls.push(0.12);
        return {
          result: {
            criterionId: _req.criterion.id,
            reasoning: "ok",
            rawScore: 1,
            normalizedScore: 1,
            pass: true,
          },
          cost: { inputTokens: 0, outputTokens: 0, model: "m", estimatedCostUsd: 0.12 },
        };
      },
    };
    const grader = new LLMJudgeGrader({
      client,
      rubric: {
        id: "r",
        name: "R",
        version: "1",
        criteria: [
          { id: "c1", description: "d", scale: { min: 0, max: 1 }, passThreshold: 0.5 },
        ],
      },
      budgetUsd: 0.15,
    });
    const [a, b] = await Promise.all([
      grader.grade("p1", "r1"),
      grader.grade("p2", "r2"),
    ]);
    void a; void b;
    expect(grader.cumulativeCostUsd).toBeLessThanOrEqual(0.15 + 1e-9);
    expect(invocations).toBeGreaterThanOrEqual(1);
  });
});

describe("iter19 H7: EvalRunner freezes RunResult before reporters", () => {
  it("reporter cannot mutate the canonical returned RunResult", async () => {
    const driver: Driver = {
      run: async () => ({ toolCalls: [], finalResponse: "x", sessionId: "s", latencyMs: 0 }),
    };
    const result = await new EvalRunner({
      driver,
      reporters: [
        {
          onRunStart: () => {},
          onCaseResult: () => {},
          onRunComplete: (r: { cases?: unknown; summary?: { total?: number } }) => {
            try {
              // @ts-expect-error attempt mutation
              r.cases = [];
            } catch { /* frozen */ }
            try {
              // @ts-expect-error attempt mutation
              r.summary.total = 999;
            } catch { /* frozen */ }
          },
        },
      ],
    }).runTask({
      schemaVersion: 1,
      id: "t",
      name: "n",
      description: "d",
      version: "1",
      runnable: true,
      samples: [
        {
          id: "s",
          description: "d",
          input: { prompt: "p" },
          expected: { toolCalls: [{ name: "t", match: "subset" as const }], toolSequence: "unordered" as const },
          timeoutMs: 5000,
        },
      ],
    } as never);
    expect(Array.isArray(result.cases) && result.cases.length).toBe(1);
    expect(result.summary.total).toBe(1);
  });
});

describe("iter19 H9: MultiTrialResultSchema requires rawRuns.length === trials for non-dry", () => {
  it("rejects trials:100 with rawRuns:[]", () => {
    const ci = { lower: 0, upper: 0, point: 0, z: 1.96 };
    const r = MultiTrialResultSchema.safeParse({
      schemaVersion: 1,
      runId: "r",
      taskId: "t",
      taskVersion: "1",
      trials: 100,
      startedAt: "a",
      finishedAt: "b",
      summary: { total: 1, trials: 100, stddevPassRate: 0, passRateCI: ci },
      samples: [
        {
          sampleId: "s",
          trials: 100,
          passCount: 0,
          failCount: 0,
          errorCount: 100,
          noQualitySignal: true,
          passAtK: {},
          scores: {},
          wilsonCI: ci,
        },
      ],
      rawRuns: [],
    });
    expect(r.success).toBe(false);
  });
});
