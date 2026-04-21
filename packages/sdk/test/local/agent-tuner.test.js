/**
 * Agent Tuner — read-only diagnostic tools.
 *
 * Verifies the tuner-only set registered by createInspectTools when
 * agentIdentity === "agent-tuner":
 *   - list_all_sessions
 *   - read_session_info
 *   - read_user_stats
 *   - read_session_metric_summary
 *   - read_session_tree_stats
 *   - read_fleet_stats
 *   - read_agent_events with lineage gate bypassed
 *
 * Direct tool-handler tests against a real CMS populated by a parent +
 * sub-agent run. We don't drive the agent-tuner LLM here; that's an
 * end-to-end concern proven separately via the agent prompt and
 * runtime wiring.
 *
 * Run: npx vitest run test/local/agent-tuner.test.js
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
    return tools.find((t) => t.name === name);
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

    await withClient(env, async (client) => {
        const session = await client.createSession();
        parentId = session.sessionId;
        await session.send(
            "Spawn a sub-agent with the task: 'Say hello world and nothing else'",
        );
        const deadline = Date.now() + TIMEOUT;
        const child = await pollForChild(catalog, parentId, deadline);
        childId = child.sessionId;
        await pollForChildEvents(catalog, childId, 3, deadline);
    });

    return { catalog, parentId, childId };
}

describe("Agent Tuner: read-only diagnostic tools", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Registers the tuner-only toolset for agent-tuner identity", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        try {
            const userTools = createInspectTools({ catalog, agentIdentity: "alpha" });
            const tunerTools = createInspectTools({ catalog, agentIdentity: "agent-tuner" });

            assertEqual(userTools.length, 1, "non-tuner gets only read_agent_events");
            assertEqual(userTools[0].name, "read_agent_events", "non-tuner has read_agent_events");

            const tunerNames = tunerTools.map((t) => t.name).sort();
            const expected = [
                "list_all_sessions",
                "read_agent_events",
                "read_fleet_stats",
                "read_session_info",
                "read_session_metric_summary",
                "read_session_tree_stats",
                "read_user_stats",
            ];
            for (const name of expected) {
                assert(tunerNames.includes(name), `tuner toolset missing ${name} (got ${tunerNames.join(",")})`);
            }
            console.log(`  tuner tools: ${tunerNames.join(", ")}`);
        } finally {
            await catalog.close();
        }
    });

    it("Tuner bypasses lineage gate on read_agent_events", { timeout: TIMEOUT * 2 }, async () => {
        const env = getEnv();
        const { catalog, parentId, childId } = await setupParentChild(env);
        try {
            // Unrelated caller (not the parent, not in the lineage)
            const unrelatedCallerId = "00000000-0000-0000-0000-000000000abc";

            const userTools = createInspectTools({ catalog, agentIdentity: "alpha" });
            const userResult = await findTool(userTools, "read_agent_events").handler(
                { agent_id: childId, limit: 5 },
                { sessionId: unrelatedCallerId },
            );
            assertNotNull(userResult.error, "non-tuner caller should be denied");
            assert(/not a descendant/i.test(userResult.error), `error message: ${userResult.error}`);

            const tunerTools = createInspectTools({ catalog, agentIdentity: "agent-tuner" });
            const tunerResult = await findTool(tunerTools, "read_agent_events").handler(
                { agent_id: childId, limit: 5 },
                { sessionId: unrelatedCallerId },
            );
            assertEqual(tunerResult.agentId, childId, "tuner reads any session");
            assertGreaterOrEqual(tunerResult.events.length, 1, "tuner sees events");
            console.log(`  tuner read events=${tunerResult.events.length} from unrelated session`);

            // Tuner is also allowed to read the parent (which is not in its own lineage)
            const tunerOnParent = await findTool(tunerTools, "read_agent_events").handler(
                { agent_id: parentId, limit: 5 },
                { sessionId: unrelatedCallerId },
            );
            assertEqual(tunerOnParent.agentId, parentId, "tuner reads parent too");
            assertGreaterOrEqual(tunerOnParent.events.length, 1, "tuner sees parent events");
        } finally {
            await catalog.close();
        }
    });

    it("Tuner read_session_info / metric / tree / fleet return real data", { timeout: TIMEOUT * 2 }, async () => {
        const env = getEnv();
        const { catalog, parentId, childId } = await setupParentChild(env);
        try {
            const tools = createInspectTools({ catalog, agentIdentity: "agent-tuner" });

            const info = await findTool(tools, "read_session_info").handler(
                { session_id: parentId },
                { sessionId: "tuner-1" },
            );
            assertEqual(info.exists, true, "parent exists");
            assertEqual(info.sessionId, parentId, "info echoes id");
            assert(typeof info.state === "string" && info.state.length > 0, "state populated");

            const summary = await findTool(tools, "read_session_metric_summary").handler(
                { session_id: parentId },
                { sessionId: "tuner-1" },
            );
            // Summary may not be populated yet for very-fast sessions; just shape-check.
            assert("exists" in summary, "summary returns exists field");

            const tree = await findTool(tools, "read_session_tree_stats").handler(
                { session_id: parentId },
                { sessionId: "tuner-1" },
            );
            assert("exists" in tree, "tree returns exists field");

            const list = await findTool(tools, "list_all_sessions").handler(
                { limit: 50, agent_id_filter: "" },
                { sessionId: "tuner-1" },
            );
            assertGreaterOrEqual(list.count, 2, "list contains at least parent + child");
            const ids = list.sessions.map((s) => s.sessionId);
            assert(ids.includes(parentId), "list contains parent");
            assert(ids.includes(childId), "list contains child");

            const fleet = await findTool(tools, "read_fleet_stats").handler(
                {},
                { sessionId: "tuner-1" },
            );
            assertNotNull(fleet, "fleet returns an object");
            assert(typeof fleet === "object", "fleet is an object");
            console.log(`  fleet keys: ${Object.keys(fleet).join(",")}`);
        } finally {
            await catalog.close();
        }
    });

    it("Non-tuner cannot call tuner-only tools (they are not registered)", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        try {
            const userTools = createInspectTools({ catalog, agentIdentity: "alpha" });
            for (const name of [
                "list_all_sessions",
                "read_session_info",
                "read_user_stats",
                "read_session_metric_summary",
                "read_session_tree_stats",
                "read_fleet_stats",
                "read_orchestration_stats",
                "read_execution_history",
                "list_orchestrations_by_status",
            ]) {
                assertEqual(findTool(userTools, name), undefined, `${name} not exposed to non-tuner`);
            }
        } finally {
            await catalog.close();
        }
    });

    it("Duroxide-backed tools register only when a duroxide client is provided", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        try {
            const noClient = createInspectTools({ catalog, agentIdentity: "agent-tuner" });
            for (const name of ["read_orchestration_stats", "read_execution_history", "list_orchestrations_by_status"]) {
                assertEqual(findTool(noClient, name), undefined, `${name} should be absent without duroxide client`);
            }

            const fakeClient = {
                async getOrchestrationStats() { return { historyEventCount: 7, historySizeBytes: 123 }; },
                async getInstanceInfo() { return { orchestrationVersion: "1_0_42", status: "Running" }; },
                async listExecutions() { return [1]; },
                async readExecutionHistory() { return [{ eventId: 1, kind: "OrchestratorStarted", timestampMs: 0 }]; },
                async listInstancesByStatus() { return [{ instanceId: "session-foo", status: "Running" }]; },
            };
            const withClientTools = createInspectTools({ catalog, agentIdentity: "agent-tuner", duroxideClient: fakeClient });

            const stats = await findTool(withClientTools, "read_orchestration_stats").handler(
                { session_id: "abc" },
                { sessionId: "tuner-1" },
            );
            assertEqual(stats.historyEventCount, 7, "stats forwards history event count");
            assertEqual(stats.orchestrationVersion, "1_0_42", "stats forwards orchestration version");

            const history = await findTool(withClientTools, "read_execution_history").handler(
                { session_id: "abc" },
                { sessionId: "tuner-1" },
            );
            assertEqual(history.executionId, 1, "history picks latest execution");
            assertGreaterOrEqual(history.events.length, 1, "history returns events");

            const list = await findTool(withClientTools, "list_orchestrations_by_status").handler(
                { status: "Running" },
                { sessionId: "tuner-1" },
            );
            assertEqual(list.totalCount, 1, "list returns one instance");
            assertEqual(list.instances[0].sessionId, "foo", "list strips session- prefix");
        } finally {
            await catalog.close();
        }
    });
});
