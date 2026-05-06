import { describe, it, expect } from "vitest";
import { renderReport } from "../../src/prompt-testing/reporter.js";
import type {
  PromptTestMatrixResult,
} from "../../src/prompt-testing/types.js";

function baseline(label = "default") {
  return { label, source: { kind: "inline" as const, agentName: "x", prompt: "y" } };
}

describe("HIGH #5 + #7 — reporter error surface", () => {
  it("renders a per-cell error table with variant/model/trial/sampleId/message", () => {
    const matrix: PromptTestMatrixResult = {
      baseline: baseline(),
      variants: [{ id: "v1", baseline: baseline() }],
      models: ["gpt-x"],
      cells: [
        {
          variantId: "v1",
          model: "gpt-x",
          trial: 0,
          sampleId: "s1",
          toolCallAccuracy: 0,
          instructionFollowing: 0,
          latencyMs: 0,
          observedToolCalls: [],
          finalResponse: "",
          errored: true,
          errorMessage: "driver hung up after 240s",
        },
      ],
      summary: {
        perVariant: {
          v1: { passRate: 0, meanLatency: 0, toolCallAccuracy: 0 },
        },
        perModel: {
          "gpt-x": { passRate: 0, meanLatency: 0 },
        },
        crossCells: { v1: { "gpt-x": 0 } },
      },
    };
    const r = renderReport({ matrices: [{ title: "T", matrix }] });
    expect(r.markdown).toContain("Errors (1 cell(s))");
    expect(r.markdown).toContain("`v1`");
    expect(r.markdown).toContain("`gpt-x`");
    expect(r.markdown).toContain("`s1`");
    expect(r.markdown).toContain("driver hung up after 240s");
  });

  it("renders a cleanup-error table when cleanupErrors is present", () => {
    const matrix: PromptTestMatrixResult = {
      baseline: baseline(),
      variants: [{ id: "v1", baseline: baseline() }],
      models: [],
      cells: [],
      summary: {
        perVariant: { v1: { passRate: 0, meanLatency: 0, toolCallAccuracy: 0 } },
        perModel: {},
        crossCells: {},
      },
      cleanupErrors: [
        { pluginDir: "/tmp/leftover-1", error: "EBUSY: open file handle" },
      ],
    };
    const r = renderReport({ matrices: [{ title: "T", matrix }] });
    expect(r.markdown).toContain("cleanup errors");
    expect(r.markdown).toContain("/tmp/leftover-1");
    expect(r.markdown).toContain("EBUSY");
  });

  it("renders per-sample drift detail for failed regression", () => {
    const matrix: PromptTestMatrixResult = {
      baseline: baseline(),
      variants: [{ id: "v1", baseline: baseline() }],
      models: [],
      cells: [],
      summary: {
        perVariant: { v1: { passRate: 0, meanLatency: 0, toolCallAccuracy: 0 } },
        perModel: {},
        crossCells: {},
      },
    };
    const r = renderReport({
      matrices: [{ title: "T", matrix }],
      drift: [
        {
          title: "v1",
          report: {
            passed: false,
            reasons: ["sample 's1': tool-call sequence mismatch in 1/1 trial(s)"],
            golden: {
              schemaVersion: 2,
              variantId: "v1",
              model: null,
              toolCallAccuracyMean: 1,
              instructionFollowingMean: 1,
              latencyMsMean: 100,
              trials: 1,
              capturedAt: "now",
              hasQualitySignal: true,
              samples: {},
            },
            current: {
              schemaVersion: 2,
              variantId: "v1",
              model: null,
              toolCallAccuracyMean: 1,
              instructionFollowingMean: 1,
              latencyMsMean: 100,
              trials: 1,
              capturedAt: "now",
              hasQualitySignal: true,
              samples: {},
            },
            perSample: [
              { sampleId: "s1", passed: false, reasons: ["tool-call sequence mismatch"] },
            ],
            notes: ["legacy v1 golden"],
          },
        },
      ],
    });
    expect(r.markdown).toContain("Per-sample failures");
    expect(r.markdown).toContain("`s1`");
    expect(r.markdown).toContain("tool-call sequence mismatch");
    expect(r.markdown).toContain("Notes:");
    expect(r.markdown).toContain("legacy v1 golden");
  });
});
