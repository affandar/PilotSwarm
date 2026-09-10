#!/usr/bin/env node
// Real local orchestration companion to the isolated SDK boundary evaluation.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import assert from "node:assert/strict";
import { ApiClient } from "../packages/sdk/api/src/api-client.js";
import { isSuccessfulTool, waitForSmokeSettlement } from "./lib/native-filesystem-evidence.mjs";

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const url = option("url") || "http://127.0.0.1:3017";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) throw new Error("Use a localhost worker for this filesystem fixture");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(root, ".tmp"); fs.mkdirSync(scratch, { recursive: true });
const directory = fs.mkdtempSync(path.join(scratch, "durable-filesystem-"));
const producerPath = path.join(directory, "producer.bin"), consumerPath = path.join(directory, "consumer.bin");
const bytes = randomBytes(4096), hash = createHash("sha256").update(bytes).digest("hex");
fs.writeFileSync(producerPath, bytes);
const api = new ApiClient({ apiUrl: url });
const types = ["tool.execution_complete", "native.tool.execution_complete", "subagent.started", "subagent.completed", "session.turn_completed"];
const events = async sessionId => {
    const rows = await api.call("getSessionEvents", { sessionId, afterSeq: 0, limit: 1000, eventTypes: types });
    assert(Array.isArray(rows) && rows.length < 1000, "Complete event history required");
    return rows;
};
const tool = (rows, name, native = false) => rows.filter(e => e.eventType === `${native ? "native." : ""}tool.execution_complete` && e.data.toolName === name);
let sessionId;
try {
    const created = await api.call("createSession", { model: "github-copilot:gpt-5.6-terra", reasoningEffort: "medium", contextTier: "default" });
    sessionId = typeof created === "string" ? created : created.sessionId;
    assert(sessionId);
    console.log(JSON.stringify({ sessionId, directory }));
    await api.call("renameSession", { sessionId, title: "Durable files — transfer before native checksum" });
    await api.call("uploadArtifact", { sessionId, filename: "payload.bin", content: bytes.toString("base64"), contentEncoding: "base64", contentType: "application/octet-stream" });
    fs.unlinkSync(producerPath);
    const prompt = `Spawn exactly one separate durable PilotSwarm child to compute the SHA-256 of a binary report previously produced by this session. Source report: local file ${producerPath}; published artifact artifact://${sessionId}/payload.bin. Have the child use one synchronous native task to independently run shasum -a 256 on the report bytes and return the checksum. Do not substitute the advertised artifact hash for computation. The child may use ${consumerPath} as its own local destination. Do not compute the checksum yourself. Validate its result, close the child with complete_agent, then report. This is finite work; no timers, web research, or extra children are needed.`;
    await api.call("sendMessage", { sessionId, prompt, options: {} });
    const { children } = await waitForSmokeSettlement({ listSessions: () => api.call("listSessions"), sessionId });
    const child = children[0], parentEvents = await events(sessionId), childEvents = await events(child.sessionId);
    // Save selected real evidence before assertions, including on a failing model run.
    fs.writeFileSync(path.join(directory, "events.json"), JSON.stringify({ sessionId, child, parentEvents, childEvents }, null, 2));
    assert.equal(tool(parentEvents, "spawn_agent").filter(isSuccessfulTool).length, 1);
    assert.equal(parentEvents.filter(e => e.eventType === "subagent.started").length, 0, "Root must spawn durable child, not run native work itself");
    const transfer = tool(childEvents, "read_artifact").find(e => isSuccessfulTool(e) && e.data.arguments?.sessionId === sessionId
        && path.resolve(String(e.data.arguments?.toFile || "")) === consumerPath);
    assert(transfer, "Durable child must materialize its parent's artifact into its own local destination");
    assert(!fs.existsSync(producerPath), "Original producer path must remain unavailable");
    assert(fs.readFileSync(consumerPath).equals(bytes), "Transferred bytes must match independently retained fixture bytes");
    const shells = tool(childEvents, "bash", true);
    const checksum = shells.find(e => isSuccessfulTool(e) && e.seq > transfer.seq
        && [ `shasum -a 256 ${consumerPath}`, `shasum -a 256 '${consumerPath}'`, `shasum -a 256 "${consumerPath}"` ].includes(e.data.arguments?.command)
        && String(e.data.result?.content).includes(hash));
    assert(checksum, "Expected actual native hashing of the downloaded bytes after transfer");
    assert.equal(shells.length, 1, "Unexpected native shell work");
    assert.equal(tool(childEvents, "bash").length, 0, "Durable child must delegate checksum execution");
    const starts = childEvents.filter(e => e.eventType === "subagent.started");
    assert.equal(starts.length, 1);
    assert.equal(starts[0].data.executionMode, "sync");
    assert.equal(starts[0].data.nativeAgentId, checksum.data.nativeAgentId);
    assert(childEvents.some(e => e.eventType === "subagent.completed" && e.data.nativeAgentId === checksum.data.nativeAgentId && !e.data.cancelled && !e.data.error));
    assert(tool(parentEvents, "complete_agent").some(e => isSuccessfulTool(e) && [child.sessionId, `session-${child.sessionId}`].includes(e.data.arguments?.agent_id)));
    const detail = await api.call("getSession", { sessionId: child.sessionId });
    // Some API views expose the final text differently; verified commands and
    // completed lifecycle are authoritative, not a prose success claim.
    const result = { pass: true, sessionId, childId: child.sessionId, nativeAgentId: checksum.data.nativeAgentId,
        producerUnavailable: true, transferredBytes: bytes.length, hash, transferSeq: transfer.seq, checksumSeq: checksum.seq,
        childStatus: child.status, observedStatus: detail.status };
    fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, directory }));
} catch (error) {
    fs.writeFileSync(path.join(directory, "failure.json"), JSON.stringify({ sessionId, error: error.message }));
    if (sessionId) {
        await api.call("cancelSession", { sessionId }).catch(() => {});
        for (const child of (await api.call("listSessions").catch(() => [])).filter(s => s.parentSessionId === sessionId && !["completed", "cancelled"].includes(s.status))) {
            await api.call("cancelSession", { sessionId: child.sessionId }).catch(() => {});
        }
    }
    throw error;
}
