/**
 * The provider wake: the release path behind every budget mutation.
 *
 * _wakeProvidersPaused is called after releasing a hold, raising or removing
 * a limit, widening an allowance, and re-creating a provider sessions are
 * stranded on. It read `session.orchestrationId` off the view getSession
 * returns — a field that view has never carried, because getSession DERIVES
 * the id (`session-${sessionId}`) at its own top and then drops it. So
 * `if (!orchId) continue` skipped every session, every time, behind a bare
 * catch: all six advertised release paths were silent no-ops and only the
 * 6-hour backstop timer ever released anybody. Measured live before the fix:
 * 335s, 347s, 326s of nothing; after: both parked sessions woke inside 9s.
 *
 * These tests drive the REAL method on a bare prototype instance, so the
 * derivation and the enqueue are the actual code paths.
 *
 * Run: node --test test/unit/provider-wake.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PilotSwarmManagementClient } from "../../dist/management-client.js";
import { createProviderTools } from "../../dist/provider-tools.js";
import { ProviderError } from "../../dist/provider-store.js";
import { PROVIDER_BUDGET_WAKE_PROMPT } from "../../dist/provider-budgets.js";

function makeClient({ paused = [], pausedError = null } = {}) {
    const enqueued = [];
    const updated = [];
    const client = Object.create(PilotSwarmManagementClient.prototype);
    client._catalog = {
        providers: {
            pausedFor: async (name) => {
                if (pausedError) throw pausedError;
                return paused.map((p) => (typeof p === "string" ? p : p.id));
            },
        },
        updateSession: async (sessionId, patch) => { updated.push({ sessionId, patch }); },
    };
    client._duroxideClient = {
        enqueueEvent: async (orchId, queue, payload) => { enqueued.push({ orchId, queue, payload }); },
    };
    return { client, enqueued, updated };
}

test("every paused session is woken on its DERIVED orchestration id", async () => {
    const { client, enqueued, updated } = makeClient({ paused: ["s-one", "s-two"] });
    await client._wakeProvidersPaused("azure-openai");

    // The id is session-<id>, built here — never read off a view that does
    // not carry it. That read is the exact shape of the original defect.
    assert.deepEqual(enqueued.map((e) => e.orchId), ["session-s-one", "session-s-two"]);
    assert.ok(enqueued.every((e) => e.queue === "messages"));

    // The wake is internal traffic, not proof a model turn was admitted.
    for (const e of enqueued) {
        const body = JSON.parse(e.payload);
        assert.equal(body.prompt, PROVIDER_BUDGET_WAKE_PROMPT);
    }
    assert.deepEqual(updated, [], "only the orchestration may change running/waiting state");
});

test("the wake nudge is internal traffic, not user words", () => {
    // [SYSTEM: is what isInternalSystemPrompt keys on. Without it the wake
    // painted "Internal wake-up: …" into transcripts as a USER message —
    // live-observed the first day the wake actually fired.
    assert.match(PROVIDER_BUDGET_WAKE_PROMPT, /^\[SYSTEM: /);
    assert.match(PROVIDER_BUDGET_WAKE_PROMPT, /\]$/);
});

test("one unreachable session does not stop the others", async () => {
    const { client, enqueued } = makeClient({ paused: ["s-a", "s-b", "s-c"] });
    // The second enqueue blows up; the third must still happen.
    const original = client._duroxideClient.enqueueEvent;
    let n = 0;
    client._duroxideClient.enqueueEvent = async (...args) => {
        n += 1;
        if (n === 2) throw new Error("orchestration unreachable");
        return original(...args);
    };
    await client._wakeProvidersPaused("azure-openai");
    assert.deepEqual(enqueued.map((e) => e.orchId), ["session-s-a", "session-s-c"]);
});

test("a failed paused-list read is swallowed: the backstop timer still covers everyone", async () => {
    const { client, enqueued } = makeClient({ pausedError: new Error("db down") });
    await client._wakeProvidersPaused("azure-openai");
    assert.equal(enqueued.length, 0);
});


test("duplicate paused rows produce a single nudge and failed queues do not mark running", async () => {
    const { client, enqueued, updated } = makeClient({ paused: ["s-a", "s-a", "s-b"] });
    const enqueue = client._duroxideClient.enqueueEvent;
    client._duroxideClient.enqueueEvent = async (...args) => {
        if (args[0] === "session-s-b") throw new Error("unreachable");
        return enqueue(...args);
    };
    await client._wakeProvidersPaused("ghcp-u1");
    assert.equal(enqueued.length, 1);
    assert.deepEqual(updated, []);
});

function toolHarness({ forbidden = false, queueFailure = false } = {}) {
    const { client, enqueued, updated } = makeClient({ paused: ["budget-session"] });
    const calls = [];
    let actor = { userId: 42, isAdmin: false, adminScope: "cluster" };
    for (const [method, result] of Object.entries({
        createProvider: { name: "ghcp-u1" }, setLimit: { ruleId: "cap", seededTokens: 123 },
        removeLimit: true, setAllowance: 100, setHold: undefined,
    })) {
        client._catalog.providers[method] = async (...args) => {
            calls.push({ method, args });
            if (forbidden) throw new ProviderError("PROVIDER_FORBIDDEN", "Not allowed");
            return result;
        };
    }
    const lookup = client._catalog.providers.pausedFor;
    client._catalog.providers.pausedFor = async (name) => {
        calls.push({ method: "pausedFor", args: [name] });
        return lookup(name);
    };
    if (queueFailure) client._duroxideClient.enqueueEvent = async () => { throw new Error("unreachable"); };
    const tools = new Map(createProviderTools({
        catalog: client._catalog, duroxideClient: client._duroxideClient,
        resolveViewer: () => actor,
    }).map((tool) => [tool.name, tool]));
    return { tools, calls, enqueued, updated, setActor: (value) => { actor = value; } };
}

const RELEASING_MUTATIONS = [
    ["set_provider_limit", { provider: "ghcp-u1", period: "month", model: "ghcp-u1:opus", tokens: null }, "removeLimit"],
    ["set_provider_limit", { provider: "ghcp-u1", period: "month", model: "ghcp-u1:opus", tokens: 2000 }, "setLimit"],
    ["set_provider_allowance", { provider: "ghcp-u1", pct: 100 }, "setAllowance"],
    ["provider_hold", { provider: "ghcp-u1", action: "release" }, "setHold"],
    ["manage_provider", { name: "ghcp-u1", type: "github-copilot", action: "create", mine: true }, "createProvider"],
];

for (const [name, args, method] of RELEASING_MUTATIONS) {
    test(`agent ${name}/${method} commits under its viewer before waking the exact provider`, async () => {
        const h = toolHarness();
        const result = await h.tools.get(name).handler(args);
        assert.equal(result?.error, undefined);
        assert.deepEqual(h.calls.map((c) => c.method), [method, "pausedFor"]);
        assert.deepEqual(h.calls[0].args.slice(-2), [42, false]);
        assert.deepEqual(h.calls[1].args, ["ghcp-u1"]);
        assert.equal(h.enqueued.length, 1);
        assert.deepEqual(JSON.parse(h.enqueued[0].payload), { prompt: PROVIDER_BUDGET_WAKE_PROMPT });
        assert.deepEqual(h.updated, []);
    });
    test(`denied agent ${name}/${method} never discovers or wakes paused sessions`, async () => {
        const h = toolHarness({ forbidden: true });
        const result = await h.tools.get(name).handler(args);
        assert.equal(result.code, "PROVIDER_FORBIDDEN");
        assert.deepEqual(h.calls.map((c) => c.method), [method]);
        assert.deepEqual(h.enqueued, []);
    });
}

test("a persisted agent limit removal remains successful if wake delivery fails", async () => {
    const h = toolHarness({ queueFailure: true });
    const result = await h.tools.get("set_provider_limit").handler(RELEASING_MUTATIONS[0][1]);
    assert.deepEqual(result, { removed: true });
    assert.deepEqual(h.updated, []);
});

test("agent mutation resolves the current viewer for each invocation", async () => {
    const h = toolHarness();
    await h.tools.get("set_provider_limit").handler(RELEASING_MUTATIONS[0][1]);
    h.setActor({ userId: 99, isAdmin: true });
    await h.tools.get("set_provider_limit").handler(RELEASING_MUTATIONS[0][1]);
    assert.deepEqual(h.calls.filter((c) => c.method === "removeLimit").map((c) => c.args.slice(-2)), [[42, false], [99, true]]);
});

test("invalid token amounts never write or wake", async () => {
    for (const tokens of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "garbage"]) {
        const h = toolHarness();
        const result = await h.tools.get("set_provider_limit").handler({ ...RELEASING_MUTATIONS[1][1], tokens });
        assert.equal(result.code, "PROVIDER_INVALID");
        assert.deepEqual(h.calls, []);
        assert.deepEqual(h.enqueued, []);
    }
});
