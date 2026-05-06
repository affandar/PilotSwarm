import { describe, it, expect } from "vitest";
import { gradeResponse } from "../src/graders/response.js";

describe("gradeResponse", () => {
  it("containsAny: passes on any match, fails on none", () => {
    expect(gradeResponse("The answer is 42", { containsAny: ["42", "100"] })!.pass).toBe(true);
    expect(gradeResponse("Something else", { containsAny: ["42", "100"] })!.pass).toBe(false);
  });

  it("containsAll: all present passes; one missing fails with value<1", () => {
    const all = gradeResponse("alpha and beta and gamma", { containsAll: ["alpha", "beta", "gamma"] })!;
    expect(all.pass).toBe(true);
    expect(all.value).toBe(1);
    const partial = gradeResponse("alpha and beta", { containsAll: ["alpha", "beta", "gamma"] })!;
    expect(partial.pass).toBe(false);
    expect(partial.value).toBeLessThan(1);
  });

  it("matching is case-insensitive", () => {
    expect(gradeResponse("The ANSWER is here", { containsAll: ["answer"] })!.pass).toBe(true);
  });

  it("undefined config returns undefined (skip)", () => {
    expect(gradeResponse("anything", undefined)).toBeUndefined();
  });

  it("uses word-boundary matching: 'hi' matches 'hi there' but not 'this is helpful'", () => {
    expect(gradeResponse("this is helpful", { containsAny: ["hi"] })!.pass).toBe(false);
    expect(gradeResponse("hi there", { containsAny: ["hi"] })!.pass).toBe(true);
  });

  it("word-boundary: 'cat' does NOT match inside 'concatenation'", () => {
    expect(gradeResponse("look at this concatenation", { containsAny: ["cat"] })!.pass).toBe(false);
  });

  it("punctuation does not block boundary match: 'hello' matches 'hello,'", () => {
    expect(gradeResponse("hello, world", { containsAny: ["hello"] })!.pass).toBe(true);
  });

  it("containsAll respects word boundaries", () => {
    expect(gradeResponse("this is helpful", { containsAll: ["hi"] })!.pass).toBe(false);
  });
});
