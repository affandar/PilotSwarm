/**
 * Regression: the duroxide orchestration Postgres provider (Rust/sqlx,
 * configured separately from the node-pg pools) must carry pool/acquire
 * resiliency options on its Entra path, so a slow turn-commit under pool
 * contention lands before its orchestrator-queue message is redelivered.
 *
 * Incident: on a remote devbox (~14s cold authenticated connect) a
 * durable-session turn kept failing to commit within the native 30s
 * acquire timeout; the ActivityCompleted message for getWorkerSessionPolicy
 * was redelivered until it exceeded duroxide's hard-capped 10 poison
 * attempts, failing the session with `poison: ... exceeded 11 attempts`.
 *
 * Run: node --test test/unit/duroxide-pool-resiliency.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
    duroxidePgResiliencyConfig,
    createDuroxidePostgresProvider,
} from "../../dist/duroxide-provider-factory.js";

const MI_URL = "postgres://appuser@dbhost.example.com:5432/appdb";

test("defaults: acquire timeout raised to 60s, ceiling/refresh left to native", () => {
    const cfg = duroxidePgResiliencyConfig({});
    assert.equal(cfg.acquireTimeoutMs, 60_000, "acquireTimeoutMs must default to 60s");
    assert.equal(cfg.maxConnections, undefined, "maxConnections omitted when env unset");
    assert.equal(cfg.refreshIntervalMs, undefined, "refreshIntervalMs omitted when env unset");
});

test("env overrides are honoured", () => {
    const cfg = duroxidePgResiliencyConfig({
        DUROXIDE_PG_POOL_MAX: "8",
        DUROXIDE_PG_ACQUIRE_TIMEOUT_MS: "45000",
        DUROXIDE_PG_TOKEN_REFRESH_MS: "120000",
    });
    assert.equal(cfg.maxConnections, 8);
    assert.equal(cfg.acquireTimeoutMs, 45_000);
    assert.equal(cfg.refreshIntervalMs, 120_000);
});

test("blank / non-positive values fall back to native defaults", () => {
    const cfg = duroxidePgResiliencyConfig({
        DUROXIDE_PG_POOL_MAX: "",
        DUROXIDE_PG_ACQUIRE_TIMEOUT_MS: "0",
        DUROXIDE_PG_TOKEN_REFRESH_MS: "-5",
    });
    assert.equal(cfg.maxConnections, undefined, "blank ceiling omitted");
    assert.equal(cfg.acquireTimeoutMs, 60_000, "non-positive acquire timeout -> default 60s");
    assert.equal(cfg.refreshIntervalMs, undefined, "negative refresh omitted");
});

test("factory threads resiliency options into the Entra connect call", async () => {
    let captured;
    const stubProvider = {
        connectWithSchema() {
            throw new Error("legacy path must not run on the MI branch");
        },
        connectWithSchemaAndEntra(host, port, database, user, schema, options) {
            captured = { host, port, database, user, schema, options };
            return Promise.resolve({ __provider: true });
        },
    };

    await createDuroxidePostgresProvider(stubProvider, MI_URL, "ps_duroxide", {
        useManagedIdentity: true,
        entraOptions: { maxConnections: 8, acquireTimeoutMs: 60_000 },
    });

    assert.equal(captured.schema, "ps_duroxide");
    assert.deepEqual(captured.options, { maxConnections: 8, acquireTimeoutMs: 60_000 });
});

test("factory falls back to env-derived options when none are passed", async () => {
    let captured;
    const stubProvider = {
        connectWithSchema() {
            throw new Error("legacy path must not run on the MI branch");
        },
        connectWithSchemaAndEntra(host, port, database, user, schema, options) {
            captured = options;
            return Promise.resolve({ __provider: true });
        },
    };

    await createDuroxidePostgresProvider(stubProvider, MI_URL, "ps_duroxide", {
        useManagedIdentity: true,
    });

    assert.equal(typeof captured, "object", "an options object must be passed");
    assert.equal(captured.acquireTimeoutMs, 60_000, "env-derived default acquire timeout must be threaded");
});

test("legacy (non-MI) path stays optionless", async () => {
    let usedLegacy = false;
    const stubProvider = {
        connectWithSchema() {
            usedLegacy = true;
            return Promise.resolve({ __provider: true });
        },
        connectWithSchemaAndEntra() {
            throw new Error("MI path must not run when useManagedIdentity is false");
        },
    };

    await createDuroxidePostgresProvider(stubProvider, MI_URL, "ps_duroxide", {
        useManagedIdentity: false,
    });
    assert.equal(usedLegacy, true, "non-MI path must use connectWithSchema");
});
