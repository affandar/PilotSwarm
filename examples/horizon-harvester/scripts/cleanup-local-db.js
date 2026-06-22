#!/usr/bin/env node

/**
 * Horizon Harvester — Local Cleanup Script
 *
 * Resets local development state:
 *   1. Queries CMS for session IDs (before dropping schemas)
 *   2. Removes local artifact / session-state / session-store files for those sessions
 *   3. Drops the local ps_duroxide, legacy duroxide if PilotSwarm-owned, and copilot_sessions schemas (CMS + orchestration)
 *
 * The HorizonDB facts + graph live on a SEPARATE (preview) cluster, so this script
 * does NOT touch them by default. Two opt-in levels of HorizonDB cleanup:
 *
 *   HARVESTER_CLEAN_HORIZON=1  — delete just this sample's corpus/northwind facts
 *                                (keeps the schema, embedder loop, and any other data).
 *   HARVESTER_DROP_HORIZON=1   — full teardown of the harvested data AND schemas:
 *                                cancels the durable embedder loop, drops the AGE
 *                                knowledge graph (horizon_graph), and DROP SCHEMA
 *                                horizon_facts CASCADE. Use this to start completely
 *                                clean (e.g. to re-harvest with a changed embed input).
 *
 * Usage:
 *   node --env-file=../../.env examples/horizon-harvester/scripts/cleanup-local-db.js
 *   HARVESTER_CLEAN_HORIZON=1 node --env-file=../../.env .../cleanup-local-db.js
 *   HARVESTER_DROP_HORIZON=1  node --env-file=../../.env .../cleanup-local-db.js
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";

const { Client } = pg;

async function schemaOwnedByPgDurable(client, schemaName) {
    const { rows } = await client.query(`
        SELECT EXISTS (
            SELECT 1
            FROM pg_extension e
            JOIN pg_namespace n ON n.oid = e.extnamespace
            WHERE e.extname = 'pg_durable'
              AND n.nspname = $1
        ) AS owned
    `, [schemaName]);
    return Boolean(rows[0]?.owned);
}

if (typeof process.loadEnvFile === "function") {
    try { process.loadEnvFile(".env"); } catch {}
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
    console.error("DATABASE_URL is required.");
    process.exit(1);
}

const SESSION_STATE_DIR = process.env.SESSION_STATE_DIR || path.join(os.homedir(), ".copilot", "session-state");
const SESSION_STORE_DIR = path.join(path.dirname(SESSION_STATE_DIR), "session-store");
const ARTIFACT_DIR = path.join(path.dirname(SESSION_STATE_DIR), "artifacts");

/** Build a pg Client from a connection string, honoring sslmode. */
function pgClient(connStr) {
    const url = new URL(connStr);
    const ssl = ["require", "prefer", "verify-ca", "verify-full"].includes(url.searchParams.get("sslmode") ?? "");
    url.searchParams.delete("sslmode");
    return new Client({
        connectionString: url.toString(),
        ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    });
}

// ── 1. Collect session IDs from CMS ─────────────────────────

const client = pgClient(connectionString);

let sessionIds = [];
try {
    await client.connect();
    const { rows } = await client.query("SELECT session_id FROM copilot_sessions.sessions");
    sessionIds = rows.map((r) => r.session_id);
    console.log(`Found ${sessionIds.length} CMS session(s).`);
} catch {
    console.log("No CMS sessions found (schema may not exist yet).");
}

// ── 2. Remove local artifact / state / store files ──────────

let artifactsDeleted = 0;
let stateDeleted = 0;
let storeDeleted = 0;
for (const sid of sessionIds) {
    const artDir = path.join(ARTIFACT_DIR, sid);
    if (fs.existsSync(artDir)) { fs.rmSync(artDir, { recursive: true, force: true }); artifactsDeleted++; }

    const stDir = path.join(SESSION_STATE_DIR, sid);
    if (fs.existsSync(stDir)) { fs.rmSync(stDir, { recursive: true, force: true }); stateDeleted++; }

    for (const ext of [".tar.gz", ".meta.json"]) {
        const file = path.join(SESSION_STORE_DIR, `${sid}${ext}`);
        if (fs.existsSync(file)) { fs.unlinkSync(file); storeDeleted++; }
    }
}
console.log(`Deleted ${artifactsDeleted} artifact dir(s), ${stateDeleted} session-state dir(s), ${storeDeleted} session-store file(s).`);

// ── 3. Drop local CMS + orchestration schemas ───────────────

try {
    await client.query("DROP SCHEMA IF EXISTS ps_duroxide CASCADE");
    console.log("Dropped schema: ps_duroxide");
    if (await schemaOwnedByPgDurable(client, "duroxide")) {
        console.log("Skipped schema: duroxide (owned by pg_durable)");
    } else {
        await client.query("DROP SCHEMA IF EXISTS duroxide CASCADE");
        console.log("Dropped schema: duroxide");
    }
    await client.query("DROP SCHEMA IF EXISTS copilot_sessions CASCADE");
    console.log("Dropped schema: copilot_sessions");
} finally {
    await client.end().catch(() => {});
}

// ── 4. (Optional) HorizonDB cleanup — facts + graph on the preview cluster ──

const factsSchema = process.env.HORIZON_FACTS_SCHEMA || "horizon_facts";
const graphSchema = process.env.HORIZON_GRAPH_SCHEMA || "horizon_graph";
const factsUrl = process.env.HORIZON_DATABASE_URL;
const graphUrl = process.env.HORIZON_GRAPH_DATABASE_URL || factsUrl;

if (process.env.HARVESTER_DROP_HORIZON === "1" && factsUrl) {
    // Full teardown: cancel the durable embed loop, drop the AGE graph, then
    // DROP SCHEMA the facts store. Cancelling the loop FIRST matters — a
    // pg_durable instance lives in the `df` schema and survives a facts-schema
    // drop, so left running it would keep firing against a now-missing table
    // (and, after an embed-input change, a stale loop would keep embedding with
    // the OLD text). Label mirrors horizon-store: hz-embed-cron:<schema>.
    const facts = pgClient(factsUrl);
    try {
        await facts.connect();
        try {
            const { rows } = await facts.query(
                `SELECT id FROM df.instances
                  WHERE label = $1 AND status IN ('pending','running')`,
                [`hz-embed-cron:${factsSchema}`],
            );
            for (const r of rows) {
                await facts.query(`SELECT df.cancel($1, $2)`, [r.id, "harvester cleanup teardown"]);
            }
            console.log(`Cancelled ${rows.length} durable embedder loop instance(s) for ${factsSchema}.`);
        } catch (err) {
            console.warn(`Embedder loop cancel skipped: ${err.message}`);
        }
        await facts.query(`DROP SCHEMA IF EXISTS "${factsSchema}" CASCADE`);
        console.log(`Dropped schema: ${factsSchema} (facts).`);
    } catch (err) {
        console.warn(`Horizon facts drop skipped: ${err.message}`);
    } finally {
        await facts.end().catch(() => {});
    }

    // The AGE graph may live on the same cluster or a separate one. drop_graph
    // (cascade=true) removes the graph's backing schema and its ag_catalog
    // entry; a bare DROP SCHEMA would leave ag_catalog inconsistent.
    const graph = pgClient(graphUrl);
    try {
        await graph.connect();
        try { await graph.query(`LOAD 'age'`); } catch { /* preloaded on HorizonDB — tolerated */ }
        await graph.query(`SET search_path = ag_catalog, "$user", public`);
        try {
            await graph.query(`SELECT drop_graph($1, true)`, [graphSchema]);
            console.log(`Dropped AGE graph: ${graphSchema}.`);
        } catch (err) {
            console.warn(`AGE graph drop skipped (may not exist): ${err.message}`);
        }
    } catch (err) {
        console.warn(`Horizon graph drop skipped: ${err.message}`);
    } finally {
        await graph.end().catch(() => {});
    }
    console.log("HorizonDB teardown complete. Facts + graph will be recreated on next harvest.");
} else if (process.env.HARVESTER_CLEAN_HORIZON === "1" && factsUrl) {
    // Light cleanup: delete just this sample's corpus facts (keep schema/embedder).
    const horizon = pgClient(factsUrl);
    try {
        await horizon.connect();
        const { rowCount } = await horizon.query(
            `DELETE FROM "${factsSchema}".facts WHERE key LIKE 'corpus/northwind/%'`,
        );
        console.log(`Deleted ${rowCount ?? 0} corpus/northwind fact(s) from ${factsSchema}.`);
    } catch (err) {
        console.warn(`Horizon facts cleanup skipped: ${err.message}`);
    } finally {
        await horizon.end().catch(() => {});
    }
    console.log("Note: the knowledge graph (Apache AGE) was not reset. Use HARVESTER_DROP_HORIZON=1 for a full teardown.");
}

console.log("\nDone. Schemas will be recreated on next start.");
