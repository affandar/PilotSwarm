import { describe, expect, it } from "vitest";
import { runMigrations } from "../../src/pg-migrator.ts";

function createMockPool(appliedVersions = []) {
    const queries = [];
    let released = false;

    const client = {
        async query(sql, params) {
            queries.push({ sql, params });

            if (typeof sql === "string" && sql.includes("SELECT version FROM")) {
                return { rows: appliedVersions.map(version => ({ version })) };
            }

            return { rows: [] };
        },
        release() {
            released = true;
        },
    };

    return {
        pool: {
            async connect() {
                return client;
            },
        },
        queries,
        wasReleased() {
            return released;
        },
    };
}

function normalizeSql(sql) {
    return String(sql).replace(/\s+/g, " ").trim();
}

describe("pg-migrator", () => {
    it("runs non-transactional statements separately without BEGIN/COMMIT", async () => {
        const { pool, queries, wasReleased } = createMockPool();
        const statements = [
            "CREATE INDEX CONCURRENTLY idx_one ON foo(id);",
            "CREATE INDEX CONCURRENTLY idx_two ON foo(created_at);",
        ];

        await runMigrations(
            pool,
            "copilot_sessions",
            [
                {
                    version: "0008",
                    name: "query_indexes",
                    sql: statements.join("\n"),
                    statements,
                    transactional: false,
                },
            ],
            123,
        );

        const sqls = queries.map(entry => normalizeSql(entry.sql));

        expect(sqls).toContain(normalizeSql(statements[0]));
        expect(sqls).toContain(normalizeSql(statements[1]));
        expect(sqls).not.toContain("BEGIN");
        expect(sqls).not.toContain("COMMIT");
        expect(sqls).toContain(
            'INSERT INTO "copilot_sessions".schema_migrations (version, name) VALUES ($1, $2)',
        );
        expect(wasReleased()).toBe(true);
    });

    it("runs statement arrays transactionally when a migration stays transactional", async () => {
        const { pool, queries } = createMockPool();
        const statements = [
            "ALTER TABLE foo ADD COLUMN bar TEXT;",
            "UPDATE foo SET bar = 'ready';",
        ];

        await runMigrations(
            pool,
            "copilot_sessions",
            [
                {
                    version: "0009",
                    name: "transactional_statements",
                    sql: statements.join("\n"),
                    statements,
                },
            ],
            123,
        );

        const sqls = queries.map(entry => normalizeSql(entry.sql));
        const beginIndex = sqls.indexOf("BEGIN");
        const firstStatementIndex = sqls.indexOf(normalizeSql(statements[0]));
        const secondStatementIndex = sqls.indexOf(normalizeSql(statements[1]));
        const commitIndex = sqls.indexOf("COMMIT");

        expect(beginIndex).toBeGreaterThan(-1);
        expect(firstStatementIndex).toBeGreaterThan(beginIndex);
        expect(secondStatementIndex).toBeGreaterThan(firstStatementIndex);
        expect(commitIndex).toBeGreaterThan(secondStatementIndex);
    });
});
