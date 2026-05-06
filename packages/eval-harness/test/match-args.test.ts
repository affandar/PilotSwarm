import { describe, it, expect } from "vitest";
import { matchArgs, sortKeys } from "../src/graders/match-args.js";

describe("sortKeys", () => {
  it("recursively sorts object keys (top-level + nested), preserves arrays and primitives", () => {
    const r = sortKeys({ b: { z: 1, a: 2 }, a: 1 }) as Record<string, Record<string, number>>;
    expect(Object.keys(r)).toEqual(["a", "b"]);
    expect(Object.keys(r.b)).toEqual(["a", "z"]);
    expect(sortKeys([3, 1, 2])).toEqual([3, 1, 2]);
    expect(sortKeys(42)).toBe(42);
    expect(sortKeys(null)).toBe(null);
  });
});

describe("matchArgs: exact", () => {
  it("identical objects pass; key order does not matter", () => {
    const r = matchArgs({ b: 2, a: 1 }, { a: 1, b: 2 }, "exact");
    expect(r.pass).toBe(true);
    expect(r.score).toBe(1);
  });

  it("any divergence (different value, extra or missing key) fails with diff", () => {
    expect(matchArgs({ a: 1 }, { a: 2 }, "exact").pass).toBe(false);
    expect(matchArgs({ a: 1, b: 2 }, { a: 1 }, "exact").pass).toBe(false);
    expect(matchArgs({ a: 1 }, { a: 1, b: 2 }, "exact").pass).toBe(false);
    expect(matchArgs({ a: 1 }, { a: 2 }, "exact").diff.length).toBeGreaterThan(0);
  });
});

describe("matchArgs: subset (default)", () => {
  it("expected ⊆ actual passes (and is the default mode)", () => {
    expect(matchArgs({ a: 1, extra: 2 }, { a: 1 }).pass).toBe(true);
    expect(matchArgs({ a: 1, b: 2, c: 3 }, { a: 1, b: 2 }, "subset").pass).toBe(true);
  });

  it("missing keys yield fractional score and fail", () => {
    const r = matchArgs({ a: 1 }, { a: 1, b: 2, c: 3 }, "subset");
    expect(r.pass).toBe(false);
    expect(r.score).toBeCloseTo(1 / 3, 5);
  });

  it("string comparison is case-insensitive + trims when subsetCaseInsensitive=true; case-sensitive otherwise", () => {
    expect(matchArgs({ city: "  Paris  " }, { city: "paris" }, "subset", { subsetCaseInsensitive: true }).pass).toBe(true);
    expect(matchArgs({ path: "Src/API.ts" }, { path: "src/api.ts" }, "subset").pass).toBe(false);
  });
});

describe("matchArgs: fuzzy", () => {
  it("close strings pass; distant strings fail (Levenshtein-based)", () => {
    expect(matchArgs({ city: "San Fransisco" }, { city: "San Francisco" }, "fuzzy").pass).toBe(true);
    expect(matchArgs({ city: "Tokyo" }, { city: "San Francisco" }, "fuzzy").pass).toBe(false);
  });

  it("number coercion works ('42' matches 42); numeric tolerance is configurable", () => {
    expect(matchArgs({ n: "42" }, { n: 42 }, "fuzzy").pass).toBe(true);
    expect(matchArgs({ n: 3.001 }, { n: 3 }, "fuzzy").pass).toBe(false);
    expect(matchArgs({ n: 3.001 }, { n: 3 }, "fuzzy", { numericTolerance: 0.01 }).pass).toBe(true);
  });

  it("arrays are order-insensitive in fuzzy mode", () => {
    expect(matchArgs({ tags: ["b", "a", "c"] }, { tags: ["a", "b", "c"] }, "fuzzy").pass).toBe(true);
  });

  it("fuzzy string distance is configurable (strict mode rejects typos)", () => {
    const strict = matchArgs({ city: "San Fransisco" }, { city: "San Francisco" }, "fuzzy", {
      fuzzyStringMaxRelativeDistance: 0,
    });
    expect(strict.pass).toBe(false);
  });
});

describe("matchArgs: setEquals", () => {
  it("identical objects pass; any extra/missing key on either side fails", () => {
    expect(matchArgs({ b: 2, a: 1 }, { a: 1, b: 2 }, "setEquals").pass).toBe(true);
    expect(matchArgs({ a: 1, b: 2, c: 3 }, { a: 1, b: 2 }, "setEquals").pass).toBe(false);
    expect(matchArgs({ a: 1 }, { a: 1, b: 2 }, "setEquals").pass).toBe(false);
  });
});
