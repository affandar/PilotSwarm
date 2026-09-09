const phases = ["prepare", "native-one", "native-two", "verify"];
const completion = e => ["tool.execution_complete", "native.tool.execution_complete"].includes(e.eventType);
function failedResult(value, depth = 0) {
    if (depth > 8 || value == null) return false;
    if (typeof value === "string") {
        try { return failedResult(JSON.parse(value), depth + 1); } catch { return false; }
    }
    if (typeof value !== "object") return false;
    return value.success === false || value.cancelled === true || Boolean(value.error) || value.isError === true
        || ["error", "failure", "failed", "rejected", "denied"].includes(value.resultType)
        || (value.type === "shell_exit" && value.exitCode !== 0)
        || ["result", "content", "detailedContent", "structuredContent"].some(key => failedResult(value[key], depth + 1))
        || (Array.isArray(value.contents) && value.contents.some(item => failedResult(item, depth + 1)));
}
const succeeded = e => e?.data?.success === true && !failedResult(e.data);
export const isSuccessfulTool = succeeded;

/** Poll only this test tree; reaching the deadline is never a successful run. */
export async function waitForSmokeSettlement({ listSessions, sessionId, timeoutMs = 300_000, pollMs = 2_000,
    now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
        const sessions = await listSessions();
        const children = sessions.filter(s => s.parentSessionId === sessionId);
        const parent = sessions.find(s => s.sessionId === sessionId);
        if (now() >= deadline) break;
        if (children.length > 1) throw new Error("Expected exactly one durable child");
        if ([parent, ...children].some(s => ["error", "failed", "cancelled"].includes(s?.status))) {
            throw new Error("Smoke session failed or cancelled");
        }
        if (children.length === 1 && children[0].status === "completed" && parent?.status === "idle") {
            return { parent, children };
        }
        await sleep(Math.min(pollMs, deadline - now()));
    }
    throw new Error("Smoke deadline exceeded before the parent settled and durable child completed");
}

/** Verify tool execution and lifecycle evidence, not the model's final claim. */
export function verifySharingEvidence({ parentEvents, childEvents, children, commands, verification, proofVerified, probeUnchanged }) {
    const failures = [];
    const require = (condition, message) => { if (!condition) failures.push(message); };
    require(children.length === 1, "Expected exactly one durable child");
    require(children[0]?.status === "completed", "Durable child was not closed");
    require(!parentEvents.some(e => e.eventType.startsWith("subagent.") || e.eventType.startsWith("native.")), "Root ran native work instead of delegating it");
    // Status/transcript inspection cannot manufacture filesystem proof. Keep
    // unrelated coordination mistakes separate from this execution boundary.
    require(!parentEvents.some(e => completion(e) && !["spawn_agent", "complete_agent", "check_agents", "read_agent", "read_agent_events", "wait_for_agents", "wait"].includes(e.data?.toolName)), "Root executed unexpected work");
    const spawns = parentEvents.filter(e => completion(e) && e.data?.toolName === "spawn_agent");
    require(spawns.length === 1 && succeeded(spawns[0]), "Expected one successful durable spawn");
    require(parentEvents.some(e => completion(e) && e.data?.toolName === "complete_agent" && succeeded(e)
        && [children[0]?.sessionId, `session-${children[0]?.sessionId}`].includes(e.data.arguments?.agent_id)), "Parent did not complete this durable child");
    const phaseEvents = phases.map(phase => {
        const native = phase.startsWith("native-");
        const matches = childEvents.filter(e => e.eventType === `${native ? "native." : ""}tool.execution_complete`
            && e.data?.toolName === "bash" && e.data.arguments?.command === commands[phase]);
        require(matches.length === 1, `${phase}: expected exactly one attributed shell execution`);
        const event = matches[0];
        let output;
        try { output = JSON.parse(String(event?.data.result?.content).split("\n")[0]); } catch {}
        require(succeeded(event) && output?.status === "ok" && output?.phase === phase && output?.cwd === verification?.cwd
            && (phase !== "verify" || output?.finalHash === verification?.finalHash), `${phase}: command did not succeed`);
        if (!native) require(!event?.data.nativeAgentId && !event?.data.parentToolCallId, `${phase}: was not executed by the durable child`);
        return event;
    });
    require(phaseEvents.every(Boolean) && phaseEvents.every((event, i) => Number.isFinite(event.seq) && (i === 0 || event.seq > phaseEvents[i - 1]?.seq)), "Filesystem phases were not executed in order");
    const nativeIds = phaseEvents.slice(1, 3).map(e => e?.data.nativeAgentId);
    require(nativeIds.every(Boolean) && new Set(nativeIds).size === 2, "Expected two distinct native agents");
    const nativeStarts = childEvents.filter(e => e.eventType === "subagent.started");
    const nativeEnds = childEvents.filter(e => e.eventType === "subagent.completed");
    const taskCalls = childEvents.filter(e => e.eventType === "tool.execution_complete" && e.data?.toolName === "task");
    require(nativeStarts.length === 2 && nativeEnds.length === 2 && taskCalls.length === 2
        && !childEvents.some(e => e.eventType === "subagent.failed"), "Unexpected number or failure of native agents");
    const taskReturns = [];
    for (const [index, id] of nativeIds.entries()) {
        const start = nativeStarts.find(e => e.data?.nativeAgentId === id);
        const end = nativeEnds.find(e => e.data?.nativeAgentId === id);
        const phase = phaseEvents[index + 1];
        const task = taskCalls.find(e => e.data?.toolCallId === start?.data.toolCallId);
        taskReturns.push(task);
        require(start?.data.executionMode === "sync" && start?.data.agentName === "swarm-task"
            && task?.data.arguments?.mode === "sync" && task?.data.arguments?.agent_type === "swarm-task", "Native task profile/mode is wrong");
        require(Boolean(id && start?.data.toolCallId) && end?.data.toolCallId === start?.data.toolCallId
            && phase?.data.parentToolCallId === start?.data.toolCallId && succeeded(task), "Native task execution attribution missing");
        require(start && end && !end.data.cancelled && !end.data.error && start.seq < phase?.seq && end.seq > phase?.seq
            && task?.seq > end.seq, "Successful native lifecycle missing");
    }
    require(taskReturns[0]?.seq < nativeStarts.find(e => e.data?.nativeAgentId === nativeIds[1])?.seq
        && taskReturns[1]?.seq < phaseEvents[3]?.seq, "Native tasks did not return sequentially before verification");
    // No alternate shell command or file-edit tool may manufacture the proof.
    require(childEvents.filter(completion).every(e => phaseEvents.includes(e) || taskReturns.includes(e)), "Durable child or native agent executed unexpected work");
    // Copilot turnId counts model/tool rounds, not the durable activity turn.
    const starts = childEvents.filter(e => e.eventType === "session.turn_started");
    const ends = childEvents.filter(e => e.eventType === "session.turn_completed");
    require(starts.length === 1 && ends.length === 1 && ends[0].data?.resultType === "completed"
        && starts[0].seq < phaseEvents[0]?.seq && ends[0].seq > phaseEvents[3]?.seq,
        "Sharing was not verified within one durable-child turn");
    require(verification?.status === "ok" && verification.phase === "verify" && /^[a-f0-9]{64}$/.test(verification.finalHash || ""), "Independent on-disk verification missing");
    require(proofVerified === true && probeUnchanged === true, "Receipt chain or probe integrity was not independently verified");
    return { pass: failures.length === 0, failures, nativeIds };
}
