import { hasTurnExpectedCriteria } from "../types.js";
import type {
  EvalExpected,
  ObservedResult,
  ObservedTrajectory,
  Score,
  TrajectorySample,
  TrajectoryScore,
} from "../types.js";
import { gradeEvalCase } from "./index.js";

type ContextRetentionMatch = "explicit-tool-arg" | "inferred-tool-arg" | "lexical" | "none";
type ContextRetentionRule = NonNullable<
  NonNullable<TrajectorySample["expected"]>["contextRetention"]
>[number];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * F8: Unicode-aware containment for context-retention lexical fallback.
 *
 * `\b` ASCII word boundaries don't help for terms like `C++`, `C#`, `.NET`,
 * or non-ASCII strings (`東京`, `café`). Strategy:
 *   - If the term contains any non-ASCII character, use plain substring match.
 *   - Otherwise, build a regex with explicit boundary character classes that
 *     treat `\p{L}\p{N}_+#` as "token chars" (not boundaries) so that:
 *       - `C++` matches at end-of-string and before non-token punctuation.
 *       - `C#` matches without being broken by the `#`.
 *       - `.NET` matches at start-of-string and after whitespace (the `.` is
 *         the first character of the term itself, not a boundary char).
 *       - "Osaka" still matches in "Osaka." because `.` is a boundary char.
 *       - Bare "C" does NOT match inside "C++" because the trailing `+` is a
 *         token char, not a boundary.
 */
function termMatchesHaystack(term: string, haystack: string): boolean {
  if (term.length === 0) return false;
  if (/[^\x00-\x7F]/.test(term)) {
    return haystack.includes(term);
  }
  const escaped = escapeRegExp(term);
  const re = new RegExp(
    `(?:^|[^\\p{L}\\p{N}_+#])${escaped}(?:$|[^\\p{L}\\p{N}_+#])`,
    "iu",
  );
  return re.test(haystack);
}

function prefix(scores: Score[], p: string): Score[] {
  return scores.map((s) => ({ ...s, name: `${p}${s.name}` }));
}

function valueAtPath(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function containsArgValue(value: unknown, expected: string): boolean {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => containsArgValue(item, expected));
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((item) => containsArgValue(item, expected));
  }
  return false;
}

function contextRetentionReason(
  cr: ContextRetentionRule,
  found: boolean,
  matchedBy: ContextRetentionMatch,
): string {
  if (cr.requireToolArgUse) {
    return found
      ? `"${cr.term}" used as ${cr.requireToolArgUse.toolName}.${cr.requireToolArgUse.argPath} after turn ${cr.mustAppearAfterTurn}`
      : `"${cr.term}" not used as ${cr.requireToolArgUse.toolName}.${cr.requireToolArgUse.argPath} after turn ${cr.mustAppearAfterTurn}`;
  }
  if (matchedBy === "inferred-tool-arg") {
    return `"${cr.term}" retained via tool argument after turn ${cr.mustAppearAfterTurn}`;
  }
  if (matchedBy === "lexical") {
    return `"${cr.term}" retained after turn ${cr.mustAppearAfterTurn} via lexical regex`;
  }
  return found
    ? `"${cr.term}" retained after turn ${cr.mustAppearAfterTurn}`
    : `"${cr.term}" not found after turn ${cr.mustAppearAfterTurn}`;
}

export function gradeTrajectory(
  observed: ObservedTrajectory,
  sample: TrajectorySample,
): TrajectoryScore {
  const turnScores: Score[][] = [];

  for (let i = 0; i < sample.turns.length; i++) {
    const turn = sample.turns[i];
    const observedTurn = observed.turns[i];
    if (!observedTurn) {
      turnScores.push([
        {
          name: `t${i + 1}/missing`,
          value: 0,
          pass: false,
          reason: `Turn ${i + 1} not observed`,
        },
      ]);
      continue;
    }

    const turnObserved: ObservedResult = {
      toolCalls: observedTurn.toolCalls,
      finalResponse: observedTurn.response,
      sessionId: observed.sessionId,
      latencyMs: observedTurn.latencyMs,
      model: observed.model,
    };

    const turnExpected: EvalExpected = {
      toolCalls: turn.expected.toolCalls,
      toolSequence: turn.expected.toolSequence ?? "unordered",
      forbiddenTools: turn.expected.forbiddenTools,
      noToolCall: turn.expected.noToolCall,
      response: turn.expected.response,
    };

    if (!hasTurnExpectedCriteria(turn.expected)) {
      turnScores.push([
        {
          name: `t${i + 1}/expected-criteria`,
          value: 0,
          pass: false,
          reason: `Turn ${i + 1} has no expected criteria`,
          infraError: true,
          infraSource: "grader",
        },
      ]);
      continue;
    }

    const raw = gradeEvalCase(turnObserved, turnExpected);
    if (raw.length === 0) {
      turnScores.push([
        {
          name: `t${i + 1}/expected-criteria`,
          value: 0,
          pass: false,
          reason: `Turn ${i + 1} emitted no grading criteria`,
          infraError: true,
          infraSource: "grader",
        },
      ]);
      continue;
    }
    turnScores.push(prefix(raw, `t${i + 1}/`));
  }

  // Cross-turn: context retention
  const crossTurnScores: Score[] = [];
  if (sample.expected?.contextRetention) {
    for (const cr of sample.expected.contextRetention) {
      const after = observed.turns.slice(cr.mustAppearAfterTurn + 1);
      let matchedBy: ContextRetentionMatch = "none";
      let found = false;
      if (cr.requireToolArgUse) {
        found = after.some((t) =>
          t.toolCalls.some((call) => {
            if (call.name !== cr.requireToolArgUse!.toolName) return false;
            return valueAtPath(call.args, cr.requireToolArgUse!.argPath) === cr.term;
          }),
        );
        matchedBy = found ? "explicit-tool-arg" : "none";
      } else {
        const shouldInferToolArgUse = (sample.tools?.length ?? 0) > 0;
        if (shouldInferToolArgUse) {
          found = after.some((t) =>
            t.toolCalls.some((call) => containsArgValue(call.args, cr.term)),
          );
          matchedBy = found ? "inferred-tool-arg" : "none";
        }
        if (!found) {
          // F8: Unicode-aware containment. \b boundaries don't work for terms
          // containing '+', '#', '.', or non-ASCII letters. We use plain
          // substring match for non-ASCII terms, and a Unicode-aware boundary
          // regex (with '+', '#', '.' explicitly excluded) for ASCII terms so
          // that "C++", "C#", and ".NET" all match.
          const term = cr.term;
          found = after.some((t) => termMatchesHaystack(term, t.response));
          matchedBy = found ? "lexical" : "none";
          if (found) {
            console.warn(
              `contextRetention matched only via lexical regex on "${cr.term}" — this can pass parroting agents. Configure requireToolArgUse for stronger validation, OR add a turn-end response check that requires the term in a meaningful semantic context.`,
            );
          }
        }
      }
      crossTurnScores.push({
        name: `context-retention/${cr.term}`,
        value: found ? 1 : 0,
        pass: found,
        reason: contextRetentionReason(cr, found, matchedBy),
      });
    }
  }

  // Holistic
  const holisticScores: Score[] = [];

  const expectedTurnCount = sample.turns.length;
  const observedTurnCount = observed.turns.length;
  const turnCountOk = observedTurnCount === expectedTurnCount;
  holisticScores.push({
    name: "turn-count",
    value: turnCountOk ? 1 : 0,
    pass: turnCountOk,
    reason: turnCountOk
      ? `${observedTurnCount} turns as expected`
      : `Expected ${expectedTurnCount} turns but observed ${observedTurnCount}`,
    actual: observedTurnCount,
    expected: expectedTurnCount,
  });

  if (sample.expected?.goalCompleted !== undefined) {
    const allTurnsPass =
      turnScores.length > 0 && turnScores.every((ts) => ts.every((s) => s.pass));
    const goalMet = allTurnsPass;
    const expectGoal = sample.expected.goalCompleted;
    const pass = goalMet === expectGoal;
    holisticScores.push({
      name: "goal-completed",
      value: pass ? 1 : 0,
      pass,
      reason: expectGoal
        ? allTurnsPass
          ? "All turns passed"
          : "Some turns failed"
        : allTurnsPass
          ? "Expected goal not to be completed, but all turns passed"
          : "Goal correctly not completed",
    });
  }
  if (sample.expected?.maxTotalToolCalls !== undefined) {
    const totalCalls = observed.turns.reduce((sum, t) => sum + t.toolCalls.length, 0);
    const budget = sample.expected.maxTotalToolCalls;
    const ok = totalCalls <= budget;
    holisticScores.push({
      name: "call-budget",
      value: ok ? 1 : 0,
      pass: ok,
      reason: ok
        ? `${totalCalls} calls within budget of ${budget}`
        : `${totalCalls} calls exceeds budget of ${budget}`,
      actual: totalCalls,
      expected: budget,
    });
  }

  return { turnScores, crossTurnScores, holisticScores };
}
