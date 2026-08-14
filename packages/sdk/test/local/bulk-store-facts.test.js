/**
 * bulk_store_facts against a REAL PgFactStore — persistence, real committed
 * counts, genuine db_error attribution, and the retry loop end to end.
 *
 * The unit suite (test/unit/bulk-store-facts.test.mjs) pins the contract with
 * a fake store; this suite proves the pieces the fake cannot: the database's
 * RETURNING count surfacing as committed_count, idempotent re-ingestion, the
 * per-record fallback isolating a record PostgreSQL genuinely rejects (jsonb
 * refuses U+0000 in strings), and store_fact's unchanged behavior on the same
 * live store after the count fix.
 *
 * Run: npx vitest run test/local/bulk-store-facts.test.js
 */

import { describe, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PgFactStore } from "../../src/facts-store.ts";
import { createFactTools } from "../../src/facts-tools.ts";
import { FilesystemArtifactStore } from "../../src/session-store.ts";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";

const TIMEOUT = 120_000;
const getEnv = useSuiteEnv(import.meta.url);

const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CTX = { sessionId: SESSION, agentId: "bulk-int-test" };

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");

async function withSetup(fn) {
    const env = await getEnv();
    const factStore = await PgFactStore.create(env.store, env.factsSchema);
    await factStore.initialize();
    const dir = mkdtempSync(join(tmpdir(), "bulk-int-"));
    const artifacts = new FilesystemArtifactStore(dir);
    const tools = createFactTools({ factStore, artifactStore: artifacts, agentIdentity: "bulk-int-test" });
    const bulk = tools.find((t) => t.name === "bulk_store_facts");
    const storeFact = tools.find((t) => t.name === "store_fact");
    const readFacts = tools.find((t) => t.name === "read_facts");
    try {
        await fn({ factStore, artifacts, bulk, storeFact, readFacts });
    } finally {
        rmSync(dir, { recursive: true, force: true });
        await factStore.close?.();
    }
}

describe("bulk_store_facts on live PostgreSQL", () => {
    it("ingests a multi-chunk artifact: real committed count, real persistence, idempotent re-ingest", { timeout: TIMEOUT }, async () => {
        await withSetup(async ({ artifacts, bulk, readFacts }) => {
            const N = 1200; // three chunks at the 500-record chunk size
            const records = Array.from({ length: N }, (_, i) => ({
                key: `corpus/int/${i}`,
                value: { i, text: `narrative ${i}` },
                tags: ["bulk-int"],
            }));
            const body = JSON.stringify(records);
            await artifacts.uploadArtifact(SESSION, "apply.json", body, "application/octet-stream");

            const out = await bulk.handler({
                from: { filename: "apply.json", expected_sha256: sha(body) },
                key_prefix: "corpus/int/",
                expected_count: N,
            }, CTX);
            assertEqual(out.error, undefined);
            assertEqual(out.accepted_count, N);
            assertEqual(out.committed_count, N, "the DATABASE's count, across 3 chunks");
            assertEqual(out.failed_count, 0);

            // Persistence, not just accounting.
            const readBack = await readFacts.handler({ key_pattern: "corpus/int/%", limit: 10 }, CTX);
            assert(readBack.count >= 10, "facts actually landed");

            // Byte-identical re-ingest: idempotent upsert commits N again
            // (DO UPDATE returns a row per record) and nothing duplicates.
            const again = await bulk.handler({ from: { filename: "apply.json" } }, CTX);
            assertEqual(again.error, undefined);
            assertEqual(again.committed_count, N);
        });
    });

    it("a record PostgreSQL rejects gets db_error; neighbors commit; the failure file retries to the same failure", { timeout: TIMEOUT }, async () => {
        await withSetup(async ({ artifacts, bulk, readFacts }) => {
            // jsonb refuses U+0000 inside strings — a REAL per-record database
            // failure that shape validation cannot catch.
            const nul = String.fromCharCode(0);
            const records = [
                { key: "poison/ok-1", value: { fine: true } },
                { key: "poison/bad", value: { text: `a${nul}b` } },
                { key: "poison/ok-2", value: { fine: true } },
            ];
            await artifacts.uploadArtifact(SESSION, "apply.json", JSON.stringify(records), "application/json");

            const out = await bulk.handler({ from: { filename: "apply.json" }, to_file: "failed-01.json" }, CTX);
            assertEqual(out.error, undefined);
            assertEqual(out.accepted_count, 3);
            assertEqual(out.committed_count, 2, "chunk fell back per-record and isolated the poison");
            assertEqual(out.failed_count, 1);
            assertEqual(out.failed_sample[0].key, "poison/bad");
            assertEqual(out.failed_sample[0].reason, "db_error");

            const good = await readFacts.handler({ key_pattern: "poison/ok-%" }, CTX);
            assertEqual(good.count, 2, "healthy records persisted despite the poisoned neighbor");

            // The failure artifact is valid input; the poison fails again for
            // the same reason. Loop signal: failed_count stopped dropping.
            const retry = await bulk.handler({ from: { filename: "failed-01.json" }, to_file: "failed-02.json" }, CTX);
            assertEqual(retry.error, undefined);
            assertEqual(retry.accepted_count, 1);
            assertEqual(retry.committed_count, 0);
            assertEqual(retry.failed_count, 1);
            assertEqual(retry.failed_sample[0].reason, "db_error");
        });
    });

    it("intake/ records fail per record on the live path and never reach the store", { timeout: TIMEOUT }, async () => {
        await withSetup(async ({ bulk, readFacts }) => {
            const out = await bulk.handler({
                facts: [
                    { key: "mixed/ok", value: 1 },
                    { key: "intake/topic/some-session", value: { obs: true }, shared: true },
                ],
            }, CTX);
            assertEqual(out.error, undefined);
            assertEqual(out.committed_count, 1);
            assertEqual(out.failed_count, 1);
            assertEqual(out.failed_sample[0].reason, "intake_requires_single_write");
            const readBack = await readFacts.handler({ key_pattern: "mixed/%" }, CTX);
            assertEqual(readBack.count, 1);
        });
    });

    it("store_fact is unchanged after the count fix: single and batch shapes on the live store", { timeout: TIMEOUT }, async () => {
        await withSetup(async ({ storeFact, factStore }) => {
            const single = await storeFact.handler({ key: "regress/one", value: { a: 1 } }, CTX);
            assertEqual(single.key, "regress/one");
            assertEqual(single.stored, true);
            assertEqual(single.scope, "session");

            const batch = await storeFact.handler({
                facts: [
                    { key: "regress/b1", value: 1 },
                    { key: "regress/b2", value: 2, shared: true },
                ],
            }, CTX);
            assertEqual(batch.stored, 2, "stored now comes from the DB and still equals the input length");
            assertEqual(batch.facts.length, 2);
            assertEqual(batch.facts[1].scope, "shared");

            // Store layer directly: the count is the database's number.
            const direct = await factStore.storeFact([
                { key: "regress/direct", value: 7, sessionId: SESSION },
            ]);
            assertEqual(direct.stored, 1);
        });
    });
});
