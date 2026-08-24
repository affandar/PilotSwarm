import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/pilotswarm";
const HORIZON_DATABASE_URL = process.env.HORIZON_DATABASE_URL || "";
const TEST_SCHEMA_PREFIX = "ps_test";
const HORIZON_FACTS_TEST_SCHEMA_PREFIX = `${TEST_SCHEMA_PREFIX}_facts`;
const TEST_TEMP_PREFIX = "pilotswarm-test-";
const CLEANUP_LOCK_KEY = 0x50_53_54_43; // "PSTC"
export const ACTIVE_TEST_LAYOUT_MAX_AGE_MS = Number(
    process.env.PS_TEST_ACTIVE_LAYOUT_MAX_AGE_MS || 6 * 60 * 60 * 1000,
);
const TRANSIENT_DB_ERROR = /ECONNRESET|ENOTCONN|EPIPE|ETIMEDOUT|Connection terminated|terminating connection|server closed the connection|connection to server|read ECONN|EADDRNOTAVAIL|ECONNABORTED|ENOTFOUND|EAI_AGAIN|getaddrinfo/i;
const TRANSIENT_PG_CODE = new Set(["08006", "08003", "08000", "08001", "08004", "57P01", "57P02", "57P03"]);

function normalizeHorizonDbUrl(raw) {
    if (!raw) return raw;
    if (!/[?&]sslmode=/i.test(raw)) return raw;
    if (/[?&]uselibpqcompat=/i.test(raw)) return raw;
    return raw + (raw.includes("?") ? "&" : "?") + "uselibpqcompat=true";
}

export function testRunIdFromTempName(name) {
    return new RegExp(`^${TEST_TEMP_PREFIX}([0-9a-f]{8})-`, "i").exec(String(name || ""))?.[1]?.toLowerCase() ?? null;
}

export function testRunIdFromSchemaName(name) {
    return /_([0-9a-f]{8})$/i.exec(String(name || ""))?.[1]?.toLowerCase() ?? null;
}

export function shouldPreserveTestSchema(schemaName, activeRunIds) {
    const runId = testRunIdFromSchemaName(schemaName);
    return runId !== null && activeRunIds.has(runId);
}

function discoverTempLayouts() {
    const tmpRoot = tmpdir();
    return readdirSync(tmpRoot, { withFileTypes: true })
        .filter((entry) => entry.name.startsWith(TEST_TEMP_PREFIX))
        .map((entry) => {
            const path = join(tmpRoot, entry.name);
            let mtimeMs = 0;
            try { mtimeMs = statSync(path).mtimeMs; } catch {}
            return { path, name: entry.name, runId: testRunIdFromTempName(entry.name), mtimeMs };
        });
}

export function activeTestRunIds(layouts, nowMs = Date.now(), maxAgeMs = ACTIVE_TEST_LAYOUT_MAX_AGE_MS) {
    return new Set(layouts
        .filter((layout) => layout.runId && nowMs - layout.mtimeMs <= maxAgeMs)
        .map((layout) => layout.runId));
}

function cleanupTempLayouts(layouts, activeRunIds) {
    const stale = layouts.filter((layout) => !layout.runId || !activeRunIds.has(layout.runId));
    const active = layouts.length - stale.length;

    if (stale.length === 0) {
        console.log("No matching test temp dirs found.");
        if (active > 0) console.log(`Preserving ${active} active test temp dir(s).`);
        return;
    }

    console.log(`Removing ${stale.length} stale test temp dir(s)...`);
    for (const layout of stale) {
        console.log(`  rm -rf ${layout.path}`);
        rmSync(layout.path, { recursive: true, force: true });
    }
    if (active > 0) console.log(`Preserving ${active} active test temp dir(s).`);
}

async function main() {
    const layouts = discoverTempLayouts();
    const activeRunIds = activeTestRunIds(layouts);
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    let hadMatchingSchemas = false;

    try {
        await client.query("SELECT pg_advisory_lock($1)", [CLEANUP_LOCK_KEY]);
        const result = await client.query(
            `
                SELECT schema_name
                FROM information_schema.schemata
                WHERE schema_name LIKE $1
                ORDER BY schema_name
            `,
            [`${TEST_SCHEMA_PREFIX}_%`],
        );

        if (result.rows.length > 0) {
            hadMatchingSchemas = true;
            const staleRows = result.rows.filter((row) => !shouldPreserveTestSchema(row.schema_name, activeRunIds));
            const activeCount = result.rows.length - staleRows.length;
            if (staleRows.length > 0) console.log(`Dropping ${staleRows.length} stale test schema(s)...`);
            for (const row of staleRows) {
                console.log(`  DROP SCHEMA ${row.schema_name}`);
                await client.query(`DROP SCHEMA IF EXISTS "${row.schema_name}" CASCADE`);
            }
            if (activeCount > 0) console.log(`Preserving ${activeCount} active test schema(s).`);
        }
    } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [CLEANUP_LOCK_KEY]).catch(() => {});
        await client.end();
    }

    if (!hadMatchingSchemas) {
        console.log("No matching test schemas found.");
    }
    await cleanupHorizonTestSchemas(activeRunIds);
    cleanupTempLayouts(layouts, activeRunIds);
}

async function cleanupHorizonTestSchemas(activeRunIds) {
    if (!HORIZON_DATABASE_URL || HORIZON_DATABASE_URL === DATABASE_URL) return;

    await withTransientRetry("HorizonDB test schema cleanup", () => cleanupHorizonTestSchemasOnce(activeRunIds));
}

async function cleanupHorizonTestSchemasOnce(activeRunIds) {
    const client = new pg.Client({ connectionString: normalizeHorizonDbUrl(HORIZON_DATABASE_URL) });
    await client.connect();
    try {
        await client.query("SELECT pg_advisory_lock($1)", [CLEANUP_LOCK_KEY]);
        const result = await client.query(
            `
                SELECT schema_name
                FROM information_schema.schemata
                WHERE schema_name LIKE $1
                ORDER BY schema_name
            `,
            [`${HORIZON_FACTS_TEST_SCHEMA_PREFIX}_%`],
        );

        const staleRows = result.rows.filter((row) => !shouldPreserveTestSchema(row.schema_name, activeRunIds));
        const activeCount = result.rows.length - staleRows.length;
        if (staleRows.length === 0) {
            console.log("No matching HorizonDB test facts schemas found.");
            if (activeCount > 0) console.log(`Preserving ${activeCount} active HorizonDB test facts schema(s).`);
            return;
        }

        console.log(`Dropping ${staleRows.length} stale HorizonDB test facts schema(s)...`);
        await cancelHorizonEmbedLoops(client, staleRows.map((row) => row.schema_name));
        for (const row of staleRows) {
            console.log(`  DROP HORIZON SCHEMA ${row.schema_name}`);
            await client.query(`DROP SCHEMA IF EXISTS "${row.schema_name}" CASCADE`);
        }
        if (activeCount > 0) console.log(`Preserving ${activeCount} active HorizonDB test facts schema(s).`);
    } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [CLEANUP_LOCK_KEY]).catch(() => {});
        await client.end();
    }
}

function isTransientDbError(err) {
    if (err?.code && TRANSIENT_PG_CODE.has(String(err.code))) return true;
    return TRANSIENT_DB_ERROR.test(`${err?.code ?? ""} ${err?.message ?? ""}`);
}

async function withTransientRetry(label, fn, tries = 4) {
    let lastErr;
    for (let attempt = 1; attempt <= tries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (!isTransientDbError(err) || attempt === tries) throw err;
            console.warn(`  ⚠️  ${label} transient failure (${attempt}/${tries - 1}): ${err.message}`);
            await new Promise((resolve) => setTimeout(resolve, Math.min(200 * 2 ** (attempt - 1), 2000)));
        }
    }
    throw lastErr;
}

async function cancelHorizonEmbedLoops(client, schemas) {
    if (schemas.length === 0) return;
    const labels = schemas.flatMap((schema) => [
        `hz-embed-cron:${schema}`,
        `hz-embed-batch-cron:${schema}`,
        `hz-embed-retry-cron:${schema}`,
    ]);
    try {
        const result = await client.query(
            `SELECT id, label
               FROM df.instances
              WHERE label = ANY($1::text[])
                AND status IN ('pending', 'running')
              ORDER BY created_at DESC`,
            [labels],
        );
        if (result.rows.length === 0) return;
        console.log(`  Cancelling ${result.rows.length} HorizonDB test embedder loop(s)...`);
        for (const row of result.rows) {
            console.log(`    df.cancel ${row.label}`);
            await client.query(`SELECT df.cancel($1, $2)`, [row.id, "test cleanup"]);
        }
    } catch (err) {
        console.warn(`  ⚠️  HorizonDB embedder cleanup warning: ${err.message}`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
