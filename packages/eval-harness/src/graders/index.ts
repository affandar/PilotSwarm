import type { EvalExpected, ObservedResult, Score } from "../types.js";
import { matchArgs } from "./match-args.js";
import { gradeToolSelection } from "./tool-selection.js";
import { gradeOrdering } from "./ordering.js";
import { gradeResponse } from "./response.js";
import { gradeCmsState } from "./cms-state.js";
import { gradeDurability } from "./durability.js";

export { matchArgs, sortKeys } from "./match-args.js";
export { gradeToolSelection } from "./tool-selection.js";
export { gradeOrdering } from "./ordering.js";
export { gradeResponse } from "./response.js";
export { gradeCmsState } from "./cms-state.js";
export { gradeDurability } from "./durability.js";
export {
  gradeNoSecretLeak,
  findSecretLeaks,
  SecretLeakPatterns,
} from "./secret-leak.js";
export type { SecretLeakOptions, SecretLeakHit } from "./secret-leak.js";

export function gradeEvalCase(observed: ObservedResult, expected: EvalExpected): Score[] {
  const scores: Score[] = [];

  scores.push(...gradeToolSelection(observed.toolCalls, expected));

  if (expected.toolCalls && expected.toolCalls.length > 0) {
    scores.push(gradeOrdering(observed.toolCalls, expected.toolCalls, expected.toolSequence ?? "unordered"));

    const argScores: Score[] = [];
    const consumed = new Set<number>();
    // Match the most-constrained expectations first so duplicates of the same
    // tool name don't get mis-paired by greedy declaration-order matching.
    // Stable sort: more specified args = matched earlier.
    const orderedExpected = expected.toolCalls
      .map((exp, declarationOrder) => ({ exp, declarationOrder }))
      .sort((a, b) => {
        const aKeys = a.exp.args ? Object.keys(a.exp.args).length : 0;
        const bKeys = b.exp.args ? Object.keys(b.exp.args).length : 0;
        if (aKeys !== bKeys) return bKeys - aKeys;
        return a.declarationOrder - b.declarationOrder;
      })
      .map(({ exp }) => exp);
    for (const exp of orderedExpected) {
      const candidates = observed.toolCalls
        .map((o, idx) => ({ o, idx }))
        .filter(({ o, idx }) => o.name === exp.name && !consumed.has(idx));
      if (candidates.length === 0) {
        argScores.push({
          name: `tool-args:${exp.name}`,
          value: 0,
          pass: false,
          reason: `no observed call to "${exp.name}" to match args against`,
          expected: exp.args,
        });
        continue;
      }
      let best = { pass: false, score: 0, diff: [] as string[] };
      let bestCall = candidates[0].o;
      let bestIdx = candidates[0].idx;
      for (const { o, idx } of candidates) {
        const r = matchArgs(o.args, exp.args, exp.match ?? "subset", {
          subsetCaseInsensitive: exp.subsetCaseInsensitive,
          numericTolerance: exp.numericTolerance,
          fuzzyStringMaxRelativeDistance: exp.fuzzyStringMaxRelativeDistance,
        });
        if (r.score > best.score || (r.pass && !best.pass)) {
          best = r;
          bestCall = o;
          bestIdx = idx;
        }
      }
      consumed.add(bestIdx);
      argScores.push({
        name: `tool-args:${exp.name}`,
        value: best.score,
        pass: best.pass,
        reason: best.pass
          ? `args matched (mode=${exp.match ?? "subset"})`
          : `args mismatch (mode=${exp.match ?? "subset"}): ${best.diff.join("; ")}`,
        actual: bestCall.args,
        expected: exp.args,
      });
    }
    scores.push(...argScores);
  }

  const responseScore = gradeResponse(observed.finalResponse, expected.response);
  if (responseScore) scores.push(responseScore);

  const cmsScore = gradeCmsState(observed.cmsState, expected.cms);
  if (cmsScore) scores.push(cmsScore);

  if (expected.durability || observed.durability) {
    scores.push(...gradeDurability(observed.durability, expected.durability));
  }

  return scores;
}
