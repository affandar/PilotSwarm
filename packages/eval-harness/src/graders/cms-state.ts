import type { EvalExpected, Score } from "../types.js";

export function gradeCmsState(
  actualState: string | undefined,
  expected: EvalExpected["cms"],
): Score | undefined {
  if (!expected || !expected.stateIn || expected.stateIn.length === 0) return undefined;

  const pass = actualState !== undefined && expected.stateIn.includes(actualState);
  return {
    name: "cms-state",
    value: pass ? 1 : 0,
    pass,
    reason: pass
      ? `CMS state "${actualState}" is in allowed set`
      : actualState === undefined
        ? "CMS state is undefined but was expected"
        : `CMS state "${actualState}" not in allowed set [${expected.stateIn.join(", ")}]`,
    actual: actualState,
    expected: expected.stateIn,
  };
}
