/** Capability routing for the complete named-agent handoff contract.
 *
 * Old orchestration callers omit this contract and retain their exact activity
 * names, inputs and descriptors. Only orchestration 1.0.75 opts into it.
 */
export const AGENT_HANDOFF_CAPABILITY = "pilotswarm.agent-handoff.v2";
export type ActivityRoutingContract = "agent-handoff-v2";
export const HANDOFF_ACTIVITY_NAMES = {
    runTurn: "runTurnV3",
    runTurn2: "runTurnEpochV3",
    resolveAgentConfig: "resolveAgentConfigV2",
    resolveAgentForRequiredTool: "resolveAgentForRequiredToolV2",
    spawnChildSession: "spawnChildSessionV2",
} as const;

export function routedActivityName(name: keyof typeof HANDOFF_ACTIVITY_NAMES, contract?: ActivityRoutingContract): string {
    return contract ? HANDOFF_ACTIVITY_NAMES[name] : name;
}

export function routeHandoffActivity(task: any, contract?: ActivityRoutingContract): any {
    if (!contract) return task;
    if (typeof task.withTag !== "function") {
        throw new Error("Agent handoff requires Duroxide activity tag routing support");
    }
    return task.withTag(AGENT_HANDOFF_CAPABILITY);
}

/** Retain legacy handlers for already-scheduled work while registering the new contract. */
export function registerHandoffActivity(runtime: any, name: keyof typeof HANDOFF_ACTIVITY_NAMES, handler: any): void {
    runtime.registerActivity(name, handler);
    runtime.registerActivity(HANDOFF_ACTIVITY_NAMES[name], handler);
}
