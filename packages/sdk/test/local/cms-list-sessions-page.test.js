/**
 * Management client bounded session paging tests.
 */

import { describe, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createManagementClient } from "../helpers/local-workers.js";
import { assert, assertEqual, assertNotNull } from "../helpers/assertions.js";
import { PgSessionCatalogProvider } from "../../src/index.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

describe("Management session paging", () => {
    it("returns bounded pages with hasMore and cursor metadata", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        let mgmt = null;

        try {
            await catalog.initialize();

            for (const suffix of ["001", "002", "003", "004", "005"]) {
                const sessionId = `mgmt-page-${Date.now()}-${suffix}`;
                await catalog.createSession(sessionId, { model: "gpt-5.4" });
                await catalog.updateSession(sessionId, { state: "running" });
            }

            mgmt = await createManagementClient(env);

            const firstPage = await mgmt.listSessionsPage({ limit: 2 });
            assertEqual(firstPage.sessions.length, 2, "First page should contain requested page size");
            assertEqual(firstPage.hasMore, true, "First page should report more rows");
            assertNotNull(firstPage.nextCursor, "First page should include nextCursor");
            assert(typeof firstPage.nextCursor.updatedAt === "number", "Cursor updatedAt should be numeric");
            assert(typeof firstPage.nextCursor.sessionId === "string", "Cursor sessionId should be a string");

            const secondPage = await mgmt.listSessionsPage({ limit: 2, cursor: firstPage.nextCursor });
            assertEqual(secondPage.sessions.length, 2, "Second page should contain requested page size");

            const seen = new Set([...firstPage.sessions, ...secondPage.sessions].map((s) => s.sessionId));
            assertEqual(seen.size, 4, "Paged management reads should not repeat sessions");

            const broadList = await mgmt.listSessions();
            assert(
                broadList.length >= 5,
                "Existing listSessions should remain available for compatibility",
            );
        } finally {
            if (mgmt) await mgmt.stop();
            await catalog.close();
        }
    }, TIMEOUT);
});
