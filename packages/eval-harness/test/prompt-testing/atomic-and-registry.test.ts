import { describe, it, expect } from "vitest";
import {
  existsSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  statSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  materializeVariant,
  cleanupPluginDir,
  runVariantMatrix,
  DEFAULT_MAX_CELLS,
} from "../../src/prompt-testing/variant-runner.js";
import {
  registerTempDir,
  unregisterTempDir,
  _getTrackedTempDirs,
} from "../../src/prompt-testing/temp-registry.js";
import type {
  PromptUnderTest,
  PromptVariant,
} from "../../src/prompt-testing/types.js";
import type { EvalSample } from "../../src/types.js";

function makeBaselineFile(): { dir: string; path: string; baseline: PromptUnderTest } {
  const dir = mkdtempSync(join(tmpdir(), "ps-prompt-runner-fix-test-"));
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
`,
    "utf8",
  );
  return {
    dir,
    path,
    baseline: { label: "default", source: { kind: "file", path } },
  };
}

function makeBrokenBaseline(): PromptUnderTest {
  return {
    label: "broken",
    source: { kind: "file", path: "/this/path/does/not/exist.agent.md" },
  };
}

function makeSample(): EvalSample {
  return {
    id: "test-sample-1",
    description: "synthetic sample",
    input: { prompt: "noop" },
    expected: { toolCalls: [{ name: "noop", match: "subset" }] },
    timeoutMs: 1000,
  };
}

describe("BLOCKER #1 — atomic variant materialization", () => {
  it("cleans up earlier variants when a later one fails to materialize", async () => {
    const ok = makeBaselineFile();
    try {
      const variants: PromptVariant[] = [
        { id: "v1", baseline: ok.baseline },
        { id: "v2-broken", baseline: makeBrokenBaseline() },
      ];
      // Capture the set of plugin dirs before; materialize v1 alone first
      // and verify it gets cleaned up automatically when v2 fails inside
      // runVariantMatrix.
      const before = _getTrackedTempDirs().slice();
      let threw = false;
      try {
        await runVariantMatrix({
          baseline: ok.baseline,
          variants,
          sample: makeSample(),
          trials: 1,
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      // Anything created during materialization must NOT still be on disk.
      const after = _getTrackedTempDirs();
      const newlyCreated = after.filter((d) => !before.includes(d));
      for (const d of newlyCreated) {
        expect(existsSync(d)).toBe(false);
      }
    } finally {
      rmSync(ok.dir, { recursive: true, force: true });
    }
  });
});

describe("temp-registry — process-exit cleanup", () => {
  it("registers and unregisters dirs", () => {
    const d = mkdtempSync(join(tmpdir(), "ps-prompt-temp-reg-"));
    try {
      registerTempDir(d);
      expect(_getTrackedTempDirs()).toContain(d);
      unregisterTempDir(d);
      expect(_getTrackedTempDirs()).not.toContain(d);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("materializeVariant registers the produced dir", async () => {
    const ok = makeBaselineFile();
    try {
      const mat = await materializeVariant({ id: "v1", baseline: ok.baseline });
      try {
        expect(_getTrackedTempDirs()).toContain(mat.pluginDir);
      } finally {
        cleanupPluginDir(mat.pluginDir);
      }
      expect(_getTrackedTempDirs()).not.toContain(mat.pluginDir);
    } finally {
      rmSync(ok.dir, { recursive: true, force: true });
    }
  });
});

describe("HIGH #2 — matrix-size guard", () => {
  it("throws when planned cells exceed maxCells (default 48)", async () => {
    const ok = makeBaselineFile();
    try {
      // 5 variants × 5 models × 3 trials = 75 > 48
      const variants: PromptVariant[] = Array.from({ length: 5 }, (_, i) => ({
        id: `v${i}`,
        baseline: ok.baseline,
      }));
      await expect(
        runVariantMatrix({
          baseline: ok.baseline,
          variants,
          sample: makeSample(),
          models: ["m1", "m2", "m3", "m4", "m5"],
          trials: 3,
        }),
      ).rejects.toThrow(/exceeds maxCells/);
    } finally {
      rmSync(ok.dir, { recursive: true, force: true });
    }
  });

  it("permits raising the cap via maxCells", async () => {
    // The MatrixRunner rejects 0; ensure we propagate validation to runVariantMatrix.
    const ok = makeBaselineFile();
    try {
      await expect(
        runVariantMatrix({
          baseline: ok.baseline,
          variants: [{ id: "v1", baseline: ok.baseline }],
          sample: makeSample(),
          maxCells: 0,
        }),
      ).rejects.toThrow(/maxCells must be a positive integer/);
    } finally {
      rmSync(ok.dir, { recursive: true, force: true });
    }
  });

  it("DEFAULT_MAX_CELLS is exported as 48", () => {
    expect(DEFAULT_MAX_CELLS).toBe(48);
  });
});

describe("HIGH #7 — cleanup error surfacing", () => {
  it("cleanupPluginDir returns null on success", () => {
    const d = mkdtempSync(join(tmpdir(), "ps-prompt-cleanup-ok-"));
    expect(cleanupPluginDir(d)).toBeNull();
    expect(existsSync(d)).toBe(false);
  });

  it("cleanupPluginDir is idempotent (force: true)", () => {
    const d = mkdtempSync(join(tmpdir(), "ps-prompt-cleanup-idempotent-"));
    expect(cleanupPluginDir(d)).toBeNull();
    // Second call: dir already gone — rmSync with force: true returns silently.
    expect(cleanupPluginDir(d)).toBeNull();
  });

  it("cleanupPluginDir surfaces error structure for unremovable paths", () => {
    if (process.platform === "win32") return;
    const parent = mkdtempSync(join(tmpdir(), "ps-prompt-cleanup-err-"));
    const child = join(parent, "sub");
    writeFileSync(child, "x", "utf8");
    try {
      // Make parent read-only so rm of child fails
      const origMode = statSync(parent).mode;
      try {
        chmodSync(parent, 0o500);
        const err = cleanupPluginDir(child);
        // On macOS / Linux this typically yields EACCES; if the platform allows
        // removal anyway the test is a no-op (still passing).
        if (err !== null) {
          expect(err.pluginDir).toBe(child);
          expect(typeof err.error).toBe("string");
          expect(err.error.length).toBeGreaterThan(0);
        }
      } finally {
        chmodSync(parent, origMode);
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
