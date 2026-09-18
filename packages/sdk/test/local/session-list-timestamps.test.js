import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PilotSwarmClient } from "../../src/client.ts";
import { registerActivities } from "../../src/session-proxy.ts";
import { handleSubAgentAction } from "../../src/orchestration/agents.ts";
import { handleSubAgentAction as handleFrozenAction } from "../../src/orchestration_1_0_78/agents.ts";

const createdAt = Date.parse("2026-09-15T23:22:58.181Z");
const updatedAt = Date.parse("2026-09-17T09:32:04.000Z");
const row = (id, extra = {}) => ({
    sessionId: id, title: id, status: "idle", iterations: 4,
    owner: { provider: "entra", subject: "alice", displayName: "Alice" },
    createdAt, updatedAt, ...extra,
});
const ctx = { traceInfo() {}, isCancelled: () => false };

function harness(rows) {
    vi.spyOn(PilotSwarmClient.prototype, "listSessions").mockResolvedValue(rows);
    const handlers = {};
    let listArgs;
    const session = {
        abort: vi.fn(),
        runTurn: async (_prompt, options) => ({
            type: "completed", events: [],
            content: await options.controlToolBridge.listSessions(listArgs),
        }),
    };
    registerActivities(
        { registerActivity: (name, handler) => { handlers[name] = handler; } },
        {
            withRunTurnLock: async (_id, _operation, fn) => fn(),
            getOrCreate: async () => session,
            getModelSummary: () => undefined,
            resetSessionState: async () => {},
        },
        null, undefined, undefined, undefined, "sqlite::memory:",
    );
    return {
        activity: (args = {}) => handlers.listSessions(ctx, args),
        inline: async (args = {}) => {
            listArgs = args;
            const result = await handlers.runTurn(ctx, {
                sessionId: "current", prompt: "List sessions", config: {}, turnIndex: 0,
            });
            expect(result.type).toBe("completed");
            return result.content;
        },
    };
}

function runFallback(handler, rows, filters = {}) {
    let activityInput;
    const runtime = {
        ctx,
        input: { sessionId: "current" },
        state: {},
        manager: { listSessions: (input) => { activityInput = input; return "listSessions"; } },
    };
    const gen = handler(runtime, { type: "list_sessions", ...filters });
    expect(gen.next()).toEqual({ value: "listSessions", done: false });
    expect(gen.next(JSON.stringify(rows))).toEqual({ value: true, done: true });
    return { activityInput, prompt: runtime.state.pendingPrompt };
}

beforeEach(() => {
    // Exercise the real activity/bridge formatting without a database or LLM.
    vi.spyOn(PilotSwarmClient.prototype, "start").mockResolvedValue(undefined);
    vi.spyOn(PilotSwarmClient.prototype, "stop").mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("list_sessions timestamps", () => {
    it("returns creation and update times as distinct UTC instants through the actual inline bridge", async () => {
        const text = await harness([row("current")]).inline();
        expect(text).toContain("current (this session)");
        expect(text).toContain("Created: 2026-09-15T23:22:58.181Z");
        expect(text).toContain("Updated: 2026-09-17T09:32:04.000Z");
        expect(text).toContain("Status: idle, Iterations: 4");
        expect(PilotSwarmClient.prototype.stop).toHaveBeenCalledTimes(1);
    });

    it("updated_since compares epoch milliseconds, retaining the inclusive boundary and ISO rows", async () => {
        const text = await harness([
            row("before", { updatedAt: updatedAt - 1 }),
            row("boundary"), row("after", { updatedAt: updatedAt + 1 }),
            row("iso", { updatedAt: "2026-09-17T10:32:04+01:00" }),
            row("missing", { createdAt: undefined, updatedAt: undefined }),
            row("malformed", { updatedAt: "bad date" }),
        ]).inline({ updated_since: "2026-09-17T09:32:04Z" });
        expect(text).toContain("Active sessions (3)");
        for (const id of ["boundary", "after", "iso"]) expect(text).toContain(`  - ${id}\n`);
        for (const id of ["before", "missing", "malformed"]) expect(text).not.toContain(`  - ${id}\n`);
    });

    it("does not treat epoch zero as missing or substitute creation for an actual older update", async () => {
        const text = await harness([row("epoch", { updatedAt: 0 })]).inline({ updated_since: "1970-01-01T00:00:00.001Z" });
        expect(text).toContain("Active sessions (0)");
    });

    it("retains the missing-update filter fallback without inventing an Updated value", async () => {
        const text = await harness([row("fallback", { updatedAt: undefined, createdAt: updatedAt })])
            .inline({ updated_since: "2026-09-17T09:32:04Z" });
        expect(text).toContain("Active sessions (1)");
        expect(text).toContain("Updated: unknown");
    });

    it("preserves owner, child, system, and limit filters", async () => {
        const rows = [row("child", { parentSessionId: "parent" }), row("system", { isSystem: true }),
            row("bob", { owner: { provider: "entra", subject: "bob" } }), row("alice-1"), row("alice-2")];
        const h = harness(rows);
        const text = await h.inline({ owner_query: "Alice", limit: 1 });
        expect(text).toContain("Active sessions (1)");
        expect(text).toContain("  - alice-1\n");
        expect(text).not.toContain("  - child\n");
        expect(text).not.toContain("  - system\n");
        const included = await h.inline({ include_children: true, include_system: true });
        expect(included).toContain("Active sessions (5)");
    });

    it("keeps the old activity JSON byte-for-byte and includes raw timestamps only on opt-in", async () => {
        const h = harness([row("old")]);
        const legacy = '{"sessionId":"old","title":"old","owner":{"provider":"entra","subject":"alice","displayName":"Alice"},"ownerKind":"user","status":"idle","iterations":4}';
        expect(await h.activity()).toBe(`[${legacy}]`);
        expect(await h.activity({ includeTimestamps: false })).toBe(`[${legacy}]`);
        expect(JSON.parse(await h.activity({ includeTimestamps: true }))).toEqual([
            { ...JSON.parse(legacy), createdAt, updatedAt },
        ]);
    });

    it("passes activity timestamps into the new durable followup without changing the old workflow", async () => {
        const filters = { includeSystem: true, ownerQuery: "Alice", ownerKind: "user" };
        const h = harness([row("current")]);
        const latest = runFallback(handleSubAgentAction, JSON.parse(await h.activity({ ...filters, includeTimestamps: true })), filters);
        expect(latest.activityInput).toEqual({ ...filters, includeTimestamps: true });
        expect(latest.prompt).toContain("Created: 2026-09-15T23:22:58.181Z");
        expect(latest.prompt).toContain("Updated: 2026-09-17T09:32:04.000Z");
        const old = runFallback(handleFrozenAction, JSON.parse(await h.activity(filters)), filters);
        expect(old.activityInput).toEqual(filters);
        expect(old.prompt).not.toMatch(/Created:|Updated:/);
    });

    it("handles an old worker response during rollout and empty results", () => {
        const latest = runFallback(handleSubAgentAction, [row("legacy", { createdAt: undefined, updatedAt: undefined })]);
        expect(latest.prompt).toContain("Created: unknown");
        expect(latest.prompt).toContain("Updated: unknown");
        expect(runFallback(handleSubAgentAction, []).prompt).toBe("Active sessions (0). No sessions matched the requested filters.");
    });

    it.each(["inline", "durable"])("%s handles epoch, timezone offsets, missing and invalid dates without failing the list", async (mode) => {
        const rows = [row("epoch", { createdAt: 0, updatedAt: "2026-09-17T10:32:04+01:00" }),
            row("invalid", { createdAt: null, updatedAt: "invalid" }),
            row("missing", { createdAt: undefined, updatedAt: undefined }),
            row("out-of-range", { createdAt: 1e20, updatedAt: 1e20 })];
        const text = mode === "inline" ? await harness(rows).inline() : runFallback(handleSubAgentAction, rows).prompt;
        expect(text).toContain("Active sessions (4)");
        expect(text).toContain("Created: 1970-01-01T00:00:00.000Z");
        expect(text).toContain("Updated: 2026-09-17T09:32:04.000Z");
        expect(text.match(/Created: unknown/g)).toHaveLength(3);
        expect(text.match(/Updated: unknown/g)).toHaveLength(3);
    });
});
