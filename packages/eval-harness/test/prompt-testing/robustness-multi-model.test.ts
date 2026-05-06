/**
 * Robustness suite — unit-level coverage for the synchronous summary
 * aggregation paths that don't require a LIVE LLM. Multi-model summary
 * population is covered by injecting a stub `runVariantMatrix` via module
 * spying — we verify that perVariant, perModel, crossCells, and
 * cleanupErrors are populated correctly when sub-matrices return them.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/prompt-testing/variant-runner.js", () => {
    return {
        runVariantMatrix: vi.fn(),
    };
});

import { runVariantMatrix } from "../../src/prompt-testing/variant-runner.js";
import { runRobustnessSuite } from "../../src/prompt-testing/suites/robustness.js";
import type {
    PromptTestMatrixResult,
    PromptTestResult,
    PromptUnderTest,
    PromptVariant,
} from "../../src/prompt-testing/types.js";
import type { EvalSample } from "../../src/types.js";

const baseline: PromptUnderTest = {
    label: "baseline",
    source: { kind: "inline", agentName: "default", prompt: "agent prompt" },
};
const variant: PromptVariant = { id: "v1", baseline };

function makeSample(): EvalSample {
    return {
        id: "sample.x",
        description: "synthetic",
        input: { prompt: "Use test_add to compute 1 + 1." },
        expected: { toolCalls: [{ name: "test_add", match: "subset" }] },
        timeoutMs: 1000,
    };
}

function cell(opts: {
    variantId: string;
    model?: string;
    trial: number;
    toolCallAccuracy: number;
    instructionFollowing: number;
    errored?: boolean;
}): PromptTestResult {
    const c: PromptTestResult = {
        variantId: opts.variantId,
        trial: opts.trial,
        sampleId: `${opts.variantId}-${opts.trial}`,
        toolCallAccuracy: opts.toolCallAccuracy,
        instructionFollowing: opts.instructionFollowing,
        latencyMs: 100,
        observedToolCalls: [],
        finalResponse: "ok",
    };
    if (opts.model) c.model = opts.model;
    if (opts.errored) c.errored = true;
    return c;
}

function makeStubMatrix(opts: {
    variantId: string;
    models: string[];
    trials: number;
    cleanupErrors?: Array<{ pluginDir: string; error: string }>;
}): PromptTestMatrixResult {
    const cells: PromptTestResult[] = [];
    if (opts.models.length === 0) {
        for (let t = 0; t < opts.trials; t++) {
            cells.push(
                cell({
                    variantId: opts.variantId,
                    trial: t,
                    toolCallAccuracy: 1,
                    instructionFollowing: 1,
                }),
            );
        }
    } else {
        for (const m of opts.models) {
            for (let t = 0; t < opts.trials; t++) {
                cells.push(
                    cell({
                        variantId: opts.variantId,
                        model: m,
                        trial: t,
                        toolCallAccuracy: 1,
                        instructionFollowing: 1,
                    }),
                );
            }
        }
    }
    const result: PromptTestMatrixResult = {
        baseline,
        variants: [variant],
        models: opts.models,
        cells,
        summary: { perVariant: {}, perModel: {}, crossCells: {} },
    };
    if (opts.cleanupErrors) result.cleanupErrors = opts.cleanupErrors;
    return result;
}

describe("runRobustnessSuite — multi-model summary population", () => {
    it("populates perModel and crossCells for each variant × model cell", async () => {
        const stub = vi.mocked(runVariantMatrix);
        stub.mockReset();
        // 3 paraphrases × 2 models × 1 trial each
        for (let i = 0; i < 3; i++) {
            stub.mockResolvedValueOnce(
                makeStubMatrix({
                    variantId: `v1::para-${i}`,
                    models: ["m-alpha", "m-beta"],
                    trials: 1,
                }),
            );
        }

        const robust = await runRobustnessSuite({
            baseline,
            variant,
            sample: makeSample(),
            paraphrases: ["a", "b", "c"],
            models: ["m-alpha", "m-beta"],
            trials: 1,
        });

        // perVariant for each paraphrased variant
        for (let i = 0; i < 3; i++) {
            expect(robust.matrix.summary.perVariant[`v1::para-${i}`]).toBeDefined();
        }
        // perModel for each model
        expect(robust.matrix.summary.perModel["m-alpha"]).toBeDefined();
        expect(robust.matrix.summary.perModel["m-beta"]).toBeDefined();
        expect(robust.matrix.summary.perModel["m-alpha"]!.passRate).toBe(1);

        // crossCells variant × model
        for (let i = 0; i < 3; i++) {
            expect(
                robust.matrix.summary.crossCells[`v1::para-${i}`]?.["m-alpha"],
            ).toBe(1);
            expect(
                robust.matrix.summary.crossCells[`v1::para-${i}`]?.["m-beta"],
            ).toBe(1);
        }

        // 3 paraphrases × 2 models × 1 trial = 6 cells total
        expect(robust.matrix.cells.length).toBe(6);
        expect(robust.matrix.models).toEqual(["m-alpha", "m-beta"]);
    });

    it("propagates cleanupErrors from sub-matrices", async () => {
        const stub = vi.mocked(runVariantMatrix);
        stub.mockReset();
        // First sub-matrix has a cleanup error; second is clean.
        stub.mockResolvedValueOnce(
            makeStubMatrix({
                variantId: "v1::para-0",
                models: [],
                trials: 1,
                cleanupErrors: [
                    { pluginDir: "/tmp/leaked-1", error: "EACCES" },
                    { pluginDir: "/tmp/leaked-2", error: "ENOTEMPTY" },
                ],
            }),
        );
        stub.mockResolvedValueOnce(
            makeStubMatrix({
                variantId: "v1::para-1",
                models: [],
                trials: 1,
            }),
        );

        const robust = await runRobustnessSuite({
            baseline,
            variant,
            sample: makeSample(),
            paraphrases: ["a", "b"],
            trials: 1,
        });

        expect(robust.matrix.cleanupErrors).toBeDefined();
        expect(robust.matrix.cleanupErrors!.length).toBe(2);
        expect(robust.matrix.cleanupErrors!.map((e) => e.pluginDir)).toEqual([
            "/tmp/leaked-1",
            "/tmp/leaked-2",
        ]);
    });

    it("omits cleanupErrors entirely when all sub-matrices clean", async () => {
        const stub = vi.mocked(runVariantMatrix);
        stub.mockReset();
        stub.mockResolvedValueOnce(
            makeStubMatrix({ variantId: "v1::para-0", models: [], trials: 1 }),
        );
        stub.mockResolvedValueOnce(
            makeStubMatrix({ variantId: "v1::para-1", models: [], trials: 1 }),
        );

        const robust = await runRobustnessSuite({
            baseline,
            variant,
            sample: makeSample(),
            paraphrases: ["a", "b"],
            trials: 1,
        });

        expect(robust.matrix.cleanupErrors).toBeUndefined();
    });

    it("reports zero stddev when all paraphrases produce identical accuracy", async () => {
        const stub = vi.mocked(runVariantMatrix);
        stub.mockReset();
        for (let i = 0; i < 3; i++) {
            stub.mockResolvedValueOnce(
                makeStubMatrix({ variantId: `v1::para-${i}`, models: [], trials: 1 }),
            );
        }
        const robust = await runRobustnessSuite({
            baseline,
            variant,
            sample: makeSample(),
            paraphrases: ["x", "y", "z"],
            trials: 1,
        });
        expect(robust.toolCallAccuracyMean).toBe(1);
        expect(robust.toolCallAccuracyStddev).toBe(0);
    });
});
