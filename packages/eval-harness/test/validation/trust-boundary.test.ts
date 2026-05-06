import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  parseAtBoundary,
  parseAtBoundaryOrInfraError,
} from "../../src/validation/trust-boundary.js";

describe("validation/trust-boundary", () => {
  const schema = z.object({
    n: z.number(),
    s: z.string(),
    payload: z.unknown().optional(),
  });

  describe("parseAtBoundary success", () => {
    it("returns ok:true with frozen, deep-cloned data", () => {
      const input = { n: 1, s: "hi" };
      const r = parseAtBoundary(schema, input);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data).toEqual({ n: 1, s: "hi" });
      expect(Object.isFrozen(r.data)).toBe(true);
      // identity severed from input
      expect(r.data).not.toBe(input);
    });

    it("mutating original after parse does not affect snapshot", () => {
      const input: { n: number; s: string } = { n: 1, s: "hi" };
      const r = parseAtBoundary(schema, input);
      if (!r.ok) throw new Error("expected ok");
      input.n = 999;
      expect(r.data.n).toBe(1);
    });
  });

  describe("parseAtBoundary failure", () => {
    it("returns ok:false with structured issues on shape mismatch", () => {
      const r = parseAtBoundary(schema, { n: "not-a-number", s: "hi" });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toMatch(/schema validation failed/);
      expect(r.issues.length).toBeGreaterThan(0);
      expect(r.issues[0]?.path).toBe("n");
    });

    it("includes context label in error when provided", () => {
      const r = parseAtBoundary(schema, { n: "x", s: "y" }, { context: "Foo:bar" });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toMatch(/^\[Foo:bar\]/);
    });

    it("rejects Symbol at deep path BEFORE Zod parse", () => {
      const r = parseAtBoundary(schema, {
        n: 1,
        s: "hi",
        payload: { nested: { evil: Symbol("nope") } },
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toMatch(/forbidden symbol/);
    });

    it("rejects Function at deep path", () => {
      const r = parseAtBoundary(schema, {
        n: 1,
        s: "hi",
        payload: { nested: { evil: () => 42 } },
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toMatch(/forbidden function/);
    });

    it("rejects BigInt at deep path", () => {
      const r = parseAtBoundary(schema, {
        n: 1,
        s: "hi",
        payload: { count: BigInt(1) },
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toMatch(/forbidden bigint/);
    });

    it("rejects Symbol-keyed property", () => {
      const obj: Record<string | symbol, unknown> = { n: 1, s: "hi" };
      obj[Symbol("evil")] = "x";
      const r = parseAtBoundary(schema, obj);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toMatch(/forbidden symbol-keyed/);
    });

    it("rejects Symbol inside array", () => {
      const r = parseAtBoundary(z.object({ arr: z.array(z.unknown()) }), {
        arr: [1, 2, Symbol("x")],
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toMatch(/forbidden symbol/);
    });
  });

  describe("parseAtBoundaryOrInfraError", () => {
    it("returns infraScore on failure", () => {
      const r = parseAtBoundaryOrInfraError(schema, { bogus: true });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      if (!("infraScore" in r)) throw new Error("expected infraScore");
      expect(r.infraScore.infraError).toBe(true);
      expect(r.infraScore.pass).toBe(false);
      expect(r.infraScore.value).toBe(0);
      expect(r.infraScore.name).toBe("trust-boundary");
    });

    it("uses scoreName option when provided", () => {
      const r = parseAtBoundaryOrInfraError(
        schema,
        { bogus: true },
        { scoreName: "driver-output" },
      );
      if (r.ok) return;
      if (!("infraScore" in r)) throw new Error("expected infraScore");
      expect(r.infraScore.name).toBe("driver-output");
    });

    it("returns ok on success", () => {
      const r = parseAtBoundaryOrInfraError(schema, { n: 1, s: "x" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data).toEqual({ n: 1, s: "x" });
    });
  });
});
