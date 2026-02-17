#!/usr/bin/env node

/**
 * Interactive console chat via durable-copilot-sdk.
 *
 * Usage: node --env-file=.env examples/chat.js
 */

import { DurableCopilotClient } from "../dist/index.js";
import { createInterface } from "node:readline";

/** Strip common markdown syntax for clean terminal output. */
function stripMarkdown(text) {
    return text
        .replace(/\*\*(.+?)\*\*/g, "$1")   // **bold**
        .replace(/\*(.+?)\*/g, "$1")        // *italic*
        .replace(/__(.+?)__/g, "$1")        // __bold__
        .replace(/_(.+?)_/g, "$1")          // _italic_
        .replace(/`(.+?)`/g, "$1")          // `code`
        .replace(/^#{1,6}\s+/gm, "")        // # headings
        .replace(/^\s*[-*+]\s+/gm, "  • ")  // - bullets → • bullets
        .replace(/^\s*\d+\.\s+/gm, (m) =>   // 1. numbered → keep number with •
            "  " + m.trim().replace(/\.$/, "") + ". ")
        .replace(/\[(.+?)\]\(.+?\)/g, "$1") // [link](url)
        .trim();
}

const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
});

const prompt = (q) =>
    new Promise((resolve) => rl.question(q, resolve));

console.log("🤖 Durable Copilot Chat");
console.log("   Type a message, press Enter. Type 'exit' to quit.\n");

const store = process.env.DATABASE_URL || "sqlite::memory:";
console.log(`   Store: ${store.startsWith("postgres") ? "PostgreSQL" : store}\n`);

const client = new DurableCopilotClient({
    store,
    githubToken: process.env.GITHUB_TOKEN,
});

await client.start();

const session = await client.createSession({
    systemMessage: "You are a helpful assistant. Be concise.",
    onUserInputRequest: async (request) => {
        console.log();
        const answer = await prompt(`🙋 ${request.question}\n> `);
        return { answer, wasFreeform: true };
    },
});

while (true) {
    const input = await prompt("\nyou: ");
    if (!input || input.trim() === "") continue;
    if (input.trim().toLowerCase() === "exit") break;

    try {
        const response = await session.sendAndWait(input, 120_000);
        console.log(`\n🤖 ${stripMarkdown(response ?? "")}`);
    } catch (err) {
        console.error(`\n❌ ${err.message}`);
    }
}

await client.stop();
rl.close();
process.exit(0);
