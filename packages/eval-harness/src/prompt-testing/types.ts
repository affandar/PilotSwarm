/**
 * Public types for the prompt-testing module.
 *
 * See docs/superpowers/specs/2026-05-02-prompt-testing-design.md.
 */

import type { ObservedToolCall } from "../types.js";

/** Source of a baseline prompt under test. */
export type PromptSource =
  | { kind: "file"; path: string }
  | { kind: "inline"; agentName: string; prompt: string };

export interface PromptUnderTest {
  source: PromptSource;
  /** Human-readable label for reports. */
  label: string;
}

/** Mutator identifier. */
export type MutatorKind = "paraphrase" | "minimize" | "reorder" | "remove-section";

export interface MutationSpec {
  mutator: MutatorKind;
  config: unknown;
}

export interface PromptOverride {
  body?: string;
  frontmatter?: Record<string, unknown>;
}

export interface PromptVariant {
  /** Unique identifier across a matrix run. */
  id: string;
  baseline: PromptUnderTest;
  /** Programmatic mutation (deterministic except `paraphrase`). */
  mutation?: MutationSpec;
  /** Hand-authored override applied AFTER mutation (if any). */
  override?: PromptOverride;
  /**
   * Optional paraphrased user prompt. Carried as a first-class field on
   * `PromptVariant` so callers (notably `runRobustnessSuite`) do not have
   * to smuggle metadata via type casts. Has no effect on the rendered
   * agent prompt — it is reported only.
   */
  paraphrase?: string;
}

export interface PromptTestResult {
  variantId: string;
  model?: string;
  trial: number;
  /** Sample id this cell ran (persisted so reports / regression goldens can match). */
  sampleId?: string;
  /** 0..1 — fraction of expected tool calls actually observed. */
  toolCallAccuracy: number;
  /** 0..1 — graded instruction-following score. */
  instructionFollowing: number;
  /** Optional LLM-judge response quality (0..1). */
  responseQuality?: number;
  /** Optional injection-resistance score (0..1) when applicable. */
  injectionResistance?: number;
  latencyMs: number;
  observedToolCalls: ObservedToolCall[];
  finalResponse: string;
  /** True when this cell was an infra error (not a quality signal). */
  errored?: boolean;
  errorMessage?: string;
}

export interface PerVariantSummary {
  passRate: number;
  meanLatency: number;
  toolCallAccuracy: number;
}

export interface PerModelSummary {
  passRate: number;
  meanLatency: number;
}

export interface PromptTestMatrixResult {
  baseline: PromptUnderTest;
  variants: PromptVariant[];
  models: string[];
  cells: PromptTestResult[];
  summary: {
    perVariant: Record<string, PerVariantSummary>;
    perModel: Record<string, PerModelSummary>;
    /** variant × model pass rate. */
    crossCells: Record<string, Record<string, number>>;
  };
  /**
   * Plugin-dir cleanup failures encountered after the run completed.
   * Surfaced (rather than swallowed) so operators can investigate
   * permission / stale-handle issues that would otherwise leak temp dirs.
   * Absent when all cleanups succeeded.
   */
  cleanupErrors?: Array<{ pluginDir: string; error: string }>;
}

/** Parsed `.agent.md` file. */
export interface ParsedAgentMd {
  frontmatter: Record<string, unknown>;
  /** Markdown body after frontmatter. */
  body: string;
  /**
   * Raw frontmatter text as read from the source file (between the two
   * `---` fences, no fences, no trailing newline). Preserved so we can
   * round-trip frontmatter that uses YAML shapes our minimal parser does
   * not support (nested mappings, comments, anchors, multi-line strings).
   * Only `null` when the source had no frontmatter at all.
   */
  rawFrontmatter: string | null;
}
