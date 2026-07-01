/**
 * Level 7c: CMS — LLM-driven summary/title tool updates.
 *
 * Covers update_session_summary when the LLM is asked to update:
 *   - only the sticky title
 *   - only the live summary
 *   - both title and live summary
 *
 * Run: npx vitest run test/local/cms-summary-title.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { assert, assertEqual, assertNotNull } from "../helpers/assertions.js";
import { createCatalog, getSession } from "../helpers/cms-helpers.js";

const TIMEOUT = 180_000;

async function testLlmTitleOnlyUpdate(env) {
    const catalog = await createCatalog(env);
    try {
        await withClient(env, async (client) => {
            const session = await client.createSession();
            const title = `Title Only ${session.sessionId.slice(0, 8)}`;

            console.log(`  Asking LLM to set title only: "${title}"`);
            const response = await session.sendAndWait(
                `Use the update_session_summary tool exactly once to set this session title to "${title}". ` +
                `Do not pass summary_state. Do not pass short_summary. ` +
                `After the tool succeeds, reply exactly TITLE_ONLY_DONE.`,
                TIMEOUT,
            );
            console.log(`  Response: "${response}"`);

            const row = await getSession(catalog, session.sessionId);
            assertNotNull(row, "session row after title-only update");
            assertEqual(row.title, title, "title-only update should persist title");
            assertEqual(row.titleLocked, true, "title-only update should lock title");
            assertEqual(row.shortSummary, null, "title-only update should not write short summary");
            assertEqual(row.summaryState, null, "title-only update should not write summary state");
            assertEqual(row.summaryUpdatedAt, null, "title-only update should not bump summary timestamp");
        });
    } finally {
        await catalog.close();
    }
}

async function testLlmSummaryOnlyUpdate(env) {
    const catalog = await createCatalog(env);
    try {
        await withClient(env, async (client) => {
            const session = await client.createSession();
            const shortSummary = `Summary Only ${session.sessionId.slice(0, 8)}`;
            const fullSummary = `${shortSummary} complete`;

            console.log(`  Asking LLM to set summary only: "${shortSummary}"`);
            const response = await session.sendAndWait(
                `Use the update_session_summary tool exactly once to update only this session summary. ` +
                `Do not pass title. Set short_summary to "${shortSummary}". ` +
                `Set summary_state to an object with schemaVersion 1, intent "Summary-only integration test", ` +
                `summary "${fullSummary}", state {}, and empty arrays for openQuestions, blockers, nextActions, links, and structureChangeLog. ` +
                `After the tool succeeds, reply exactly SUMMARY_ONLY_DONE.`,
                TIMEOUT,
            );
            console.log(`  Response: "${response}"`);

            const row = await getSession(catalog, session.sessionId);
            assertNotNull(row, "session row after summary-only update");
            assertEqual(row.title, null, "summary-only update should not write title");
            assertEqual(row.titleLocked, false, "summary-only update should not lock title");
            assertEqual(row.shortSummary, shortSummary, "summary-only update should persist short summary");
            assertEqual(row.summaryState?.summary, fullSummary, "summary-only update should persist summary state");
            assert(row.summaryUpdatedAt instanceof Date, "summary-only update should bump summary timestamp");
        });
    } finally {
        await catalog.close();
    }
}

async function testLlmTitleAndSummaryUpdate(env) {
    const catalog = await createCatalog(env);
    try {
        await withClient(env, async (client) => {
            const session = await client.createSession();
            const title = `Combined Title ${session.sessionId.slice(0, 8)}`;
            const shortSummary = `Combined Summary ${session.sessionId.slice(0, 8)}`;
            const fullSummary = `${shortSummary} complete`;

            console.log(`  Asking LLM to set title and summary: "${title}" / "${shortSummary}"`);
            const response = await session.sendAndWait(
                `Use the update_session_summary tool exactly once to update both this session title and summary. ` +
                `Pass title "${title}" and short_summary "${shortSummary}". ` +
                `Set summary_state to an object with schemaVersion 1, intent "Combined title and summary integration test", ` +
                `summary "${fullSummary}", state {}, and empty arrays for openQuestions, blockers, nextActions, links, and structureChangeLog. ` +
                `After the tool succeeds, reply exactly TITLE_AND_SUMMARY_DONE.`,
                TIMEOUT,
            );
            console.log(`  Response: "${response}"`);

            const row = await getSession(catalog, session.sessionId);
            assertNotNull(row, "session row after combined update");
            assertEqual(row.title, title, "combined update should persist title");
            assertEqual(row.titleLocked, true, "combined update should lock title");
            assertEqual(row.shortSummary, shortSummary, "combined update should persist short summary");
            assertEqual(row.summaryState?.summary, fullSummary, "combined update should persist summary state");
            assert(row.summaryUpdatedAt instanceof Date, "combined update should bump summary timestamp");
        });
    } finally {
        await catalog.close();
    }
}

describe.concurrent("Level 7c: CMS — LLM Summary/Title Updates", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("LLM can update title without touching summary", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("cms-summary-title-title-only");
        try { await testLlmTitleOnlyUpdate(env); } finally { await env.cleanup(); }
    });

    it("LLM can update summary without touching title", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("cms-summary-title-summary-only");
        try { await testLlmSummaryOnlyUpdate(env); } finally { await env.cleanup(); }
    });

    it("LLM can update title and summary together", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("cms-summary-title-combined");
        try { await testLlmTitleAndSummaryUpdate(env); } finally { await env.cleanup(); }
    });
});
