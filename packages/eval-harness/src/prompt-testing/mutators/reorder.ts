/**
 * Reorder mutator: shuffles `## section` order using a seeded RNG.
 * Preamble (content before the first `##` heading) is preserved in place.
 *
 * Deterministic given the same seed.
 *
 * Config: { seed: number }   — must be a non-negative safe integer.
 *
 * Note: only top-level `##` sections are reordered. `###` subsections move
 * with their parent `##` block (because `splitSections()` only treats `##`
 * as a section boundary). This matches the documented `minimize` /
 * `remove-section` behavior.
 */

import type { Mutator, MutatorContext } from "./mutator.js";
import { assertObjectConfig } from "./mutator.js";
import { splitSections, joinSections } from "./minimize.js";

export interface ReorderConfig {
  seed: number;
}

/** mulberry32 — small deterministic PRNG suitable for shuffling. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = items.slice();
  const rng = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

export const reorderMutator: Mutator = {
  kind: "reorder",
  async apply(ctx: MutatorContext): Promise<string> {
    const config = assertObjectConfig(ctx.config, "reorder");
    const seed = config.seed;
    if (typeof seed !== "number" || !Number.isFinite(seed)) {
      throw new Error("reorder: config.seed must be a finite number");
    }
    if (!Number.isInteger(seed)) {
      throw new Error(
        `reorder: config.seed must be an integer (got ${seed}); fractional seeds previously floored silently which made distinct configs collide`,
      );
    }
    if (seed < 0) {
      throw new Error(`reorder: config.seed must be >= 0 (got ${seed})`);
    }
    if (!Number.isSafeInteger(seed)) {
      throw new Error(`reorder: config.seed must be a safe integer (got ${seed})`);
    }

    const sections = splitSections(ctx.body);
    if (sections.length <= 2) return ctx.body; // preamble + (0 or 1) section

    const preamble = sections[0]!;
    const headed = sections.slice(1);
    const shuffled = seededShuffle(headed, seed);
    return joinSections([preamble, ...shuffled]);
  },
};

export default reorderMutator;
