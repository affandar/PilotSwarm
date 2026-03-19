#!/usr/bin/env node

/**
 * DevOps Command Center — Local Cleanup Script
 *
 * Resets local development state:
 *   1. Queries CMS for session IDs (before dropping schemas)
 *   2. Removes local artifact dirs (~/.copilot/artifacts/<sessionId>/)
 *   3. Removes local session state dirs (~/.copilot/session-state/<sessionId>/)
 *   4. Removes local session store archives (~/.copilot/session-store/<sessionId>.tar.gz + .meta.json)
 *   5. Drops duroxide + copilot_sessions database schemas
 *
 * Usage:
 *   node --env-file=../../.env examples/devops-command-center/scripts/cleanup-local-db.js
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";

const { Client } = pg;

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

// ── 1. Collect session IDs from CMS ─────────────────────────

const url = new URL(connectionString);
const ssl = ["require", "prefer", "verify-ca", "verify-full"].includes(url.searchParams.get("sslmode") ?? "");
url.searchParams.delete("sslmode");

const client = new Client({
    connectionString: url.toString(),
    ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
});

let sessionIds = [];
try {
    await client.connect();
    const { rows } = await client.query("SELECT session_id FROM copilot_sessions.sessions");
    sessionIds = rows.map((r) => r.session_id);
    console.log(`Found ${sessionIds.length} CMS session(s).`);
} catch {
    console.log("No CMS sessions found (schema may not exist yet).");
}

// ── 2. Remove local artifact dirs ───────────────────────────

let artifactsDeleted = 0;
for (const sid of sessionIds) {
    const dir = path.join(ARTIFACT_DIR, sid);
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        artifactsDeleted++;
    }
}
console.log(`Deleted ${artifactsDeleted} local artifact dir(s).`);

// ── 3. Remove local session state dirs ──────────────────────

let stateDeleted = 0;
for (const sid of sessionIds) {
    const dir = path.join(SESSION_STATE_DIR, sid);
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        stateDeleted++;
    }
}
console.log(`Deleted ${stateDeleted} local session state dir(s).`);

// ── 4. Remove local session store archives ──────────────────

let storeDeleted = 0;
for (const sid of sessionIds) {
    for (const ext of [".tar.gz", ".meta.json"]) {
        const file = path.join(SESSION_STORE_DIR, `${sid}${ext}`);
        if (fs.existsSync(file)) {
            fs.unlinkSync(file);
            storeDeleted++;
        }
    }
}
console.log(`Deleted ${storeDeleted} local session store file(s).`);

// ── 5. Drop database schemas ────────────────────────────────

try {
    await client.query("DROP SCHEMA IF EXISTS duroxide CASCADE");
    console.log("Dropped schema: duroxide");
    await client.query("DROP SCHEMA IF EXISTS copilot_sessions CASCADE");
    console.log("Dropped schema: copilot_sessions");
} finally {
    await client.end().catch(() => {});
}

console.log("\nDone. Schemas will be recreated on next start.");
