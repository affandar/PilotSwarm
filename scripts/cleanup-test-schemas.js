import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/pilotswarm";
const TEST_SCHEMA_PREFIX = "ps_test";
const TEST_TEMP_PREFIX = "pilotswarm-test-";

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
    cleanupTempLayouts();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
