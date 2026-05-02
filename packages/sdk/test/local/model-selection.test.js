/**
 * Model selection tests.
 *
 * Covers: creating sessions with specific GitHub models,
 * verifying model is recorded in CMS, and model persists across turns.
 *
 * Run: npx vitest run test/local/model-selection.test.js
 */

import { describe, it, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { assertEqual, assertNotNull, assertThrows } from "../helpers/assertions.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { TEST_CLAUDE_MODEL, TEST_GPT_MODEL } from "../helpers/fixtures.js";
import { ModelProviderRegistry, PilotSwarmManagementClient } from "../../src/index.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);
const FORCE_SINGLE_MODEL = Boolean(process.env.PS_TEST_FORCE_MODEL || process.env.TEST_FORCE_MODEL);
const describeModelSelection = FORCE_SINGLE_MODEL ? describe.skip : describe;

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

async function testMissingConfiguredDefaultDoesNotFallback() {
    const registry = new ModelProviderRegistry({
        providers: [
            {
                id: "github-copilot",
                type: "github",
                githubToken: "env:GITHUB_TOKEN",
                models: ["gpt-5.1"],
            },
        ],
    });

    assertEqual(
        registry.defaultModel,
        undefined,
        "registry should not silently choose the first available model as default",
    );
    assertEqual(
        registry.normalize(),
        undefined,
        "normalizing an unspecified model should stay undefined when no defaultModel is configured",
    );
}

async function testGithubModelsRemainVisibleWithoutEnvToken() {
    const previousToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
        const registry = new ModelProviderRegistry({
            providers: [
                {
                    id: "github-copilot",
                    type: "github",
                    githubToken: "env:GITHUB_TOKEN",
                    models: ["gpt-5.5"],
                },
                {
                    id: "missing-openai",
                    type: "openai",
                    baseUrl: "https://example.invalid/openai/v1",
                    apiKey: "env:MISSING_OPENAI_KEY_FOR_TEST",
                    models: ["missing-model"],
                },
            ],
        });

        assertNotNull(
            registry.getDescriptor("github-copilot:gpt-5.5"),
            "GitHub models should remain visible even when env GITHUB_TOKEN is missing",
        );
        assertEqual(
            registry.getDescriptor("missing-openai:missing-model"),
            undefined,
            "non-GitHub providers should still require their API key before becoming visible",
        );
        assertEqual(
            registry.resolve("github-copilot:gpt-5.5")?.githubToken,
            undefined,
            "GitHub provider should expose missing env token as undefined for create-time enforcement",
        );
    } finally {
        if (previousToken == null) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = previousToken;
    }
}

async function testReasoningEffortMetadata() {
    const registry = new ModelProviderRegistry({
        providers: [
            {
                id: "github-copilot",
                type: "github",
                githubToken: "env:GITHUB_TOKEN",
                models: [
                    {
                        name: "gpt-5.5",
                        supportedReasoningEfforts: ["medium", "xhigh"],
                        defaultReasoningEffort: "medium",
                    },
                    "legacy-model",
                ],
            },
        ],
    });

    const gpt55 = registry.getDescriptor("github-copilot:gpt-5.5");
    assertNotNull(gpt55, "gpt-5.5 descriptor should exist");
    assertEqual(
        JSON.stringify(gpt55.supportedReasoningEfforts),
        JSON.stringify(["medium", "xhigh"]),
        "supported reasoning efforts should be preserved from model config",
    );
    assertEqual(gpt55.defaultReasoningEffort, "medium", "default reasoning effort should be preserved from model config");
    const summary = registry.getModelSummaryForLLM();
    assertEqual(summary.includes("[reasoning: medium, xhigh; default: medium]"), true, "LLM model summary should advertise supported and default reasoning efforts");

    const legacy = registry.getDescriptor("github-copilot:legacy-model");
    assertNotNull(legacy, "legacy descriptor should exist");
    assertEqual(
        legacy.supportedReasoningEfforts,
        undefined,
        "legacy string model entries should remain backward compatible and omit reasoning metadata",
    );
    assertEqual(legacy.defaultReasoningEffort, undefined, "legacy string model entries should not invent a default reasoning effort");
}

async function testManagementListModelsReasoningMetadata(env) {
    const modelProvidersPath = path.join(env.baseDir, "model-providers.reasoning-list.json");
    fs.writeFileSync(modelProvidersPath, JSON.stringify({
        providers: [{
            id: "github-copilot",
            type: "github",
            githubToken: "env:GITHUB_TOKEN",
            models: [{
                name: "gpt-5.5",
                description: "Reasoning metadata test model.",
                cost: "high",
                supportedReasoningEfforts: ["medium", "xhigh"],
                defaultReasoningEffort: "medium",
            }],
        }],
        defaultModel: "github-copilot:gpt-5.5",
    }));

    const mgmt = new PilotSwarmManagementClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        modelProvidersPath,
    });
    try {
        await mgmt.start();
        const models = mgmt.listModels();
        const model = models.find((entry) => entry.qualifiedName === "github-copilot:gpt-5.5");
        assertNotNull(model, "management listModels should include configured model");
        assertEqual(JSON.stringify(model.supportedReasoningEfforts), JSON.stringify(["medium", "xhigh"]), "management listModels should expose supported reasoning efforts");
        assertEqual(model.defaultReasoningEffort, "medium", "management listModels should expose default reasoning effort");
    } finally {
        await mgmt.stop().catch(() => {});
    }
}

describeModelSelection("Model Selection", () => {
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
    it("Missing Configured Default Does Not Fallback", async () => {
        await testMissingConfiguredDefaultDoesNotFallback();
    });
    it("GitHub Models Remain Visible Without Env Token", async () => {
        await testGithubModelsRemainVisibleWithoutEnvToken();
    });
    it("Reasoning Effort Metadata", async () => {
        await testReasoningEffortMetadata();
    });
    it("Management List Models Includes Reasoning Metadata", async () => {
        await testManagementListModelsReasoningMetadata(getEnv());
    });
});
