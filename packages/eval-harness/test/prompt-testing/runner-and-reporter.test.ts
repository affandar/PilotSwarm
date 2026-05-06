import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  materializeVariant,
  cleanupPluginDir,
} from "../../src/prompt-testing/variant-runner.js";
import { syntheticallyDegrade, compareGoldens } from "../../src/prompt-testing/suites/regression.js";
import { renderReport } from "../../src/prompt-testing/reporter.js";
import type {
  PromptTestMatrixResult,
  PromptVariant,
} from "../../src/prompt-testing/types.js";

function makeBaselineFile(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "ps-prompt-runner-test-"));
  const path = join(dir, "default.agent.md");
  writeFileSync(
    path,
    `---
name: default
description: test
tools:
  - bash
---

# Default

## Rules

1. Be helpful.
2. Be concise.
3. Use tools when needed.
4. Always cite.
`,
    "utf8",
  );
  return { dir, path };
}

describe("variant-runner smoke (no LIVE)", () => {
  it("materializeVariant produces a plugin dir with mutated agent.md", async () => {
    const { dir, path } = makeBaselineFile();
    try {
      const variant: PromptVariant = {
        id: "minimize-50",
        baseline: { label: "default", source: { kind: "file", path } },
        mutation: { mutator: "minimize", config: { percent: 50 } },
      };
      const mat = await materializeVariant(variant);
      try {
        expect(existsSync(join(mat.pluginDir, "agents", "default.agent.md"))).toBe(true);
        const text = readFileSync(join(mat.pluginDir, "agents", "default.agent.md"), "utf8");
        expect(text).toMatch(/^---/u);
        expect(text).toContain("name: default");
        // 4 rules → keep 2 → "Always cite" must be dropped.
        expect(text).not.toContain("Always cite");
      } finally {
        cleanupPluginDir(mat.pluginDir);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("materializeVariant honors override on top of mutation", async () => {
    const { dir, path } = makeBaselineFile();
    try {
      const variant: PromptVariant = {
        id: "ovr",
        baseline: { label: "default", source: { kind: "file", path } },
        mutation: { mutator: "minimize", config: { percent: 50 } },
        override: { frontmatter: { description: "overridden" } },
      };
      const mat = await materializeVariant(variant);
      try {
        const text = readFileSync(join(mat.pluginDir, "agents", "default.agent.md"), "utf8");
        expect(text).toContain("description: overridden");
      } finally {
        cleanupPluginDir(mat.pluginDir);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("regression / drift", () => {
  it("syntheticallyDegrade zeros out tool-call accuracy", () => {
    const matrix: PromptTestMatrixResult = {
      baseline: { label: "b", source: { kind: "inline", agentName: "x", prompt: "y" } },
      variants: [{ id: "v", baseline: { label: "b", source: { kind: "inline", agentName: "x", prompt: "y" } } }],
      models: [],
      cells: [
        {
          variantId: "v",
          trial: 0,
          toolCallAccuracy: 1,
          instructionFollowing: 1,
          latencyMs: 100,
          observedToolCalls: [],
          finalResponse: "ok",
        },
      ],
      summary: { perVariant: {}, perModel: {}, crossCells: {} },
    };
    const degraded = syntheticallyDegrade(matrix);
    expect(degraded.cells[0]!.toolCallAccuracy).toBe(0);
    expect(degraded.cells[0]!.instructionFollowing).toBe(0);
  });

  it("compareGoldens flags toolCallAccuracy drop", () => {
    const golden = {
      schemaVersion: 1 as const,
      variantId: "v",
      model: null,
      toolCallAccuracyMean: 0.9,
      instructionFollowingMean: 0.9,
      latencyMsMean: 100,
      trials: 3,
      capturedAt: new Date().toISOString(),
    };
    const current = { ...golden, toolCallAccuracyMean: 0.5 };
    const report = compareGoldens(golden, current);
    expect(report.passed).toBe(false);
    expect(report.reasons.some((r) => r.includes("toolCallAccuracy"))).toBe(true);
  });

  it("compareGoldens passes within thresholds", () => {
    const golden = {
      schemaVersion: 1 as const,
      variantId: "v",
      model: null,
      toolCallAccuracyMean: 0.9,
      instructionFollowingMean: 0.9,
      latencyMsMean: 100,
      trials: 3,
      capturedAt: new Date().toISOString(),
    };
    const current = { ...golden, toolCallAccuracyMean: 0.85 };
    const report = compareGoldens(golden, current);
    expect(report.passed).toBe(true);
    expect(report.reasons.length).toBe(0);
  });
});

describe("reporter", () => {
  it("renders markdown with per-variant + cross-cell tables", () => {
    const matrix: PromptTestMatrixResult = {
      baseline: { label: "default", source: { kind: "inline", agentName: "x", prompt: "y" } },
      variants: [
        { id: "baseline", baseline: { label: "default", source: { kind: "inline", agentName: "x", prompt: "y" } } },
        { id: "minimize-50", baseline: { label: "default", source: { kind: "inline", agentName: "x", prompt: "y" } } },
      ],
      models: ["m1", "m2"],
      cells: [],
      summary: {
        perVariant: {
          baseline: { passRate: 0.9, meanLatency: 1000, toolCallAccuracy: 0.9 },
          "minimize-50": { passRate: 0.5, meanLatency: 800, toolCallAccuracy: 0.5 },
        },
        perModel: {
          m1: { passRate: 0.8, meanLatency: 900 },
          m2: { passRate: 0.6, meanLatency: 950 },
        },
        crossCells: {
          baseline: { m1: 1, m2: 0.8 },
          "minimize-50": { m1: 0.5, m2: 0.5 },
        },
      },
    };
    const report = renderReport({ matrices: [{ title: "Ablation", matrix }] });
    expect(report.markdown).toContain("# Prompt Testing Report");
    expect(report.markdown).toContain("## Ablation");
    expect(report.markdown).toContain("`baseline`");
    expect(report.markdown).toContain("`minimize-50`");
    expect(report.markdown).toContain("Cross-cell pass rates");
    expect(report.json.matrices.length).toBe(1);
  });
});
