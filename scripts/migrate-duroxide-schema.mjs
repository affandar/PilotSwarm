#!/usr/bin/env node

/**
 * Rename a legacy PilotSwarm-owned duroxide schema to ps_duroxide.
 *
 * Usage:
 *   npm run build --workspace pilotswarm-sdk
 *   node --env-file=.env scripts/migrate-duroxide-schema.mjs --install-guard
 *
 * Env:
 *   DATABASE_URL                         PostgreSQL connection string
 *   DUROXIDE_LEGACY_SCHEMA               default: duroxide
 *   PILOTSWARM_DUROXIDE_SCHEMA           default: ps_duroxide
 *   PILOTSWARM_DUROXIDE_GUARD_ROLE       runtime DB role blocked from recreating legacy schema
 */

import pg from "pg";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const sdkDist = resolve("packages/sdk/dist/index.js");
if (!existsSync(sdkDist)) {
    console.error("ERROR: packages/sdk/dist/index.js not found. Run: npm run build --workspace pilotswarm-sdk");
    process.exit(1);
}

const { migrateLegacyDuroxideSchema } = await import(`../packages/sdk/dist/index.js`);

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.error("ERROR: DATABASE_URL is required.");
    process.exit(1);
}

const installGuard = process.argv.includes("--install-guard");
const requireGuard = process.argv.includes("--require-guard");
const legacySchema = process.env.DUROXIDE_LEGACY_SCHEMA || "duroxide";
const targetSchema = process.env.PILOTSWARM_DUROXIDE_SCHEMA || "ps_duroxide";
const blockedRole = process.env.PILOTSWARM_DUROXIDE_GUARD_ROLE || undefined;

if (installGuard && !blockedRole) {
    console.error("ERROR: --install-guard requires PILOTSWARM_DUROXIDE_GUARD_ROLE to name the PilotSwarm runtime DB role to block.");
    process.exit(1);
}

const parsedUrl = new URL(DATABASE_URL);
const needsSsl = ["require", "prefer", "verify-ca", "verify-full"]
    .includes(parsedUrl.searchParams.get("sslmode") ?? "");
parsedUrl.searchParams.delete("sslmode");

const pool = new pg.Pool({
    connectionString: parsedUrl.toString(),
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
    max: 1,
});

try {
    const result = await migrateLegacyDuroxideSchema(pool, {
        legacySchema,
        targetSchema,
        installCreateSchemaGuard: installGuard,
        requireCreateSchemaGuard: requireGuard,
        blockedRole,
    });
    console.log(JSON.stringify(result, null, 2));
    if (installGuard && !result.guardInstalled && result.guardError) {
        console.warn(`WARNING: schema rename result is valid, but guard installation failed: ${result.guardError}`);
    }
} finally {
    await pool.end();
}
