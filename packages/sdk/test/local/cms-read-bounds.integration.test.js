/**
 * CMS bounded read integration tests.
 */

import { describe, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual, assertGreaterOrEqual } from "../helpers/assertions.js";
import { PgSessionCatalogProvider } from "../../src/index.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

function makeEvents(count, prefix) {
    return Array.from({ length: count }, (_, i) => ({
        eventType: `${prefix}.${i % 3}`,
        data: { index: i, prefix },
    }));
}

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

describe("CMS read bounds", () => {
    it("pages sessions by updated_at/session_id in bounded slices", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);

        try {
            await catalog.initialize();

            const sessionIds = ["s-001", "s-002", "s-003", "s-004", "s-005"];
            for (const sessionId of sessionIds) {
                await catalog.createSession(sessionId, { model: "gpt-5.4" });
            }

            await catalog.updateSession("s-001", { state: "running" });
            await catalog.updateSession("s-002", { state: "running" });
            await catalog.updateSession("s-003", { state: "running" });
            await catalog.updateSession("s-004", { state: "running" });
            await catalog.updateSession("s-005", { state: "running" });

            const firstPage = await catalog.listSessionsPage({ limit: 2 });
            assertEqual(firstPage.length, 2, "First page should contain 2 rows");

            const cursor = firstPage[firstPage.length - 1];
            const secondPage = await catalog.listSessionsPage({
                limit: 2,
                cursorUpdatedAt: cursor.updatedAt,
                cursorSessionId: cursor.sessionId,
            });

            assertEqual(secondPage.length, 2, "Second page should contain 2 rows");
            const seen = new Set([...firstPage, ...secondPage].map((s) => s.sessionId));
            assertEqual(seen.size, 4, "Paged reads should not repeat session rows");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("clamps oversized latest-event reads in SQL", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);

        try {
            await catalog.initialize();

            const sessionId = `events-${Date.now()}`;
            await catalog.createSession(sessionId, { model: "gpt-5.4" });
            await directQuery(
                env,
                `INSERT INTO "${env.cmsSchema}".session_events (session_id, event_type, data, worker_node_id)
                 SELECT
                   $1,
                   'history.' || ((gs - 1) % 3)::text,
                   jsonb_build_object('index', gs - 1, 'prefix', 'history'),
                   'worker-a'
                 FROM generate_series(1, 520) AS gs`,
                [sessionId],
            );

            const { rows: latest } = await directQuery(
                env,
                `SELECT *
                 FROM "${env.cmsSchema}".cms_get_session_events($1, $2, $3)`,
                [sessionId, null, 10_000],
            );
            assertEqual(latest.length, 500, "getSessionEvents should clamp to 500 rows");
            assert(latest[0].seq < latest[latest.length - 1].seq, "Latest events should be returned in ascending seq order");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("clamps oversized older-event reads in SQL", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);

        try {
            await catalog.initialize();

            const sessionId = `events-before-${Date.now()}`;
            await catalog.createSession(sessionId, { model: "gpt-5.4" });
            await directQuery(
                env,
                `INSERT INTO "${env.cmsSchema}".session_events (session_id, event_type, data, worker_node_id)
                 SELECT
                   $1,
                   'history.' || ((gs - 1) % 3)::text,
                   jsonb_build_object('index', gs - 1, 'prefix', 'history'),
                   'worker-a'
                 FROM generate_series(1, 520) AS gs`,
                [sessionId],
            );

            const { rows: latest } = await directQuery(
                env,
                `SELECT *
                 FROM "${env.cmsSchema}".cms_get_session_events($1, $2, $3)`,
                [sessionId, null, 10_000],
            );
            const beforeCursor = latest[latest.length - 1].seq;

            const { rows: older } = await directQuery(
                env,
                `SELECT *
                 FROM "${env.cmsSchema}".cms_get_session_events_before($1, $2, $3)`,
                [sessionId, beforeCursor, 10_000],
            );
            assertGreaterOrEqual(older.length, 1, "Expected at least one older event page");
            assert(older.length <= 500, "getSessionEventsBefore should clamp to 500 rows");
            assert(older[0].seq < older[older.length - 1].seq, "Older events should be returned in ascending seq order");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("returns bounded top event emitter diagnostics", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);

        try {
            await catalog.initialize();

            const sessionA = `emit-a-${Date.now()}`;
            const sessionB = `emit-b-${Date.now()}`;
            await catalog.createSession(sessionA);
            await catalog.createSession(sessionB);

            await catalog.recordEvents(sessionA, makeEvents(12, "tool"), "worker-hot");
            await catalog.recordEvents(sessionB, makeEvents(4, "tool"), "worker-cold");

            const rows = await catalog.getTopEventEmitters(new Date(Date.now() - 60_000), 1_000);
            assert(rows.length > 0, "Expected top event emitter rows");
            assert(rows.length <= 100, "Top event emitter query should clamp its limit");

            const hottest = rows[0];
            assertEqual(hottest.workerNodeId, "worker-hot", "Expected busiest worker first");
            assertGreaterOrEqual(hottest.eventCount, 4, "Top emitter should have aggregated event rows");
            assert(hottest.firstSeenAt instanceof Date || hottest.firstSeenAt === null, "Expected firstSeenAt to be mapped");
            assert(hottest.lastSeenAt instanceof Date || hottest.lastSeenAt === null, "Expected lastSeenAt to be mapped");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);
});
