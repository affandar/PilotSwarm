export type MatchMode = "exact" | "subset" | "fuzzy" | "setEquals";

export interface MatchResult {
  pass: boolean;
  score: number;
  diff: string[];
}

export interface MatchOptions {
  /**
   * Legacy subset semantics: trim, collapse whitespace, and lowercase strings
   * before comparing. Default subset mode is exact for string values because
   * paths, URLs, IDs, regexes, and branch names are often case-sensitive.
   */
  subsetCaseInsensitive?: boolean;
  /** Absolute numeric tolerance for fuzzy numeric comparison. Defaults to 0. */
  numericTolerance?: number;
  /** Max Levenshtein distance divided by expected length in fuzzy mode. Defaults to 0.2. */
  fuzzyStringMaxRelativeDistance?: number;
}

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      out[k] = sortKeys(src[k]);
    }
    return out;
  }
  return value;
}

function normalizeString(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = a.length;
  const n = b.length;
  const prev = new Array<number>(n + 1);
  const cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!(k in bo)) return false;
      if (!deepEqual(ao[k], bo[k])) return false;
    }
    return true;
  }
  return false;
}

/**
 * F20: Strict structural equality for exact-mode argument matching.
 *
 * Differs from {@link deepEqual} in three ways that matter for argument
 * comparisons:
 *   - Treats own-key presence as significant: `{a: undefined}` !== `{}`.
 *   - Uses `Object.is` semantics on leaves so that `NaN === NaN` is true,
 *     `+0 !== -0`, and `Infinity !== -Infinity`.
 *   - Recurses through arrays and plain objects index-by-index / key-by-key
 *     including keys whose value is `undefined`.
 *
 * Non-exact modes (subset / fuzzy / setEquals) are intentionally left on the
 * looser `deepEqual` semantics.
 */
function deepEqualStrict(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualStrict(a[i], b[i])) return false;
    }
    return true;
  }
  if (
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object"
  ) {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    // Both directions of key presence must match.
    for (const k of ak) {
      if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
      if (!deepEqualStrict(ao[k], bo[k])) return false;
    }
    return true;
  }
  return Object.is(a, b);
}

function subsetValueMatch(actual: unknown, expected: unknown, options: MatchOptions): boolean {
  if (typeof expected === "string" && typeof actual === "string") {
    return options.subsetCaseInsensitive
      ? normalizeString(actual) === normalizeString(expected)
      : actual === expected;
  }
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    const exp = expected as Record<string, unknown>;
    const act = actual as Record<string, unknown>;
    for (const k of Object.keys(exp)) {
      if (!(k in act)) return false;
      if (!subsetValueMatch(act[k], exp[k], options)) return false;
    }
    return true;
  }
  return deepEqual(actual, expected);
}

function fuzzyValueMatch(actual: unknown, expected: unknown, options: MatchOptions): boolean {
  if (typeof expected === "string") {
    const a = typeof actual === "string" ? actual : typeof actual === "number" ? String(actual) : null;
    if (a === null) return false;
    const na = normalizeString(a);
    const ne = normalizeString(expected);
    if (na === ne) return true;
    const dist = levenshtein(na, ne);
    const ratio = options.fuzzyStringMaxRelativeDistance ?? 0.2;
    const tolerance = Math.ceil(ne.length * ratio);
    return dist <= tolerance;
  }
  if (typeof expected === "number") {
    const a =
      typeof actual === "number"
        ? actual
        : typeof actual === "string" && actual.trim() !== "" && !Number.isNaN(Number(actual))
          ? Number(actual)
          : null;
    if (a === null) return false;
    return Math.abs(a - expected) <= (options.numericTolerance ?? 0);
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    if (expected.length !== actual.length) return false;
    const used = new Set<number>();
    for (const ev of expected) {
      let found = -1;
      for (let i = 0; i < actual.length; i++) {
        if (used.has(i)) continue;
        if (fuzzyValueMatch(actual[i], ev, options)) {
          found = i;
          break;
        }
      }
      if (found === -1) return false;
      used.add(found);
    }
    return true;
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    const exp = expected as Record<string, unknown>;
    const act = actual as Record<string, unknown>;
    for (const k of Object.keys(exp)) {
      if (!(k in act)) return false;
      if (!fuzzyValueMatch(act[k], exp[k], options)) return false;
    }
    return true;
  }
  return deepEqual(actual, expected);
}

export function matchArgs(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, unknown> | undefined,
  mode: MatchMode = "subset",
  options: MatchOptions = {},
): MatchResult {
  const a = actual ?? {};
  const e = expected ?? {};
  const diff: string[] = [];
  if (!["exact", "subset", "fuzzy", "setEquals"].includes(mode)) {
    throw new Error(`unknown match mode: ${String(mode)}`);
  }

  if (mode === "exact") {
    const ok = deepEqualStrict(a, e);
    if (!ok) diff.push(`exact mismatch: expected=${JSON.stringify(sortKeys(e))} actual=${JSON.stringify(sortKeys(a))}`);
    return { pass: ok, score: ok ? 1 : 0, diff };
  }

  if (mode === "setEquals") {
    const aKeys = Object.keys(a).sort();
    const eKeys = Object.keys(e).sort();
    if (aKeys.length !== eKeys.length || aKeys.some((k, i) => k !== eKeys[i])) {
      diff.push(`key sets differ: expected=[${eKeys.join(",")}] actual=[${aKeys.join(",")}]`);
      return { pass: false, score: 0, diff };
    }
    for (const k of eKeys) {
      if (!deepEqual(a[k], e[k])) {
        diff.push(`value mismatch for "${k}": expected=${JSON.stringify(e[k])} actual=${JSON.stringify(a[k])}`);
      }
    }
    const pass = diff.length === 0;
    return { pass, score: pass ? 1 : 0, diff };
  }

  const keys = Object.keys(e);
  if (keys.length === 0) {
    return { pass: true, score: 1, diff };
  }

  let matched = 0;
  for (const k of keys) {
    if (!(k in a)) {
      diff.push(`missing key "${k}"`);
      continue;
    }
    const ok = mode === "fuzzy" ? fuzzyValueMatch(a[k], e[k], options) : subsetValueMatch(a[k], e[k], options);
    if (ok) {
      matched++;
    } else {
      diff.push(`value mismatch for "${k}": expected=${JSON.stringify(e[k])} actual=${JSON.stringify(a[k])}`);
    }
  }
  const score = matched / keys.length;
  return { pass: matched === keys.length, score, diff };
}
