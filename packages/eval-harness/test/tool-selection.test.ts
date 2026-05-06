import { describe, it, expect } from "vitest";
import { gradeToolSelection } from "../src/graders/tool-selection.js";
import type { ObservedToolCall, EvalExpected } from "../src/types.js";

function call(name: string, args: Record<string, unknown> = {}, order = 0): ObservedToolCall {
  return { name, args, order };
}

describe("gradeToolSelection: tool-names", () => {
  it("passes when all expected tools called; fails when wrong tool called", () => {
    const exp: EvalExpected = { toolCalls: [{ name: "add", match: "subset" }], toolSequence: "unordered" };
    const ok = gradeToolSelection([call("add", { a: 1, b: 2 })], exp).find((x) => x.name === "tool-names")!;
    expect(ok.pass).toBe(true);
    expect(ok.value).toBe(1);
    const bad = gradeToolSelection([call("multiply")], exp).find((x) => x.name === "tool-names")!;
    expect(bad.pass).toBe(false);
    expect(bad.value).toBe(0);
  });

  it("partial match → fractional score (1 of 2 expected tools observed)", () => {
    const expected: EvalExpected = {
      toolCalls: [
        { name: "add", match: "subset" },
        { name: "multiply", match: "subset" },
      ],
      toolSequence: "unordered",
    };
    const s = gradeToolSelection([call("add")], expected).find((x) => x.name === "tool-names")!;
    expect(s.pass).toBe(false);
    expect(s.value).toBeCloseTo(0.5, 5);
  });

  it("multiset: 2 expected calls to same tool but only 1 observed → partial fail", () => {
    const expected: EvalExpected = {
      toolCalls: [
        { name: "test_weather", match: "subset" },
        { name: "test_weather", match: "subset" },
      ],
      toolSequence: "unordered",
    };
    const partial = gradeToolSelection([call("test_weather")], expected).find((x) => x.name === "tool-names")!;
    expect(partial.pass).toBe(false);
    expect(partial.value).toBeCloseTo(0.5, 5);
    const full = gradeToolSelection(
      [call("test_weather", { city: "Paris" }), call("test_weather", { city: "London" })],
      expected,
    ).find((x) => x.name === "tool-names")!;
    expect(full.pass).toBe(true);
    expect(full.value).toBe(1);
  });
});

describe("gradeToolSelection: forbidden-tools", () => {
  it("fails when forbidden tool called; passes when not called", () => {
    const expected: EvalExpected = { forbiddenTools: ["delete_all"], toolSequence: "unordered" };
    expect(gradeToolSelection([call("delete_all")], expected).find((x) => x.name === "forbidden-tools")!.pass).toBe(false);
    expect(gradeToolSelection([call("add")], expected).find((x) => x.name === "forbidden-tools")!.pass).toBe(true);
  });
});

describe("gradeToolSelection: no-tool-compliance", () => {
  it("noToolCall=true passes with empty observations, fails when calls exist", () => {
    const expected: EvalExpected = { noToolCall: true, toolSequence: "unordered" };
    expect(gradeToolSelection([], expected).find((x) => x.name === "no-tool-compliance")!.pass).toBe(true);
    expect(gradeToolSelection([call("add")], expected).find((x) => x.name === "no-tool-compliance")!.pass).toBe(false);
  });
});

describe("gradeToolSelection: call-count", () => {
  it("minCalls met → pass; not met → fail", () => {
    const expected: EvalExpected = { minCalls: 2, toolSequence: "unordered" };
    expect(gradeToolSelection([call("add"), call("add")], expected).find((x) => x.name === "call-count")!.pass).toBe(true);
    expect(gradeToolSelection([call("add")], expected).find((x) => x.name === "call-count")!.pass).toBe(false);
  });

  it("maxCalls exceeded → fail; within range → pass", () => {
    const exceeded: EvalExpected = { maxCalls: 2, toolSequence: "unordered" };
    expect(
      gradeToolSelection([call("add"), call("add"), call("add")], exceeded)
        .find((x) => x.name === "call-count")!.pass,
    ).toBe(false);
    const inRange: EvalExpected = { minCalls: 1, maxCalls: 3, toolSequence: "unordered" };
    expect(
      gradeToolSelection([call("add"), call("add")], inRange).find((x) => x.name === "call-count")!.pass,
    ).toBe(true);
  });
});
