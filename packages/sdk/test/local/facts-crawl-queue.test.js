/**
 * P1 (enhancedfactstore): base-store crawl queue + EnhancedFactStore guard.
 *
 * Verifies the additive base-store changes from facts migrations 0005/0006:
 *   - FactRecord now exposes `scopeKey`
 *   - readFacts({ scopeKeys }) bulk read-by-key
 *   - readUncrawledFacts / markFactsCrawled work queue with the read→mark race guard
 *   - isEnhancedFactStore(PgFactStore) === false (plain FactStore, no throwing stubs)
 *
 * Vanilla PG only — no HorizonDB required.
 */

import { describe, it, beforeAll } from "vitest";
import { useSuiteEnv, preflightChecks } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { PgFactStore, isEnhancedFactStore } from "../../src/index.ts";

const TIMEOUT = 60_000;
const getEnv = useSuiteEnv(import.meta.url);

async function withPgClient(env, fn) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: env.store });
    try {
        await client.connect();
        return await fn(client);
    } finally {
        try { await client.end(); } catch {}
    }
}

async function rawFact(env, scopeKey) {
    return withPgClient(env, async (client) => {
        const { rows } = await client.query(
            `SELECT scope_key, key, deleted_at, last_crawled_at, etag
             FROM "${env.factsSchema}".facts
             WHERE scope_key = $1`,
            [scopeKey],
        );
        return rows[0] ?? null;
    });
}

async function testScopeKeyExposedAndBulkRead(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        await factStore.storeFact({ key: "alpha/one", value: { v: 1 }, shared: true });
        await factStore.storeFact({ key: "alpha/two", value: { v: 2 }, shared: true });
        await factStore.storeFact({ key: "beta/three", value: { v: 3 }, shared: true });

        const all = await factStore.readFacts({ scope: "shared" }, { unrestricted: true });
        for (const f of all.facts) {
            assert(typeof f.scopeKey === "string" && f.scopeKey.length > 0, "every fact exposes scopeKey");
        }
        const oneKey = all.facts.find((f) => f.key === "alpha/one")?.scopeKey;
        assertEqual(oneKey, "shared:alpha/one", "scopeKey is the canonical shared key");

        // Bulk read-by-key resolves exactly the requested scope keys (ACL applies).
        const byKeys = await factStore.readFacts(
            { scopeKeys: ["shared:alpha/one", "shared:beta/three", "shared:does/not-exist"] },
            { unrestricted: true },
        );
        const gotKeys = new Set(byKeys.facts.map((f) => f.key));
        assertEqual(byKeys.count, 2, "scopeKeys returns only the existing accessible keys");
        assert(gotKeys.has("alpha/one") && gotKeys.has("beta/three"), "scopeKeys resolves the right facts");
        assert(!gotKeys.has("alpha/two"), "scopeKeys does not leak unrequested facts");
    } finally {
        await factStore.close();
    }
}

async function testCrawlQueueRoundTrip(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const ns = `crawl-${Math.random().toString(36).slice(2, 8)}`;
        await factStore.storeFact({ key: `${ns}/a`, value: { v: "a1" }, shared: true });
        await factStore.storeFact({ key: `${ns}/b`, value: { v: "b1" }, shared: true });

        // 1. New facts are uncrawled and carry scopeKey + etag receipts.
        const q1 = await factStore.readUncrawledFacts({ namespace: ns });
        assertEqual(q1.count, 2, "both new facts are uncrawled");
        for (const f of q1.facts) {
            assert(typeof f.scopeKey === "string", "uncrawled fact carries scopeKey");
            assert(typeof f.etag === "number" && f.etag > 0, "uncrawled fact carries etag receipt");
        }

        // 2. Mark both crawled with valid receipts → they leave the queue.
        const stamps = q1.facts.map((f) => ({ scopeKey: f.scopeKey, etag: f.etag }));
        const m1 = await factStore.markFactsCrawled(stamps);
        assertEqual(m1.marked, 2, "both facts marked crawled");
        assertEqual(m1.skipped, 0, "no skips with valid receipts");

        const q2 = await factStore.readUncrawledFacts({ namespace: ns });
        assertEqual(q2.count, 0, "crawled facts leave the queue");

        // 3. Editing a fact re-enters it into the queue.
        await factStore.storeFact({ key: `${ns}/a`, value: { v: "a2-edited" }, shared: true });
        const q3 = await factStore.readUncrawledFacts({ namespace: ns });
        assertEqual(q3.count, 1, "edited fact re-enters the queue");
        assertEqual(q3.facts[0].key, `${ns}/a`, "the edited fact is the one re-queued");

        // 4. A current scopeKey + etag receipt marks the queued fact; a second mark is skipped.
        const marked = await factStore.markFactsCrawled([{ scopeKey: q3.facts[0].scopeKey, etag: q3.facts[0].etag }]);
        assertEqual(marked.marked, 1, "current receipt marks queued fact");
        assertEqual(marked.skipped, 0, "valid queued receipt is not skipped");
        const stale = await factStore.markFactsCrawled([{ scopeKey: q3.facts[0].scopeKey, etag: q3.facts[0].etag }]);
        assertEqual(stale.marked, 0, "already-marked receipt marks nothing");
        assertEqual(stale.skipped, 1, "already-marked receipt is counted as skipped");
        const q4 = await factStore.readUncrawledFacts({ namespace: ns });
        assertEqual(q4.count, 0, "fact leaves queue after mark");

        // 5. markFactsCrawled validates receipt shape.
        let threw = false;
        try {
            await factStore.markFactsCrawled([{ scopeKey: q3.facts[0].scopeKey }]);
        } catch {
            threw = true;
        }
        assert(threw, "markFactsCrawled rejects a malformed stamp");

        // 6. Empty stamps is a no-op.
        const empty = await factStore.markFactsCrawled([]);
        assertEqual(empty.marked, 0, "empty stamps → 0 marked");
        assertEqual(empty.skipped, 0, "empty stamps → 0 skipped");
    } finally {
        await factStore.close();
    }
}

async function testIsEnhancedGuardFalseForBase(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        assertEqual(isEnhancedFactStore(factStore), false, "PgFactStore is a plain FactStore, not enhanced");
        assert(typeof (factStore).searchFacts !== "function", "PgFactStore has no searchFacts (no throwing stub)");
        assert((factStore).capabilities === undefined, "PgFactStore advertises no capabilities");
    } finally {
        await factStore.close();
    }
}

async function testScopeKeysAclAndEdgeCases(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const a = `sess-a-${Math.random().toString(36).slice(2, 8)}`;
        const b = `sess-b-${Math.random().toString(36).slice(2, 8)}`;
        await factStore.storeFact({ key: "priv/x", value: { v: "a" }, sessionId: a });
        await factStore.storeFact({ key: "priv/y", value: { v: "b" }, sessionId: b });
        await factStore.storeFact({ key: "pub/z", value: { v: "s" }, shared: true });

        const aKey = `session:${a}:priv/x`;
        const bKey = `session:${b}:priv/y`;

        // 1. scopeKeys must NOT bypass ACL: reader B asking for A's key gets nothing.
        const bReadsA = await factStore.readFacts({ scopeKeys: [aKey] }, { readerSessionId: b });
        assertEqual(bReadsA.count, 0, "scopeKeys does not bypass session ACL");

        // 2. With a grant, the same read resolves.
        const bGranted = await factStore.readFacts({ scopeKeys: [aKey] }, { readerSessionId: b, grantedSessionIds: [a] });
        assertEqual(bGranted.count, 1, "granted session resolves the scopeKey");
        assertEqual(bGranted.facts[0].key, "priv/x", "granted read returns the right fact");

        // 3. Owner reads its own key.
        const aReadsA = await factStore.readFacts({ scopeKeys: [aKey] }, { readerSessionId: a });
        assertEqual(aReadsA.count, 1, "owner resolves its own scopeKey");

        // 4. Shared keys resolve for anyone.
        const anyShared = await factStore.readFacts({ scopeKeys: ["shared:pub/z"] }, { readerSessionId: b });
        assertEqual(anyShared.count, 1, "shared scopeKey resolves for any reader");

        // 5. EMPTY scopeKeys → empty result (never "return everything"), even unrestricted.
        const emptyUnrestricted = await factStore.readFacts({ scopeKeys: [] }, { unrestricted: true });
        assertEqual(emptyUnrestricted.count, 0, "empty scopeKeys returns nothing under unrestricted");
        const emptyShared = await factStore.readFacts({ scopeKeys: [] }, { readerSessionId: b });
        assertEqual(emptyShared.count, 0, "empty scopeKeys returns nothing under a reader");

        // 6. undefined scopeKeys → normal read (no filter).
        const noFilter = await factStore.readFacts({ scope: "shared" }, { unrestricted: true });
        assert(noFilter.count >= 1, "undefined scopeKeys means no filter (normal read)");

        // 7. Mixed accessible + inaccessible: only the accessible ones come back.
        const mixed = await factStore.readFacts({ scopeKeys: [aKey, bKey, "shared:pub/z"] }, { readerSessionId: a });
        const mixedKeys = new Set(mixed.facts.map((f) => f.key));
        assert(mixedKeys.has("priv/x") && mixedKeys.has("pub/z"), "accessible keys resolve");
        assert(!mixedKeys.has("priv/y"), "inaccessible session key is omitted");

        // 8. Weird key characters in a scopeKey don't break the dynamic-SQL array quoting.
        const weird = `weird/{a},'b";c`;
        await factStore.storeFact({ key: weird, value: { v: "w" }, shared: true });
        const weirdRead = await factStore.readFacts({ scopeKeys: [`shared:${weird}`] }, { unrestricted: true });
        assertEqual(weirdRead.count, 1, "weird-character scopeKey resolves (array quoting holds)");
    } finally {
        await factStore.close();
    }
}

async function testUncrawledNamespaceLiteral(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        // Namespaces containing LIKE metacharacters must match literally.
        const lit = `ns_${Math.random().toString(36).slice(2, 6)}`; // underscore is a LIKE wildcard
        await factStore.storeFact({ key: `${lit}/real`, value: { v: 1 }, shared: true });
        // A key that a raw LIKE `${lit}%` (with `_` as wildcard) could also match
        // if it weren't literal: replace the underscore with another char.
        const decoy = lit.replace("_", "X");
        await factStore.storeFact({ key: `${decoy}/decoy`, value: { v: 2 }, shared: true });

        const q = await factStore.readUncrawledFacts({ namespace: `${lit}/` });
        const keys = q.facts.map((f) => f.key);
        assert(keys.includes(`${lit}/real`), "literal namespace matches its own facts");
        assert(!keys.includes(`${decoy}/decoy`), "underscore is matched literally, not as a wildcard");
    } finally {
        await factStore.close();
    }
}

async function testSoftDeleteEtagConcurrency(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const ns = `soft-${Math.random().toString(36).slice(2, 8)}`;
        const key = `${ns}/race`;
        await factStore.storeFact({ key, value: { v: 1 }, shared: true });

        const q1 = await factStore.readUncrawledFacts({ namespace: `${ns}/` });
        const live = q1.facts.find((f) => f.key === key);
        assert(live, "live fact is initially uncrawled");
        assertEqual(live.deletedAt, null, "live uncrawled fact has no deletedAt");
        const liveEtag = live.etag;

        const deleted = await factStore.deleteFact({ key, shared: true });
        assertEqual(deleted.deleted, true, "deleteFact soft-deletes live fact");
        const hidden = await factStore.readFacts({ scope: "shared", keyPattern: key }, { unrestricted: true });
        assertEqual(hidden.count, 0, "soft-deleted fact is hidden from reads");
        const tombstone = await rawFact(env, live.scopeKey);
        assert(tombstone?.deleted_at, "soft-deleted row remains as a tombstone");
        assertEqual(tombstone.last_crawled_at, null, "delete re-enters crawl queue");
        assert(Number(tombstone.etag) > liveEtag, "delete bumps etag");

        const staleLiveMark = await factStore.markFactsCrawled([{ scopeKey: live.scopeKey, etag: liveEtag }]);
        assertEqual(staleLiveMark.marked, 0, "stale live mark is skipped after delete");
        assertEqual(staleLiveMark.skipped, 1, "stale live mark counted as skipped");

        const q2 = await factStore.readUncrawledFacts({ namespace: `${ns}/` });
        const deletedQueued = q2.facts.find((f) => f.key === key);
        assert(deletedQueued?.deletedAt instanceof Date, "tombstone is visible to crawl queue with deletedAt");
        const markDelete = await factStore.markFactsCrawled([{ scopeKey: deletedQueued.scopeKey, etag: deletedQueued.etag }]);
        assertEqual(markDelete.marked, 1, "delete reconciliation mark succeeds with current etag");

        const purged = await factStore.purgeExpiredFacts(21_600);
        assertEqual(purged, 1, "reconciled tombstone is hard-deleted before TTL");
        assertEqual(await rawFact(env, live.scopeKey), null, "purged tombstone row is gone");
    } finally {
        await factStore.close();
    }
}

async function testReviveAndStaleEtag(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const ns = `revive-${Math.random().toString(36).slice(2, 8)}`;
        const key = `${ns}/same`;
        const value = { v: "same" };
        await factStore.storeFact({ key, value, shared: true });
        const initial = (await factStore.readUncrawledFacts({ namespace: `${ns}/` })).facts[0];
        await factStore.markFactsCrawled([{ scopeKey: initial.scopeKey, etag: initial.etag }]);

        await factStore.deleteFact({ key, shared: true });
        const tombstone = (await factStore.readUncrawledFacts({ namespace: `${ns}/` })).facts[0];
        await factStore.markFactsCrawled([{ scopeKey: tombstone.scopeKey, etag: tombstone.etag }]);
        const reconciled = await rawFact(env, initial.scopeKey);
        assert(reconciled?.deleted_at && reconciled?.last_crawled_at, "tombstone is reconciled before revive");

        await factStore.storeFact({ key, value, shared: true });
        const revived = await rawFact(env, initial.scopeKey);
        assertEqual(revived.deleted_at, null, "revive clears deleted_at");
        assertEqual(revived.last_crawled_at, null, "identical-value revive re-enters crawl queue");
        assert(Number(revived.etag) > Number(reconciled.etag), "identical-value revive bumps etag");

        const queued = (await factStore.readUncrawledFacts({ namespace: `${ns}/` })).facts[0];
        await factStore.storeFact({ key, value: { v: "edited" }, shared: true });
        const stale = await factStore.markFactsCrawled([{ scopeKey: queued.scopeKey, etag: queued.etag }]);
        assertEqual(stale.marked, 0, "stale etag after edit is skipped");
        assertEqual(stale.skipped, 1, "stale etag counted as skipped");
    } finally {
        await factStore.close();
    }
}

async function testIdempotentDeleteAndTtlBackstop(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const ns = `ttl-${Math.random().toString(36).slice(2, 8)}`;
        const key = `${ns}/old`;
        await factStore.storeFact({ key, value: { v: 1 }, shared: true });
        const queued = (await factStore.readUncrawledFacts({ namespace: `${ns}/` })).facts[0];

        assertEqual((await factStore.deleteFact({ key, shared: true })).deleted, true, "first delete affects live row");
        const first = await rawFact(env, queued.scopeKey);
        assertEqual((await factStore.deleteFact({ key, shared: true })).deleted, false, "second delete is a no-op");
        const second = await rawFact(env, queued.scopeKey);
        assertEqual(String(second.deleted_at), String(first.deleted_at), "idempotent delete does not refresh deleted_at");
        assertEqual(Number(second.etag), Number(first.etag), "idempotent delete does not bump etag");
        assertEqual(second.last_crawled_at, null, "idempotent delete does not mark crawled");

        await withPgClient(env, (client) => client.query(
            `UPDATE "${env.factsSchema}".facts SET deleted_at = now() - interval '7 hours' WHERE scope_key = $1`,
            [queued.scopeKey],
        ));
        const stats = await factStore.getFactsTombstoneStats(21_600);
        assertEqual(stats.pendingTotal, 1, "tombstone stats count pending tombstone");
        assertEqual(stats.unreconciled, 1, "tombstone stats count unreconciled tombstone");
        assertEqual(stats.ttlBlocked, 0, "expired tombstone is not ttl-blocked");
        assert(stats.oldestUnreconciledAgeSeconds >= 6 * 60 * 60, "oldest unreconciled age is reported");
        assertEqual(await factStore.purgeExpiredFacts(21_600), 1, "TTL backstop purges old unreconciled tombstone");
    } finally {
        await factStore.close();
    }
}

// M3: the mark path coerces a numeric-string etag exactly like the SQL does
// (LLM tool JSON often serializes numbers as strings), but still rejects junk.
async function testStringEtagMarkCoercion(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const ns = `etagstr-${Math.random().toString(36).slice(2, 8)}`;
        const key = `${ns}/coerce`;
        await factStore.storeFact({ key, value: { v: 1 }, shared: true });
        const queued = (await factStore.readUncrawledFacts({ namespace: `${ns}/` })).facts[0];
        assert(typeof queued.etag === "number" && queued.etag > 0, "queued fact has a numeric etag");

        const marked = await factStore.markFactsCrawled([{ scopeKey: queued.scopeKey, etag: String(queued.etag) }]);
        assertEqual(marked.marked, 1, "numeric-string etag marks the fact crawled");
        assertEqual(marked.skipped, 0, "numeric-string etag is not skipped");

        let threwJunk = false;
        try { await factStore.markFactsCrawled([{ scopeKey: queued.scopeKey, etag: "not-a-number" }]); }
        catch { threwJunk = true; }
        assert(threwJunk, "non-numeric etag is still rejected loudly");

        let threwMissing = false;
        try { await factStore.markFactsCrawled([{ scopeKey: queued.scopeKey }]); }
        catch { threwMissing = true; }
        assert(threwMissing, "missing etag is still rejected loudly");
    } finally {
        await factStore.close();
    }
}

// M4: operator force-purge is selective — onlyUnreconciled spares reconciled
// tombstones, keyPrefix is a literal prefix (starts_with), and the cutoff is an
// exclusive lower bound on tombstone age.
async function testForcePurgeSelectivity(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const ns = `force-${Math.random().toString(36).slice(2, 8)}`;
        const reconciledKey = `${ns}/reconciled`;
        const strandedKey = `${ns}/stranded`;
        await factStore.storeFact({ key: reconciledKey, value: { v: 1 }, shared: true });
        await factStore.storeFact({ key: strandedKey, value: { v: 2 }, shared: true });

        // Soft-delete both → both become unreconciled tombstones in the queue.
        await factStore.deleteFact({ key: reconciledKey, shared: true });
        await factStore.deleteFact({ key: strandedKey, shared: true });

        // Reconcile ONLY the first tombstone (a harvester marks it crawled).
        const tombstones = (await factStore.readUncrawledFacts({ namespace: `${ns}/` })).facts;
        const recon = tombstones.find((f) => f.key === reconciledKey);
        const stranded = tombstones.find((f) => f.key === strandedKey);
        await factStore.markFactsCrawled([{ scopeKey: recon.scopeKey, etag: recon.etag }]);

        const future = new Date(Date.now() + 60_000);
        const purgedUnrecon = await factStore.forcePurgeFacts({ cutoff: future, onlyUnreconciled: true });
        assertEqual(purgedUnrecon, 1, "onlyUnreconciled purges just the unreconciled tombstone");
        assert(await rawFact(env, recon.scopeKey), "reconciled tombstone survives an onlyUnreconciled purge");
        assertEqual(await rawFact(env, stranded.scopeKey), null, "unreconciled tombstone is purged");

        const purgedNoMatch = await factStore.forcePurgeFacts({ cutoff: future, keyPrefix: `${ns}/zzz` });
        assertEqual(purgedNoMatch, 0, "a keyPrefix that matches nothing purges nothing");
        const purgedPrefix = await factStore.forcePurgeFacts({ cutoff: future, keyPrefix: `${ns}/` });
        assertEqual(purgedPrefix, 1, "a matching literal keyPrefix purges the remaining tombstone");
        assertEqual(await rawFact(env, recon.scopeKey), null, "prefix-purged tombstone row is gone");

        // A cutoff in the past spares fresh tombstones (cutoff is exclusive).
        const freshKey = `${ns}/fresh`;
        await factStore.storeFact({ key: freshKey, value: { v: 3 }, shared: true });
        await factStore.deleteFact({ key: freshKey, shared: true });
        const past = new Date(Date.now() - 60_000);
        assertEqual(await factStore.forcePurgeFacts({ cutoff: past }), 0, "a past cutoff spares fresh tombstones");
    } finally {
        await factStore.close();
    }
}

// M5: the TTL backstop reclaims reconciled (safe) tombstones before unreconciled
// ones, so a lagging crawler's evidence is not stranded prematurely. The
// unreconciled row is stored FIRST (lower id) so the old `deleted_at, id` order
// would have purged it first — this test fails without the reconciled-first order.
async function testPurgePrefersReconciled(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const ns = `m5-${Math.random().toString(36).slice(2, 8)}`;
        const unreconKey = `${ns}/unrecon`;
        const reconKey = `${ns}/recon`;
        await factStore.storeFact({ key: unreconKey, value: { v: 1 }, shared: true });
        await factStore.storeFact({ key: reconKey, value: { v: 2 }, shared: true });
        await factStore.deleteFact({ key: unreconKey, shared: true });
        await factStore.deleteFact({ key: reconKey, shared: true });

        // Age BOTH tombstones equally and past the TTL (one UPDATE → identical
        // deleted_at; the trigger re-nulls last_crawled_at, so reconcile AFTER).
        await withPgClient(env, (client) => client.query(
            `UPDATE "${env.factsSchema}".facts SET deleted_at = now() - interval '7 hours' WHERE scope_key = ANY($1)`,
            [[unreconKey, reconKey].map((k) => `shared:${k}`)],
        ));

        const aged = (await factStore.readUncrawledFacts({ namespace: `${ns}/` })).facts;
        const recon = aged.find((f) => f.key === reconKey);
        await factStore.markFactsCrawled([{ scopeKey: recon.scopeKey, etag: recon.etag }]);

        // A single-row backstop pass must reclaim the reconciled tombstone first.
        const purged = await factStore.purgeExpiredFacts(21_600, 1);
        assertEqual(purged, 1, "exactly one tombstone purged in the capped batch");
        assertEqual(await rawFact(env, `shared:${reconKey}`), null, "reconciled tombstone is reclaimed first");
        assert(await rawFact(env, `shared:${unreconKey}`), "unreconciled tombstone is spared in the capped batch");
    } finally {
        await factStore.close();
    }
}

describe("P1: base-store crawl queue + EnhancedFactStore guard", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("FactRecord exposes scopeKey + readFacts({ scopeKeys }) bulk read", { timeout: TIMEOUT }, async () => {
        await testScopeKeyExposedAndBulkRead(getEnv());
    });

    it("scopeKeys respects ACL, empty → empty, weird keys, mixed access", { timeout: TIMEOUT }, async () => {
        await testScopeKeysAclAndEdgeCases(getEnv());
    });

    it("readUncrawledFacts namespace is a literal prefix (no LIKE wildcards)", { timeout: TIMEOUT }, async () => {
        await testUncrawledNamespaceLiteral(getEnv());
    });

    it("crawl queue: read uncrawled → mark crawled → edit re-queues → stale skipped", { timeout: TIMEOUT }, async () => {
        await testCrawlQueueRoundTrip(getEnv());
    });

    it("soft delete: stale live mark skips, delete mark succeeds, purge removes reconciled tombstone", { timeout: TIMEOUT }, async () => {
        await testSoftDeleteEtagConcurrency(getEnv());
    });

    it("soft delete: identical-value revive requeues and stale etag after edit skips", { timeout: TIMEOUT }, async () => {
        await testReviveAndStaleEtag(getEnv());
    });

    it("soft delete: idempotent delete and TTL backstop purge", { timeout: TIMEOUT }, async () => {
        await testIdempotentDeleteAndTtlBackstop(getEnv());
    });

    it("mark crawled: numeric-string etag receipt is coerced, junk is rejected", { timeout: TIMEOUT }, async () => {
        await testStringEtagMarkCoercion(getEnv());
    });

    it("force purge: onlyUnreconciled / keyPrefix / cutoff are selective", { timeout: TIMEOUT }, async () => {
        await testForcePurgeSelectivity(getEnv());
    });

    it("TTL backstop reclaims reconciled tombstones before unreconciled ones", { timeout: TIMEOUT }, async () => {
        await testPurgePrefersReconciled(getEnv());
    });

    it("isEnhancedFactStore(PgFactStore) is false (no throwing stubs)", { timeout: TIMEOUT }, async () => {
        await testIsEnhancedGuardFalseForBase(getEnv());
    });
});
