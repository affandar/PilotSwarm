import { beforeEach, describe, it } from "vitest";
import {
    replyInternalSessionMessage,
    resetSessionMessageRateLimitsForTests,
    sendInternalSessionMessage,
} from "../../src/session-messages.ts";
import { assert, assertEqual, assertIncludes, assertThrows } from "../helpers/assertions.js";

function session(sessionId, updates = {}) {
    return {
        sessionId,
        state: "running",
        parentSessionId: null,
        isSystem: false,
        ...updates,
    };
}

function createRuntime(rows) {
    const sessions = new Map(rows.map((row) => [row.sessionId, row]));
    const enqueued = [];
    const catalog = {
        async getSession(sessionId) {
            return sessions.get(sessionId) ?? null;
        },
    };
    const duroxideClient = {
        async getStatus(orchestrationId) {
            return { status: orchestrationId.startsWith("session-") ? "Running" : "NotFound" };
        },
        async enqueueEvent(orchestrationId, eventName, payload) {
            enqueued.push({ orchestrationId, eventName, payload: JSON.parse(payload) });
        },
    };
    return { runtime: { catalog, duroxideClient }, enqueued, sessions };
}

describe("Cross-session messaging", () => {
    beforeEach(() => {
        resetSessionMessageRateLimitsForTests();
    });

    it("routes a multi-agent conversation A -> B -> C -> A", async () => {
        const { runtime, enqueued } = createRuntime([
            session("A"),
            session("B"),
            session("C"),
        ]);

        const first = await sendInternalSessionMessage(runtime, {
            fromSessionId: "A",
            toSessionId: "B",
            subject: "Need context",
            body: "Ask C for the release signal and report back.",
            expectsResponse: true,
        });
        await sendInternalSessionMessage(runtime, {
            fromSessionId: "B",
            toSessionId: "C",
            subject: "Release signal",
            body: "A needs the latest release signal.",
            reason: "status-request",
        });
        await replyInternalSessionMessage(runtime, {
            requestId: first.requestId,
            fromSessionId: "C",
            toSessionId: "A",
            body: "Signal is green from C.",
        });

        assertEqual(enqueued.map((event) => event.orchestrationId).join(","), "session-B,session-C,session-A", "Messages should route around the A -> B -> C -> A loop");
        assertIncludes(enqueued[0].payload.prompt, "[SESSION_MESSAGE", "A -> B should enqueue a session message");
        assertIncludes(enqueued[0].payload.prompt, "from=A", "A -> B should identify the sender");
        assertIncludes(enqueued[0].payload.prompt, "expects_response=true", "A -> B should request a response");
        assertIncludes(enqueued[0].payload.prompt, "call reply_session_message", "A -> B should instruct the target to use the reply tool");
        assertIncludes(enqueued[0].payload.prompt, `request_id=`, "A -> B should expose a request id for the reply tool");
        assertIncludes(enqueued[0].payload.prompt, `session_id=\"A\"`, "A -> B should name the sender session as reply target");
        assertIncludes(enqueued[1].payload.prompt, "from=B", "B -> C should identify the sender");
        assertIncludes(enqueued[1].payload.prompt, "reason=status-request", "B -> C should carry the reason");
        assertIncludes(enqueued[2].payload.prompt, "[SESSION_MESSAGE_RESPONSE", "C -> A should enqueue a response");
        assertIncludes(enqueued[2].payload.prompt, `request_id=${first.requestId}`, "C -> A should preserve the request id");
        assertIncludes(enqueued[2].payload.prompt, "cross-session response", "C -> A should identify the payload as the response channel");
    });

    it("queues messages while recipients are waiting on timers, user input, agent waits, and active work", async () => {
        const { runtime, enqueued } = createRuntime([
            session("coordinator"),
            session("timer-target", { state: "waiting", waitReason: "timer: refresh later" }),
            session("ask-target", { state: "input_required", waitReason: "waiting for user answer" }),
            session("agent-wait-target", { state: "waiting", waitReason: "waiting for agents" }),
            session("running-target", { state: "running" }),
        ]);

        await sendInternalSessionMessage(runtime, {
            fromSessionId: "coordinator",
            toSessionId: "timer-target",
            subject: "Timer overlap",
            body: "Record this while your timer is pending.",
        });
        await sendInternalSessionMessage(runtime, {
            fromSessionId: "coordinator",
            toSessionId: "ask-target",
            subject: "User wait overlap",
            body: "Record this while you are waiting for the user.",
        });
        await sendInternalSessionMessage(runtime, {
            fromSessionId: "coordinator",
            toSessionId: "agent-wait-target",
            subject: "Child wait overlap",
            body: "Record this while you are waiting for child agents.",
        });
        await sendInternalSessionMessage(runtime, {
            fromSessionId: "coordinator",
            toSessionId: "running-target",
            subject: "Active work overlap",
            body: "Record this while active work is happening.",
        });

        assertEqual(enqueued.length, 4, "All non-terminal recipients should accept cross-session messages");
        assert(enqueued.every((event) => event.eventName === "messages"), "Every dispatch should use the durable messages queue");
        assertEqual(
            enqueued.map((event) => event.orchestrationId).join(","),
            "session-timer-target,session-ask-target,session-agent-wait-target,session-running-target",
            "Messages should enqueue to each recipient's own orchestration",
        );
    });

    it("guards missing and terminal targets before enqueue", async () => {
        const { runtime, enqueued } = createRuntime([
            session("sender"),
            session("terminal", { state: "cancelled" }),
        ]);

        await assertThrows(
            () => sendInternalSessionMessage(runtime, {
                fromSessionId: "sender",
                toSessionId: "missing-target",
                subject: "Need info",
                body: "Ping",
            }),
            /not found/i,
            "Missing cross-session target should fail before enqueue",
        );

        await assertThrows(
            () => sendInternalSessionMessage(runtime, {
                fromSessionId: "sender",
                toSessionId: "terminal",
                subject: "Need info",
                body: "Ping",
            }),
            /terminal/i,
            "Terminal cross-session target should fail before enqueue",
        );

        await assertThrows(
            () => replyInternalSessionMessage(runtime, {
                requestId: "request-1",
                fromSessionId: "sender",
                toSessionId: "terminal",
                body: "Reply",
            }),
            /terminal/i,
            "Terminal cross-session reply target should fail before enqueue",
        );

        assertEqual(enqueued.length, 0, "Rejected cross-session messages should not enqueue durable prompts");
    });

    it("allows ordinary sessions to send messages and replies to system sessions", async () => {
        const { runtime, enqueued } = createRuntime([
            session("ordinary-sender"),
            session("ordinary-responder"),
            session("system-target", { isSystem: true, agentId: "facts-manager" }),
        ]);

        const message = await sendInternalSessionMessage(runtime, {
            fromSessionId: "ordinary-sender",
            toSessionId: "system-target",
            subject: "Please inspect intake",
            body: "A regular agent needs Facts Manager to inspect a shared intake item.",
            reason: "guidance",
            expectsResponse: true,
        });
        await replyInternalSessionMessage(runtime, {
            requestId: message.requestId,
            fromSessionId: "ordinary-responder",
            toSessionId: "system-target",
            verdict: "answered",
            body: "Here is extra context for the system session.",
        });

        assertEqual(enqueued.length, 2, "Ordinary-to-system message and reply should enqueue durable prompts");
        assertEqual(enqueued[0].orchestrationId, "session-system-target", "Message should target the system session orchestration");
        assertIncludes(enqueued[0].payload.prompt, "[SESSION_MESSAGE", "System target receives a session message prompt");
        assertIncludes(enqueued[0].payload.prompt, "from=ordinary-sender", "System target sees the ordinary sender id");
        assertIncludes(enqueued[0].payload.prompt, "expects_response=true", "Message expectation is preserved for system target");
        assertEqual(enqueued[1].orchestrationId, "session-system-target", "Reply should also target the system session orchestration");
        assertIncludes(enqueued[1].payload.prompt, "[SESSION_MESSAGE_RESPONSE", "System target receives a response prompt");
        assertIncludes(enqueued[1].payload.prompt, "from=ordinary-responder", "System target sees the ordinary responder id");
    });

    it("lets two owners' private sessions hold a two-way conversation via agent cross-comms", async () => {
        // Alice and Bob each own a *private* session. At the user-access plane
        // they are mutually invisible — neither owner can read or write the
        // other's session (see security-model.test.mjs "cross-owner isolation").
        // The agent cross-comms plane carries no ownership/visibility gate, so
        // their agents can still talk to each other. This is the durable channel
        // that lets two people coordinate through their agents.
        const alice = { provider: "dev", subject: "alice", displayName: "Alice Anderson", email: "alice@dev.local" };
        const bob = { provider: "dev", subject: "bob", displayName: "Bob Baker", email: "bob@dev.local" };
        const { runtime, enqueued } = createRuntime([
            session("A", { owner: alice, visibility: "private" }),
            session("B", { owner: bob, visibility: "private" }),
        ]);

        // Alice's agent reaches Bob's private session and asks for an answer.
        const req = await sendInternalSessionMessage(runtime, {
            fromSessionId: "A",
            toSessionId: "B",
            subject: "Coordinate a meeting",
            body: "Can your owner meet in the kitchen at 2pm tomorrow?",
            reason: "guidance",
            expectsResponse: true,
        });
        // Bob's agent answers Alice on the same request id.
        await replyInternalSessionMessage(runtime, {
            requestId: req.requestId,
            fromSessionId: "B",
            toSessionId: "A",
            verdict: "answered",
            body: "Yes — kitchen at 2pm works for Bob.",
        });
        // ...and Bob's agent can open its own channel back to Alice: the channel
        // is bidirectional, not merely request/reply.
        await sendInternalSessionMessage(runtime, {
            fromSessionId: "B",
            toSessionId: "A",
            subject: "One more thing",
            body: "Bob will bring the release notes too.",
        });

        assertEqual(
            enqueued.map((event) => event.orchestrationId).join(","),
            "session-B,session-A,session-A",
            "A->B request, B->A reply, and B->A follow-up each route to the recipient's own orchestration despite the different owners",
        );
        // A -> B request reaches Bob's *private* session across the owner boundary.
        assertIncludes(enqueued[0].payload.prompt, "[SESSION_MESSAGE", "Alice's agent reaches Bob's private session via a cross-session message");
        assertIncludes(enqueued[0].payload.prompt, "from=A", "Bob's session sees session A as the sender");
        assertIncludes(enqueued[0].payload.prompt, "expects_response=true", "Alice requests a reply");
        assertIncludes(enqueued[0].payload.prompt, `session_id=\"A\"`, "Bob is told to reply back to session A");
        // B -> A reply closes the loop on Alice's original request id.
        assertIncludes(enqueued[1].payload.prompt, "[SESSION_MESSAGE_RESPONSE", "Bob answers through the response channel");
        assertIncludes(enqueued[1].payload.prompt, `request_id=${req.requestId}`, "the reply preserves Alice's request id");
        assertIncludes(enqueued[1].payload.prompt, "from=B", "Alice's session sees session B as the responder");
        // B -> A follow-up proves the channel is bidirectional.
        assertIncludes(enqueued[2].payload.prompt, "[SESSION_MESSAGE", "Bob's agent can also open its own channel back to Alice");
        assertIncludes(enqueued[2].payload.prompt, "from=B", "Alice's session sees session B as the sender of the follow-up");
    });

    const alice = { provider: "dev", subject: "alice", displayName: "Alice Anderson", email: "alice@dev.local" };
    const bob = { provider: "dev", subject: "bob", displayName: "Bob Baker", email: "bob@dev.local" };

    it("a cross-owner message carries precedence framing and the sender's owner identity", async () => {
        const { runtime, enqueued } = createRuntime([
            session("A", { owner: alice }),
            session("B", { owner: bob }),
        ]);
        await sendInternalSessionMessage(runtime, {
            fromSessionId: "A",
            toSessionId: "B",
            subject: "Coordinate",
            body: "Please help with X.",
            expectsResponse: true,
        });
        const prompt = enqueued[0].payload.prompt;
        assertIncludes(prompt, "relation=cross-owner", "the envelope is tagged cross-owner");
        assertIncludes(prompt, "[CROSS-OWNER MESSAGE]", "the preamble is present");
        assertIncludes(prompt, "different user", "the preamble says it is from a different owner");
        assertIncludes(prompt, "Alice Anderson", "the receiver sees the sender's owner identity");
        assertIncludes(prompt, "task takes precedence", "the preamble asserts the receiver's task takes precedence");
        assertIncludes(prompt, 'verdict="declined"', "the preamble tells the receiver how to decline a distracting/contradictory request");
    });

    it("a same-owner message is byte-for-byte unchanged — no cross-owner framing", async () => {
        const { runtime, enqueued } = createRuntime([
            session("A", { owner: alice }),
            session("A2", { owner: alice }),
        ]);
        await sendInternalSessionMessage(runtime, {
            fromSessionId: "A",
            toSessionId: "A2",
            subject: "Sync",
            body: "Status update please.",
            expectsResponse: true,
        });
        const prompt = enqueued[0].payload.prompt;
        assertIncludes(prompt, "[SESSION_MESSAGE", "the ordinary envelope is still used");
        assert(!prompt.includes("relation=cross-owner"), "a same-owner message is not tagged cross-owner");
        assert(!prompt.includes("[CROSS-OWNER MESSAGE]"), "a same-owner message carries no precedence preamble");
    });

    it("system and unowned sessions never trip the cross-owner boundary", async () => {
        const { runtime, enqueued } = createRuntime([
            session("A", { owner: alice }),
            session("sys", { isSystem: true, agentId: "facts-manager" }), // system: trusted infrastructure
            session("orphan", { owner: null }),                           // unowned: no user owner
        ]);
        // user -> system, and user -> unowned: neither is "another person".
        await sendInternalSessionMessage(runtime, { fromSessionId: "A", toSessionId: "sys", subject: "Inspect", body: "Please inspect intake." });
        await sendInternalSessionMessage(runtime, { fromSessionId: "A", toSessionId: "orphan", subject: "Ping", body: "Hello." });
        // system -> user: also not cross-owner (the system side has no user owner).
        await sendInternalSessionMessage(runtime, { fromSessionId: "sys", toSessionId: "A", subject: "FYI", body: "Facts refreshed." });
        assertEqual(enqueued.length, 3, "all three messages enqueue");
        for (const event of enqueued) {
            assert(!event.payload.prompt.includes("relation=cross-owner"), "system/unowned traffic is not tagged cross-owner");
            assert(!event.payload.prompt.includes("[CROSS-OWNER MESSAGE]"), "system/unowned traffic gets no precedence preamble");
        }
    });

    it("a cross-owner reply is advisory; a same-owner reply keeps the default cooperative framing", async () => {
        const { runtime, enqueued } = createRuntime([
            session("A", { owner: alice }),
            session("B", { owner: bob }),
            session("A2", { owner: alice }),
        ]);
        // Bob's session answering Alice's session: cross-owner.
        await replyInternalSessionMessage(runtime, { requestId: "r1", fromSessionId: "B", toSessionId: "A", verdict: "answered", body: "Here is the answer." });
        // Alice's own second session answering the first: same owner.
        await replyInternalSessionMessage(runtime, { requestId: "r2", fromSessionId: "A2", toSessionId: "A", verdict: "answered", body: "Sibling answer." });

        const crossReply = enqueued[0].payload.prompt;
        assertIncludes(crossReply, "relation=cross-owner", "the cross-owner reply is tagged");
        assertIncludes(crossReply, "advisory input", "the cross-owner reply is framed as advisory, not instruction");
        assertIncludes(crossReply, "Bob Baker", "the cross-owner reply names the responder's owner");
        assert(!crossReply.includes("Incorporate it into your work"), "the cross-owner reply drops the default cooperative line");

        const sameReply = enqueued[1].payload.prompt;
        assert(!sameReply.includes("relation=cross-owner"), "the same-owner reply is not tagged");
        assertIncludes(sameReply, "Incorporate it into your work", "the same-owner reply keeps the default cooperative line");
    });
});
