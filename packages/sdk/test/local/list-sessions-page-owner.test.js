/**
 * Migration 0028 — paged session listing carries the owner.
 *
 * DB-only (no workers, no LLM): creates a throwaway schema, runs the full
 * migration chain through PgSessionCatalog.initialize(), persists an owned
 * session, and asserts the KEYSET-PAGED list — the path the web portal
 * always uses — returns the owner. Before 0028, cms_list_sessions_page
 * returned SETOF sessions (no owner columns), so paged rows carried
 * owner: null and the portal rendered "?" initials for every session.
 *
 * Run: node --env-file=../../.env ../../node_modules/vitest/vitest.mjs run test/local/list-sessions-page-owner.test.js
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { PgSessionCatalog } from "../../dist/cms.js";

const DATABASE_URL = process.env.DATABASE_URL;
const SCHEMA = `t0028_${Date.now().toString(36)}`;

const OWNER = {
    provider: "entra",
    subject: "test-subject-0028",
    email: "owner0028@example.test",
    displayName: "Paged Owner",
};

describe.skipIf(!DATABASE_URL)("cms_list_sessions_page owner join (0028)", () => {
    let catalog;

    beforeAll(async () => {
        catalog = await PgSessionCatalog.create(DATABASE_URL, SCHEMA);
        await catalog.initialize(); // runs the full migration chain incl. 0028
    });

    afterAll(async () => {
        // Hermetic: drop the throwaway schema, then close.
        try {
            const { default: pg } = await import("pg");
            const p = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
            await p.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
            await p.end();
        } finally {
            await catalog?.close?.();
        }
    });

    it("paged rows carry the persisted owner", async () => {
        const sessionId = `sess-0028-${Date.now()}`;
        await catalog.createSession(sessionId, {
            model: "test-model",
            splash: "{cyan-fg}desktop{/cyan-fg}",
            splashMobile: "{cyan-fg}mobile{/cyan-fg}",
            owner: OWNER,
        });

        const page = await catalog.listSessionsPage({ limit: 10 });
        const row = page.find((r) => r.sessionId === sessionId);
        expect(row, "created session must appear in the paged list").toBeTruthy();
        expect(row.owner, "paged row must carry the owner (0028)").toBeTruthy();
        expect(row.owner.provider).toBe(OWNER.provider);
        expect(row.owner.subject).toBe(OWNER.subject);
        expect(row.owner.email).toBe(OWNER.email);
        expect(row.owner.displayName).toBe(OWNER.displayName);
        // 0026/0028 wire order: splash_mobile rides along on the paged path too.
        expect(row.splashMobile).toBe("{cyan-fg}mobile{/cyan-fg}");
    });

    it("paged list and full list agree on the owner for the same session", async () => {
        const sessionId = `sess-0028b-${Date.now()}`;
        await catalog.createSession(sessionId, { model: "test-model", owner: OWNER });

        const [paged, full] = await Promise.all([
            catalog.listSessionsPage({ limit: 10 }),
            catalog.listSessions(),
        ]);
        const pagedRow = paged.find((r) => r.sessionId === sessionId);
        const fullRow = full.find((r) => r.sessionId === sessionId);
        expect(pagedRow?.owner).toEqual(fullRow?.owner);
    });
});
