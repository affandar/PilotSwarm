import { describe, it, expect } from "vitest";
import {
  formatPValue,
  formatRate,
  formatCount,
  formatProvenance,
  MISSING_VALUE_GLYPH,
} from "../../src/reporters/format.js";

describe("reporters/format", () => {
  describe("formatPValue", () => {
    it("formats finite p-values with 4 decimal places", () => {
      expect(formatPValue(0)).toBe("0.0000");
      expect(formatPValue(0.05)).toBe("0.0500");
      expect(formatPValue(1)).toBe("1.0000");
    });
    it("returns em-dash for non-finite / out-of-range / undefined", () => {
      expect(formatPValue(undefined)).toBe(MISSING_VALUE_GLYPH);
      expect(formatPValue(Number.NaN)).toBe(MISSING_VALUE_GLYPH);
      expect(formatPValue(Number.POSITIVE_INFINITY)).toBe(MISSING_VALUE_GLYPH);
      expect(formatPValue(Number.NEGATIVE_INFINITY)).toBe(MISSING_VALUE_GLYPH);
      expect(formatPValue(-0.1)).toBe(MISSING_VALUE_GLYPH);
      expect(formatPValue(1.1)).toBe(MISSING_VALUE_GLYPH);
      expect(formatPValue("0.5" as unknown as number)).toBe(MISSING_VALUE_GLYPH);
    });
  });

  describe("formatRate", () => {
    it("formats as percentage", () => {
      expect(formatRate(0)).toBe("0.0%");
      expect(formatRate(0.5)).toBe("50.0%");
      expect(formatRate(1)).toBe("100.0%");
      expect(formatRate(0.1234, 2)).toBe("12.34%");
    });
    it("returns em-dash for non-finite", () => {
      expect(formatRate(Number.NaN)).toBe(MISSING_VALUE_GLYPH);
      expect(formatRate(Number.POSITIVE_INFINITY)).toBe(MISSING_VALUE_GLYPH);
      expect(formatRate(undefined)).toBe(MISSING_VALUE_GLYPH);
      expect(formatRate(-0.01)).toBe(MISSING_VALUE_GLYPH);
      expect(formatRate(1.01)).toBe(MISSING_VALUE_GLYPH);
    });
  });

  describe("formatCount", () => {
    it("formats nonneg integers", () => {
      expect(formatCount(0)).toBe("0");
      expect(formatCount(42)).toBe("42");
    });
    it("returns em-dash for non-integer / negative / non-finite", () => {
      expect(formatCount(1.5)).toBe(MISSING_VALUE_GLYPH);
      expect(formatCount(-1)).toBe(MISSING_VALUE_GLYPH);
      expect(formatCount(Number.NaN)).toBe(MISSING_VALUE_GLYPH);
      expect(formatCount(Number.POSITIVE_INFINITY)).toBe(MISSING_VALUE_GLYPH);
      expect(formatCount(undefined)).toBe(MISSING_VALUE_GLYPH);
    });
  });

  describe("formatProvenance", () => {
    it("returns markdown bullet line for defined values", () => {
      expect(formatProvenance("Run ID", "abc")).toBe("- **Run ID:** abc");
      expect(formatProvenance("Model", "m")).toBe("- **Model:** m");
    });
    it("returns null for undefined values (so reporter omits the line)", () => {
      expect(formatProvenance("Run ID", undefined)).toBeNull();
    });
    it("includes empty-string values as-is (they are not undefined)", () => {
      expect(formatProvenance("Foo", "")).toBe("- **Foo:** ");
    });
  });

  describe("MISSING_VALUE_GLYPH", () => {
    it("is the em-dash character", () => {
      expect(MISSING_VALUE_GLYPH).toBe("—");
    });
  });
});
