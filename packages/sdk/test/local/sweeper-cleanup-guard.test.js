/**
 * Sweeper cleanup guardrail tests.
 *
 * Regression coverage for the 2026-06-28 incident where the Sweeper Agent
 * deleted LIVE root sessions after `scan_completed_sessions` returned stale
 * CHILD sessions grouped under those roots. The model collapsed the children
 * to their shared parent root and called `cleanup_session(root)`; the tool
 * accepted it because it only checked exists + not-system, so the live root
 * and its whole subtree were soft-deleted.
 *
 * These tests lock the TOOL boundary (not the model). They drive the sweeper
 * tool handlers directly against a real CMS catalog with a controlled
 * orchestration-status source (a stub duroxide client), so the live/terminal
 * state of each session is deterministic — no LLM, no real orchestration.
 *
 *   - cleanup_session REFUSES a live root inferred from stale children
 *   - cleanup_session still cleans a genuinely terminal target
 *   - cleanup_session cleans terminal children individually (by their own
 *     sessionId), refuses live/idle children, and preserves the live parent
 *   - cleanup_session batch (sessionIds[]) gates each target independently:
 *     cleans eligible ones, refuses live roots, de-dupes
 *
 * Run: npx vitest run test/local/sweeper-cleanup-guard.test.js
 */

import { randomUUID } from "node:crypto";
import { describe, it, beforeAll } from "vitest";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { createSweeperTools } from "../../src/sweeper-tools.ts";
import { assertEqual, assertNotNull } from "../helpers/assertions.js";

const TIMEOUT = 60_000;
const getEnv = useSuiteEnv(import.meta.url);

function findTool(tools, name) {
    const tool = tools.find(t => t.name === name);
    if (!tool) throw new Error(`tool not found: ${name}`);
    return tool;
}

/**
 * Stub duroxide client whose getStatus is driven by a status map keyed by
 * instance id (`session-<id>`). Anything not in the map is NotFound. This puts
 * a session into a precise live/terminal orchestration state without spinning
 * up a real orchestration — the orchestration status is an external input to
 * the eligibility guard, so controlling it is the point of the test.
 */
function makeStubDuroxide(statusByInstance) {
    const enqueuedEvents = [];
    return {
        enqueuedEvents,
        async getStatus(instanceId) {
            return statusByInstance.get(instanceId) ?? { status: "NotFound" };
        },
        async enqueueEvent(orchestrationId, eventName, payload) {
            enqueuedEvents.push({ orchestrationId, eventName, payload });
        },
        // CMS soft-delete is what we assert against; the duroxide instance
        // delete is best-effort in the tool and irrelevant to the guard.
        async deleteInstance() {},
    };
}

async function isLive(catalog, sessionId) {
    const row = await catalog.getSession(sessionId);
    return !!row && row.deletedAt == null;
}

async function testRefusesLiveRoot(env) {
    const catalog = await createCatalog(env);
    try {
        const rootId = randomUUID();
        const childA = randomUUID();
        const childB = randomUUID();

        // The incident shape: a live root (recurring crawler) with two stale,
        // completed children hanging off it.
        await catalog.createSession(rootId, { agentId: "generic-crawler" });
        await catalog.createSession(childA, { parentSessionId: rootId });
        await catalog.createSession(childB, { parentSessionId: rootId });

        const status = new Map([
            // Root orchestration is alive (idle between cron wake-ups) — NOT terminal.
            [`session-${rootId}`, { status: "Running", customStatus: JSON.stringify({ status: "idle", cronActive: true }) }],
            // Children finished their tasks.
            [`session-${childA}`, { status: "Completed" }],
            [`session-${childB}`, { status: "Completed" }],
        ]);
        const tools = createSweeperTools({ catalog, duroxideClient: makeStubDuroxide(status), factStore: null });
        const cleanup = findTool(tools, "cleanup_session");

        // The bad call the model used to make: clean the inferred parent root.
        const res = await cleanup.handler({ sessionId: rootId, graceMinutes: 0 });
        console.log(`  cleanup_session(root) -> ok=${res.ok} refused=${res.refused} status=${res.status}`);
        assertEqual(res.ok, false, "cleanup_session must refuse a live root");
        assertEqual(res.refused, true, "refusal should be explicit");

        // Root and BOTH children must still be live — nothing was deleted.
        assertEqual(await isLive(catalog, rootId), true, "live root must survive");
        assertEqual(await isLive(catalog, childA), true, "child A must survive a refused root cleanup");
        assertEqual(await isLive(catalog, childB), true, "child B must survive a refused root cleanup");
        console.log("  ✓ live root and its children preserved");
    } finally {
        await catalog.close();
    }
}

async function testCleansTerminalTarget(env) {
    const catalog = await createCatalog(env);
    try {
        // A genuinely completed root is still cleanable — the guard must not
        // over-block legitimate cleanup.
        const rootId = randomUUID();
        await catalog.createSession(rootId);

        const status = new Map([[`session-${rootId}`, { status: "Completed" }]]);
        const tools = createSweeperTools({ catalog, duroxideClient: makeStubDuroxide(status), factStore: null });
        const cleanup = findTool(tools, "cleanup_session");

        const res = await cleanup.handler({ sessionId: rootId, graceMinutes: 0 });
        console.log(`  cleanup_session(terminal root) -> ok=${res.ok} deletedCount=${res.deletedCount}`);
        assertEqual(res.ok, true, "a genuinely terminal root is still cleanable");
        assertEqual(await isLive(catalog, rootId), false, "terminal root should be soft-deleted");
        console.log("  ✓ terminal root cleaned");
    } finally {
        await catalog.close();
    }
}

async function testCleanupOnlyCleansTerminalChildren(env) {
    const catalog = await createCatalog(env);
    try {
        const rootId = randomUUID();
        const childA = randomUUID();
        const childB = randomUUID();
        await catalog.createSession(rootId, { agentId: "generic-crawler" });
        await catalog.createSession(childA, { parentSessionId: rootId });
        await catalog.createSession(childB, { parentSessionId: rootId });

        const status = new Map([
            // Live root, idle between cron wake-ups.
            [`session-${rootId}`, { status: "Running", customStatus: JSON.stringify({ status: "idle", cronActive: true }) }],
            // childA finished (terminal); childB is an idle live sub-agent.
            [`session-${childA}`, { status: "Completed" }],
            [`session-${childB}`, { status: "Running", customStatus: JSON.stringify({ status: "idle" }) }],
        ]);
        const duroxide = makeStubDuroxide(status);
        const tools = createSweeperTools({ catalog, duroxideClient: duroxide, factStore: null });
        const cleanup = findTool(tools, "cleanup_session");

        // Terminal children still clean directly by their own sessionId.
        const a = await cleanup.handler({ sessionId: childA, graceMinutes: 0 });
        // Idle children are live sessions and are no longer cleanup targets.
        const refusedB = await cleanup.handler({ sessionId: childB, graceMinutes: 0 });
        console.log(`  cleanup_session(childA)=${a.ok} cleanup_session(idle childB)=${refusedB.ok}`);
        assertEqual(a.ok, true, "terminal child should be cleaned via cleanup_session");
        assertEqual(refusedB.ok, false, "idle child should be refused even when stale");
        assertEqual(refusedB.refused, true, "idle child refusal should be explicit");
        assertEqual(duroxide.enqueuedEvents.length, 0, "cleanup should not ask parents about idle children");

        assertEqual(await isLive(catalog, childA), false, "child A should be deleted");
        assertEqual(await isLive(catalog, childB), true, "child B should survive because it is live/idle");
        assertEqual(await isLive(catalog, rootId), true, "live parent root must remain after cleaning its children");
        console.log("  ✓ cleanup_session cleans only terminal children; live parent and idle child preserved");
    } finally {
        await catalog.close();
    }
}

async function testBatchGatesEachTarget(env) {
    const catalog = await createCatalog(env);
    try {
        const rootId = randomUUID();
        const childA = randomUUID();
        const childB = randomUUID();
        await catalog.createSession(rootId, { agentId: "generic-crawler" });
        await catalog.createSession(childA, { parentSessionId: rootId });
        await catalog.createSession(childB, { parentSessionId: rootId });

        const status = new Map([
            [`session-${rootId}`, { status: "Running", customStatus: JSON.stringify({ status: "idle", cronActive: true }) }],
            [`session-${childA}`, { status: "Completed" }],
            [`session-${childB}`, { status: "Running", customStatus: JSON.stringify({ status: "idle" }) }],
        ]);
        const tools = createSweeperTools({ catalog, duroxideClient: makeStubDuroxide(status), factStore: null });
        const cleanup = findTool(tools, "cleanup_session");

        // One batch call that (wrongly) includes the live parent root alongside
        // its two stale children. Each id is gated independently: the terminal
        // child is cleaned, the idle child is refused because it is live,
        // and the live root is refused — not deleted.
        const res = await cleanup.handler({ sessionIds: [childA, childB, rootId], graceMinutes: 0 });
        console.log(`  batch -> ok=${res.ok} cleaned=${res.cleanedCount} refused=${res.refusedCount} totalDeleted=${res.totalDeleted}`);
        assertEqual(res.ok, true, "batch call returns ok");
        assertEqual(res.batch, true, "batch flag set");
        assertEqual(res.cleanedCount, 1, "terminal child cleaned");
        assertEqual(res.refusedCount, 2, "the idle child and live root are refused");
        assertEqual(res.totalDeleted, 1, "exactly one session deleted");

        assertEqual(await isLive(catalog, childA), false, "child A deleted");
        assertEqual(await isLive(catalog, childB), true, "child B survives because it is live/idle");
        assertEqual(await isLive(catalog, rootId), true, "live root survives batch (refused)");

        const rootResult = res.results.find(r => r.sessionId === rootId);
        assertNotNull(rootResult, "root has a per-id result");
        assertEqual(rootResult.refused, true, "root result marked refused");
        const idleChildResult = res.results.find(r => r.sessionId === childB);
        assertNotNull(idleChildResult, "idle child has a per-id result");
        assertEqual(idleChildResult.refused, true, "idle child result marked refused");
        console.log("  ✓ batch gates each target independently");
    } finally {
        await catalog.close();
    }
}

async function testBatchCleansAllEligibleAndDedupes(env) {
    const catalog = await createCatalog(env);
    try {
        const ids = [randomUUID(), randomUUID(), randomUUID()];
        for (const id of ids) await catalog.createSession(id); // standalone terminal roots
        const status = new Map(ids.map(id => [`session-${id}`, { status: "Completed" }]));
        const tools = createSweeperTools({ catalog, duroxideClient: makeStubDuroxide(status), factStore: null });
        const cleanup = findTool(tools, "cleanup_session");

        // Pass a duplicate id to exercise de-duplication.
        const res = await cleanup.handler({ sessionIds: [...ids, ids[0]], graceMinutes: 0 });
        console.log(`  batch all-eligible -> requested=${res.requested} cleaned=${res.cleanedCount}`);
        assertEqual(res.requested, 3, "duplicate id is de-duplicated");
        assertEqual(res.cleanedCount, 3, "all three terminal sessions cleaned");
        assertEqual(res.refusedCount, 0, "nothing refused");
        for (const id of ids) assertEqual(await isLive(catalog, id), false, `session ${id.slice(0, 8)} deleted`);
        console.log("  ✓ batch cleans all eligible and de-dupes");
    } finally {
        await catalog.close();
    }
}

describe("Sweeper cleanup guardrails", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("cleanup_session refuses a live root inferred from stale children", { timeout: TIMEOUT }, async () => {
        await testRefusesLiveRoot(getEnv());
    });

    it("cleanup_session still cleans a genuinely terminal target", { timeout: TIMEOUT }, async () => {
        await testCleansTerminalTarget(getEnv());
    });

    it("cleanup_session cleans only terminal children while preserving live children", { timeout: TIMEOUT }, async () => {
        await testCleanupOnlyCleansTerminalChildren(getEnv());
    });

    it("cleanup_session batch gates each target (cleans children, refuses live root)", { timeout: TIMEOUT }, async () => {
        await testBatchGatesEachTarget(getEnv());
    });

    it("cleanup_session batch cleans all eligible targets and de-dupes", { timeout: TIMEOUT }, async () => {
        await testBatchCleansAllEligibleAndDedupes(getEnv());
    });
});
