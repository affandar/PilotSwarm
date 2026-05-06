import { describe, it, expect } from "vitest";
import { reorderMutator, seededShuffle } from "../../src/prompt-testing/mutators/reorder.js";

const SAMPLE = `Preamble text.

## Alpha

Alpha body.

## Beta

Beta body.

## Gamma

Gamma body.

## Delta

Delta body.
`;

describe("reorder mutator", () => {
  it("is deterministic for the same seed", async () => {
    const a = await reorderMutator.apply({ body: SAMPLE, config: { seed: 42 } });
    const b = await reorderMutator.apply({ body: SAMPLE, config: { seed: 42 } });
    expect(a).toBe(b);
  });

  it("produces different orderings for different seeds (probabilistic but deterministic)", async () => {
    const a = await reorderMutator.apply({ body: SAMPLE, config: { seed: 1 } });
    const b = await reorderMutator.apply({ body: SAMPLE, config: { seed: 7 } });
    // With 4 sections and these specific seeds, orderings should differ.
    expect(a).not.toBe(b);
  });

  it("preserves preamble in place", async () => {
    const out = await reorderMutator.apply({ body: SAMPLE, config: { seed: 5 } });
    expect(out.startsWith("Preamble text.")).toBe(true);
  });

  it("preserves all section bodies (only reorders, no loss)", async () => {
    const out = await reorderMutator.apply({ body: SAMPLE, config: { seed: 99 } });
    for (const heading of ["## Alpha", "## Beta", "## Gamma", "## Delta"]) {
      expect(out).toContain(heading);
    }
  });

  it("returns body unchanged when fewer than two sections", async () => {
    const tiny = "Just preamble.\n\n## Only\n\nOnly body.\n";
    const out = await reorderMutator.apply({ body: tiny, config: { seed: 1 } });
    expect(out).toBe(tiny);
  });

  it("rejects invalid config", async () => {
    await expect(reorderMutator.apply({ body: SAMPLE, config: { seed: "x" } })).rejects.toThrow();
    await expect(reorderMutator.apply({ body: SAMPLE, config: null })).rejects.toThrow();
  });

  it("rejects fractional seeds (was silently floored)", async () => {
    await expect(
      reorderMutator.apply({ body: SAMPLE, config: { seed: 1.5 } }),
    ).rejects.toThrow(/integer/);
  });

  it("rejects negative seeds", async () => {
    await expect(
      reorderMutator.apply({ body: SAMPLE, config: { seed: -1 } }),
    ).rejects.toThrow(/>= 0/);
  });

  it("rejects unsafe-integer seeds", async () => {
    await expect(
      reorderMutator.apply({ body: SAMPLE, config: { seed: 2 ** 60 } }),
    ).rejects.toThrow(/safe integer/);
  });

  it("seededShuffle is a permutation", () => {
    const items = [1, 2, 3, 4, 5];
    const shuffled = seededShuffle(items, 123);
    expect(shuffled.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(shuffled.length).toBe(items.length);
  });
});
