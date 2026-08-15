/**
 * Whitebox: SessionBlobStore's platform-owned git-workspace artifacts (§8.5
 * AKS git hydration). These three blobs — `bundle` (session commits,
 * base..HEAD), `patch` (uncommitted tracked + untracked manifest) and `meta`
 * ({ branch, baseSha, headSha, epoch }) — back the dehydrate/hydrate protocol
 * that survives uncommitted work across a cold cross-pod resume.
 *
 * Contract under test:
 *   - gitWorkspaceBlobName derives stable, session-scoped, NON-epoch keys.
 *   - putGitWorkspaceBlob writes overwrite-in-place under that key.
 *   - getGitWorkspaceBlob round-trips the bytes, returns null on 404 (a
 *     base-only session that never dehydrated), and rethrows other errors.
 *   - the whole-session delete() sweeps all three (they leak otherwise —
 *     never epoch-versioned, never pushed to the customer remote).
 *
 * No Azure: a fake ContainerClient is injected via the config constructor
 * path (the same seam managed-identity mode and other tests use).
 *
 * Run: node --test test/unit/blob-store-git-workspace.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
    SessionBlobStore,
    gitWorkspaceBlobName,
} from "../../dist/blob-store.js";

const SESSION = "11111111-2222-3333-4444-555555555555";

/** In-memory ContainerClient double capturing every block-blob operation. */
function makeFakeContainer() {
    const blobs = new Map(); // name -> Buffer
    const calls = { put: [], get: [], del: [] };
    return {
        blobs,
        calls,
        getBlockBlobClient(name) {
            return {
                async uploadData(data) {
                    calls.put.push(name);
                    blobs.set(name, Buffer.from(data));
                },
                async downloadToBuffer() {
                    calls.get.push(name);
                    if (!blobs.has(name)) {
                        const err = new Error("BlobNotFound");
                        err.statusCode = 404;
                        throw err;
                    }
                    return blobs.get(name);
                },
                async deleteIfExists() {
                    calls.del.push(name);
                    return { succeeded: blobs.delete(name) };
                },
            };
        },
    };
}

function makeStore(container = makeFakeContainer()) {
    const store = new SessionBlobStore({
        containerClient: container,
        containerName: "copilot-sessions",
    });
    return { store, container };
}

test("gitWorkspaceBlobName derives stable, non-epoch, session-scoped keys", () => {
    assert.equal(gitWorkspaceBlobName(SESSION, "bundle"), `${SESSION}.git.bundle`);
    assert.equal(gitWorkspaceBlobName(SESSION, "patch"), `${SESSION}.git.patch`);
    // meta carries a .json suffix so listings/browsers treat it as text.
    assert.equal(gitWorkspaceBlobName(SESSION, "meta"), `${SESSION}.git.meta.json`);
});

test("put/get round-trips each git-workspace artifact byte-for-byte", async () => {
    const { store, container } = makeStore();
    const bundle = Buffer.from("PACK\x00\x01git-bundle-bytes", "binary");
    const patch = Buffer.from("diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n");
    const meta = Buffer.from(JSON.stringify({ branch: "main", baseSha: "b", headSha: "h", epoch: 3 }));

    await store.putGitWorkspaceBlob(SESSION, "bundle", bundle);
    await store.putGitWorkspaceBlob(SESSION, "patch", patch);
    await store.putGitWorkspaceBlob(SESSION, "meta", meta);

    assert.deepEqual(await store.getGitWorkspaceBlob(SESSION, "bundle"), bundle);
    assert.deepEqual(await store.getGitWorkspaceBlob(SESSION, "patch"), patch);
    assert.deepEqual(await store.getGitWorkspaceBlob(SESSION, "meta"), meta);

    // Keys used are exactly the stable git-workspace names, nothing else.
    assert.deepEqual(
        [...container.blobs.keys()].sort(),
        [
            `${SESSION}.git.bundle`,
            `${SESSION}.git.meta.json`,
            `${SESSION}.git.patch`,
        ],
    );
});

test("put overwrites in place (dehydrate is not epoch-versioned)", async () => {
    const { store, container } = makeStore();
    await store.putGitWorkspaceBlob(SESSION, "meta", Buffer.from("v1"));
    await store.putGitWorkspaceBlob(SESSION, "meta", Buffer.from("v2"));

    assert.deepEqual(await store.getGitWorkspaceBlob(SESSION, "meta"), Buffer.from("v2"));
    // Same key both times — no epoch fan-out.
    assert.deepEqual(container.calls.put, [
        `${SESSION}.git.meta.json`,
        `${SESSION}.git.meta.json`,
    ]);
    assert.equal(container.blobs.size, 1);
});

test("get returns null for an absent blob (base-only session, never dehydrated)", async () => {
    const { store } = makeStore();
    assert.equal(await store.getGitWorkspaceBlob(SESSION, "bundle"), null);
    assert.equal(await store.getGitWorkspaceBlob(SESSION, "patch"), null);
    assert.equal(await store.getGitWorkspaceBlob(SESSION, "meta"), null);
});

test("get rethrows non-404 failures instead of masking them as absent", async () => {
    const container = makeFakeContainer();
    container.getBlockBlobClient = () => ({
        async downloadToBuffer() {
            const err = new Error("AuthenticationFailed");
            err.statusCode = 403;
            throw err;
        },
    });
    const { store } = makeStore(container);
    await assert.rejects(
        () => store.getGitWorkspaceBlob(SESSION, "meta"),
        /AuthenticationFailed/,
    );
});

test("whole-session delete sweeps all three git-workspace blobs", async () => {
    const { store, container } = makeStore();
    await store.putGitWorkspaceBlob(SESSION, "bundle", Buffer.from("b"));
    await store.putGitWorkspaceBlob(SESSION, "patch", Buffer.from("p"));
    await store.putGitWorkspaceBlob(SESSION, "meta", Buffer.from("m"));

    await store.delete(SESSION); // legacy epoch => whole-session teardown

    for (const kind of ["bundle", "patch", "meta"]) {
        assert.ok(
            container.calls.del.includes(gitWorkspaceBlobName(SESSION, kind)),
            `delete() must remove the ${kind} blob`,
        );
    }
    assert.equal(container.blobs.size, 0, "no git-workspace blob may leak past session teardown");
});

test("a per-epoch delete must NOT touch git-workspace blobs (idle eviction keeps them)", async () => {
    const { store, container } = makeStore();
    await store.putGitWorkspaceBlob(SESSION, "bundle", Buffer.from("b"));
    await store.putGitWorkspaceBlob(SESSION, "patch", Buffer.from("p"));
    await store.putGitWorkspaceBlob(SESSION, "meta", Buffer.from("m"));

    await store.delete(SESSION, 4); // epoch chain teardown, not whole session

    for (const kind of ["bundle", "patch", "meta"]) {
        assert.ok(
            !container.calls.del.includes(gitWorkspaceBlobName(SESSION, kind)),
            `per-epoch delete must preserve the ${kind} blob`,
        );
    }
    assert.equal(container.blobs.size, 3, "resumable git state must survive an epoch eviction");
});
