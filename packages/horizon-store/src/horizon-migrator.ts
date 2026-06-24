// pilotswarm-horizon-store — vendored migration runner.
//
// VENDORED from packages/sdk/src/pg-migrator.ts (advisory-locked, versioned,
// one transaction per migration). TODO(graduation): merge back into
// pg-migrator.ts when this package moves into packages/* — do not let the two
// copies drift.
//
// The loader half is horizon-specific: it reads the numbered migrations/*.sql
// files that ship with the package and substitutes the deployment tokens
// ({{SCHEMA}}, {{GRAPH_NAME}}, {{EMBEDDING_DIM}}) before handing them to the
// runner. All DDL lives in those files — none in TypeScript (04 §6 M1 guard).

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface MigrationEntry {
    version: string;
    name: string;
    sql: string;
}

/** Seed for the advisory lock — distinct from the SDK CMS/facts seeds. */
export const HORIZON_FACTS_LOCK_SEED = 0x48_5a_46; // "HZF"

/**
 * Migration versions OWNED BY THE GRAPH PROVIDER (HorizonDBGraphStore), not the
 * facts provider. The facts store filters these out of its run set; the graph
 * store runs them inline as part of its idempotent bootstrap.
 *   0003 — AGE extension + create_graph (the graph bootstrap).
 *   0013 — graph_namespaces registry sidecar (graph-fact-search enhancements).
 */
export const GRAPH_OWNED_MIGRATIONS = ["0003", "0013"] as const;
export const HORIZON_GLOBAL_DDL_LOCK_LABEL = "__horizon_facts_global_ddl__";
export const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 60_000;

const GLOBAL_DDL_SQL = /\bCREATE\s+EXTENSION\b|\bag_catalog\.create_graph\b/i;

/** Whether a migration version is graph-owned (run by the graph store, not facts). */
export function isGraphOwnedMigration(version: string): boolean {
    return (GRAPH_OWNED_MIGRATIONS as readonly string[]).includes(version);
}

/** Whether a migration contains database-global DDL that needs global serialization. */
export function migrationRequiresGlobalDdlLock(migration: Pick<MigrationEntry, "sql">): boolean {
    return GLOBAL_DDL_SQL.test(migration.sql);
}

/**
 * Run all pending migrations against the given schema.
 *
 * Uses a PostgreSQL advisory lock keyed on `lockSeed` + schema name to
 * serialize concurrent workers. Each migration runs in its own transaction.
 * Throws (never "repairs") when the migrations table records a version the
 * code does not know — a newer deployment owns this schema.
 */
export async function runMigrations(
    pool: any,
    schema: string,
    migrations: MigrationEntry[],
    lockSeed: number,
): Promise<void> {
    const lockKey = hashSchemaName(schema, lockSeed);
    const globalDdlLockKey = hashSchemaName(HORIZON_GLOBAL_DDL_LOCK_LABEL, lockSeed);
    const client = await pool.connect();
    let schemaLockHeld = false;
    try {
        // Serialize concurrent initializers for the same schema, but keep other
        // schemas moving. The database-global DDL lock is acquired only inside
        // the specific migration transactions that need it.
        await acquireSessionAdvisoryLock(client, lockKey, `horizon schema migration for ${schema}`);
        schemaLockHeld = true;

        await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

        const migrationsTable = `"${schema}".schema_migrations`;
        await client.query(`
            CREATE TABLE IF NOT EXISTS ${migrationsTable} (
                version     TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);

        const { rows: applied } = await client.query(
            `SELECT version FROM ${migrationsTable} ORDER BY version`,
        );
        const appliedSet = new Set(applied.map((r: any) => r.version));
        const knownSet = new Set(migrations.map((m) => m.version));
        const unknown = [...appliedSet].filter((v) => !knownSet.has(v as string));
        if (unknown.length > 0) {
            throw new Error(
                `horizon-facts migrations: schema "${schema}" records versions this build does not know ` +
                `(${unknown.join(", ")}). A newer deployment owns this schema; refusing to continue.`,
            );
        }

        for (const migration of migrations) {
            if (appliedSet.has(migration.version)) continue;

            for (let attempt = 1; attempt <= 5; attempt++) {
                try {
                    await client.query("BEGIN");
                    if (migrationRequiresGlobalDdlLock(migration)) {
                        await acquireTransactionAdvisoryLock(
                            client,
                            globalDdlLockKey,
                            `horizon global DDL migration ${migration.version} (${migration.name})`,
                        );
                    }
                    await client.query(migration.sql);
                    await client.query(
                        `INSERT INTO ${migrationsTable} (version, name) VALUES ($1, $2)`,
                        [migration.version, migration.name],
                    );
                    await client.query("COMMIT");
                    break;
                } catch (err) {
                    await client.query("ROLLBACK").catch(() => {});
                    if (!isRetryableMigrationRace(err) || attempt === 5) throw err;
                    await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
                }
            }
        }
    } finally {
        if (schemaLockHeld) await client.query("SELECT pg_advisory_unlock($1)", [lockKey]).catch(() => {});
        client.release();
    }
}

function migrationLockTimeoutMs(): number {
    const raw = process.env.HORIZON_MIGRATION_LOCK_TIMEOUT_MS;
    if (raw == null || raw === "") return DEFAULT_MIGRATION_LOCK_TIMEOUT_MS;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`HORIZON_MIGRATION_LOCK_TIMEOUT_MS must be a non-negative number, got ${JSON.stringify(raw)}`);
    }
    return Math.trunc(value);
}

async function acquireSessionAdvisoryLock(client: any, key: number, label: string): Promise<void> {
    await acquireAdvisoryLock(client, key, label, "pg_try_advisory_lock");
}

async function acquireTransactionAdvisoryLock(client: any, key: number, label: string): Promise<void> {
    await acquireAdvisoryLock(client, key, label, "pg_try_advisory_xact_lock");
}

async function acquireAdvisoryLock(
    client: any,
    key: number,
    label: string,
    fnName: "pg_try_advisory_lock" | "pg_try_advisory_xact_lock",
): Promise<void> {
    const timeoutMs = migrationLockTimeoutMs();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const { rows } = await client.query(`SELECT ${fnName}($1) AS locked`, [key]);
        if (rows[0]?.locked === true) return;
        if (Date.now() >= deadline) {
            throw new Error(await advisoryLockTimeoutMessage(client, key, label, timeoutMs));
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}

async function advisoryLockTimeoutMessage(client: any, key: number, label: string, timeoutMs: number): Promise<string> {
    try {
        const { classid, objid } = advisoryLockKeyParts(key);
        const { rows } = await client.query(
            `SELECT a.pid,
                    a.state,
                    a.wait_event_type,
                    a.wait_event,
                    now() - a.query_start AS age,
                    left(a.query, 160) AS query
               FROM pg_locks l
               LEFT JOIN pg_stat_activity a ON a.pid = l.pid
              WHERE l.locktype = 'advisory'
                AND l.granted
                AND l.classid::bigint = $1
                AND l.objid::bigint = $2
              ORDER BY a.query_start NULLS LAST
              LIMIT 5`,
            [String(classid), String(objid)],
        );
        const holders = rows.length > 0
            ? rows.map((row: any) => `pid=${row.pid} state=${row.state ?? "unknown"} wait=${row.wait_event_type ?? ""}/${row.wait_event ?? ""} query=${JSON.stringify(row.query ?? "")}`).join("; ")
            : "no granted holder found";
        return `${label} could not acquire advisory lock ${key} within ${timeoutMs}ms; holders: ${holders}`;
    } catch (err: any) {
        return `${label} could not acquire advisory lock ${key} within ${timeoutMs}ms; holder lookup failed: ${err?.message ?? err}`;
    }
}

export function advisoryLockKeyParts(key: number): { classid: string; objid: string } {
    const unsigned = BigInt.asUintN(64, BigInt(Math.trunc(key)));
    return {
        classid: String((unsigned >> 32n) & 0xffff_ffffn),
        objid: String(unsigned & 0xffff_ffffn),
    };
}

// Concurrent first-time creation of the same global object (extension, AGE
// graph schema, catalog row) surfaces as one of these races. The losing tx
// rolled back and committed nothing, and the object now exists, so re-running
// the same idempotent migration statement succeeds.
function isRetryableMigrationRace(err: any): boolean {
    const text = `${err?.code ?? ""} ${err?.message ?? ""} ${err?.detail ?? ""}`;
    return /tuple concurrently updated|deadlock detected|could not serialize access|already exists/i.test(text);
}

/** Stable 32-bit hash of a schema name combined with a per-system seed. */
export function hashSchemaName(schema: string, seed: number): number {
    let hash = seed;
    for (let i = 0; i < schema.length; i++) {
        hash = ((hash << 5) - hash + schema.charCodeAt(i)) | 0;
    }
    return hash;
}

// ─── Horizon-specific loader ─────────────────────────────────────────────────

export interface MigrationTokens {
    schema: string;
    graphName: string;
    embeddingDim: number;
    /** Graph-owned schema for the namespace registry sidecar (0013).
     * Defaults to `${graphName}_registry`. */
    registrySchema?: string;
}

const MIGRATION_FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** Resolve the packaged migrations/ directory (works from src/ and dist/src/). */
export function migrationsDir(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // src/ → ../migrations ; dist/src/ → ../../migrations
    for (const rel of ["../migrations", "../../migrations"]) {
        const dir = path.resolve(here, rel);
        try {
            readdirSync(dir);
            return dir;
        } catch { /* try next */ }
    }
    throw new Error(`horizon-facts: cannot locate migrations/ relative to ${here}`);
}

/** Load the numbered migrations, token-substituted for this deployment. */
export function loadMigrations(tokens: MigrationTokens): MigrationEntry[] {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokens.schema)) {
        throw new Error(`unsafe schema name: ${JSON.stringify(tokens.schema)}`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokens.graphName)) {
        throw new Error(`unsafe graph name: ${JSON.stringify(tokens.graphName)}`);
    }
    const registrySchema = tokens.registrySchema ?? `${tokens.graphName}_registry`;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(registrySchema)) {
        throw new Error(`unsafe registry schema name: ${JSON.stringify(registrySchema)}`);
    }
    const dim = Math.trunc(tokens.embeddingDim);
    if (!Number.isFinite(dim) || dim < 1) {
        throw new Error(`embeddingDim must be a positive integer, got ${tokens.embeddingDim}`);
    }

    const dir = migrationsDir();
    const files = readdirSync(dir).filter((f) => MIGRATION_FILE.test(f)).sort();
    if (files.length === 0) throw new Error(`horizon-facts: no migrations found in ${dir}`);

    let last = 0;
    return files.map((f) => {
        const m = MIGRATION_FILE.exec(f)!;
        const num = Number(m[1]);
        if (num !== last + 1) {
            throw new Error(`horizon-facts migrations: non-contiguous numbering at ${f} (expected ${String(last + 1).padStart(4, "0")})`);
        }
        last = num;
        const raw = readFileSync(path.join(dir, f), "utf8");
        const sql = raw
            .replaceAll("{{SCHEMA}}", tokens.schema)
            .replaceAll("{{GRAPH_NAME}}", tokens.graphName)
            .replaceAll("{{REGISTRY_SCHEMA}}", registrySchema)
            .replaceAll("{{EMBEDDING_DIM}}", String(dim));
        return { version: m[1], name: m[2], sql };
    });
}
