import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  safeIntCount,
  safePosInt,
  safeIntCap,
  finiteRate,
  finiteCost,
  finitePValue,
  nonblankString,
} from "../../src/validation/numbers.js";

describe("validation/numbers helpers", () => {
  describe("safeIntCount", () => {
    const s = safeIntCount();
    it("accepts 0, 1, MAX_SAFE_INTEGER", () => {
      expect(s.safeParse(0).success).toBe(true);
      expect(s.safeParse(1).success).toBe(true);
      expect(s.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
    });
    it("rejects -0, -1, NaN, Infinity, 1.5", () => {
      expect(s.safeParse(-0).success).toBe(false);
      expect(s.safeParse(-1).success).toBe(false);
      expect(s.safeParse(Number.NaN).success).toBe(false);
      expect(s.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
      expect(s.safeParse(1.5).success).toBe(false);
    });
    it("rejects 2^53 (not Number.isSafeInteger)", () => {
      expect(s.safeParse(2 ** 53).success).toBe(false);
      expect(s.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
    });
  });

  describe("safePosInt", () => {
    const s = safePosInt();
    it("accepts 1, MAX_SAFE_INTEGER; rejects 0, -1, -0", () => {
      expect(s.safeParse(1).success).toBe(true);
      expect(s.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
      expect(s.safeParse(0).success).toBe(false);
      expect(s.safeParse(-1).success).toBe(false);
      expect(s.safeParse(-0).success).toBe(false);
    });
    it("rejects 2^53", () => {
      expect(s.safeParse(2 ** 53).success).toBe(false);
    });
  });

  describe("safeIntCap", () => {
    it("matches safePosInt semantics (positive safe int)", () => {
      const s = safeIntCap();
      expect(s.safeParse(1).success).toBe(true);
      expect(s.safeParse(0).success).toBe(false);
      expect(s.safeParse(2 ** 53).success).toBe(false);
    });
  });

  describe("finiteRate", () => {
    const s = finiteRate();
    it("accepts 0, 0.5, 1", () => {
      expect(s.safeParse(0).success).toBe(true);
      expect(s.safeParse(0.5).success).toBe(true);
      expect(s.safeParse(1).success).toBe(true);
    });
    it("rejects -0, NaN, Infinity, -0.1, 1.1", () => {
      expect(s.safeParse(-0).success).toBe(false);
      expect(s.safeParse(Number.NaN).success).toBe(false);
      expect(s.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
      expect(s.safeParse(-0.1).success).toBe(false);
      expect(s.safeParse(1.1).success).toBe(false);
    });
  });

  describe("finiteCost", () => {
    const s = finiteCost();
    it("accepts 0, 0.001, 1000", () => {
      expect(s.safeParse(0).success).toBe(true);
      expect(s.safeParse(0.001).success).toBe(true);
      expect(s.safeParse(1000).success).toBe(true);
    });
    it("rejects -0, -1, NaN, Infinity", () => {
      expect(s.safeParse(-0).success).toBe(false);
      expect(s.safeParse(-1).success).toBe(false);
      expect(s.safeParse(Number.NaN).success).toBe(false);
      expect(s.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    });
  });

  describe("finitePValue", () => {
    const s = finitePValue();
    it("accepts 0, 0.5, 1", () => {
      expect(s.safeParse(0).success).toBe(true);
      expect(s.safeParse(0.5).success).toBe(true);
      expect(s.safeParse(1).success).toBe(true);
    });
    it("rejects -0, NaN, Infinity, 1.1", () => {
      expect(s.safeParse(-0).success).toBe(false);
      expect(s.safeParse(Number.NaN).success).toBe(false);
      expect(s.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
      expect(s.safeParse(1.1).success).toBe(false);
    });
  });

  describe("nonblankString", () => {
    const s = nonblankString();
    it("accepts non-blank strings", () => {
      expect(s.safeParse("a").success).toBe(true);
      expect(s.safeParse(" a ").success).toBe(true);
    });
    it("rejects empty and whitespace-only", () => {
      expect(s.safeParse("").success).toBe(false);
      expect(s.safeParse(" ").success).toBe(false);
      expect(s.safeParse("\t\n").success).toBe(false);
    });
  });

  describe("composability", () => {
    it("helpers compose inside z.object", () => {
      const schema = z.object({
        n: safeIntCount(),
        rate: finiteRate(),
        id: nonblankString(),
      });
      expect(schema.safeParse({ n: 0, rate: 0, id: "x" }).success).toBe(true);
      expect(schema.safeParse({ n: -0, rate: 0, id: "x" }).success).toBe(false);
      expect(schema.safeParse({ n: 0, rate: Number.NaN, id: "x" }).success).toBe(false);
      expect(schema.safeParse({ n: 0, rate: 0, id: " " }).success).toBe(false);
    });
  });
});
