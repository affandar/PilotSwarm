/**
 * P1 (enhancedfactstore): base-store crawl queue + EnhancedFactStore guard.
 *
 * Verifies the additive base-store changes from facts migrations 0005/0006:
 *   - FactRecord now exposes `scopeKey`
 *   - readFacts({ scopeKeys }) bulk read-by-key
 *   - readUncrawledFacts / setFactsCrawled work queue with the read→mark race guard
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
        const m1 = await factStore.setFactsCrawled({ scopeKeys: stamps });
        assertEqual(m1.affected, 2, "both facts marked crawled");
        assertEqual(m1.skipped, 0, "no skips with valid receipts");

        const q2 = await factStore.readUncrawledFacts({ keyPrefix: ns });
        assertEqual(q2.count, 0, "crawled facts leave the queue");

        // 3. Editing a fact re-enters it into the queue.
        await factStore.storeFact({ key: `${ns}/a`, value: { v: "a2-edited" }, shared: true });
        const q3 = await factStore.readUncrawledFacts({ keyPrefix: ns });
        assertEqual(q3.count, 1, "edited fact re-enters the queue");
        assertEqual(q3.facts[0].key, `${ns}/a`, "the edited fact is the one re-queued");

        // 4. A current scopeKey + etag receipt marks the queued fact; a second mark is skipped.
        const marked = await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: q3.facts[0].scopeKey, etag: q3.facts[0].etag }] });
        assertEqual(marked.affected, 1, "current receipt marks queued fact");
        assertEqual(marked.skipped, 0, "valid queued receipt is not skipped");
        const stale = await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: q3.facts[0].scopeKey, etag: q3.facts[0].etag }] });
        assertEqual(stale.affected, 0, "already-marked receipt marks nothing");
        assertEqual(stale.skipped, 1, "already-marked receipt is counted as skipped");
        const q4 = await factStore.readUncrawledFacts({ keyPrefix: ns });
        assertEqual(q4.count, 0, "fact leaves queue after mark");

        // 5. A blank scopeKey entry is a validation error.
        let threw = false;
        try {
            await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: "" }] });
        } catch {
            threw = true;
        }
        assert(threw, "setFactsCrawled rejects a blank scopeKey entry");

        // 6. Empty scopeKeys is a validation error (no accidental whole-store op).
        let threwEmpty = false;
        try { await factStore.setFactsCrawled({ scopeKeys: [] }); } catch { threwEmpty = true; }
        assert(threwEmpty, "empty scopeKeys is rejected");
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

        const staleLiveMark = await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: live.scopeKey, etag: liveEtag }] });
        assertEqual(staleLiveMark.affected, 0, "stale live mark is skipped after delete");
        assertEqual(staleLiveMark.skipped, 1, "stale live mark counted as skipped");

        const q2 = await factStore.readUncrawledFacts({ namespace: `${ns}/` });
        const deletedQueued = q2.facts.find((f) => f.key === key);
        assert(deletedQueued?.deletedAt instanceof Date, "tombstone is visible to crawl queue with deletedAt");
        const markDelete = await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: deletedQueued.scopeKey, etag: deletedQueued.etag }] });
        assertEqual(markDelete.affected, 1, "delete reconciliation mark succeeds with current etag");

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
        await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: initial.scopeKey, etag: initial.etag }] });

        await factStore.deleteFact({ key, shared: true });
        const tombstone = (await factStore.readUncrawledFacts({ namespace: `${ns}/` })).facts[0];
        await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: tombstone.scopeKey, etag: tombstone.etag }] });
        const reconciled = await rawFact(env, initial.scopeKey);
        assert(reconciled?.deleted_at && reconciled?.last_crawled_at, "tombstone is reconciled before revive");

        await factStore.storeFact({ key, value, shared: true });
        const revived = await rawFact(env, initial.scopeKey);
        assertEqual(revived.deleted_at, null, "revive clears deleted_at");
        assertEqual(revived.last_crawled_at, null, "identical-value revive re-enters crawl queue");
        assert(Number(revived.etag) > Number(reconciled.etag), "identical-value revive bumps etag");

        const queued = (await factStore.readUncrawledFacts({ namespace: `${ns}/` })).facts[0];
        await factStore.storeFact({ key, value: { v: "edited" }, shared: true });
        const stale = await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: queued.scopeKey, etag: queued.etag }] });
        assertEqual(stale.affected, 0, "stale etag after edit is skipped");
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

// M3: setFactsCrawled coerces a numeric-string etag exactly like the SQL does
// (LLM tool JSON often serializes numbers as strings), rejects junk / present-null
// etags loudly, and treats an OMITTED etag as a deliberate stomp.
async function testStringEtagMarkCoercion(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const ns = `etagstr-${Math.random().toString(36).slice(2, 8)}`;
        const key = `${ns}/coerce`;
        await factStore.storeFact({ key, value: { v: 1 }, shared: true });
        const queued = (await factStore.readUncrawledFacts({ keyPrefix: `${ns}/` })).facts[0];
        assert(typeof queued.etag === "number" && queued.etag > 0, "queued fact has a numeric etag");

        // A numeric-string etag is coerced exactly like the SQL digit-string rule.
        const marked = await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: queued.scopeKey, etag: String(queued.etag) }] });
        assertEqual(marked.affected, 1, "numeric-string etag marks the fact crawled");
        assertEqual(marked.skipped, 0, "numeric-string etag is not skipped");

        // Junk / non-integer / present-null etags are still rejected loudly.
        for (const bad of ["not-a-number", "1.0", 1.5, true, null]) {
            let threw = false;
            try { await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: queued.scopeKey, etag: bad }] }); }
            catch { threw = true; }
            assert(threw, `etag ${JSON.stringify(bad)} is rejected`);
        }

        // Omitting etag is a deliberate STOMP (not an error): re-queue, then stomp.
        await factStore.setFactsCrawled({ keyPrefix: `${ns}/`, crawled: false });
        const stomp = await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: queued.scopeKey }] });
        assertEqual(stomp.affected, 1, "omitted etag stomps the crawl flag regardless of version");
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
        await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: recon.scopeKey, etag: recon.etag }] });

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
        await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: recon.scopeKey, etag: recon.etag }] });

        // A single-row backstop pass must reclaim the reconciled tombstone first.
        const purged = await factStore.purgeExpiredFacts(21_600, 1);
        assertEqual(purged, 1, "exactly one tombstone purged in the capped batch");
        assertEqual(await rawFact(env, `shared:${reconKey}`), null, "reconciled tombstone is reclaimed first");
        assert(await rawFact(env, `shared:${unreconKey}`), "unreconciled tombstone is spared in the capped batch");
    } finally {
        await factStore.close();
    }
}

// ── Prefix-scoped crawl flag (multi-crawler Phase 1) ─────────────────────────

// A1/A2 + C1/C2/C5: prefix read filtering + prefix flush + disjoint isolation.
async function testPrefixReadAndFlush(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const root = `pfx-${Math.random().toString(36).slice(2, 8)}`;
        const ab = `${root}/a/b`, ac = `${root}/a/c`;
        await factStore.storeFact([
            { key: `${ab}/1`, value: { v: 1 }, shared: true },
            { key: `${ab}/2`, value: { v: 2 }, shared: true },
            { key: `${ab}/3`, value: { v: 3 }, shared: true },
            { key: `${ac}/1`, value: { v: 4 }, shared: true },
        ]);

        // A1 literal prefix returns only the subtree.
        assertEqual((await factStore.readUncrawledFacts({ keyPrefix: `${ab}/` })).count, 3, "keyPrefix returns only its subtree");
        // A2 null prefix returns all uncrawled.
        assert((await factStore.readUncrawledFacts({ keyPrefix: null })).count >= 4, "null prefix returns all uncrawled");

        // Cross-mode skipped count: pre-mark one row, then prefix-flush the subtree.
        const abQueued = (await factStore.readUncrawledFacts({ keyPrefix: `${ab}/` })).facts;
        await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: abQueued[0].scopeKey, etag: abQueued[0].etag }] });

        // C1 prefix flush marks the remaining 2 a/b rows; the pre-marked row is skipped; C5 a/c untouched.
        const flush = await factStore.setFactsCrawled({ keyPrefix: `${ab}/`, crawled: true });
        assertEqual(flush.affected, 2, "prefix flush marks queued rows in the subtree");
        assertEqual(flush.skipped, 1, "already-crawled row in the subtree is counted as skipped");
        assertEqual((await factStore.readUncrawledFacts({ keyPrefix: `${ab}/` })).count, 0, "a/b drained");
        assertEqual((await factStore.readUncrawledFacts({ keyPrefix: `${ac}/` })).count, 1, "disjoint a/c subtree untouched");

        // C2 already-crawled rows are skipped, not re-touched.
        const flush2 = await factStore.setFactsCrawled({ keyPrefix: `${ab}/`, crawled: true });
        assertEqual(flush2.affected, 0, "no rows change on second flush");
        assertEqual(flush2.skipped, 3, "already-crawled rows counted as skipped");
    } finally {
        await factStore.close();
    }
}

// A3/C4: literal %/_ in a prefix match literally, not as LIKE wildcards.
async function testPrefixLiteralMetacharacters(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const root = `lit-${Math.random().toString(36).slice(2, 8)}`;
        await factStore.storeFact([
            { key: `${root}/a%b/1`, value: { v: 1 }, shared: true },
            { key: `${root}/axb/1`, value: { v: 2 }, shared: true },
            { key: `${root}/a_b/1`, value: { v: 3 }, shared: true },
            { key: `${root}/aXb/1`, value: { v: 4 }, shared: true },
        ]);
        // A3 read: literal % matches only a%b, not axb.
        const pct = (await factStore.readUncrawledFacts({ keyPrefix: `${root}/a%b/` })).facts.map((f) => f.key);
        assertEqual(pct.length, 1, "literal % prefix matches exactly one key");
        assertEqual(pct[0], `${root}/a%b/1`, "literal % matches a%b, not axb");
        // literal _ matches only a_b, not aXb.
        const und = (await factStore.readUncrawledFacts({ keyPrefix: `${root}/a_b/` })).facts.map((f) => f.key);
        assertEqual(und.length, 1, "literal _ prefix matches exactly one key");
        assertEqual(und[0], `${root}/a_b/1`, "literal _ matches a_b, not aXb");
        // C4 flush: literal % prefix flushes only a%b.
        const flush = await factStore.setFactsCrawled({ keyPrefix: `${root}/a%b/`, crawled: true });
        assertEqual(flush.affected, 1, "literal % prefix flush touches exactly one row");
    } finally {
        await factStore.close();
    }
}

// B1/B2/B3/B4/B6/B7/B8: scopeKeys conditional CAS behavior + receipt survives recrawl.
async function testScopeKeysConditional(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const ns = `cond-${Math.random().toString(36).slice(2, 8)}`;
        await factStore.storeFact({ key: `${ns}/x`, value: { v: 1 }, shared: true });
        const q = (await factStore.readUncrawledFacts({ keyPrefix: `${ns}/` })).facts[0];

        // B7 missing scopeKey: neither affected nor skipped.
        const missing = await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: `shared:${ns}/does-not-exist`, etag: 1 }] });
        assertEqual(missing.affected, 0, "missing scopeKey not affected");
        assertEqual(missing.skipped, 0, "missing scopeKey not skipped");

        // B1 happy path.
        assertEqual((await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: q.scopeKey, etag: q.etag }] })).affected, 1, "matching etag marks crawled");

        // B3 already-crawled re-mark is skipped (membership guard).
        const again = await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: q.scopeKey, etag: q.etag }] });
        assertEqual(again.affected, 0, "already-crawled re-mark affects nothing");
        assertEqual(again.skipped, 1, "already-crawled re-mark is skipped");

        // B8 receipt survives recrawl: crawled=false stomp does not bump etag.
        assertEqual((await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: q.scopeKey }], crawled: false })).affected, 1, "stomp recrawl requeues");
        const re = (await factStore.readUncrawledFacts({ keyPrefix: `${ns}/` })).facts[0];
        assertEqual(re.etag, q.etag, "recrawl does not bump etag (receipt survives)");
        assertEqual((await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: q.scopeKey, etag: q.etag }] })).affected, 1, "original etag still matches after recrawl");

        // B2 stale etag: edit bumps etag, the old entry skips.
        await factStore.setFactsCrawled({ keyPrefix: `${ns}/`, crawled: false });
        const beforeEdit = (await factStore.readUncrawledFacts({ keyPrefix: `${ns}/` })).facts[0];
        await factStore.storeFact({ key: `${ns}/x`, value: { v: 2 }, shared: true }); // bumps etag
        const staleConditional = await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: beforeEdit.scopeKey, etag: beforeEdit.etag }] });
        assertEqual(staleConditional.affected, 0, "stale etag does not mark");
        assertEqual(staleConditional.skipped, 1, "stale etag is skipped");

        // B6 conditional recrawl: matching etag requeues; stale etag skips.
        const b6 = `condrec-${Math.random().toString(36).slice(2, 8)}`;
        await factStore.storeFact([
            { key: `${b6}/ok`, value: { v: 1 }, shared: true },
            { key: `${b6}/stale`, value: { v: 1 }, shared: true },
        ]);
        const b6Rows = (await factStore.readUncrawledFacts({ keyPrefix: `${b6}/` })).facts;
        await factStore.setFactsCrawled({ scopeKeys: b6Rows.map((f) => ({ scopeKey: f.scopeKey, etag: f.etag })) });
        const ok = b6Rows.find((f) => f.key.endsWith("/ok"));
        const stale = b6Rows.find((f) => f.key.endsWith("/stale"));
        const recrawlOk = await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: ok.scopeKey, etag: ok.etag }], crawled: false });
        assertEqual(recrawlOk.affected, 1, "B6 matching-etag recrawl requeues the row");
        await factStore.storeFact({ key: `${b6}/stale`, value: { v: 2 }, shared: true });
        const staleCurrent = (await factStore.readUncrawledFacts({ keyPrefix: `${b6}/` })).facts.find((f) => f.key.endsWith("/stale"));
        await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: staleCurrent.scopeKey, etag: staleCurrent.etag }] });
        const recrawlStale = await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: stale.scopeKey, etag: stale.etag }], crawled: false });
        assertEqual(recrawlStale.affected, 0, "B6 stale-etag recrawl affects nothing");
        assertEqual(recrawlStale.skipped, 1, "B6 stale-etag recrawl is skipped");

        // B4 mixed batch: current, stale, already-crawled, and missing split counts correctly.
        const mix = `mix-${Math.random().toString(36).slice(2, 8)}`;
        await factStore.storeFact([
            { key: `${mix}/current`, value: { v: 1 }, shared: true },
            { key: `${mix}/stale`, value: { v: 1 }, shared: true },
            { key: `${mix}/already`, value: { v: 1 }, shared: true },
        ]);
        const mixRows = (await factStore.readUncrawledFacts({ keyPrefix: `${mix}/` })).facts;
        const current = mixRows.find((f) => f.key.endsWith("/current"));
        const staleMix = mixRows.find((f) => f.key.endsWith("/stale"));
        const already = mixRows.find((f) => f.key.endsWith("/already"));
        await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: already.scopeKey, etag: already.etag }] });
        await factStore.storeFact({ key: `${mix}/stale`, value: { v: 2 }, shared: true });
        const mixed = await factStore.setFactsCrawled({ scopeKeys: [
            { scopeKey: current.scopeKey, etag: current.etag },
            { scopeKey: staleMix.scopeKey, etag: staleMix.etag },
            { scopeKey: already.scopeKey, etag: already.etag },
            { scopeKey: `shared:${mix}/missing`, etag: 1 },
        ] });
        assertEqual(mixed.affected, 1, "B4 mixed batch affects only the current queued row");
        assertEqual(mixed.skipped, 2, "B4 mixed batch skips stale + already-crawled rows; missing is not skipped");
    } finally {
        await factStore.close();
    }
}

// A5/C3/C7/D6: tombstone handling across prefix vs scopeKeys selections.
async function testScopeKeysTombstones(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const ns = `tomb-${Math.random().toString(36).slice(2, 8)}`;
        await factStore.storeFact({ key: `${ns}/t`, value: { v: 1 }, shared: true });
        await factStore.deleteFact({ key: `${ns}/t`, shared: true }); // tombstone, requeued
        const tomb = (await factStore.readUncrawledFacts({ keyPrefix: `${ns}/` })).facts[0];
        assert(tomb.deletedAt instanceof Date, "A5: tombstone surfaces in read");

        // C3: prefix flush(true) does NOT mark the tombstone.
        const pf = await factStore.setFactsCrawled({ keyPrefix: `${ns}/`, crawled: true });
        assertEqual(pf.affected, 0, "C3: prefix flush(true) skips tombstones");
        assertEqual(pf.skipped, 0, "C3: prefix flush(true) does not count tombstones as skipped");
        assertEqual((await factStore.readUncrawledFacts({ keyPrefix: `${ns}/` })).count, 1, "tombstone stays queued after prefix flush");

        // C8: scopeKeys with a matching etag can conditionally mark a tombstone.
        assertEqual((await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: tomb.scopeKey, etag: tomb.etag }], crawled: true })).affected, 1, "C8: matching-etag tombstone mark succeeds");
        assertEqual((await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: tomb.scopeKey, etag: tomb.etag }], crawled: false })).affected, 1, "D6: matching-etag tombstone recrawl re-surfaces it");
        await factStore.storeFact({ key: `${ns}/t`, value: { v: 2 }, shared: true }); // revive + bump etag
        await factStore.deleteFact({ key: `${ns}/t`, shared: true }); // tombstone again, with newer etag
        const staleTomb = await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: tomb.scopeKey, etag: tomb.etag }], crawled: true });
        assertEqual(staleTomb.affected, 0, "C8: stale-etag tombstone mark affects nothing");
        assertEqual(staleTomb.skipped, 1, "C8: stale-etag tombstone mark is skipped");
        const freshTomb = (await factStore.readUncrawledFacts({ keyPrefix: `${ns}/` })).facts[0];

        // C7: scopeKeys stomp CAN mark the tombstone crawled.
        assertEqual((await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: freshTomb.scopeKey }], crawled: true })).affected, 1, "C7: scopeKeys stomp marks the tombstone crawled");

        // D2: prefix recrawl includes reconciled tombstones.
        assertEqual((await factStore.setFactsCrawled({ keyPrefix: `${ns}/`, crawled: false })).affected, 1, "D2: prefix recrawl re-surfaces a reconciled tombstone");

        // D6: scopeKeys recrawl re-surfaces the crawled tombstone.
        await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: freshTomb.scopeKey }], crawled: true });
        assertEqual((await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: freshTomb.scopeKey }], crawled: false })).affected, 1, "D6: scopeKeys recrawl re-surfaces the tombstone");
        assertEqual((await factStore.readUncrawledFacts({ keyPrefix: `${ns}/` })).count, 1, "tombstone requeued");
    } finally {
        await factStore.close();
    }
}

// D1/D4/D5: crawled=false recrawl by prefix (requeue, idempotent, disjoint).
async function testPrefixRecrawl(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const root = `rec-${Math.random().toString(36).slice(2, 8)}`;
        const a = `${root}/a`, b = `${root}/b`;
        await factStore.storeFact([
            { key: `${a}/1`, value: { v: 1 }, shared: true },
            { key: `${a}/2`, value: { v: 2 }, shared: true },
            { key: `${b}/1`, value: { v: 3 }, shared: true },
        ]);
        await factStore.setFactsCrawled({ keyPrefix: `${root}/`, crawled: true });
        assertEqual((await factStore.readUncrawledFacts({ keyPrefix: `${root}/` })).count, 0, "all crawled");

        // D1 prefix recrawl: a/ rows return to the queue.
        assertEqual((await factStore.setFactsCrawled({ keyPrefix: `${a}/`, crawled: false })).affected, 2, "prefix recrawl requeues the subtree");
        assertEqual((await factStore.readUncrawledFacts({ keyPrefix: `${a}/` })).count, 2, "a/ rows reappear");
        // D5 disjoint isolation: b/ stays crawled.
        assertEqual((await factStore.readUncrawledFacts({ keyPrefix: `${b}/` })).count, 0, "b/ stays crawled");

        // D4 idempotent: second recrawl affects 0, skips the 2 already-uncrawled.
        const rec2 = await factStore.setFactsCrawled({ keyPrefix: `${a}/`, crawled: false });
        assertEqual(rec2.affected, 0, "second recrawl affects nothing");
        assertEqual(rec2.skipped, 2, "already-uncrawled rows counted as skipped");
    } finally {
        await factStore.close();
    }
}

// E1-E7: guardrails / validation (provider + the null-prefix proc no-op).
async function testSetCrawledGuardrails(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const rej = async (label, input, pattern) => {
            let threw = false;
            let message = "";
            try { await factStore.setFactsCrawled(input); } catch (err) { threw = true; message = String(err?.message ?? err); }
            assert(threw, `rejected: ${label}`);
            if (pattern) assert(pattern.test(message), `${label} error is clear (${message})`);
        };
        await rej("E1 empty keyPrefix", { keyPrefix: "" }, /non-empty/);
        await rej("E2 both selectors", { keyPrefix: "x", scopeKeys: [{ scopeKey: "y" }] }, /exactly one/);
        await rej("E2 neither selector", { crawled: true }, /exactly one/);
        await rej("E5 empty scopeKeys", { scopeKeys: [] }, /non-empty/);
        await rej("E6 etag 0", { scopeKeys: [{ scopeKey: "x", etag: 0 }] }, /positive integer/);
        await rej("E6 etag -1", { scopeKeys: [{ scopeKey: "x", etag: -1 }] }, /positive integer/);
        await rej("E7 duplicate scopeKeys", { scopeKeys: [{ scopeKey: "x" }, { scopeKey: "x" }] }, /duplicate/);
        await rej("E4 501 entries", { scopeKeys: Array.from({ length: 501 }, (_, i) => ({ scopeKey: `k${i}` })) }, /500/);
        const exactly500 = await factStore.setFactsCrawled({ scopeKeys: Array.from({ length: 500 }, (_, i) => ({ scopeKey: `none${i}` })) });
        assertEqual(exactly500.affected, 0, "E4 exactly 500 entries accepted (none exist)");
        assertEqual(exactly500.skipped, 0, "E4 exactly 500 missing entries are not skipped");

        // E3 null prefix proc is a no-op at the SQL layer (the provider rejects a
        // null/empty selection, so exercise the proc directly).
        const nullProc = await withPgClient(env, async (client) => {
            const { rows } = await client.query(`SELECT * FROM "${env.factsSchema}".facts_set_crawled_by_prefix($1, $2)`, [null, true]);
            return rows[0];
        });
        assertEqual(Number(nullProc.affected), 0, "E3 null prefix proc affects 0");
        assertEqual(Number(nullProc.skipped), 0, "E3 null prefix proc skips 0");
    } finally {
        await factStore.close();
    }
}

// A6: namespace is a deprecated alias for keyPrefix on the read path.
async function testNamespaceAlias(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const ns = `alias-${Math.random().toString(36).slice(2, 8)}`;
        await factStore.storeFact([
            { key: `${ns}/a/1`, value: { v: 1 }, shared: true },
            { key: `${ns}/b/1`, value: { v: 2 }, shared: true },
        ]);
        const viaKeyPrefix = (await factStore.readUncrawledFacts({ keyPrefix: `${ns}/a/` })).facts.map((f) => f.key);
        const viaNamespace = (await factStore.readUncrawledFacts({ namespace: `${ns}/a/` })).facts.map((f) => f.key);
        assertEqual(JSON.stringify(viaNamespace), JSON.stringify(viaKeyPrefix), "namespace alias behaves like keyPrefix");
        assertEqual(viaKeyPrefix.length, 1, "alias prefix filters correctly");
    } finally {
        await factStore.close();
    }
}

// F4: neither crawled=true nor crawled=false bumps etag (receipt stability).
async function testSetCrawledDoesNotBumpEtag(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const ns = `noetag-${Math.random().toString(36).slice(2, 8)}`;
        await factStore.storeFact({ key: `${ns}/k`, value: { v: 1 }, shared: true });
        const q = (await factStore.readUncrawledFacts({ keyPrefix: `${ns}/` })).facts[0];
        await factStore.setFactsCrawled({ keyPrefix: `${ns}/`, crawled: true });
        assertEqual((await rawFact(env, q.scopeKey)).etag, String(q.etag), "crawled=true does not bump etag");
        await factStore.setFactsCrawled({ keyPrefix: `${ns}/`, crawled: false });
        assertEqual((await rawFact(env, q.scopeKey)).etag, String(q.etag), "crawled=false does not bump etag");
    } finally {
        await factStore.close();
    }
}

// J: the prefix read uses the (key text_pattern_ops, id) partial index on a
// selective prefix instead of a sequential scan. Isolated in a throwaway schema
// (short name so the index identifier is not truncated at 63 chars) so the 20k
// probe rows do not burden the rest of the suite.
async function testPrefixIndexUsage(env) {
    const schema = `idxq_${Math.random().toString(36).slice(2, 8)}`;
    const factStore = await PgFactStore.create(env.store, schema);
    await factStore.initialize();
    try {
        const root = `idx-${Math.random().toString(36).slice(2, 8)}`;
        await withPgClient(env, (client) => client.query(
            `INSERT INTO "${schema}".facts(scope_key, key, value, shared)
             SELECT 'bulk:${root}/'||g, '${root}/bulk/'||g, '1'::jsonb, true FROM generate_series(1, 20000) g`));
        await factStore.storeFact({ key: `${root}/rare/zone/1`, value: { v: 1 }, shared: true });
        await withPgClient(env, (client) => client.query(`ANALYZE "${schema}".facts`));

        const plan = await withPgClient(env, async (client) => {
            const { rows } = await client.query(
                `EXPLAIN (FORMAT TEXT) SELECT * FROM "${schema}".facts_read_uncrawled($1, $2)`,
                [`${root}/rare/zone/`, 20]);
            return rows.map((r) => r["QUERY PLAN"]).join("\n");
        });
        // The text_pattern_ops index shows up as an Index Scan using idx_..._facts_unc*
        // (or a Bitmap Index Scan on the same index) with the prefix range operators (~>=~ / ~<~);
        // a missing index would seq-scan.
        assert(
            /(Index Scan using|Bitmap Index Scan on) idx_\w*facts_unc/i.test(plan) && /~>=~/.test(plan),
            `selective prefix uses the uncrawled-key index:\n${plan}`,
        );
    } finally {
        await withPgClient(env, (client) => client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)).catch(() => {});
        await factStore.close();
    }
}

// H1-H4: conditional receipts preserve read→edit races; coarse writes/stomps are deliberately privileged.
async function testCoarseRaceSemantics(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const ns = `coarse-${Math.random().toString(36).slice(2, 8)}`;
        await factStore.storeFact([
            { key: `${ns}/conditional`, value: { v: 1 }, shared: true },
            { key: `${ns}/prefix`, value: { v: 1 }, shared: true },
            { key: `${ns}/stomp`, value: { v: 1 }, shared: true },
        ]);
        const rows = (await factStore.readUncrawledFacts({ keyPrefix: `${ns}/` })).facts;
        const conditional = rows.find((f) => f.key.endsWith("/conditional"));
        const prefix = rows.find((f) => f.key.endsWith("/prefix"));
        const stomp = rows.find((f) => f.key.endsWith("/stomp"));

        await factStore.storeFact({ key: `${ns}/conditional`, value: { v: 2 }, shared: true });
        const staleConditional = await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: conditional.scopeKey, etag: conditional.etag }] });
        assertEqual(staleConditional.affected, 0, "H1 conditional receipt does not hide an edit");
        assertEqual(staleConditional.skipped, 1, "H1 stale conditional receipt is skipped");

        await factStore.storeFact({ key: `${ns}/prefix`, value: { v: 2 }, shared: true });
        const prefixFlush = await factStore.setFactsCrawled({ keyPrefix: `${ns}/prefix`, crawled: true });
        assertEqual(prefixFlush.affected, 1, "H2 prefix flush deliberately stomps the read→edit race");
        assertEqual((await factStore.readUncrawledFacts({ keyPrefix: `${ns}/prefix` })).count, 0, "H2 edited prefix row is drained by coarse flush");

        await factStore.storeFact({ key: `${ns}/stomp`, value: { v: 2 }, shared: true });
        const stomped = await factStore.setFactsCrawled({ scopeKeys: [{ scopeKey: stomp.scopeKey }], crawled: true });
        assertEqual(stomped.affected, 1, "H4 scopeKeys without etag deliberately stomps the read→edit race");
    } finally {
        await factStore.close();
    }
}

// G1/G2: two simulated crawlers over disjoint prefixes drain and recrawl independently.
async function testTwoCrawlerDisjointFlow(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const root = `multi-${Math.random().toString(36).slice(2, 8)}`;
        const a = `${root}/crawler-a/`, b = `${root}/crawler-b/`;
        await factStore.storeFact([
            { key: `${a}1`, value: { v: 1 }, shared: true },
            { key: `${a}2`, value: { v: 2 }, shared: true },
            { key: `${b}1`, value: { v: 3 }, shared: true },
            { key: `${b}2`, value: { v: 4 }, shared: true },
        ]);
        const qa = await factStore.readUncrawledFacts({ keyPrefix: a, limit: 500 });
        const qb = await factStore.readUncrawledFacts({ keyPrefix: b, limit: 500 });
        assertEqual(qa.count, 2, "crawler A sees only A rows");
        assertEqual(qb.count, 2, "crawler B sees only B rows");
        assertEqual((await factStore.setFactsCrawled({ scopeKeys: qa.facts.map((f) => ({ scopeKey: f.scopeKey, etag: f.etag })) })).affected, 2, "crawler A drains A");
        assertEqual((await factStore.readUncrawledFacts({ keyPrefix: b })).count, 2, "crawler A drain leaves B queued");
        assertEqual((await factStore.setFactsCrawled({ scopeKeys: qb.facts.map((f) => ({ scopeKey: f.scopeKey, etag: f.etag })) })).affected, 2, "crawler B drains B");
        assertEqual((await factStore.setFactsCrawled({ keyPrefix: a, crawled: false })).affected, 2, "crawler A recrawls A");
        assertEqual((await factStore.readUncrawledFacts({ keyPrefix: b })).count, 0, "crawler A recrawl leaves B drained");
    } finally {
        await factStore.close();
    }
}

// J3: read cap and 500-row batch round-trip.
async function testReadAndSetCapRoundTrip(env) {
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    try {
        const ns = `cap-${Math.random().toString(36).slice(2, 8)}`;
        const facts = Array.from({ length: 525 }, (_, i) => ({ key: `${ns}/${String(i).padStart(3, "0")}`, value: { i }, shared: true }));
        await factStore.storeFact(facts);
        const first = await factStore.readUncrawledFacts({ keyPrefix: `${ns}/`, limit: 501 });
        assertEqual(first.count, 500, "readUncrawledFacts caps limit at 500");
        const drained = await factStore.setFactsCrawled({ scopeKeys: first.facts.map((f) => ({ scopeKey: f.scopeKey, etag: f.etag })) });
        assertEqual(drained.affected, 500, "500-scopeKey batch drains exactly 500 rows");
        assertEqual(drained.skipped, 0, "500-scopeKey batch has no skips with fresh receipts");
        assertEqual((await factStore.readUncrawledFacts({ keyPrefix: `${ns}/`, limit: 500 })).count, 25, "remaining rows page after 500-row drain");
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

    it("set crawled: numeric-string etag coerced, junk/null rejected, omitted etag stomps", { timeout: TIMEOUT }, async () => {
        await testStringEtagMarkCoercion(getEnv());
    });

    // ── Prefix-scoped crawl flag (multi-crawler Phase 1) ─────────────────────
    it("prefix: read filters subtree, flush marks subtree, disjoint isolation, idempotent skip", { timeout: TIMEOUT }, async () => {
        await testPrefixReadAndFlush(getEnv());
    });

    it("prefix: literal %/_ matched literally on read and flush (not LIKE wildcards)", { timeout: TIMEOUT }, async () => {
        await testPrefixLiteralMetacharacters(getEnv());
    });

    it("scopeKeys: conditional CAS — happy/stale/already-crawled/missing, receipt survives recrawl", { timeout: TIMEOUT }, async () => {
        await testScopeKeysConditional(getEnv());
    });

    it("tombstones: prefix flush skips, scopeKeys stomp marks, scopeKeys recrawl re-surfaces", { timeout: TIMEOUT }, async () => {
        await testScopeKeysTombstones(getEnv());
    });

    it("recrawl: crawled=false prefix requeues subtree, idempotent, disjoint isolation", { timeout: TIMEOUT }, async () => {
        await testPrefixRecrawl(getEnv());
    });

    it("guardrails: empty prefix / exactly-one selection / cap 500 / dup / bad etag / null-prefix no-op", { timeout: TIMEOUT }, async () => {
        await testSetCrawledGuardrails(getEnv());
    });

    it("read: namespace is a deprecated alias for keyPrefix", { timeout: TIMEOUT }, async () => {
        await testNamespaceAlias(getEnv());
    });

    it("set crawled (true/false) does not bump etag", { timeout: TIMEOUT }, async () => {
        await testSetCrawledDoesNotBumpEtag(getEnv());
    });

    it("read: selective prefix uses the (key text_pattern_ops, id) partial index", { timeout: TIMEOUT }, async () => {
        await testPrefixIndexUsage(getEnv());
    });

    it("coarseness: conditional receipts guard races, prefix/scopeKey stomps deliberately bypass them", { timeout: TIMEOUT }, async () => {
        await testCoarseRaceSemantics(getEnv());
    });

    it("multi-crawler: disjoint prefixes drain and recrawl independently", { timeout: TIMEOUT }, async () => {
        await testTwoCrawlerDisjointFlow(getEnv());
    });

    it("cap: read limit caps at 500 and 500-receipt batch drains one page", { timeout: TIMEOUT }, async () => {
        await testReadAndSetCapRoundTrip(getEnv());
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
