// DB-less unit tests for provider construction guards (enhancedfactstore 07 P5).
//
// These never connect to a database: create() either throws BEFORE building a
// pool (managed-identity rejection), or builds a pg.Pool whose constructor does
// not open a connection (capability reflection). Run: npm test.

import { test } from "vitest";
import assert from "node:assert/strict";

import { HorizonDBFactStore, HorizonDBGraphStore } from "../dist/src/index.js";

const URL = "postgresql://u:p@localhost:5432/db";
const EMBED = { url: "https://embed.example/v1/embeddings", model: "text-embedding-3-small", dim: 1536 };

// ─── HIGH#4: managed-identity is rejected fast + loud (no silent wrong-auth) ──

test("HorizonDBFactStore.create rejects useManagedIdentity (no AAD token pool yet)", async () => {
    await assert.rejects(
        () => HorizonDBFactStore.create({ connectionString: URL, useManagedIdentity: true }),
        /managed-identity/i,
        "fact store create() must reject MI rather than silently ignore it",
    );
});

test("HorizonDBGraphStore.create rejects useManagedIdentity", async () => {
    await assert.rejects(
        () => HorizonDBGraphStore.create({ connectionString: URL, useManagedIdentity: true }),
        /managed-identity/i,
        "graph store create() must reject MI rather than silently ignore it",
    );
});

// ─── HIGH#5: capabilities.embedder reflects construction config ───────────────

test("capabilities: search always true; embedder false without an endpoint", async () => {
    const store = await HorizonDBFactStore.create({ connectionString: URL });
    try {
        assert.equal(store.capabilities.search, true, "lexical search always supported");
        assert.equal(store.capabilities.embedder, false, "no embedding endpoint → embedder:false");
    } finally {
        await store.close(); // pool.end() on an unconnected pool is a no-op
    }
});

test("capabilities: embedder true when an embedding endpoint is provisioned", async () => {
    const store = await HorizonDBFactStore.create({ connectionString: URL, embedding: EMBED });
    try {
        assert.equal(store.capabilities.search, true);
        assert.equal(store.capabilities.embedder, true, "embedding endpoint → embedder:true");
    } finally {
        await store.close();
    }
});

// A connection-string credential (the supported path) must NOT be rejected —
// only managed identity is gated. create() returns a store (no DB connection).
test("connection-string auth is accepted (only MI is gated)", async () => {
    const store = await HorizonDBFactStore.create({ connectionString: URL });
    try {
        assert.ok(store, "non-MI create() succeeds without touching the DB");
    } finally {
        await store.close();
    }
});
