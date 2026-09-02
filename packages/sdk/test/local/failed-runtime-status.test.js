import { describe, it } from "vitest";
import { deriveStatusFromCmsAndRuntime, resolveStaleRunningRowRecovery, shouldSyncFailedStatus } from "../../src/session-status.ts";
import { assertEqual } from "../helpers/assertions.js";

describe("Failed runtime status sync", () => {
    it("prefers orchestration failure over stale CMS and custom running state", () => {
        const status = deriveStatusFromCmsAndRuntime({
            row: {
                sessionId: "s1",
                orchestrationId: "session-s1",
                title: null,
                state: "idle",
                model: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                lastActiveAt: null,
                deletedAt: null,
                currentIteration: 0,
                lastError: null,
                waitReason: null,
                parentSessionId: null,
                isSystem: false,
                agentId: null,
                splash: null,
            },
            customStatus: {
                status: "running",
                iteration: 2,
            },
            orchestrationStatus: "Failed",
        });

        assertEqual(status, "failed", "failed runtime should win over stale catalog/custom status");
    });

    it("requests CMS sync when runtime failed but row was not yet marked failed", () => {
        assertEqual(
            shouldSyncFailedStatus({
                rowState: "idle",
                status: "running",
                orchestrationStatus: "Failed",
            }),
            true,
            "stale non-failed rows should self-heal to failed",
        );

        assertEqual(
            shouldSyncFailedStatus({
                rowState: "failed",
                status: "failed",
                orchestrationStatus: "Failed",
            }),
            false,
            "already-synced failed rows should not churn",
        );
    });

    it("prefers live running orchestration over stale CMS error state when no runtime error status is present", () => {
        const status = deriveStatusFromCmsAndRuntime({
            row: {
                sessionId: "s2",
                orchestrationId: "session-s2",
                title: null,
                state: "error",
                model: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                lastActiveAt: null,
                deletedAt: null,
                currentIteration: 0,
                lastError: "Session not found",
                waitReason: null,
                parentSessionId: null,
                isSystem: false,
                agentId: null,
                splash: null,
            },
            customStatus: {},
            orchestrationStatus: "Running",
        });

        assertEqual(status, "running", "live running runtime should override stale CMS error");
    });
});

describe("Stale error row recovery on a running orchestration", () => {
    it("recovers a stale error row when the runtime reports no status", () => {
        assertEqual(
            resolveStaleRunningRowRecovery({ rowState: "error", status: undefined, orchestrationStatus: "Running" }),
            "running",
            "no runtime status: the row is stale and should be recovered",
        );
    });

    it("recovers to the runtime's own non-error status", () => {
        assertEqual(
            resolveStaleRunningRowRecovery({ rowState: "failed", status: "waiting", orchestrationStatus: "Running" }),
            "waiting",
        );
    });

    it("leaves the row alone when the runtime itself reports the error", () => {
        // The worker just wrote this row for a turn that ended in error while
        // the orchestration keeps running (retries pending). The detail read
        // reports "error" to the caller; rewriting the row to "running" made
        // the row-based list disagree with it on every poll.
        assertEqual(
            resolveStaleRunningRowRecovery({ rowState: "error", status: "error", orchestrationStatus: "Running" }),
            null,
        );
        assertEqual(
            resolveStaleRunningRowRecovery({ rowState: "error", status: "failed", orchestrationStatus: "Running" }),
            null,
        );
    });

    it("never touches a row that is not parked on error/failed, or a non-running orchestration", () => {
        assertEqual(resolveStaleRunningRowRecovery({ rowState: "idle", status: undefined, orchestrationStatus: "Running" }), null);
        assertEqual(resolveStaleRunningRowRecovery({ rowState: "error", status: undefined, orchestrationStatus: "Completed" }), null);
    });
});

