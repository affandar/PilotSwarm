import { describe, it } from "vitest";
import { PilotSwarmClient } from "../../src/client.js";
import { assertEqual } from "../helpers/assertions.js";

describe("PilotSwarmClient wait status handling", () => {
    it("resets a stale status cursor when fallback getStatus observes a lower version", async () => {
        const client = new PilotSwarmClient({});
        const observedVersions = [];
        client.lastSeenStatusVersion.set("session-reset", 20);
        client.lastSeenIteration.set("session-reset", 1);
        client.lastSeenResponseVersion.set("session-reset", 1);
        client.duroxideClient = {
            waitForStatusChange: async (_orchestrationId, afterVersion) => {
                observedVersions.push(afterVersion);
                if (afterVersion === 0) {
                    return {
                        status: "Running",
                        customStatusVersion: 2,
                        customStatus: JSON.stringify({
                            status: "idle",
                            iteration: 2,
                            responseVersion: 2,
                        }),
                    };
                }
                return {
                    status: "Running",
                    customStatusVersion: afterVersion,
                    customStatus: JSON.stringify({
                        status: "running",
                        iteration: 1,
                        responseVersion: 1,
                    }),
                };
            },
            getStatus: async () => ({
                status: "Running",
                customStatusVersion: 1,
                customStatus: JSON.stringify({
                    status: "running",
                    iteration: 1,
                    responseVersion: 1,
                }),
            }),
            getValue: async () => JSON.stringify({
                type: "completed",
                content: "Recovered after status reset",
                version: 2,
            }),
        };

        const response = await client._waitForTurnResult_external(
            "session-reset",
            "reset",
            undefined,
            2_000,
        );

        assertEqual(response, "Recovered after status reset", "wait should recover after observing a lower status version");
        assertEqual(observedVersions.includes(0), true, "wait should retry from version 0 after the fallback detects a reset");
    });
});
