/**
 * Tool: read_agent_events — paginated descendant transcript reader.
 *
 * Tests the tool handler directly against the catalog and a real
 * parent/child session pair. We don't rely on the LLM choosing to call
 * the tool — that's a separate concern (the prompt layer is updated
 * elsewhere and the integration is covered by the existing default
 * agent toolset contract).
 *
 * Run: npx vitest run test/local/inspect-tools.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createInspectTools } from "../../src/index.ts";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import {
    assert,
    assertEqual,
    assertGreaterOrEqual,
    assertNotNull,
} from "../helpers/assertions.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

function findTool(tools, name) {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`tool ${name} not registered`);
    return tool;
}

async function pollForChild(catalog, parentSessionId, deadlineMs) {
    while (Date.now() < deadlineMs) {
        const sessions = await catalog.listSessions();
        const child = sessions.find((s) => s.parentSessionId === parentSessionId);
        if (child) return child;
        await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`no child session for ${parentSessionId.slice(0, 8)} within deadline`);
}

async function pollForChildEvents(catalog, childId, minCount, deadlineMs) {
    while (Date.now() < deadlineMs) {
        const events = await catalog.getSessionEvents(childId, undefined, 500);
        if (events.length >= minCount) return events;
        await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`child ${childId.slice(0, 8)} did not accumulate ${minCount} events in time`);
}

async function setupParentChild(env) {
    const catalog = await createCatalog(env);
    let parentId;
    let childId;
    let allEvents;

    await withClient(env, async (client) => {
        const session = await client.createSession();
        parentId = session.sessionId;
        await session.send(
            "Spawn a sub-agent with the task: 'Say hello world and nothing else'",
        );

        const deadline = Date.now() + TIMEOUT;
        const child = await pollForChild(catalog, parentId, deadline);
        childId = child.sessionId;
        allEvents = await pollForChildEvents(catalog, childId, 3, deadline);
    });

    return { catalog, parentId, childId, allEvents };
}

describe("Inspect Tools: read_agent_events", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Tail page + backward pagination + lineage gate", { timeout: TIMEOUT * 2 }, async () => {
        const env = getEnv();
        const { catalog, parentId, childId, allEvents } = await setupParentChild(env);

        try {
            const tools = createInspectTools({ catalog });
            const tool = findTool(tools, "read_agent_events");

            // Tail page (cursor=null) returns the newest events in chronological order.
            const tail = await tool.handler(
                { agent_id: childId, limit: 2 },
                { sessionId: parentId },
            );
            assertNotNull(tail.events, "tail page should include events array");
            assertEqual(tail.agentId, childId, "agentId echoes the target");
            assertGreaterOrEqual(tail.events.length, 1, "tail page returns at least one event");
            assert(
                tail.events[0].seq < tail.events[tail.events.length - 1].seq
                || tail.events.length === 1,
                "events inside the page are seq-ascending",
            );
            console.log(`  tail: events=${tail.events.length} hasMore=${tail.hasMore} prevCursor=${tail.prevCursor}`);

            // hasMore should be true since the child accumulated >= 3 events and limit=2.
            if (allEvents.length > 2) {
                assert(tail.hasMore, "hasMore=true when more events exist beyond the tail page");
                assertNotNull(tail.prevCursor, "prevCursor populated when hasMore=true");

                const older = await tool.handler(
                    { agent_id: childId, cursor: tail.prevCursor, limit: 5 },
                    { sessionId: parentId },
                );
                assertGreaterOrEqual(older.events.length, 1, "older page returns at least one event");
                assert(
                    older.events.every((e) => e.seq < tail.prevCursor),
                    "older page events have seq < cursor",
                );
                console.log(`  older: events=${older.events.length} firstSeq=${older.events[0]?.seq}`);
            }

            // Lineage gate: a fresh unrelated session id should be rejected.
            const denied = await tool.handler(
                { agent_id: "00000000-0000-0000-0000-000000000000", limit: 5 },
                { sessionId: parentId },
            );
            assertNotNull(denied.error, "non-descendant target should return an error");
            assert(
                /not a descendant/i.test(denied.error),
                `error mentions descendant gate, got: ${denied.error}`,
            );
            console.log(`  non-descendant denied: "${denied.error}"`);

            // Self-read denied.
            const selfDenied = await tool.handler(
                { agent_id: parentId, limit: 5 },
                { sessionId: parentId },
            );
            assertNotNull(selfDenied.error, "self-read should be rejected");
            assert(
                /your own session/i.test(selfDenied.error),
                `error mentions self-read, got: ${selfDenied.error}`,
            );
        } finally {
            await catalog.close();
        }
    });

    it("event_types filter respected; limit clamped to MAX", { timeout: TIMEOUT * 2 }, async () => {
        const env = getEnv();
        const { catalog, parentId, childId, allEvents } = await setupParentChild(env);

        try {
            const tools = createInspectTools({ catalog });
            const tool = findTool(tools, "read_agent_events");

            // Pick a real event type from the child's events to filter on.
            const sampleType = allEvents[0].eventType;
            const filtered = await tool.handler(
                { agent_id: childId, event_types: [sampleType], limit: 50 },
                { sessionId: parentId },
            );
            assert(
                filtered.events.every((e) => e.eventType === sampleType),
                `every returned event matches filter type "${sampleType}"`,
            );
            console.log(`  filter "${sampleType}": ${filtered.events.length}/${allEvents.length} events kept`);

            // limit clamping — passing limit=10000 should not blow up; it gets clamped to 200.
            const big = await tool.handler(
                { agent_id: childId, limit: 10000 },
                { sessionId: parentId },
            );
            assertGreaterOrEqual(big.events.length, 0);
            assert(big.events.length <= 200, "limit clamped to MAX=200");
            console.log(`  limit clamp: returned ${big.events.length} events (cap 200)`);
        } finally {
            await catalog.close();
        }
    });

    it("agent-tuner bypasses lineage gate; non-tuner cannot", { timeout: TIMEOUT * 2 }, async () => {
        const env = getEnv();
        const { catalog, parentId, childId } = await setupParentChild(env);

        try {
            const userTools = createInspectTools({ catalog });
            const tunerTools = createInspectTools({ catalog, agentIdentity: "agent-tuner" });

            const userTool = findTool(userTools, "read_agent_events");
            const tunerTool = findTool(tunerTools, "read_agent_events");

            // Use a synthetic caller that is unrelated to the parent/child tree.
            const unrelatedCaller = "11111111-2222-3333-4444-555555555555";

            const userDenied = await userTool.handler(
                { agent_id: childId, limit: 5 },
                { sessionId: unrelatedCaller },
            );
            assertNotNull(userDenied.error, "unrelated caller without tuner identity is denied");

            const tunerOk = await tunerTool.handler(
                { agent_id: childId, limit: 5 },
                { sessionId: unrelatedCaller },
            );
            assertNotNull(tunerOk.events, "tuner identity bypasses lineage gate");
            assert(!tunerOk.error, `tuner read should succeed, got error: ${tunerOk.error}`);
            console.log(`  tuner read: events=${tunerOk.events.length}`);

            // Also: parent reading its own descendant should still work (sanity).
            const parentOk = await userTool.handler(
                { agent_id: childId, limit: 5 },
                { sessionId: parentId },
            );
            assertGreaterOrEqual(parentOk.events.length, 1, "parent can read its descendant");
        } finally {
            await catalog.close();
        }
    });
});
