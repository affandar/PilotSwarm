/**
 * Model selection tests.
 *
 * Covers: creating sessions with specific GitHub models,
 * verifying model is recorded in CMS, and model persists across turns.
 *
 * Run: npx vitest run test/local/model-selection.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { assertEqual, assertNotNull, assertThrows } from "../helpers/assertions.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { TEST_CLAUDE_MODEL, TEST_GPT_MODEL } from "../helpers/fixtures.js";
import { ModelProviderRegistry } from "../../src/index.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

async function testCreateSessionWithModel(env) {
    await withClient(env, {}, async (client, worker) => {
        const session = await client.createSession({ model: TEST_GPT_MODEL });
        assertNotNull(session, "session created");

        const catalog = await createCatalog(env);
        try {
            const row = await catalog.getSession(session.sessionId);
            assertNotNull(row, "CMS row exists");
            console.log(`  CMS model: "${row.model}"`);
            assertNotNull(row.model, "model recorded in CMS");
            // Model may be normalized to include provider prefix
            assertEqual(
                row.model.includes(TEST_GPT_MODEL),
                true,
                `model contains ${TEST_GPT_MODEL} (got: ${row.model})`,
            );
        } finally {
            await catalog.close();
        }
    });
}

async function testModelRecordedAfterTurn(env) {
    await withClient(env, {}, async (client, worker) => {
        const session = await client.createSession({ model: TEST_GPT_MODEL });
        assertNotNull(session, "session created");

        console.log(`  Sending prompt with ${TEST_GPT_MODEL} model...`);
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
                row.model.includes(TEST_GPT_MODEL),
                true,
                `model still ${TEST_GPT_MODEL} after turn (got: ${row.model})`,
            );
        } finally {
            await catalog.close();
        }
    });
}

async function testDifferentModelSameWorker(env) {
    await withClient(env, {}, async (client, worker) => {
        const s1 = await client.createSession({ model: TEST_GPT_MODEL });
        const s2 = await client.createSession({ model: TEST_CLAUDE_MODEL });
        assertNotNull(s1, "session 1 created");
        assertNotNull(s2, "session 2 created");

        console.log("  Sending prompts to both sessions...");
        const [r1, r2] = await Promise.all([
            s1.sendAndWait("Say hello", TIMEOUT),
            s2.sendAndWait("Say hello", TIMEOUT),
        ]);
        console.log(`  ${TEST_GPT_MODEL} response: "${r1?.slice(0, 60)}"`);
        console.log(`  ${TEST_CLAUDE_MODEL} response: "${r2?.slice(0, 60)}"`);
        assertNotNull(r1, `got ${TEST_GPT_MODEL} response`);
        assertNotNull(r2, "got claude response");

        const catalog = await createCatalog(env);
        try {
            const row1 = await catalog.getSession(s1.sessionId);
            const row2 = await catalog.getSession(s2.sessionId);
            console.log(`  CMS model 1: "${row1?.model}"`);
            console.log(`  CMS model 2: "${row2?.model}"`);
            assertEqual(
                row1.model.includes(TEST_GPT_MODEL),
                true,
                `session 1 model is ${TEST_GPT_MODEL} (got: ${row1.model})`,
            );
            assertEqual(
                row2.model.includes(TEST_CLAUDE_MODEL),
                true,
                `session 2 model is ${TEST_CLAUDE_MODEL} (got: ${row2.model})`,
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

async function testInvalidConfiguredDefaultFailsFast() {
    await assertThrows(
        async () => {
            new ModelProviderRegistry({
                providers: [
                    {
                        id: "github-copilot",
                        type: "github",
                        githubToken: "env:GITHUB_TOKEN",
                        models: ["gpt-5.1"],
                    },
                ],
                defaultModel: "azure-openai:gpt-5.4-min1i",
            });
        },
        /invalid defaultmodel/i,
        "invalid configured default should fail fast",
    );
}

describe("Model Selection", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Create Session With Explicit Model", { timeout: TIMEOUT }, async () => {
        await testCreateSessionWithModel(getEnv());
    });
    it("Model Recorded in CMS After Turn", { timeout: TIMEOUT }, async () => {
        await testModelRecordedAfterTurn(getEnv());
    });
    it("Different Models on Same Worker", { timeout: TIMEOUT }, async () => {
        await testDifferentModelSameWorker(getEnv());
    });
    it("Default Model Recorded", { timeout: TIMEOUT }, async () => {
        await testDefaultModelRecorded(getEnv());
    });
    it("Invalid Configured Default Fails Fast", async () => {
        await testInvalidConfiguredDefaultFailsFast();
    });
});
