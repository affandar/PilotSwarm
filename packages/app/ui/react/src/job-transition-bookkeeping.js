const BOOKKEEPING_EVENTS = Object.freeze({
    "session.turn_started": { label: "State execution started", kind: "worker" },
    "session.turn_completed": { label: "State execution finished", kind: "worker" },
    "session.turn_stopped": { label: "State execution stopped", kind: "worker" },
    "session.hydrated": { label: "Session restored", kind: "session" },
    "session.dehydrated": { label: "Session dehydrated", kind: "session" },
    "session.affinity_released": { label: "Worker affinity released", kind: "worker" },
    "session.input_required_started": { label: "Human input requested", kind: "wait" },
    "session.wait_started": { label: "Durable timer started", kind: "wait" },
    "session.wait_completed": { label: "Durable timer completed", kind: "wait" },
    "session.system_wait_requested": { label: "Observed-condition wait requested", kind: "wait" },
    "session.system_wait_started": { label: "Observed-condition wait parked", kind: "wait" },
    "session.system_wait_completed": { label: "Observed-condition wait resumed", kind: "wait" },
    "session.system_signal_ignored": { label: "Unmatched system signal ignored", kind: "wait" },
    "session.command_received": { label: "Session command received", kind: "session" },
    "session.command_completed": { label: "Session command completed", kind: "session" },
    "session.error": { label: "Session error", kind: "error" },
    "session.lossy_handoff": { label: "Session handoff warning", kind: "error" },
    "session.snapshot_regressed": { label: "Snapshot regression detected", kind: "error" },
    "session.snapshot_store_empty": { label: "Snapshot store empty", kind: "error" },
    "session.snapshot_unpublished": { label: "Snapshot publication failed", kind: "error" },
});

export function describeJobTransitionBookkeepingEvent(eventType) {
    return BOOKKEEPING_EVENTS[String(eventType || "")] || null;
}
