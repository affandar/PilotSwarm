/**
 * CMS session-event type-filter integration tests (migration 0025).
 *
 * The 4-arg overloads of cms_get_session_events / cms_get_session_events_before
 * accept p_event_types TEXT[] so chat-history paging can fetch transcript-dense
 * pages instead of draining raw event noise.
 */

import { describe, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual, assertGreaterOrEqual } from "../helpers/assertions.js";
import { PgSessionCatalogProvider } from "../../src/index.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

const CHAT_TYPES = ["user.message", "assistant.message", "system.message"];

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

/**
 * Seed a noise-dominated stream: `total` events where only every `stride`-th
 * event is a chat message (alternating user/assistant), the rest tool noise.
 * Mirrors the production shape that motivated the filter (a session with
 * thousands of tool events between chat messages).
 */
async function seedNoisyStream(env, sessionId, total, stride) {
    await directQuery(
        env,
        `INSERT INTO "${env.cmsSchema}".session_events (session_id, event_type, data, worker_node_id)
         SELECT
           $1,
           CASE
             WHEN gs % $3 = 0 AND (gs / $3) % 2 = 0 THEN 'user.message'
             WHEN gs % $3 = 0 THEN 'assistant.message'
             ELSE 'tool.noise'
           END,
           jsonb_build_object('index', gs),
           'worker-a'
         FROM generate_series(1, $2::int) AS gs`,
        [sessionId, total, stride],
    );
}

describe("CMS session-event type filter", () => {
    it("filters the latest page to the requested event types", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);

        try {
            await catalog.initialize();
            const sessionId = `filter-latest-${Date.now()}`;
            await catalog.createSession(sessionId, { model: "gpt-5.4" });
            // 600 events, a chat message every 20th → 30 chat messages, and the
            // final 19 events are pure noise (the splash-screen scenario: a raw
            // tail window can contain zero renderable messages).
            await seedNoisyStream(env, sessionId, 600, 20);

            const chat = await catalog.getSessionEvents(sessionId, undefined, 300, CHAT_TYPES);
            assertEqual(chat.length, 30, "Should return every chat message, skipping noise");
            for (const event of chat) {
                assert(CHAT_TYPES.includes(event.eventType), `Unexpected event type ${event.eventType}`);
            }
            for (let i = 1; i < chat.length; i += 1) {
                assert(Number(chat[i - 1].seq) < Number(chat[i].seq), "Filtered page should be seq-ascending");
            }

            // Limit applies to the filtered set: latest N chat messages.
            const lastFive = await catalog.getSessionEvents(sessionId, undefined, 5, CHAT_TYPES);
            assertEqual(lastFive.length, 5, "Limit should bound the filtered page");
            assertEqual(
                Number(lastFive[4].seq),
                Number(chat[chat.length - 1].seq),
                "Limited filtered page should end at the newest chat message",
            );

            // Unfiltered read is unchanged (3-arg proc still in place).
            const raw = await catalog.getSessionEvents(sessionId, undefined, 300);
            assertEqual(raw.length, 300, "Unfiltered read should return raw events");
            assert(raw.some((e) => e.eventType === "tool.noise"), "Unfiltered read should include noise");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("filters forward pages after a cursor", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);

        try {
            await catalog.initialize();
            const sessionId = `filter-after-${Date.now()}`;
            await catalog.createSession(sessionId, { model: "gpt-5.4" });
            await seedNoisyStream(env, sessionId, 400, 10);

            const all = await catalog.getSessionEvents(sessionId, undefined, 1000, CHAT_TYPES);
            assertEqual(all.length, 40, "Expected 40 chat messages in the fixture");

            const cursor = Number(all[19].seq);
            const forward = await catalog.getSessionEvents(sessionId, cursor, 1000, CHAT_TYPES);
            assertEqual(forward.length, 20, "Forward page should hold the chat messages after the cursor");
            assert(forward.every((e) => Number(e.seq) > cursor), "Forward page must be strictly after the cursor");
            assert(forward.every((e) => CHAT_TYPES.includes(e.eventType)), "Forward page must honor the filter");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("filters backward pages and exhausts cleanly", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);

        try {
            await catalog.initialize();
            const sessionId = `filter-before-${Date.now()}`;
            await catalog.createSession(sessionId, { model: "gpt-5.4" });
            await seedNoisyStream(env, sessionId, 400, 10);

            const all = await catalog.getSessionEvents(sessionId, undefined, 1000, CHAT_TYPES);
            const cursor = Number(all[all.length - 1].seq);

            // One backward page picks up every older chat message in a single
            // fetch — the payoff over raw paging.
            const older = await catalog.getSessionEventsBefore(sessionId, cursor, 300, CHAT_TYPES);
            assertEqual(older.length, all.length - 1, "Backward page should hold all older chat messages");
            assert(older.every((e) => Number(e.seq) < cursor), "Backward page must be strictly before the cursor");
            assert(older.every((e) => CHAT_TYPES.includes(e.eventType)), "Backward page must honor the filter");
            for (let i = 1; i < older.length; i += 1) {
                assert(Number(older[i - 1].seq) < Number(older[i].seq), "Backward page should be seq-ascending");
            }

            // Below the oldest chat message the filtered page is empty even
            // though raw noise events remain — the client's exhaustion signal.
            const oldestChatSeq = Number(older[0].seq);
            const empty = await catalog.getSessionEventsBefore(sessionId, oldestChatSeq, 300, CHAT_TYPES);
            assertEqual(empty.length, 0, "Filtered page below the oldest chat message should be empty");
            const rawBelow = await catalog.getSessionEventsBefore(sessionId, oldestChatSeq, 300);
            assertGreaterOrEqual(rawBelow.length, 1, "Raw events should still exist below the oldest chat message");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("treats empty/missing type lists as unfiltered", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);

        try {
            await catalog.initialize();
            const sessionId = `filter-empty-${Date.now()}`;
            await catalog.createSession(sessionId, { model: "gpt-5.4" });
            await seedNoisyStream(env, sessionId, 50, 10);

            const viaEmpty = await catalog.getSessionEvents(sessionId, undefined, 1000, []);
            const viaUndefined = await catalog.getSessionEvents(sessionId, undefined, 1000);
            assertEqual(viaEmpty.length, viaUndefined.length, "Empty type list should behave as no filter");
            assertEqual(viaEmpty.length, 50, "Unfiltered read should return everything");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("creates the composite (session_id, event_type, seq) index", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);

        try {
            await catalog.initialize();
            // Match on indexdef, not name: long test-schema names push the
            // interpolated index name past Postgres's 63-char identifier cap.
            const { rows } = await directQuery(
                env,
                `SELECT indexdef FROM pg_indexes
                 WHERE schemaname = $1 AND tablename = 'session_events'
                   AND indexdef LIKE '%(session_id, event_type, seq)%'`,
                [env.cmsSchema],
            );
            assertEqual(rows.length, 1, "Composite type-filter index should exist");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("falls back to the unfiltered proc when the DB predates migration 0025", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);

        try {
            await catalog.initialize();
            const sessionId = `filter-fallback-${Date.now()}`;
            await catalog.createSession(sessionId, { model: "gpt-5.4" });
            await seedNoisyStream(env, sessionId, 40, 10);

            // Simulate a pre-0025 database (e.g. a new portal against an old
            // worker's schema): drop the 4-arg overloads, keep the 3-arg procs.
            await directQuery(env, `DROP FUNCTION "${env.cmsSchema}".cms_get_session_events(TEXT, BIGINT, INT, TEXT[])`);
            await directQuery(env, `DROP FUNCTION "${env.cmsSchema}".cms_get_session_events_before(TEXT, BIGINT, INT, TEXT[])`);

            const latest = await catalog.getSessionEvents(sessionId, undefined, 1000, CHAT_TYPES);
            assertEqual(latest.length, 40, "Fallback should return the unfiltered page");
            const older = await catalog.getSessionEventsBefore(sessionId, Number(latest[latest.length - 1].seq), 1000, CHAT_TYPES);
            assertEqual(older.length, 39, "Fallback backward page should return unfiltered rows");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);
});
