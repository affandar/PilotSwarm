export type MatchMode = "exact" | "subset" | "fuzzy" | "setEquals";

export interface MatchResult {
  pass: boolean;
  score: number;
  diff: string[];
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

function subsetValueMatch(actual: unknown, expected: unknown): boolean {
  if (typeof expected === "string" && typeof actual === "string") {
    return actual.trim().toLowerCase() === expected.trim().toLowerCase();
  }
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    const exp = expected as Record<string, unknown>;
    const act = actual as Record<string, unknown>;
    for (const k of Object.keys(exp)) {
      if (!(k in act)) return false;
      if (!subsetValueMatch(act[k], exp[k])) return false;
    }
    return true;
  }
  return deepEqual(actual, expected);
}

function fuzzyValueMatch(actual: unknown, expected: unknown): boolean {
  if (typeof expected === "string") {
    const a = typeof actual === "string" ? actual : typeof actual === "number" ? String(actual) : null;
    if (a === null) return false;
    const na = normalizeString(a);
    const ne = normalizeString(expected);
    if (na === ne) return true;
    const dist = levenshtein(na, ne);
    const tolerance = Math.max(1, Math.ceil(ne.length * 0.2));
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
    return Math.abs(a - expected) <= 0.01;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    if (expected.length !== actual.length) return false;
    const used = new Set<number>();
    for (const ev of expected) {
      let found = -1;
      for (let i = 0; i < actual.length; i++) {
        if (used.has(i)) continue;
        if (fuzzyValueMatch(actual[i], ev)) {
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
      if (!fuzzyValueMatch(act[k], exp[k])) return false;
    }
    return true;
  }
  return deepEqual(actual, expected);
}

export function matchArgs(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, unknown> | undefined,
  mode: MatchMode = "subset",
): MatchResult {
  const a = actual ?? {};
  const e = expected ?? {};
  const diff: string[] = [];

  if (mode === "exact") {
    const ok = JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(e));
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
    const ok = mode === "fuzzy" ? fuzzyValueMatch(a[k], e[k]) : subsetValueMatch(a[k], e[k]);
    if (ok) {
      matched++;
    } else {
      diff.push(`value mismatch for "${k}": expected=${JSON.stringify(e[k])} actual=${JSON.stringify(a[k])}`);
    }
  }
  const score = matched / keys.length;
  return { pass: matched === keys.length, score, diff };
}
