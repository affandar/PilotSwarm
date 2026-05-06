import type { EvalToolCall, ObservedToolCall, Score } from "../types.js";

export function gradeOrdering(
  observed: ObservedToolCall[],
  expected: EvalToolCall[],
  mode: "strict" | "unordered",
): Score {
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

  if (mode === "unordered") {
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
    return {
      name: "tool-ordering",
      value,
      pass: matched === expectedSorted.length,
      reason:
        matched === expectedSorted.length
          ? "all expected tools present (unordered)"
          : `only ${matched}/${expectedSorted.length} expected tools present`,
      actual: observedSorted.map((o) => o.name),
      expected: expectedSorted.map((e) => e.name),
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
    value,
    pass,
    reason: pass
      ? "expected tools appeared in the correct order"
      : `subsequence match failed: ${pairsMatched}/${expectedSorted.length} expected tools in order`,
    actual: observedSorted.map((o) => o.name),
    expected: expectedSorted.map((e) => e.name),
  };
}
