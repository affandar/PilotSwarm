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

    it("guards missing, terminal, and system-session targets before enqueue", async () => {
        const { runtime, enqueued } = createRuntime([
            session("sender"),
            session("terminal", { state: "cancelled" }),
            session("system-target", { isSystem: true }),
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

        await assertThrows(
            () => sendInternalSessionMessage(runtime, {
                fromSessionId: "sender",
                toSessionId: "system-target",
                subject: "Need info",
                body: "Ping",
            }),
            /ordinary sessions cannot wake system sessions/i,
            "Ordinary sessions should not wake system sessions through cross-session messaging",
        );

        assertEqual(enqueued.length, 0, "Rejected cross-session messages should not enqueue durable prompts");
    });
});
