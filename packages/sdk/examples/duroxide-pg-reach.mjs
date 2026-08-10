#!/usr/bin/env node
/**
 * Bounded duroxide PostgresProvider reachability probe (native runtime path).
 *
 * Goal (PoC Step 1, increment 2): prove that duroxide's OWN native Postgres
 * provider — the Rust code path the real worker uses for the durable
 * orchestration store — can connect to the real PostgreSQL server, over TLS,
 * against the live `ps_duroxide` schema. This is a strict superset of the raw
 * `pg` probe (db-reach.mjs): it exercises the actual native duroxide wire/TLS/
 * schema handling, not just node-pg.
 *
 * It does NOT start a Runtime and does NOT poll any queue, so it cannot claim
 * or process orchestration work. It connects, confirms the provider object is
 * live, and closes.
 *
 * Auth: Azure Database for PostgreSQL accepts a Microsoft Entra access token
 * presented AS the libpq password. So we build a standard connection string
 * with the token as the password and hand it to duroxide's
 * `PostgresProvider.connectWithSchema(url, schema)`. This reuses the same
 * PG_ENTRA_TOKEN the raw probe uses and avoids duroxide's in-Rust credential
 * chain (which would require a provisioned managed identity / az login on the
 * host — deferred to the MI hardening step).
 *
 * Env vars:
 *   PGHOST_FQDN       — server FQDN
 *   PGDB              — database name (default: postgres)
 *   PGUSER_ENTRA      — Entra principal name provisioned as a PG role
 *   PG_ENTRA_TOKEN    — Entra access token (ossrdbms audience), used as password
 *   PGPORT            — port (default: 5432)
 *   DUROXIDE_PG_SCHEMA — schema to bind (default: ps_duroxide)
 *   REACH_TIMEOUT_MS  — watchdog (default: 30000)
 *
 * Exit codes: 0 = provider connected; 1 = connect failure; 2 = watchdog.
 *
 * Usage: node duroxide-pg-reach.mjs
 */
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const OK = "DUROXIDE_PG_OK: duroxide PostgresProvider connected to the durable store";
const FAIL = "DUROXIDE_PG_FAIL";

const timeoutMs = Number.parseInt(process.env.REACH_TIMEOUT_MS || "30000", 10);
const bail = setTimeout(() => {
    console.error(`${FAIL}: probe did not complete within ${timeoutMs}ms`);
    process.exit(2);
}, timeoutMs);
bail.unref?.();

function redact(url) {
    return url.replace(/:\/\/([^:]+):[^@]+@/, "://$1:***@");
}

try {
    console.log(`[duroxide-pg] node ${process.version} on ${os.platform()}-${os.arch()} (${os.hostname()})`);

    const host = process.env.PGHOST_FQDN;
    const database = process.env.PGDB || "postgres";
    const user = process.env.PGUSER_ENTRA;
    const token = process.env.PG_ENTRA_TOKEN;
    const port = Number.parseInt(process.env.PGPORT || "5432", 10);
    const schema = process.env.DUROXIDE_PG_SCHEMA || "ps_duroxide";

    const misconfig = [];
    if (!host) misconfig.push("PGHOST_FQDN");
    if (!user) misconfig.push("PGUSER_ENTRA");
    if (!token) misconfig.push("PG_ENTRA_TOKEN");
    if (misconfig.length) throw new Error(`missing required env: ${misconfig.join(", ")}`);

    // Azure PG Entra auth: token presented as the libpq password. URL-encode
    // both the principal (contains '@') and the token (JWT: only [A-Za-z0-9_.-],
    // but encode defensively).
    const url =
        `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(token)}` +
        `@${host}:${port}/${database}?sslmode=require`;
    console.log(`[duroxide-pg] connect url: ${redact(url)}  schema=${schema}`);

    const duroxide = require("duroxide");
    if (!duroxide.PostgresProvider) throw new Error("duroxide.PostgresProvider export missing");
    if (typeof duroxide.PostgresProvider.connectWithSchema !== "function") {
        throw new Error("duroxide.PostgresProvider.connectWithSchema is not a function");
    }
    console.log("[duroxide-pg] duroxide native addon loaded; PostgresProvider present");

    const t0 = Date.now();
    const provider = await duroxide.PostgresProvider.connectWithSchema(url, schema);
    if (!provider) throw new Error("connectWithSchema returned nothing");
    console.log(`[duroxide-pg] PostgresProvider.connectWithSchema('${schema}') OK in ${Date.now() - t0}ms`);
    console.log(`[duroxide-pg] provider object type: ${provider?.constructor?.name || typeof provider}`);

    // Deliberately NOT starting a Runtime or polling queues — connection proof only.
    if (typeof provider.close === "function") {
        try { await provider.close(); console.log("[duroxide-pg] provider.close() OK"); } catch { /* best effort */ }
    }

    clearTimeout(bail);
    console.log(OK);
    process.exit(0);
} catch (err) {
    clearTimeout(bail);
    console.error(`${FAIL}: ${err?.stack || err}`);
    process.exit(1);
}
