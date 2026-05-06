/**
 * Centralized reporter formatters.
 *
 * iter18 consolidates p-value / rate / count / provenance formatting into a
 * single module. Every reporter (markdown, pr-comment, console,
 * console-aggregate, jsonl) MUST route number → string conversion through
 * here so a fixer that breaks finite-formatting in one place breaks them
 * uniformly (and is caught by the Family 6 matrix).
 *
 * Contracts:
 *   - `formatPValue` and `formatRate` collapse `undefined` / `NaN` /
 *     `±Infinity` to a single em-dash glyph (`"—"`). Never `"NaN"`,
 *     never `"Infinity"`.
 *   - `formatCount` collapses non-finite / non-integer to `"—"` and
 *     formats valid counts with no trailing decimals.
 *   - `formatProvenance` builds the `- **Label:** value` markdown
 *     bullet line, omitting the line when `value` is `undefined`. This
 *     guarantees the Family 6 anchored-regex test
 *     (`/^- \*\*Model:\*\* m$/m`) keeps passing.
 */

const EM_DASH = "—";

/**
 * Canonical missing-value glyph. Reporters MUST use this; do not write
 * `"-"` / `"--"` / `"N/A"` / blank instead.
 */
export const MISSING_VALUE_GLYPH: "—" = EM_DASH;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Format a p-value as a 4-decimal-fixed string. Returns `"—"` for
 * `undefined`, `NaN`, `±Infinity`, or any value outside `[0, 1]`.
 */
export function formatPValue(v: unknown): string {
  if (!isFiniteNumber(v)) return EM_DASH;
  if (v < 0 || v > 1) return EM_DASH;
  return v.toFixed(4);
}

/**
 * Format a rate (`[0, 1]`) as a percentage with `digits` decimal places.
 * Returns `"—"` for non-finite or out-of-range. Default 1 decimal.
 */
export function formatRate(v: unknown, digits: number = 1): string {
  if (!isFiniteNumber(v)) return EM_DASH;
  if (v < 0 || v > 1) return EM_DASH;
  return `${(v * 100).toFixed(digits)}%`;
}

/**
 * Format an integer count. Returns `"—"` for non-finite / non-integer /
 * negative. Reporters use this for trial counts, error counts, regression
 * counts, etc.
 */
export function formatCount(v: unknown): string {
  if (!isFiniteNumber(v)) return EM_DASH;
  if (!Number.isInteger(v) || v < 0) return EM_DASH;
  return String(v);
}

/**
 * Format a provenance bullet line: `- **Label:** value`. Returns `null`
 * when the value is `undefined` so the reporter can omit the line
 * entirely (matching the Family 6 anchored-regex contract).
 *
 * The value is rendered as-is — escaping (e.g. zero-width-strip) is the
 * caller's responsibility (see `escapeMarkdownCell` in `util.ts`).
 */
export function formatProvenance(
  label: string,
  value: string | undefined,
): string | null {
  if (value === undefined) return null;
  return `- **${label}:** ${value}`;
}
