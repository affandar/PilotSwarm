import test from "node:test";
import assert from "node:assert/strict";
import { createSessionBlobStore, SessionBlobStore } from "../../dist/blob-store.js";
import { PilotSwarmWorker } from "../../dist/worker.js";

const ACCOUNT_URL = "https://example.blob.core.windows.net";
const CONNECTION_STRING =
    "DefaultEndpointsProtocol=https;AccountName=example;AccountKey=dGVzdGtleTEyMw==;EndpointSuffix=core.windows.net";

test("blob identity selection has explicit, backward-compatible precedence", async (t) => {
    await t.test("the blob-specific flag can enable identity independently", () => {
        const store = createSessionBlobStore({
            PILOTSWARM_BLOB_USE_MANAGED_IDENTITY: "1",
            PILOTSWARM_USE_MANAGED_IDENTITY: "0",
            AZURE_STORAGE_ACCOUNT_URL: ACCOUNT_URL,
        });
        assert.ok(store instanceof SessionBlobStore);
    });

    await t.test("the legacy shared flag remains the default", () => {
        const store = createSessionBlobStore({
            PILOTSWARM_USE_MANAGED_IDENTITY: "1",
            AZURE_STORAGE_ACCOUNT_URL: ACCOUNT_URL,
        });
        assert.ok(store instanceof SessionBlobStore);
    });

    await t.test("an explicit false blob flag wins and permits a connection string", () => {
        const store = createSessionBlobStore({
            PILOTSWARM_BLOB_USE_MANAGED_IDENTITY: "0",
            PILOTSWARM_USE_MANAGED_IDENTITY: "1",
            AZURE_STORAGE_ACCOUNT_URL: ACCOUNT_URL,
            AZURE_STORAGE_CONNECTION_STRING: CONNECTION_STRING,
        });
        assert.ok(store instanceof SessionBlobStore);
    });

    await t.test("an explicit true blob flag wins over a connection string", () => {
        assert.throws(
            () => createSessionBlobStore({
                PILOTSWARM_BLOB_USE_MANAGED_IDENTITY: "1",
                PILOTSWARM_USE_MANAGED_IDENTITY: "0",
                AZURE_STORAGE_CONNECTION_STRING: CONNECTION_STRING,
            }),
            /AZURE_STORAGE_ACCOUNT_URL is not/,
        );
    });
});

test("configured account URLs never fall back without credentials", async (t) => {
    await t.test("an account URL alone is rejected", () => {
        assert.throws(
            () => createSessionBlobStore({ AZURE_STORAGE_ACCOUNT_URL: ACCOUNT_URL }),
            /no blob credential path is enabled/,
        );
    });

    await t.test("an explicit false blob flag does not revive the shared flag", () => {
        assert.throws(
            () => createSessionBlobStore({
                PILOTSWARM_BLOB_USE_MANAGED_IDENTITY: "0",
                PILOTSWARM_USE_MANAGED_IDENTITY: "1",
                AZURE_STORAGE_ACCOUNT_URL: ACCOUNT_URL,
            }),
            /no blob credential path is enabled/,
        );
    });

    await t.test("a connection string remains a credential path", () => {
        const store = createSessionBlobStore({
            AZURE_STORAGE_ACCOUNT_URL: ACCOUNT_URL,
            AZURE_STORAGE_CONNECTION_STRING: CONNECTION_STRING,
        });
        assert.ok(store instanceof SessionBlobStore);
    });

    await t.test("empty configuration still selects filesystem storage", () => {
        assert.equal(createSessionBlobStore({}), null);
    });
});

test("worker options separate blob and database identity decisions", async (t) => {
    await t.test("database identity can coexist with filesystem artifacts", () => {
        assert.doesNotThrow(() => new PilotSwarmWorker({
            store: "sqlite::memory:",
            useManagedIdentity: true,
            blobUseManagedIdentity: false,
        }));
    });

    await t.test("blob identity can be enabled without database identity", () => {
        const worker = new PilotSwarmWorker({
            store: "sqlite::memory:",
            useManagedIdentity: false,
            blobUseManagedIdentity: true,
            blobAccountUrl: ACCOUNT_URL,
        });
        assert.ok(worker.blobStore instanceof SessionBlobStore);
    });

    await t.test("legacy worker configuration still enables both", () => {
        const worker = new PilotSwarmWorker({
            store: "sqlite::memory:",
            useManagedIdentity: true,
            blobAccountUrl: ACCOUNT_URL,
        });
        assert.ok(worker.blobStore instanceof SessionBlobStore);
    });
});
