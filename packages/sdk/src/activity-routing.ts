import { SIGNAL_ACTIVITY_CAPABILITY, SIGNAL_RACE_ACTIVITY_CAPABILITY } from "./session-signals.js";

/** Capability routing for the complete named-agent handoff contract.
 *
 * Old orchestration callers omit this contract and retain their exact activity
 * names, inputs and descriptors. Orchestrations 1.0.75 and later opt into it.
 */
export const AGENT_HANDOFF_CAPABILITY = "pilotswarm.agent-handoff.v2";
export type ActivityRoutingContract = "agent-handoff-v2" | "signals-v1" | "signals-v2";
export const SIGNAL_ACTIVITY_NAMES = {
    runTurn: "runTurnSignalsV1",
    runTurn2: "runTurnSignalsEpochV1",
} as const;
export const SIGNAL_RACE_ACTIVITY_NAMES = {
    runTurn: "runTurnSignalsV2",
    runTurn2: "runTurnSignalsEpochV2",
} as const;
export const HANDOFF_ACTIVITY_NAMES = {
    runTurn: "runTurnV3",
    runTurn2: "runTurnEpochV3",
    resolveAgentConfig: "resolveAgentConfigV2",
    resolveAgentForRequiredTool: "resolveAgentForRequiredToolV2",
    spawnChildSession: "spawnChildSessionV2",
    getSessionStatus: "getSessionStatusV2",
    listChildSessions: "listChildSessionsV2",
} as const;

export function routedActivityName(name: keyof typeof HANDOFF_ACTIVITY_NAMES, contract?: ActivityRoutingContract): string {
    if (contract === "signals-v2" && (name === "runTurn" || name === "runTurn2")) {
        return SIGNAL_RACE_ACTIVITY_NAMES[name];
    }
    if (contract === "signals-v1" && (name === "runTurn" || name === "runTurn2")) {
        return SIGNAL_ACTIVITY_NAMES[name];
    }
    return contract ? HANDOFF_ACTIVITY_NAMES[name] : name;
}

export function routeHandoffActivity(task: any, contract?: ActivityRoutingContract): any {
    if (!contract) return task;
    if (typeof task.withTag !== "function") {
        throw new Error("Agent handoff requires Duroxide activity tag routing support");
    }
    return task.withTag(contract === "signals-v2" ? SIGNAL_RACE_ACTIVITY_CAPABILITY
        : contract === "signals-v1" ? SIGNAL_ACTIVITY_CAPABILITY : AGENT_HANDOFF_CAPABILITY);
}

/** Retain legacy handlers for already-scheduled work while registering the new contract. */
export function registerHandoffActivity(runtime: any, name: keyof typeof HANDOFF_ACTIVITY_NAMES, handler: any, versionedHandler = handler): void {
    runtime.registerActivity(name, handler);
    runtime.registerActivity(HANDOFF_ACTIVITY_NAMES[name], versionedHandler);
}
