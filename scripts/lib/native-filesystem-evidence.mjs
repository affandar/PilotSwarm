/** Verify tool execution and lifecycle evidence, not the model's final claim. */
export function verifySharingEvidence({ parentEvents, childEvents, children, commands, verification, proofVerified, probeUnchanged }) {
    const failures = [];
    const require = (condition, message) => { if (!condition) failures.push(message); };
    require(children.length === 1, "Expected exactly one durable child");
    require(children[0]?.status === "completed", "Durable child was not closed");
    require(!parentEvents.some(e => e.eventType === "subagent.started"), "Root ran native work instead of delegating it");
    require(!parentEvents.some(e => e.eventType === "tool.execution_complete" && ["bash", "powershell"].includes(e.data?.toolName)), "Root executed shell work");
    require(parentEvents.some(e => e.eventType === "tool.execution_complete" && e.data?.toolName === "spawn_agent" && e.data.success), "No successful durable spawn");
    require(parentEvents.some(e => e.eventType === "tool.execution_complete" && e.data?.toolName === "complete_agent" && e.data.success
        && [children[0]?.sessionId, `session-${children[0]?.sessionId}`].includes(e.data.arguments?.agent_id)), "Parent did not complete this durable child");
    const phases = ["prepare", "native-one", "native-two", "verify"];
    const phaseEvents = phases.map(phase => {
        const native = phase.startsWith("native-");
        const matches = childEvents.filter(e => e.eventType === `${native ? "native." : ""}tool.execution_complete`
            && e.data?.toolName === "bash" && e.data.arguments?.command === commands[phase]);
        require(matches.length === 1, `${phase}: expected exactly one attributed shell execution`);
        const event = matches[0];
        let output;
        try { output = JSON.parse(String(event?.data.result?.content).split("\n")[0]); } catch {}
        require(event?.data.success === true && output?.status === "ok" && output?.phase === phase && output?.cwd === verification?.cwd, `${phase}: command did not succeed`);
        return event;
    });
    require(phaseEvents.every(Boolean) && phaseEvents.every((event, i) => i === 0 || event.seq > phaseEvents[i - 1]?.seq), "Filesystem phases were not executed in order");
    const nativeIds = phaseEvents.slice(1, 3).map(e => e?.data.nativeAgentId);
    require(nativeIds.every(Boolean) && new Set(nativeIds).size === 2, "Expected two distinct native agents");
    require(childEvents.filter(e => e.eventType === "subagent.started").length === 2, "Unexpected number of native agents");
    for (const id of nativeIds.filter(Boolean)) {
        const start = childEvents.find(e => e.eventType === "subagent.started" && e.data?.nativeAgentId === id);
        const end = childEvents.find(e => e.eventType === "subagent.completed" && e.data?.nativeAgentId === id && !e.data.cancelled && !e.data.error);
        const phase = phaseEvents.find(e => e?.data.nativeAgentId === id);
        require(start?.data.executionMode === "sync" && start?.data.agentName === "swarm-task", "Native task profile/mode is wrong");
        require(start && end && start.seq < phase?.seq && end.seq > phase?.seq, "Successful native lifecycle missing");
    }
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
