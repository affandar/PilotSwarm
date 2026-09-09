import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "../../src/session-manager.ts";
import { ModelProviderRegistry } from "../../src/model-providers.ts";
import { createNativeCopilotProvider } from "../helpers/native-copilot-provider.mjs";

const MODEL = "gpt-5.6-terra";
const parentRequest = body => body.tools?.some(t => t.function?.name === "ps_marker");
const nativeTask = overrides => ({ name: "task", args: {
    name: "probe", agent_type: "swarm-explore", description: "Inspect local fixture",
    prompt: "Inspect the assigned local fixture and return results", ...overrides,
} });
const facts = { readFacts: async () => ({ count: 0, facts: [] }), storeFact: async () => ({ stored: true }), deleteFact: async () => ({ deleted: true }) };

async function harness(respond, run, mode = "sync") {
    const home = mkdtempSync(join(tmpdir(), "ps-native-runtime-"));
    const server = await createNativeCopilotProvider((body, index) => respond(body, index, home));
    const registry = new ModelProviderRegistry({ providers: [{ id: "fixture", type: "openai", baseUrl: server.baseUrl, apiKey: "synthetic", models: [MODEL] }] });
    const sessionId = randomUUID();
    let leaked = 0;
    let manager;
    const config = { model: `fixture:${MODEL}`, workingDirectory: home };
    const createManager = () => {
        manager = new SessionManager(undefined, null, { nativeSubagents: mode, modelProviders: registry, turnTimeoutMs: 10_000 }, join(home, "session-state"));
        manager.setFactStore(facts);
        manager.setConfig(sessionId, { ...config, tools: [{
            name: "ps_marker", description: "Parent-only external tool", parameters: { type: "object", properties: {} },
            handler: () => { leaked++; return "EXTERNAL_TOOL_RAN"; },
        }] });
        return manager;
    };
    try {
        await run({ home, server, config, sessionId, createManager, leaks: () => leaked });
    } finally {
        await manager?.shutdown();
        await server.close();
        rmSync(home, { recursive: true, force: true });
    }
}

describe("native subagents (real Copilot SDK/CLI, scripted local inference)", () => {
    it("executes native view on the same worker, accounts usage, and survives warm/cold resume", { timeout: 40_000 }, async () => {
        await harness((body, index, home) => {
            if (index > 20) throw new Error("Unexpected tool loop");
            if (parentRequest(body)) return body.messages.at(-1).role === "tool"
                ? { content: `PARENT: ${body.messages.at(-1).content}` } : { tools: [nativeTask()] };
            return body.messages.at(-1).role === "tool"
                ? { content: `CHILD: ${body.messages.at(-1).content}` }
                : { tools: [{ name: "view", args: { path: join(home, "fixture.txt") } }] };
        }, async ({ home, server, config, sessionId, createManager, leaks }) => {
            writeFileSync(join(home, "fixture.txt"), "local-native-proof-739");
            let manager = createManager();
            for (let turn = 0; turn < 3; turn++) {
                if (turn === 2) { await manager.shutdown(); manager = createManager(); }
                const managed = await manager.getOrCreate(sessionId, config, { turnIndex: turn });
                const events = [];
                const result = await managed.runTurn(`Delegate inspection, turn ${turn}`, { onEvent: e => events.push(e) });
                expect(result.type).toBe("completed");
                expect(result.content).toContain("PARENT: CHILD:");
                expect(result.content).toContain("local-native-proof-739");
                expect(events.filter(e => e.eventType === "assistant.message" && e.data.content).every(e => e.data.content.startsWith("PARENT:"))).toBe(true);
                expect(events.some(e => e.eventType === "native.assistant.message")).toBe(true);
                expect(events.find(e => e.eventType === "subagent.started").data).toMatchObject({ agentName: "swarm-explore", executionMode: "sync", model: MODEL, nativeAgentId: expect.any(String) });
                const usage = events.filter(e => e.eventType === "assistant.usage");
                expect(usage.some(e => e.data.nativeAgentId)).toBe(true);
                expect(usage.reduce((n, e) => n + e.data.inputTokens, 0)).toBe(80);
                expect(usage.reduce((n, e) => n + e.data.outputTokens, 0)).toBe(20);
                expect((await managed.getCopilotSession().rpc.tasks.list()).tasks.filter(t => t.type === "agent")).toEqual([]);
            }
            const childRequests = server.requests.filter(body => !parentRequest(body));
            expect(childRequests.length).toBe(6);
            for (const request of childRequests) {
                expect(request.model).toBe(MODEL);
                const toolNames = request.tools.map(t => t.function?.name);
                for (const tool of ["ps_marker", "spawn_agent", "store_fact", "complete_agent", "task", "write_agent"]) expect(toolNames).not.toContain(tool);
            }
            expect(leaks()).toBe(0);
        });
    });

    it.each([
        { agent_type: "general-purpose" }, { mode: "background" }, { model: "foreign-model" },
    ])("runtime rejects a parent bypass %j before starting a child", { timeout: 20_000 }, async overrides => {
        await harness(body => body.messages.at(-1).role === "tool" ? { content: "HANDLED_DENIAL" } : { tools: [nativeTask(overrides)] },
            async ({ config, sessionId, createManager, server }) => {
                const managed = await createManager().getOrCreate(sessionId, config, { turnIndex: 0 });
                const events = [];
                expect((await managed.runTurn("try delegation", { onEvent: e => events.push(e) })).content).toBe("HANDLED_DENIAL");
                expect(events.some(e => e.eventType === "subagent.started")).toBe(false);
                expect(server.requests.every(parentRequest)).toBe(true);
            });
    });

    it("a fabricated external tool call from the child cannot invoke the parent's handler", { timeout: 20_000 }, async () => {
        await harness(body => {
            if (parentRequest(body)) return body.messages.at(-1).role === "tool" ? { content: "PARENT_DONE" } : { tools: [nativeTask()] };
            return body.messages.at(-1).role === "tool" ? { content: "CHILD_DENIED" } : { tools: [{ name: "ps_marker", args: {} }] };
        }, async ({ config, sessionId, createManager, leaks, server }) => {
            const managed = await createManager().getOrCreate(sessionId, config, { turnIndex: 0 });
            expect((await managed.runTurn("delegate")).content).toBe("PARENT_DONE");
            expect(leaks()).toBe(0);
            expect(server.requests.some(b => !parentRequest(b) && b.messages.at(-1).role === "tool")).toBe(true);
        });
    });

    it("keeps task disabled by default", { timeout: 20_000 }, async () => {
        await harness(() => ({ content: "NO_DELEGATION" }), async ({ config, sessionId, createManager, server }) => {
            const managed = await createManager().getOrCreate(sessionId, config, { turnIndex: 0 });
            expect((await managed.runTurn("hello")).content).toBe("NO_DELEGATION");
            expect(server.requests[0].tools.map(t => t.function?.name)).not.toContain("task");
        }, "off");
    });

    it("parent external tools still execute through the guarded per-turn handler map", { timeout: 20_000 }, async () => {
        await harness(body => body.messages.at(-1).role === "tool"
            ? { content: "PARENT_TOOL_OK" } : { tools: [{ name: "ps_marker", args: {} }] },
        async ({ config, sessionId, createManager, leaks }) => {
            const managed = await createManager().getOrCreate(sessionId, config, { turnIndex: 0 });
            expect((await managed.runTurn("call parent tool")).content).toBe("PARENT_TOOL_OK");
            expect(leaks()).toBe(1);
        });
    });

    it("stopping the parent terminates an executing child shell before returning", { timeout: 25_000 }, async () => {
        let pid;
        try {
            await harness((body, index, home) => {
                if (index > 8) throw new Error("Unexpected tool loop");
                if (parentRequest(body)) return body.messages.at(-1).role === "tool" ? { content: "PARENT_DONE" } : { tools: [nativeTask({ agent_type: "swarm-task" })] };
                const code = `require('fs').writeFileSync(${JSON.stringify(join(home, "child.pid"))},String(process.pid));setTimeout(()=>{},20000)`;
                const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
                return body.messages.at(-1).role === "tool" ? { content: "CHILD_DONE" }
                    : { tools: [{ name: "bash", args: { command: `${quote(process.execPath)} -e ${quote(code)}`, description: "Run cancellation fixture", mode: "sync" } }] };
            }, async ({ home, config, sessionId, createManager }) => {
                const managed = await createManager().getOrCreate(sessionId, config, { turnIndex: 0 });
                const turn = managed.runTurn("delegate command");
                const deadline = Date.now() + 6_000;
                while (!existsSync(join(home, "child.pid")) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
                expect(existsSync(join(home, "child.pid"))).toBe(true);
                pid = Number(readFileSync(join(home, "child.pid"), "utf8"));
                managed.requestStop("user");
                await managed.getCopilotSession().abort();
                expect((await turn).type).toBe("stopped");
                expect((await managed.getCopilotSession().rpc.tasks.list()).tasks.filter(t => t.type === "agent")).toEqual([]);
                // The process must be gone, not merely absent from task metadata.
                expect(() => process.kill(pid, 0)).toThrow();
                pid = undefined;
            });
        } finally { if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} } }
    });
});
