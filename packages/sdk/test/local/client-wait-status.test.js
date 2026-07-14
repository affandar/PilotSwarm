import { describe, expect, it } from "vitest";
import { PilotSwarmClient } from "../../src/client.js";
import { WebPilotSwarmSession } from "../../src/web/web-client.ts";
import { assertEqual } from "../helpers/assertions.js";

describe("PilotSwarmClient wait status handling", () => {
    it("raises a durable latest-response error instead of waiting for timeout", async () => {
        const client = new PilotSwarmClient({});
        client.duroxideClient = {
            waitForStatusChange: async () => ({
                status: "Running",
                customStatusVersion: 1,
                customStatus: JSON.stringify({
                    status: "error",
                    iteration: 0,
                    responseVersion: 1,
                    error: "Bad credentials — update the key in Admin",
                }),
            }),
            getValue: async () => JSON.stringify({
                schemaVersion: 1,
                version: 1,
                emittedAt: 1,
                iteration: 0,
                type: "error",
                content: "Bad credentials — update the key in Admin",
            }),
        };

        await expect(client._waitForTurnResult_external(
            "session-auth-error",
            "auth-error",
            undefined,
            1_000,
        )).rejects.toThrow("Bad credentials");
    });

    it("raises a web durable error response instead of waiting for timeout", async () => {
        const api = {
            call: async (method) => {
                if (method === "getSessionStatus") {
                    return { customStatusVersion: 0, customStatus: { iteration: 0, responseVersion: 0, status: "idle" } };
                }
                if (method === "sendMessage") return {};
                if (method === "waitForStatusChange") {
                    return {
                        customStatusVersion: 1,
                        customStatus: { iteration: 0, responseVersion: 1, status: "error" },
                        orchestrationStatus: "Running",
                    };
                }
                if (method === "getLatestResponse") {
                    return { type: "error", content: "Bad credentials — update the key in Admin", version: 1 };
                }
                throw new Error(`Unexpected API method: ${method}`);
            },
        };
        const session = new WebPilotSwarmSession("web-auth-error", api);

        await expect(session.sendAndWait("hi", 1_000)).rejects.toThrow("Bad credentials");
    });

    it("refreshes direct-client cursors before sendAndWait on a reused handle", async () => {
        const client = new PilotSwarmClient({});
        client.duroxideClient = {
            getStatus: async () => ({
                customStatusVersion: 9,
                customStatus: JSON.stringify({ iteration: 4, responseVersion: 4, status: "idle" }),
            }),
        };
        client._ensureOrchestrationAndSend = async () => {
            assertEqual(client.lastSeenStatusVersion.get("session-reused"), 9, "status cursor should refresh before enqueue");
            assertEqual(client.lastSeenIteration.get("session-reused"), 4, "iteration cursor should refresh before enqueue");
            assertEqual(client.lastSeenResponseVersion.get("session-reused"), 4, "response cursor should refresh before enqueue");
            return "session-reused";
        };
        client._waitForTurnResult = async () => "second response";

        const response = await client._startAndWait("reused", "second prompt", undefined, 1_000);
        assertEqual(response, "second response", "sendAndWait should wait from refreshed cursors");
    });

    it("refreshes web-client cursors after an unobserved fire-and-forget response", async () => {
        let completedResponses = 0;
        const statusSnapshots = [
            { customStatusVersion: 0, customStatus: { iteration: 0, responseVersion: 0, status: "idle" } },
            { customStatusVersion: 3, customStatus: { iteration: 1, responseVersion: 1, status: "idle" } },
        ];
        const api = {
            call: async (method, params) => {
                if (method === "getSessionStatus") return statusSnapshots.shift();
                if (method === "sendMessage") return {};
                if (method === "waitForStatusChange") {
                    assertEqual(params.afterVersion, 3, "second wait must start after the first completed turn");
                    return {
                        customStatusVersion: 4,
                        customStatus: { iteration: 2, responseVersion: 2, status: "idle" },
                        orchestrationStatus: "Running",
                    };
                }
                if (method === "getLatestResponse") {
                    completedResponses += 1;
                    return { type: "completed", content: "second response", version: 2 };
                }
                throw new Error(`Unexpected API method: ${method}`);
            },
        };
        const session = new WebPilotSwarmSession("web-reused", api);

        await session.send("first prompt");
        const response = await session.sendAndWait("second prompt", 1_000);

        assertEqual(response, "second response", "web sendAndWait should return the second response");
        assertEqual(completedResponses, 1, "only the post-refresh response should be read");
    });

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
