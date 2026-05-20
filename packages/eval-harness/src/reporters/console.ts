import type { Reporter } from "../registry.js";

export const consoleReporter: Reporter = {
  emit(result) {
    console.log(`Eval run ${result.runId}: ${result.passed} passed, ${result.failed} failed, ${result.infraErrors} infra errors`);
  }
};
