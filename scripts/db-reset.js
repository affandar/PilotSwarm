#!/usr/bin/env node

/**
 * Reset the pilotswarm database.
 *
 * Drops both schemas:
 *   - duroxide          (orchestration runtime tables)
 *   - copilot_sessions  (CMS session catalog + events)
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

const skipConfirm = process.argv.includes("--yes") || process.argv.includes("-y");

// Parse host for display (hide password)
const displayUrl = DATABASE_URL.replace(/:\/\/([^:]+):[^@]+@/, "://$1:***@");

console.log(`\n🗑️  Database Reset`);
console.log(`   Target: ${displayUrl}\n`);
console.log(`   This will DROP:`);
console.log(`     • Schema "duroxide"         (orchestrations, queues, timers, history)`);
console.log(`     • Schema "copilot_sessions"  (sessions, events)\n`);

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

try {
    console.log("\n   Dropping schemas...");

    await pool.query("DROP SCHEMA IF EXISTS duroxide CASCADE");
    console.log("   ✅ duroxide");

    await pool.query("DROP SCHEMA IF EXISTS copilot_sessions CASCADE");
    console.log("   ✅ copilot_sessions");

    // Also clean up any leftover duroxide tables in public schema (from before schema migration)
    const { rows } = await pool.query(`
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
        AND tablename IN (
            'instances', 'executions', 'history',
            'orchestrator_queue', 'worker_queue', 'timer_queue',
            'instance_locks', 'sessions', '_duroxide_migrations'
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
