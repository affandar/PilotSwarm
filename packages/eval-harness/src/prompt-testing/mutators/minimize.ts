/**
 * Minimize mutator: drops the last N% of *sentences* from each `## section`.
 * Frontmatter is handled at the caller level (prompt-loader); this operates
 * on the markdown body only.
 *
 * Deterministic — no RNG, no clock.
 *
 * Config: { percent: number }   // 0..100; how much to drop from each section
 *
 * # Known caveats (documented; do NOT consider these silent bugs)
 *
 *   - Section detection is `^##\s+` only. `###` subsections are treated as
 *     body content under the closest preceding `##` and are pruned along
 *     with it. This matches the deliberate scoping of `remove-section`
 *     and `reorder`.
 *   - List-heavy sections: each `-`/`*`/`1.` line is treated as a unit;
 *     non-list, non-blank continuation lines are appended to the previous
 *     unit (so a wrapped list item stays attached to its bullet).
 *   - List-heavy output preserves AT MOST one leading blank line. Sections
 *     that originally had multiple blank-line separators between bullets
 *     are collapsed; this can produce visually-odd-but-still-valid
 *     Markdown for nested lists or mixed prose/list sections.
 *   - Pure-prose sections collapse the kept sentences into a single line.
 *     Whitespace inside sentences is preserved; line wrapping is not.
 *
 * The output is always valid Markdown for the consumers we actually feed
 * (the SDK plugin loader). Renderers that depend on multi-blank-line
 * paragraph spacing inside list-heavy sections may render the minimized
 * body differently from the original.
 */

import type { Mutator, MutatorContext } from "./mutator.js";
import { assertObjectConfig } from "./mutator.js";

export interface MinimizeConfig {
  /** Percent of sentences (per section) to drop, 0..100. */
  percent: number;
}

const SENTENCE_TERMINATORS = /(?<=[.!?])\s+(?=[A-Z0-9"`*\-(\[])/u;

export function splitSentences(text: string): string[] {
  if (text.length === 0) return [];
  return text.split(SENTENCE_TERMINATORS);
}

interface Section {
  /** Heading line (e.g. "## Critical Rules"), or empty for preamble. */
  heading: string;
  /** Body lines under the heading (excluding the heading itself). */
  bodyLines: string[];
}

export function splitSections(body: string): Section[] {
  const lines = body.split(/\r?\n/);
  const sections: Section[] = [];
  let current: Section = { heading: "", bodyLines: [] };
  for (const line of lines) {
    if (/^##\s+/u.test(line)) {
      sections.push(current);
      current = { heading: line, bodyLines: [] };
    } else {
      current.bodyLines.push(line);
    }
  }
  sections.push(current);
  return sections;
}

export function joinSections(sections: Section[]): string {
  const out: string[] = [];
  for (const s of sections) {
    if (s.heading.length > 0) out.push(s.heading);
    out.push(...s.bodyLines);
  }
  return out.join("\n");
}

function pruneSection(bodyLines: string[], dropPercent: number): string[] {
  // Treat numbered/bulleted lists as "sentences" (one per line) and prose
  // paragraphs as sentence-terminated runs. The pruning is deterministic:
  // we keep the first ceil((1-percent/100) * count) units.
  const text = bodyLines.join("\n").trim();
  if (text.length === 0) return bodyLines;

  // List-heavy sections: each non-empty top-level line is a unit.
  const isListLike = bodyLines.some((l) => /^(\s*[-*]\s+|\s*\d+\.\s+)/u.test(l));
  if (isListLike) {
    const units: string[] = [];
    const blanks: string[] = [];
    for (const line of bodyLines) {
      if (/^(\s*[-*]\s+|\s*\d+\.\s+)/u.test(line)) {
        units.push(line);
      } else if (line.trim().length === 0) {
        blanks.push(line);
      } else {
        // Continuation of previous unit; append to the last unit.
        if (units.length > 0) {
          units[units.length - 1] = `${units[units.length - 1]}\n${line}`;
        } else {
          blanks.push(line);
        }
      }
    }
    const keep = Math.max(0, Math.ceil(units.length * (1 - dropPercent / 100)));
    const kept = units.slice(0, keep);
    // Preserve up to one leading blank for readability.
    const prefix = blanks.length > 0 ? [""] : [];
    return [...prefix, ...kept];
  }

  // Prose: split sentences across the whole section and keep first N%.
  const sentences = splitSentences(text);
  const keep = Math.max(0, Math.ceil(sentences.length * (1 - dropPercent / 100)));
  const kept = sentences.slice(0, keep).join(" ");
  return kept.length > 0 ? [kept] : [""];
}

export const minimizeMutator: Mutator = {
  kind: "minimize",
  async apply(ctx: MutatorContext): Promise<string> {
    const config = assertObjectConfig(ctx.config, "minimize");
    const percent = config.percent;
    if (typeof percent !== "number" || !Number.isFinite(percent)) {
      throw new Error("minimize: config.percent must be a finite number");
    }
    if (percent < 0 || percent > 100) {
      throw new Error("minimize: config.percent must be in [0, 100]");
    }
    if (percent === 0) return ctx.body;

    const sections = splitSections(ctx.body);
    const pruned = sections.map((s) => ({
      heading: s.heading,
      bodyLines: pruneSection(s.bodyLines, percent),
    }));
    return joinSections(pruned);
  },
};

export default minimizeMutator;
