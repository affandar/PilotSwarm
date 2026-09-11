import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "../../src/session-manager.ts";
import { ModelProviderRegistry } from "../../src/model-providers.ts";
import { createNativeCopilotProvider } from "../helpers/native-copilot-provider.mjs";

const MODEL = "gpt-5.6-terra";
const systemPrompt = body => body.messages.filter(m => m.role === "system").map(m =>
    typeof m.content === "string" ? m.content : m.content.map(part => part.text ?? "").join("\n")).join("\n");
const toolNames = body => body.tools.map(t => t.function?.name);
const facts = { readFacts: async () => ({ count: 0, facts: [] }), storeFact: async () => ({ stored: true }), deleteFact: async () => ({ deleted: true }) };

describe("named-agent binding refresh (real Copilot SDK/CLI, scripted local inference)", () => {
    it("refreshes handlers in place, then changes instructions and declarations together on resume", { timeout: 60_000 }, async () => {
        const home = mkdtempSync(join(tmpdir(), "ps-agent-refresh-runtime-"));
        let phase = 0;
        const executed = [];
        const names = ["catalog", "catalog", "search_catalog", "search_catalog"];
        const server = await createNativeCopilotProvider(body => body.messages.at(-1).role === "tool"
            ? { content: `TURN_${phase}_COMPLETE` }
            : { tools: [{ name: names[phase], args: {} }] });
        const registry = new ModelProviderRegistry({ providers: [{ id: "fixture", type: "openai", baseUrl: server.baseUrl, apiKey: "synthetic", models: [MODEL] }] });
        const lookup = {};
        const sessionId = randomUUID();
        const manager = new SessionManager(undefined, null, {
            modelProviders: registry, agentPromptLookup: lookup, turnTimeoutMs: 20_000,
        }, join(home, "session-state"));
        manager.setFactStore(facts);
        const config = {
            model: `fixture:${MODEL}`, workingDirectory: home,
            boundAgentName: "analyst", boundAgentPackageId: "shared-package",
            detachedPackageToolPolicy: "reject", toolNames: ["catalog"],
        };
        function publish(version, name, prompt) {
            lookup.analyst = { prompt, kind: "app-agent", packageId: "shared-package", packageScope: "shared", toolNames: [name] };
            const tool = {
                name, description: "Inspect the fixture catalog", parameters: { type: "object", properties: {} },
                handler: async () => { executed.push(version); return `HANDLER_${version}`; },
            };
            manager.setToolRegistry(new Map([[name, tool]]), {
                byPackage: new Map([["shared-package", new Map([[name, tool]])]]), staticNames: new Set(),
            });
        }
        try {
            publish(0, "catalog", "AGENT_VERSION_ORIGINAL");
            let managed = await manager.getOrCreate(sessionId, config, { turnIndex: 0 });
            const firstHandle = managed.getCopilotSession();
            expect((await managed.runTurn("Inspect the catalog using the catalog tool.")).content).toBe("TURN_0_COMPLETE");
            expect(executed).toEqual([0]);
            expect(systemPrompt(server.requests[0])).toContain("AGENT_VERSION_ORIGINAL");

            phase = 1;
            publish(1, "catalog", "AGENT_VERSION_ORIGINAL");
            managed = await manager.getOrCreate(sessionId, config, { turnIndex: 1 });
            expect(managed.getCopilotSession()).toBe(firstHandle);
            expect((await managed.runTurn("Inspect it again using the catalog tool.")).content).toBe("TURN_1_COMPLETE");
            expect(executed).toEqual([0, 1]);
            expect(server.requests.some(body => body.messages.some(m => m.role === "tool" && String(m.content).includes("HANDLER_1")))).toBe(true);

            phase = 2;
            const changedStart = server.requests.length;
            publish(2, "search_catalog", "AGENT_VERSION_UPDATED");
            managed = await manager.getOrCreate(sessionId, config, { turnIndex: 2 });
            expect(managed.getCopilotSession()).not.toBe(firstHandle);
            expect((await managed.runTurn("Use the current catalog search capability.")).content).toBe("TURN_2_COMPLETE");
            const changed = server.requests[changedStart];
            expect(toolNames(changed)).toContain("search_catalog");
            expect(toolNames(changed)).not.toContain("catalog");
            expect(systemPrompt(changed)).toContain("AGENT_VERSION_UPDATED");
            expect(systemPrompt(changed)).not.toContain("AGENT_VERSION_ORIGINAL");
            expect(executed).toEqual([0, 1, 2]);

            delete lookup.analyst;
            manager.setToolRegistry(new Map(), { byPackage: new Map(), staticNames: new Set() });
            const beforeRemoval = server.requests.length;
            await expect(manager.getOrCreate(sessionId, config, { turnIndex: 3 })).rejects.toMatchObject({ code: "BOUND_AGENT_PACKAGE_UNAVAILABLE" });
            expect(manager.get(sessionId)).toBeNull();
            expect(server.requests.length).toBe(beforeRemoval);

            phase = 3;
            publish(3, "search_catalog", "AGENT_VERSION_REENABLED");
            managed = await manager.getOrCreate(sessionId, config, { turnIndex: 4 });
            expect((await managed.runTurn("Use the restored search capability.")).content).toBe("TURN_3_COMPLETE");
            expect(executed).toEqual([0, 1, 2, 3]);
            const restored = server.requests[beforeRemoval];
            expect(systemPrompt(restored)).toContain("AGENT_VERSION_REENABLED");
            expect(toolNames(restored)).not.toContain("catalog");
        } finally {
            await manager.shutdown();
            await server.close();
            rmSync(home, { recursive: true, force: true });
        }
    });
});

describe("queued named startup across package republish (real Copilot SDK/CLI)", () => {
    it.each([false, true])("preserves the queued startup obligation when original tool is still declared=%s", { timeout: 30_000 }, async preserved => {
        const home = mkdtempSync(join(tmpdir(), "ps-queued-startup-"));
        const called = [];
        const server = await createNativeCopilotProvider(body => body.messages.at(-1).role === "tool"
            ? { content: "STARTUP_VERIFIED" }
            : { tools: [{ name: "load_v1", args: {} }] });
        const registry = new ModelProviderRegistry({ providers: [{ id: "fixture", type: "openai", baseUrl: server.baseUrl,
            apiKey: "synthetic", models: [MODEL] }] });
        const lookup = { analyst: {
            prompt: "QUEUED_DEFINITION", kind: "app-agent", packageId: "pkg-startup", packageScope: "shared",
            toolNames: ["load_v1"], initialRequiredTool: "load_v1",
        } };
        const queuedStartup = lookup.analyst.initialRequiredTool;
        const sessionId = randomUUID();
        const config = { model: `fixture:${MODEL}`, workingDirectory: home,
            boundAgentName: "analyst", boundAgentPackageId: "pkg-startup", toolNames: ["load_v1"] };
        const manager = new SessionManager(undefined, null, { modelProviders: registry,
            agentPromptLookup: lookup, turnTimeoutMs: 10_000 }, join(home, "sessions"));
        manager.setFactStore(facts);
        // The package changes after the durable opening message was enqueued,
        // before any worker creates the child SDK session.
        lookup.analyst = { ...lookup.analyst, prompt: "REPUBLISHED_DEFINITION",
            toolNames: preserved ? ["load_v1", "load_v2"] : ["load_v2"], initialRequiredTool: "load_v2" };
        const exports = lookup.analyst.toolNames.map(name => ({ name,
            description: `Run ${name}`, parameters: { type: "object", properties: {} },
            handler: async () => { called.push(name); return `${name}_EXECUTED`; },
        }));
        manager.setToolRegistry(new Map(exports.map(tool => [tool.name, tool])), {
            byPackage: new Map([["pkg-startup", new Map(exports.map(tool => [tool.name, tool]))]]), staticNames: new Set(),
        });
        try {
            const session = await manager.getOrCreate(sessionId, config, { turnIndex: 0 });
            const result = await session.runTurn("Carry out the queued named-agent assignment", { requiredTool: queuedStartup });
            if (preserved) {
                expect(result).toMatchObject({ type: "completed", content: "STARTUP_VERIFIED" });
                expect(called).toEqual(["load_v1"]);
                expect(systemPrompt(server.requests[0])).toContain("REPUBLISHED_DEFINITION");
                expect(toolNames(server.requests[0])).toContain("load_v2");
            } else {
                expect(result).toMatchObject({ type: "error", retryable: false });
                expect(result.message).toContain("load_v1");
                expect(result.message).toMatch(/not available|unavailable/i);
                expect(server.requests).toHaveLength(0);
                expect(called).toEqual([]);
            }
        } finally {
            await manager.shutdown();
            await server.close();
            rmSync(home, { recursive: true, force: true });
        }
    });
});
