// Abramowitz & Stegun 7.1.26 — max error ~1.5e-7
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1.0 / (1.0 + p * ax);
  const y =
    1.0 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

export function standardNormalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function chiSquaredCdfDf1(x: number): number {
  if (x <= 0) return 0;
  return erf(Math.sqrt(x / 2));
}

function lgamma(x: number): number {
  // Lanczos approximation
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    return (
      Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x)
    );
  }
  x -= 1;
  let a = c[0]!;
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i]! / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function lnBinomial(k: number, n: number): number {
  if (k < 0 || k > n) return -Infinity;
  return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
}

function binomialPmf(k: number, n: number, p: number): number {
  if (k < 0 || k > n) return 0;
  if (p === 0) return k === 0 ? 1 : 0;
  if (p === 1) return k === n ? 1 : 0;
  const ln =
    lnBinomial(k, n) + k * Math.log(p) + (n - k) * Math.log(1 - p);
  return Math.exp(ln);
}

function binomialCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  let sum = 0;
  for (let i = 0; i <= k; i++) sum += binomialPmf(i, n, p);
  return Math.min(1, sum);
}

export function passAtK(results: boolean[], k: number): number {
  const n = results.length;
  if (n === 0) throw new Error("passAtK: empty results");
  if (!Number.isInteger(k)) throw new Error("passAtK: k must be an integer");
  if (k <= 0) throw new Error("passAtK: k must be > 0");
  if (k > n) throw new Error("passAtK: k must be <= n");
  let c = 0;
  for (const r of results) if (r) c++;
  if (n - c < k) return 1.0;
  // 1 - prod_{i=n-c+1..n} (1 - k/i)
  let prod = 1;
  for (let i = n - c + 1; i <= n; i++) prod *= 1 - k / i;
  return 1 - prod;
}

export function meanStddev(
  values: number[],
): { mean: number; stddev: number; n: number } {
  const n = values.length;
  if (n === 0) return { mean: NaN, stddev: NaN, n: 0 };
  for (const v of values) {
    if (!Number.isFinite(v)) throw new Error("meanStddev: non-finite value");
  }
  if (n === 1) return { mean: values[0]!, stddev: 0, n: 1 };
  // Welford
  let mean = 0;
  let m2 = 0;
  let count = 0;
  for (const v of values) {
    count++;
    const delta = v - mean;
    mean += delta / count;
    const delta2 = v - mean;
    m2 += delta * delta2;
  }
  const stddev = Math.sqrt(m2 / (n - 1));
  return { mean, stddev, n };
}

export function wilsonInterval(
  passes: number,
  total: number,
  z: number = 1.959964,
): { lower: number; upper: number; point: number; z: number } {
  if (!Number.isFinite(z) || z <= 0) {
    throw new Error(
      `wilsonInterval: z must be a finite positive number, got ${z}`,
    );
  }
  // H1 (iter19): bound z to a sane upper limit. Any reasonable confidence
  // level corresponds to z ≤ ~10 (z=10 ≈ ~1 in 10^23 tail probability). Huge
  // z values (e.g. 1e308) cause `z*z` to overflow to Infinity inside the
  // wilson formula and produce NaN bounds, which then propagate into Wilson
  // CIs throughout the harness. Reject early with a clear error.
  if (z > 100) {
    throw new Error(
      `wilsonInterval: z must be <= 100 (got ${z}); huge z values overflow to NaN bounds`,
    );
  }
  // iter18 F9: NaN/Infinity guards. `passes < 0` returns false for NaN, so
  // without an explicit `Number.isFinite` check `wilsonInterval(NaN, 10)`
  // would silently compute NaN bounds and propagate them into Wilson CIs
  // throughout the harness. Reject non-finite numerator/denominator loudly.
  if (!Number.isFinite(passes)) {
    throw new Error(`wilsonInterval: passes must be a finite number, got ${passes}`);
  }
  if (!Number.isFinite(total)) {
    throw new Error(`wilsonInterval: total must be a finite number, got ${total}`);
  }
  if (!Number.isInteger(passes)) {
    throw new Error(`wilsonInterval: passes must be an integer, got ${passes}`);
  }
  if (!Number.isInteger(total)) {
    throw new Error(`wilsonInterval: total must be an integer, got ${total}`);
  }
  if (passes < 0) throw new Error("wilsonInterval: passes < 0");
  if (total < 0) throw new Error("wilsonInterval: total < 0");
  if (passes > total) throw new Error("wilsonInterval: passes > total");
  if (total === 0) return { lower: 0, upper: 1, point: 0, z };
  const p = passes / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denom;
  const lower = passes === 0 ? 0 : Math.max(0, Math.min(1, center - margin));
  const upper = passes === total ? 1 : Math.max(0, Math.min(1, center + margin));
  // H1 (iter19): defense in depth — even with the z bound above, post-validate
  // that bounds are finite numbers in [0,1] before returning. Any non-finite
  // value here indicates a numeric edge case the bound did not catch.
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || !Number.isFinite(p)) {
    throw new Error(
      `wilsonInterval: produced non-finite output (lower=${lower}, upper=${upper}, point=${p}) for inputs passes=${passes}, total=${total}, z=${z}`,
    );
  }
  return { lower, upper, point: p, z };
}

/**
 * Bootstrap percentile confidence interval for the mean.
 * Uses the basic percentile method (Efron 1979), NOT BCa.
 * For symmetric or near-symmetric statistics (like eval score means),
 * percentile bootstrap is adequate. BCa would improve coverage for
 * skewed statistics but adds significant complexity.
 */
export function bootstrapCI(
  values: number[],
  alpha: number = 0.05,
  reps: number = 10_000,
  rng: () => number = Math.random,
): { lower: number; upper: number; point: number; reps: number; alpha: number } {
  if (!(alpha > 0 && alpha < 1)) {
    throw new Error("bootstrapCI: alpha must be in (0,1)");
  }
  if (!Number.isInteger(reps) || reps <= 0) {
    throw new Error("bootstrapCI: reps must be a positive integer");
  }
  const n = values.length;
  if (n === 0) {
    return { lower: NaN, upper: NaN, point: NaN, reps, alpha };
  }
  for (const v of values) {
    if (!Number.isFinite(v)) throw new Error("bootstrapCI: non-finite value");
  }
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / n;
  if (n === 1) {
    return { lower: values[0]!, upper: values[0]!, point: values[0]!, reps, alpha };
  }
  const means = new Float64Array(reps);
  for (let r = 0; r < reps; r++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      const u = rng();
      if (!Number.isFinite(u) || u < 0 || u >= 1) {
        throw new Error(
          `bootstrapCI: rng must return a finite number in [0, 1), got ${u}`,
        );
      }
      const idx = Math.floor(u * n);
      s += values[idx === n ? n - 1 : idx]!;
    }
    means[r] = s / n;
  }
  means.sort();
  const loIdx = Math.floor((alpha / 2) * reps);
  const hiIdx = Math.min(reps - 1, Math.ceil((1 - alpha / 2) * reps) - 1);
  return {
    lower: means[loIdx]!,
    upper: means[hiIdx]!,
    point: mean,
    reps,
    alpha,
  };
}

export function mcNemarTest(
  paired: Array<[boolean, boolean]>,
  opts?: { exact?: "auto" | boolean },
): {
  pValue: number;
  statistic: number;
  b: number;
  c: number;
  method: "exact" | "chi2-yates";
} {
  let b = 0;
  let c = 0;
  for (const [baseline, current] of paired) {
    if (baseline && !current) b++;
    else if (!baseline && current) c++;
  }
  const n = b + c;
  const exactOpt = opts?.exact ?? "auto";
  const useExact =
    exactOpt === true || (exactOpt === "auto" && n < 25);
  if (n === 0) {
    return {
      pValue: 1.0,
      statistic: 0,
      b,
      c,
      method: useExact ? "exact" : "chi2-yates",
    };
  }
  if (useExact) {
    const m = Math.min(b, c);
    const p = Math.min(1, 2 * binomialCdf(m, n, 0.5));
    return { pValue: p, statistic: m, b, c, method: "exact" };
  }
  const diff = Math.max(0, Math.abs(b - c) - 1);
  const chi2 = (diff * diff) / n;
  const pValue = 1 - chiSquaredCdfDf1(chi2);
  return { pValue, statistic: chi2, b, c, method: "chi2-yates" };
}

export function mannWhitneyU(
  a: number[],
  b: number[],
): {
  u: number;
  u1: number;
  u2: number;
  z: number;
  pValue: number;
  n1: number;
  n2: number;
} {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 === 0 || n2 === 0) {
    return {
      u: NaN,
      u1: NaN,
      u2: NaN,
      z: NaN,
      pValue: NaN,
      n1,
      n2,
    };
  }
  for (const v of a) {
    if (!Number.isFinite(v)) throw new Error("mannWhitneyU: non-finite in a");
  }
  for (const v of b) {
    if (!Number.isFinite(v)) throw new Error("mannWhitneyU: non-finite in b");
  }
  type Tagged = { v: number; src: 0 | 1 };
  const combined: Tagged[] = [];
  for (const v of a) combined.push({ v, src: 0 });
  for (const v of b) combined.push({ v, src: 1 });
  combined.sort((x, y) => x.v - y.v);
  const N = combined.length;
  const ranks = new Array<number>(N);
  const tieGroups: number[] = [];
  let i = 0;
  while (i < N) {
    let j = i;
    while (j + 1 < N && combined[j + 1]!.v === combined[i]!.v) j++;
    const avg = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k++) ranks[k] = avg;
    const groupSize = j - i + 1;
    if (groupSize > 1) tieGroups.push(groupSize);
    i = j + 1;
  }
  let r1 = 0;
  for (let k = 0; k < N; k++) {
    if (combined[k]!.src === 0) r1 += ranks[k]!;
  }
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const u2 = n1 * n2 - u1;
  const u = Math.min(u1, u2);

  const hasTies = tieGroups.length > 0;
  // Exact path enumerates C(n1+n2, n1) permutations; bound BOTH sides to keep
  // memory/time bounded. For asymmetric samples (e.g. n1=5, n2=100) the
  // asymptotic approximation is adequate and avoids pathological allocations.
  const useExact = !hasTies && n1 <= 8 && n2 <= 8;
  if (useExact) {
    const pValue = exactMannWhitneyP(u1, n1, n2);
    return { u, u1, u2, z: NaN, pValue, n1, n2 };
  }

  const meanU = (n1 * n2) / 2;
  let tieTerm = 0;
  for (const t of tieGroups) tieTerm += t * t * t - t;
  const varU =
    (n1 * n2 * (N + 1)) / 12 -
    (n1 * n2 * tieTerm) / (12 * N * (N - 1));
  if (varU <= 0) {
    return { u, u1, u2, z: 0, pValue: 1, n1, n2 };
  }
  const diff = u - meanU;
  const cc = diff > 0 ? -0.5 : diff < 0 ? 0.5 : 0;
  const z = (diff + cc) / Math.sqrt(varU);
  const pValue = 2 * (1 - standardNormalCdf(Math.abs(z)));
  return { u, u1, u2, z, pValue: Math.min(1, Math.max(0, pValue)), n1, n2 };
}

function exactUFrequencies(n1: number, n2: number): number[] {
  const maxU = n1 * n2;
  const out = new Array<number>(maxU + 1).fill(0);
  const totalRanks = n1 + n2;
  const rankSumOffset = (n1 * (n1 + 1)) / 2;

  function chooseRanks(nextRank: number, chosen: number, rankSum: number): void {
    if (chosen === n1) {
      const u = rankSum - rankSumOffset;
      out[u] = (out[u] ?? 0) + 1;
      return;
    }

    const remainingToChoose = n1 - chosen;
    const maxStart = totalRanks - remainingToChoose + 1;
    for (let rank = nextRank; rank <= maxStart; rank++) {
      chooseRanks(rank + 1, chosen + 1, rankSum + rank);
    }
  }

  chooseRanks(1, 0, 0);
  return out;
}

function exactMannWhitneyP(u1: number, n1: number, n2: number): number {
  const freq = exactUFrequencies(n1, n2);
  let total = 0;
  for (const v of freq) total += v;
  if (total === 0) return 1;
  const uIdx = Math.round(u1);
  let leftSum = 0;
  for (let u = 0; u <= uIdx && u < freq.length; u++) leftSum += freq[u]!;
  let rightSum = 0;
  for (let u = uIdx; u < freq.length; u++) rightSum += freq[u]!;
  const pLeft = leftSum / total;
  const pRight = rightSum / total;
  return Math.min(1, 2 * Math.min(pLeft, pRight));
}
