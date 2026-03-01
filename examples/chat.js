#!/usr/bin/env node

/**
 * Interactive console chat using durable-copilot-runtime.
 *
 * Usage: node --env-file=.env examples/chat.js
 *
 * Features:
 *   - Full architecture (orchestration → SessionProxy → ManagedSession)
 *   - CMS session persistence (Postgres)
 *   - Live event streaming via session.on()
 *   - Durable wait tool + ask_user tool
 */

import { DurableCopilotClient, DurableCopilotWorker } from "../dist/index.js";
import { createInterface } from "node:readline";

const STORE = process.env.DATABASE_URL || "sqlite::memory:";

// ─── Readline setup ──────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout });
const prompt = (q) => new Promise((resolve) => rl.question(q, resolve));

function stripMarkdown(text) {
    return text
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/\*(.+?)\*/g, "$1")
        .replace(/`(.+?)`/g, "$1")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/^\s*[-*+]\s+/gm, "  • ")
        .replace(/\[(.+?)\]\(.+?\)/g, "$1")
        .trim();
}

// ─── Start worker + client ───────────────────────────────────────

console.log("🤖 Durable Copilot Chat");
console.log(`   Store: ${STORE.startsWith("postgres") ? "PostgreSQL" : STORE}\n`);

const worker = new DurableCopilotWorker({
    store: STORE,
    githubToken: process.env.GITHUB_TOKEN,
    blobConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
    blobContainer: process.env.AZURE_STORAGE_CONTAINER || "copilot-sessions",
});
await worker.start();

const client = new DurableCopilotClient({
    store: STORE,
    blobEnabled: true,
});
await client.start();

// Create session with user input handler for ask_user tool
const session = await client.createSession({
    onUserInputRequest: async (request) => {
        let q = `\n❓ ${request.question}`;
        if (request.choices?.length) {
            q += "\n" + request.choices.map((c, i) => `   ${i + 1}. ${c}`).join("\n");
        }
        q += "\n> ";
        const answer = await prompt(q);
        return { answer };
    },
});

// Forward config to co-located worker
worker.setSessionConfig(session.sessionId, {});

// ─── Subscribe to live events ────────────────────────────────────

session.on((event) => {
    const dim = "\x1b[2m";
    const reset = "\x1b[0m";
    const type = event.eventType;
    const seq = event.seq;

    // Compact one-line display per event
    let detail = "";
    if (type === "assistant.message") {
        const content = event.data?.content ?? "";
        detail = content.length > 80 ? content.slice(0, 80) + "…" : content;
    } else if (type === "tool.execution_start") {
        detail = event.data?.toolName ?? event.data?.name ?? "";
    } else if (type === "tool.execution_end") {
        detail = event.data?.toolName ?? event.data?.name ?? "";
    } else if (type === "assistant.usage" || type === "session.usage_info") {
        const u = event.data;
        detail = u ? `in=${u.inputTokens ?? u.input_tokens ?? "?"} out=${u.outputTokens ?? u.output_tokens ?? "?"}` : "";
    }

    console.log(`${dim}   [${seq}] ${type}${detail ? " — " + detail : ""}${reset}`);
});

// ─── Chat loop ───────────────────────────────────────────────────

console.log("   Type a message, press Enter. Type 'exit' to quit.\n");

while (true) {
    const input = await prompt("you> ");
    if (!input || input.trim().toLowerCase() === "exit") break;

    try {
        const response = await session.sendAndWait(input.trim(), 300_000);
        if (response) {
            console.log(`\n${stripMarkdown(response)}\n`);
        }
    } catch (err) {
        console.error(`\n⚠️  Error: ${err.message}\n`);
    }
}

// ─── Cleanup ─────────────────────────────────────────────────────

console.log("\n👋 Bye!");
await session.destroy();
await client.stop();
await worker.stop();
rl.close();
process.exit(0);
