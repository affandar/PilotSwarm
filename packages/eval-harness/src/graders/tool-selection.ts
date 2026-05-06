import type { EvalExpected, ObservedToolCall, Score } from "../types.js";

export function gradeToolSelection(observed: ObservedToolCall[], expected: EvalExpected): Score[] {
  const scores: Score[] = [];

  if (expected.toolCalls && expected.toolCalls.length > 0) {
    const expectedNames = expected.toolCalls.map((t) => t.name);
    const expectedCount: Record<string, number> = {};
    for (const n of expectedNames) expectedCount[n] = (expectedCount[n] ?? 0) + 1;
    const observedCount: Record<string, number> = {};
    for (const o of observed) observedCount[o.name] = (observedCount[o.name] ?? 0) + 1;

    let matched = 0;
    for (const n of expectedNames) {
      // Each expected occurrence is satisfied iff observedCount[n] still has a remaining call.
      if ((observedCount[n] ?? 0) > 0) {
        matched++;
        observedCount[n]--;
      }
    }
    const value = expectedNames.length === 0 ? 1 : matched / expectedNames.length;
    scores.push({
      name: "tool-names",
      value,
      pass: matched === expectedNames.length,
      reason:
        matched === expectedNames.length
          ? `all ${expectedNames.length} expected tool(s) were called`
          : `matched ${matched}/${expectedNames.length} expected tool name(s)`,
      actual: observed.map((o) => o.name),
      expected: expectedNames,
    });
  }

  if (expected.forbiddenTools && expected.forbiddenTools.length > 0) {
    const observedNames = new Set(observed.map((o) => o.name));
    const violated = expected.forbiddenTools.filter((n) => observedNames.has(n));
    scores.push({
      name: "forbidden-tools",
      value: violated.length === 0 ? 1 : 0,
      pass: violated.length === 0,
      reason:
        violated.length === 0
          ? "no forbidden tools were called"
          : `forbidden tool(s) called: ${violated.join(", ")}`,
      actual: violated,
      expected: expected.forbiddenTools,
    });
  }

  const hasMin = typeof expected.minCalls === "number";
  const hasMax = typeof expected.maxCalls === "number";
  if (hasMin || hasMax) {
    const count = observed.length;
    const minOk = !hasMin || count >= (expected.minCalls as number);
    const maxOk = !hasMax || count <= (expected.maxCalls as number);
    const pass = minOk && maxOk;
    scores.push({
      name: "call-count",
      value: pass ? 1 : 0,
      pass,
      reason: pass
        ? `call count ${count} within bounds`
        : `call count ${count} out of bounds (min=${expected.minCalls ?? "-"}, max=${expected.maxCalls ?? "-"})`,
      actual: count,
      expected: { min: expected.minCalls, max: expected.maxCalls },
    });
  }

  if (expected.noToolCall === true) {
    const pass = observed.length === 0;
    scores.push({
      name: "no-tool-compliance",
      value: pass ? 1 : 0,
      pass,
      reason: pass ? "no tools called as expected" : `expected no tool calls but got ${observed.length}`,
      actual: observed.length,
      expected: 0,
    });
  }

  return scores;
}
