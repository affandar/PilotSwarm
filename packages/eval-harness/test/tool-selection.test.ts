import { describe, it, expect } from "vitest";
import { gradeToolSelection } from "../src/graders/tool-selection.js";
import type { ObservedToolCall, EvalExpected } from "../src/types.js";

function call(name: string, args: Record<string, unknown> = {}, order = 0): ObservedToolCall {
  return { name, args, order };
}

describe("gradeToolSelection: tool-names", () => {
  it("correct tool called → pass", () => {
    const observed = [call("add", { a: 1, b: 2 })];
    const exp: EvalExpected = { toolCalls: [{ name: "add", match: "subset" }], toolSequence: "unordered" };
    const scores = gradeToolSelection(observed, exp);
    const s = scores.find((x) => x.name === "tool-names");
    expect(s).toBeDefined();
    expect(s!.pass).toBe(true);
    expect(s!.value).toBe(1);
  });

  it("wrong tool called → fail", () => {
    const observed = [call("multiply")];
    const expected: EvalExpected = { toolCalls: [{ name: "add", match: "subset" }], toolSequence: "unordered" };
    const scores = gradeToolSelection(observed, expected);
    const s = scores.find((x) => x.name === "tool-names");
    expect(s!.pass).toBe(false);
    expect(s!.value).toBe(0);
  });

  it("multiple expected tools, all present → pass", () => {
    const observed = [call("add"), call("multiply")];
    const expected: EvalExpected = {
      toolCalls: [
        { name: "add", match: "subset" },
        { name: "multiply", match: "subset" },
      ],
      toolSequence: "unordered",
    };
    const scores = gradeToolSelection(observed, expected);
    const s = scores.find((x) => x.name === "tool-names")!;
    expect(s.pass).toBe(true);
    expect(s.value).toBe(1);
  });

  it("multiple expected tools, one missing → partial score", () => {
    const observed = [call("add")];
    const expected: EvalExpected = {
      toolCalls: [
        { name: "add", match: "subset" },
        { name: "multiply", match: "subset" },
      ],
      toolSequence: "unordered",
    };
    const scores = gradeToolSelection(observed, expected);
    const s = scores.find((x) => x.name === "tool-names")!;
    expect(s.pass).toBe(false);
    expect(s.value).toBeCloseTo(0.5, 5);
  });
});

describe("gradeToolSelection: forbidden-tools", () => {
  it("forbidden tool called → fail", () => {
    const observed = [call("delete_all")];
    const expected: EvalExpected = { forbiddenTools: ["delete_all"], toolSequence: "unordered" };
    const scores = gradeToolSelection(observed, expected);
    const s = scores.find((x) => x.name === "forbidden-tools")!;
    expect(s.pass).toBe(false);
  });

  it("forbidden tool not called → pass", () => {
    const observed = [call("add")];
    const expected: EvalExpected = { forbiddenTools: ["delete_all"], toolSequence: "unordered" };
    const scores = gradeToolSelection(observed, expected);
    const s = scores.find((x) => x.name === "forbidden-tools")!;
    expect(s.pass).toBe(true);
    expect(s.value).toBe(1);
  });
});

describe("gradeToolSelection: no-tool-compliance", () => {
  it("noToolCall=true with no calls → pass", () => {
    const observed: ObservedToolCall[] = [];
    const expected: EvalExpected = { noToolCall: true, toolSequence: "unordered" };
    const scores = gradeToolSelection(observed, expected);
    const s = scores.find((x) => x.name === "no-tool-compliance")!;
    expect(s.pass).toBe(true);
  });

  it("noToolCall=true with calls → fail", () => {
    const observed = [call("add")];
    const expected: EvalExpected = { noToolCall: true, toolSequence: "unordered" };
    const scores = gradeToolSelection(observed, expected);
    const s = scores.find((x) => x.name === "no-tool-compliance")!;
    expect(s.pass).toBe(false);
  });
});

describe("gradeToolSelection: call-count", () => {
  it("minCalls met → pass", () => {
    const observed = [call("add"), call("add")];
    const expected: EvalExpected = { minCalls: 2, toolSequence: "unordered" };
    const scores = gradeToolSelection(observed, expected);
    const s = scores.find((x) => x.name === "call-count")!;
    expect(s.pass).toBe(true);
  });

  it("minCalls not met → fail", () => {
    const observed = [call("add")];
    const expected: EvalExpected = { minCalls: 2, toolSequence: "unordered" };
    const scores = gradeToolSelection(observed, expected);
    const s = scores.find((x) => x.name === "call-count")!;
    expect(s.pass).toBe(false);
  });

  it("maxCalls exceeded → fail", () => {
    const observed = [call("add"), call("add"), call("add")];
    const expected: EvalExpected = { maxCalls: 2, toolSequence: "unordered" };
    const scores = gradeToolSelection(observed, expected);
    const s = scores.find((x) => x.name === "call-count")!;
    expect(s.pass).toBe(false);
  });

  it("within min/max range → pass", () => {
    const observed = [call("add"), call("add")];
    const expected: EvalExpected = { minCalls: 1, maxCalls: 3, toolSequence: "unordered" };
    const scores = gradeToolSelection(observed, expected);
    const s = scores.find((x) => x.name === "call-count")!;
    expect(s.pass).toBe(true);
  });
});

describe("gradeToolSelection: multiset semantics", () => {
  it("fails when expected has 2 calls to same tool but observed has only 1", () => {
    const observed = [call("test_weather", { city: "Paris" })];
    const expected: EvalExpected = {
      toolCalls: [
        { name: "test_weather", match: "subset" },
        { name: "test_weather", match: "subset" },
      ],
      toolSequence: "unordered",
    };
    const scores = gradeToolSelection(observed, expected);
    const s = scores.find((x) => x.name === "tool-names")!;
    expect(s.pass).toBe(false);
    expect(s.value).toBeCloseTo(0.5, 5);
  });

  it("passes when expected has 2 calls to same tool and observed has 2", () => {
    const observed = [call("test_weather", { city: "Paris" }), call("test_weather", { city: "London" })];
    const expected: EvalExpected = {
      toolCalls: [
        { name: "test_weather", match: "subset" },
        { name: "test_weather", match: "subset" },
      ],
      toolSequence: "unordered",
    };
    const scores = gradeToolSelection(observed, expected);
    const s = scores.find((x) => x.name === "tool-names")!;
    expect(s.pass).toBe(true);
    expect(s.value).toBe(1);
  });
});
