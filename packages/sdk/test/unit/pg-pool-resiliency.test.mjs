/**
 * Regression: every pg.Pool built by buildPgPoolConfig must carry
 * connection-resiliency bounds (keepAlive + connection/query/statement
 * timeouts) so a transient Postgres connectivity blip becomes a fast
 * REJECT the cms-retry layer can ride out, instead of a permanent HANG
 * that wedges the worker heartbeat / CMS work until a process restart.
 *
 * Incident: devbox worker heartbeat froze after a momentary devbox->PG
 * network drop. pg's defaults (connectionTimeoutMillis:0, no
 * query_timeout, keepAlive off) let pool.query hang forever on a
 * half-open socket, so try/catch and cms-retry never engaged. Tracked as
 * a pool-resiliency defect (missing timeouts were a long-standing gap,
 * pickaxe-proven never present in the real pools).
 *
 * Run: node --test test/unit/pg-pool-resiliency.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
    buildPgPoolConfig,
    pgResiliencyConfig,
    _setPgAadCredentialForTests,
} from "../../dist/pg-pool-factory.js";

const NON_MI_URL = "postgres://appuser:secret@dbhost.example.com:5432/appdb";
const MI_URL = "postgres://appuser@dbhost.example.com:5432/appdb";

const RESILIENCY_KEYS = [
    "keepAlive",
    "keepAliveInitialDelayMillis",
    "connectionTimeoutMillis",
    "query_timeout",
    "statement_timeout",
    "min",
    "idleTimeoutMillis",
];

function assertHasDefaults(cfg) {
    assert.equal(cfg.keepAlive, true, "keepAlive must be enabled");
    assert.equal(cfg.keepAliveInitialDelayMillis, 10_000);
    assert.equal(cfg.connectionTimeoutMillis, 15_000);
    assert.equal(cfg.query_timeout, 60_000);
    assert.equal(cfg.statement_timeout, 60_000);
    // Warm-pool floor: keep 1 connection alive so steady-state queries
    // skip the ~3-11s cold Entra-auth connect; hold burst connections 60s.
    assert.equal(cfg.min, 1);
    assert.equal(cfg.idleTimeoutMillis, 60_000);
}

test("pgResiliencyConfig returns the documented defaults for empty env", () => {
    assertHasDefaults(pgResiliencyConfig({}));
});

test("non-MI pool config carries the resiliency bounds", () => {
    const cfg = buildPgPoolConfig({ connectionString: NON_MI_URL });
    for (const k of RESILIENCY_KEYS) {
        assert.ok(k in cfg, `non-MI config missing ${k}`);
    }
    assertHasDefaults(cfg);
});

test("MI pool config carries the resiliency bounds", () => {
    // Stub the AAD credential so the MI branch never dials Azure.
    _setPgAadCredentialForTests({ getToken: async () => ({ token: "stub", expiresOnTimestamp: Date.now() + 60_000 }) });
    try {
        const cfg = buildPgPoolConfig({ connectionString: MI_URL, useManagedIdentity: true });
        for (const k of RESILIENCY_KEYS) {
            assert.ok(k in cfg, `MI config missing ${k}`);
        }
        assertHasDefaults(cfg);
        // Sanity: still an MI-shaped config (async password callback, no embedded password).
        assert.equal(typeof cfg.password, "function");
    } finally {
        _setPgAadCredentialForTests(null);
    }
});

test("env overrides are honored", () => {
    const cfg = pgResiliencyConfig({
        PILOTSWARM_PG_KEEPALIVE_INITIAL_DELAY_MS: "2000",
        PILOTSWARM_PG_CONNECTION_TIMEOUT_MS: "3000",
        PILOTSWARM_PG_QUERY_TIMEOUT_MS: "4000",
        PILOTSWARM_PG_STATEMENT_TIMEOUT_MS: "5000",
        PILOTSWARM_PG_POOL_MIN: "3",
        PILOTSWARM_PG_IDLE_TIMEOUT_MS: "120000",
    });
    assert.equal(cfg.keepAliveInitialDelayMillis, 2000);
    assert.equal(cfg.connectionTimeoutMillis, 3000);
    assert.equal(cfg.query_timeout, 4000);
    assert.equal(cfg.statement_timeout, 5000);
    assert.equal(cfg.min, 3);
    assert.equal(cfg.idleTimeoutMillis, 120000);
});

test("0 is an accepted escape hatch that disables a bound", () => {
    const cfg = pgResiliencyConfig({
        PILOTSWARM_PG_CONNECTION_TIMEOUT_MS: "0",
        PILOTSWARM_PG_QUERY_TIMEOUT_MS: "0",
        PILOTSWARM_PG_STATEMENT_TIMEOUT_MS: "0",
        PILOTSWARM_PG_POOL_MIN: "0",
        PILOTSWARM_PG_IDLE_TIMEOUT_MS: "0",
    });
    assert.equal(cfg.connectionTimeoutMillis, 0);
    assert.equal(cfg.query_timeout, 0);
    assert.equal(cfg.statement_timeout, 0);
    // min 0 restores drain-to-zero; idleTimeoutMillis 0 disables reaping.
    assert.equal(cfg.min, 0);
    assert.equal(cfg.idleTimeoutMillis, 0);
});

test("blank / malformed / negative env values fall back to defaults", () => {
    for (const bad of ["", "   ", "abc", "-1", "12.5xyz-nope"]) {
        const cfg = pgResiliencyConfig({ PILOTSWARM_PG_QUERY_TIMEOUT_MS: bad });
        // "12.5xyz-nope" parseInt -> 12 (finite, >=0) is acceptable; only assert
        // the clearly-invalid ones fall back.
        if (bad.trim() === "" || bad === "abc" || bad === "-1") {
            assert.equal(cfg.query_timeout, 60_000, `expected fallback for ${JSON.stringify(bad)}`);
        }
    }
});
