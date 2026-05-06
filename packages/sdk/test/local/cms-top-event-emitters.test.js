/**
 * Integration tests for migration 0013: cms_get_top_event_emitters.
 *
 * Verifies event-emitter aggregation, SQL-side limit bounds, time-window
 * filtering, and null worker_node_id exclusion.
 *
 * Uses PgSessionCatalogProvider directly; no LLM or worker needed.
 * When PostgreSQL is unreachable all tests self-skip (exit code 0).
 */

import { describe, it, beforeAll } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { PgSessionCatalogProvider } from "../../src/index.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

let dbAvailable = false;

beforeAll(async () => {
    const env = getEnv();
    const { default: pg } = await import("pg");
    const client = new pg.Client({
        connectionString: env.store,
        connectionTimeoutMillis: 4000,
    });
    try {
        await client.connect();
        await client.query("SELECT 1");
        dbAvailable = true;
    } catch {
        // DB not reachable — all tests will self-skip
    } finally {
        try { await client.end(); } catch {}
    }
});

// ─── Helpers ─────────────────────────────────────────────────────

async function directQuery(env, sql, params = []) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: env.store });
    try {
        await client.connect();
        return await client.query(sql, params);
    } finally {
        try { await client.end(); } catch {}
    }
}

async function makeCatalog(env) {
    const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
    await catalog.initialize();
    return catalog;
}

/** Insert session_events with specific worker_node_id and event_type. */
async function insertTaggedEvents(env, sessionId, workerNodeId, eventType, count) {
    await directQuery(
        env,
        `
        INSERT INTO "${env.cmsSchema}".session_events
            (session_id, event_type, data, worker_node_id)
        SELECT $1, $2, '{}', $3
        FROM generate_series(1, $4)
        `,
        [sessionId, eventType, workerNodeId, count],
    );
}

// ─── Tests ───────────────────────────────────────────────────────

describe("cms_get_top_event_emitters", () => {
    it("returns empty array when no events exist in window", async (ctx) => {
        if (!dbAvailable) return ctx.skip();
        const env = getEnv();
        const catalog = await makeCatalog(env);
        const since = new Date(Date.now() + 60_000); // 1 minute in the future — no events
        const rows = await catalog.getTopEventEmitters({ since });
        assertEqual(rows.length, 0, "no events should be returned");
        await catalog.close();
    }, TIMEOUT);

    it("returns correct aggregation for a single emitter", async (ctx) => {
        if (!dbAvailable) return ctx.skip();
        const env = getEnv();
        const catalog = await makeCatalog(env);
        const sid = `tee-single-${Date.now()}`;
        await catalog.createSession(sid);
        await insertTaggedEvents(env, sid, "wk-tee-a", "tool.call", 10);

        const since = new Date(Date.now() - 60_000);
        const rows = await catalog.getTopEventEmitters({ since });
        const row = rows.find(r => r.workerNodeId === "wk-tee-a" && r.eventType === "tool.call");
        assert(row !== undefined, "expected row for wk-tee-a/tool.call");
        assert(row.eventCount >= 10, `expected eventCount >= 10, got ${row.eventCount}`);
        assertEqual(row.sessionCount, 1, "single session");
        assert(row.firstSeenAt instanceof Date, "firstSeenAt should be a Date");
        assert(row.lastSeenAt instanceof Date, "lastSeenAt should be a Date");

        await catalog.close();
    }, TIMEOUT);

    it("groups correctly across multiple sessions for same worker+eventType", async (ctx) => {
        if (!dbAvailable) return ctx.skip();
        const env = getEnv();
        const catalog = await makeCatalog(env);
        const tag = `tee-multi-${Date.now()}`;
        const sid1 = `${tag}-s1`;
        const sid2 = `${tag}-s2`;
        await catalog.createSession(sid1);
        await catalog.createSession(sid2);
        await insertTaggedEvents(env, sid1, `wk-${tag}`, "agent.step", 5);
        await insertTaggedEvents(env, sid2, `wk-${tag}`, "agent.step", 7);

        const since = new Date(Date.now() - 60_000);
        const rows = await catalog.getTopEventEmitters({ since });
        const row = rows.find(r => r.workerNodeId === `wk-${tag}` && r.eventType === "agent.step");
        assert(row !== undefined, "expected aggregated row");
        assert(row.eventCount >= 12, `expected eventCount >= 12, got ${row.eventCount}`);
        assert(row.sessionCount >= 2, `expected sessionCount >= 2, got ${row.sessionCount}`);

        await catalog.close();
    }, TIMEOUT);

    it("excludes events with null worker_node_id", async (ctx) => {
        if (!dbAvailable) return ctx.skip();
        const env = getEnv();
        const catalog = await makeCatalog(env);
        const sid = `tee-null-wk-${Date.now()}`;
        await catalog.createSession(sid);
        // Insert with NULL worker_node_id directly
        await directQuery(
            env,
            `INSERT INTO "${env.cmsSchema}".session_events (session_id, event_type, data, worker_node_id)
             VALUES ($1, 'null.worker.event', '{}', NULL)`,
            [sid],
        );

        const since = new Date(Date.now() - 60_000);
        const rows = await catalog.getTopEventEmitters({ since });
        const nullRow = rows.find(r => r.eventType === "null.worker.event");
        assert(nullRow === undefined, "events with null worker_node_id should be excluded");

        await catalog.close();
    }, TIMEOUT);

    it("orders by event_count DESC", async (ctx) => {
        if (!dbAvailable) return ctx.skip();
        const env = getEnv();
        const catalog = await makeCatalog(env);
        const tag = `tee-order-${Date.now()}`;
        const sid = `${tag}-s`;
        await catalog.createSession(sid);
        await insertTaggedEvents(env, sid, `wk-${tag}-hi`, "ev.hi", 30);
        await insertTaggedEvents(env, sid, `wk-${tag}-lo`, "ev.lo", 5);

        const since = new Date(Date.now() - 60_000);
        const rows = await catalog.getTopEventEmitters({ since, limit: 100 });
        const hiIdx = rows.findIndex(r => r.workerNodeId === `wk-${tag}-hi`);
        const loIdx = rows.findIndex(r => r.workerNodeId === `wk-${tag}-lo`);
        assert(hiIdx !== -1 && loIdx !== -1, "both rows should be present");
        assert(hiIdx < loIdx, `high-count row (${hiIdx}) should precede low-count row (${loIdx})`);

        await catalog.close();
    }, TIMEOUT);

    it("SQL COALESCE default: NULL p_limit returns 20 rows", async (ctx) => {
        if (!dbAvailable) return ctx.skip();
        const env = getEnv();
        const catalog = await makeCatalog(env);
        const tag = `tee-coalesce-${Date.now()}`;
        // Insert 30 distinct (worker, event_type) combinations
        for (let i = 1; i <= 30; i++) {
            const sid = `${tag}-s${i}`;
            await catalog.createSession(sid);
            await insertTaggedEvents(env, sid, `wk-${tag}-${i}`, "ev.type", 1);
        }

        const result = await directQuery(
            env,
            `SELECT * FROM "${env.cmsSchema}".cms_get_top_event_emitters($1, NULL)`,
            [new Date(Date.now() - 60_000)],
        );
        assertEqual(result.rows.length, 20, "NULL p_limit should COALESCE to 20");

        await catalog.close();
    }, TIMEOUT);

    it("SQL LEAST: p_limit=9999 is capped to 100", async (ctx) => {
        if (!dbAvailable) return ctx.skip();
        const env = getEnv();
        const catalog = await makeCatalog(env);
        const tag = `tee-cap-${Date.now()}`;
        for (let i = 1; i <= 120; i++) {
            const sid = `${tag}-s${i}`;
            await catalog.createSession(sid);
            await insertTaggedEvents(env, sid, `wk-${tag}-${i}`, "ev.type", 1);
        }

        const result = await directQuery(
            env,
            `SELECT * FROM "${env.cmsSchema}".cms_get_top_event_emitters($1, 9999)`,
            [new Date(Date.now() - 60_000)],
        );
        assertEqual(result.rows.length, 100, "p_limit=9999 should cap to 100");

        await catalog.close();
    }, TIMEOUT);

    it("SQL GREATEST: p_limit=0 is clamped to 1", async (ctx) => {
        if (!dbAvailable) return ctx.skip();
        const env = getEnv();
        const catalog = await makeCatalog(env);
        const tag = `tee-zero-${Date.now()}`;
        const sid = `${tag}-s`;
        await catalog.createSession(sid);
        await insertTaggedEvents(env, sid, `wk-${tag}`, "ev.zero", 5);

        const result = await directQuery(
            env,
            `SELECT * FROM "${env.cmsSchema}".cms_get_top_event_emitters($1, 0)`,
            [new Date(Date.now() - 60_000)],
        );
        assertEqual(result.rows.length, 1, "p_limit=0 should clamp to 1");

        await catalog.close();
    }, TIMEOUT);

    it("app-side clamp: limit>100 is capped to 100", async (ctx) => {
        if (!dbAvailable) return ctx.skip();
        const env = getEnv();
        const catalog = await makeCatalog(env);
        const tag = `tee-appclamp-${Date.now()}`;
        for (let i = 1; i <= 120; i++) {
            const sid = `${tag}-s${i}`;
            await catalog.createSession(sid);
            await insertTaggedEvents(env, sid, `wk-${tag}-${i}`, "ev.type", 1);
        }

        const rows = await catalog.getTopEventEmitters({
            since: new Date(Date.now() - 60_000),
            limit: 9999,
        });
        assert(rows.length <= 100, `app-side cap should limit to ≤100, got ${rows.length}`);

        await catalog.close();
    }, TIMEOUT);

    it("respects p_since window: excludes old events", async (ctx) => {
        if (!dbAvailable) return ctx.skip();
        const env = getEnv();
        const catalog = await makeCatalog(env);
        const tag = `tee-window-${Date.now()}`;
        const sid = `${tag}-s`;
        await catalog.createSession(sid);
        await insertTaggedEvents(env, sid, `wk-${tag}`, "ev.old", 10);

        // Use a since in the future to exclude all just-inserted events
        const rows = await catalog.getTopEventEmitters({
            since: new Date(Date.now() + 60_000),
            limit: 100,
        });
        const found = rows.find(r => r.workerNodeId === `wk-${tag}`);
        assert(found === undefined, "events outside the since window should be excluded");

        await catalog.close();
    }, TIMEOUT);
});
