/**
 * Epoch-scoped snapshot storage unit tests — filesystem backend + pure
 * blob naming/metadata helpers, no Azure.
 *
 * Covers the epoch key scoping contract (snapshot-protocol.ts /
 * docs/proposals/session-regen-and-footprint.md §6.1-6.2): epoch 0 keeps
 * the legacy key family byte-for-byte, epoch >= 1 chains get their own
 * names and CAS counters restarting at 1, deletion is epoch-scoped and
 * fail-closed, and no epoch-scoped blob name ends `.tar.gz`/`.meta.json`.
 *
 * Run: node --test test/unit/epoch-store.test.mjs   (requires a prior build)
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    FilesystemSessionStore,
    epochMetaFileName,
    epochVersionedTarFileName,
    parseEpochSnapshotName,
} from "../../dist/session-store.js";
import { SnapshotConflictError } from "../../dist/snapshot-protocol.js";
import { epochSnapshotBlobName, snapshotCommitBlobMetadata } from "../../dist/blob-store.js";

/** Fresh store + session-state dirs under a temp root, removed after the test. */
function makeStore(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-epoch-store-"));
    const stateDir = path.join(root, "state");
    const storeDir = path.join(root, "store");
    fs.mkdirSync(stateDir, { recursive: true });
    const store = new FilesystemSessionStore(storeDir, stateDir);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { store, stateDir, storeDir };
}

/** Minimal committable session dir (workspace.yaml is the layout signal). */
function writeSessionDir(stateDir, sessionId, noteContent) {
    const dir = path.join(stateDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "workspace.yaml"), "workspace: test\n");
    fs.writeFileSync(path.join(dir, "notes.txt"), noteContent);
}

function readNote(stateDir, sessionId) {
    return fs.readFileSync(path.join(stateDir, sessionId, "notes.txt"), "utf8");
}

test("epoch-0 commit produces exactly the legacy names", async (t) => {
    const S = "sess-legacy-naming";
    const { store, stateDir, storeDir } = makeStore(t);
    writeSessionDir(stateDir, S, "legacy");

    const res = await store.commitSnapshot(S, { baseVersion: 0, turnKey: "t1" });
    assert.equal(res.version, 1);

    const names = fs.readdirSync(storeDir);
    assert.ok(names.includes(`${S}.v1.tar.br`), `expected ${S}.v1.tar.br in ${names}`);
    assert.ok(names.includes(`${S}.meta.json`), `expected ${S}.meta.json in ${names}`);
    assert.ok(!names.some((n) => n.startsWith(`${S}.e`)), `no epoch-scoped names for epoch 0: ${names}`);
});

test("epoch-1 commit gets its own names; legacy chain probes independently", async (t) => {
    const S = "sess-epoch1-naming";
    const { store, stateDir, storeDir } = makeStore(t);
    writeSessionDir(stateDir, S, "epoch0");
    await store.commitSnapshot(S, { baseVersion: 0, turnKey: "t0" });

    const res = await store.commitSnapshot(S, { baseVersion: 0, turnKey: "e1-t1" }, 1);
    assert.equal(res.version, 1, "epoch-1 chain restarts at version 1");

    const names = fs.readdirSync(storeDir);
    assert.ok(names.includes(epochVersionedTarFileName(S, 1, 1)), `expected ${S}.e1.v1.tar.br in ${names}`);
    assert.ok(names.includes(epochMetaFileName(S, 1)), `expected ${S}.e1.meta.json in ${names}`);

    const epochProbe = await store.probeSnapshot(S, 1);
    assert.equal(epochProbe.exists, true);
    assert.equal(epochProbe.version, 1);
    assert.equal(epochProbe.turnKey, "e1-t1");

    const legacyProbe = await store.probeSnapshot(S);
    assert.equal(legacyProbe.exists, true);
    assert.equal(legacyProbe.version, 1);
    assert.equal(legacyProbe.turnKey, "t0");

    const absent = await store.probeSnapshot(S, 2);
    assert.deepEqual(absent, { exists: false, version: 0 });
});

test("epoch chains advance independently and CAS-fence stale bases", async (t) => {
    const S = "sess-chain-independence";
    const { store, stateDir, storeDir } = makeStore(t);
    writeSessionDir(stateDir, S, "epoch0");
    await store.commitSnapshot(S, { baseVersion: 0, turnKey: "t0" });
    await store.commitSnapshot(S, { baseVersion: 0, turnKey: "e1-t1" }, 1);

    const res = await store.commitSnapshot(S, { baseVersion: 1, turnKey: "e1-t2" }, 1);
    assert.equal(res.version, 2);
    const names = fs.readdirSync(storeDir);
    assert.ok(names.includes(`${S}.e1.v2.tar.br`));
    assert.ok(!names.includes(`${S}.e1.v1.tar.br`), "superseded epoch tar is GCed");
    assert.ok(names.includes(`${S}.v1.tar.br`), "legacy chain untouched");
    assert.equal((await store.probeSnapshot(S)).version, 1, "legacy version untouched");

    await assert.rejects(
        store.commitSnapshot(S, { baseVersion: 1, turnKey: "e1-t2-stale" }, 1),
        (err) => {
            assert.ok(err instanceof SnapshotConflictError);
            assert.equal(err.storedVersion, 2);
            return true;
        },
    );
});

test("hydrateSnapshot(S, 1) restores the epoch-1 content, not the legacy content", async (t) => {
    const S = "sess-epoch-hydrate";
    const { store, stateDir } = makeStore(t);
    writeSessionDir(stateDir, S, "content-epoch0");
    await store.commitSnapshot(S, { baseVersion: 0, turnKey: "t0" });
    fs.writeFileSync(path.join(stateDir, S, "notes.txt"), "content-epoch1");
    await store.commitSnapshot(S, { baseVersion: 0, turnKey: "e1-t1" }, 1);

    fs.writeFileSync(path.join(stateDir, S, "notes.txt"), "local-scratch");
    const epochRes = await store.hydrateSnapshot(S, 1);
    assert.equal(epochRes.version, 1);
    assert.equal(readNote(stateDir, S), "content-epoch1");

    const legacyRes = await store.hydrateSnapshot(S);
    assert.equal(legacyRes.version, 1);
    assert.equal(readNote(stateDir, S), "content-epoch0");
});

test("delete is epoch-scoped; deleteAllEpochs removes everything but is fail-closed", async (t) => {
    const S = "sess-epoch-delete";
    const { store, stateDir, storeDir } = makeStore(t);
    writeSessionDir(stateDir, S, "epoch0");
    await store.commitSnapshot(S, { baseVersion: 0, turnKey: "t0" });
    await store.commitSnapshot(S, { baseVersion: 0, turnKey: "e1-t1" }, 1);
    await store.commitSnapshot(S, { baseVersion: 0, turnKey: "e2-t1" }, 2);
    const planted = path.join(storeDir, `${S}.e1.weird.tar.br.bak`);
    fs.writeFileSync(planted, "not-ours-to-delete");

    await store.delete(S, 1);
    let names = fs.readdirSync(storeDir);
    assert.ok(!names.includes(`${S}.e1.v1.tar.br`), "epoch-1 tar removed");
    assert.ok(!names.includes(`${S}.e1.meta.json`), "epoch-1 meta removed");
    assert.ok(names.includes(`${S}.v1.tar.br`), "legacy tar survives");
    assert.ok(names.includes(`${S}.meta.json`), "legacy meta survives");
    assert.ok(names.includes(`${S}.e2.v1.tar.br`), "epoch-2 chain survives");
    assert.equal(await store.exists(S, 1), false);
    assert.equal(await store.exists(S), true);
    assert.equal(await store.exists(S, 2), true);

    await store.deleteAllEpochs(S);
    names = fs.readdirSync(storeDir);
    assert.ok(!names.some((n) => n.startsWith(`${S}.`) && n !== path.basename(planted)),
        `only the unparseable planted file may remain: ${names}`);
    assert.ok(fs.existsSync(planted), "fail-closed: unparseable name under the prefix survives");
});

test("a fresh epoch chain restarts version numbering at 1", async (t) => {
    const S = "sess-version-restart";
    const { store, stateDir } = makeStore(t);
    writeSessionDir(stateDir, S, "epoch0");
    await store.commitSnapshot(S, { baseVersion: 0, turnKey: "t1" });
    await store.commitSnapshot(S, { baseVersion: 1, turnKey: "t2" });
    await store.commitSnapshot(S, { baseVersion: 2, turnKey: "t3" });
    assert.equal((await store.probeSnapshot(S)).version, 3);

    const res = await store.commitSnapshot(S, { baseVersion: 0, turnKey: "e2-t1" }, 2);
    assert.equal(res.version, 1, "epoch-2 chain starts at 1 even though legacy is at 3");
});

// ─── Pure naming/metadata helpers (blob backend, no Azure) ──────────────────

test("epoch blob names never take a purge-collectible shape", () => {
    const S = "11111111-2222-3333-4444-555555555555";
    assert.equal(epochSnapshotBlobName(S, 3), `${S}.e3.tar.br`);
    for (const epoch of [1, 7, 42]) {
        const name = epochSnapshotBlobName(S, epoch);
        assert.ok(!name.endsWith(".tar.gz"), "key-shape invariant: never .tar.gz");
        assert.ok(!name.endsWith(".meta.json"), "key-shape invariant: never .meta.json");
    }
});

test("snapshot commit blob metadata carries psepoch only for epoch chains", () => {
    const base = { version: 4, turnKey: "tk", contentHash: "abc", codec: "brotli", rawSizeBytes: 123 };
    const legacy = snapshotCommitBlobMetadata(base);
    assert.deepEqual(legacy, {
        psver: "4",
        psturnkey: "tk",
        pssha: "abc",
        pscodec: "brotli",
        psraw: "123",
    });
    assert.deepEqual(snapshotCommitBlobMetadata({ ...base, epoch: 0 }), legacy, "epoch 0 = legacy");
    const epoch = snapshotCommitBlobMetadata({ ...base, epoch: 2 });
    assert.deepEqual(epoch, { ...legacy, psepoch: "2" });
});

test("parseEpochSnapshotName accepts exactly the shapes the stores write", () => {
    const S = "sess-parse";
    assert.deepEqual(parseEpochSnapshotName(S, `${S}.e1.tar.br`), { epoch: 1, kind: "tar" });
    assert.deepEqual(parseEpochSnapshotName(S, `${S}.e2.v7.tar.br`), { epoch: 2, version: 7, kind: "tar" });
    assert.deepEqual(parseEpochSnapshotName(S, `${S}.e3.meta.json`), { epoch: 3, kind: "meta" });

    for (const name of [
        `${S}.e1.weird.tar.br.bak`,
        `${S}.e1.tar.gz`,
        `${S}.e1.v2.tar.gz`,
        `${S}.e.tar.br`,
        `${S}.tar.br`,
        `${S}.e1.tar.br.tmp`,
        `other.e1.tar.br`,
        `${S}x.e1.tar.br`,
    ]) {
        assert.equal(parseEpochSnapshotName(S, name), null, `must reject ${name}`);
    }

    // Regex metacharacters in the session id must be matched literally.
    assert.deepEqual(parseEpochSnapshotName("a.b", "a.b.e1.tar.br"), { epoch: 1, kind: "tar" });
    assert.equal(parseEpochSnapshotName("a.b", "aXb.e1.tar.br"), null);
});
