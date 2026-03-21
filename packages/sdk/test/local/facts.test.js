/**
 * Level 3/4: durable facts behavior.
 *
 * Verifies:
 *   - facts tools store/read/delete with shared vs session semantics
 *   - session facts are removed when a session is deleted
 *   - sweeper cleanup also removes session facts for descendants
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks } from "../helpers/local-env.js";
import { assert, assertEqual, assertIncludes } from "../helpers/assertions.js";
import {
    PilotSwarmClient,
    PilotSwarmWorker,
    PgFactStore,
    createFactStoreForUrl,
    createFactTools,
    createSweeperTools,
} from "../../src/index.ts";

const TIMEOUT = 120_000;

async function listFactRows(env) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: env.store });
    try {
        await client.connect();
        const { rows } = await client.query(
            `SELECT key, session_id, shared
             FROM "${env.factsSchema}".facts
             ORDER BY key ASC, session_id ASC NULLS LAST`,
        );
        return rows;
    } finally {
        try { await client.end(); } catch {}
    }
}

async function testFactToolsStoreReadDelete(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();

    try {
        const [storeFact, readFacts, deleteFact] = createFactTools({ factStore });

        await storeFact.handler(
            { key: "build/status", value: { status: "running" }, tags: ["build"] },
            { sessionId: "session-a", agentId: "builder" },
        );
        await storeFact.handler(
            { key: "build/status", value: { status: "queued" }, tags: ["build"] },
            { sessionId: "session-b", agentId: "builder" },
        );
        await storeFact.handler(
            { key: "baseline/tps", value: { value: 1250 }, shared: true, tags: ["baseline"] },
            { sessionId: "session-a", agentId: "analyst" },
        );

        const accessible = await readFacts.handler(
            { scope: "accessible" },
            { sessionId: "session-a" },
        );
        assertEqual(accessible.count, 2, "session-a should see its session fact plus shared fact");
        assert(accessible.facts.some((fact) => fact.key === "build/status" && fact.shared === false), "session fact returned");
        assert(accessible.facts.some((fact) => fact.key === "baseline/tps" && fact.shared === true), "shared fact returned");
        assert(!accessible.facts.some((fact) => fact.sessionId === "session-b"), "other session's private fact should be hidden");

        const sessionOnly = await readFacts.handler(
            { scope: "session" },
            { sessionId: "session-b" },
        );
        assertEqual(sessionOnly.count, 1, "session-only read should only return the caller's private facts");
        assertEqual(sessionOnly.facts[0].sessionId, "session-b", "session-only read should stay local");

        const deleted = await deleteFact.handler(
            { key: "build/status" },
            { sessionId: "session-a" },
        );
        assertEqual(deleted.deleted, true, "delete_fact should delete the current session's private fact");

        const rows = await listFactRows(env);
        assertEqual(rows.length, 2, "two facts should remain after deleting session-a's private fact");
        assert(rows.some((row) => row.key === "build/status" && row.session_id === "session-b"), "session-b private fact should remain");
        assert(rows.some((row) => row.key === "baseline/tps" && row.shared === true), "shared fact should remain");
    } finally {
        await factStore.close();
    }
}

async function testDeleteSessionCleansSessionFacts(env) {
    const worker = new PilotSwarmWorker({
        store: env.store,
        githubToken: process.env.GITHUB_TOKEN,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        sessionStateDir: env.sessionStateDir,
        workerNodeId: "facts-delete-worker",
        disableManagementAgents: true,
    });
    const client = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
    });
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();

    await worker.start();
    await client.start();

    try {
        const session = await client.createSession({
            systemMessage: { mode: "replace", content: "Reply with one word." },
        });

        await factStore.storeFact({
            key: "scratch/step",
            value: { step: 2 },
            sessionId: session.sessionId,
            agentId: "builder",
        });
        await factStore.storeFact({
            key: "result/summary",
            value: { summary: "keep me" },
            sessionId: session.sessionId,
            agentId: "builder",
        });
        await factStore.storeFact({
            key: "shared/baseline",
            value: { value: 99 },
            shared: true,
            sessionId: session.sessionId,
            agentId: "builder",
        });

        await client.deleteSession(session.sessionId);

        const rows = await listFactRows(env);
        assertEqual(rows.length, 1, "deleteSession should remove all session-scoped facts");
        assert(!rows.some((row) => row.key === "scratch/step"), "session fact should be removed");
        assert(!rows.some((row) => row.key === "result/summary"), "session facts should not outlive the session");
        assert(rows.some((row) => row.key === "shared/baseline" && row.shared === true), "shared fact should remain");
    } finally {
        await client.stop();
        await worker.stop();
        await factStore.close();
    }
}

async function testSweeperCleanupCleansSessionFacts() {
    const cleanedSessions = [];
    const softDeleted = [];
    const deletedInstances = [];

    const tools = createSweeperTools({
        catalog: {
            async initialize() {},
            async createSession() {},
            async updateSession() {},
            async softDeleteSession(sessionId) { softDeleted.push(sessionId); },
            async listSessions() { return []; },
            async getSession(sessionId) {
                return {
                    sessionId,
                    isSystem: false,
                    title: "Test Session",
                };
            },
            async getDescendantSessionIds() {
                return ["child-a", "child-b"];
            },
            async getLastSessionId() { return null; },
            async recordEvents() {},
            async getSessionEvents() { return []; },
            async close() {},
        },
        duroxideClient: {
            async getStatus() { return { status: "Completed" }; },
            async deleteInstance(instanceId) { deletedInstances.push(instanceId); },
        },
        factStore: {
            async initialize() {},
            async storeFact() { throw new Error("not used"); },
            async readFacts() { return { count: 0, facts: [] }; },
            async deleteFact() { return { key: "", shared: false, deleted: false }; },
            async deleteSessionFactsForSession(sessionId) {
                cleanedSessions.push(sessionId);
                return 1;
            },
            async close() {},
        },
    });

    const cleanupTool = tools.find((tool) => tool.name === "cleanup_session");
    assert(cleanupTool, "cleanup_session tool should exist");

    const result = await cleanupTool.handler({
        sessionId: "root-session",
        reason: "test cleanup",
    });

    assertEqual(result.ok, true, "cleanup_session should succeed");
    assertIncludes(JSON.stringify(cleanedSessions), "root-session", "root session facts should be cleaned");
    assertIncludes(JSON.stringify(cleanedSessions), "child-a", "child-a session facts should be cleaned");
    assertIncludes(JSON.stringify(cleanedSessions), "child-b", "child-b session facts should be cleaned");
    assertEqual(softDeleted.length, 3, "root and descendants should be soft-deleted");
    assertEqual(deletedInstances.length, 3, "root and descendants should be removed from duroxide");
}

async function testNonPostgresStoreRejected() {
    let threw = false;
    try {
        await createFactStoreForUrl("sqlite:///tmp/pilotswarm-facts-local-test.db");
    } catch (err) {
        threw = true;
        assertIncludes(String(err?.message ?? err), "require a PostgreSQL store", "non-Postgres fact store should be rejected");
    }
    assertEqual(threw, true, "createFactStoreForUrl should reject non-PostgreSQL stores");
}

async function testParentReadsChildFactsBySessionId(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();

    try {
        const mockGetDescendants = async (sessionId) => {
            if (sessionId === "parent-session") return ["child-session"];
            return [];
        };
        const [storeFact, readFacts] = createFactTools({
            factStore,
            getDescendantSessionIds: mockGetDescendants,
        });

        // Parent stores a session-scoped fact
        await storeFact.handler(
            { key: "parent/state", value: { step: 1 } },
            { sessionId: "parent-session", agentId: "parent" },
        );
        // Child stores a session-scoped fact
        await storeFact.handler(
            { key: "child/result", value: { answer: 42 } },
            { sessionId: "child-session", agentId: "child" },
        );
        // Unrelated session stores a session-scoped fact
        await storeFact.handler(
            { key: "other/secret", value: { hidden: true } },
            { sessionId: "other-session", agentId: "other" },
        );

        // Parent reads child's facts via session_id filter
        const result = await readFacts.handler(
            { session_id: "child-session" },
            { sessionId: "parent-session" },
        );
        console.log("  parent reads child facts:", result.count);
        assertEqual(result.count, 1, "parent should see child's session-scoped fact");
        assertEqual(result.facts[0].key, "child/result", "parent should see child's fact key");
        assertEqual(result.facts[0].sessionId, "child-session", "fact should belong to child session");

        // Parent cannot read unrelated session's facts via session_id
        const unrelated = await readFacts.handler(
            { session_id: "other-session" },
            { sessionId: "parent-session" },
        );
        console.log("  parent reads unrelated session facts:", unrelated.count);
        assertEqual(unrelated.count, 0, "parent should NOT see unrelated session's private facts");

        // Parent reads child's facts via orchId format "session-<uuid>"
        const orchIdResult = await readFacts.handler(
            { session_id: "session-child-session" },
            { sessionId: "parent-session" },
        );
        console.log("  parent reads child facts via orchId format:", orchIdResult.count);
        assertEqual(orchIdResult.count, 1, "orchId format session_id should be normalized to raw UUID");
        assertEqual(orchIdResult.facts[0].key, "child/result", "orchId format should resolve to child's fact");

        // Parent reads child's facts via session_id + key_pattern combo
        const withPattern = await readFacts.handler(
            { session_id: "child-session", key_pattern: "child/%" },
            { sessionId: "parent-session" },
        );
        console.log("  parent reads child facts with key_pattern:", withPattern.count);
        assertEqual(withPattern.count, 1, "session_id + key_pattern should return child's matching fact");
        assertEqual(withPattern.facts[0].key, "child/result", "key_pattern should filter correctly");

        // Parent reads child's facts via session_id + non-matching key_pattern
        const noMatch = await readFacts.handler(
            { session_id: "child-session", key_pattern: "parent/%" },
            { sessionId: "parent-session" },
        );
        console.log("  parent reads child facts with non-matching pattern:", noMatch.count);
        assertEqual(noMatch.count, 0, "non-matching key_pattern should return 0 even for descendant");
    } finally {
        await factStore.close();
    }
}

async function testMultiLevelDescendantFactsBySessionId(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();

    try {
        // Three-level hierarchy: grandparent → middle → leaf
        const mockGetDescendants = async (sessionId) => {
            if (sessionId === "grandparent") return ["middle", "leaf"];
            if (sessionId === "middle") return ["leaf"];
            return [];
        };

        // Create separate tool sets for each session level (each gets its own ctx)
        const gpTools = createFactTools({ factStore, getDescendantSessionIds: mockGetDescendants });
        const midTools = createFactTools({ factStore, getDescendantSessionIds: mockGetDescendants });
        const leafTools = createFactTools({ factStore, getDescendantSessionIds: mockGetDescendants });

        // Leaf stores a fact
        await leafTools[0].handler(
            { key: "leaf/random-fact", value: "taco-99-dragon" },
            { sessionId: "leaf", agentId: "leaf-agent" },
        );
        // Middle stores a fact
        await midTools[0].handler(
            { key: "middle/random-fact", value: "pizza-42-unicorn" },
            { sessionId: "middle", agentId: "middle-agent" },
        );

        // Middle reads leaf's fact via session_id
        const midReadsLeaf = await midTools[1].handler(
            { session_id: "leaf" },
            { sessionId: "middle" },
        );
        console.log("  middle reads leaf via session_id:", midReadsLeaf.count);
        assertEqual(midReadsLeaf.count, 1, "middle should see leaf's fact via session_id");
        assertEqual(midReadsLeaf.facts[0].key, "leaf/random-fact", "middle sees leaf's fact key");

        // Middle reads leaf's fact via orchId format
        const midReadsLeafOrch = await midTools[1].handler(
            { session_id: "session-leaf" },
            { sessionId: "middle" },
        );
        console.log("  middle reads leaf via orchId session_id:", midReadsLeafOrch.count);
        assertEqual(midReadsLeafOrch.count, 1, "middle should see leaf's fact via orchId format");

        // Grandparent reads middle's fact via session_id
        const gpReadsMid = await gpTools[1].handler(
            { session_id: "middle" },
            { sessionId: "grandparent" },
        );
        console.log("  grandparent reads middle via session_id:", gpReadsMid.count);
        assertEqual(gpReadsMid.count, 1, "grandparent should see middle's fact via session_id");

        // Grandparent reads leaf's fact via session_id
        const gpReadsLeaf = await gpTools[1].handler(
            { session_id: "leaf" },
            { sessionId: "grandparent" },
        );
        console.log("  grandparent reads leaf via session_id:", gpReadsLeaf.count);
        assertEqual(gpReadsLeaf.count, 1, "grandparent should see leaf's fact via session_id");

        // Grandparent reads all via scope=descendants
        const gpAll = await gpTools[1].handler(
            { scope: "descendants" },
            { sessionId: "grandparent" },
        );
        console.log("  grandparent reads all descendants:", gpAll.count);
        assertEqual(gpAll.count, 2, "grandparent should see both middle and leaf facts via descendants scope");

        // Middle cannot read grandparent's fact (not a descendant)
        await gpTools[0].handler(
            { key: "gp/secret", value: "top-secret" },
            { sessionId: "grandparent", agentId: "gp-agent" },
        );
        const midReadsGp = await midTools[1].handler(
            { session_id: "grandparent" },
            { sessionId: "middle" },
        );
        console.log("  middle reads grandparent (should fail):", midReadsGp.count);
        assertEqual(midReadsGp.count, 0, "middle should NOT see grandparent's private facts (not a descendant)");
    } finally {
        await factStore.close();
    }
}

async function testParentReadsAllDescendantFacts(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();

    try {
        const mockGetDescendants = async (sessionId) => {
            if (sessionId === "parent-session") return ["child-session", "grandchild-session"];
            return [];
        };
        const [storeFact, readFacts] = createFactTools({
            factStore,
            getDescendantSessionIds: mockGetDescendants,
        });

        // Store facts across the hierarchy
        await storeFact.handler(
            { key: "parent/plan", value: { plan: "run tests" } },
            { sessionId: "parent-session", agentId: "parent" },
        );
        await storeFact.handler(
            { key: "child/finding", value: { issue: "flaky test" } },
            { sessionId: "child-session", agentId: "child" },
        );
        await storeFact.handler(
            { key: "grandchild/detail", value: { fix: "retry logic" } },
            { sessionId: "grandchild-session", agentId: "grandchild" },
        );
        await storeFact.handler(
            { key: "baseline/tps", value: { value: 1000 }, shared: true },
            { sessionId: "parent-session", agentId: "parent" },
        );
        await storeFact.handler(
            { key: "unrelated/data", value: { nope: true } },
            { sessionId: "unrelated-session", agentId: "unrelated" },
        );

        // Parent reads with scope=descendants
        const result = await readFacts.handler(
            { scope: "descendants" },
            { sessionId: "parent-session" },
        );
        console.log("  parent reads descendants facts:", result.count);
        assertEqual(result.count, 4, "parent should see own + child + grandchild + shared facts");
        assert(result.facts.some((f) => f.key === "parent/plan"), "parent's own fact included");
        assert(result.facts.some((f) => f.key === "child/finding"), "child's fact included");
        assert(result.facts.some((f) => f.key === "grandchild/detail"), "grandchild's fact included");
        assert(result.facts.some((f) => f.key === "baseline/tps"), "shared fact included");
        assert(!result.facts.some((f) => f.key === "unrelated/data"), "unrelated session's fact excluded");
    } finally {
        await factStore.close();
    }
}

async function testDescendantsScopeWithNoSubAgents(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();

    try {
        const mockGetDescendants = async () => [];
        const [storeFact, readFacts] = createFactTools({
            factStore,
            getDescendantSessionIds: mockGetDescendants,
        });

        await storeFact.handler(
            { key: "my/state", value: { step: 1 } },
            { sessionId: "solo-session", agentId: "solo" },
        );
        await storeFact.handler(
            { key: "shared/info", value: { info: "global" }, shared: true },
            { sessionId: "solo-session", agentId: "solo" },
        );

        const descendants = await readFacts.handler(
            { scope: "descendants" },
            { sessionId: "solo-session" },
        );
        const accessible = await readFacts.handler(
            { scope: "accessible" },
            { sessionId: "solo-session" },
        );
        console.log("  descendants vs accessible:", descendants.count, accessible.count);
        assertEqual(descendants.count, accessible.count, "descendants with no children should equal accessible");
        assertEqual(descendants.count, 2, "should see own fact and shared fact");
    } finally {
        await factStore.close();
    }
}

describe.concurrent("Level 3/4: Facts", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("facts tools store, read, and delete with shared/session semantics", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("facts-tools");
        try { await testFactToolsStoreReadDelete(env); } finally { await env.cleanup(); }
    });

    it("deleteSession removes session facts but keeps shared facts", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("facts-delete");
        try { await testDeleteSessionCleansSessionFacts(env); } finally { await env.cleanup(); }
    });

    it("sweeper cleanup removes session facts for descendants too", async () => {
        await testSweeperCleanupCleansSessionFacts();
    });

    it("non-postgres stores are rejected for facts", async () => {
        await testNonPostgresStoreRejected();
    });

    it("parent reads child session facts via session_id lineage check", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("facts-child");
        try { await testParentReadsChildFactsBySessionId(env); } finally { await env.cleanup(); }
    });

    it("multi-level descendant facts read via session_id at each level", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("facts-multi");
        try { await testMultiLevelDescendantFactsBySessionId(env); } finally { await env.cleanup(); }
    });

    it("parent reads all descendants facts via scope=descendants", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("facts-desc");
        try { await testParentReadsAllDescendantFacts(env); } finally { await env.cleanup(); }
    });

    it("scope=descendants with no sub-agents equals accessible", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("facts-nodesc");
        try { await testDescendantsScopeWithNoSubAgents(env); } finally { await env.cleanup(); }
    });
});
