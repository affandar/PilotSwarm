import { describe, it, expect } from "vitest";
import {
  passAtK,
  meanStddev,
  wilsonInterval,
  bootstrapCI,
  mcNemarTest,
  mannWhitneyU,
} from "../src/stats.js";

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("passAtK", () => {
  it("computes pass@k correctly across boundary cases (all-pass, all-fail, partial, n-c<k, single)", () => {
    expect(passAtK([true, true, true], 1)).toBe(1.0);
    expect(passAtK([false, false, false], 1)).toBe(0.0);
    expect(passAtK([true, false, false, false, false], 1)).toBeCloseTo(0.2, 10);
    const ten = [true, true, false, false, false, false, false, false, false, false];
    expect(passAtK(ten, 3)).toBeCloseTo(1 - 56 / 120, 10);
    expect(passAtK([true, true, true, true, false], 3)).toBe(1.0); // n-c < k
    expect(passAtK([true], 1)).toBe(1.0);
    expect(passAtK([false], 1)).toBe(0.0);
  });

  it("validates inputs: empty/k=0/k>n/non-integer/negative all throw", () => {
    expect(() => passAtK([], 1)).toThrow();
    expect(() => passAtK([true], 0)).toThrow();
    expect(() => passAtK([true], 2)).toThrow();
    expect(() => passAtK([true], 1.5)).toThrow();
    expect(() => passAtK([true], -1)).toThrow();
  });
});

describe("meanStddev", () => {
  it("computes mean and sample stddev correctly across normal/single/empty/identical/negative", () => {
    const r = meanStddev([1, 2, 3, 4, 5]);
    expect(r.mean).toBeCloseTo(3, 10);
    expect(r.stddev).toBeCloseTo(Math.sqrt(2.5), 10);
    expect(r.n).toBe(5);

    const single = meanStddev([10]);
    expect(single.mean).toBe(10);
    expect(single.stddev).toBe(0);

    const empty = meanStddev([]);
    expect(Number.isNaN(empty.mean)).toBe(true);
    expect(Number.isNaN(empty.stddev)).toBe(true);
    expect(empty.n).toBe(0);

    expect(meanStddev([1, 1, 1, 1]).stddev).toBe(0);

    const neg = meanStddev([-2, -1, 0, 1, 2]);
    expect(neg.mean).toBeCloseTo(0, 10);
    expect(neg.stddev).toBeCloseTo(Math.sqrt(2.5), 10);
  });

  it("rejects non-finite inputs (NaN, Infinity)", () => {
    expect(() => meanStddev([1, NaN, 3])).toThrow();
    expect(() => meanStddev([1, Infinity, 3])).toThrow();
  });
});

describe("wilsonInterval", () => {
  it("computes Wilson CI: known midpoint + boundary cases (0/n, n/n, 0/0) and clamps to [0,1]", () => {
    const r = wilsonInterval(50, 100, 1.96);
    expect(r.point).toBeCloseTo(0.5, 10);
    expect(r.lower).toBeCloseTo(0.4038, 3);
    expect(r.upper).toBeCloseTo(0.5962, 3);
    expect(r.z).toBe(1.96);

    expect(wilsonInterval(50, 100).z).toBeCloseTo(1.959964, 5);

    const zeroN = wilsonInterval(0, 10);
    expect(zeroN.lower).toBe(0);
    expect(zeroN.upper).toBeGreaterThan(0);
    expect(zeroN.point).toBe(0);

    const fullN = wilsonInterval(10, 10);
    expect(fullN.upper).toBe(1);
    expect(fullN.lower).toBeLessThan(1);
    expect(fullN.point).toBe(1);

    const empty = wilsonInterval(0, 0);
    expect(empty.lower).toBe(0);
    expect(empty.upper).toBe(1);
    expect(empty.point).toBe(0);

    const half = wilsonInterval(1, 2);
    expect(half.lower).toBeGreaterThanOrEqual(0);
    expect(half.upper).toBeLessThanOrEqual(1);
  });

  it("rejects invalid counts (negative passes/total, passes>total)", () => {
    expect(() => wilsonInterval(-1, 10)).toThrow();
    expect(() => wilsonInterval(1, -1)).toThrow();
    expect(() => wilsonInterval(11, 10)).toThrow();
  });
});

describe("bootstrapCI", () => {
  it("degenerate, deterministic-seeded, empty, and single-value all behave correctly", () => {
    const deg = bootstrapCI([5, 5, 5, 5], 0.05, 500, mulberry32(1));
    expect(deg.lower).toBe(5);
    expect(deg.upper).toBe(5);
    expect(deg.point).toBe(5);
    expect(deg.reps).toBe(500);
    expect(deg.alpha).toBe(0.05);

    const ra = bootstrapCI([1, 2, 3, 4, 5], 0.05, 1000, mulberry32(42));
    const rb = bootstrapCI([1, 2, 3, 4, 5], 0.05, 1000, mulberry32(42));
    expect(ra.lower).toBe(rb.lower);
    expect(ra.upper).toBe(rb.upper);
    expect(ra.lower).toBeLessThan(ra.point);
    expect(ra.upper).toBeGreaterThan(ra.point);
    expect(ra.point).toBeCloseTo(3, 10);

    const empty = bootstrapCI([], 0.05, 100, mulberry32(1));
    expect(Number.isNaN(empty.lower)).toBe(true);
    expect(Number.isNaN(empty.upper)).toBe(true);

    const single = bootstrapCI([7], 0.05, 100, mulberry32(1));
    expect(single.lower).toBe(7);
    expect(single.upper).toBe(7);
  });

  it("validates alpha range, finite values, and rep counts; uses defaults when omitted", () => {
    expect(() => bootstrapCI([1, 2, 3], 0, 100, mulberry32(1))).toThrow();
    expect(() => bootstrapCI([1, 2, 3], 1, 100, mulberry32(1))).toThrow();
    expect(() => bootstrapCI([1, NaN, 3], 0.05, 100, mulberry32(1))).toThrow();
    expect(() => bootstrapCI([1, 2, 3], 0.05, 0)).toThrow();
    expect(() => bootstrapCI([1, 2, 3], 0.05, -1)).toThrow();
    expect(() => bootstrapCI([1, 2, 3], 0.05, 2.5)).toThrow();

    const r = bootstrapCI([1, 2, 3, 4, 5], undefined, undefined, mulberry32(1));
    expect(r.alpha).toBe(0.05);
    expect(r.reps).toBe(10_000);
  });
});

describe("mcNemarTest", () => {
  it("concordant-only / empty / single-pair return p=1, b=c=0", () => {
    expect(mcNemarTest([]).pValue).toBe(1.0);
    const concordant = mcNemarTest([
      [true, true],
      [false, false],
    ]);
    expect(concordant.b).toBe(0);
    expect(concordant.c).toBe(0);
    expect(concordant.pValue).toBe(1.0);
    expect(mcNemarTest([[true, true]]).pValue).toBe(1.0);
    expect(mcNemarTest([[true, false]]).pValue).toBe(1.0);
  });

  it("small-discordant uses exact binomial; large uses chi²-yates; extreme regressions are highly significant", () => {
    const small: Array<[boolean, boolean]> = [];
    small.push([true, false]);
    for (let i = 0; i < 9; i++) small.push([false, true]);
    const sm = mcNemarTest(small);
    expect(sm.method).toBe("exact");
    expect(sm.b).toBe(1);
    expect(sm.c).toBe(9);
    expect(sm.pValue).toBeCloseTo(22 / 1024, 6);

    const large: Array<[boolean, boolean]> = [];
    for (let i = 0; i < 15; i++) large.push([true, false]);
    for (let i = 0; i < 35; i++) large.push([false, true]);
    const lg = mcNemarTest(large);
    expect(lg.method).toBe("chi2-yates");
    expect(lg.statistic).toBeCloseTo(Math.pow(Math.abs(15 - 35) - 1, 2) / 50, 10);
    expect(lg.pValue).toBeLessThan(0.01);

    const allRegress: Array<[boolean, boolean]> = [];
    for (let i = 0; i < 10; i++) allRegress.push([true, false]);
    expect(mcNemarTest(allRegress).pValue).toBeCloseTo(2 / 1024, 8);
  });

  it("exact flag overrides default method selection", () => {
    const big: Array<[boolean, boolean]> = [];
    for (let i = 0; i < 15; i++) big.push([true, false]);
    for (let i = 0; i < 35; i++) big.push([false, true]);
    expect(mcNemarTest(big, { exact: true }).method).toBe("exact");

    const small: Array<[boolean, boolean]> = [
      [true, false],
      [false, true],
      [false, true],
    ];
    expect(mcNemarTest(small, { exact: false }).method).toBe("chi2-yates");
  });
});

describe("mannWhitneyU", () => {
  it("complete separation and exact p-values for small untied samples (with symmetry)", () => {
    const sep = mannWhitneyU([1, 2, 3], [4, 5, 6]);
    expect(sep.u).toBe(0);
    expect(sep.n1).toBe(3);
    expect(sep.n2).toBe(3);
    expect(sep.pValue).toBeCloseTo(0.1, 4);

    expect(mannWhitneyU([1, 2], [3]).pValue).toBeCloseTo(2 / 3, 12);
    expect(mannWhitneyU([3, 4], [1]).pValue).toBeCloseTo(2 / 3, 12);
    expect(mannWhitneyU([3], [1, 2]).pValue).toBeCloseTo(2 / 3, 12);
    expect(mannWhitneyU([10, 11, 12], [1, 2, 3]).pValue).toBeCloseTo(0.1, 12);

    // symmetry
    const f = mannWhitneyU([1, 3, 5, 7], [2, 4, 6, 8]);
    const r = mannWhitneyU([2, 4, 6, 8], [1, 3, 5, 7]);
    expect(f.pValue).toBeCloseTo(r.pValue, 12);

    expect(mannWhitneyU([1, 2], [3, 4]).pValue).toBeCloseTo(1 / 3, 3);
  });

  it("falls back to asymptotic for larger n or when ties exist even at small n", () => {
    const a = Array.from({ length: 10 }, (_, i) => i);
    const b = Array.from({ length: 10 }, (_, i) => i + 10);
    expect(mannWhitneyU(a, b).pValue).toBeLessThan(0.001);

    const tied = mannWhitneyU([1, 1, 2], [2, 3, 3]);
    expect(tied.pValue).toBeGreaterThan(0);
    expect(tied.pValue).toBeLessThan(1);
  });

  it("identical samples / all-tied / empty / single each side handled correctly; u1+u2 = n1*n2", () => {
    const id = mannWhitneyU([1, 2, 3], [1, 2, 3]);
    expect(id.u).toBeCloseTo(4.5, 10);
    expect(id.pValue).toBeCloseTo(1.0, 5);

    const allTied = mannWhitneyU([5, 5, 5], [5, 5, 5]);
    expect(allTied.z).toBe(0);
    expect(allTied.pValue).toBe(1);

    const empty = mannWhitneyU([], [1, 2, 3]);
    expect(Number.isNaN(empty.u)).toBe(true);
    expect(Number.isNaN(empty.pValue)).toBe(true);
    expect(Number.isNaN(empty.z)).toBe(true);

    const single = mannWhitneyU([1], [2]);
    expect(single.n1).toBe(1);
    expect(single.n2).toBe(1);
    expect(single.u).toBe(0);

    const sum = mannWhitneyU([1, 3, 5, 7], [2, 4, 6, 8, 10]);
    expect(sum.u1 + sum.u2).toBe(4 * 5);
    expect(sum.u).toBe(Math.min(sum.u1, sum.u2));
  });

  it("rejects non-finite input", () => {
    expect(() => mannWhitneyU([1, NaN], [2, 3])).toThrow();
    expect(() => mannWhitneyU([1, 2], [Infinity])).toThrow();
  });
});
