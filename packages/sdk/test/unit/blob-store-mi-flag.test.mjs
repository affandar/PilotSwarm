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
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createSessionBlobStore, SessionBlobStore } from "../../dist/blob-store.js";
import { PilotSwarmWorker } from "../../dist/worker.js";
import { resolveStorageConfig } from "../../dist/storage-config.js";

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

for (const [label, options] of [
    ["password DB and Blob identity", { useManagedIdentity: false, blobUseManagedIdentity: true }],
    ["legacy shared identity", { useManagedIdentity: true }],
]) {
    test(`real worker constructor supports ${label}`, async () => {
        const root = mkdtempSync(join(tmpdir(), "ps-worker-blob-auth-"));
        const modelProvidersPath = join(root, "models.json");
        writeFileSync(modelProvidersPath, JSON.stringify({ providers: [{
            id: "test-copilot", type: "github", githubToken: "fixture-token",
            models: [{ name: "gpt-5.6-terra" }],
        }] }));
        let worker;
        try {
            const config = {
                store: "postgresql://u:p@unittest.invalid/app",
                blobAccountUrl: ACCOUNT_URL,
                sessionStateDir: join(root, "session-state"),
                modelProvidersPath, pluginDirs: [], ...options,
            };
            worker = new PilotSwarmWorker(config);
            assert.ok(worker.blobStore instanceof SessionBlobStore);
            const storage = resolveStorageConfig({ env: {}, options: config });
            assert.equal(storage.runtime.useManagedIdentity, options.useManagedIdentity);
            assert.equal(storage.duroxide.useManagedIdentity, options.useManagedIdentity);
        } finally {
            await worker?.sessionManager.shutdown();
            rmSync(root, { recursive: true, force: true });
        }
    });
}

test("worker Blob override false is not lost to truthy database identity", () => {
    assert.throws(() => new PilotSwarmWorker({
        store: "postgresql://u@unittest.invalid/app",
        useManagedIdentity: true, blobUseManagedIdentity: false, blobAccountUrl: ACCOUNT_URL,
    }), /no blob credential path is enabled/);
});

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
for (const entrypoint of ["packages/sdk/examples/worker.js", "packages/app/tui/src/embedded-workers.js"]) {
    for (const [flag, expected] of [["1", true], [" FALSE ", false], [undefined, undefined]]) {
        test(`${entrypoint} forwards Blob flag ${String(flag)} independently of database auth`, () => {
            const sdkUrl = new URL("../../dist/index.js", import.meta.url).href;
            const entryUrl = new URL(entrypoint, new URL("../../../../", import.meta.url)).href;
            const script = `
                import { mock } from "node:test";
                mock.module(${JSON.stringify(sdkUrl)}, { namedExports: {
                    horizonConfigFromEnv: () => ({}),
                    PilotSwarmWorker: class {
                        constructor(options) { this.options = options; }
                        async start() {
                            process.stdout.write("AUTH_OPTIONS:" + JSON.stringify({
                                db: this.options.useManagedIdentity, blob: this.options.blobUseManagedIdentity
                            }) + "\\n");
                            process.exit(0);
                        }
                    }
                } });
                const entry = await import(${JSON.stringify(entryUrl)});
                if (entry.startEmbeddedWorkers) await entry.startEmbeddedWorkers({count: 1, store: process.env.DATABASE_URL});
            `;
            const env = {
                ...process.env,
                DATABASE_URL: "postgresql://u:p@unittest.invalid/app",
                PILOTSWARM_USE_MANAGED_IDENTITY: "0",
            };
            if (flag === undefined) delete env.PILOTSWARM_BLOB_USE_MANAGED_IDENTITY;
            else env.PILOTSWARM_BLOB_USE_MANAGED_IDENTITY = flag;
            const result = spawnSync(process.execPath, [
                "--experimental-test-module-mocks", "--no-warnings=ExperimentalWarning",
                "--input-type=module", "-e", script,
            ], { cwd: repoRoot, env, encoding: "utf8" });
            assert.equal(result.status, 0, result.stderr);
            const match = result.stdout.match(/AUTH_OPTIONS:(.*)/);
            assert.ok(match, result.stdout);
            const options = JSON.parse(match[1]);
            assert.equal(options.db, false);
            assert.equal(options.blob, expected);
        });
    }
}
