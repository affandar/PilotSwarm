/**
 * Shared durable-session orchestration version constants.
 *
 * The latest version is the canonical target for new starts and every
 * continue-as-new handoff. Frozen orchestration files keep their own
 * CURRENT_ORCHESTRATION_VERSION for replay/tracing, but must not hard-code
 * the latest target themselves.
 *
 * The compatibility floor documents the oldest orchestration input wire
 * format that the latest handler must continue to normalize while that
 * version remains registered in the repo.
 *
 * @internal
 */
export const DURABLE_SESSION_LATEST_VERSION = "1.0.52";
export const DURABLE_SESSION_COMPATIBILITY_FLOOR_VERSION = "1.0.47";
