import { describe, it, expect } from "vitest";
import { CopilotSession } from "@github/copilot-sdk";
import { ManagedSession } from "../../src/managed-session.js";
import { SessionManager } from "../../src/session-manager.js";
import { PilotSwarmManagementClient } from "../../src/management-client.js";
import { stopTurnQueueName } from "../../src/types.js";
import { normalizeRacedTurnValue } from "../../src/orchestration/turn.js";

/**
 * Stop-turn (docs/proposals-impl/stop-button-turn-abort-plan.md) — deterministic
 * unit/integration coverage of the worker-local interrupt path:
 *
 *  - ManagedSession stop marker: requestStop/abort classifies the unwind as
 *    { type: "stopped" }, never completed/error; forceSettleTurn escalation
 *    unwinds a turn whose SDK never fires session.idle.
 *  - SessionManager.abortWarmSessionTurn: lock-bypassing primitive with
 *    no_active_turn / wrong-turn guards and the stop_forced escalation.
 *  - PilotSwarmManagementClient.stopSessionTurn: CMS pre-check, turn-scoped
 *    stop queue addressing, command-response polling, timeout.
 *  - normalizeRacedTurnValue: the duroxide-node select bridge flattens
 *    activity failures into raw error strings; the orchestration must be able
 *    to tell them apart from TurnResult payloads.
 *  - Copilot SDK abort primitive contract (session.abort RPC shape).
 *
 * No live LLM, database, or duroxide runtime required.
 */

// ─── Fakes ───────────────────────────────────────────────────────

function createFakeCopilotSession({ abortFiresIdle = true } = {}) {
    const handlers = [];
    const emit = (type, data = {}) => {
        for (const h of [...handlers]) {
            if (h.type === null) h.fn({ type, data });
            else if (h.type === type) h.fn({ type, data });
        }
    };
    const fake = {
        sent: [],
        abortCalls: 0,
        disconnectCalls: 0,
        registerTools() {},
        on(a, b) {
            const h = typeof a === "function" ? { type: null, fn: a } : { type: a, fn: b };
            handlers.push(h);
            return () => {
                const i = handlers.indexOf(h);
                if (i >= 0) handlers.splice(i, 1);
            };
        },
        async send(msg) {
            fake.sent.push(msg);
        },
        abort() {
            fake.abortCalls++;
            if (abortFiresIdle) setTimeout(() => emit("session.idle"), 5);
        },
        async disconnect() {
            fake.disconnectCalls++;
        },
        getMessages() {
            return [];
        },
        _emit: emit,
    };
    return fake;
}

function createManagedSession(fakeCopilot, config = {}) {
    return new ManagedSession("stop-turn-test-session", fakeCopilot, { waitThreshold: 30, ...config });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 2_000, stepMs = 10) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(stepMs);
    }
    return predicate();
}

// ─── ManagedSession stop classification ──────────────────────────

describe("ManagedSession stop classification", () => {
    it("classifies an aborted turn as stopped, not completed", async () => {
        const copilot = createFakeCopilotSession();
        const managed = createManagedSession(copilot);

        const turnPromise = managed.runTurn("long prompt", { turnIndex: 7 });
        await waitFor(() => managed.getActiveTurn() != null);
        expect(managed.getActiveTurn().turnIndex).toBe(7);

        // Marker first, then abort — mirrors abortWarmSessionTurn ordering.
        const stopped = managed.requestStop("Stopped by user");
        expect(stopped).toEqual({ turnIndex: 7 });
        managed.abort();

        const result = await turnPromise;
        expect(result.type).toBe("stopped");
        expect(result.reason).toBe("Stopped by user");
        // Without the stop marker this unwind would have been
        // { type: "completed", content: "(no response)" } — the whole reason
        // the marker exists (verified fact 6 in the plan).
        expect(managed.getActiveTurn()).toBeNull();
    });

    it("unmarked aborts still unwind as completed (wait/ask_user contract preserved)", async () => {
        const copilot = createFakeCopilotSession();
        const managed = createManagedSession(copilot);

        const turnPromise = managed.runTurn("prompt", { turnIndex: 1 });
        await waitFor(() => managed.getActiveTurn() != null);
        managed.abort(); // no requestStop — e.g. a control-tool abort

        const result = await turnPromise;
        expect(result.type).toBe("completed");
    });

    it("requestStop returns null when no turn is in flight", () => {
        const managed = createManagedSession(createFakeCopilotSession());
        expect(managed.requestStop("late click")).toBeNull();
        expect(managed.getActiveTurn()).toBeNull();
    });

    it("forceSettleTurn unwinds a turn whose SDK never fires session.idle", async () => {
        const copilot = createFakeCopilotSession({ abortFiresIdle: false });
        const managed = createManagedSession(copilot);

        const turnPromise = managed.runTurn("hung prompt", { turnIndex: 3 });
        await waitFor(() => managed.getActiveTurn() != null);

        managed.requestStop("Stopped by user");
        managed.abort(); // does nothing — the fake never fires idle
        await sleep(50);
        expect(managed.getActiveTurn()).not.toBeNull();

        expect(managed.forceSettleTurn("Stopped by user")).toBe(true);
        const result = await turnPromise;
        expect(result.type).toBe("stopped");
        expect(managed.getActiveTurn()).toBeNull();
    });
});

// ─── SessionManager.abortWarmSessionTurn ─────────────────────────

function createBareSessionManager() {
    // Bypass the full constructor: abortWarmSessionTurn only reads the warm
    // map and (on escalation) calls invalidateWarmSession.
    const manager = Object.create(SessionManager.prototype);
    manager.sessions = new Map();
    manager.invalidateWarmSessionCalls = [];
    manager.invalidateWarmSession = async (sessionId) => {
        manager.invalidateWarmSessionCalls.push(sessionId);
        manager.sessions.delete(sessionId);
    };
    return manager;
}

describe("SessionManager.abortWarmSessionTurn", () => {
    it("returns no_active_turn when the session is not warm", async () => {
        const manager = createBareSessionManager();
        const result = await manager.abortWarmSessionTurn("missing", { reason: "user" });
        expect(result.outcome).toBe("no_active_turn");
    });

    it("returns no_active_turn when the warm session has no turn in flight", async () => {
        const manager = createBareSessionManager();
        const managed = createManagedSession(createFakeCopilotSession());
        manager.sessions.set(managed.sessionId, managed);

        const result = await manager.abortWarmSessionTurn(managed.sessionId, { reason: "user" });
        expect(result.outcome).toBe("no_active_turn");
    });

    it("guards against stopping the wrong turn (expectedTurnIndex mismatch)", async () => {
        const manager = createBareSessionManager();
        const copilot = createFakeCopilotSession();
        const managed = createManagedSession(copilot);
        manager.sessions.set(managed.sessionId, managed);

        const turnPromise = managed.runTurn("prompt", { turnIndex: 5 });
        await waitFor(() => managed.getActiveTurn() != null);

        const result = await manager.abortWarmSessionTurn(managed.sessionId, {
            reason: "user",
            expectedTurnIndex: 4, // stale — a previous turn
        });
        expect(result.outcome).toBe("no_active_turn");
        expect(result.turnIndex).toBe(5);
        expect(copilot.abortCalls).toBe(0); // the newer turn was untouched

        managed.abort();
        const turnResult = await turnPromise;
        expect(turnResult.type).toBe("completed"); // wrong-turn stop never marked it
    });

    it("aborts a matching in-flight turn mid-flight and reports stopped", async () => {
        const manager = createBareSessionManager();
        const copilot = createFakeCopilotSession();
        const managed = createManagedSession(copilot);
        manager.sessions.set(managed.sessionId, managed);

        const turnPromise = managed.runTurn("prompt", { turnIndex: 2 });
        await waitFor(() => managed.getActiveTurn() != null);

        const result = await manager.abortWarmSessionTurn(managed.sessionId, {
            reason: "Stopped by user",
            expectedTurnIndex: 2,
        });
        expect(result.outcome).toBe("stopped");
        expect(result.turnIndex).toBe(2);
        expect(copilot.abortCalls).toBe(1);

        const turnResult = await turnPromise;
        expect(turnResult.type).toBe("stopped");
    });

    it("escalates to stop_forced when the SDK never unwinds, and invalidates the warm session", async () => {
        const manager = createBareSessionManager();
        const copilot = createFakeCopilotSession({ abortFiresIdle: false });
        const managed = createManagedSession(copilot);
        manager.sessions.set(managed.sessionId, managed);

        const turnPromise = managed.runTurn("hung prompt", { turnIndex: 9 });
        await waitFor(() => managed.getActiveTurn() != null);

        const result = await manager.abortWarmSessionTurn(managed.sessionId, {
            reason: "Stopped by user",
            expectedTurnIndex: 9,
            unwindGraceMs: 100, // keep the test fast
        });
        expect(result.outcome).toBe("stop_forced");

        const turnResult = await turnPromise;
        expect(turnResult.type).toBe("stopped");
        await waitFor(() => manager.invalidateWarmSessionCalls.length > 0);
        expect(manager.invalidateWarmSessionCalls).toContain(managed.sessionId);
    });

    it("never takes the per-session lock (lock-bypass contract)", () => {
        // runTurn holds withRunTurnLock for the entire turn; a lock-taking
        // stop would serialize behind the turn and defeat mid-flight stop.
        const source = SessionManager.prototype.abortWarmSessionTurn.toString();
        expect(source.includes("_withSessionLock")).toBe(false);
        expect(source.includes("withRunTurnLock")).toBe(false);
    });
});

// ─── Management client stopSessionTurn ───────────────────────────

function createMgmtHarness({ row, response } = {}) {
    const mgmt = new PilotSwarmManagementClient({});
    mgmt._started = true;
    const enqueues = [];
    mgmt._duroxideClient = {
        enqueueEvent: async (orchestrationId, queue, payload) => {
            enqueues.push({ orchestrationId, queue, payload: JSON.parse(payload) });
        },
    };
    mgmt._catalog = {
        getSession: async () => row ?? null,
    };
    mgmt._assertOrchestrationLive = async () => {};
    mgmt._readJsonValue = async (_sessionId, key) => {
        if (response && enqueues.length > 0 && key === `command.response.${enqueues[0].payload.id}`) {
            return { schemaVersion: 1, version: 1, emittedAt: Date.now(), id: enqueues[0].payload.id, cmd: "stop_turn", ...response };
        }
        return null;
    };
    return { mgmt, enqueues };
}

describe("PilotSwarmManagementClient.stopSessionTurn", () => {
    it("returns no_active_turn without enqueueing when the session is not running", async () => {
        const { mgmt, enqueues } = createMgmtHarness({
            row: { sessionId: "s1", state: "idle", activeTurnIndex: null, deletedAt: null },
        });
        const result = await mgmt.stopSessionTurn("s1");
        expect(result.outcome).toBe("no_active_turn");
        expect(enqueues.length).toBe(0);
    });

    it("returns no_active_turn when the session does not exist", async () => {
        const { mgmt, enqueues } = createMgmtHarness({ row: null });
        const result = await mgmt.stopSessionTurn("missing");
        expect(result.outcome).toBe("no_active_turn");
        expect(enqueues.length).toBe(0);
    });

    it("enqueues on the turn-scoped stop queue and returns the polled outcome", async () => {
        const { mgmt, enqueues } = createMgmtHarness({
            row: { sessionId: "s2", state: "running", activeTurnIndex: 4, deletedAt: null },
            response: { result: { outcome: "stopped", turnIndex: 4 } },
        });
        const result = await mgmt.stopSessionTurn("s2", { reason: "test stop" });

        expect(enqueues.length).toBe(1);
        expect(enqueues[0].orchestrationId).toBe("session-s2");
        expect(enqueues[0].queue).toBe(stopTurnQueueName(4));
        expect(enqueues[0].queue).toBe("stopTurn.4");
        expect(typeof enqueues[0].payload.id).toBe("string");
        expect(enqueues[0].payload.reason).toBe("test stop");

        expect(result.outcome).toBe("stopped");
        expect(result.turnIndex).toBe(4);
    });

    it("times out honestly when no response ever lands (stale-stop window)", async () => {
        const { mgmt, enqueues } = createMgmtHarness({
            row: { sessionId: "s3", state: "running", activeTurnIndex: 1, deletedAt: null },
            // no response — the turn ended between the CMS read and the enqueue
        });
        const result = await mgmt.stopSessionTurn("s3", { timeoutMs: 300 });
        expect(enqueues.length).toBe(1);
        expect(result.outcome).toBe("timeout");
        expect(result.turnIndex).toBe(1);
    });
});

// ─── Raced turn value normalization ──────────────────────────────

describe("normalizeRacedTurnValue", () => {
    it("passes through structured TurnResult objects", () => {
        const raced = normalizeRacedTurnValue({ type: "completed", content: "done" });
        expect(raced.kind).toBe("result");
        expect(raced.result.type).toBe("completed");
    });

    it("parses JSON-encoded TurnResult strings", () => {
        const raced = normalizeRacedTurnValue(JSON.stringify({ type: "wait", seconds: 60, reason: "poll" }));
        expect(raced.kind).toBe("result");
        expect(raced.result.type).toBe("wait");
    });

    it("classifies flattened activity error strings as errors", () => {
        // duroxide-node's select bridge maps a failed activity branch to its
        // raw error string (Ok(v) => v, Err(e) => e) instead of throwing.
        const raced = normalizeRacedTurnValue("live Copilot connection closed unexpectedly");
        expect(raced.kind).toBe("error");
        expect(raced.message).toContain("connection closed");
    });

    it("classifies non-TurnResult JSON payloads as errors", () => {
        const raced = normalizeRacedTurnValue(JSON.stringify({ oops: true }));
        expect(raced.kind).toBe("error");
    });
});

// ─── Queue naming ────────────────────────────────────────────────

describe("stopTurnQueueName", () => {
    it("is turn-scoped so a stale stop can never win a later turn's race", () => {
        expect(stopTurnQueueName(0)).toBe("stopTurn.0");
        expect(stopTurnQueueName(12)).toBe("stopTurn.12");
        expect(stopTurnQueueName(12)).not.toBe(stopTurnQueueName(13));
    });
});

// ─── Copilot SDK abort primitive contract ────────────────────────

describe("CopilotSession.abort contract", () => {
    it("sends session.abort with the current sessionId (guards SDK drift)", async () => {
        const calls = [];
        const connection = {
            sendRequest: async (method, params) => {
                calls.push({ method, params });
                return { ok: true };
            },
        };
        const session = new CopilotSession("probe-session", connection, process.cwd());
        expect(typeof session.abort).toBe("function");
        await session.abort();
        expect(calls.length).toBe(1);
        expect(calls[0].method).toBe("session.abort");
        expect(calls[0].params.sessionId).toBe("probe-session");
    });
});
