import type { EvalExpected, Score } from "../types.js";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary aware containment check. For multi-character needles we wrap
 * the match in `\b...\b` so that short tokens like "hi" don't silently match
 * inside larger words like "this" or "history". For single-character needles
 * we fall back to plain substring containment because `\b` is meaningless
 * around non-word characters.
 */
function containsNeedle(haystackLower: string, needle: string): boolean {
  if (!needle) return true;
  const n = needle.toLowerCase();
  if (n.length < 2) return haystackLower.includes(n);
  // If the needle starts or ends with a non-word character, \b would not align
  // with it — fall back to plain substring match in that case.
  const startsWithWord = /\w/.test(n[0]);
  const endsWithWord = /\w/.test(n[n.length - 1]);
  if (!startsWithWord || !endsWithWord) {
    return haystackLower.includes(n);
  }
  const re = new RegExp(`\\b${escapeRegExp(n)}\\b`, "i");
  return re.test(haystackLower);
}

export function gradeResponse(
  finalResponse: string,
  expected: EvalExpected["response"],
): Score | undefined {
  if (!expected) return undefined;
  const { containsAny, containsAll } = expected;
  if (!containsAny && !containsAll) return undefined;

  const hay = finalResponse.toLowerCase();
  const checks: Array<{ type: string; needle: string; hit: boolean }> = [];

  if (containsAll) {
    for (const s of containsAll) {
      checks.push({ type: "all", needle: s, hit: containsNeedle(hay, s) });
    }
  }

  let anyHit = true;
  if (containsAny && containsAny.length > 0) {
    anyHit = containsAny.some((s) => containsNeedle(hay, s));
    checks.push({ type: "any", needle: containsAny.join("|"), hit: anyHit });
  }

  const total = checks.length;
  const hits = checks.filter((c) => c.hit).length;
  const allCheck = containsAll ? checks.filter((c) => c.type === "all").every((c) => c.hit) : true;
  const pass = allCheck && anyHit;
  const value = total === 0 ? 1 : hits / total;

  return {
    name: "response-contains",
    value,
    pass,
    reason: pass
      ? "response satisfied all containment checks"
      : `response failed ${total - hits}/${total} containment check(s)`,
    actual: finalResponse,
    expected,
  };
}
