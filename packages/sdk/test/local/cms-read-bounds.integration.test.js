/**
 * Integration tests for migration 0012: SQL-side read bounds.
 *
 * Verifies that cms_get_session_events, cms_get_session_events_before, and
 * cms_get_session_turn_metrics enforce server-side COALESCE/GREATEST/LEAST
 * limits regardless of what the TypeScript layer passes in.
 *
 * Uses PgSessionCatalogProvider directly; no LLM or worker needed.
 *
 * When PostgreSQL is unreachable all tests self-skip (exit code 0).
 */

import { describe, it, beforeAll } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { PgSessionCatalogProvider } from "../../src/index.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

// Set to true once preflight succeeds; all tests guard on this flag.
let dbAvailable = false;

// ─── Preflight ───────────────────────────────────────────────────
//
// Must NOT throw — a throwing beforeAll causes vitest to report the
// suite as failed even when tests are individually skipped.

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
        // DB not reachable — all tests will self-skip via ctx.skip()
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

/** Insert N session_events for a given session via direct SQL. */
async function insertEvents(env, sessionId, count) {
    await directQuery(
        env,
        `
        INSERT INTO "${env.cmsSchema}".session_events
            (session_id, event_type, data, worker_node_id)
        SELECT $1, 'test.event', '{}', 'wk-bounds'
        FROM generate_series(1, $2)
        `,
        [sessionId, count],
    );
}

/** Insert N turn_metrics rows for a given session via direct SQL. */
async function insertTurnMetrics(env, sessionId, count) {
    await directQuery(
        env,
        `
        INSERT INTO "${env.cmsSchema}".session_turn_metrics (
            session_id, agent_id, model, turn_index,
            started_at, ended_at, duration_ms,
            tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
            tool_calls, tool_errors, result_type, error_message, worker_node_id
        )
        SELECT
            $1, 'ag-bounds', 'claude-sonnet-4-6', gs,
            now() - (gs || ' seconds')::interval,
            now() - ((gs - 1) || ' seconds')::interval,
            1000,
            10, 5, 1, 0, 1, 0, 'completed', NULL, 'wk-bounds'
        FROM generate_series(1, $2) AS gs
        `,
        [sessionId, count],
    );
}

// ─── cms_get_session_events ───────────────────────────────────────

describe("cms_get_session_events SQL bounds", () => {
    it("p_limit=9999 is capped to 500", async (ctx) => {
        if (!dbAvailable) return ctx.skip();
        const env = getEnv();
        const catalog = await makeCatalog(env);
        const sid = `events-bounds-cap-${Date.now()}`;
        await catalog.createSession(sid);
        await insertEvents(env, sid, 600);

        const rows = await catalog.getSessionEvents(sid, undefined, 9999);
        assertEqual(rows.length, 500, "p_limit=9999 should cap to 500 (SQL LEAST)");

        await catalog.close();
    }, TIMEOUT);

    it("p_limit=0 is clamped to 1", async (ctx) => {
        if (!dbAvailable) return ctx.skip();
        const env = getEnv();
        const catalog = await makeCatalog(env);
        const sid = `events-bounds-zero-${Date.now()}`;
        await catalog.createSession(sid);
        await insertEvents(env, sid, 5);

        const rows = await catalog.getSessionEvents(sid, undefined, 0);
        assertEqual(rows.length, 1, "p_limit=0 should clamp to 1 (SQL GREATEST)");

        await catalog.close();
    }, TIMEOUT);

    it("SQL COALESCE default: NULL p_limit returns 200 rows", async (ctx) => {
        if (!dbAvailable) return ctx.skip();
        const env = getEnv();
        const catalog = await makeCatalog(env);
        const sid = `events-bounds-sql-null-${Date.now()}`;
        await catalog.createSession(sid);
        await insertEvents(env, sid, 250);

        // Call the SQL function directly with explicit NULL — bypasses the
        // TypeScript DEFAULT_EVENT_FETCH_LIMIT=200 injection so we verify
        // the SQL-side COALESCE(p_limit, 200) default independently.
        const result = await directQuery(
            env,
            `SELECT * FROM "${env.cmsSchema}".cms_get_session_events($1, NULL, NULL)`,
            [sid],
        );
        assertEqual(result.rows.length, 200, "SQL NULL p_limit should COALESCE to 200");

        await catalog.close();
    }, TIMEOUT);

    it("valid limit within range passes through unchanged", async (ctx) => {
        if (!dbAvailable) return ctx.skip();
        const env = getEnv();
        const catalog = await makeCatalog(env);
        const sid = `events-bounds-valid-${Date.now()}`;
        await catalog.createSession(sid);
        await insertEvents(env, sid, 100);

        const rows = await catalog.getSessionEvents(sid, undefined, 50);
        assertEqual(rows.length, 50, "limit=50 should return exactly 50");

        await catalog.close();
    }, TIMEOUT);
});

// ─── cms_get_session_events_before ───────────────────────────────

describe("cms_get_session_events_before SQL bounds", () => {
    it("p_limit=9999 is capped to 500", async (ctx) => {
        if (!dbAvailable) return ctx.skip();
        const env = getEnv();
        const catalog = await makeCatalog(env);
        const sid = `events-before-cap-${Date.now()}`;
        await catalog.createSession(sid);
        await insertEvents(env, sid, 600);

        const all = await catalog.getSessionEvents(sid, undefined, 500);
        assert(all.length > 0, "expected events");
        const maxSeq = all[all.length - 1].seq;

        const rows = await catalog.getSessionEventsBefore(sid, maxSeq + 1, 9999);
        assertEqual(rows.length, 500, "p_limit=9999 should cap to 500");

        await catalog.close();
    }, TIMEOUT);

    it("p_limit=0 is clamped to 1", async (ctx) => {
        if (!dbAvailable) return ctx.skip();
        const env = getEnv();
        const catalog = await makeCatalog(env);
        const sid = `events-before-zero-${Date.now()}`;
        await catalog.createSession(sid);
        await insertEvents(env, sid, 5);

        const all = await catalog.getSessionEvents(sid);
        const maxSeq = all[all.length - 1].seq;

        const rows = await catalog.getSessionEventsBefore(sid, maxSeq + 1, 0);
        assertEqual(rows.length, 1, "p_limit=0 should clamp to 1");

        await catalog.close();
    }, TIMEOUT);

    it("SQL COALESCE default: NULL p_limit returns 200 rows", async (ctx) => {
        if (!dbAvailable) return ctx.skip();
        const env = getEnv();
        const catalog = await makeCatalog(env);
        const sid = `events-before-sql-null-${Date.now()}`;
        await catalog.createSession(sid);
        await insertEvents(env, sid, 250);

        const all = await catalog.getSessionEvents(sid, undefined, 500);
        const maxSeq = all[all.length - 1].seq;

        // Call SQL directly with explicit NULL — verifies COALESCE(p_limit, 200)
        // independently of the TypeScript DEFAULT_EVENT_FETCH_LIMIT injection.
        const result = await directQuery(
            env,
            `SELECT * FROM "${env.cmsSchema}".cms_get_session_events_before($1, $2, NULL)`,
            [sid, maxSeq + 1],
        );
        assertEqual(result.rows.length, 200, "SQL NULL p_limit should COALESCE to 200");

        await catalog.close();
    }, TIMEOUT);
});

// ─── cms_get_session_turn_metrics ────────────────────────────────

describe("cms_get_session_turn_metrics SQL bounds", () => {
    it("p_limit=9999 is capped to 500", async (ctx) => {
        if (!dbAvailable) return ctx.skip();
        const env = getEnv();
        const catalog = await makeCatalog(env);
        const sid = `turn-metrics-cap-${Date.now()}`;
        await catalog.createSession(sid, { agentId: "ag-bounds", model: "claude-sonnet-4-6" });
        await insertTurnMetrics(env, sid, 600);

        const rows = await catalog.getSessionTurnMetrics(sid, { limit: 9999 });
        assertEqual(rows.length, 500, "p_limit=9999 should cap to 500");

        await catalog.close();
    }, TIMEOUT);

    it("p_limit=0 is clamped to 1", async (ctx) => {
        if (!dbAvailable) return ctx.skip();
        const env = getEnv();
        const catalog = await makeCatalog(env);
        const sid = `turn-metrics-zero-${Date.now()}`;
        await catalog.createSession(sid, { agentId: "ag-bounds", model: "claude-sonnet-4-6" });
        await insertTurnMetrics(env, sid, 5);

        const rows = await catalog.getSessionTurnMetrics(sid, { limit: 0 });
        assertEqual(rows.length, 1, "p_limit=0 should clamp to 1");

        await catalog.close();
    }, TIMEOUT);

    it("SQL COALESCE default: NULL p_limit returns 200 rows", async (ctx) => {
        if (!dbAvailable) return ctx.skip();
        const env = getEnv();
        const catalog = await makeCatalog(env);
        const sid = `turn-metrics-sql-null-${Date.now()}`;
        await catalog.createSession(sid, { agentId: "ag-bounds", model: "claude-sonnet-4-6" });
        await insertTurnMetrics(env, sid, 250);

        // Call SQL directly with explicit NULL — verifies COALESCE(p_limit, 200)
        // independently of the TypeScript opts?.limit ?? 200 injection.
        const result = await directQuery(
            env,
            `SELECT * FROM "${env.cmsSchema}".cms_get_session_turn_metrics($1, NULL, NULL)`,
            [sid],
        );
        assertEqual(result.rows.length, 200, "SQL NULL p_limit should COALESCE to 200");

        await catalog.close();
    }, TIMEOUT);

    it("valid limit within range passes through unchanged", async (ctx) => {
        if (!dbAvailable) return ctx.skip();
        const env = getEnv();
        const catalog = await makeCatalog(env);
        const sid = `turn-metrics-valid-${Date.now()}`;
        await catalog.createSession(sid, { agentId: "ag-bounds", model: "claude-sonnet-4-6" });
        await insertTurnMetrics(env, sid, 100);

        const rows = await catalog.getSessionTurnMetrics(sid, { limit: 75 });
        assertEqual(rows.length, 75, "limit=75 should return exactly 75");

        await catalog.close();
    }, TIMEOUT);

    it("ordering is preserved (turn_index DESC)", async (ctx) => {
        if (!dbAvailable) return ctx.skip();
        const env = getEnv();
        const catalog = await makeCatalog(env);
        const sid = `turn-metrics-order-${Date.now()}`;
        await catalog.createSession(sid, { agentId: "ag-bounds", model: "claude-sonnet-4-6" });
        await insertTurnMetrics(env, sid, 10);

        const rows = await catalog.getSessionTurnMetrics(sid, { limit: 10 });
        assertEqual(rows.length, 10, "should get 10 rows");
        for (let i = 1; i < rows.length; i++) {
            assert(
                rows[i - 1].turnIndex >= rows[i].turnIndex,
                `ordering broken at index ${i}: ${rows[i - 1].turnIndex} < ${rows[i].turnIndex}`,
            );
        }

        await catalog.close();
    }, TIMEOUT);
});
