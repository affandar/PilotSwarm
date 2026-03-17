/**
 * Level 7b: CMS consistency — session state tests.
 *
 * Covers: session state transitions, title update via management,
 * session iteration count, soft delete hides session.
 *
 * Run: npx vitest run test/local/cms-state.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks } from "../helpers/local-env.js";
import { withClient, createManagementClient } from "../helpers/local-workers.js";
import { assert, assertEqual, assertNotNull, assertGreaterOrEqual } from "../helpers/assertions.js";
import { createCatalog, getSession, validateSessionAfterTurn } from "../helpers/cms-helpers.js";
import { ONEWORD_CONFIG, BRIEF_CONFIG } from "../helpers/fixtures.js";

const TIMEOUT = 120_000;

async function testSessionStateTransitions(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(ONEWORD_CONFIG);

            let row = await getSession(catalog, session.sessionId);
            assertNotNull(row, "Session must exist");
            console.log(`  State before send: ${row.state}`);
            assertEqual(row.state, "pending", "Initial state");

            console.log("  Sending: What is 1+1?");
            await session.sendAndWait("What is 1+1?", TIMEOUT);

            row = await getSession(catalog, session.sessionId);
            console.log(`  State after first turn: ${row.state}`);
            assert(
                row.state === "idle" || row.state === "running" || row.state === "completed",
                `Expected idle/running/completed but got: ${row.state}`,
            );

            await validateSessionAfterTurn(env, session.sessionId, {
                expectedCmsStates: ["idle", "running", "completed"],
            });
        });
    } finally {
        await catalog.close();
    }
}

async function testTitleUpdate(env) {
    const catalog = await createCatalog(env);
    const { PilotSwarmManagementClient } = await import("../../dist/index.js");
    const mgmt = new PilotSwarmManagementClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
    });
    await mgmt.start();

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(BRIEF_CONFIG);

            console.log("  Sending: Tell me about quantum computing");
            await session.sendAndWait("Tell me about quantum computing", TIMEOUT);

            let row = await getSession(catalog, session.sessionId);
            console.log(`  Title before rename: "${row?.title}"`);

            await mgmt.renameSession(session.sessionId, "Quantum Computing Chat");

            row = await getSession(catalog, session.sessionId);
            console.log(`  Title after rename: "${row?.title}"`);
            assertEqual(row.title, "Quantum Computing Chat", "CMS title after rename");

            await validateSessionAfterTurn(env, session.sessionId);
        });
    } finally {
        await mgmt.stop();
        await catalog.close();
    }
}

async function testSessionIterationCount(env) {
    await withClient(env, async (client) => {
        const session = await client.createSession(ONEWORD_CONFIG);

        let info = await session.getInfo();
        assertEqual(info.iterations, 0, "Initial iteration should be 0");

        console.log("  Turn 1...");
        await session.sendAndWait("What is 1+1?", TIMEOUT);

        info = await session.getInfo();
        console.log(`  Iterations after turn 1: ${info.iterations}`);
        assertGreaterOrEqual(info.iterations, 1, "After turn 1");

        console.log("  Turn 2...");
        await session.sendAndWait("What is 2+2?", TIMEOUT);

        info = await session.getInfo();
        console.log(`  Iterations after turn 2: ${info.iterations}`);
        assertGreaterOrEqual(info.iterations, 2, "After turn 2");

        await validateSessionAfterTurn(env, session.sessionId, { minIteration: 2 });
    });
}

async function testSoftDeleteHidesSession(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(ONEWORD_CONFIG);
            const id = session.sessionId;

            await session.sendAndWait("What is 1+1?", TIMEOUT);

            let row = await getSession(catalog, id);
            assertNotNull(row, "Session should exist before delete");

            await validateSessionAfterTurn(env, id);

            await client.deleteSession(id);

            row = await getSession(catalog, id);
            assert(row === null, "Session should be null after soft delete");

            const list = await catalog.listSessions();
            assert(!list.some(s => s.sessionId === id), "Deleted session should not appear in list");
        });
    } finally {
        await catalog.close();
    }
}

async function testRenameVisibleInListAndInfo(env) {
    const mgmt = await createManagementClient(env);
    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(ONEWORD_CONFIG);
            await session.sendAndWait("Say hello", TIMEOUT);

            await mgmt.renameSession(session.sessionId, "My Custom Title");

            // Verify via listSessions
            const list = await client.listSessions();
            const entry = list.find(s => s.sessionId === session.sessionId);
            console.log(`  listSessions title: "${entry?.title}"`);
            assertEqual(entry?.title, "My Custom Title", "title in listSessions");

            // Verify via getInfo
            const info = await session.getInfo();
            console.log(`  getInfo title: "${info?.title}"`);
            assertEqual(info?.title, "My Custom Title", "title in getInfo");
        });
    } finally {
        await mgmt.stop();
    }
}

async function testRenamePersistsAcrossResume(env) {
    const mgmt = await createManagementClient(env);
    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(ONEWORD_CONFIG);
            await session.sendAndWait("Say hello", TIMEOUT);

            await mgmt.renameSession(session.sessionId, "Persisted Title");

            // Resume the same session
            const resumed = await client.resumeSession(session.sessionId);
            const info = await resumed.getInfo();
            console.log(`  Title after resume: "${info?.title}"`);
            assertEqual(info?.title, "Persisted Title", "title survives resume");
        });
    } finally {
        await mgmt.stop();
    }
}

async function testRenameTruncatesLongTitle(env) {
    const mgmt = await createManagementClient(env);
    const catalog = await createCatalog(env);
    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(ONEWORD_CONFIG);

            const longTitle = "A".repeat(100);
            await mgmt.renameSession(session.sessionId, longTitle);

            const row = await getSession(catalog, session.sessionId);
            console.log(`  Title length: ${row?.title?.length}`);
            assertGreaterOrEqual(60, row.title.length, "title truncated to <= 60 chars");
            assertEqual(row.title, "A".repeat(60), "title is first 60 chars");
        });
    } finally {
        await mgmt.stop();
        await catalog.close();
    }
}

describe.concurrent("Level 7b: CMS — State", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Session State Transitions", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("cms-consistency");
        try { await testSessionStateTransitions(env); } finally { await env.cleanup(); }
    });
    it("Title Update via Management", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("cms-consistency");
        try { await testTitleUpdate(env); } finally { await env.cleanup(); }
    });
    it("Session Iteration Count", { timeout: TIMEOUT * 2 }, async () => {
        const env = createTestEnv("cms-consistency");
        try { await testSessionIterationCount(env); } finally { await env.cleanup(); }
    });
    it("Soft Delete Hides Session", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("cms-consistency");
        try { await testSoftDeleteHidesSession(env); } finally { await env.cleanup(); }
    });
    it("Rename Visible in List and Info", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("cms-consistency");
        try { await testRenameVisibleInListAndInfo(env); } finally { await env.cleanup(); }
    });
    it("Rename Persists Across Resume", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("cms-consistency");
        try { await testRenamePersistsAcrossResume(env); } finally { await env.cleanup(); }
    });
    it("Rename Truncates Long Title", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("cms-consistency");
        try { await testRenameTruncatesLongTitle(env); } finally { await env.cleanup(); }
    });
});
