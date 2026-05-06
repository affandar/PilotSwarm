import { describe, it, expect } from "vitest";
import { matchArgs, sortKeys } from "../src/graders/match-args.js";

describe("sortKeys", () => {
  it("sorts top-level keys alphabetically", () => {
    const result = sortKeys({ b: 1, a: 2, c: 3 });
    expect(Object.keys(result as Record<string, unknown>)).toEqual(["a", "b", "c"]);
  });

  it("recursively sorts nested object keys", () => {
    const result = sortKeys({ b: { z: 1, a: 2 }, a: 1 }) as Record<string, Record<string, number>>;
    expect(Object.keys(result)).toEqual(["a", "b"]);
    expect(Object.keys(result.b)).toEqual(["a", "z"]);
  });

  it("passes through primitives unchanged", () => {
    expect(sortKeys(42)).toBe(42);
    expect(sortKeys("hi")).toBe("hi");
    expect(sortKeys(null)).toBe(null);
  });

  it("preserves arrays (does not sort elements)", () => {
    expect(sortKeys([3, 1, 2])).toEqual([3, 1, 2]);
  });
});

describe("matchArgs: exact", () => {
  it("matching objects pass", () => {
    const r = matchArgs({ a: 1, b: 2 }, { a: 1, b: 2 }, "exact");
    expect(r.pass).toBe(true);
    expect(r.score).toBe(1);
  });

  it("different values fail", () => {
    const r = matchArgs({ a: 1 }, { a: 2 }, "exact");
    expect(r.pass).toBe(false);
    expect(r.score).toBe(0);
    expect(r.diff.length).toBeGreaterThan(0);
  });

  it("extra keys in actual fail", () => {
    const r = matchArgs({ a: 1, b: 2 }, { a: 1 }, "exact");
    expect(r.pass).toBe(false);
  });

  it("missing keys in actual fail", () => {
    const r = matchArgs({ a: 1 }, { a: 1, b: 2 }, "exact");
    expect(r.pass).toBe(false);
  });

  it("key order doesn't matter", () => {
    const r = matchArgs({ b: 2, a: 1 }, { a: 1, b: 2 }, "exact");
    expect(r.pass).toBe(true);
  });

  it("handles nested objects", () => {
    const r = matchArgs({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } }, "exact");
    expect(r.pass).toBe(true);
  });
});

describe("matchArgs: subset (default)", () => {
  it("expected ⊆ actual passes", () => {
    const r = matchArgs({ a: 1, b: 2, c: 3 }, { a: 1, b: 2 }, "subset");
    expect(r.pass).toBe(true);
    expect(r.score).toBe(1);
  });

  it("extra keys in actual OK", () => {
    const r = matchArgs({ a: 1, extra: "x" }, { a: 1 }, "subset");
    expect(r.pass).toBe(true);
  });

  it("missing keys fail", () => {
    const r = matchArgs({ a: 1 }, { a: 1, b: 2 }, "subset");
    expect(r.pass).toBe(false);
    expect(r.score).toBeLessThan(1);
  });

  it("string comparison is case-insensitive", () => {
    const r = matchArgs({ city: "Paris" }, { city: "paris" }, "subset");
    expect(r.pass).toBe(true);
  });

  it("string comparison trims whitespace", () => {
    const r = matchArgs({ city: "  Paris  " }, { city: "paris" }, "subset");
    expect(r.pass).toBe(true);
  });

  it("mismatched values fail", () => {
    const r = matchArgs({ a: 1 }, { a: 2 }, "subset");
    expect(r.pass).toBe(false);
  });

  it("is the default mode", () => {
    const r = matchArgs({ a: 1, extra: 2 }, { a: 1 });
    expect(r.pass).toBe(true);
  });

  it("partial match gives fractional score", () => {
    const r = matchArgs({ a: 1 }, { a: 1, b: 2, c: 3 }, "subset");
    expect(r.score).toBeCloseTo(1 / 3, 5);
  });
});

describe("matchArgs: fuzzy", () => {
  it("close string matches pass (Levenshtein within 20%)", () => {
    const r = matchArgs({ city: "San Fransisco" }, { city: "San Francisco" }, "fuzzy");
    expect(r.pass).toBe(true);
  });

  it("distant strings fail", () => {
    const r = matchArgs({ city: "Tokyo" }, { city: "San Francisco" }, "fuzzy");
    expect(r.pass).toBe(false);
  });

  it("number coercion: string matches number", () => {
    const r = matchArgs({ n: "42" }, { n: 42 }, "fuzzy");
    expect(r.pass).toBe(true);
  });

  it("numeric tolerance ±0.01", () => {
    const r = matchArgs({ n: 3.001 }, { n: 3 }, "fuzzy");
    expect(r.pass).toBe(true);
  });

  it("numeric tolerance violated", () => {
    const r = matchArgs({ n: 3.5 }, { n: 3 }, "fuzzy");
    expect(r.pass).toBe(false);
  });

  it("arrays are order-insensitive", () => {
    const r = matchArgs({ tags: ["b", "a", "c"] }, { tags: ["a", "b", "c"] }, "fuzzy");
    expect(r.pass).toBe(true);
  });
});

describe("matchArgs: setEquals", () => {
  it("identical objects pass", () => {
    const r = matchArgs({ a: 1, b: 2 }, { a: 1, b: 2 }, "setEquals");
    expect(r.pass).toBe(true);
    expect(r.score).toBe(1);
  });

  it("extra keys in actual fail", () => {
    const r = matchArgs({ a: 1, b: 2, c: 3 }, { a: 1, b: 2 }, "setEquals");
    expect(r.pass).toBe(false);
  });

  it("extra keys in expected fail", () => {
    const r = matchArgs({ a: 1 }, { a: 1, b: 2 }, "setEquals");
    expect(r.pass).toBe(false);
  });

  it("order-independent", () => {
    const r = matchArgs({ b: 2, a: 1 }, { a: 1, b: 2 }, "setEquals");
    expect(r.pass).toBe(true);
  });
});
