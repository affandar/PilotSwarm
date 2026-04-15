/**
 * Session Stats Management API tests.
 *
 * Verifies:
 *   - CMS migration framework (baseline + session_metric_summaries)
 *   - Summary row lifecycle (create, soft-delete retention, prune)
 *   - Persistence upserts (dehydrate, hydrate, lossy, checkpoint)
 *   - Token usage upserts (cumulative, independent)
 *   - Fleet aggregate reads (grouping, time filter, deleted filter)
 *   - Descendant / tree aggregates
 *   - Denormalization correctness
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import {
    PgSessionCatalogProvider,
} from "../../src/index.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

// ── Helpers ──────────────────────────────────────────────────────

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

async function getSummaryRow(env, sessionId) {
    const schema = env.cmsSchema;
    const { rows } = await directQuery(
        env,
        `SELECT * FROM "${schema}".session_metric_summaries WHERE session_id = $1`,
        [sessionId],
    );
    return rows[0] || null;
}

async function countSummaryRows(env) {
    const schema = env.cmsSchema;
    const { rows } = await directQuery(
        env,
        `SELECT COUNT(*)::int AS count FROM "${schema}".session_metric_summaries`,
    );
    return rows[0].count;
}

// ── Suite 1: Migration framework ─────────────────────────────────

describe("Suite 1: Migration framework", () => {
    it("Test 1: Fresh database applies all migrations in order", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();

        // Verify schema_migrations table exists with all versions
        const { rows } = await directQuery(
            env,
            `SELECT version FROM "${env.cmsSchema}".schema_migrations ORDER BY version`,
        );
        assert(rows.length >= 3, `Expected at least 3 migrations, got ${rows.length}`);
        assertEqual(rows[0].version, "0001", "First migration should be 0001");
        assertEqual(rows[1].version, "0002", "Second migration should be 0002");
        assertEqual(rows[2].version, "0003", "Third migration should be 0003");

        // Verify session_metric_summaries table exists
        const { rows: cols } = await directQuery(
            env,
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = 'session_metric_summaries'
             ORDER BY ordinal_position`,
            [env.cmsSchema],
        );
        assert(cols.length > 0, "session_metric_summaries table should exist");
        const colNames = cols.map(c => c.column_name);
        assert(colNames.includes("session_id"), "Should have session_id column");
        assert(colNames.includes("tokens_input"), "Should have tokens_input column");
        assert(colNames.includes("dehydration_count"), "Should have dehydration_count column");
        assert(colNames.includes("agent_id"), "Should have agent_id column");
        assert(colNames.includes("model"), "Should have model column");
        assert(colNames.includes("parent_session_id"), "Should have parent_session_id column");

        console.log("  ✓ Fresh database applied all migrations");
        await catalog.close();
    }, TIMEOUT);

    it("Test 2: Existing database upgrades without data loss", async () => {
        const env = getEnv();

        // Simulate pre-migration database
        await directQuery(env, `CREATE SCHEMA IF NOT EXISTS "${env.cmsSchema}"`);
        await directQuery(env, `
            CREATE TABLE IF NOT EXISTS "${env.cmsSchema}".sessions (
                session_id TEXT PRIMARY KEY,
                orchestration_id TEXT,
                title TEXT,
                state TEXT NOT NULL DEFAULT 'pending',
                model TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                last_active_at TIMESTAMPTZ,
                deleted_at TIMESTAMPTZ,
                current_iteration INTEGER NOT NULL DEFAULT 0,
                last_error TEXT
            )
        `);
        await directQuery(env, `
            CREATE TABLE IF NOT EXISTS "${env.cmsSchema}".session_events (
                seq BIGSERIAL PRIMARY KEY,
                session_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                data JSONB,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);

        // Insert test data
        await directQuery(
            env,
            `INSERT INTO "${env.cmsSchema}".sessions (session_id, state, model) VALUES ($1, 'running', 'gpt-4')`,
            ["test-session-upgrade"],
        );
        await directQuery(
            env,
            `INSERT INTO "${env.cmsSchema}".session_events (session_id, event_type, data) VALUES ($1, 'user.message', '{"content":"hello"}')`,
            ["test-session-upgrade"],
        );

        // Now run migrations
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();

        // Verify pre-existing data is intact
        const session = await catalog.getSession("test-session-upgrade");
        assert(session !== null, "Pre-existing session should still exist");
        assertEqual(session.model, "gpt-4", "Model should be preserved");

        // Verify backfill created summary row
        const summary = await getSummaryRow(env, "test-session-upgrade");
        assert(summary !== null, "Backfill should have created a summary row");
        assertEqual(Number(summary.tokens_input), 0, "Backfilled tokens_input should be 0");

        console.log("  ✓ Existing database upgraded without data loss");
        await catalog.close();
    }, TIMEOUT);

    it("Test 3: Concurrent startup does not double-apply", async () => {
        const env = getEnv();

        // Start two initializations in parallel
        const [cat1, cat2] = await Promise.all([
            PgSessionCatalogProvider.create(env.store, env.cmsSchema),
            PgSessionCatalogProvider.create(env.store, env.cmsSchema),
        ]);
        await Promise.all([cat1.initialize(), cat2.initialize()]);

        // Verify no duplicate versions
        const { rows } = await directQuery(
            env,
            `SELECT version, COUNT(*)::int AS cnt FROM "${env.cmsSchema}".schema_migrations GROUP BY version HAVING COUNT(*) > 1`,
        );
        assertEqual(rows.length, 0, "No migration version should appear more than once");

        console.log("  ✓ Concurrent startup did not double-apply");
        await cat1.close();
        await cat2.close();
    }, TIMEOUT);
});

// ── Suite 2: Summary row lifecycle ───────────────────────────────

describe("Suite 2: Summary row lifecycle", () => {
    it("Test 5: Session creation seeds a zeroed summary row", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();

        const sid = `test-seed-${Date.now()}`;
        await catalog.createSession(sid, { model: "gpt-5.4", agentId: "test-agent" });

        const summary = await catalog.getSessionMetricSummary(sid);
        assert(summary !== null, "Summary row should exist");
        assertEqual(summary.tokensInput, 0, "tokens_input should be 0");
        assertEqual(summary.tokensOutput, 0, "tokens_output should be 0");
        assertEqual(summary.dehydrationCount, 0, "dehydration_count should be 0");
        assertEqual(summary.hydrationCount, 0, "hydration_count should be 0");
        assertEqual(summary.lossyHandoffCount, 0, "lossy_handoff_count should be 0");
        assertEqual(summary.agentId, "test-agent", "agent_id should match");
        assertEqual(summary.model, "gpt-5.4", "model should match");
        assert(summary.lastDehydratedAt === null, "last_dehydrated_at should be null");
        assert(summary.lastHydratedAt === null, "last_hydrated_at should be null");

        console.log("  ✓ Session creation seeds zeroed summary row");
        await catalog.close();
    }, TIMEOUT);

    it("Test 6: Session deletion marks summary as deleted but retains it", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();

        const sid = `test-delete-${Date.now()}`;
        await catalog.createSession(sid);

        // Add some token usage
        await catalog.upsertSessionMetricSummary(sid, {
            tokensInputIncrement: 500,
            tokensOutputIncrement: 200,
        });

        await catalog.softDeleteSession(sid);

        const summary = await catalog.getSessionMetricSummary(sid);
        assert(summary !== null, "Summary row should still exist after deletion");
        assert(summary.deletedAt !== null, "deleted_at should be set");
        assertEqual(summary.tokensInput, 500, "Token counters should be preserved");
        assertEqual(summary.tokensOutput, 200, "Token counters should be preserved");

        console.log("  ✓ Session deletion retains summary row");
        await catalog.close();
    }, TIMEOUT);
});

// ── Suite 3: Persistence upserts ─────────────────────────────────

describe("Suite 3: Persistence upserts", () => {
    it("Test 7: Dehydrate updates summary atomically", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();

        const sid = `test-dehydrate-${Date.now()}`;
        await catalog.createSession(sid);
        await catalog.upsertSessionMetricSummary(sid, {
            snapshotSizeBytes: 12345,
            dehydrationCountIncrement: 1,
            lastDehydratedAt: true,
        });

        const summary = await catalog.getSessionMetricSummary(sid);
        assertEqual(summary.snapshotSizeBytes, 12345, "snapshot_size_bytes should be 12345");
        assertEqual(summary.dehydrationCount, 1, "dehydration_count should be 1");
        assert(summary.lastDehydratedAt !== null, "last_dehydrated_at should be set");

        console.log("  ✓ Dehydrate updates summary atomically");
        await catalog.close();
    }, TIMEOUT);

    it("Test 8: Hydrate updates summary atomically", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();

        const sid = `test-hydrate-${Date.now()}`;
        await catalog.createSession(sid);
        await catalog.upsertSessionMetricSummary(sid, {
            hydrationCountIncrement: 1,
            lastHydratedAt: true,
        });

        const summary = await catalog.getSessionMetricSummary(sid);
        assertEqual(summary.hydrationCount, 1, "hydration_count should be 1");
        assert(summary.lastHydratedAt !== null, "last_hydrated_at should be set");

        console.log("  ✓ Hydrate updates summary atomically");
        await catalog.close();
    }, TIMEOUT);

    it("Test 9: Multiple dehydrations increment counter", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();

        const sid = `test-multi-dehydrate-${Date.now()}`;
        await catalog.createSession(sid);
        for (let i = 0; i < 3; i++) {
            await catalog.upsertSessionMetricSummary(sid, {
                dehydrationCountIncrement: 1,
                lastDehydratedAt: true,
            });
        }

        const summary = await catalog.getSessionMetricSummary(sid);
        assertEqual(summary.dehydrationCount, 3, "dehydration_count should be 3");

        // Verify only one row
        const { rows } = await directQuery(
            env,
            `SELECT COUNT(*)::int AS cnt FROM "${env.cmsSchema}".session_metric_summaries WHERE session_id = $1`,
            [sid],
        );
        assertEqual(rows[0].cnt, 1, "Should have exactly 1 summary row");

        console.log("  ✓ Multiple dehydrations increment counter");
        await catalog.close();
    }, TIMEOUT);

    it("Test 10: Lossy handoff updates summary", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();

        const sid = `test-lossy-${Date.now()}`;
        await catalog.createSession(sid);
        await catalog.upsertSessionMetricSummary(sid, {
            lossyHandoffCountIncrement: 1,
        });

        const summary = await catalog.getSessionMetricSummary(sid);
        assertEqual(summary.lossyHandoffCount, 1, "lossy_handoff_count should be 1");

        console.log("  ✓ Lossy handoff updates summary");
        await catalog.close();
    }, TIMEOUT);
});

// ── Suite 4: Token usage upserts ─────────────────────────────────

describe("Suite 4: Token usage upserts", () => {
    it("Test 11: Token usage increments cumulatively", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();

        const sid = `test-tokens-${Date.now()}`;
        await catalog.createSession(sid);

        await catalog.upsertSessionMetricSummary(sid, {
            tokensInputIncrement: 100,
            tokensOutputIncrement: 50,
        });
        await catalog.upsertSessionMetricSummary(sid, {
            tokensInputIncrement: 200,
            tokensOutputIncrement: 75,
        });

        const summary = await catalog.getSessionMetricSummary(sid);
        assertEqual(summary.tokensInput, 300, "tokens_input should be 300");
        assertEqual(summary.tokensOutput, 125, "tokens_output should be 125");

        console.log("  ✓ Token usage increments cumulatively");
        await catalog.close();
    }, TIMEOUT);

    it("Test 12: Token usage and persistence are independent", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();

        const sid = `test-independence-${Date.now()}`;
        await catalog.createSession(sid);

        await catalog.upsertSessionMetricSummary(sid, {
            dehydrationCountIncrement: 1,
            snapshotSizeBytes: 9999,
            lastDehydratedAt: true,
        });
        await catalog.upsertSessionMetricSummary(sid, {
            tokensInputIncrement: 500,
            tokensOutputIncrement: 250,
        });

        const summary = await catalog.getSessionMetricSummary(sid);
        assertEqual(summary.dehydrationCount, 1, "dehydration_count should be 1");
        assertEqual(summary.snapshotSizeBytes, 9999, "snapshot_size_bytes should be 9999");
        assertEqual(summary.tokensInput, 500, "tokens_input should be 500");
        assertEqual(summary.tokensOutput, 250, "tokens_output should be 250");

        console.log("  ✓ Token usage and persistence are independent");
        await catalog.close();
    }, TIMEOUT);
});

// ── Suite 5: Fleet aggregate reads ───────────────────────────────

describe("Suite 5: Fleet aggregate reads", () => {
    it("Test 13: Fleet stats aggregate across sessions", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();

        const ts = Date.now();
        await catalog.createSession(`fleet-a1-${ts}`, { agentId: "agent-a", model: "model-x" });
        await catalog.createSession(`fleet-a2-${ts}`, { agentId: "agent-a", model: "model-y" });
        await catalog.createSession(`fleet-b1-${ts}`, { agentId: "agent-b", model: "model-x" });

        await catalog.upsertSessionMetricSummary(`fleet-a1-${ts}`, { tokensInputIncrement: 100 });
        await catalog.upsertSessionMetricSummary(`fleet-a2-${ts}`, { tokensInputIncrement: 200 });
        await catalog.upsertSessionMetricSummary(`fleet-b1-${ts}`, { tokensInputIncrement: 300, dehydrationCountIncrement: 2 });

        const stats = await catalog.getFleetStats();
        assert(stats.totals.sessionCount >= 3, `Expected at least 3 sessions, got ${stats.totals.sessionCount}`);
        assert(stats.totals.totalTokensInput >= 600, `Expected at least 600 tokens, got ${stats.totals.totalTokensInput}`);
        assert(stats.byAgent.length >= 3, `Expected at least 3 groups, got ${stats.byAgent.length}`);

        console.log("  ✓ Fleet stats aggregate across sessions");
        await catalog.close();
    }, TIMEOUT);

    it("Test 14: Deleted sessions excluded by default, included with flag", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();

        const ts = Date.now();
        const sidLive = `fleet-live-${ts}`;
        const sidDead = `fleet-dead-${ts}`;
        await catalog.createSession(sidLive, { agentId: "unique-agent-14", model: "unique-model-14" });
        await catalog.createSession(sidDead, { agentId: "unique-agent-14", model: "unique-model-14" });
        await catalog.upsertSessionMetricSummary(sidLive, { tokensInputIncrement: 100 });
        await catalog.upsertSessionMetricSummary(sidDead, { tokensInputIncrement: 200 });
        await catalog.softDeleteSession(sidDead);

        const liveStats = await catalog.getFleetStats();
        const liveGroup = liveStats.byAgent.find(g => g.agentId === "unique-agent-14" && g.model === "unique-model-14");
        assert(liveGroup !== undefined, "Should have a group for unique-agent-14");
        assertEqual(liveGroup.sessionCount, 1, "Live fleet should have 1 session");
        assertEqual(liveGroup.totalTokensInput, 100, "Live fleet should have 100 tokens");

        const allStats = await catalog.getFleetStats({ includeDeleted: true });
        const allGroup = allStats.byAgent.find(g => g.agentId === "unique-agent-14" && g.model === "unique-model-14");
        assertEqual(allGroup.sessionCount, 2, "All fleet should have 2 sessions");
        assertEqual(allGroup.totalTokensInput, 300, "All fleet should have 300 tokens");

        console.log("  ✓ Deleted sessions excluded by default, included with flag");
        await catalog.close();
    }, TIMEOUT);

    it("Test 15: Fleet stats with time-window filter", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();

        const ts = Date.now();
        const sidOld = `fleet-old-${ts}`;
        const sidNew = `fleet-new-${ts}`;
        await catalog.createSession(sidOld, { agentId: "tw-agent", model: "tw-model" });
        await catalog.createSession(sidNew, { agentId: "tw-agent", model: "tw-model" });
        await catalog.upsertSessionMetricSummary(sidOld, { tokensInputIncrement: 100 });
        await catalog.upsertSessionMetricSummary(sidNew, { tokensInputIncrement: 200 });

        // Backdate the old session's created_at
        await directQuery(
            env,
            `UPDATE "${env.cmsSchema}".session_metric_summaries SET created_at = now() - interval '60 days' WHERE session_id = $1`,
            [sidOld],
        );

        const filtered = await catalog.getFleetStats({ since: new Date(Date.now() - 30 * 86400_000) });
        const filteredGroup = filtered.byAgent.find(g => g.agentId === "tw-agent");
        assertEqual(filteredGroup.sessionCount, 1, "Only 1 session in last 30 days");
        assertEqual(filteredGroup.totalTokensInput, 200, "Only new session's tokens");
        assert(filtered.earliestSessionCreatedAt !== null, "earliestSessionCreatedAt should be set");

        const all = await catalog.getFleetStats();
        const allGroup = all.byAgent.find(g => g.agentId === "tw-agent");
        assertEqual(allGroup.sessionCount, 2, "Both sessions without filter");

        console.log("  ✓ Fleet stats with time-window filter");
        await catalog.close();
    }, TIMEOUT);

    it("Test 15b: Empty fleet returns zero totals and null earliest date", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();

        // Use a since date far in the future to get empty results
        const stats = await catalog.getFleetStats({ since: new Date(Date.now() + 365 * 86400_000) });
        assertEqual(stats.totals.sessionCount, 0, "Session count should be 0");
        assertEqual(stats.totals.totalTokensInput, 0, "Tokens should be 0");
        assert(stats.earliestSessionCreatedAt === null, "earliestSessionCreatedAt should be null");

        console.log("  ✓ Empty fleet returns zero totals");
        await catalog.close();
    }, TIMEOUT);
});

// ── Suite 5b: Pruning ────────────────────────────────────────────

describe("Suite 5b: Pruning", () => {
    it("Test 15c: Prune removes deleted summaries older than cutoff", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();

        const ts = Date.now();
        const sids = [`prune-a-${ts}`, `prune-b-${ts}`, `prune-c-${ts}`];
        for (const sid of sids) {
            await catalog.createSession(sid);
            await catalog.upsertSessionMetricSummary(sid, { tokensInputIncrement: 100 });
            await catalog.softDeleteSession(sid);
        }

        // Backdate 2 of them
        await directQuery(
            env,
            `UPDATE "${env.cmsSchema}".session_metric_summaries SET deleted_at = now() - interval '100 days' WHERE session_id IN ($1, $2)`,
            [sids[0], sids[1]],
        );

        const pruned = await catalog.pruneDeletedSummaries(new Date(Date.now() - 90 * 86400_000));
        assertEqual(pruned, 2, "Should prune 2 old deleted rows");

        const remaining = await catalog.getSessionMetricSummary(sids[2]);
        assert(remaining !== null, "Recently deleted row should still exist");

        const gone = await catalog.getSessionMetricSummary(sids[0]);
        assert(gone === null, "Old deleted row should be gone");

        console.log("  ✓ Prune removes old deleted summaries");
        await catalog.close();
    }, TIMEOUT);

    it("Test 15d: Prune does not touch non-deleted rows", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();

        const ts = Date.now();
        const sid = `prune-live-${ts}`;
        await catalog.createSession(sid);

        const pruned = await catalog.pruneDeletedSummaries(new Date());
        // May be non-zero from other tests' rows; just check our row survives
        const summary = await catalog.getSessionMetricSummary(sid);
        assert(summary !== null, "Non-deleted summary should survive pruning");

        console.log("  ✓ Prune does not touch non-deleted rows");
        await catalog.close();
    }, TIMEOUT);
});

// ── Suite 6: Descendant / tree aggregates ────────────────────────

describe("Suite 6: Descendant / tree aggregates", () => {
    it("Test 16: Session tree stats includes children", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();

        const ts = Date.now();
        const parentId = `tree-parent-${ts}`;
        const child1Id = `tree-child1-${ts}`;
        const child2Id = `tree-child2-${ts}`;
        await catalog.createSession(parentId, { agentId: "parent" });
        await catalog.createSession(child1Id, { agentId: "child1", parentSessionId: parentId });
        await catalog.createSession(child2Id, { agentId: "child2", parentSessionId: parentId });

        await catalog.upsertSessionMetricSummary(parentId, { tokensInputIncrement: 100 });
        await catalog.upsertSessionMetricSummary(child1Id, { tokensInputIncrement: 200 });
        await catalog.upsertSessionMetricSummary(child2Id, { tokensInputIncrement: 300 });

        const tree = await catalog.getSessionTreeStats(parentId);
        assert(tree !== null, "Tree stats should exist");
        assertEqual(tree.self.tokensInput, 100, "Self tokens should be 100");
        assertEqual(tree.tree.sessionCount, 3, "Tree should include 3 sessions");
        assertEqual(tree.tree.totalTokensInput, 600, "Tree total tokens should be 600");

        console.log("  ✓ Session tree stats includes children");
        await catalog.close();
    }, TIMEOUT);

    it("Test 17: Session tree stats includes grandchildren", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();

        const ts = Date.now();
        const parentId = `gc-parent-${ts}`;
        const childId = `gc-child-${ts}`;
        const grandchildId = `gc-grandchild-${ts}`;
        await catalog.createSession(parentId);
        await catalog.createSession(childId, { parentSessionId: parentId });
        await catalog.createSession(grandchildId, { parentSessionId: childId });

        await catalog.upsertSessionMetricSummary(parentId, { tokensInputIncrement: 10 });
        await catalog.upsertSessionMetricSummary(childId, { tokensInputIncrement: 20 });
        await catalog.upsertSessionMetricSummary(grandchildId, { tokensInputIncrement: 30 });

        const tree = await catalog.getSessionTreeStats(parentId);
        assertEqual(tree.tree.sessionCount, 3, "Tree should include 3 sessions");
        assertEqual(tree.tree.totalTokensInput, 60, "Tree total should include grandchild");

        console.log("  ✓ Session tree stats includes grandchildren");
        await catalog.close();
    }, TIMEOUT);

    it("Test 18: Session tree stats includes deleted children", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();

        const ts = Date.now();
        const parentId = `del-tree-parent-${ts}`;
        const childId = `del-tree-child-${ts}`;
        await catalog.createSession(parentId);
        await catalog.createSession(childId, { parentSessionId: parentId });

        await catalog.upsertSessionMetricSummary(parentId, { tokensInputIncrement: 100 });
        await catalog.upsertSessionMetricSummary(childId, { tokensInputIncrement: 200 });
        await catalog.softDeleteSession(childId);

        const tree = await catalog.getSessionTreeStats(parentId);
        assertEqual(tree.tree.sessionCount, 2, "Deleted child should still be in tree");
        assertEqual(tree.tree.totalTokensInput, 300, "Deleted child tokens included");

        console.log("  ✓ Session tree stats includes deleted children");
        await catalog.close();
    }, TIMEOUT);

    it("Test 19: Session with no children returns tree = self", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();

        const sid = `solo-${Date.now()}`;
        await catalog.createSession(sid);
        await catalog.upsertSessionMetricSummary(sid, { tokensInputIncrement: 42 });

        const tree = await catalog.getSessionTreeStats(sid);
        assertEqual(tree.tree.sessionCount, 1, "Solo session tree count should be 1");
        assertEqual(tree.tree.totalTokensInput, 42, "Tree total should equal self");
        assertEqual(tree.self.tokensInput, 42, "Self should match");

        console.log("  ✓ Solo session: tree = self");
        await catalog.close();
    }, TIMEOUT);
});

// ── Suite 7: Denormalization correctness ─────────────────────────

describe("Suite 7: Denormalization correctness", () => {
    it("Test 20: Summary row captures agent_id and model", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();

        const sid = `denorm-${Date.now()}`;
        await catalog.createSession(sid, { agentId: "test-agent", model: "gpt-5.4" });

        const summary = await catalog.getSessionMetricSummary(sid);
        assertEqual(summary.agentId, "test-agent", "agent_id should match");
        assertEqual(summary.model, "gpt-5.4", "model should match");

        console.log("  ✓ Summary captures agent_id and model");
        await catalog.close();
    }, TIMEOUT);

    it("Test 21: Summary row captures parent_session_id", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();

        const ts = Date.now();
        const parentId = `denorm-parent-${ts}`;
        const childId = `denorm-child-${ts}`;
        await catalog.createSession(parentId);
        await catalog.createSession(childId, { parentSessionId: parentId });

        const summary = await catalog.getSessionMetricSummary(childId);
        assertEqual(summary.parentSessionId, parentId, "parent_session_id should match");

        console.log("  ✓ Summary captures parent_session_id");
        await catalog.close();
    }, TIMEOUT);
});

// ── Preflight ────────────────────────────────────────────────────

describe("Session Stats", () => {
    beforeAll(async () => {
        await preflightChecks();
    });

    it("preflight", () => {
        assert(true);
    });
});
