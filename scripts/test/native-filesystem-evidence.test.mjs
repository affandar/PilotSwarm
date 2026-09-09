import test from "node:test";
import assert from "node:assert/strict";
import { verifySharingEvidence } from "../lib/native-filesystem-evidence.mjs";
function fixture() {
    const commands = Object.fromEntries(["prepare", "native-one", "native-two", "verify"].map(p => [p, `node probe ${p}`]));
    const childEvents = Object.keys(commands).map((phase, i) => ({ seq: i + 2,
        eventType: `${phase.startsWith("native-") ? "native." : ""}tool.execution_complete`,
        data: { toolName: "bash", arguments: { command: commands[phase] }, success: true, result: { content: '{"status":"ok"}' }, turnId: "0", ...(i === 1 || i === 2 ? { nativeAgentId: `native-${i}` } : {}) } }));
    for (const id of ["native-1", "native-2"]) for (const type of ["started", "completed"]) childEvents.push({ eventType: `subagent.${type}`, data: { nativeAgentId: id } });
    childEvents.push({ seq: 1, eventType: "session.turn_started" }, { seq: 6, eventType: "session.turn_completed" });
    return { commands, children: [{ sessionId: "child", status: "completed" }], childEvents,
        parentEvents: ["spawn_agent", "complete_agent"].map(toolName => ({ eventType: "tool.execution_complete", data: { toolName, success: true, arguments: { agent_id: "session-child" } } })),
        verification: { status: "ok", phase: "verify", finalHash: "a".repeat(64) } };
}
test("accepts attributed bidirectional sharing and child cleanup", () => assert.equal(verifySharingEvidence(fixture()).pass, true));
for (const [name, mutate] of Object.entries({
    "assistant success claim without executed commands": f => { f.childEvents = []; },
    "root native execution": f => f.parentEvents.push({ eventType: "subagent.started" }),
    "child does native work itself": f => { f.childEvents[1].eventType = "tool.execution_complete"; },
    "native command failed": f => { f.childEvents[1].data.success = false; },
    "same agent reused": f => { f.childEvents[2].data.nativeAgentId = "native-1"; },
    "wrong phase order": f => { f.childEvents[1].seq = 10; },
    "different durable turn": f => { f.childEvents.push({ seq: 4, eventType: "session.turn_started" }); },
    "missing durable completion": f => { f.childEvents = f.childEvents.filter(e => e.eventType !== "session.turn_completed"); },
    "missing native completion": f => { f.childEvents = f.childEvents.filter(e => e.eventType !== "subagent.completed"); },
    "child still alive": f => { f.children[0].status = "idle"; },
    "closed a different child": f => { f.parentEvents[1].data.arguments.agent_id = "another-child"; },
    "missing disk proof": f => { f.verification = null; },
})) test(`rejects ${name}`, () => { const f = fixture(); mutate(f); assert.equal(verifySharingEvidence(f).pass, false); });
