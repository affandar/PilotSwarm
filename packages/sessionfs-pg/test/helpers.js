/**
 * Test helpers — random schema names + automatic teardown.
 *
 * Each test gets a unique `copilot_sessions_fsstore_test_<rand>` schema so
 * suites can run in parallel against the same Postgres instance without
 * interfering. The schema is dropped in afterAll regardless of pass/fail.
 */
import { randomBytes } from "node:crypto";
import { PgSessionFsStore } from "../src/index.js";

function requireEnv(name) {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is required (not set in .env)`);
    return v;
}

export function randomSchemaName(prefix = "copilot_sessions_fsstore_test") {
    return `${prefix}_${randomBytes(6).toString("hex")}`;
}

export async function makeStore() {
    const connectionString = requireEnv("DATABASE_URL");
    const schema = randomSchemaName();
    const store = new PgSessionFsStore({ connectionString, schema });
    await store.initialize();

    const cleanup = async () => {
        try { await store.dropSchema(); } catch { /* swallow */ }
        try { await store.close(); } catch { /* swallow */ }
    };

    return { store, schema, cleanup };
}
