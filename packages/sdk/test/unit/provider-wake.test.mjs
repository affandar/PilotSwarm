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

    // The wake body is the internal nudge, and the row is marked running so
    // the list stops saying "waiting" during the seconds before the turn.
    for (const e of enqueued) {
        const body = JSON.parse(e.payload);
        assert.equal(body.prompt, PROVIDER_BUDGET_WAKE_PROMPT);
    }
    assert.deepEqual(updated.map((u) => u.sessionId), ["s-one", "s-two"]);
    assert.ok(updated.every((u) => u.patch.state === "running"));
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
