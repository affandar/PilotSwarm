import { describe, it, expect } from "vitest";
import { minimizeMutator, splitSentences, splitSections, joinSections } from "../../src/prompt-testing/mutators/minimize.js";

const SAMPLE = `Preamble text. Another sentence.

## Rules

1. First rule.
2. Second rule.
3. Third rule.
4. Fourth rule.

## Notes

This is a note. Another note here. Final note.
`;

describe("minimize mutator", () => {
  it("preserves body when percent=0", async () => {
    const out = await minimizeMutator.apply({ body: SAMPLE, config: { percent: 0 } });
    expect(out).toBe(SAMPLE);
  });

  it("drops list items deterministically at 50%", async () => {
    const out = await minimizeMutator.apply({ body: SAMPLE, config: { percent: 50 } });
    // 4 list items, drop 50% → keep 2 (ceil)
    expect(out).toContain("1. First rule.");
    expect(out).toContain("2. Second rule.");
    expect(out).not.toContain("4. Fourth rule.");
  });

  it("drops everything when percent=100", async () => {
    const out = await minimizeMutator.apply({ body: SAMPLE, config: { percent: 100 } });
    expect(out).not.toContain("First rule");
    expect(out).not.toContain("Final note");
  });

  it("is idempotent (deterministic) across runs", async () => {
    const a = await minimizeMutator.apply({ body: SAMPLE, config: { percent: 30 } });
    const b = await minimizeMutator.apply({ body: SAMPLE, config: { percent: 30 } });
    expect(a).toBe(b);
  });

  it("rejects invalid config", async () => {
    await expect(minimizeMutator.apply({ body: SAMPLE, config: null })).rejects.toThrow();
    await expect(
      minimizeMutator.apply({ body: SAMPLE, config: { percent: -1 } }),
    ).rejects.toThrow();
    await expect(
      minimizeMutator.apply({ body: SAMPLE, config: { percent: 101 } }),
    ).rejects.toThrow();
    await expect(
      minimizeMutator.apply({ body: SAMPLE, config: { percent: "fifty" } }),
    ).rejects.toThrow();
  });

  it("section split round-trips", () => {
    const sections = splitSections(SAMPLE);
    const joined = joinSections(sections);
    expect(joined.trim()).toBe(SAMPLE.trim());
  });

  it("splitSentences handles empty input", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("One. Two. Three.").length).toBeGreaterThanOrEqual(2);
  });
});
