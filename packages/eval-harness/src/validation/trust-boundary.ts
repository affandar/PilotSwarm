/**
 * Trust-boundary parser.
 *
 * `parseAtBoundary` is the SINGLE choke point through which every public
 * runner / gate boundary must validate inbound data. It does three things:
 *
 *   1. Run the Zod schema in `safeParse` mode, returning a structured
 *      `{ok:false, error}` on failure (never a thrown ZodError).
 *   2. Deep-walk the parsed data and reject `Symbol`, `Function`, and
 *      `BigInt` at any path. Zod tolerates these in `z.unknown()` /
 *      `z.record()` slots, but they break `structuredClone` (which throws
 *      on Symbol/Function/BigInt for our use case) AND they are common
 *      vectors for prototype-pollution / adversarial inputs.
 *   3. Take a deep `structuredClone` AND `Object.freeze` the root, so any
 *      downstream getter mutation on the original cannot affect the
 *      validated snapshot. (This is the iter17 CIGate TOCTOU defense
 *      generalized.)
 *
 * Use `parseAtBoundaryOrInfraError` for paths where the boundary failure
 * must surface as a quality-bypassing infraError Score (e.g. a corrupt
 * driver-observed result inside `EvalRunner.runCase`).
 */
import { z } from "zod";
import type { Score } from "../types.js";

export interface ParseSuccess<T> {
  readonly ok: true;
  readonly data: T;
}

export interface ParseFailure {
  readonly ok: false;
  readonly error: string;
  readonly issues: ReadonlyArray<{ path: string; message: string }>;
}

export type ParseResult<T> = ParseSuccess<T> | ParseFailure;

const FORBIDDEN_TYPES = new Set(["symbol", "function", "bigint"]);

function rejectForbiddenTypes(value: unknown, path: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  const t = typeof value;
  if (FORBIDDEN_TYPES.has(t)) {
    return `forbidden ${t} value at "${path || "<root>"}"`;
  }
  if (t !== "object") return undefined;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const reason = rejectForbiddenTypes(value[i], `${path}[${i}]`);
      if (reason) return reason;
    }
    return undefined;
  }
  // Reject Symbol-keyed properties at this object level.
  for (const sym of Object.getOwnPropertySymbols(value as object)) {
    return `forbidden symbol-keyed property at "${path || "<root>"}.${String(sym)}"`;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const reason = rejectForbiddenTypes(v, path ? `${path}.${k}` : k);
    if (reason) return reason;
  }
  return undefined;
}

function formatIssues(err: z.ZodError): {
  message: string;
  issues: ReadonlyArray<{ path: string; message: string }>;
} {
  const issues = err.issues.map((i) => ({
    path: i.path.join(".") || "<root>",
    message: i.message,
  }));
  const message = issues.map((i) => `${i.path}: ${i.message}`).join("; ");
  return { message, issues };
}

export interface ParseOptions {
  /**
   * Label included in the failure message — typically the boundary site
   * (e.g. "EvalRunner.runTask:result", "CIGate.evaluate:input").
   */
  context?: string;
  /**
   * Skip the Symbol/Function/BigInt deep-walk. Default `false`. Only set
   * `true` when the schema itself uses primitive-only types and you're
   * certain the deep-walk is unneeded — almost never.
   */
  skipForbiddenWalk?: boolean;
  /**
   * Skip the structuredClone+freeze step. Default `false`. Only set `true`
   * when the boundary explicitly cares about identity (e.g. middleware
   * that re-emits the same object); virtually never.
   */
  skipFreeze?: boolean;
}

/**
 * Parse `value` against `schema`, returning a frozen, deep-cloned, type-safe
 * snapshot on success. On failure, returns `{ok:false, error}` instead of
 * throwing.
 */
export function parseAtBoundary<T>(
  schema: z.ZodType<T>,
  value: unknown,
  opts: ParseOptions = {},
): ParseResult<T> {
  const ctx = opts.context ? `[${opts.context}] ` : "";

  // Step 0: pre-Zod shallow check for Symbol-keyed properties on the root.
  // Zod object schemas strip symbol-keyed properties silently during parse,
  // so a post-parse walk would miss them. Enumerating Symbol keys via
  // Object.getOwnPropertySymbols does NOT invoke getters, so this is
  // TOCTOU-neutral. Deeper symbol-keyed properties inside z.unknown() slots
  // are still caught by the post-parse walk on parsed.data.
  if (
    !opts.skipForbiddenWalk &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const rootSymbols = Object.getOwnPropertySymbols(value as object);
    if (rootSymbols.length > 0) {
      const reason = `forbidden symbol-keyed property at "<root>.${String(rootSymbols[0])}"`;
      return {
        ok: false,
        error: `${ctx}${reason}`,
        issues: [{ path: "<root>", message: reason }],
      };
    }
  }

  // Step 1: Zod safeParse. Run FIRST so we don't add an extra getter-read
  // pass before parse — that would let a TOCTOU getter return a different
  // value to Zod than to the forbidden-walk. For typed fields, Zod returns
  // a fresh object built from one read of each input field; for `z.unknown()`
  // slots the reference passes through unchanged.
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const { message, issues } = formatIssues(parsed.error);
    return {
      ok: false,
      error: `${ctx}schema validation failed: ${message}`,
      issues,
    };
  }

  // Step 2: walk `parsed.data` for forbidden Symbol / Function / BigInt.
  // Catches anything that survived inside `z.unknown()` / `z.record()` slots.
  // We walk parsed.data (not the original value) to avoid an extra read of
  // input getters, which preserves the iter16 TOCTOU snapshot guarantee:
  // Zod sees the same value the walk sees.
  if (!opts.skipForbiddenWalk) {
    const reason = rejectForbiddenTypes(parsed.data, "");
    if (reason) {
      return {
        ok: false,
        error: `${ctx}${reason}`,
        issues: [{ path: "<root>", message: reason }],
      };
    }
  }

  if (opts.skipFreeze) {
    return { ok: true, data: parsed.data };
  }

  // Step 3: structuredClone + Object.freeze. The clone severs identity with
  // the input so downstream getters cannot mutate per-call. The freeze
  // makes it explicit that downstream code must not mutate the snapshot.
  let snapshot: T;
  try {
    snapshot = structuredClone(parsed.data) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `${ctx}structuredClone failed: ${msg}`,
      issues: [{ path: "<root>", message: msg }],
    };
  }
  Object.freeze(snapshot);
  return { ok: true, data: snapshot };
}

/**
 * Variant for the driver→runner boundary. On parse failure, returns a
 * Score with `infraError: true` so the runner records it as an infra
 * outage (excluded from passRate) rather than a quality fail.
 */
export function parseAtBoundaryOrInfraError<T>(
  schema: z.ZodType<T>,
  value: unknown,
  opts: ParseOptions & { scoreName?: string } = {},
): ParseResult<T> | { ok: false; infraScore: Score } {
  const result = parseAtBoundary(schema, value, opts);
  if (result.ok) return result;
  const scoreName = opts.scoreName ?? "trust-boundary";
  const infraScore: Score = {
    name: scoreName,
    value: 0,
    pass: false,
    reason: result.error,
    infraError: true,
  };
  return { ok: false, infraScore };
}
