import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/pilotswarm";
const HORIZON_DATABASE_URL = process.env.HORIZON_DATABASE_URL || "";
const TEST_SCHEMA_PREFIX = "ps_test";
const HORIZON_FACTS_TEST_SCHEMA_PREFIX = `${TEST_SCHEMA_PREFIX}_facts`;
const TEST_TEMP_PREFIX = "pilotswarm-test-";
const TRANSIENT_DB_ERROR = /ECONNRESET|ENOTCONN|EPIPE|ETIMEDOUT|Connection terminated|terminating connection|server closed the connection|connection to server|read ECONN|EADDRNOTAVAIL|ECONNABORTED|ENOTFOUND|EAI_AGAIN|getaddrinfo/i;
const TRANSIENT_PG_CODE = new Set(["08006", "08003", "08000", "08001", "08004", "57P01", "57P02", "57P03"]);

function normalizeHorizonDbUrl(raw) {
    if (!raw) return raw;
    if (!/[?&]sslmode=/i.test(raw)) return raw;
    if (/[?&]uselibpqcompat=/i.test(raw)) return raw;
    return raw + (raw.includes("?") ? "&" : "?") + "uselibpqcompat=true";
}

function cleanupTempLayouts() {
    const tmpRoot = tmpdir();
    const entries = readdirSync(tmpRoot, { withFileTypes: true })
        .filter((entry) => entry.name.startsWith(TEST_TEMP_PREFIX))
        .map((entry) => join(tmpRoot, entry.name));

    if (entries.length === 0) {
        console.log("No matching test temp dirs found.");
        return;
    }

    console.log(`Removing ${entries.length} test temp dir(s)...`);
    for (const dir of entries) {
        console.log(`  rm -rf ${dir}`);
        rmSync(dir, { recursive: true, force: true });
    }
}

async function main() {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    let hadMatchingSchemas = false;

    try {
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
            console.log(`Dropping ${result.rows.length} test schema(s)...`);
            for (const row of result.rows) {
                console.log(`  DROP SCHEMA ${row.schema_name}`);
                await client.query(`DROP SCHEMA IF EXISTS "${row.schema_name}" CASCADE`);
            }
        }
    } finally {
        await client.end();
    }

    if (!hadMatchingSchemas) {
        console.log("No matching test schemas found.");
    }
    await cleanupHorizonTestSchemas();
    cleanupTempLayouts();
}

async function cleanupHorizonTestSchemas() {
    if (!HORIZON_DATABASE_URL || HORIZON_DATABASE_URL === DATABASE_URL) return;

    await withTransientRetry("HorizonDB test schema cleanup", cleanupHorizonTestSchemasOnce);
}

async function cleanupHorizonTestSchemasOnce() {
    const client = new pg.Client({ connectionString: normalizeHorizonDbUrl(HORIZON_DATABASE_URL) });
    await client.connect();
    try {
        const result = await client.query(
            `
                SELECT schema_name
                FROM information_schema.schemata
                WHERE schema_name LIKE $1
                ORDER BY schema_name
            `,
            [`${HORIZON_FACTS_TEST_SCHEMA_PREFIX}_%`],
        );

        if (result.rows.length === 0) {
            console.log("No matching HorizonDB test facts schemas found.");
            return;
        }

        console.log(`Dropping ${result.rows.length} HorizonDB test facts schema(s)...`);
        await cancelHorizonEmbedLoops(client, result.rows.map((row) => row.schema_name));
        for (const row of result.rows) {
            console.log(`  DROP HORIZON SCHEMA ${row.schema_name}`);
            await client.query(`DROP SCHEMA IF EXISTS "${row.schema_name}" CASCADE`);
        }
    } finally {
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

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
