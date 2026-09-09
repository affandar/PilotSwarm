import { describe, it, expect, vi } from "vitest";
import { nativeSubagentHooks, resolveNativeSubagents, settleNativeSubagents, guardNativeExternalTools } from "../../src/native-subagents.ts";
import { ManagedSession } from "../../src/managed-session.ts";
import { SessionManager } from "../../src/session-manager.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODEL = "gpt-5.6-terra";
const task = { agent_type: "swarm-explore", prompt: "inspect", name: "probe", description: "Inspect workspace" };
const invoke = (toolArgs, hooks, extra = {}) => nativeSubagentHooks(MODEL, hooks).onPreToolUse(
    { toolName: "task", toolArgs, sessionId: "parent", ...extra }, { sessionId: "parent" });

describe("native delegation policy", () => {
    it("defaults off and rejects unknown deployment values", () => {
        expect(resolveNativeSubagents(null)).toBe("off");
        expect(resolveNativeSubagents("off")).toBe("off");
        expect(resolveNativeSubagents("sync")).toBe("sync");
        expect(() => resolveNativeSubagents("true")).toThrow(/off or sync/);
    });
    it("guards external callbacks even when they collide with native CLI tool names", async () => {
        const handler = vi.fn(() => "parent result");
        const [wrapped] = guardNativeExternalTools([{ name: "bash", handler }], "parent");
        expect(wrapped.handler({}, { sessionId: "parent" })).toBe("parent result");
        expect(() => wrapped.handler({}, { sessionId: "child" })).toThrow(/cannot invoke/);
        expect(handler).toHaveBeenCalledTimes(1);
    });
    it("pins sync and the admitted parent model", async () => {
        expect((await invoke(task)).modifiedArgs).toEqual({ ...task, mode: "sync", model: MODEL });
    });
    it.each([
        { mode: "background" }, { mode: "async" }, { agent_type: "explore" },
        { agent_type: "general-purpose" }, { model: "other-provider:model" },
        { reasoning_effort: "high" }, { context_tier: "long_context" },
    ])("denies unsafe task overrides %j", async overrides => {
        expect((await invoke({ ...task, ...overrides })).permissionDecision).toBe("deny");
    });
    it.each([null, "{}", [], 1])("rejects malformed task arguments %j", async args => {
        expect((await invoke(args)).permissionDecision).toBe("deny");
    });
    it("composes application hooks without allowing their rewrites to bypass policy", async () => {
        const deny = { permissionDecision: "deny", permissionDecisionReason: "application policy" };
        expect(await invoke(task, { onPreToolUse: () => deny })).toBe(deny);
        expect((await invoke(task, { onPreToolUse: () => ({ modifiedArgs: { ...task, mode: "background" } }) })).permissionDecision).toBe("deny");
        const result = await invoke(task, { onPreToolUse: () => ({ additionalContext: "retained", modifiedArgs: { ...task, prompt: "rewritten" } }) });
        expect(result).toMatchObject({ additionalContext: "retained", modifiedArgs: { prompt: "rewritten", mode: "sync" } });
    });
    it.each(["spawn_agent", "complete_agent", "store_fact", "wait", "ask_user", "ps_custom", "task"])("blocks child invocation of %s", async toolName => {
        expect((await invoke(task, undefined, { toolName, sessionId: "child" })).permissionDecision).toBe("deny");
    });
    it("allows parent durable tools while blocking child shell detachment", async () => {
        expect(await invoke({}, undefined, { toolName: "spawn_agent" })).toBeUndefined();
        expect(await invoke({ mode: "sync" }, undefined, { toolName: "bash", sessionId: "child" })).toBeUndefined();
        for (const args of [{ mode: "async" }, { detach: true }]) {
            expect((await invoke(args, undefined, { toolName: "bash", sessionId: "child" })).permissionDecision).toBe("deny");
        }
        expect((await invoke({}, undefined, { toolName: "write_agent" })).permissionDecision).toBe("deny");
    });
});

class FakeSession {
    handlers = [];
    tasks = [];
    rpc = { tasks: {
        list: async () => ({ tasks: this.tasks }),
        cancel: async ({ id }) => { this.tasks.find(t => t.id === id).status = "cancelled"; return { cancelled: true }; },
        remove: async ({ id }) => { this.tasks = this.tasks.filter(t => t.id !== id); return { removed: true }; },
    } };
    on(type, callback) {
        const entry = typeof type === "function" ? { callback: type } : { type, callback };
        this.handlers.push(entry);
        return () => { this.handlers = this.handlers.filter(h => h !== entry); };
    }
    emit(type, data = {}, agentId) {
        for (const h of [...this.handlers]) if (!h.type || h.type === type) h.callback({ type, data, agentId });
    }
    registerTools() {}
    async abort() { this.emit("session.idle"); }
    async send() {}
}

describe("native turn boundaries", () => {
    it("projects task milestones without persisting empty registry notifications or live ticks", async () => {
        const sdk = new FakeSession();
        const events = [];
        sdk.send = async () => {
            sdk.emit("tool.execution_start", { toolName: "task", toolCallId: "call", arguments: task });
            sdk.emit("subagent.started", { toolCallId: "call", agentName: "swarm-explore" }, "child");
            for (let i = 0; i < 20; i++) sdk.emit("session.background_tasks_changed");
            sdk.emit("subagent.completed", { toolCallId: "call", totalToolCalls: 4 }, "child");
            sdk.emit("tool.execution_complete", { toolCallId: "call", success: true, result: { content: "Findings" } });
            sdk.emit("assistant.message", { content: "Parent answer" });
            sdk.emit("session.idle");
        };
        const result = await new ManagedSession("test", sdk, { nativeSubagents: "sync" }).runTurn("go", {
            turnIndex: 3, onEvent: event => events.push(event),
        });
        expect(result.content).toBe("Parent answer");
        expect(events.some(event => event.eventType === "session.background_tasks_changed")).toBe(false);
        expect(result.events.some(event => event.eventType === "session.native_tasks_tick")).toBe(false);
        const snapshot = events.findLast(event => event.eventType === "session.native_tasks_tick").data;
        expect(snapshot).toMatchObject({ phase: "idle", turnIndex: 3, tasks: [{ id: "call", status: "completed", result: "Findings", toolCalls: 4 }] });
        expect(result.events.findLast(event => event.eventType === "native.task_updated").data).toMatchObject({ id: "call", status: "completed", result: "Findings" });
    });
    it("isolates interleaved child messages, reasoning, tools and idle; retains usage", async () => {
        const sdk = new FakeSession();
        const events = [], deltas = [], tools = [];
        sdk.send = async () => {
            sdk.emit("assistant.turn_start");
            sdk.emit("assistant.message_delta", { messageId: "root", deltaContent: "PARENT" });
            for (const [type, data] of [
                ["assistant.turn_start", {}],
                ["assistant.reasoning_delta", { deltaContent: "CHILD_REASONING" }],
                ["assistant.reasoning", { content: "CHILD_REASONING" }],
                ["assistant.message_delta", { deltaContent: "CHILD" }],
                ["tool.execution_start", { toolName: "sensitive_parent_tool" }],
                ["assistant.message", { content: "CHILD" }],
                ["assistant.usage", { inputTokens: 20, outputTokens: 5, model: MODEL }],
                ["assistant.turn_end", {}], ["session.idle", {}],
            ]) sdk.emit(type, data, "native-child");
            // A child idle must not settle the turn before the parent's answer.
            setTimeout(() => {
                sdk.emit("assistant.message", { content: "PARENT", messageId: "root" });
                sdk.emit("assistant.turn_end");
                sdk.emit("session.idle");
            }, 15);
        };
        const result = await new ManagedSession("test", sdk, { nativeSubagents: "sync" }).runTurn("go", {
            liveTurn: true, onEvent: e => events.push(e), onDelta: d => deltas.push(d), onToolStart: t => tools.push(t),
        });
        expect(result.content).toBe("PARENT");
        expect(deltas).toEqual(["PARENT"]);
        expect(tools).toEqual([]);
        expect(events.filter(e => e.eventType === "assistant.message").map(e => e.data.content)).toEqual(["PARENT"]);
        expect(events.find(e => e.eventType === "assistant.usage").data.nativeAgentId).toBe("native-child");
        expect(events.filter(e => e.eventType === "assistant.live_tick").every(e => !JSON.stringify(e).includes("CHILD"))).toBe(true);
        expect(events.find(e => e.eventType === "assistant.turn_end").data.streamingChars).toBe(6);
    });
    it("retires idle agents and leaves unrelated parent shell tasks alone", async () => {
        const sdk = new FakeSession();
        sdk.tasks = [{ type: "agent", id: "a", status: "idle" }, { type: "shell", id: "s", status: "running" }];
        await settleNativeSubagents(sdk);
        expect(sdk.tasks).toEqual([{ type: "shell", id: "s", status: "running" }]);
    });
    it("cancels but fails a successful turn that left a running native agent", async () => {
        const sdk = new FakeSession();
        sdk.tasks = [{ type: "agent", id: "a", status: "running" }];
        await expect(settleNativeSubagents(sdk, { rejectRunning: true })).rejects.toThrow(/contract violated/);
        expect(sdk.tasks).toEqual([]);
    });
    it("fails closed when cancellation is refused or task RPC hangs", async () => {
        const sdk = new FakeSession();
        sdk.tasks = [{ type: "agent", id: "a", status: "running" }];
        sdk.rpc.tasks.cancel = async () => ({ cancelled: false });
        await expect(settleNativeSubagents(sdk)).rejects.toThrow(/still active/);
        sdk.rpc.tasks.list = () => new Promise(() => {});
        await expect(settleNativeSubagents(sdk, { timeoutMs: 10 })).rejects.toThrow(/cannot commit/);
    });
    it("does not swallow cleanup failure when the user stopped the parent", async () => {
        const sdk = new FakeSession();
        const managed = new ManagedSession("test", sdk, { nativeSubagents: "sync" });
        sdk.send = async () => {
            sdk.tasks = [{ type: "agent", id: "a", status: "running" }];
            sdk.rpc.tasks.cancel = async () => ({ cancelled: false });
            managed.requestStop("user");
            sdk.emit("session.idle");
        };
        await expect(managed.runTurn("go")).rejects.toThrow(/still active/);
        expect(managed.getActiveTurn()).toBeNull();
    });
    it("honors a stop arriving during native cleanup", async () => {
        const sdk = new FakeSession();
        const managed = new ManagedSession("test", sdk, { nativeSubagents: "sync" });
        sdk.rpc.tasks.cancel = async () => {
            managed.requestStop("stopped during cleanup");
            sdk.tasks[0].status = "cancelled";
            return { cancelled: true };
        };
        sdk.send = async () => {
            sdk.tasks = [{ type: "agent", id: "a", status: "idle" }];
            sdk.emit("assistant.message", { content: "done" });
            sdk.emit("session.idle");
        };
        expect(await managed.runTurn("go")).toMatchObject({ type: "stopped", reason: "stopped during cleanup" });
    });
    it("a timed-out task list cannot later cancel a subsequent turn's agents", async () => {
        const sdk = new FakeSession();
        let release;
        sdk.rpc.tasks.list = () => new Promise(resolve => { release = resolve; });
        sdk.rpc.tasks.cancel = vi.fn();
        await expect(settleNativeSubagents(sdk, { timeoutMs: 10 })).rejects.toThrow(/timed out/);
        release({ tasks: [{ type: "agent", id: "later-agent", status: "running" }] });
        await new Promise(resolve => setImmediate(resolve));
        expect(sdk.rpc.tasks.cancel).not.toHaveBeenCalled();
    });
    it("does not use experimental task RPC when disabled and rebinds on a mode change", async () => {
        const sdk = new FakeSession();
        sdk.rpc.tasks.list = vi.fn(() => { throw new Error("must not call"); });
        sdk.send = async () => { sdk.emit("assistant.message", { content: "OK" }); sdk.emit("session.idle"); };
        const managed = new ManagedSession("test", sdk, { model: MODEL });
        expect((await managed.runTurn("go")).content).toBe("OK");
        expect(sdk.rpc.tasks.list).not.toHaveBeenCalled();
        expect(managed.requiresModelRebind({ model: MODEL, nativeSubagents: "sync" })).toBe(true);
    });
});

describe("worker session assembly", () => {
    it.each([
        [{}, true],
        [{ agentIdentity: "agent-tuner" }, false],
        [{ agentIdentity: "regen-distiller" }, false],
        [{ promptLayering: { kind: "pilotswarm-system-agent" } }, false],
    ])("applies native policy only to eligible sessions %j", async (config, enabled) => {
        const home = mkdtempSync(join(tmpdir(), "ps-native-config-"));
        const manager = new SessionManager(undefined, null, {
            nativeSubagents: "sync", customAgents: [{ name: "durable-agent", prompt: "Use complete_agent" }],
        }, join(home, "session-state"));
        manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
        const created = [];
        manager.client = {
            createSession: async options => { created.push(options); return new FakeSession(); },
            stop: async () => {},
        };
        try {
            await manager.getOrCreate("native-config", {
                model: MODEL, systemMessage: { content: "APP_CONTEXT" }, turnSystemPrompt: "LEGACY_TURN_NOTE", ...config,
            }, { turnIndex: 0 });
            const options = created[0];
            expect(options.excludedTools.includes("task")).toBe(!enabled);
            expect(options.customAgents.map(a => a.name)).toEqual(enabled ? ["swarm-explore", "swarm-task"] : ["durable-agent"]);
            expect(options.customAgentsLocalOnly === true).toBe(enabled);
            const transform = options.systemMessage.sections.last_instructions.action;
            expect(typeof transform).toBe("function");
            const rendered = await transform("COPILOT_LAST_INSTRUCTIONS");
            expect(rendered).toContain("COPILOT_LAST_INSTRUCTIONS");
            expect(rendered).toContain("APP_CONTEXT");
            expect(rendered).toContain("LEGACY_TURN_NOTE");
            expect(rendered.includes("## Native local delegation")).toBe(enabled);
        } finally { await manager.shutdown(); rmSync(home, { recursive: true, force: true }); }
    });
});
