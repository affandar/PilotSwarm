#!/usr/bin/env node
/**
 * Bounded PostgreSQL reachability + sanity-query probe (raw `pg` client).
 *
 * Goal (PoC Step 1a): prove that a host (an ADO Windows agent, in the PoC
 * pipeline) can (a) reach the real durable PostgreSQL store over the network
 * and TLS, (b) authenticate, and (c) run read-only sanity queries against it.
 * It does NOT boot the worker, does NOT claim or process any orchestration —
 * this is the "can the VM talk to the DB at all" milestone that precedes any
 * worker.start(). Serving work is a later, explicit step.
 *
 * Auth: Entra ID (Microsoft Entra) token used as the libpq password. The prod
 * Flexible Server has passwordAuth disabled, so the caller mints an access
 * token for https://ossrdbms-aad.database.windows.net/.default and passes it
 * in PG_ENTRA_TOKEN; PGUSER_ENTRA is the AAD principal name (e.g. a user UPN
 * or a managed-identity name provisioned as a PG role).
 *
 * Env vars:
 *   PGHOST_FQDN       — server FQDN (e.g. myserver.postgres.database.azure.com)
 *   PGDB              — database name (default: postgres)
 *   PGUSER_ENTRA      — Entra principal name provisioned as a PG role
 *   PG_ENTRA_TOKEN    — Entra access token (ossrdbms audience) used as password
 *   PGPORT            — port (default: 5432)
 *   REACH_TIMEOUT_MS  — watchdog (default: 30000)
 *
 * Read-only: every statement is a SELECT against catalog/inventory. No writes,
 * no locks, no queue reads that could claim work.
 *
 * Exit codes: 0 = reached + queried; 1 = connect/query failure; 2 = watchdog.
 *
 * Usage: node db-reach.mjs
 */
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const OK = "REACH_OK: connected to PostgreSQL and ran sanity queries";
const FAIL = "REACH_FAIL";

const timeoutMs = Number.parseInt(process.env.REACH_TIMEOUT_MS || "30000", 10);
const bail = setTimeout(() => {
    console.error(`${FAIL}: probe did not complete within ${timeoutMs}ms`);
    process.exit(2);
}, timeoutMs);
bail.unref?.();

// Best-effort: print the agent's outbound IP so the operator can tighten the
// server firewall to just this address after the broad probe succeeds.
async function reportEgressIp() {
    try {
        const res = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(8000) });
        const { ip } = await res.json();
        console.log(`[db-reach] agent egress IP: ${ip}`);
    } catch (e) {
        console.log(`[db-reach] egress IP lookup skipped: ${e?.message || e}`);
    }
}

try {
    console.log(`[db-reach] node ${process.version} on ${os.platform()}-${os.arch()} (${os.hostname()})`);
    await reportEgressIp();

    const host = process.env.PGHOST_FQDN;
    const database = process.env.PGDB || "postgres";
    const user = process.env.PGUSER_ENTRA;
    const password = process.env.PG_ENTRA_TOKEN;
    const port = Number.parseInt(process.env.PGPORT || "5432", 10);

    const misconfig = [];
    if (!host) misconfig.push("PGHOST_FQDN");
    if (!user) misconfig.push("PGUSER_ENTRA");
    if (!password) misconfig.push("PG_ENTRA_TOKEN");
    if (misconfig.length) throw new Error(`missing required env: ${misconfig.join(", ")}`);

    console.log(`[db-reach] connecting to ${host}:${port}/${database} as ${user} (Entra token, sslmode=require)`);

    const pg = require("pg");
    const client = new pg.Client({
        host,
        port,
        user,
        password,
        database,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 15000,
        // Fail fast rather than hang if a query wedges.
        statement_timeout: 10000,
        query_timeout: 10000,
    });

    await client.connect();
    console.log("[db-reach] TCP + TLS + auth handshake OK");

    const version = await client.query("select version() as v");
    console.log(`[db-reach] server: ${version.rows[0].v.split(" on ")[0]}`);

    const whoami = await client.query("select current_user as u, current_database() as d, inet_server_addr()::text as srv");
    console.log(`[db-reach] current_user=${whoami.rows[0].u} db=${whoami.rows[0].d} server_addr=${whoami.rows[0].srv}`);

    const schemas = await client.query(
        `select schema_name from information_schema.schemata
         where schema_name not in ('pg_catalog','information_schema','pg_toast')
         order by 1`,
    );
    console.log(`[db-reach] schemas: ${schemas.rows.map((r) => r.schema_name).join(", ") || "(none)"}`);

    const counts = await client.query(
        `select table_schema, count(*)::int n from information_schema.tables
         where table_schema not in ('pg_catalog','information_schema')
         group by 1 order by 2 desc`,
    );
    for (const r of counts.rows) console.log(`[db-reach]   ${r.table_schema}: ${r.n} tables`);

    // Confirm the duroxide store schema is present (read-only inventory, no queue read).
    const duroxide = await client.query(
        `select table_name from information_schema.tables
         where table_schema = 'ps_duroxide' order by 1`,
    );
    if (duroxide.rows.length > 0) {
        console.log(`[db-reach] ps_duroxide tables: ${duroxide.rows.map((r) => r.table_name).join(", ")}`);
    } else {
        console.log("[db-reach] NOTE: ps_duroxide schema not found (store may be empty/uninitialized)");
    }

    await client.end();
    clearTimeout(bail);
    console.log(OK);
    process.exit(0);
} catch (err) {
    clearTimeout(bail);
    console.error(`${FAIL}: ${err?.stack || err}`);
    process.exit(1);
}
