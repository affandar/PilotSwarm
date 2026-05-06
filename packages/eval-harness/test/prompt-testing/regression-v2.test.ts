import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureGolden,
  compareGoldens,
  compareToGolden,
  readGolden,
  syntheticallyDegrade,
  normalizeResponse,
} from "../../src/prompt-testing/suites/regression.js";
import type {
  PromptGoldenV1,
  PromptGoldenV2,
} from "../../src/prompt-testing/suites/regression.js";
import type {
  PromptTestMatrixResult,
  PromptVariant,
} from "../../src/prompt-testing/types.js";

function inlineBaseline(label = "b") {
  return { label, source: { kind: "inline" as const, agentName: "x", prompt: "y" } };
}

function variant(id: string): PromptVariant {
  return { id, baseline: inlineBaseline() };
}

function makeMatrix(opts: {
  variantId: string;
  cells: Array<{
    sampleId: string;
    trial: number;
    toolCallAccuracy: number;
    instructionFollowing: number;
    latencyMs: number;
    finalResponse: string;
    toolCalls?: Array<{ name: string; args?: Record<string, unknown> }>;
    errored?: boolean;
  }>;
}): PromptTestMatrixResult {
  return {
    baseline: inlineBaseline(),
    variants: [variant(opts.variantId)],
    models: [],
    cells: opts.cells.map((c) => ({
      variantId: opts.variantId,
      sampleId: `${c.sampleId}::${opts.variantId}::default`,
      trial: c.trial,
      toolCallAccuracy: c.toolCallAccuracy,
      instructionFollowing: c.instructionFollowing,
      latencyMs: c.latencyMs,
      observedToolCalls: (c.toolCalls ?? []).map((t, i) => ({
        name: t.name,
        args: t.args ?? {},
        order: i,
      })),
      finalResponse: c.finalResponse,
      ...(c.errored ? { errored: true as const, errorMessage: "synthetic" } : {}),
    })),
    summary: { perVariant: {}, perModel: {}, crossCells: {} },
  };
}

describe("BLOCKER #3 — regression v2 schema (per-sample digests)", () => {
  it("captureGolden writes v2 schema with per-sample observations", () => {
    const dir = mkdtempSync(join(tmpdir(), "ps-prompt-golden-v2-"));
    try {
      const golden = captureGolden({
        matrix: makeMatrix({
          variantId: "v",
          cells: [
            {
              sampleId: "s1",
              trial: 0,
              toolCallAccuracy: 1,
              instructionFollowing: 1,
              latencyMs: 100,
              finalResponse: "Hello world",
              toolCalls: [{ name: "test_add", args: { a: 1, b: 2 } }],
            },
          ],
        }),
        variantId: "v",
        goldenPath: join(dir, "g.json"),
      });
      expect(golden.schemaVersion).toBe(2);
      expect(golden.hasQualitySignal).toBe(true);
      expect(Object.keys(golden.samples)).toEqual(["s1"]);
      const s = golden.samples["s1"]!;
      expect(s.observations.length).toBe(1);
      expect(s.observations[0]!.responseDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(s.observations[0]!.toolCallSequence).toEqual([
        { name: "test_add", argKeys: ["a", "b"], argDigest: expect.any(String) },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects tool-call-NAME drift even when aggregate metrics match", () => {
    const golden = captureGolden({
      matrix: makeMatrix({
        variantId: "v",
        cells: [
          {
            sampleId: "s1",
            trial: 0,
            toolCallAccuracy: 1,
            instructionFollowing: 1,
            latencyMs: 100,
            finalResponse: "abc",
            toolCalls: [{ name: "expected_tool" }],
          },
        ],
      }),
      variantId: "v",
      goldenPath: join(mkdtempSync(join(tmpdir(), "ps-pg-")), "g.json"),
    });
    // Current run: same accuracy / instr-follow, but DIFFERENT tool name
    const current = captureGolden({
      matrix: makeMatrix({
        variantId: "v",
        cells: [
          {
            sampleId: "s1",
            trial: 0,
            toolCallAccuracy: 1,
            instructionFollowing: 1,
            latencyMs: 100,
            finalResponse: "abc",
            toolCalls: [{ name: "different_tool" }],
          },
        ],
      }),
      variantId: "v",
      goldenPath: join(mkdtempSync(join(tmpdir(), "ps-pg2-")), "g.json"),
    });
    const drift = compareGoldens(golden, current);
    expect(drift.passed).toBe(false);
    expect(drift.reasons.some((r) => r.includes("tool-call sequence"))).toBe(true);
  });

  it("digest matcher fails on different response text even when length matches", () => {
    const dir = mkdtempSync(join(tmpdir(), "ps-prompt-digest-"));
    const goldenPath = join(dir, "g.json");
    try {
      const g = captureGolden({
        matrix: makeMatrix({
          variantId: "v",
          cells: [
            {
              sampleId: "s1",
              trial: 0,
              toolCallAccuracy: 1,
              instructionFollowing: 1,
              latencyMs: 100,
              finalResponse: "the answer is 42",
            },
          ],
        }),
        variantId: "v",
        goldenPath,
      });
      const current = makeMatrix({
        variantId: "v",
        cells: [
          {
            sampleId: "s1",
            trial: 0,
            toolCallAccuracy: 1,
            instructionFollowing: 1,
            latencyMs: 100,
            finalResponse: "totalgarbageABCDEF", // same length 18
          },
        ],
      });
      const drift = compareToGolden({
        matrix: current,
        variantId: "v",
        goldenPath,
        threshold: { responseMatch: "digest" },
      });
      expect(drift.passed).toBe(false);
      expect(drift.reasons.some((r) => r.includes("response digest mismatch"))).toBe(true);
      expect(g).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("length-tolerance matcher passes for similar-length responses", () => {
    const golden = captureGolden({
      matrix: makeMatrix({
        variantId: "v",
        cells: [
          {
            sampleId: "s1",
            trial: 0,
            toolCallAccuracy: 1,
            instructionFollowing: 1,
            latencyMs: 100,
            finalResponse: "the answer is 42",
          },
        ],
      }),
      variantId: "v",
      goldenPath: join(mkdtempSync(join(tmpdir(), "ps-len-")), "g.json"),
    });
    const current = captureGolden({
      matrix: makeMatrix({
        variantId: "v",
        cells: [
          {
            sampleId: "s1",
            trial: 0,
            toolCallAccuracy: 1,
            instructionFollowing: 1,
            latencyMs: 100,
            finalResponse: "the result is 42!", // length 17 vs 16
          },
        ],
      }),
      variantId: "v",
      goldenPath: join(mkdtempSync(join(tmpdir(), "ps-len2-")), "g.json"),
    });
    const drift = compareGoldens(golden, current);
    expect(drift.passed).toBe(true);
  });

  it("detects per-sample regression even when aggregate masks it", () => {
    const golden = captureGolden({
      matrix: makeMatrix({
        variantId: "v",
        cells: [
          {
            sampleId: "s1",
            trial: 0,
            toolCallAccuracy: 1,
            instructionFollowing: 1,
            latencyMs: 100,
            finalResponse: "abc",
            toolCalls: [{ name: "t1" }],
          },
          {
            sampleId: "s2",
            trial: 0,
            toolCallAccuracy: 0,
            instructionFollowing: 0,
            latencyMs: 100,
            finalResponse: "abc",
            toolCalls: [{ name: "t2" }],
          },
        ],
      }),
      variantId: "v",
      goldenPath: join(mkdtempSync(join(tmpdir(), "ps-mask-")), "g.json"),
    });
    // Current: s1 went to 0, s2 went to 1 → aggregate same, per-sample drifted
    const current = captureGolden({
      matrix: makeMatrix({
        variantId: "v",
        cells: [
          {
            sampleId: "s1",
            trial: 0,
            toolCallAccuracy: 0,
            instructionFollowing: 0,
            latencyMs: 100,
            finalResponse: "abc",
            toolCalls: [{ name: "different_tool" }],
          },
          {
            sampleId: "s2",
            trial: 0,
            toolCallAccuracy: 1,
            instructionFollowing: 1,
            latencyMs: 100,
            finalResponse: "abc",
            toolCalls: [{ name: "another_different" }],
          },
        ],
      }),
      variantId: "v",
      goldenPath: join(mkdtempSync(join(tmpdir(), "ps-mask2-")), "g.json"),
    });
    const drift = compareGoldens(golden, current);
    expect(drift.passed).toBe(false);
    // Per-sample drops should be in reasons.
    expect(drift.reasons.some((r) => r.startsWith("sample 's1':"))).toBe(true);
  });

  it("'no quality signal' is reported distinctly from 'all metrics dropped'", () => {
    const goldenMatrix = makeMatrix({
      variantId: "v",
      cells: [
        {
          sampleId: "s1",
          trial: 0,
          toolCallAccuracy: 1,
          instructionFollowing: 1,
          latencyMs: 100,
          finalResponse: "ok",
        },
      ],
    });
    const erroredMatrix = makeMatrix({
      variantId: "v",
      cells: [
        {
          sampleId: "s1",
          trial: 0,
          toolCallAccuracy: 0,
          instructionFollowing: 0,
          latencyMs: 0,
          finalResponse: "",
          errored: true,
        },
      ],
    });
    const goldenPath = join(mkdtempSync(join(tmpdir(), "ps-noqs-")), "g.json");
    captureGolden({ matrix: goldenMatrix, variantId: "v", goldenPath });
    const drift = compareToGolden({ matrix: erroredMatrix, variantId: "v", goldenPath });
    expect(drift.passed).toBe(false);
    expect(drift.reasons.some((r) => r.includes("no quality signal"))).toBe(true);
  });

  it("readGolden upgrades v1 files transparently", () => {
    const dir = mkdtempSync(join(tmpdir(), "ps-prompt-v1-up-"));
    try {
      const v1: PromptGoldenV1 = {
        schemaVersion: 1,
        variantId: "v",
        model: null,
        toolCallAccuracyMean: 0.8,
        instructionFollowingMean: 0.9,
        latencyMsMean: 100,
        trials: 3,
        capturedAt: new Date().toISOString(),
      };
      const path = join(dir, "v1.json");
      require("node:fs").writeFileSync(path, JSON.stringify(v1), "utf8");
      const upgraded = readGolden(path) as PromptGoldenV2;
      expect(upgraded.schemaVersion).toBe(2);
      expect(upgraded.hasQualitySignal).toBe(true);
      expect(upgraded.samples).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("syntheticallyDegrade still works against v2 path", () => {
    const m = makeMatrix({
      variantId: "v",
      cells: [
        {
          sampleId: "s1",
          trial: 0,
          toolCallAccuracy: 1,
          instructionFollowing: 1,
          latencyMs: 100,
          finalResponse: "x",
        },
      ],
    });
    const d = syntheticallyDegrade(m);
    expect(d.cells[0]!.toolCallAccuracy).toBe(0);
  });

  it("normalizeResponse strips timestamps / UUIDs / IPs", () => {
    const t = "session 2025-01-01T00:00:00Z from 10.0.0.1 (00000000-0000-0000-0000-000000000000)";
    expect(normalizeResponse(t)).toBe("session <TS> from <IP> (<UUID>)");
  });

  it("captured golden round-trips through readGolden", () => {
    const dir = mkdtempSync(join(tmpdir(), "ps-rt-"));
    try {
      const goldenPath = join(dir, "g.json");
      const golden = captureGolden({
        matrix: makeMatrix({
          variantId: "v",
          cells: [
            {
              sampleId: "s1",
              trial: 0,
              toolCallAccuracy: 1,
              instructionFollowing: 1,
              latencyMs: 100,
              finalResponse: "ok",
            },
          ],
        }),
        variantId: "v",
        goldenPath,
      });
      const text = readFileSync(goldenPath, "utf8");
      expect(text).toContain('"schemaVersion": 2');
      const back = readGolden(goldenPath);
      expect(back).toEqual(golden);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
