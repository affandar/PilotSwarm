import { describe, it } from "vitest";
import { PilotSwarmSession, PilotSwarmClient } from "../../src/client.js";
import { PilotSwarmManagementClient } from "../../src/management-client.js";
import { assertEqual, assert } from "../helpers/assertions.js";

/**
 * Unit-level tests for the cancelPendingMessage API surface.
 *
 * Verifies that PilotSwarmSession, PilotSwarmClient, and
 * PilotSwarmManagementClient all enqueue the same tombstone envelope shape
 * (`{ cancelPending: ["id", ...] }`) on the same durable `messages` queue.
 *
 * No database or live duroxide required — uses a fake duroxide client.
 */

function createFakeDuroxideClient() {
    const calls = [];
    return {
        calls,
        enqueueEvent: async (orchestrationId, queue, payload) => {
            calls.push({ orchestrationId, queue, payload: JSON.parse(payload) });
        },
    };
}

describe("cancelPendingMessage API surface", () => {
    it("PilotSwarmSession.cancelPendingMessage enqueues tombstone on the session's orchestration", async () => {
        const fake = createFakeDuroxideClient();
        const fakeClient = { _getDuroxideClient: () => fake };

        const session = new PilotSwarmSession("sess-abc", fakeClient);
        await session.cancelPendingMessage(["msg:1", "msg:2"]);

        assertEqual(fake.calls.length, 1, "session cancel should enqueue exactly once");
        assertEqual(fake.calls[0].orchestrationId, "session-sess-abc", "session cancel should target session-<sessionId>");
        assertEqual(fake.calls[0].queue, "messages", "session cancel should use the messages queue");
        const payload = fake.calls[0].payload;
        assertEqual(Array.isArray(payload.cancelPending), true, "payload should carry the cancelPending field");
        assertEqual(payload.cancelPending.length, 2, "payload should include both ids");
        assert(payload.cancelPending.includes("msg:1"), "payload should include msg:1");
        assert(payload.cancelPending.includes("msg:2"), "payload should include msg:2");
    });

    it("PilotSwarmSession.cancelPendingMessage prefers lastOrchestrationId when set", async () => {
        const fake = createFakeDuroxideClient();
        const fakeClient = { _getDuroxideClient: () => fake };

        const session = new PilotSwarmSession("sess-abc", fakeClient);
        session.lastOrchestrationId = "session-sess-abc-resumed";
        await session.cancelPendingMessage(["msg:7"]);

        assertEqual(fake.calls[0].orchestrationId, "session-sess-abc-resumed", "cancel should target the resumed orchestration id");
    });

    it("PilotSwarmSession.cancelPendingMessage is a no-op for empty input", async () => {
        const fake = createFakeDuroxideClient();
        const fakeClient = { _getDuroxideClient: () => fake };

        const session = new PilotSwarmSession("sess-abc", fakeClient);
        await session.cancelPendingMessage([]);
        await session.cancelPendingMessage([null, undefined, ""]);

        assertEqual(fake.calls.length, 0, "no enqueue should occur for empty/invalid id input");
    });

    it("PilotSwarmSession.cancelPendingMessage is a no-op when duroxide client is not yet started", async () => {
        const fakeClient = { _getDuroxideClient: () => null };

        const session = new PilotSwarmSession("sess-abc", fakeClient);
        // Should not throw.
        await session.cancelPendingMessage(["msg:1"]);
    });

    it("PilotSwarmClient.cancelPendingMessage forwards to the duroxide client when started", async () => {
        const fake = createFakeDuroxideClient();
        const client = new PilotSwarmClient({});
        client.duroxideClient = fake;

        await client.cancelPendingMessage("sess-xyz", ["msg:42"]);

        assertEqual(fake.calls.length, 1, "client cancel should enqueue exactly once");
        assertEqual(fake.calls[0].orchestrationId, "session-sess-xyz", "client cancel should target session-<sessionId>");
        assertEqual(fake.calls[0].queue, "messages", "client cancel should use the messages queue");
        const payload = fake.calls[0].payload;
        assertEqual(payload.cancelPending[0], "msg:42", "payload should include the cancelled id");
    });

    it("PilotSwarmClient.cancelPendingMessage is a no-op for empty ids", async () => {
        const fake = createFakeDuroxideClient();
        const client = new PilotSwarmClient({});
        client.duroxideClient = fake;

        await client.cancelPendingMessage("sess-xyz", []);
        assertEqual(fake.calls.length, 0, "empty ids should not enqueue anything");
    });

    it("PilotSwarmManagementClient.cancelPendingMessage funnels through the same low-level enqueue", async () => {
        const fake = createFakeDuroxideClient();
        const mgmt = new PilotSwarmManagementClient({});
        mgmt._duroxideClient = fake;
        mgmt._started = true;

        await mgmt.cancelPendingMessage("sess-mgmt", ["msg:99", "msg:100"]);

        assertEqual(fake.calls.length, 1, "mgmt cancel should enqueue exactly once");
        assertEqual(fake.calls[0].orchestrationId, "session-sess-mgmt", "mgmt cancel should target session-<sessionId>");
        assertEqual(fake.calls[0].queue, "messages", "mgmt cancel should use the messages queue");
        const payload = fake.calls[0].payload;
        assertEqual(payload.cancelPending.length, 2, "payload should include both ids");
    });

    it("PilotSwarmManagementClient.cancelPendingMessage is a no-op for empty ids", async () => {
        const fake = createFakeDuroxideClient();
        const mgmt = new PilotSwarmManagementClient({});
        mgmt._duroxideClient = fake;
        mgmt._started = true;

        await mgmt.cancelPendingMessage("sess-mgmt", []);
        assertEqual(fake.calls.length, 0, "empty ids should not enqueue anything");
    });

    it("all three API surfaces produce byte-identical envelope shapes", async () => {
        const fakeSession = createFakeDuroxideClient();
        const fakeClient = createFakeDuroxideClient();
        const fakeMgmt = createFakeDuroxideClient();

        const session = new PilotSwarmSession("sess-shape", { _getDuroxideClient: () => fakeSession });
        const client = new PilotSwarmClient({});
        client.duroxideClient = fakeClient;
        const mgmt = new PilotSwarmManagementClient({});
        mgmt._duroxideClient = fakeMgmt;
        mgmt._started = true;

        await session.cancelPendingMessage(["msg:a", "msg:b"]);
        await client.cancelPendingMessage("sess-shape", ["msg:a", "msg:b"]);
        await mgmt.cancelPendingMessage("sess-shape", ["msg:a", "msg:b"]);

        const sessionPayload = JSON.stringify(fakeSession.calls[0].payload);
        const clientPayload = JSON.stringify(fakeClient.calls[0].payload);
        const mgmtPayload = JSON.stringify(fakeMgmt.calls[0].payload);

        assertEqual(sessionPayload, clientPayload, "session and client payloads must match");
        assertEqual(clientPayload, mgmtPayload, "client and mgmt payloads must match");
        assertEqual(sessionPayload, '{"cancelPending":["msg:a","msg:b"]}', "envelope shape must be the canonical tombstone JSON");
    });
});
