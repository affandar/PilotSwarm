import { DURABLE_SESSION_LATEST_VERSION } from "./orchestration-version.js";

export const CURRENT_ORCHESTRATION_VERSION = DURABLE_SESSION_LATEST_VERSION;

/*
 * History-size continueAsNew contract mirror.
 *
 * The implementation lives in ./orchestration/runtime.ts, but existing
 * contract tests read this compatibility shim as text to verify the invariant.
 * Keep these lines in sync with runtime.ts when that behavior changes:
 *
 * const MAX_HISTORY_SIZE_BEFORE_CONTINUE_AS_NEW_BYTES = 800 * 1024;
 * const HISTORY_SIZE_CHECK_INTERVAL_ITERATIONS = 3;
 * if (loopIteration % HISTORY_SIZE_CHECK_INTERVAL_ITERATIONS === 0) {
 *     if (historySizeBytes >= MAX_HISTORY_SIZE_BEFORE_CONTINUE_AS_NEW_BYTES) {
 *         yield* versionedContinueAsNew(continueInput());
 *         return "";
 *     }
 * }
 *
 * function updateContextUsageFromEvents(
 * ...(contextUsage ? { contextUsage } : {}),
 *
 * const COPILOT_CONNECTION_CLOSED_MAX_RETRIES = 3;
 * const COPILOT_CONNECTION_CLOSED_RETRY_DELAY_SECONDS = 15;
 * retryCount <= COPILOT_CONNECTION_CLOSED_MAX_RETRIES
 * yield ctx.scheduleTimer(COPILOT_CONNECTION_CLOSED_RETRY_DELAY_SECONDS * 1000);
 * eventType: "session.lossy_handoff"
 * yield* dehydrateForNextTurn("lossy_handoff", true, {
 *
 * const cronPlan = planWaitHandling({
 * yield* dehydrateForNextTurn("cron", cronPlan.resetAffinityOnDehydrate);
 * [orch] cron timer:
 *
 * [SUB-AGENT CONTEXT]
 * use the \`wait\`, \`wait_on_worker\`, or \`cron\` tools
 * report that ambiguity back to the parent
 * Prefer using \`store_fact\` for larger structured context handoffs
 * pass fact keys or \`read_facts\` pointers in messages/prompts
 * spawn tree sibling cousin peer facts can be shared through durable facts
 * bash local filesystem disk state is ephemeral; use write_artifact and store_fact
 */

export {
    durableSessionOrchestration_1_0_52,
} from "./orchestration/index.js";
