import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/pilotswarm";
const TEST_SCHEMA_PREFIX = "ps_test";

async function main() {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();

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

        if (result.rows.length === 0) {
            console.log("No matching test schemas found.");
            return;
        }

        console.log(`Dropping ${result.rows.length} test schema(s)...`);
        for (const row of result.rows) {
            console.log(`  DROP SCHEMA ${row.schema_name}`);
            await client.query(`DROP SCHEMA IF EXISTS "${row.schema_name}" CASCADE`);
        }
    } finally {
        await client.end();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});