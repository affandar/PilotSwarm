import type { DurabilityExpected, DurabilityObservation, Score } from "../types.js";

/**
 * Score a `DurabilityObservation` against `DurabilityExpected`.
 *
 * IMPORTANT: This grader does NOT verify that crashes / recovery actually
 * happened — it scores the values in `observed` as supplied. Producers of
 * `DurabilityObservation` decide truthfulness:
 *   - `DurabilityFixtureDriver` derives values from a JSON script; passing
 *     scores measure script structure, not real recovery (see that class's
 *     docstring for the production-vs-fixture distinction).
 *   - `ChaosDriver` + `LiveDriver` with real `beforeRunHook` worker.kill()
 *     produce real observations from observed runtime + CMS events.
 *
 * For production crash-recovery evidence, gate on the LIVE durability suite
 * (`test/durability-live.test.ts`) which reads CMS event log directly via
 * `session.getMessages()` and asserts distinct `workerNodeId` values across
 * cross-worker handoff. Do NOT rely on this grader against fixture-only
 * drivers as proof of durability in production.
 */
export function gradeDurability(
  observed: DurabilityObservation | undefined,
  expected: DurabilityExpected | undefined,
): Score[] {
  if (!expected) return [];
  if (!observed) {
    return [
      {
        name: "durability-missing",
        value: 0,
        pass: false,
        reason: "Expected durability observation but none found",
      },
    ];
  }

  const scores: Score[] = [];

  // 1. Recovery
  if (expected.mustRecover) {
    scores.push({
      name: "crash-recovery",
      value: observed.recovered ? 1 : 0,
      pass: observed.recovered,
      reason: observed.recovered
        ? "Recovered after fault"
        : `Failed to recover after ${observed.faultMode} at ${observed.faultPoint}`,
    });
  }

  // 2. Final state
  if (expected.finalStateIn && expected.finalStateIn.length > 0) {
    const state = observed.postRecoveryState;
    const stateOk = state !== undefined && expected.finalStateIn.includes(state);
    scores.push({
      name: "post-recovery-state",
      value: stateOk ? 1 : 0,
      pass: stateOk,
      reason: stateOk
        ? `State "${state}" is expected`
        : `State "${state ?? "undefined"}" not in [${expected.finalStateIn.join(", ")}]`,
      actual: state,
      expected: expected.finalStateIn,
    });
  }

  // 3. Tool calls after recovery
  if (expected.minToolCallsAfterRecovery !== undefined) {
    const ok = observed.toolCallsAfterRecovery >= expected.minToolCallsAfterRecovery;
    scores.push({
      name: "tool-calls-after-recovery",
      value: ok ? 1 : 0,
      pass: ok,
      reason: ok
        ? `${observed.toolCallsAfterRecovery} calls after recovery (min: ${expected.minToolCallsAfterRecovery})`
        : `Only ${observed.toolCallsAfterRecovery} calls after recovery (expected >= ${expected.minToolCallsAfterRecovery})`,
      actual: observed.toolCallsAfterRecovery,
      expected: expected.minToolCallsAfterRecovery,
    });
  }

  // 4. Timer accuracy
  if (expected.maxTimerDriftMs !== undefined) {
    if (observed.timerAccuracyMs === undefined) {
      scores.push({
        name: "timer-accuracy",
        value: 0,
        pass: false,
        reason: "Timer drift expected but timerAccuracyMs missing from observation",
        expected: expected.maxTimerDriftMs,
      });
    } else {
      const drift = Math.abs(observed.timerAccuracyMs);
      const tol = expected.maxTimerDriftMs;
      const ok = drift <= tol;
      const value = ok ? 1 : Math.max(0, 1 - drift / (tol * 2 || 1));
      scores.push({
        name: "timer-accuracy",
        value,
        pass: ok,
        reason: ok
          ? `Timer drift ${drift}ms within ${tol}ms tolerance`
          : `Timer drift ${drift}ms exceeds ${tol}ms tolerance`,
        actual: drift,
        expected: tol,
      });
    }
  }

  // 5. Dehydration / hydration
  if (expected.requireDehydrated) {
    const ok = observed.dehydrated === true;
    scores.push({
      name: "dehydration",
      value: ok ? 1 : 0,
      pass: ok,
      reason: ok ? "Session was dehydrated" : "Expected dehydration but not observed",
    });
  }
  if (expected.requireHydrated) {
    const ok = observed.hydrated === true;
    scores.push({
      name: "hydration",
      value: ok ? 1 : 0,
      pass: ok,
      reason: ok ? "Session was hydrated" : "Expected hydration but not observed",
    });
  }

  // 6. Worker handoff
  if (expected.requireWorkerHandoff) {
    const ok = observed.workerHandoff === true;
    scores.push({
      name: "worker-handoff",
      value: ok ? 1 : 0,
      pass: ok,
      reason: ok ? "Worker handoff occurred" : "Expected worker handoff but not observed",
    });
  }

  return scores;
}
