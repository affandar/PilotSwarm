/**
 * bulk_store_facts — contract tests against a fake FactStore and a real
 * FilesystemArtifactStore (docs/proposals/bulk-facts-ingestion.md).
 *
 * The contract under test is ACCOUNTING, not atomicity: every input record
 * ends either committed or in the failure artifact with a reason; the failure
 * artifact is valid input for a retry call (`_error` is written, never read);
 * intake/ keys are refused per record; committed_count is the store's number,
 * not the input length.
 *
 * Run: node --test test/unit/bulk-store-facts.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createFactTools } from "../../dist/facts-tools.js";
import { FilesystemArtifactStore } from "../../dist/session-store.js";

const SESSION = "11111111-2222-3333-4444-555555555555";
const CTX = { sessionId: SESSION, agentId: "test-agent" };

/** A FactStore fake capturing writes; per-test failure injection. */
function fakeStore({ failKeys = new Set(), failChunksContaining = new Set(), storedDelta = 0 } = {}) {
    const calls = [];
    return {
        calls,
        writtenKeys: () => calls.flat().map((i) => i.key),
        async storeFact(input) {
            const inputs = Array.isArray(input) ? input : [input];
            calls.push(inputs);
            const chunkHasPoison = inputs.some((i) => failChunksContaining.has(i.key));
            if (inputs.length > 1 && chunkHasPoison) throw new Error("chunk poisoned (fake)");
            for (const i of inputs) {
                if (failKeys.has(i.key)) throw new Error(`record poisoned: ${i.key} (fake)`);
            }
            const result = { stored: inputs.length + storedDelta, facts: inputs.map((i) => ({ key: i.key, shared: i.shared === true, stored: true })) };
            return Array.isArray(input) ? result : result.facts[0];
        },
    };
}

function toolsFor(store, artifactStore, agentIdentity = "test-agent") {
    const tools = createFactTools({ factStore: store, artifactStore, agentIdentity });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.ok(byName.bulk_store_facts, "bulk_store_facts is registered");
    return byName;
}

function withArtifacts(fn) {
    const dir = mkdtempSync(join(tmpdir(), "bulk-facts-"));
    const artifacts = new FilesystemArtifactStore(dir);
    return Promise.resolve(fn(artifacts)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const rec = (key, value = { v: 1 }, extra = {}) => ({ key, value, ...extra });
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The failure artifact is written under a BINARY content type (the text cap
 * is 1 MB; failure sets mirror multi-MB apply artifacts), so read it the way
 * the tool itself does: raw bytes, decoded as utf8.
 */
async function readFailureFile(artifacts, name) {
    const { body } = await artifacts.downloadArtifact(SESSION, name);
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "");
    return JSON.parse(buf.toString("utf8"));
}

// ─── Source selection ────────────────────────────────────────────

test("exactly one source: neither and both are call-level errors, nothing written", async () => {
    await withArtifacts(async (artifacts) => {
        const store = fakeStore();
        const { bulk_store_facts } = toolsFor(store, artifacts);
        const neither = await bulk_store_facts.handler({}, CTX);
        assert.match(neither.error, /exactly one source/);
        const both = await bulk_store_facts.handler({ facts: [rec("a")], from: { filename: "x.json" } }, CTX);
        assert.match(both.error, /exactly one source/);
        assert.equal(store.calls.length, 0);
    });
});

test("inline happy path: committed == accepted, no failure artifact without to_file", async () => {
    await withArtifacts(async (artifacts) => {
        const store = fakeStore();
        const { bulk_store_facts } = toolsFor(store, artifacts);
        const out = await bulk_store_facts.handler({ facts: [rec("a/1"), rec("a/2", { big: "x".repeat(500) })] }, CTX);
        assert.equal(out.accepted_count, 2);
        assert.equal(out.committed_count, 2);
        assert.equal(out.failed_count, 0);
        assert.equal(out.failed_artifact, null);
        assert.equal(out.source, "inline");
        assert.ok(out.sha256?.length === 64);
        assert.deepEqual(store.writtenKeys(), ["a/1", "a/2"]);
    });
});

test("from-artifact happy path verifies sha256 and reads bytes store-side", async () => {
    await withArtifacts(async (artifacts) => {
        const body = JSON.stringify([rec("c/1"), rec("c/2")]);
        await artifacts.uploadArtifact(SESSION, "apply.json", body, "application/json");
        const store = fakeStore();
        const { bulk_store_facts } = toolsFor(store, artifacts);
        const out = await bulk_store_facts.handler({ from: { filename: "apply.json", expected_sha256: sha(body) } }, CTX);
        assert.equal(out.committed_count, 2);
        assert.equal(out.source, "apply.json");
        assert.equal(out.sha256, sha(body));
    });
});

test("sha mismatch refuses the whole call; the store is never touched", async () => {
    await withArtifacts(async (artifacts) => {
        await artifacts.uploadArtifact(SESSION, "apply.json", JSON.stringify([rec("c/1")]), "application/json");
        const store = fakeStore();
        const { bulk_store_facts } = toolsFor(store, artifacts);
        const out = await bulk_store_facts.handler({ from: { filename: "apply.json", expected_sha256: "0".repeat(64) } }, CTX);
        assert.match(out.error, /SHA_MISMATCH/);
        assert.match(out.error, /nothing was written/);
        assert.equal(store.calls.length, 0);
    });
});

test("bad JSON, non-array payloads, and missing artifacts are call-level errors", async () => {
    await withArtifacts(async (artifacts) => {
        const store = fakeStore();
        const { bulk_store_facts } = toolsFor(store, artifacts);
        await artifacts.uploadArtifact(SESSION, "bad.json", "{not json", "application/json");
        assert.match((await bulk_store_facts.handler({ from: { filename: "bad.json" } }, CTX)).error, /not valid JSON/);
        await artifacts.uploadArtifact(SESSION, "obj.json", JSON.stringify({ key: "a", value: 1 }), "application/json");
        assert.match((await bulk_store_facts.handler({ from: { filename: "obj.json" } }, CTX)).error, /JSON array/);
        assert.match((await bulk_store_facts.handler({ from: { filename: "missing.json" } }, CTX)).error, /could not read artifact/);
        assert.equal(store.calls.length, 0);
    });
});

test("expected_count mismatch refuses the whole call before any write", async () => {
    await withArtifacts(async (artifacts) => {
        const store = fakeStore();
        const { bulk_store_facts } = toolsFor(store, artifacts);
        const out = await bulk_store_facts.handler({ facts: [rec("a"), rec("b")], expected_count: 3 }, CTX);
        assert.match(out.error, /expected_count is 3 but the input holds 2/);
        assert.equal(store.calls.length, 0);
    });
});

test("empty inputs are a zero-record success (loop termination)", async () => {
    await withArtifacts(async (artifacts) => {
        const store = fakeStore();
        const { bulk_store_facts } = toolsFor(store, artifacts);
        await artifacts.uploadArtifact(SESSION, "empty.json", "[]", "application/json");
        for (const args of [{ facts: [] }, { from: { filename: "empty.json" } }]) {
            const out = await bulk_store_facts.handler(args, CTX);
            assert.equal(out.accepted_count, 0);
            assert.equal(out.committed_count, 0);
            assert.equal(out.failed_count, 0);
            assert.equal(out.error, undefined);
        }
        assert.equal(store.calls.length, 0);
    });
});

// ─── Per-record validation ───────────────────────────────────────

test("per-record failures: shapes, namespaces, intake, prefix, duplicates — rest still commits", async () => {
    await withArtifacts(async (artifacts) => {
        const store = fakeStore();
        const { bulk_store_facts } = toolsFor(store, artifacts);
        const out = await bulk_store_facts.handler({
            facts: [
                rec("good/1"),
                "not-an-object",
                { value: 1 },                                  // key missing
                { key: "", value: 1 },                         // key empty
                { key: "good/2" },                             // value missing
                rec("good/3", 1, { tags: "oops" }),            // tags not array
                rec("intake/topic/sess", 1),                   // intake, unshared
                rec("intake/topic/sess2", 1, { shared: true }), // intake, shared
                rec("skills/x/y", 1),                          // reserved namespace
                rec("good/1"),                                 // duplicate scope key
                rec("good/1", 2, { shared: true }),            // same key, different scope — NOT a duplicate
            ],
            key_prefix: undefined,
        }, CTX);
        assert.equal(out.accepted_count, 11);
        // Valid: good/1 (session scope) and good/1 with shared:true (a
        // DIFFERENT scope key — shared:good/1 vs session:<id>:good/1).
        assert.equal(out.committed_count, 2);
        assert.equal(out.failed_count, 9);
        assert.deepEqual(store.writtenKeys(), ["good/1", "good/1"]);
        assert.equal(store.calls.flat()[1].shared, true);
    });
});

test("per-record failure reasons are precise", async () => {
    await withArtifacts(async (artifacts) => {
        const store = fakeStore();
        const { bulk_store_facts } = toolsFor(store, artifacts);
        const out = await bulk_store_facts.handler({
            facts: [
                rec("good/1"),
                { value: 1 },
                rec("intake/t/s"),
                rec("skills/x"),
                rec("zzz/off-prefix"),
                rec("good/1"),
            ],
            key_prefix: undefined,
            to_file: "failed.json",
        }, CTX);
        assert.equal(out.failed_count, 4);
        const failed = await readFailureFile(artifacts, "failed.json");
        const reasons = failed.map((f) => f._error.reason);
        assert.deepEqual(reasons, ["invalid_shape", "intake_requires_single_write", "namespace_denied", "duplicate_key"]);
        assert.deepEqual(store.writtenKeys(), ["good/1", "zzz/off-prefix"]);
    });
});

test("first failure wins: multi-defect records report the contract-order reason", async () => {
    await withArtifacts(async (artifacts) => {
        // Contract order: invalid_shape, intake_requires_single_write,
        // namespace_denied, prefix_violation, missing_session, duplicate_key.
        // Each record here trips TWO rules; the report must name the earlier
        // one. (A suite of single-defect records passes under any order.)
        const store = fakeStore();
        const { bulk_store_facts } = toolsFor(store, artifacts);
        const out = await bulk_store_facts.handler({
            facts: [
                { key: "intake/t/s" },                               // invalid_shape (no value) beats intake
                rec("intake/t/s", 1, { shared: true }),              // intake beats prefix_violation
                rec("skills/x", 1, { shared: true }),                // namespace_denied beats prefix_violation
                rec("other/unshared", 1),                            // prefix_violation beats missing_session
            ],
            key_prefix: "corpus/",
            // No to_file: the sink needs a session, and this call runs
            // session-less on purpose so missing_session is armed.
        }, { agentId: "x" });
        assert.equal(out.failed_count, 4);
        assert.equal(out.committed_count, 0);
        const reasons = out.failed_sample.map((f) => f.reason);
        assert.deepEqual(reasons, [
            "invalid_shape",
            "intake_requires_single_write",
            "namespace_denied",
            "prefix_violation",
        ]);
    });
});

test("an invalid record does not claim its key: the first VALID occurrence wins", async () => {
    await withArtifacts(async (artifacts) => {
        const store = fakeStore();
        const { bulk_store_facts } = toolsFor(store, artifacts);
        const out = await bulk_store_facts.handler({
            facts: [
                rec("corpus/a", 1, { shared: true, tags: "bad" }),   // invalid_shape — must NOT reserve corpus/a
                rec("corpus/a", 2, { shared: true }),                // first valid occurrence: commits
                rec("corpus/a", 3, { shared: true }),                // duplicate of the VALID one
            ],
        }, CTX);
        assert.equal(out.committed_count, 1);
        assert.equal(out.failed_count, 2);
        assert.deepEqual(out.failed_sample.map((f) => f.reason), ["invalid_shape", "duplicate_key"]);
        assert.deepEqual(store.calls.flat().map((f) => f.value), [2]);
    });
});

test("key_prefix guard fails non-matching records only", async () => {
    await withArtifacts(async (artifacts) => {
        const store = fakeStore();
        const { bulk_store_facts } = toolsFor(store, artifacts);
        const out = await bulk_store_facts.handler({
            facts: [rec("icm/corpus/v1/a"), rec("other/b")],
            key_prefix: "icm/corpus/v1/",
        }, CTX);
        assert.equal(out.committed_count, 1);
        assert.equal(out.failed_count, 1);
        assert.equal(out.failed_sample[0].reason, "prefix_violation");
        assert.equal(out.failed_sample[0].key, "other/b");
    });
});

test("intake/ is refused per record, shared or not, and never reaches the store", async () => {
    await withArtifacts(async (artifacts) => {
        const store = fakeStore();
        const { bulk_store_facts } = toolsFor(store, artifacts);
        const out = await bulk_store_facts.handler({
            facts: [rec("ok/1"), rec("intake/a/b"), rec("intake/c/d", 1, { shared: true })],
            to_file: "failed.json",
        }, CTX);
        assert.equal(out.committed_count, 1);
        assert.equal(out.failed_count, 2);
        for (const s of out.failed_sample) {
            assert.equal(s.reason, "intake_requires_single_write");
            assert.match(s.message, /store_fact/);
        }
        assert.ok(!store.writtenKeys().some((k) => k.startsWith("intake/")));
    });
});

test("missing session: unshared records fail per record when there is no session context", async () => {
    await withArtifacts(async (artifacts) => {
        const store = fakeStore();
        const { bulk_store_facts } = toolsFor(store, artifacts);
        const out = await bulk_store_facts.handler(
            { facts: [rec("a/1"), rec("a/2", 1, { shared: true })] },
            { agentId: "x" },   // no sessionId
        );
        assert.equal(out.committed_count, 1);
        assert.equal(out.failed_count, 1);
        assert.equal(out.failed_sample[0].reason, "missing_session");
        assert.deepEqual(store.writtenKeys(), ["a/2"]);
    });
});

// ─── The failure artifact round trip ─────────────────────────────

test("failure artifact is valid input: _error is written, never read; retry re-fails identically", async () => {
    await withArtifacts(async (artifacts) => {
        const store = fakeStore();
        const { bulk_store_facts } = toolsFor(store, artifacts);
        const first = await bulk_store_facts.handler({
            facts: [rec("ok/1", { keep: "me" }), rec("intake/t/s", { original: true }, { tags: ["a"] })],
            to_file: "failed-01.json",
        }, CTX);
        assert.equal(first.failed_count, 1);

        const failed = await readFailureFile(artifacts, "failed-01.json");
        assert.equal(failed.length, 1);
        // Original record fields survive untouched beside the annotation.
        assert.deepEqual(failed[0].value, { original: true });
        assert.deepEqual(failed[0].tags, ["a"]);
        assert.equal(failed[0]._error.reason, "intake_requires_single_write");

        // Feed the failure file straight back — _error must be ignored, the
        // record re-fails for its own reason, and the NEW file has exactly one
        // fresh _error (not nested, not accumulated).
        const second = await bulk_store_facts.handler({
            from: { filename: "failed-01.json" },
            to_file: "failed-02.json",
        }, CTX);
        assert.equal(second.accepted_count, 1);
        assert.equal(second.committed_count, 0);
        assert.equal(second.failed_count, 1);
        const failed2 = await readFailureFile(artifacts, "failed-02.json");
        assert.equal(failed2.length, 1);
        assert.equal(failed2[0]._error.reason, "intake_requires_single_write");
        assert.equal(typeof failed2[0]._error.attempts, "undefined", "no attempt counter");
        assert.deepEqual(failed2[0].value, { original: true }, "value byte-identical through two round trips");
    });
});

test("a committed retry record strips _error on the way into the store", async () => {
    await withArtifacts(async (artifacts) => {
        const store = fakeStore();
        const { bulk_store_facts } = toolsFor(store, artifacts);
        // Simulate a failure file whose record would now succeed.
        const body = JSON.stringify([{ ...rec("fixed/1", { v: 9 }), _error: { reason: "db_error", message: "was transient" } }]);
        await artifacts.uploadArtifact(SESSION, "failed-old.json", body, "application/json");
        const out = await bulk_store_facts.handler({ from: { filename: "failed-old.json" }, to_file: "failed-next.json" }, CTX);
        assert.equal(out.committed_count, 1);
        assert.equal(out.failed_count, 0);
        // The store input carries only the contract fields.
        const stored = store.calls.flat()[0];
        assert.deepEqual(Object.keys(stored).sort(), ["agentId", "key", "sessionId", "shared", "tags", "value"]);
        // Clean run still overwrites to_file with [].
        assert.equal((await readFailureFile(artifacts, "failed-next.json")).length, 0);
    });
});

test("to_file is always overwritten — a stale failure file cannot survive a clean run", async () => {
    await withArtifacts(async (artifacts) => {
        const store = fakeStore();
        const { bulk_store_facts } = toolsFor(store, artifacts);
        await artifacts.uploadArtifact(SESSION, "failed.json", JSON.stringify([{ key: "stale", value: 1, _error: { reason: "db_error", message: "old" } }]), "application/json");
        const out = await bulk_store_facts.handler({ facts: [rec("ok/1")], to_file: "failed.json" }, CTX);
        assert.equal(out.failed_count, 0);
        assert.deepEqual(await readFailureFile(artifacts, "failed.json"), []);
    });
});

test("a failure body over the 1 MB text cap still writes: the sink rides a binary content type", async () => {
    await withArtifacts(async (artifacts) => {
        // ~1500 records x ~1 KB values, all failing prefix_violation: the
        // failure body tops 1 MB. Under a text content type the artifact
        // store would throw ARTIFACT_TOO_LARGE and the retry loop would die
        // with only a 5-key sample surviving.
        const store = fakeStore();
        const { bulk_store_facts } = toolsFor(store, artifacts);
        const facts = Array.from({ length: 1500 }, (_, i) => rec(`off-prefix/${i}`, { pad: "x".repeat(1000), i }));
        const out = await bulk_store_facts.handler({ facts, key_prefix: "corpus/", to_file: "failed-big.json" }, CTX);
        assert.equal(out.failed_count, 1500);
        assert.equal(out.failed_artifact, "failed-big.json");
        assert.equal(out.failed_artifact_error, undefined);
        const failed = await readFailureFile(artifacts, "failed-big.json");
        assert.equal(failed.length, 1500);
        assert.ok(Buffer.byteLength(JSON.stringify(failed), "utf8") > 1_048_576, "the scenario genuinely tops the text cap");
        // And the big failure file is still valid retry input.
        const retry = await bulk_store_facts.handler({ from: { filename: "failed-big.json" }, key_prefix: "corpus/" }, CTX);
        assert.equal(retry.accepted_count, 1500);
        assert.equal(retry.failed_count, 1500);
    });
});

test("an artifact over the 32 MB cap is refused on raw bytes, before decode and hashing", async () => {
    await withArtifacts(async (artifacts) => {
        // The artifact store admits far larger files than the bulk cap
        // (binary cap is env-tunable; the fromFile data plane allows 256 MB),
        // so the refusal must fire on the downloaded buffer itself.
        process.env.PILOTSWARM_ARTIFACT_BINARY_MAX_BYTES = String(64 * 1024 * 1024);
        try {
            const store = fakeStore();
            const { bulk_store_facts } = toolsFor(store, artifacts);
            const big = Buffer.alloc(33 * 1024 * 1024, 0x5b); // 33 MB of "[" — never parsed
            await artifacts.uploadArtifact(SESSION, "huge.json", big, "application/octet-stream");
            const out = await bulk_store_facts.handler({ from: { filename: "huge.json" } }, CTX);
            assert.match(out.error, /over the 32 MB bulk-ingestion cap/);
            assert.match(out.error, /nothing was written/);
            assert.equal(store.calls.length, 0);
        } finally {
            delete process.env.PILOTSWARM_ARTIFACT_BINARY_MAX_BYTES;
        }
    });
});

// ─── Chunking and db_error attribution ───────────────────────────

test("a poisoned chunk falls back to per-record writes; the error lands on the right record", async () => {
    await withArtifacts(async (artifacts) => {
        const store = fakeStore({ failKeys: new Set(["bad/7"]), failChunksContaining: new Set(["bad/7"]) });
        const { bulk_store_facts } = toolsFor(store, artifacts);
        const facts = Array.from({ length: 20 }, (_, i) => rec(i === 7 ? "bad/7" : `ok/${i}`));
        const out = await bulk_store_facts.handler({ facts, to_file: "failed.json" }, CTX);
        assert.equal(out.accepted_count, 20);
        assert.equal(out.committed_count, 19);
        assert.equal(out.failed_count, 1);
        assert.equal(out.failed_sample[0].key, "bad/7");
        assert.equal(out.failed_sample[0].reason, "db_error");
        const failed = await readFailureFile(artifacts, "failed.json");
        assert.equal(failed[0].key, "bad/7");
    });
});

test("committed_count is the store's number, not the input length", async () => {
    await withArtifacts(async (artifacts) => {
        // A store that claims one FEWER row than asked simulates SQL drift.
        const store = fakeStore({ storedDelta: -1 });
        const { bulk_store_facts } = toolsFor(store, artifacts);
        const out = await bulk_store_facts.handler({ facts: [rec("a/1"), rec("a/2"), rec("a/3")] }, CTX);
        assert.equal(out.accepted_count, 3);
        assert.equal(out.committed_count, 2, "reports what the store reported, not what was sent");
    });
});

// ─── Caps, identity, degraded deployments ────────────────────────

test("record cap refuses the whole call", async () => {
    await withArtifacts(async (artifacts) => {
        const store = fakeStore();
        const { bulk_store_facts } = toolsFor(store, artifacts);
        const facts = Array.from({ length: 50_001 }, (_, i) => rec(`k/${i}`, 1));
        const out = await bulk_store_facts.handler({ facts }, CTX);
        assert.match(out.error, /50000/);
        assert.equal(store.calls.length, 0);
    });
});

test("byte cap refuses the whole call (inline path — artifact stores cap uploads earlier)", async () => {
    await withArtifacts(async (artifacts) => {
        const store = fakeStore();
        const { bulk_store_facts } = toolsFor(store, artifacts);
        const out = await bulk_store_facts.handler({ facts: [rec("a/big", "x".repeat(33 * 1024 * 1024))] }, CTX);
        assert.match(out.error, /32 MB/);
        assert.equal(store.calls.length, 0);
    });
});

test("reads binary-content-type artifacts — the shape large apply artifacts actually take", async () => {
    await withArtifacts(async (artifacts) => {
        // Text artifacts cap at 1 MB; real apply artifacts ride a binary
        // content type for the 10 MB cap. The tool must read those (the
        // text reader refuses binary).
        const body = Buffer.from(JSON.stringify([rec("bin/1"), rec("bin/2")]), "utf8");
        await artifacts.uploadArtifact(SESSION, "apply.bin", body, "application/octet-stream");
        const store = fakeStore();
        const { bulk_store_facts } = toolsFor(store, artifacts);
        const out = await bulk_store_facts.handler({ from: { filename: "apply.bin", expected_sha256: sha(body.toString("utf8")) } }, CTX);
        assert.equal(out.committed_count, 2);
        assert.deepEqual(store.writtenKeys(), ["bin/1", "bin/2"]);
    });
});

test("agent-tuner is refused at the call level", async () => {
    await withArtifacts(async (artifacts) => {
        const store = fakeStore();
        const { bulk_store_facts } = toolsFor(store, artifacts, "agent-tuner");
        const out = await bulk_store_facts.handler({ facts: [rec("a/1")] }, CTX);
        assert.match(out.error, /read-only/);
        assert.equal(store.calls.length, 0);
    });
});

test("no artifact store: inline works, from/to_file are refused clearly", async () => {
    const store = fakeStore();
    const tools = createFactTools({ factStore: store, agentIdentity: "test-agent" });
    const bulk = tools.find((t) => t.name === "bulk_store_facts");
    const inline = await bulk.handler({ facts: [rec("a/1")] }, CTX);
    assert.equal(inline.committed_count, 1);
    const fromFile = await bulk.handler({ from: { filename: "x.json" } }, CTX);
    assert.match(fromFile.error, /no artifact store/);
    const toFile = await bulk.handler({ facts: [rec("a/2")], to_file: "f.json" }, CTX);
    assert.match(toFile.error, /no artifact store/);
});

test("failure-sink write failure surfaces in the receipt without failing the call", async () => {
    const store = fakeStore();
    const brokenArtifacts = {
        async downloadArtifact() { throw new Error("unused"); },
        async uploadArtifact() { throw new Error("disk full (fake)"); },
    };
    const tools = createFactTools({ factStore: store, artifactStore: brokenArtifacts, agentIdentity: "test-agent" });
    const bulk = tools.find((t) => t.name === "bulk_store_facts");
    const out = await bulk.handler({ facts: [rec("ok/1"), rec("intake/t/s")], to_file: "failed.json" }, CTX);
    assert.equal(out.committed_count, 1);
    assert.equal(out.failed_count, 1);
    assert.equal(out.failed_artifact, null);
    assert.match(out.failed_artifact_error, /disk full/);
});

test("failed_sample caps at 5 and carries keys, never values", async () => {
    await withArtifacts(async (artifacts) => {
        const store = fakeStore();
        const { bulk_store_facts } = toolsFor(store, artifacts);
        const facts = Array.from({ length: 8 }, (_, i) => rec(`intake/t/${i}`, { secret: "must-not-appear" }));
        const out = await bulk_store_facts.handler({ facts }, CTX);
        assert.equal(out.failed_count, 8);
        assert.equal(out.failed_sample.length, 5);
        assert.ok(!JSON.stringify(out.failed_sample).includes("must-not-appear"));
    });
});

// ─── store_fact regression: untouched behavior ───────────────────

test("store_fact single and batch shapes are unchanged", async () => {
    const store = fakeStore();
    const tools = createFactTools({ factStore: store, agentIdentity: "test-agent" });
    const storeFactTool = tools.find((t) => t.name === "store_fact");
    const single = await storeFactTool.handler({ key: "s/1", value: 42 }, CTX);
    assert.equal(single.key, "s/1");
    assert.equal(single.stored, true);
    assert.equal(single.scope, "session");
    const batch = await storeFactTool.handler({ facts: [{ key: "b/1", value: 1 }, { key: "b/2", value: 2, shared: true }] }, CTX);
    assert.equal(batch.stored, 2);
    assert.equal(batch.facts.length, 2);
    assert.equal(batch.facts[1].scope, "shared");
});
