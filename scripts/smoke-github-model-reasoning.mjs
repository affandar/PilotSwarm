#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CopilotClient } from "@github/copilot-sdk";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = process.env.PS_MODEL_PROVIDER_SMOKE_CONFIG
    ? path.resolve(process.env.PS_MODEL_PROVIDER_SMOKE_CONFIG)
    : path.join(rootDir, ".model_providers.json");
const envPath = path.join(rootDir, ".env");

if (!process.env.GITHUB_TOKEN && fs.existsSync(envPath) && typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envPath);
}

const EXPECTED_GITHUB_CASES = [
    { model: "claude-opus-4.8", reasoningEffort: "medium" },
    { model: "gpt-5.5", reasoningEffort: "low" },
    { model: "gpt-5.5", reasoningEffort: "medium" },
    { model: "gpt-5.5", reasoningEffort: "high" },
    { model: "gpt-5.5", reasoningEffort: "xhigh" },
];

function loadCatalog() {
    return JSON.parse(fs.readFileSync(catalogPath, "utf8"));
}

function normalizeEntry(entry) {
    return typeof entry === "string" ? { name: entry } : entry;
}

function getGitHubProvider(catalog) {
    const provider = catalog.providers?.find((entry) => entry.id === "github-copilot");
    if (!provider) throw new Error(`Missing github-copilot provider in ${catalogPath}`);
    return provider;
}

function assertCatalog() {
    const provider = getGitHubProvider(loadCatalog());
    const models = provider.models.map(normalizeEntry);
    const byName = new Map(models.map((entry) => [entry.name, entry]));

    if (byName.has("claude-opus-4.7")) {
        throw new Error("Catalog still contains removed GitHub model claude-opus-4.7");
    }
    if (!byName.has("claude-opus-4.8")) {
        throw new Error("Catalog is missing GitHub model claude-opus-4.8");
    }
    const gpt55 = byName.get("gpt-5.5");
    if (!gpt55) throw new Error("Catalog is missing GitHub model gpt-5.5");
    const efforts = gpt55.supportedReasoningEfforts || [];
    for (const effort of ["low", "medium", "high", "xhigh"]) {
        if (!efforts.includes(effort)) {
            throw new Error(`gpt-5.5 is missing supportedReasoningEfforts entry ${effort}`);
        }
    }

    console.log(`catalog OK: ${path.relative(rootDir, catalogPath) || catalogPath}`);
}

function waitForResponse(session, prompt, timeoutMs = 180_000) {
    return new Promise((resolve, reject) => {
        let lastAssistantMessage = "";
        const timer = setTimeout(() => {
            reject(new Error(`Timed out waiting for response after ${timeoutMs}ms`));
        }, timeoutMs);

        session.on("assistant.message", (event) => {
            const content = String(event?.data?.content || "").trim();
            if (content) lastAssistantMessage = content;
        });
        session.on("session.idle", () => {
            clearTimeout(timer);
            resolve(lastAssistantMessage);
        });
        session.on("session.error", (event) => {
            clearTimeout(timer);
            reject(new Error(event?.data?.message || "session error"));
        });

        Promise.resolve(session.send({ prompt })).catch((error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

async function runLiveCase(client, { model, reasoningEffort }) {
    const session = await client.createSession({
        model,
        reasoningEffort,
        systemMessage: {
            content: "You are validating a model provider catalog. Reply to validation prompts with exactly OK.",
        },
        onPermissionRequest: () => ({ kind: "approve-once" }),
    });
    const response = await waitForResponse(session, "Reply with exactly OK.");
    if (!/\bok\b/i.test(response)) {
        throw new Error(`${model}:${reasoningEffort} returned unexpected response ${JSON.stringify(response)}`);
    }
    console.log(`live OK: github-copilot:${model}:${reasoningEffort}`);
}

async function main() {
    assertCatalog();

    if (!process.env.GITHUB_TOKEN) {
        throw new Error("GITHUB_TOKEN is required (set it in the environment or repo-root .env)");
    }

    const client = new CopilotClient({ gitHubToken: process.env.GITHUB_TOKEN });
    await client.start();
    try {
        for (const testCase of EXPECTED_GITHUB_CASES) {
            await runLiveCase(client, testCase);
        }
    } finally {
        await client.stop();
    }
}

main().catch((error) => {
    console.error(`smoke FAILED: ${error?.message || String(error)}`);
    process.exitCode = 1;
});