/**
 * Remove-section mutator: drops `## sections` whose heading text matches one
 * of the configured headings (case-insensitive, trimmed). The preamble and
 * non-matching sections are preserved verbatim.
 *
 * Deterministic.
 *
 * Config: { headings: string[] }
 *
 * Note: only top-level `##` headings are recognized. To remove a `###`
 * subsection independently you must remove its parent `##`. This matches
 * the documented `minimize` / `reorder` behavior.
 */

import type { Mutator, MutatorContext } from "./mutator.js";
import { assertObjectConfig } from "./mutator.js";
import { splitSections, joinSections } from "./minimize.js";

export interface RemoveSectionConfig {
  headings: string[];
}

function normalizeHeading(line: string): string {
  return line.replace(/^##\s+/u, "").trim().toLowerCase();
}

export const removeSectionMutator: Mutator = {
  kind: "remove-section",
  async apply(ctx: MutatorContext): Promise<string> {
    const config = assertObjectConfig(ctx.config, "remove-section");
    const headings = config.headings;
    if (!Array.isArray(headings) || headings.some((h) => typeof h !== "string")) {
      throw new Error("remove-section: config.headings must be a string[]");
    }
    if (headings.length === 0) return ctx.body;

    const targets = new Set(headings.map((h) => h.trim().toLowerCase()));
    const sections = splitSections(ctx.body);
    const filtered = sections.filter((s) => {
      if (s.heading.length === 0) return true; // keep preamble
      return !targets.has(normalizeHeading(s.heading));
    });
    return joinSections(filtered);
  },
};

export default removeSectionMutator;
