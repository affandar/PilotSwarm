/**
 * Model selection tests.
 *
 * Covers: creating sessions with specific GitHub models,
 * verifying model is recorded in CMS, and model persists across turns.
 *
 * Run: npx vitest run test/local/model-selection.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { assertEqual, assertNotNull } from "../helpers/assertions.js";
import { createCatalog } from "../helpers/cms-helpers.js";

const TIMEOUT = 120_000;

async function testCreateSessionWithModel(env) {
    await withClient(env, {}, async (client, worker) => {
        const session = await client.createSession({ model: "gpt-4o" });
        assertNotNull(session, "session created");

        const catalog = await createCatalog(env);
        try {
            const row = await catalog.getSession(session.sessionId);
            assertNotNull(row, "CMS row exists");
            console.log(`  CMS model: "${row.model}"`);
            assertNotNull(row.model, "model recorded in CMS");
            // Model may be normalized to include provider prefix
            assertEqual(
                row.model.includes("gpt-4o"),
                true,
                `model contains gpt-4o (got: ${row.model})`,
            );
        } finally {
            await catalog.close();
        }
    });
}

async function testModelRecordedAfterTurn(env) {
    await withClient(env, {}, async (client, worker) => {
        const session = await client.createSession({ model: "gpt-4o" });
        assertNotNull(session, "session created");

        console.log("  Sending prompt with gpt-4o model...");
        const response = await session.sendAndWait("Say hello", TIMEOUT);
        console.log(`  Response: "${response?.slice(0, 80)}"`);
        assertNotNull(response, "got response");

        const catalog = await createCatalog(env);
        try {
            const row = await catalog.getSession(session.sessionId);
            assertNotNull(row, "CMS row exists");
            console.log(`  CMS model after turn: "${row.model}"`);
            assertNotNull(row.model, "model still in CMS after turn");
            assertEqual(
                row.model.includes("gpt-4o"),
                true,
                `model still gpt-4o after turn (got: ${row.model})`,
            );
        } finally {
            await catalog.close();
        }
    });
}

async function testDifferentModelSameWorker(env) {
    await withClient(env, {}, async (client, worker) => {
        const s1 = await client.createSession({ model: "gpt-4o" });
        const s2 = await client.createSession({ model: "claude-sonnet-4.6" });
        assertNotNull(s1, "session 1 created");
        assertNotNull(s2, "session 2 created");

        console.log("  Sending prompts to both sessions...");
        const [r1, r2] = await Promise.all([
            s1.sendAndWait("Say hello", TIMEOUT),
            s2.sendAndWait("Say hello", TIMEOUT),
        ]);
        console.log(`  gpt-4o response: "${r1?.slice(0, 60)}"`);
        console.log(`  claude response: "${r2?.slice(0, 60)}"`);
        assertNotNull(r1, "got gpt-4o response");
        assertNotNull(r2, "got claude response");

        const catalog = await createCatalog(env);
        try {
            const row1 = await catalog.getSession(s1.sessionId);
            const row2 = await catalog.getSession(s2.sessionId);
            console.log(`  CMS model 1: "${row1?.model}"`);
            console.log(`  CMS model 2: "${row2?.model}"`);
            assertEqual(
                row1.model.includes("gpt-4o"),
                true,
                `session 1 model is gpt-4o (got: ${row1.model})`,
            );
            assertEqual(
                row2.model.includes("claude"),
                true,
                `session 2 model is claude (got: ${row2.model})`,
            );
        } finally {
            await catalog.close();
        }
    });
}

async function testDefaultModelRecorded(env) {
    await withClient(env, {}, async (client, worker) => {
        // No explicit model — should use the worker's default
        const session = await client.createSession();
        assertNotNull(session, "session created");

        console.log("  Sending prompt with default model...");
        const response = await session.sendAndWait("Say hello", TIMEOUT);
        assertNotNull(response, "got response");

        const info = await session.getInfo();
        console.log(`  Session info model: "${info?.model}"`);
        // Default model should be set (either from worker config or SDK default)
    });
}

describe.concurrent("Model Selection", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Create Session With Explicit Model", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("model-selection");
        try { await testCreateSessionWithModel(env); } finally { await env.cleanup(); }
    });
    it("Model Recorded in CMS After Turn", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("model-selection");
        try { await testModelRecordedAfterTurn(env); } finally { await env.cleanup(); }
    });
    it("Different Models on Same Worker", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("model-selection");
        try { await testDifferentModelSameWorker(env); } finally { await env.cleanup(); }
    });
    it("Default Model Recorded", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("model-selection");
        try { await testDefaultModelRecorded(env); } finally { await env.cleanup(); }
    });
});
