/**
 * Mutator registry — lookup table from `MutatorKind` to implementation.
 */

import type { Mutator } from "./mutator.js";
import { minimizeMutator } from "./minimize.js";
import { reorderMutator } from "./reorder.js";
import { removeSectionMutator } from "./remove-section.js";
import { paraphraseMutator } from "./paraphrase.js";
import type { MutatorKind } from "../types.js";

export const MUTATORS: Record<MutatorKind, Mutator> = {
  minimize: minimizeMutator,
  reorder: reorderMutator,
  "remove-section": removeSectionMutator,
  paraphrase: paraphraseMutator,
};

export function resolveMutator(kind: MutatorKind): Mutator {
  const mutator = MUTATORS[kind];
  if (!mutator) {
    throw new Error(`unknown mutator: ${kind}`);
  }
  return mutator;
}
