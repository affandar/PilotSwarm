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
});
