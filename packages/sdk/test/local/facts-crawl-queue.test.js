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

        // 1. New facts are uncrawled and carry a contentHash receipt.
        const q1 = await factStore.readUncrawledFacts({ namespace: ns });
        assertEqual(q1.count, 2, "both new facts are uncrawled");
        for (const f of q1.facts) {
            assert(typeof f.contentHash === "string" && f.contentHash.length > 0, "uncrawled fact carries contentHash");
            assert(typeof f.scopeKey === "string", "uncrawled fact carries scopeKey");
        }

        // 2. Mark both crawled with valid receipts → they leave the queue.
        const stamps = q1.facts.map((f) => ({ scopeKey: f.scopeKey, contentHash: f.contentHash }));
        const m1 = await factStore.markFactsCrawled(stamps);
        assertEqual(m1.marked, 2, "both facts marked crawled");
        assertEqual(m1.skipped, 0, "no skips with valid receipts");

        const q2 = await factStore.readUncrawledFacts({ namespace: ns });
        assertEqual(q2.count, 0, "crawled facts leave the queue");

        // 3. Editing a fact re-enters it into the queue (content_hash changed →
        //    last_crawled_at reset by the trigger).
        await factStore.storeFact({ key: `${ns}/a`, value: { v: "a2-edited" }, shared: true });
        const q3 = await factStore.readUncrawledFacts({ namespace: ns });
        assertEqual(q3.count, 1, "edited fact re-enters the queue");
        assertEqual(q3.facts[0].key, `${ns}/a`, "the edited fact is the one re-queued");

        // 4. A stale receipt (wrong contentHash) is skipped, not an error; the
        //    fact stays queued.
        const stale = await factStore.markFactsCrawled([{ scopeKey: q3.facts[0].scopeKey, contentHash: "deadbeefdeadbeefdeadbeefdeadbeef" }]);
        assertEqual(stale.marked, 0, "stale receipt marks nothing");
        assertEqual(stale.skipped, 1, "stale receipt is counted as skipped");
        const q4 = await factStore.readUncrawledFacts({ namespace: ns });
        assertEqual(q4.count, 1, "fact stays queued after a stale mark");

        // 5. markFactsCrawled validates receipt shape.
        let threw = false;
        try {
            await factStore.markFactsCrawled([{ scopeKey: "x" }]);
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

    it("isEnhancedFactStore(PgFactStore) is false (no throwing stubs)", { timeout: TIMEOUT }, async () => {
        await testIsEnhancedGuardFalseForBase(getEnv());
    });
});
