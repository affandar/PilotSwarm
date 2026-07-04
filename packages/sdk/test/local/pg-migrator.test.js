/**
 * CMS migration application tests for bounded session reads.
 */

import { describe, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { PgSessionCatalogProvider } from "../../src/index.ts";

const TIMEOUT = 60_000;
const getEnv = useSuiteEnv(import.meta.url);

async function directQuery(env, sql, params = []) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: env.store });
    try {
        await client.connect();
        return await client.query(sql, params);
    } finally {
        try { await client.end(); } catch {}
    }
}

describe("CMS migrator — bounded session reads", () => {
    it("applies migration 0013 and creates bounded read functions", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);

        try {
            await catalog.initialize();

            const { rows: versions } = await directQuery(
                env,
                `SELECT version FROM "${env.cmsSchema}".schema_migrations ORDER BY version`,
            );
            const appliedVersions = versions.map((r) => r.version);
            assert(appliedVersions.includes("0013"), "Expected migration 0013 to be applied");

            // DISTINCT: information_schema.routines lists one row per overload,
            // and the event procs grew 4-arg type-filter overloads in 0025.
            const { rows: routines } = await directQuery(
                env,
                `SELECT DISTINCT routine_name
                 FROM information_schema.routines
                 WHERE routine_schema = $1
                   AND routine_name IN (
                     'cms_list_sessions_page',
                     'cms_get_top_event_emitters',
                     'cms_get_session_events',
                     'cms_get_session_events_before'
                   )
                 ORDER BY routine_name`,
                [env.cmsSchema],
            );

            const routineNames = routines.map((r) => r.routine_name);
            assertEqual(routineNames.length, 4, "Expected all bounded read routines to exist");
            assert(routineNames.includes("cms_list_sessions_page"), "Missing cms_list_sessions_page");
            assert(routineNames.includes("cms_get_top_event_emitters"), "Missing cms_get_top_event_emitters");
            assert(routineNames.includes("cms_get_session_events"), "Missing cms_get_session_events");
            assert(routineNames.includes("cms_get_session_events_before"), "Missing cms_get_session_events_before");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);
});
