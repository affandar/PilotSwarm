import type { EvalToolCall, ObservedToolCall, Score } from "../types.js";

export type OrderingMode = "strict" | "subsequence" | "exactSequence" | "unordered";

/**
 * F28: ensure that a non-passing ordering result never reports `value: 1`.
 * The arithmetic in some modes (notably `exactSequence` when the observed
 * sequence is a strict superset of the expected sequence) can compute
 * `pairsMatched / expectedNames.length === 1` even though `pass` is false
 * because of a length mismatch. Downstream consumers treat `value` as a
 * monotonic correctness signal, so a failing run must report something
 * strictly less than 1. We clamp to `1 - 1e-9` rather than e.g. `0` so the
 * relative information about how close the run was is preserved.
 */
function clampForFailure(value: number, pass: boolean): number {
  if (pass) return value;
  return Math.min(value, 1 - 1e-9);
}

export function gradeOrdering(
  observed: ObservedToolCall[],
  expected: EvalToolCall[],
  mode: OrderingMode,
): Score {
  const effectiveMode = mode === "strict" ? "subsequence" : mode;
  if (expected.length === 0) {
    return {
      name: "tool-ordering",
      value: 1,
      pass: true,
      reason: "no expected ordering to enforce",
    };
  }

  const expectedSorted = [...expected];
  const allHaveOrder = expected.every((e) => typeof e.order === "number");
  if (allHaveOrder) {
    expectedSorted.sort((a, b) => (a.order as number) - (b.order as number));
  }
  const observedSorted = [...observed].sort((a, b) => a.order - b.order);

  if (effectiveMode === "unordered") {
    const remaining: string[] = observedSorted.map((o) => o.name);
    let matched = 0;
    for (const e of expectedSorted) {
      const idx = remaining.indexOf(e.name);
      if (idx !== -1) {
        matched++;
        remaining.splice(idx, 1);
      }
    }
    const value = matched / expectedSorted.length;
    const pass = matched === expectedSorted.length;
    return {
      name: "tool-ordering",
      value: clampForFailure(value, pass),
      pass,
      reason:
        pass
          ? "all expected tools present (unordered)"
          : `only ${matched}/${expectedSorted.length} expected tools present`,
      actual: observedSorted.map((o) => o.name),
      expected: expectedSorted.map((e) => e.name),
    };
  }

  if (effectiveMode === "exactSequence") {
    const actualNames = observedSorted.map((o) => o.name);
    const expectedNames = expectedSorted.map((e) => e.name);
    let pairsMatched = 0;
    const max = Math.min(actualNames.length, expectedNames.length);
    while (pairsMatched < max && actualNames[pairsMatched] === expectedNames[pairsMatched]) {
      pairsMatched++;
    }
    const pass =
      actualNames.length === expectedNames.length &&
      pairsMatched === expectedNames.length;
    const rawValue =
      expectedNames.length === 0 ? 1 : pairsMatched / expectedNames.length;
    return {
      name: "tool-ordering",
      value: clampForFailure(rawValue, pass),
      pass,
      reason: pass
        ? "observed tools exactly matched expected sequence"
        : `exact sequence mismatch: expected=${JSON.stringify(expectedNames)} actual=${JSON.stringify(actualNames)}`,
      actual: actualNames,
      expected: expectedNames,
    };
  }

  let i = 0;
  let pairsMatched = 0;
  for (const o of observedSorted) {
    if (i >= expectedSorted.length) break;
    if (o.name === expectedSorted[i].name) {
      pairsMatched++;
      i++;
    }
  }
  const value = pairsMatched / expectedSorted.length;
  const pass = pairsMatched === expectedSorted.length;
  return {
    name: "tool-ordering",
    value: clampForFailure(value, pass),
    pass,
    reason: pass
      ? "expected tools appeared as a subsequence in the correct order"
      : `subsequence match failed: ${pairsMatched}/${expectedSorted.length} expected tools in order`,
    actual: observedSorted.map((o) => o.name),
    expected: expectedSorted.map((e) => e.name),
  };
}
