#!/usr/bin/env node
// Opt-in: creates a real local PilotSwarm tree; leaves completed sessions for inspection.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { ApiClient } from "../packages/sdk/api/src/api-client.js";
import { verifySharingEvidence } from "./lib/native-filesystem-evidence.mjs";
import { verifyDiskProof } from "./fixtures/native-filesystem-probe.mjs";

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const url = option("url") || "http://127.0.0.1:3017";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) throw new Error("This fixture is provisioned only on the local worker; use a localhost deployment");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.mkdirSync(path.join(root, ".tmp"), { recursive: true });
const directory = fs.mkdtempSync(path.join(root, ".tmp/native-filesystem-"));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const probe = path.join(root, "scripts/fixtures/native-filesystem-probe.mjs");
const probeHash = () => createHash("sha256").update(fs.readFileSync(probe)).digest("hex");
const originalProbeHash = probeHash();
const commands = Object.fromEntries(["prepare", "native-one", "native-two", "verify"].map(phase =>
    [phase, [process.execPath, probe, directory, phase].map(quote).join(" ")]));
const api = new ApiClient({ apiUrl: url });
const created = await api.call("createSession", { model: option("model") || "github-copilot:gpt-5.6-terra", reasoningEffort: "medium", contextTier: "default" });
const sessionId = typeof created === "string" ? created : created.sessionId;
if (!sessionId) throw new Error("No created session ID");
await api.call("renameSession", { sessionId, title: "File sharing — durable child with two native tasks" });
const prompt = `Run a bounded filesystem smoke test. Spawn exactly ONE separate durable PilotSwarm child session. The child must do the work below in one turn, with exactly TWO separate synchronous native swarm-task agents, in sequence. No named catalog role fits this shell fixture. You, the root, must not execute any shell or native task yourself. The probe script and empty test directory are pre-provisioned on this single localhost worker; this does NOT test file sharing between durable sessions.
Child steps (copy these exact commands into its assignment):
1. In its own bash tool, run: ${commands.prepare}
2. Ask the first native task (agent_type="swarm-task", mode="sync", distinct name) to run exactly: ${commands["native-one"]}
3. After it returns, ask a second distinct native task (agent_type="swarm-task", mode="sync") to run exactly: ${commands["native-two"]}
4. In its own bash tool, run: ${commands.verify}
All commands must use the session's default working directory, without cd or shell wrappers. Do not inspect, modify, recreate, or substitute the probe code or its data manually. The durable child generates a random challenge on disk; native one reads and modifies it; native two reads those changes and writes again; the child independently verifies the final file. Only claim success if all four commands report status ok. No web, timers, schedules, extra agents, or durable file transfer is needed inside the child's one turn. Parent: validate the child's result, close it with complete_agent, and report a concise outcome.`;
fs.writeFileSync(path.join(directory, "run.json"), JSON.stringify({ sessionId, url, commands, probeHash: originalProbeHash }, null, 2));
console.log(JSON.stringify({ sessionId, directory }));
const types = ["tool.execution_complete", "native.tool.execution_complete", "subagent.started", "subagent.completed", "session.turn_started", "session.turn_completed"];
async function events(id) {
    const rows = await api.call("getSessionEvents", { sessionId: id, afterSeq: 0, limit: 1000, eventTypes: types });
    if (!Array.isArray(rows) || rows.length === 1000) throw new Error("Event response missing or truncated");
    return rows;
}
let children = [];
try {
    await api.call("sendMessage", { sessionId, prompt, options: {} });
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
        const sessions = await api.call("listSessions");
        children = sessions.filter(s => s.parentSessionId === sessionId);
        const parent = sessions.find(s => s.sessionId === sessionId);
        if (children.length && children.every(c => c.status === "completed") && parent?.status === "idle") break;
        if ([parent, ...children].some(s => ["failed", "cancelled"].includes(s?.status))) throw new Error("Smoke session failed or cancelled");
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    const parentEvents = await events(sessionId);
    const childEvents = children.length === 1 ? await events(children[0].sessionId) : [];
    let verification = null, proofError;
    try { verification = verifyDiskProof(directory); } catch (error) { proofError = error.message; }
    const result = verifySharingEvidence({ parentEvents, childEvents, children, commands, verification,
        proofVerified: Boolean(verification), probeUnchanged: originalProbeHash === probeHash() });
    // Keep only selected tool/lifecycle evidence, never model snapshots or encrypted reasoning.
    fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({ sessionId, children, ...result, verification, proofError,
        probeHash: originalProbeHash, parentEvents, childEvents }, null, 2));
    console.log(JSON.stringify({ sessionId, directory, ...result }));
    if (!result.pass) throw new Error(result.failures.join("; "));
} catch (error) {
    // Stop only this test tree on failure; never touch unrelated user sessions.
    await api.call("cancelSession", { sessionId }).catch(() => {});
    const sessions = await api.call("listSessions").catch(() => []);
    for (const child of sessions.filter(s => s.parentSessionId === sessionId && !["completed", "cancelled"].includes(s.status))) {
        await api.call("cancelSession", { sessionId: child.sessionId }).catch(() => {});
    }
    throw error;
}
