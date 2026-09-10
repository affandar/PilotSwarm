import { createFeaturePolicy } from "./feature-policy.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { SessionManager } from "../../src/session-manager.ts";
import { ModelProviderRegistry } from "../../src/model-providers.ts";
import { FilesystemArtifactStore } from "../../src/session-store.ts";
import { createArtifactTools } from "../../src/artifact-tools.ts";
import { createNativeCopilotProvider } from "./native-copilot-provider.mjs";

/** Intentionally narrow shell fixture: real hashing, never echo of an advertised hash. */
function checksumPath(command) {
    const match = /^(?:\/usr\/bin\/)?shasum\s+-a\s+256\s+(?:--\s+)?(?:'([^']+)'|"([^"$`]+)"|([^\s'";$`|&<>]+))\s*$/.exec(command || "");
    return match ? match[1] || match[2] || match[3] : null;
}

/**
 * Real SDK/CLI and production artifact handlers; worker loss is simulated by
 * removing the producer's original file. No Duroxide scheduler or CMS is used.
 * The live model must choose to materialize an artifact before native hashing.
 */
export async function runDurableFilesystemBoundary({ relation, respond, token, model = "gpt-5.6-terra" }) {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-durable-files-")));
    const sourceDirectory = path.join(home, "producer"), childDirectory = path.join(home, "consumer");
    fs.mkdirSync(sourceDirectory); fs.mkdirSync(childDirectory);
    const parentId = randomUUID(), childId = randomUUID();
    const sourceId = relation === "parent" ? parentId : randomUUID();
    const originalPath = path.join(sourceDirectory, "payload.bin");
    const childPath = path.join(childDirectory, "payload.bin");
    const payload = randomBytes(4096), expectedHash = createHash("sha256").update(payload).digest("hex");
    fs.writeFileSync(originalPath, payload);
    const artifacts = createArtifactTools({ blobStore: new FilesystemArtifactStore(path.join(home, "artifacts")) });
    const publish = artifacts.find(t => t.name === "write_artifact");
    const publication = JSON.parse(await publish.handler({ filename: "payload.bin", fromFile: originalPath }, { durableSessionId: sourceId }));
    if (!publication.success) throw new Error(`Fixture publication failed: ${publication.error}`);
    // Even an absolute producer path must not work merely because both sessions
    // happen to be on this machine. Only the persisted artifact retains bytes.
    fs.unlinkSync(originalPath);
    const events = [], reads = [], violations = [];
    const fixture = { sourceId, originalPath, childPath, expectedHash };
    const server = respond ? await createNativeCopilotProvider((body, index) => respond(body, index, fixture)) : null;
    const registry = server ? new ModelProviderRegistry({ providers: [{ id: "fixture", type: "openai", baseUrl: server.baseUrl, apiKey: "synthetic", models: [model] }] }) : undefined;
    const base = fs.readFileSync(new URL("../../plugins/system/agents/default.agent.md", import.meta.url), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
    const manager = new SessionManager(token, null, { nativeSubagents: "sync", frameworkBasePrompt: base,
        ...(registry ? { modelProviders: registry } : {}), turnTimeoutMs: 90_000 }, path.join(home, "session-state"));
    manager.setFeatureFlagCache((await createFeaturePolicy()).cache);
    manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }), storeFact: async () => ({ stored: 1 }) });
    const tools = artifacts.map(tool => ({ ...tool, handler: async (args, context) => {
        const native = context.sessionId !== childId;
        if (native) { violations.push("Native agent attempted artifact access"); throw new Error("Parent-only artifact tools"); }
        if (tool.name !== "read_artifact" && tool.name !== "list_artifacts") throw new Error("Fixture is read-only");
        if (args.sessionId && args.sessionId !== sourceId && args.sessionId !== childId) throw new Error("Unknown fixture session");
        const target = args.toFile ? path.resolve(childDirectory, args.toFile) : null;
        if (target && target !== childPath) throw new Error("Materialize as payload.bin in the consumer's workspace");
        const result = await tool.handler({ ...args, ...(target ? { toFile: target } : {}) }, { ...context, durableSessionId: childId });
        if (tool.name === "read_artifact") reads.push({ args: { ...args, ...(target ? { toFile: target } : {}) }, result: JSON.parse(result), order: events.length });
        return result;
    } }));
    const config = { model: registry ? `fixture:${model}` : model, reasoningEffort: "medium", contextTier: "default", workingDirectory: childDirectory,
        systemMessage: { content: `This is durable PilotSwarm child session ${childId}, parent session ${parentId}. ${relation === "sibling" ? `Session ${sourceId} is a sibling durable session under the same parent.` : ""}` },
        tools, hooks: { onPreToolUse: (input, invocation) => {
            const native = input.sessionId && input.sessionId !== invocation.sessionId;
            const args = input.toolArgs || {};
            if (input.toolName === "bash") {
                const target = checksumPath(args.command);
                if (native && target && path.resolve(childDirectory, target) === childPath && fs.existsSync(childPath)) return;
                violations.push(`Unexpected ${native ? "native" : "durable"} shell command: ${args.command}`);
                return { permissionDecision: "deny", permissionDecisionReason: "Only native shasum of a materialized consumer file is admitted in this fixture" };
            }
            if (["view", "rg", "grep", "glob", "powershell"].includes(input.toolName)) {
                violations.push(`Unexpected direct filesystem access: ${input.toolName}`);
                return { permissionDecision: "deny", permissionDecisionReason: "Checksum fixture does not need extra filesystem reads" };
            }
        } } };
    manager.setConfig(childId, config);
    try {
        const managed = await manager.getOrCreate(childId, config, { turnIndex: 0 });
        const result = await managed.runTurn(`Compute SHA-256 of the binary report produced by your ${relation} session ${sourceId}. Its report says: local file ${originalPath}; published result artifact://${sourceId}/payload.bin. Use one synchronous native task to independently run shasum -a 256 on the report bytes, then return the checksum. Do not substitute the advertised artifact checksum for computation. Your working directory is ${childDirectory}.`, { onEvent: event => events.push(event) });
        const transfer = reads.find(r => r.args.sessionId === sourceId && r.args.toFile === childPath && r.result.success);
        const shell = events.find(e => e.eventType === "native.tool.execution_complete" && e.data.toolName === "bash" && e.data.success
            && checksumPath(e.data.arguments?.command) && String(e.data.result?.content).includes(expectedHash));
        const starts = events.filter(e => e.eventType === "subagent.started");
        const childBytesCorrect = fs.existsSync(childPath) && fs.readFileSync(childPath).equals(payload);
        const failures = [];
        if (result.type !== "completed") failures.push(`Durable child turn ${result.type}`);
        if (!transfer || !childBytesCorrect) failures.push("Durable child did not materialize its source session's artifact bytes locally");
        if (starts.length !== 1 || starts[0]?.data.executionMode !== "sync") failures.push("Expected one synchronous native task");
        if (!shell || !shell.data.nativeAgentId || shell.data.nativeAgentId !== starts[0]?.data.nativeAgentId) failures.push("No attributed native checksum execution");
        if (transfer && shell && transfer.order >= events.indexOf(shell)) failures.push("Native execution preceded artifact transfer");
        if (!String(result.content).includes(expectedHash)) failures.push("Durable child did not return the independently computed checksum");
        if (!events.some(e => e.eventType === "subagent.completed" && e.data.nativeAgentId === shell?.data.nativeAgentId && !e.data.cancelled && !e.data.error)) failures.push("Native task did not complete successfully");
        if ((await managed.getCopilotSession().rpc.tasks.list()).tasks.some(t => t.type === "agent")) failures.push("Native tasks were not retired");
        failures.push(...violations);
        return { relation, model, childId, sourceId, nativeMode: "sync", pass: failures.length === 0, failures,
            originalRemoved: !fs.existsSync(originalPath), transferredBytes: childBytesCorrect ? payload.length : 0,
            expectedHash, result: { type: result.type, content: result.content },
            reads: reads.map(r => ({ from: r.args.sessionId, materialized: Boolean(r.args.toFile), success: r.result.success })),
            tools: events.filter(e => ["tool.execution_complete", "native.tool.execution_complete", "subagent.started", "subagent.completed"].includes(e.eventType))
                .map(e => ({ type: e.eventType, tool: e.data.toolName, nativeAgentId: e.data.nativeAgentId, success: e.data.success,
                    command: e.data.arguments?.command, result: e.data.result?.content })) };
    } finally { await manager.shutdown(); await server?.close(); fs.rmSync(home, { recursive: true, force: true }); }
}
