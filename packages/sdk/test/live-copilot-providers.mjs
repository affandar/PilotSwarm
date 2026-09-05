/**
 * Live inference compatibility gate. Load credentials with Node --env-file;
 * never print them or endpoints. Missing required types fail the gate.
 * Example (repo root, after build):
 * node --env-file=.env packages/sdk/test/live-copilot-providers.mjs \
 *   --config .model_providers.json --models github-copilot:gpt-6-astra,azure-openai:gpt-5.4 \
 *   --require-types github,openai
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { loadModelProviders } from "../dist/model-providers.js";
import { attachWorkloadIdentity } from "../dist/wif-credentials.js";
import { createCopilotClient } from "../dist/copilot-client.js";

const { values } = parseArgs({ options: {
    config: { type: "string" }, models: { type: "string" },
    "require-types": { type: "string", default: "github,azure,openai,openai-proxy,anthropic,anthropic-wif" },
    output: { type: "string" },
} });
assert.ok(values.config, "--config must name an explicit test catalog");
const registry = loadModelProviders(resolve(values.config));
assert.ok(registry, "test catalog must load");
const models = values.models?.split(",") ?? registry.getModelsByProvider().map(p => p.models[0].qualifiedName);
const required = values["require-types"].split(",");
const covered = new Set();
const results = [];

await Promise.all(models.map(async ref => {
    const resolved = registry.resolve(ref);
    if (!resolved) { results.push({ model: ref, status: "BLOCKED", error: "Model or credentials unavailable in test catalog" }); return; }
    const home = mkdtempSync(join(tmpdir(), "ps-live-provider-"));
    const clients = [];
    const row = { model: ref, type: resolved.type, status: "FAIL", turns: [] };
    results.push(row);
    try {
        const provider = resolved.sdkProvider ? attachWorkloadIdentity(resolved) : undefined;
        const options = { useLoggedInUser: false, ...(resolved.githubToken ? { gitHubToken: resolved.githubToken } : {}), env: { ...process.env, COPILOT_HOME: home }, logLevel: "error" };
        const token = randomUUID();
        let calls = 0;
        const config = { model: resolved.modelName, ...(provider ? { provider } : {}), streaming: true,
            onPermissionRequest: () => ({ kind: "approved" }),
            availableTools: ["read_validation_token"],
            tools: [{ name: "read_validation_token", description: "Return the validation token for this test.", parameters: { type: "object", properties: {} }, handler: async () => { calls++; return token; } }],
        };
        let client = createCopilotClient(options, provider);
        clients.push(client);
        let session = await client.createSession(config);
        row.runtime = await client.getStatus();
        assert.equal(row.runtime.version, "1.0.83", "actual runtime must match the pinned CLI");
        async function turn(prompt, label) {
            const start = performance.now();
            const usage = [];
            let firstDeltaMs;
            const unsubscribe = session.on(event => {
                if (event.type === "assistant.usage") usage.push(event.data);
                if (event.type === "assistant.message_delta" && firstDeltaMs === undefined) firstDeltaMs = performance.now() - start;
            });
            try {
                const answer = await session.sendAndWait({ prompt }, 120_000);
                assert.ok(answer?.data?.content?.includes(token), `${label}: correct tool token must survive`);
                assert.ok(usage.length > 0, `${label}: token usage must be reported`);
                row.turns.push({ label, durationMs: Math.round(performance.now() - start), firstDeltaMs: firstDeltaMs === undefined ? null : Math.round(firstDeltaMs),
                    inputTokens: usage.reduce((n, u) => n + (u.inputTokens ?? 0), 0), outputTokens: usage.reduce((n, u) => n + (u.outputTokens ?? 0), 0),
                });
            } finally { unsubscribe(); }
        }
        await turn("Call read_validation_token exactly once. Reply with only the token it returns.", "tool");
        assert.equal(calls, 1, "exactly one tool execution");
        await turn("Without calling a tool, repeat the validation token you just received.", "warm");
        const id = session.sessionId;
        await session.disconnect();
        await client.stop();
        client = createCopilotClient(options, provider);
        clients.push(client);
        session = await client.resumeSession(id, config);
        await turn("Without calling a tool, repeat the validation token from our conversation.", "cold-resume");
        assert.equal(calls, 1, "resume must not replay the tool");
        covered.add(resolved.type);
        row.status = "PASS";
    } catch (error) {
        let message = String(error?.message ?? error);
        for (const secret of [resolved.githubToken, resolved.sdkProvider?.apiKey].filter(Boolean)) message = message.replaceAll(secret, "<redacted>");
        row.error = message.replace(/https?:\/\/\S+/g, "<endpoint>");
    } finally {
        await Promise.all(clients.map(client => client.stop()));
        rmSync(home, { recursive: true, force: true });
    }
    console.log(JSON.stringify(row));
}));

const missingTypes = required.filter(type => !covered.has(type));
const result = { status: results.every(r => r.status === "PASS") && !missingTypes.length ? "PASS" : "FAIL", requiredTypes: required, missingTypes, results };
if (values.output) writeFileSync(values.output, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ status: result.status, missingTypes }));
if (result.status !== "PASS") process.exitCode = 1;
