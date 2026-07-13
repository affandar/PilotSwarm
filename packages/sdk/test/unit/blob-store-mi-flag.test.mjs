/**
 * Regression: createSessionBlobStore must honor the blob-specific
 * managed-identity flag and refuse silent filesystem fallback when an
 * account URL is configured.
 *
 * Incident (2026-07-12, waldemortchk): deploy overlays set
 *   PILOTSWARM_BLOB_USE_MANAGED_IDENTITY: "1"   (blob auth — the intent)
 *   PILOTSWARM_USE_MANAGED_IDENTITY:      "0"   (database AAD — off)
 *   AZURE_STORAGE_ACCOUNT_URL:            set
 * but the factory read only the unsuffixed (database) flag, returned
 * null, and the portal silently fell back to an empty
 * FilesystemArtifactStore. Workers mapped the _BLOB_ flag themselves, so
 * agents exchanged artifacts via blob while every portal/TUI/MCP
 * download and listing returned "artifact not found" — which agents then
 * rationalized into a "first-class artifact" compliance ceremony.
 *
 * Run: node --test test/unit/blob-store-mi-flag.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createSessionBlobStore, SessionBlobStore } from "../../dist/blob-store.js";

const ACCOUNT_URL = "https://unittest.blob.core.windows.net";
// Shared-key parse only — never dialed.
const CONN_STR =
    "DefaultEndpointsProtocol=https;AccountName=unittest;AccountKey=dGVzdGtleTEyMw==;EndpointSuffix=core.windows.net";

test("waldemortchk config (blob flag on, db flag off) selects the blob store", () => {
    const store = createSessionBlobStore({
        PILOTSWARM_BLOB_USE_MANAGED_IDENTITY: "1",
        PILOTSWARM_USE_MANAGED_IDENTITY: "0",
        AZURE_STORAGE_ACCOUNT_URL: ACCOUNT_URL,
    });
    assert.ok(store instanceof SessionBlobStore, "must build the blob store, not fall back");
});

test("legacy shared flag alone still selects the blob store", () => {
    const store = createSessionBlobStore({
        PILOTSWARM_USE_MANAGED_IDENTITY: "1",
        AZURE_STORAGE_ACCOUNT_URL: ACCOUNT_URL,
    });
    assert.ok(store instanceof SessionBlobStore);
});

test("explicit blob flag wins over the legacy flag, even when falsy", () => {
    // _BLOB_="0" is an explicit blob decision; the truthy db flag must not
    // resurrect MI mode. With an account URL configured and no credential
    // path, this is now a loud misconfiguration instead of a silent null.
    assert.throws(
        () => createSessionBlobStore({
            PILOTSWARM_BLOB_USE_MANAGED_IDENTITY: "0",
            PILOTSWARM_USE_MANAGED_IDENTITY: "1",
            AZURE_STORAGE_ACCOUNT_URL: ACCOUNT_URL,
        }),
        /no blob credential path is enabled/,
    );
});

test("account URL without any credential path throws instead of silent fallback", () => {
    assert.throws(
        () => createSessionBlobStore({ AZURE_STORAGE_ACCOUNT_URL: ACCOUNT_URL }),
        /Refusing to fall back to the filesystem artifact store/,
    );
});

test("MI flag without an account URL still throws the actionable error", () => {
    assert.throws(
        () => createSessionBlobStore({ PILOTSWARM_BLOB_USE_MANAGED_IDENTITY: "1" }),
        /AZURE_STORAGE_ACCOUNT_URL is not/,
    );
});

test("connection-string mode is unchanged", () => {
    const store = createSessionBlobStore({ AZURE_STORAGE_CONNECTION_STRING: CONN_STR });
    assert.ok(store instanceof SessionBlobStore);
});

test("empty env still opts into filesystem storage via null", () => {
    assert.equal(createSessionBlobStore({}), null);
});
