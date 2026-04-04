#!/usr/bin/env node

/**
 * Reset the pilotswarm database.
 *
 * Drops PilotSwarm schemas:
 *   - duroxide          (orchestration runtime tables)
 *   - copilot_sessions  (CMS session catalog + events)
 *   - pilotswarm_facts  (durable facts)
 *
 * Usage:
 *   node --env-file=.env scripts/db-reset.js
 *   node --env-file=.env scripts/db-reset.js --yes   # skip confirmation
 */

import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.error("ERROR: DATABASE_URL not set. Use --env-file=.env");
    process.exit(1);
}
const DUROXIDE_SCHEMA = process.env.DUROXIDE_SCHEMA || "duroxide";
const CMS_SCHEMA = process.env.CMS_SCHEMA || "copilot_sessions";
const FACTS_SCHEMA = process.env.FACTS_SCHEMA || "pilotswarm_facts";

const skipConfirm = process.argv.includes("--yes") || process.argv.includes("-y");

// Parse host for display (hide password)
const displayUrl = DATABASE_URL.replace(/:\/\/([^:]+):[^@]+@/, "://$1:***@");

console.log(`\n🗑️  Database Reset`);
console.log(`   Target: ${displayUrl}\n`);
console.log(`   This will DROP:`);
console.log(`     • Schema "${DUROXIDE_SCHEMA}"         (orchestrations, queues, timers, history)`);
console.log(`     • Schema "${CMS_SCHEMA}"  (sessions, events)`);
console.log(`     • Schema "${FACTS_SCHEMA}"   (durable facts)\n`);

if (!skipConfirm) {
    const readline = await import("node:readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => rl.question("   Are you sure? [y/N] ", resolve));
    rl.close();
    if (answer.toLowerCase() !== "y") {
        console.log("   Aborted.\n");
        process.exit(0);
    }
}

// Parse SSL mode from URL — Azure DBs need rejectUnauthorized: false
const parsedUrl = new URL(DATABASE_URL);
const needsSsl = ["require", "prefer", "verify-ca", "verify-full"]
    .includes(parsedUrl.searchParams.get("sslmode") ?? "");
parsedUrl.searchParams.delete("sslmode");

const pool = new pg.Pool({
    connectionString: parsedUrl.toString(),
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

function quoteIdent(value) {
    return `"${String(value).replace(/"/g, "\"\"")}"`;
}

try {
    console.log("\n   Dropping schemas...");

    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(DUROXIDE_SCHEMA)} CASCADE`);
    console.log(`   ✅ ${DUROXIDE_SCHEMA}`);

    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(CMS_SCHEMA)} CASCADE`);
    console.log(`   ✅ ${CMS_SCHEMA}`);

    await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(FACTS_SCHEMA)} CASCADE`);
    console.log(`   ✅ ${FACTS_SCHEMA}`);

    // Also clean up any leftover duroxide tables in public schema (from before schema migration).
    // Keep this defensive: the public-schema cleanup is only for old legacy installs, and
    // duroxide's internal queue table names are not a stable contract.
    const { rows } = await pool.query(`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
        AND (
            tablename IN (
                'instances',
                'executions',
                'history',
                'instance_locks',
                'sessions',
                '_duroxide_migrations'
            )
            OR (
                tablename LIKE '%\\_queue' ESCAPE '\\'
                AND EXISTS (
                    SELECT 1
                    FROM pg_tables legacy
                    WHERE legacy.schemaname = 'public'
                      AND legacy.tablename = '_duroxide_migrations'
                )
            )
        )
    `);
    if (rows.length > 0) {
        console.log(`\n   Found ${rows.length} legacy duroxide table(s) in public schema...`);
        for (const { tablename } of rows) {
            await pool.query(`DROP TABLE IF EXISTS public."${tablename}" CASCADE`);
            console.log(`   ✅ public.${tablename}`);
        }
    }

    console.log("\n   Done. Database is clean — schemas will be recreated on next start.");

    // Also purge blob storage if configured
    const blobConnStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (blobConnStr) {
        try {
            const { BlobServiceClient } = await import("@azure/storage-blob");
            const container = process.env.AZURE_STORAGE_CONTAINER || "copilot-sessions";
            const svc = BlobServiceClient.fromConnectionString(blobConnStr);
            const ctr = svc.getContainerClient(container);
            let count = 0;
            for await (const blob of ctr.listBlobsFlat()) {
                await ctr.deleteBlob(blob.name);
                count++;
            }
            if (count > 0) {
                console.log(`   ✅ Purged ${count} blob(s) from ${container}`);
            } else {
                console.log(`   ✅ Blob storage already empty (${container})`);
            }
        } catch (err) {
            console.log(`   ⚠️  Blob purge failed: ${err.message}`);
        }
    }

    console.log("");
} catch (err) {
    console.error(`\n   ❌ Error: ${err.message}\n`);
    process.exit(1);
} finally {
    await pool.end();
}
