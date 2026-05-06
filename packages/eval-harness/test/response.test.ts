import { describe, it, expect } from "vitest";
import { gradeResponse } from "../src/graders/response.js";

describe("gradeResponse", () => {
  it("containsAny: one match → pass", () => {
    const s = gradeResponse("The answer is 42", { containsAny: ["42", "100"] });
    expect(s).toBeDefined();
    expect(s!.pass).toBe(true);
  });

  it("containsAny: no match → fail", () => {
    const s = gradeResponse("Something else", { containsAny: ["42", "100"] });
    expect(s!.pass).toBe(false);
  });

  it("containsAll: all present → pass", () => {
    const s = gradeResponse("alpha and beta and gamma", { containsAll: ["alpha", "beta", "gamma"] });
    expect(s!.pass).toBe(true);
    expect(s!.value).toBe(1);
  });

  it("containsAll: one missing → fail", () => {
    const s = gradeResponse("alpha and beta", { containsAll: ["alpha", "beta", "gamma"] });
    expect(s!.pass).toBe(false);
    expect(s!.value).toBeLessThan(1);
  });

  it("case-insensitive matching", () => {
    const s = gradeResponse("The ANSWER is here", { containsAll: ["answer"] });
    expect(s!.pass).toBe(true);
  });

  it("undefined response config → returns undefined (skip)", () => {
    const s = gradeResponse("anything", undefined);
    expect(s).toBeUndefined();
  });

  it("uses word-boundary matching: 'hi' does NOT match 'this is helpful'", () => {
    const s = gradeResponse("this is helpful", { containsAny: ["hi"] });
    expect(s).toBeDefined();
    expect(s!.pass).toBe(false);
  });

  it("word-boundary: 'hi' DOES match 'hi there'", () => {
    const s = gradeResponse("hi there", { containsAny: ["hi"] });
    expect(s!.pass).toBe(true);
  });

  it("word-boundary: 'hello' matches inside punctuation 'hello,'", () => {
    const s = gradeResponse("hello, world", { containsAny: ["hello"] });
    expect(s!.pass).toBe(true);
  });

  it("word-boundary: 'cat' does NOT match 'concatenation'", () => {
    const s = gradeResponse("look at this concatenation", { containsAny: ["cat"] });
    expect(s!.pass).toBe(false);
  });

  it("word-boundary: containsAll respects boundaries too", () => {
    const s = gradeResponse("this is helpful", { containsAll: ["hi"] });
    expect(s!.pass).toBe(false);
  });
});
