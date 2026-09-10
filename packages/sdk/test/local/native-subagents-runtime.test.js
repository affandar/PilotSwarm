import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "../../src/session-manager.ts";
import { ModelProviderRegistry } from "../../src/model-providers.ts";
import { createNativeCopilotProvider } from "../helpers/native-copilot-provider.mjs";

import { createFeaturePolicy } from "../helpers/feature-policy.mjs";

const MODEL = "gpt-5.6-terra";
const CRITIC_MODEL = "claude-sonnet-5";
const parentRequest = body => body.tools?.some(t => t.function?.name === "ps_marker");
const systemPrompt = body => body.messages.filter(m => m.role === "system").map(m =>
    typeof m.content === "string" ? m.content : m.content.map(part => part.text ?? "").join("\n")).join("\n");
const nativeTask = overrides => ({ name: "task", args: {
    name: "probe", agent_type: "swarm-explore", description: "Inspect local fixture",
    prompt: "Inspect the assigned local fixture and return results", ...overrides,
} });
const facts = { readFacts: async () => ({ count: 0, facts: [] }), storeFact: async () => ({ stored: true }), deleteFact: async () => ({ deleted: true }) };
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const nodeShell = (code, description) => ({ name: "bash", args: {
    command: `${shellQuote(process.execPath)} -e ${shellQuote(code)}`, description, mode: "sync",
} });
const toolOutput = event => event.data?.result?.detailedContent ?? event.data?.result?.content ?? "";
const assertNativeIsolation = requests => {
    const nativeRequests = requests.filter(body => !parentRequest(body));
    expect(nativeRequests.length).toBeGreaterThan(0);
    for (const request of nativeRequests) {
        const names = request.tools.map(tool => tool.function?.name);
        expect(names).toContain("bash");
        for (const forbidden of ["ps_marker", "spawn_agent", "store_fact", "complete_agent", "task", "write_agent"]) {
            expect(names).not.toContain(forbidden);
        }
    }
};

async function harness(respond, run, mode = "sync") {
    const home = mkdtempSync(join(tmpdir(), "ps-native-runtime-"));
    const server = await createNativeCopilotProvider((body, index) => respond(body, index, home));
    const registry = new ModelProviderRegistry({ providers: [{ id: "fixture", type: "openai", baseUrl: server.baseUrl, apiKey: "synthetic", models: [MODEL, CRITIC_MODEL] }] });
    const sessionId = randomUUID();
    let leaked = 0;
    let manager;
    const config = { model: `fixture:${MODEL}`, workingDirectory: home };
    const policy = await createFeaturePolicy();
    const createManager = (nativeMode = mode) => {
        manager = new SessionManager(undefined, null, { nativeSubagents: nativeMode, modelProviders: registry, turnTimeoutMs: config.turnTimeoutMs ?? 10_000 }, join(home, "session-state"));
        manager.setFeatureFlagCache(policy.cache);
        manager.setFactStore(facts);
        manager.setConfig(sessionId, { ...config, tools: [{
            name: "ps_marker", description: "Parent-only external tool", parameters: { type: "object", properties: {} },
            handler: () => { leaked++; return "EXTERNAL_TOOL_RAN"; },
        }] });
        return manager;
    };
    try {
        await run({ home, server, config, sessionId, createManager, policy, leaks: () => leaked });
    } finally {
        await manager?.shutdown();
        await policy.cache.stop();
        await server.close();
        rmSync(home, { recursive: true, force: true });
    }
}

describe("native subagents (real Copilot SDK/CLI, scripted local inference)", () => {
    it("runs a read-only rubber-duck critique and rejects a fabricated shell mutation", { timeout: 30_000 }, async () => {
        let childStage = 0;
        const evidence = `CRITIC_READ_PROOF_${randomUUID()}`;
        const rejectedResults = [];
        await harness((body, index, home) => {
            if (index > 12) throw new Error("Unexpected native critic tool loop");
            if (parentRequest(body)) return body.messages.at(-1).role === "tool"
                ? { content: `PARENT: ${body.messages.at(-1).content}` }
                : { tools: [nativeTask({ agent_type: "swarm-rubber-duck", prompt: "Critique the local critic-fixture.txt file using its actual contents." })] };
            if (childStage++ === 0) return { tools: [nodeShell(
                "require('fs').writeFileSync('critic-fixture.txt','MUTATED_BY_CRITIC')", "Attempt forbidden critic shell edit")] };
            if (childStage === 2) {
                rejectedResults.push(body.messages.at(-1));
                return { tools: [{ name: "view", args: { path: join(home, "critic-fixture.txt") } }] };
            }
            return { content: `CRITIQUE: ${body.messages.at(-1).content}` };
        }, async ({ home, server, config, sessionId, createManager, leaks }) => {
            writeFileSync(join(home, "critic-fixture.txt"), evidence);
            const manager = createManager();
            // Transport-only fixture: select an explicit model without real
            // GitHub credentials. This is not production BYOK critic support;
            // the unstubbed BYOK denial is verified separately below.
            manager._resolveNativeCriticModel = async () => CRITIC_MODEL;
            const managed = await manager.getOrCreate(sessionId, config, { turnIndex: 0 });
            const events = [];
            const result = await managed.runTurn("Use the native critic to inspect the local fixture", { onEvent: event => events.push(event) });
            expect(result.type).toBe("completed");
            expect(result.content).toContain(`PARENT:`);
            expect(result.content).toContain("CRITIQUE:");
            expect(result.content).toContain(evidence);
            expect(readFileSync(join(home, "critic-fixture.txt"), "utf8")).toBe(evidence);
            expect(rejectedResults).toHaveLength(1);
            expect(rejectedResults[0].role).toBe("tool");
            expect(String(rejectedResults[0].content)).toContain("Tool 'bash' does not exist.");
            const requests = server.requests.filter(body => !parentRequest(body));
            expect(requests.length).toBeGreaterThanOrEqual(3);
            for (const request of requests) {
                expect(request.model).toBe(CRITIC_MODEL);
                const names = request.tools.map(tool => tool.function?.name);
                expect(names).toContain("view");
                expect(names.every(name => ["view", "grep", "rg", "glob"].includes(name))).toBe(true);
                for (const name of ["bash", "powershell", "edit", "create", "ps_marker", "spawn_agent", "store_fact", "complete_agent", "task", "write_agent"]) {
                    expect(names).not.toContain(name);
                }
            }
            expect(events.find(event => event.eventType === "subagent.started")?.data).toMatchObject({
                agentName: "swarm-rubber-duck", executionMode: "sync", model: CRITIC_MODEL,
            });
            expect(events.find(event => event.eventType === "subagent.configured")?.data.model).toBe(CRITIC_MODEL);
            expect(events.find(event => event.eventType === "subagent.completed")?.data.firstDispatchedModel).toBe(CRITIC_MODEL);
            expect(events.filter(event => event.eventType === "native.task_updated").at(-1)?.data)
                .toMatchObject({ model: CRITIC_MODEL, status: "completed" });
            expect(events.filter(event => event.eventType === "native.tool.execution_complete" && event.data.toolName === "view")
                .some(event => event.data.success === true && toolOutput(event).includes(evidence))).toBe(true);
            expect(leaks()).toBe(0);
            expect((await managed.getCopilotSession().rpc.tasks.list()).tasks.filter(task => task.type === "agent")).toEqual([]);
        });
    });

    it("BYOK keeps ordinary native tasks available but denies the complementary-model critic", { timeout: 20_000 }, async () => {
        await harness(body => body.messages.at(-1).role === "tool"
            ? { content: "BYOK_CRITIC_UNAVAILABLE" } : { tools: [nativeTask({ agent_type: "swarm-rubber-duck" })] },
        async ({ config, sessionId, createManager, server }) => {
            // Use the actual SessionManager provider gate. No selection stub.
            const managed = await createManager().getOrCreate(sessionId, config, { turnIndex: 0 });
            const events = [];
            expect((await managed.runTurn("Try a complementary critic on BYOK", { onEvent: event => events.push(event) })).content).toBe("BYOK_CRITIC_UNAVAILABLE");
            expect(server.requests[0].tools.some(tool => tool.function?.name === "task")).toBe(true);
            expect(server.requests.every(parentRequest)).toBe(true);
            expect(events.some(event => event.eventType === "subagent.started")).toBe(false);
            expect(events.find(event => event.eventType === "tool.execution_complete" && event.data.toolName === "task")?.data.success).toBe(false);
            const agentNames = (await managed.getCopilotSession().rpc.agent.list()).agents.map(agent => agent.name);
            expect(agentNames).toContain("swarm-explore");
            expect(agentNames).toContain("swarm-task");
            expect(agentNames).not.toContain("swarm-rubber-duck");
        });
    });

    it("feature policy OFF prevents native critic execution even when the model fabricates a task call", { timeout: 20_000 }, async () => {
        await harness(body => body.messages.at(-1).role === "tool"
            ? { content: "CRITIC_DISABLED" } : { tools: [nativeTask({ agent_type: "swarm-rubber-duck" })] },
        async ({ policy, config, sessionId, createManager, server }) => {
            await policy.set(false);
            const managed = await createManager().getOrCreate(sessionId, config, { turnIndex: 0 });
            const events = [];
            expect((await managed.runTurn("Try the native critic while disabled", { onEvent: event => events.push(event) })).content).toBe("CRITIC_DISABLED");
            expect(server.requests.every(parentRequest)).toBe(true);
            expect(events.some(event => event.eventType === "subagent.started")).toBe(false);
            const denied = events.find(event => event.eventType === "tool.execution_complete" && event.data.toolName === "task");
            expect(denied?.data.success).toBe(false);
            const agentNames = (await managed.getCopilotSession().rpc.agent.list()).agents.map(agent => agent.name);
            expect(agentNames).not.toContain("swarm-rubber-duck");
            expect(systemPrompt(server.requests[0])).not.toContain("swarm-rubber-duck");
        });
    });

    it.each(["cluster", "user"])("applies %s OFF during native work, latches denial across ON, and rebinds warm/cold turns", { timeout: 60_000 }, async scope => {
        let phase = "revoke", parentStage = 0, policy, proofNonce = randomUUID();
        await harness(async (body) => {
            if (parentRequest(body)) {
                if (phase === "off") {
                    // A newly enabled flag must not add tools to the running turn.
                    if (parentStage++ === 0) {
                        await policy.set(true);
                        return { tools: [nativeTask({ agent_type: "swarm-task" })] };
                    }
                    return { content: "OFF_TURN_FINISHED" };
                }
                if (phase === "revoke") return parentStage++ < 2
                    ? { tools: [nativeTask({ agent_type: "swarm-task" })] }
                    : { content: "REVOCATION_FINISHED" };
                return body.messages.at(-1).role === "tool"
                    ? { content: "ENABLED_TURN_FINISHED" } : { tools: [nativeTask({ agent_type: "swarm-task" })] };
            }
            if (body.messages.at(-1).role === "tool") return { content: "ADMITTED_NATIVE_FINISHED" };
            if (phase === "revoke") { await policy.set(false); await policy.set(true); }
            return { tools: [nodeShell(`require('fs').writeFileSync('admitted-proof.txt',${JSON.stringify(proofNonce)})`, "Finish admitted local work")] };
        }, async ({ home, server, config, sessionId, createManager, policy: fixturePolicy }) => {
            const owner = { provider: "test", subject: "native-policy-owner" };
            policy = scope === "user" ? { set: value => fixturePolicy.setForUser(owner, value) } : fixturePolicy;
            await policy.set(true);
            const configuredManager = () => {
                const manager = createManager();
                if (scope === "user") manager.setSessionCatalog({ getSession: async () => ({ owner }), recordEvents: async () => {}, getUserRole: async () => ({ role: "user", seenAt: new Date() }) });
                return manager;
            };
            let manager = configuredManager();
            let managed = await manager.getOrCreate(sessionId, config, { turnIndex: 0 });
            const events = [];
            expect((await managed.runTurn("Delegate twice", { onEvent: event => events.push(event) })).type).toBe("completed");
            expect(readFileSync(join(home, "admitted-proof.txt"), "utf8")).toBe(proofNonce);
            expect(events.filter(e => e.eventType === "subagent.started")).toHaveLength(1);
            const denied = events.filter(e => e.eventType === "tool.execution_complete" && e.data.toolName === "task").at(-1);
            expect(denied?.data.success).toBe(false);
            expect(JSON.stringify(denied.data)).toContain("Native tasks are disabled by current feature policy for this turn");
            expect((await managed.getCopilotSession().rpc.tasks.list()).tasks.filter(t => t.type === "agent")).toEqual([]);
            // ON after revocation is available next turn, preserving session identity.
            for (let turn = 1; turn <= 5; turn++) {
                phase = turn % 2 ? "enabled" : "off";
                parentStage = 0; proofNonce = randomUUID();
                rmSync(join(home, "admitted-proof.txt"), { force: true });
                if (phase === "off") await policy.set(false);
                if (turn === 4) { await manager.shutdown(); manager = configuredManager(); }
                const start = server.requests.length;
                managed = await manager.getOrCreate(sessionId, config, { turnIndex: turn });
                const turnEvents = [];
                const result = await managed.runTurn(`Policy transition turn ${turn}`, { onEvent: event => turnEvents.push(event) });
                expect(result.type).toBe("completed");
                const parent = server.requests.slice(start).find(parentRequest);
                expect(parent.tools.some(t => t.function?.name === "task")).toBe(phase === "enabled");
                expect(systemPrompt(parent).includes("## Native local delegation")).toBe(phase === "enabled");
                expect(managed.getCopilotSession().sessionId).toBe(sessionId);
                const task = turnEvents.find(e => e.eventType === "tool.execution_complete" && e.data.toolName === "task");
                expect(task?.data.success).toBe(phase === "enabled");
                if (phase === "enabled") {
                    expect(server.requests.slice(start).filter(body => !parentRequest(body)).length).toBeGreaterThan(0);
                    expect(readFileSync(join(home, "admitted-proof.txt"), "utf8")).toBe(proofNonce);
                } else {
                    expect(server.requests.slice(start).filter(body => !parentRequest(body))).toHaveLength(0);
                    expect(existsSync(join(home, "admitted-proof.txt"))).toBe(false);
                }
                expect((await managed.getCopilotSession().rpc.tasks.list()).tasks.filter(t => t.type === "agent")).toEqual([]);
            }
        });
    });

    it("shares parent-created files bidirectionally with two native workers during the turn", { timeout: 40_000 }, async () => {
        let parentStage = 0;
        const createProof = `const fs=require('fs'); const proof={nonce:require('crypto').randomUUID(),cwd:fs.realpathSync('.'),steps:['parent']}; fs.writeFileSync('shared-proof.json',JSON.stringify(proof)); console.log('PARENT_CREATED='+JSON.stringify(proof));`;
        const editProof = `const fs=require('fs'); const proof=JSON.parse(fs.readFileSync('shared-proof.json','utf8')); require('assert').strictEqual(proof.cwd,fs.realpathSync('.')); proof.nativeNonce=require('crypto').randomUUID(); proof.steps.push('native-one'); fs.writeFileSync('shared-proof.json',JSON.stringify(proof)); console.log('NATIVE_ONE_EDITED='+JSON.stringify(proof));`;
        const observeProof = `const fs=require('fs'); const proof=JSON.parse(fs.readFileSync('shared-proof.json','utf8')); require('assert').deepStrictEqual(proof.steps,['parent','native-one']); require('assert').strictEqual(proof.cwd,fs.realpathSync('.')); proof.steps.push('native-two'); fs.writeFileSync('native-observation.json',JSON.stringify(proof)); fs.writeFileSync('shared-proof.json',JSON.stringify(proof)); console.log('NATIVE_TWO_OBSERVED='+JSON.stringify(proof));`;
        const verifyProof = `const fs=require('fs'),assert=require('assert'); const proof=JSON.parse(fs.readFileSync('shared-proof.json','utf8')); const observation=JSON.parse(fs.readFileSync('native-observation.json','utf8')); assert.deepStrictEqual(proof,observation); assert.deepStrictEqual(proof.steps,['parent','native-one','native-two']); assert.strictEqual(proof.cwd,fs.realpathSync('.')); fs.writeFileSync('parent-verification.json',JSON.stringify({proof,cwd:fs.realpathSync('.')})); console.log('PARENT_VERIFIED='+JSON.stringify(proof));`;
        await harness((body, index) => {
            if (index > 16) throw new Error("Unexpected filesystem proof loop");
            if (parentRequest(body)) {
                switch (parentStage++) {
                    case 0: return { tools: [nodeShell(createProof, "Create proof inside parent turn")] };
                    case 1: return { tools: [nativeTask({ agent_type: "swarm-task", name: "first-writer", prompt: "NATIVE_STAGE_ONE: edit the parent's relative file", description: "Modify shared proof" })] };
                    case 2: return { tools: [nativeTask({ agent_type: "swarm-task", name: "second-reader", prompt: "NATIVE_STAGE_TWO: inspect the first native worker's relative file", description: "Verify first native output" })] };
                    case 3: return { tools: [nodeShell(verifyProof, "Independently verify child edits in parent shell")] };
                    default: return { content: "PARENT_VERIFICATION_FINISHED" };
                }
            }
            if (body.messages.at(-1).role === "tool") return { content: "NATIVE_WORK_FINISHED" };
            const prompt = JSON.stringify(body.messages.filter(message => message.role === "user"));
            return { tools: [prompt.includes("NATIVE_STAGE_ONE")
                ? nodeShell(editProof, "Read parent file and write native proof")
                : nodeShell(observeProof, "Read first native edit in second worker")] };
        }, async ({ home, config, sessionId, createManager, server, leaks }) => {
            config.turnTimeoutMs = 30_000;
            const managed = await createManager().getOrCreate(sessionId, config, { turnIndex: 0 });
            const events = [];
            const result = await managed.runTurn("Create proof, delegate two workers, and independently verify their changes", { onEvent: event => events.push(event) });
            expect(result.type).toBe("completed");
            const proof = JSON.parse(readFileSync(join(home, "shared-proof.json"), "utf8"));
            const observed = JSON.parse(readFileSync(join(home, "native-observation.json"), "utf8"));
            const verified = JSON.parse(readFileSync(join(home, "parent-verification.json"), "utf8"));
            expect(proof).toMatchObject({ cwd: realpathSync(home), steps: ["parent", "native-one", "native-two"] });
            expect(proof.nonce).toMatch(/^[\da-f-]{36}$/);
            expect(proof.nativeNonce).toMatch(/^[\da-f-]{36}$/);
            expect(proof.nativeNonce).not.toBe(proof.nonce);
            expect(observed).toEqual(proof);
            expect(verified).toEqual({ proof, cwd: realpathSync(home) });
            const parentShellResults = events.filter(event => event.eventType === "tool.execution_complete" && event.data.toolName === "bash");
            const nativeShellResults = events.filter(event => event.eventType === "native.tool.execution_complete" && event.data.toolName === "bash");
            expect(parentShellResults).toHaveLength(2);
            expect(nativeShellResults).toHaveLength(2);
            expect(parentShellResults.every(event => event.data.success === true)).toBe(true);
            expect(nativeShellResults.every(event => event.data.success === true)).toBe(true);
            expect(toolOutput(parentShellResults[0])).toContain(`PARENT_CREATED={"nonce":"${proof.nonce}"`);
            expect(toolOutput(parentShellResults[1])).toContain(`PARENT_VERIFIED=${JSON.stringify(proof)}`);
            expect(toolOutput(nativeShellResults[0])).toContain(`"nativeNonce":"${proof.nativeNonce}"`);
            expect(toolOutput(nativeShellResults[1])).toContain(`NATIVE_TWO_OBSERVED=${JSON.stringify(proof)}`);
            const starts = events.filter(event => event.eventType === "subagent.started");
            expect(starts).toHaveLength(2);
            expect(new Set(starts.map(event => event.data.nativeAgentId)).size).toBe(2);
            expect(starts.every(event => event.data.agentName === "swarm-task")).toBe(true);
            expect((await managed.getCopilotSession().rpc.tasks.list()).tasks.filter(task => task.type === "agent")).toEqual([]);
            assertNativeIsolation(server.requests);
            expect(leaks()).toBe(0);
        });
    });
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
            config.systemMessage = { content: "RUNTIME_CONTEXT" };
            config.turnSystemPrompt = "TURN_NOTE_IN_USER_PROMPT";
            config.systemContextInPrompt = true;
            let manager = createManager();
            for (let turn = 0; turn < 3; turn++) {
                if (turn === 2) { await manager.shutdown(); manager = createManager(); }
                const requestStart = server.requests.length;
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
                // Inspect actual inference requests, after SDK callback extraction
                // and CLI prompt composition, on create, warm reuse, and cold resume.
                const parentPrompts = server.requests.slice(requestStart).filter(parentRequest).map(systemPrompt);
                expect(parentPrompts.length).toBeGreaterThan(0);
                for (const prompt of parentPrompts) {
                    expect(prompt.split("## Native local delegation")).toHaveLength(2);
                    expect(prompt).toContain('task(agent_type="swarm-explore", mode="sync")');
                    expect(prompt).toContain("Omit the model, reasoning_effort, and context_tier arguments");
                    expect(prompt).toContain("RUNTIME_CONTEXT");
                    expect(prompt).not.toContain("TURN_NOTE_IN_USER_PROMPT");
                }
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

    it("keeps native working directories distinct across concurrent sessions and warm reuse", { timeout: 40_000 }, async () => {
        await harness((body, index) => {
            if (index > 20) throw new Error("Unexpected working-directory proof loop");
            const prompt = JSON.stringify(body.messages.filter(message => message.role === "user"));
            const marker = prompt.includes("FILESYSTEM_SESSION_A") ? "FILESYSTEM_SESSION_A" : "FILESYSTEM_SESSION_B";
            if (parentRequest(body)) return body.messages.at(-1).role === "tool"
                ? { content: "PARENT_DIRECTORY_CHECK_FINISHED" }
                : { tools: [nativeTask({ agent_type: "swarm-task", name: "directory-check", prompt: `${marker}: verify relative files in this session's working directory` })] };
            if (body.messages.at(-1).role === "tool") return { content: "NATIVE_DIRECTORY_CHECK_FINISHED" };
            const code = `const fs=require('fs'),assert=require('assert'); const identity=fs.readFileSync('identity.txt','utf8'); assert.strictEqual(identity,${JSON.stringify(marker)}); const proof={identity,cwd:fs.realpathSync('.')}; fs.writeFileSync('native-visit.json',JSON.stringify(proof)); console.log('DIRECTORY_VERIFIED='+JSON.stringify(proof));`;
            return { tools: [nodeShell(code, "Verify this session's relative files")] };
        }, async ({ home, config, sessionId, createManager, server, leaks }) => {
            const directoryA = join(home, "session-a");
            const directoryB = join(home, "session-b");
            mkdirSync(directoryA);
            mkdirSync(directoryB);
            writeFileSync(join(directoryA, "identity.txt"), "FILESYSTEM_SESSION_A");
            writeFileSync(join(directoryB, "identity.txt"), "FILESYSTEM_SESSION_B");
            config.workingDirectory = directoryA;
            config.turnTimeoutMs = 30_000;
            const manager = createManager();
            const secondId = randomUUID();
            const secondConfig = { model: config.model, workingDirectory: directoryB, turnTimeoutMs: 30_000 };
            manager.setConfig(secondId, { ...secondConfig, tools: [{ name: "ps_marker", description: "Parent-only marker", parameters: { type: "object", properties: {} }, handler: () => { throw new Error("Marker must not execute"); } }] });
            const [first, second] = await Promise.all([
                manager.getOrCreate(sessionId, config, { turnIndex: 0 }),
                manager.getOrCreate(secondId, secondConfig, { turnIndex: 0 }),
            ]);
            const run = async (managed, marker, directory) => {
                const events = [];
                expect((await managed.runTurn(`Check ${marker}`, { onEvent: event => events.push(event) })).type).toBe("completed");
                const proof = { identity: marker, cwd: realpathSync(directory) };
                expect(JSON.parse(readFileSync(join(directory, "native-visit.json"), "utf8"))).toEqual(proof);
                const shell = events.find(event => event.eventType === "native.tool.execution_complete" && event.data.toolName === "bash");
                expect(shell?.data.success).toBe(true);
                expect(toolOutput(shell)).toContain(`DIRECTORY_VERIFIED=${JSON.stringify(proof)}`);
                expect((await managed.getCopilotSession().rpc.tasks.list()).tasks.filter(task => task.type === "agent")).toEqual([]);
            };
            await Promise.all([run(first, "FILESYSTEM_SESSION_A", directoryA), run(second, "FILESYSTEM_SESSION_B", directoryB)]);
            const warmFirst = await manager.getOrCreate(sessionId, config, { turnIndex: 1 });
            await run(warmFirst, "FILESYSTEM_SESSION_A", directoryA);
            expect(readFileSync(join(directoryA, "identity.txt"), "utf8")).toBe("FILESYSTEM_SESSION_A");
            expect(readFileSync(join(directoryB, "identity.txt"), "utf8")).toBe("FILESYSTEM_SESSION_B");
            assertNativeIsolation(server.requests);
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
            expect(systemPrompt(server.requests[0])).not.toContain("## Native local delegation");
        }, "off");
    });

    it("OFF preserves durable delegation and excludes native tools, profiles, and guidance across warm/cold resume", { timeout: 30_000 }, async () => {
        const spawned = [];
        await harness(body => body.messages.at(-1).role === "tool"
            ? { content: "DURABLE_SPAWN_FINISHED" }
            : { tools: [{ name: "spawn_agent", args: { task: "Inspect durable child fixture" } }] },
        async ({ config, sessionId, createManager, server }) => {
            let manager = createManager();
            for (let turn = 0; turn < 3; turn++) {
                if (turn === 2) { await manager.shutdown(); manager = createManager(); }
                const managed = await manager.getOrCreate(sessionId, config, { turnIndex: turn });
                const events = [];
                const requestStart = server.requests.length;
                const childId = randomUUID();
                const result = await managed.runTurn(`Spawn the durable fixture, turn ${turn}`, {
                    onEvent: event => events.push(event),
                    controlToolBridge: { spawnAgent: async args => { spawned.push(args); return JSON.stringify({ sessionId: childId, status: "running" }); } },
                });
                expect(result.type).toBe("completed");
                expect(spawned.at(-1)).toEqual({ task: "Inspect durable child fixture" });
                const execution = events.find(event => event.eventType === "tool.execution_complete" && event.data.toolName === "spawn_agent");
                expect(execution?.data.success).toBe(true);
                expect(toolOutput(execution)).toContain(childId);
                expect(events.some(event => event.eventType.startsWith("subagent.") || event.eventType === "session.native_tasks_tick")).toBe(false);
                const agentNames = (await managed.getCopilotSession().rpc.agent.list()).agents.map(agent => agent.name);
                expect(agentNames).not.toContain("swarm-explore");
                expect(agentNames).not.toContain("swarm-task");
                expect(agentNames).not.toContain("swarm-rubber-duck");
                for (const request of server.requests.slice(requestStart)) {
                    expect(parentRequest(request)).toBe(true);
                    const names = request.tools.map(tool => tool.function?.name);
                    expect(names).toContain("spawn_agent");
                    expect(names).not.toContain("task");
                    expect(systemPrompt(request)).not.toContain("## Native local delegation");
                    expect(systemPrompt(request)).not.toContain("swarm-explore");
                    expect(systemPrompt(request)).not.toContain("swarm-task");
                    expect(systemPrompt(request)).not.toContain("swarm-rubber-duck");
                }
            }
            expect(spawned).toHaveLength(3);
        }, "off");
    });

    it("resuming a saved sync session with OFF revokes task access and its native profiles", { timeout: 30_000 }, async () => {
        let enabled = true;
        await harness(body => {
            if (parentRequest(body)) return body.messages.at(-1).role === "tool"
                ? { content: "PARENT_FINISHED" }
                // Deliberately attempt the now-excluded tool after downgrade;
                // schema absence alone does not prove runtime revocation.
                : { tools: [nativeTask()] };
            if (!enabled) throw new Error("OFF allowed native inference after resume");
            return { content: "NATIVE_FINISHED" };
        }, async ({ config, sessionId, createManager, server }) => {
            let manager = createManager("sync");
            let managed = await manager.getOrCreate(sessionId, config, { turnIndex: 0 });
            const firstEvents = [];
            expect((await managed.runTurn("Delegate while enabled", { onEvent: event => firstEvents.push(event) })).type).toBe("completed");
            expect(firstEvents.some(event => event.eventType === "subagent.started")).toBe(true);
            expect((await managed.getCopilotSession().rpc.tasks.list()).tasks.filter(task => task.type === "agent")).toEqual([]);
            await manager.shutdown();
            enabled = false;
            manager = createManager("off");
            managed = await manager.getOrCreate(sessionId, config, { turnIndex: 1 });
            const requestStart = server.requests.length;
            const secondEvents = [];
            const result = await managed.runTurn("Try delegation after OFF", { onEvent: event => secondEvents.push(event) });
            expect(result.type).toBe("completed");
            expect(secondEvents.some(event => event.eventType === "subagent.started")).toBe(false);
            expect((await managed.getCopilotSession().rpc.tasks.list()).tasks.filter(task => task.type === "agent")).toEqual([]);
            const agentNames = (await managed.getCopilotSession().rpc.agent.list()).agents.map(agent => agent.name);
            expect(agentNames).not.toContain("swarm-explore");
            expect(agentNames).not.toContain("swarm-task");
            expect(agentNames).not.toContain("swarm-rubber-duck");
            for (const request of server.requests.slice(requestStart)) {
                expect(parentRequest(request)).toBe(true);
                expect(request.tools.map(tool => tool.function?.name)).not.toContain("task");
                expect(systemPrompt(request)).not.toContain("## Native local delegation");
            }
            const denied = secondEvents.find(event => event.eventType === "tool.execution_complete" && event.data.toolName === "task");
            expect(denied?.data.success).toBe(false);
        });
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
