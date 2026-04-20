/**
 * Facts Stats — namespace-bucketed aggregations for per-session,
 * tree, and shared facts.
 *
 * Verifies the migration 0003 facts-schema procs and the management
 * client wiring (per-session + tree + shared). Direct provider tests
 * against a real PgFactStore + CMS catalog populated with seeded facts.
 *
 * Run: npx vitest run test/local/facts-stats.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { PgFactStore, PilotSwarmManagementClient } from "../../src/index.ts";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import {
    assert,
    assertEqual,
    assertGreaterOrEqual,
    assertNotNull,
} from "../helpers/assertions.js";

const TIMEOUT = 60_000;
const getEnv = useSuiteEnv(import.meta.url);

beforeAll(async () => {
    await preflightChecks();
});

async function seedSession(catalog, sessionId, opts = {}) {
    await catalog.createSession(sessionId, opts);
    await catalog.updateSession(sessionId, { state: "running" });
}

function asMap(rows) {
    const m = new Map();
    for (const r of rows) m.set(r.namespace, r);
    return m;
}

describe("Facts Stats", () => {
    it("buckets per-session facts by namespace and ignores shared facts", async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        const factStore = await PgFactStore.create(env.store, env.factsSchema);
        await factStore.initialize();
        try {
            const sid = `sess-${Math.random().toString(36).slice(2, 10)}`;
            await seedSession(catalog, sid, { agentId: "alpha" });

            // Mix of namespaces, plus one shared (must be excluded).
            await factStore.storeFact({ key: "skills/tui/refactor", value: { x: 1 }, sessionId: sid });
            await factStore.storeFact({ key: "skills/foo/bar",     value: { x: 2 }, sessionId: sid });
            await factStore.storeFact({ key: "asks/q1",            value: { x: 3 }, sessionId: sid });
            await factStore.storeFact({ key: "config/setting",     value: { x: 4 }, sessionId: sid });
            await factStore.storeFact({ key: "intake/req1",        value: { x: 5 }, sessionId: sid });
            await factStore.storeFact({ key: "scratch/note",       value: { x: 6 }, sessionId: sid });
            await factStore.storeFact({ key: "shared/foo",         value: { x: 9 }, shared: true, sessionId: null });

            const rows = await factStore.getSessionFactsStats(sid);
            const m = asMap(rows);
            console.log("  namespaces:", rows.map(r => `${r.namespace}=${r.factCount}`).join(", "));

            assertEqual(rows.length, 5, "skills, asks, config, intake, (other)");
            assertEqual(m.get("skills").factCount, 2, "two skills facts");
            assertEqual(m.get("asks").factCount, 1);
            assertEqual(m.get("config").factCount, 1);
            assertEqual(m.get("intake").factCount, 1);
            assertEqual(m.get("(other)").factCount, 1, "scratch/note bucketed as (other)");

            // Shared facts excluded from per-session stats.
            assert(!m.has("shared"), "shared facts must not appear under per-session");
            for (const r of rows) {
                assertGreaterOrEqual(r.totalValueBytes, 1, `${r.namespace} bytes > 0`);
                assertNotNull(r.oldestCreatedAt, `${r.namespace} oldest`);
                assertNotNull(r.newestUpdatedAt, `${r.namespace} newest`);
            }
        } finally {
            await factStore.close();
            await catalog.close();
        }
    }, TIMEOUT);

    it("aggregates facts across an explicit session-id array (tree input)", async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        const factStore = await PgFactStore.create(env.store, env.factsSchema);
        await factStore.initialize();
        try {
            const a = `sess-${Math.random().toString(36).slice(2, 10)}`;
            const b = `sess-${Math.random().toString(36).slice(2, 10)}`;
            await seedSession(catalog, a, { agentId: "parent" });
            await seedSession(catalog, b, { agentId: "child" });

            await factStore.storeFact({ key: "skills/k1", value: { v: "a" }, sessionId: a });
            await factStore.storeFact({ key: "skills/k2", value: { v: "b" }, sessionId: b });
            await factStore.storeFact({ key: "asks/q",    value: { v: "c" }, sessionId: b });

            const rows = await factStore.getFactsStatsForSessions([a, b]);
            const m = asMap(rows);
            console.log("  rolled:", rows.map(r => `${r.namespace}=${r.factCount}`).join(", "));
            assertEqual(m.get("skills").factCount, 2, "skills across two sessions");
            assertEqual(m.get("asks").factCount, 1);

            // Empty array short-circuits in the provider.
            const empty = await factStore.getFactsStatsForSessions([]);
            assertEqual(empty.length, 0);
        } finally {
            await factStore.close();
            await catalog.close();
        }
    }, TIMEOUT);

    it("buckets shared facts and excludes session-scoped ones", async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        const factStore = await PgFactStore.create(env.store, env.factsSchema);
        await factStore.initialize();
        try {
            const sid = `sess-${Math.random().toString(36).slice(2, 10)}`;
            await seedSession(catalog, sid, { agentId: "alpha" });

            await factStore.storeFact({ key: "skills/curated/a", value: { v: 1 }, shared: true, sessionId: null });
            await factStore.storeFact({ key: "skills/curated/b", value: { v: 2 }, shared: true, sessionId: null });
            await factStore.storeFact({ key: "config/global",    value: { v: 3 }, shared: true, sessionId: null });
            // Per-session noise that must NOT appear in shared stats.
            await factStore.storeFact({ key: "skills/private", value: { v: 4 }, sessionId: sid });

            const rows = await factStore.getSharedFactsStats();
            const m = asMap(rows);
            console.log("  shared:", rows.map(r => `${r.namespace}=${r.factCount}`).join(", "));
            assertEqual(m.get("skills").factCount, 2, "two shared skills facts");
            assertEqual(m.get("config").factCount, 1);
            assert(!rows.some(r => r.factCount === 4), "private fact not counted as shared");
        } finally {
            await factStore.close();
            await catalog.close();
        }
    }, TIMEOUT);

    it("management client surfaces session, tree, and shared facts stats", async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        const factStore = await PgFactStore.create(env.store, env.factsSchema);
        await factStore.initialize();
        try {
            const parent = `sess-${Math.random().toString(36).slice(2, 10)}`;
            const child = `sess-${Math.random().toString(36).slice(2, 10)}`;
            await seedSession(catalog, parent, { agentId: "coordinator" });
            await seedSession(catalog, child, { agentId: "alpha", parentSessionId: parent });

            await factStore.storeFact({ key: "skills/p", value: { v: "p1" }, sessionId: parent });
            await factStore.storeFact({ key: "skills/c", value: { v: "c1" }, sessionId: child });
            await factStore.storeFact({ key: "asks/c2",  value: { v: "c2" }, sessionId: child });
            await factStore.storeFact({ key: "skills/s", value: { v: "shared" }, shared: true, sessionId: null });

            const mgmt = new PilotSwarmManagementClient({
                store: env.store,
                cmsSchema: env.cmsSchema,
                factsSchema: env.factsSchema,
                duroxideSchema: env.duroxideSchema,
            });
            await mgmt.start();

            const perSession = await mgmt.getSessionFactsStats(parent);
            console.log("  mgmt per-session totalCount:", perSession.totalCount);
            assertEqual(perSession.totalCount, 1, "parent has 1 session-scoped fact");
            assert(perSession.rows.some(r => r.namespace === "skills"));

            const tree = await mgmt.getSessionTreeFactsStats(parent);
            console.log("  mgmt tree sessions:", tree.sessionIds.length, "total:", tree.totalCount);
            assertEqual(tree.sessionIds.length, 2, "parent + child");
            assertEqual(tree.totalCount, 3, "parent.skills + child.skills + child.asks");

            const shared = await mgmt.getSharedFactsStats();
            console.log("  mgmt shared totalCount:", shared.totalCount);
            assertEqual(shared.totalCount, 1, "one shared fact");

            await mgmt.stop();
        } finally {
            await factStore.close();
            await catalog.close();
        }
    }, TIMEOUT);

    it("returns empty results gracefully for sessions with no facts", async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        const factStore = await PgFactStore.create(env.store, env.factsSchema);
        await factStore.initialize();
        try {
            const sid = `sess-${Math.random().toString(36).slice(2, 10)}`;
            await seedSession(catalog, sid, { agentId: "alpha" });

            const rows = await factStore.getSessionFactsStats(sid);
            assertEqual(rows.length, 0, "no facts → no rows");

            const shared = await factStore.getSharedFactsStats();
            assertEqual(shared.length, 0, "no shared facts → no rows");
        } finally {
            await factStore.close();
            await catalog.close();
        }
    }, TIMEOUT);
});
