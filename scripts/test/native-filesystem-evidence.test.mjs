import test from "node:test";
import assert from "node:assert/strict";
import { verifySharingEvidence, waitForSmokeSettlement } from "../lib/native-filesystem-evidence.mjs";
function fixture() {
    const commands = Object.fromEntries(["prepare", "native-one", "native-two", "verify"].map(p => [p, `node probe ${p}`]));
    const verification = { status: "ok", phase: "verify", cwd: "/worker/workspace", stages: Object.keys(commands), finalHash: "a".repeat(64) };
    const childEvents = [{ seq: 1, eventType: "session.turn_started", data: { iteration: 0 } }];
    const shell = (phase, seq, agentId, parentToolCallId) => ({ seq,
        eventType: `${agentId ? "native." : ""}tool.execution_complete`,
        data: { toolName: "bash", arguments: { command: commands[phase] }, success: true, toolCallId: `shell-${phase}`,
            result: { content: JSON.stringify(phase === "verify" ? verification : { phase, status: "ok", cwd: verification.cwd }),
                contents: [{ type: "shell_exit", exitCode: 0 }] },
            turnId: phase === "verify" ? "3" : "0", ...(agentId ? { nativeAgentId: agentId, parentToolCallId } : {}) } });
    childEvents.push(shell("prepare", 3));
    for (const [index, phase] of ["native-one", "native-two"].entries()) {
        const seq = 4 + index * 4, nativeAgentId = `native-${index + 1}`, toolCallId = `task-${index + 1}`;
        const arguments_ = { agent_type: "swarm-task", mode: "sync", name: phase };
        childEvents.push({ seq, eventType: "subagent.started", data: { nativeAgentId, toolCallId, agentName: "swarm-task", executionMode: "sync" } },
            shell(phase, seq + 1, nativeAgentId, toolCallId),
            { seq: seq + 2, eventType: "subagent.completed", data: { nativeAgentId, toolCallId } },
            { seq: seq + 3, eventType: "tool.execution_complete", data: { toolName: "task", toolCallId, arguments: arguments_, success: true, result: { content: "Probe succeeded" } } });
    }
    childEvents.push(shell("verify", 12), { seq: 13, eventType: "session.turn_completed", data: { resultType: "completed" } });
    return { commands, children: [{ sessionId: "child", status: "completed" }], childEvents,
        parentEvents: ["spawn_agent", "complete_agent"].map(toolName => ({ eventType: "tool.execution_complete", data: { toolName, success: true, arguments: { agent_id: "session-child" } } })),
        verification, proofVerified: true, probeUnchanged: true };
}
const phase = (f, name) => f.childEvents.find(e => e.data?.arguments?.command === f.commands[name]);
const lifecycle = (f, type) => f.childEvents.find(e => e.eventType === `subagent.${type}`);
const task = f => f.childEvents.find(e => e.data?.toolName === "task");
test("accepts attributed bidirectional sharing across model rounds in one durable turn", () => {
    const f = fixture();
    assert.notEqual(phase(f, "prepare").data.turnId, phase(f, "verify").data.turnId);
    assert.deepEqual(verifySharingEvidence(f), { pass: true, failures: [], nativeIds: ["native-1", "native-2"] });
});
test("allows read-only status inspection without treating it as filesystem execution", () => {
    const f = fixture();
    f.parentEvents.push(
        { eventType: "tool.execution_complete", data: { toolName: "read_agent", success: false, result: { error: "Unknown agent" } } },
        { eventType: "tool.execution_complete", data: { toolName: "read_agent_events", success: true } },
    );
    assert.equal(verifySharingEvidence(f).pass, true);
});
for (const [name, mutate] of Object.entries({
    "assistant success claim without executed commands": f => { f.childEvents = []; },
    "root native execution": f => f.parentEvents.push({ eventType: "subagent.started" }),
    "root shell execution": f => f.parentEvents.push({ eventType: "tool.execution_complete", data: { toolName: "bash", success: true } }),
    "root file edit": f => f.parentEvents.push({ eventType: "tool.execution_complete", data: { toolName: "edit", success: true } }),
    "child does native work itself": f => { phase(f, "native-one").eventType = "tool.execution_complete"; },
    "native command failed": f => { phase(f, "native-one").data.success = false; },
    "nonzero shell exit hidden behind status ok": f => { phase(f, "native-one").data.result.contents[0].exitCode = 1; },
    "missing phase in shell output": f => { phase(f, "native-one").data.result.content = '{"status":"ok"}'; },
    "wrong cwd in shell output": f => { phase(f, "native-one").data.result.content = JSON.stringify({ phase: "native-one", status: "ok", cwd: "/another" }); },
    "stale verification output": f => { phase(f, "verify").data.result.content = JSON.stringify({ ...f.verification, finalHash: "b".repeat(64) }); },
    "same agent reused": f => { phase(f, "native-two").data.nativeAgentId = "native-1"; },
    "wrong phase order": f => { phase(f, "native-one").seq = 10; },
    "duplicate shell execution": f => f.childEvents.push({ ...phase(f, "native-one"), seq: 6 }),
    "missing native parent call ID": f => { delete phase(f, "native-one").data.parentToolCallId; },
    "unrelated native parent call ID": f => { phase(f, "native-one").data.parentToolCallId = "unrelated"; },
    "native agent prepares child file": f => { phase(f, "prepare").data.nativeAgentId = "native-1"; },
    "cancelled native completion": f => { lifecycle(f, "completed").data.cancelled = true; },
    "errored native completion": f => { lifecycle(f, "completed").data.error = "Timed out"; },
    "native failure alongside completion": f => f.childEvents.push({ seq: 6, eventType: "subagent.failed", data: { nativeAgentId: "native-1" } }),
    "background native lifecycle": f => { lifecycle(f, "started").data.executionMode = "background"; },
    "wrong native profile": f => { lifecycle(f, "started").data.agentName = "swarm-explore"; },
    "background parent task request": f => { task(f).data.arguments.mode = "background"; },
    "failed parent task result": f => { task(f).data.result = { success: false, content: "Failed" }; },
    "native completion from a different call": f => { lifecycle(f, "completed").data.toolCallId = "another"; },
    "second task starts before first returned": f => { f.childEvents.filter(e => e.eventType === "subagent.started")[1].seq = 6.5; },
    "verify starts before second task returned": f => { phase(f, "verify").seq = 10.5; },
    "extra native agent": f => f.childEvents.push({ seq: 10, eventType: "subagent.started", data: { nativeAgentId: "third" } }),
    "unexpected child shell": f => f.childEvents.push({ seq: 2, eventType: "tool.execution_complete", data: { toolName: "bash", arguments: { command: "echo manufactured > verified.json" }, success: true } }),
    "unexpected native shell": f => f.childEvents.push({ seq: 5.5, eventType: "native.tool.execution_complete", data: { toolName: "bash", nativeAgentId: "native-1", arguments: { command: "pwd" }, success: true } }),
    "native fixture edit": f => f.childEvents.push({ seq: 5.5, eventType: "native.tool.execution_complete", data: { toolName: "edit", nativeAgentId: "native-1", success: true } }),
    "different durable turn": f => { f.childEvents.push({ seq: 4, eventType: "session.turn_started" }); },
    "missing durable completion": f => { f.childEvents = f.childEvents.filter(e => e.eventType !== "session.turn_completed"); },
    "failed durable completion": f => { f.childEvents.find(e => e.eventType === "session.turn_completed").data.resultType = "error"; },
    "missing native completion": f => { f.childEvents = f.childEvents.filter(e => e.eventType !== "subagent.completed"); },
    "missing parent task completion": f => { f.childEvents = f.childEvents.filter(e => e.data?.toolName !== "task"); },
    "child still alive": f => { f.children[0].status = "idle"; },
    "closed a different child": f => { f.parentEvents[1].data.arguments.agent_id = "another-child"; },
    "failed durable spawn": f => { f.parentEvents[0].data.result = { success: false }; },
    "duplicate durable spawn": f => f.parentEvents.push(structuredClone(f.parentEvents[0])),
    "nested complete_agent failure": f => { f.parentEvents[1].data.result = { success: false, resultType: "failure" }; },
    "complete_agent JSON failure": f => { f.parentEvents[1].data.result = { content: JSON.stringify({ result: { success: false } }) }; },
    "complete_agent structured failure": f => { f.parentEvents[1].data.result = { structuredContent: { resultType: "denied" } }; },
    "missing disk proof": f => { f.verification = null; },
    "receipt chain not independently checked": f => { delete f.proofVerified; },
    "receipt chain failed": f => { f.proofVerified = false; },
    "probe modified": f => { f.probeUnchanged = false; },
    "probe integrity not checked": f => { delete f.probeUnchanged; },
})) test(`rejects ${name}`, () => {
    const f = fixture();
    assert.equal(verifySharingEvidence(f).pass, true, "The unmodified fixture must remain valid");
    mutate(f);
    assert.equal(verifySharingEvidence(f).pass, false);
});

function pollingHarness(listSessions, options = {}) {
    let time = 0;
    const sleeps = [];
    return { sleeps, run: () => waitForSmokeSettlement({ sessionId: "root", timeoutMs: 100, pollMs: 60,
        now: () => time, sleep: async ms => { sleeps.push(ms); time += ms; },
        listSessions: () => listSessions(() => time, ms => { time += ms; }), ...options }) };
}
const tree = (parentStatus = "idle", childStatus = "completed") => [
    { sessionId: "root", status: parentStatus },
    { sessionId: "child", parentSessionId: "root", status: childStatus },
];
test("waits for both child completion and parent settlement, ignoring unrelated sessions", async () => {
    let calls = 0;
    const h = pollingHarness(() => [...tree(++calls === 1 ? "running" : "idle"), { sessionId: "unrelated", status: "failed" }]);
    const result = await h.run();
    assert.equal(result.parent.status, "idle");
    assert.equal(result.children.length, 1);
    assert.deepEqual(h.sleeps, [60]);
});
for (const [name, rows] of Object.entries({
    "parent still running after the child closed": tree("running"),
    "child not closed": tree("idle", "idle"),
    "parent missing": tree().slice(1),
    "child missing": tree().slice(0, 1),
})) test(`deadline rejects ${name}`, async () => {
    const h = pollingHarness(() => rows);
    await assert.rejects(h.run(), /deadline exceeded/);
    assert.deepEqual(h.sleeps, [60, 40]);
});
test("does not accept an API response arriving after the deadline", async () => {
    const h = pollingHarness((now, advance) => { advance(101); return tree(); });
    await assert.rejects(h.run(), /deadline exceeded/);
    assert.deepEqual(h.sleeps, []);
});
for (const status of ["error", "failed", "cancelled"]) test(`polling rejects ${status} immediately`, async () => {
    const h = pollingHarness(() => tree("idle", status));
    await assert.rejects(h.run(), /failed or cancelled/);
    assert.deepEqual(h.sleeps, []);
});
test("polling rejects an extra durable child immediately", async () => {
    const h = pollingHarness(() => [...tree(), { sessionId: "extra", parentSessionId: "root", status: "running" }]);
    await assert.rejects(h.run(), /exactly one durable child/);
    assert.deepEqual(h.sleeps, []);
});
