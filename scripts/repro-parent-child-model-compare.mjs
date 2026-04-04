#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
    PilotSwarmClient,
    PilotSwarmWorker,
    PgSessionCatalogProvider,
    loadModelProviders,
} from "../packages/sdk/dist/index.js";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, "../packages/sdk/test/fixtures/parent-child-roundtrip-plugin");
const DATABASE_URL = process.env.DATABASE_URL;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const ALL_MODELS = [
    { label: "gpt-5.4", model: "azure-openai:gpt-5.4" },
    { label: "opus-4.6", model: "github-copilot:claude-opus-4.6" },
];
const STEP2_TIMEOUT_MS = 240_000;
const DEFAULT_SESSION_STATE_DIR = path.join(os.homedir(), ".copilot", "session-state");
const DEFAULT_SESSION_STORE_DIR = path.join(os.homedir(), ".copilot", "session-store");
const MODEL_FILTERS = process.argv
    .filter((arg) => arg.startsWith("--model="))
    .map((arg) => arg.slice("--model=".length));

if (!DATABASE_URL) {
    console.error("DATABASE_URL not set. Run with --env-file=.env");
    process.exit(1);
}
if (!GITHUB_TOKEN) {
    console.error("GITHUB_TOKEN not set. Run with --env-file=.env");
    process.exit(1);
}

function sanitizeLabel(value) {
    return String(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 20) || "repro";
}

function createEnv(label) {
    const runId = randomBytes(4).toString("hex");
    const safeLabel = sanitizeLabel(label);
    return {
        store: DATABASE_URL,
        duroxideSchema: `ps_repro_drx_${safeLabel}_${runId}`,
        cmsSchema: `ps_repro_cms_${safeLabel}_${runId}`,
        factsSchema: `ps_repro_facts_${safeLabel}_${runId}`,
        baseDir: null,
        sessionStateDir: DEFAULT_SESSION_STATE_DIR,
        sessionStoreDir: DEFAULT_SESSION_STORE_DIR,
    };
}

async function dropSchemas(env) {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    try {
        await client.connect();
        await client.query(`DROP SCHEMA IF EXISTS "${env.duroxideSchema}" CASCADE`);
        await client.query(`DROP SCHEMA IF EXISTS "${env.cmsSchema}" CASCADE`);
        await client.query(`DROP SCHEMA IF EXISTS "${env.factsSchema}" CASCADE`);
    } finally {
        try { await client.end(); } catch {}
    }
}

async function cleanupEnv(env) {
    try {
        await dropSchemas(env);
    } catch (err) {
        console.warn(`[cleanup] schema drop failed: ${err.message || err}`);
    }
}

async function createCatalog(env) {
    const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
    await catalog.initialize();
    return catalog;
}

async function waitForChildSession(catalog, parentSessionId, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const sessions = await catalog.listSessions();
        const child = sessions.find((row) => row.parentSessionId === parentSessionId && row.agentId === "questioner");
        if (child) return child;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    return null;
}

async function readChildSignals(catalog, childSessionId, timeoutMs = 70_000) {
    const deadline = Date.now() + timeoutMs;
    let events = [];
    while (Date.now() < deadline) {
        events = await catalog.getSessionEvents(childSessionId);
        const assistantMessages = events
            .filter((event) => event.eventType === "assistant.message")
            .map((event) => event.data?.content ?? "");
        const waitReasons = events
            .filter((event) => event.eventType === "session.wait_started")
            .map((event) => event.data?.reason ?? "");
        if (assistantMessages.some(Boolean) || waitReasons.length > 0) {
            return { events, assistantMessages, waitReasons };
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    const assistantMessages = events
        .filter((event) => event.eventType === "assistant.message")
        .map((event) => event.data?.content ?? "");
    const waitReasons = events
        .filter((event) => event.eventType === "session.wait_started")
        .map((event) => event.data?.reason ?? "");
    return { events, assistantMessages, waitReasons };
}

function summarizeChildEvents(events) {
    return events.map((event) => ({
        seq: event.seq,
        eventType: event.eventType,
        data: event.data,
    }));
}

async function runScenario({ label, model }) {
    const env = createEnv(label);
    const catalog = await createCatalog(env);
    const worker = new PilotSwarmWorker({
        store: env.store,
        githubToken: GITHUB_TOKEN,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        workerNodeId: `repro-${sanitizeLabel(label)}`,
        disableManagementAgents: true,
        pluginDirs: [PLUGIN_DIR],
        logLevel: process.env.DUROXIDE_LOG_LEVEL || "error",
    });

    const client = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        ...(worker.sessionPolicy ? { sessionPolicy: worker.sessionPolicy } : {}),
        ...(worker.allowedAgentNames?.length ? { allowedAgentNames: worker.allowedAgentNames } : {}),
    });

    const summary = {
        label,
        model,
        defaultModel: null,
        parentSessionId: null,
        childSessionId: null,
        childSpawned: false,
        baseDir: env.baseDir,
        sessionStateDir: env.sessionStateDir,
        sessionStoreDir: env.sessionStoreDir,
        blockingSignals: { assistantMessages: [], waitReasons: [] },
        step2Response: null,
        step2Error: null,
        parentInfo: null,
        childRow: null,
        childEvents: [],
        sessionStoreFiles: [],
        success: false,
    };

    try {
        await worker.start();
        await client.start();

        const origCreate = client.createSession.bind(client);
        client.createSession = async (config) => {
            const session = await origCreate(config);
            if (config) worker.setSessionConfig(session.sessionId, config);
            return session;
        };

        summary.defaultModel = worker.modelProviders?.defaultModel ?? null;

        const session = await client.createSession({
            agentId: "coordinator",
            model,
        });
        summary.parentSessionId = session.sessionId;

        await session.send(
            "Using only PilotSwarm tools, spawn the named agent questioner. " +
            "Do not answer the child yet. Stop after the child has been spawned and has asked its blocking question.",
        );

        const child = await waitForChildSession(catalog, session.sessionId);
        summary.childSpawned = Boolean(child);
        summary.childSessionId = child?.sessionId ?? null;
        if (!child) {
            summary.step2Error = "child was not spawned";
            summary.parentInfo = await session.getInfo().catch(() => null);
            return summary;
        }

        const childSignals = await readChildSignals(catalog, child.sessionId);
        summary.blockingSignals.assistantMessages = childSignals.assistantMessages;
        summary.blockingSignals.waitReasons = childSignals.waitReasons;

        try {
            summary.step2Response = await session.sendAndWait(
                `Using only PilotSwarm tools, send exactly \"ANSWER: BLUE\" to child session-${child.sessionId} with message_agent. ` +
                `Then call wait_for_agents for that child and reply with exactly the child's final answer.`,
                STEP2_TIMEOUT_MS,
            );
        } catch (err) {
            summary.step2Error = err?.message || String(err);
        }

        summary.parentInfo = await session.getInfo().catch(() => null);
        summary.childRow = await catalog.getSession(child.sessionId).catch(() => null);
        summary.childEvents = summarizeChildEvents(await catalog.getSessionEvents(child.sessionId).catch(() => []));
        summary.sessionStoreFiles = fs.existsSync(env.sessionStoreDir)
            ? fs.readdirSync(env.sessionStoreDir).sort()
            : [];

        const childUserMessages = summary.childEvents
            .filter((event) => event.eventType === "user.message")
            .map((event) => event.data?.content ?? "");
        const childAssistantMessages = summary.childEvents
            .filter((event) => event.eventType === "assistant.message")
            .map((event) => event.data?.content ?? "");

        summary.success = Boolean(
            summary.step2Response?.includes("CHILD FINAL: BLUE")
            && childUserMessages.some((msg) => msg.includes("ANSWER: BLUE"))
            && childAssistantMessages.some((msg) => msg.includes("CHILD FINAL: BLUE")),
        );

        return summary;
    } finally {
        try { await client.stop(); } catch {}
        try { await worker.stop(); } catch {}
        try { await catalog.close(); } catch {}
        await cleanupEnv(env);
    }
}

function printSummary(summary) {
    const childAssistantMessages = summary.childEvents
        .filter((event) => event.eventType === "assistant.message")
        .map((event) => event.data?.content ?? "");
    const childUserMessages = summary.childEvents
        .filter((event) => event.eventType === "user.message")
        .map((event) => event.data?.content ?? "");

    console.log(`\n=== ${summary.label} (${summary.model}) ===`);
    console.log(`default model: ${summary.defaultModel}`);
    console.log(`parent session: ${summary.parentSessionId ?? "(none)"}`);
    console.log(`child session: ${summary.childSessionId ?? "(none)"}`);
    console.log(`child spawned: ${summary.childSpawned}`);
    console.log(`base dir: ${summary.baseDir ?? "(using default ~/.copilot folders)"}`);
    console.log(`session state dir: ${summary.sessionStateDir}`);
    console.log(`session store dir: ${summary.sessionStoreDir}`);
    console.log(`session store files: ${JSON.stringify(summary.sessionStoreFiles)}`);
    console.log(`blocking assistant messages: ${JSON.stringify(summary.blockingSignals.assistantMessages)}`);
    console.log(`blocking wait reasons: ${JSON.stringify(summary.blockingSignals.waitReasons)}`);
    console.log(`step2 response: ${JSON.stringify(summary.step2Response)}`);
    console.log(`step2 error: ${JSON.stringify(summary.step2Error)}`);
    console.log(`parent info: ${JSON.stringify(summary.parentInfo)}`);
    console.log(`child row: ${JSON.stringify(summary.childRow)}`);
    console.log(`child user messages: ${JSON.stringify(childUserMessages)}`);
    console.log(`child assistant messages: ${JSON.stringify(childAssistantMessages)}`);
    console.log(`success: ${summary.success}`);
}

async function main() {
    const registry = loadModelProviders();
    const models = MODEL_FILTERS.length > 0
        ? ALL_MODELS.filter((entry) => MODEL_FILTERS.includes(entry.label) || MODEL_FILTERS.includes(entry.model))
        : ALL_MODELS;
    if (models.length === 0) {
        throw new Error(`No models matched filters: ${MODEL_FILTERS.join(", ")}`);
    }
    const available = new Set(registry?.allModels?.map((model) => model.qualifiedName) ?? []);
    for (const { model } of models) {
        if (!available.has(model)) {
            throw new Error(`Model ${model} is not available in the current environment.`);
        }
    }

    console.log(`Using plugin fixture: ${PLUGIN_DIR}`);
    console.log(`Selected models: ${models.map(({ model }) => model).join(", ")}`);
    console.log(`session state dir: ${DEFAULT_SESSION_STATE_DIR}`);
    console.log(`session store dir: ${DEFAULT_SESSION_STORE_DIR}`);

    const summaries = [];
    for (const entry of models) {
        summaries.push(await runScenario(entry));
    }

    for (const summary of summaries) {
        printSummary(summary);
    }

    console.log("\n=== Comparison ===");
    for (const summary of summaries) {
        console.log(JSON.stringify({
            label: summary.label,
            model: summary.model,
            childSpawned: summary.childSpawned,
            step2Error: summary.step2Error,
            success: summary.success,
        }, null, 2));
    }

    if (!summaries.every((summary) => summary.success)) {
        process.exitCode = 1;
    }
}

await main();