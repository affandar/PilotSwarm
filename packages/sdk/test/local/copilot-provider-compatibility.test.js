import { describe, it, expect } from "vitest";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createCopilotClient } from "../../src/copilot-client.ts";
import { ModelProviderRegistry, applyReasoningEffortToProviderConfig } from "../../src/model-providers.ts";
import { attachWorkloadIdentity } from "../../src/wif-credentials.ts";
import { SessionManager } from "../../src/session-manager.ts";
import { createCopilotProviderServer } from "../helpers/copilot-provider-server.mjs";

const MODEL = "gpt-5.6-terra";
const WIF_ENV = {
    ANTHROPIC_FEDERATION_RULE_ID: "fdrl_test", ANTHROPIC_ORGANIZATION_ID: "org-test",
    ANTHROPIC_SERVICE_ACCOUNT_ID: "svac_test", AZURE_FEDERATED_TOKEN_FILE: "/synthetic/token",
    AZURE_TENANT_ID: "test-tenant", AZURE_CLIENT_ID: "test-client",
};

async function harness(run) {
    const home = mkdtempSync(join(tmpdir(), "ps-provider-compat-"));
    const server = await createCopilotProviderServer();
    const clients = [];
    try {
        await run({ home, server, clients, options: { useLoggedInUser: false, env: { ...process.env, COPILOT_HOME: home }, logLevel: "error" } });
    } finally {
        await Promise.all(clients.map(client => client.stop()));
        await server.close();
        rmSync(home, { recursive: true, force: true });
    }
}

describe.concurrent("Copilot provider wire compatibility (real SDK/CLI, synthetic HTTP)", () => {
    it("reproduces the unmodified CLI's rejected snippy field", { timeout: 30_000 }, async () => {
        await harness(async ({ server, clients, options }) => {
            const client = new CopilotClient({ ...options, connection: RuntimeConnection.forStdio() });
            clients.push(client);
            const session = await client.createSession({ model: MODEL, provider: { type: "openai", baseUrl: server.baseUrl + "/v1", apiKey: "synthetic-key" }, onPermissionRequest: () => ({ kind: "approved" }) });
            await expect(session.sendAndWait({ prompt: "Say hello" }, 20_000)).rejects.toThrow(/snippy/);
            expect(server.requests.length).toBeGreaterThan(0);
            expect(server.requests[0].body.snippy).toEqual({ enabled: false });
        });
    });

    for (const type of ["openai", "azure", "openai-proxy", "anthropic", "anthropic-wif"]) {
        for (const streaming of [false, true]) {
            it(`${type}: tool call, usage, streaming=${streaming}, warm turn and cold resume`, { timeout: 60_000 }, async () => {
                await harness(async ({ server, clients, options }) => {
                    const model = type.startsWith("anthropic") ? "claude-sonnet-5" : MODEL;
                    const registry = new ModelProviderRegistry({ providers: [{
                        id: type, type, baseUrl: server.baseUrl + (type.startsWith("anthropic") ? "" : "/v1"),
                        ...(type === "anthropic-wif" ? {} : { apiKey: "synthetic-key" }),
                        models: [{ name: model, supportedReasoningEfforts: ["medium"], defaultReasoningEffort: "medium" }],
                    }] });
                    const resolved = registry.resolve(`${type}:${model}`);
                    let credentials = 0;
                    const provider = applyReasoningEffortToProviderConfig(attachWorkloadIdentity(resolved, {
                        env: WIF_ENV, credentials: () => ({ getToken: async () => `synthetic-bearer-${++credentials}` }),
                    }), registry.getDescriptor(`${type}:${model}`), "medium");
                    const client = createCopilotClient(options, provider);
                    clients.push(client);
                    const toolCalls = [];
                    const config = { model, provider, streaming, reasoningEffort: "medium", onPermissionRequest: () => ({ kind: "approved" }), tools: [{
                        name: "compat_echo", description: "Echo the supplied value.",
                        parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
                        handler: async args => { toolCalls.push(args); return args.value; },
                    }] };
                    let session = await client.createSession(config);
                    expect((await client.getStatus()).version).toBe("1.0.83");
                    const events = [];
                    session.on(event => events.push(event));
                    const first = await session.sendAndWait({ prompt: "call compat_echo with value violet-739" }, 20_000);
                    expect(first.data.content).toContain("violet-739");
                    expect(toolCalls).toEqual([{ value: "violet-739" }]);
                    expect(events.some(e => e.type === "assistant.usage")).toBe(true);
                    expect(events.filter(e => e.type === "assistant.usage").every(e => e.data.inputTokens > 0 && e.data.outputTokens > 0)).toBe(true);
                    if (streaming) expect(events.some(e => e.type === "assistant.message_delta")).toBe(true);
                    await session.sendAndWait({ prompt: "Say hello again" }, 20_000);
                    const id = session.sessionId;
                    await session.disconnect();
                    await client.stop();
                    // New process, not just an in-memory handle reconnect.
                    const resumedClient = createCopilotClient(options, provider);
                    clients.push(resumedClient);
                    session = await resumedClient.resumeSession(id, config);
                    const result = await session.sendAndWait({ prompt: "Say hello after resume" }, 20_000);
                    expect(result.data.content).toContain("violet-739");
                    expect(toolCalls).toEqual([{ value: "violet-739" }]);
                    expect(server.requests.every(r => !Object.hasOwn(r.body, "snippy"))).toBe(true);
                    expect(server.requests.at(-1).body.messages.some(m => JSON.stringify(m).includes("violet-739"))).toBe(true);
                    if (type === "openai-proxy") expect(server.requests.every(r => r.path.includes("/x-reasoning-effort/medium/"))).toBe(true);
                    if (type === "azure") {
                        expect(server.requests[0].path).toContain(`/deployments/${model}/chat/completions`);
                        expect(server.requests[0].path).toContain("api-version=");
                    }
                    if (type === "anthropic-wif") {
                        expect(credentials).toBe(server.requests.length);
                        expect(server.requests.map(r => r.headers.authorization)).toEqual(server.requests.map((_, i) => `Bearer synthetic-bearer-${i + 1}`));
                        expect(server.requests.every(r => !r.headers["x-api-key"])).toBe(true);
                    }
                });
            });
        }
    }

    it("SessionManager applies the fix after a cold restart and isolates native-provider clients", { timeout: 60_000 }, async () => {
        await harness(async ({ home, server }) => {
            const registry = new ModelProviderRegistry({ providers: [
                { id: "azure-v1", type: "openai", baseUrl: server.baseUrl + "/v1", apiKey: "synthetic-key", models: [MODEL] },
                { id: "anthropic", type: "anthropic", baseUrl: server.baseUrl, apiKey: "synthetic-key", models: ["claude-sonnet-5"] },
            ] });
            const sessionId = randomUUID();
            const config = { model: `azure-v1:${MODEL}` };
            let manager = new SessionManager(undefined, null, { modelProviders: registry }, join(home, "session-state"));
            // No facts are invoked by this transport-only fixture.
            const facts = { readFacts: async () => ({ count: 0, facts: [] }), storeFact: async () => ({ stored: true }), deleteFact: async () => ({ deleted: true }) };
            manager.setFactStore(facts);
            try {
                let session = await manager.getOrCreate(sessionId, config, { turnIndex: 0 });
                expect((await session.runTurn("Say hello")).content).toContain("violet-739");
                await manager.shutdown();
                manager = new SessionManager(undefined, null, { modelProviders: registry }, join(home, "session-state"));
                manager.setFactStore(facts);
                session = await manager.getOrCreate(sessionId, config, { turnIndex: 1 });
                expect((await session.runTurn("Recurring wake: say hello")).content).toContain("violet-739");
                const openAiClient = [...manager.clients.values()][0];
                // Never pretty-print a CopilotClient on failure: it contains
                // the child's environment, including inherited credentials.
                expect(manager.client === openAiClient).toBe(true);
                // Catalog-only seam: the real client above still owns turns.
                // A pool namespace must never be mistaken for a GitHub token
                // by vision lookups (NUL in an env token used to fail closed).
                openAiClient.listModels = async () => [{ id: MODEL, capabilities: { supports: { vision: true } } }];
                expect(await manager.getModelVisionInfo(`azure-v1:${MODEL}`, { sessionId })).toMatchObject({ known: true, vision: true });
                expect(manager.clients.size).toBe(1);
                session = await manager.getOrCreate(sessionId, { model: "anthropic:claude-sonnet-5" }, { turnIndex: 2 });
                expect((await session.runTurn("Say hello from the new provider")).content).toContain("violet-739");
                expect(manager.clients.size).toBe(2);
                expect([...manager.clients.values()].at(-1) === openAiClient).toBe(false);
                expect(server.requests.every(r => !Object.hasOwn(r.body, "snippy"))).toBe(true);
            } finally { await manager.shutdown(); }
        });
    });
});
