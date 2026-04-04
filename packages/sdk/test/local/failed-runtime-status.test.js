import { describe, it } from "vitest";
import { deriveStatusFromCmsAndRuntime, shouldSyncFailedStatus } from "../../src/session-status.ts";
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
