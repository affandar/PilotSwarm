import type { ObservedToolCall } from "../types.js";
import type { EvalToolTracker } from "../fixtures/eval-tools.js";

export function extractObservedCalls(tracker: EvalToolTracker): ObservedToolCall[] {
  return tracker.invocations.map((inv) => ({
    name: inv.name,
    args: inv.args,
    result: inv.result,
    timestamp: inv.timestamp,
    order: inv.order,
  }));
}
