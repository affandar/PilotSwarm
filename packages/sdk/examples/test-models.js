#!/usr/bin/env node

/**
 * Model verification — tests each model by asking it to identify itself.
 * Usage: GITHUB_TOKEN=$(gh auth token) node --env-file=.env examples/test-models.js [model1 model2 ...]
 *
 * If no models specified, tests all models from model_providers.json.
 */

import { PilotSwarmClient, PilotSwarmWorker, loadModelProviders } from "@affandar/pilotswarm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE = process.env.DATABASE_URL || "sqlite::memory:";

// Build model list: CLI args or all from model_providers.json (qualified names)
let MODELS;
if (process.argv.slice(2).length > 0) {
    MODELS = process.argv.slice(2);
} else {
    const registry = loadModelProviders(path.resolve(__dirname, "..", "model_providers.json"));
    if (!registry) {
        console.error("No model_providers.json found");
        process.exit(1);
    }
    MODELS = registry.getModelsByProvider().flatMap(g => g.models.map(m => m.qualifiedName));
}

// Expected substrings in the model's self-identification response.
// Key: substring that appears in the model name. Value: substrings the response should contain.
const IDENTITY_PATTERNS = {
    "claude-opus-4.6":   ["opus", "4.6"],
    "claude-sonnet-4.6": ["sonnet", "4.6"],
    "gpt-4o":            ["gpt-4o"],
    "gpt-4.1":           ["gpt-4.1", "4.1"],
    "gpt-4.1-mini":      ["gpt-4.1", "mini"],
    "gpt-5.1":           ["gpt-5.1", "5.1"],
};

function getExpectedPatterns(modelName) {
    // Try exact match first, then substring match
    const bare = modelName.includes(":") ? modelName.split(":")[1] : modelName;
    if (IDENTITY_PATTERNS[bare]) return IDENTITY_PATTERNS[bare];
    for (const [key, patterns] of Object.entries(IDENTITY_PATTERNS)) {
        if (bare.includes(key) || key.includes(bare)) return patterns;
    }
    return [bare]; // fallback: expect the model name itself in the response
}

console.log("🧪 Model Identity Verification");
console.log(`   Store: ${STORE.startsWith("postgres") ? "PostgreSQL" : STORE}`);
console.log(`   Models: ${MODELS.join(", ")}\n`);

const worker = new PilotSwarmWorker({
    store: STORE,
    githubToken: process.env.GITHUB_TOKEN,
});
await worker.start();

const client = new PilotSwarmClient({ store: STORE });
await client.start();

const results = [];

for (const model of MODELS) {
    const bare = model.includes(":") ? model.split(":")[1] : model;
    process.stdout.write(`   Testing ${model}... `);
    const start = Date.now();
    try {
        const session = await client.createSession({ model });
        worker.setSessionConfig(session.sessionId, {});
        const response = await session.sendAndWait(
            "What specific model are you? Reply with ONLY your model name/ID, nothing else. For example: 'gpt-4o' or 'claude-sonnet-4.6'.",
            60_000,
        );
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        const answer = (response || "").replace(/\s+/g, " ").trim().toLowerCase();
        const expected = getExpectedPatterns(model);
        const matched = expected.every(p => answer.toLowerCase().includes(p.toLowerCase()));

        if (matched) {
            console.log(`✅ (${elapsed}s) "${answer}"`);
            results.push({ model, status: "ok", elapsed, answer });
        } else {
            console.log(`❌ (${elapsed}s) expected [${expected.join(", ")}] but got "${answer}"`);
            results.push({ model, status: "wrong_model", elapsed, answer, expected });
        }
        await session.destroy();
    } catch (err) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`❌ (${elapsed}s) ERROR: ${err.message}`);
        results.push({ model, status: "error", elapsed, error: err.message });
    }
}

console.log("\n─── Summary ───");
for (const r of results) {
    const icon = r.status === "ok" ? "✅" : "❌";
    console.log(`   ${icon} ${r.model} (${r.elapsed}s)${r.status !== "ok" ? " — " + (r.answer || r.error) : ""}`);
}

const passed = results.filter(r => r.status === "ok").length;
console.log(`\n   ${passed}/${results.length} models verified\n`);

await client.stop();
await worker.stop();
process.exit(passed === results.length ? 0 : 1);
