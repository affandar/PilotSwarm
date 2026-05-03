import type {
    CommandMessage,
    CommandResponse,
    SerializableSessionConfig,
    SubAgentEntry,
} from "../types.js";
import {
    clearPendingChildDigest,
    publishStatus,
    queueFollowup,
    writeCommandResponse,
} from "./lifecycle.js";
import {
    MAX_NESTING_LEVEL,
    MAX_SUB_AGENTS,
    SHUTDOWN_POLL_INTERVAL_MS,
    SHUTDOWN_TIMEOUT_MS,
    type DurableSessionRuntime,
    type PendingShutdownState,
    type ShutdownMode,
} from "./state.js";

export type { PendingShutdownState, ShutdownMode };

// ─── Pure helpers ───────────────────────────────────────────

export function isSubAgentTerminalStatus(status?: string): boolean {
    return status === "completed" || status === "failed" || status === "cancelled";
}

export function parseChildUpdate(promptText?: string): { sessionId: string; updateType: string; content: string } | null {
    if (typeof promptText !== "string") return null;
    const match = promptText.match(/^\[CHILD_UPDATE from=(\S+) type=(\S+)/);
    if (!match) return null;
    return {
        sessionId: match[1],
        updateType: match[2].replace(/\]$/, ""),
        content: promptText.split("\n").slice(1).join("\n").trim(),
    };
}

export function defaultShutdownReason(mode: ShutdownMode): string {
    switch (mode) {
        case "done":
            return "Completed by user";
        case "cancel":
            return "Cancelled by user";
        case "delete":
            return "Deleted by user";
    }
}

export function buildShutdownWaitReason(shutdown: PendingShutdownState): string {
    switch (shutdown.mode) {
        case "done":
            return `Waiting for ${shutdown.targetAgentIds.length} child session(s) to complete before closing.`;
        case "cancel":
            return `Waiting for ${shutdown.targetAgentIds.length} child session(s) to cancel before closing.`;
        case "delete":
            return `Waiting for ${shutdown.targetAgentIds.length} child session(s) to cancel before deletion.`;
    }
}

export function findTrackedAgentByOrchId(subAgents: SubAgentEntry[], orchId: string): SubAgentEntry | undefined {
    return subAgents.find((agent) => agent.orchId === orchId);
}

export function areTrackedAgentsTerminal(subAgents: SubAgentEntry[], agentIds: string[]): boolean {
    return agentIds.every((agentId) => {
        const agent = findTrackedAgentByOrchId(subAgents, agentId);
        return Boolean(agent && isSubAgentTerminalStatus(agent.status));
    });
}

export function getStillRunningAgentIds(subAgents: SubAgentEntry[], agentIds: string[]): string[] {
    return agentIds.filter((agentId) => {
        const agent = findTrackedAgentByOrchId(subAgents, agentId);
        return agent && !isSubAgentTerminalStatus(agent.status);
    });
}

export function buildWaitForAgentsFollowup(subAgents: SubAgentEntry[], targetIds: string[]): string {
    const summaries = targetIds
        .map((targetId) => subAgents.find((agent) => agent.orchId === targetId))
        .filter((agent): agent is SubAgentEntry => Boolean(agent))
        .map((agent) =>
            `  - Agent ${agent.orchId}\n` +
            `    Task: "${agent.task.slice(0, 120)}"\n` +
            `    Status: ${agent.status}\n` +
            `    Result: ${agent.result ?? "(no result)"}`,
        );

    if (summaries.length === 0) {
        return `[SYSTEM: No tracked sub-agents produced a completion summary.]`;
    }

    if (summaries.length === 1) {
        return `[SYSTEM: Sub-agent completed. If the user asked you to relay the child's final output, return the single sub-agent Result text verbatim.\n${summaries[0]}]`;
    }

    return `[SYSTEM: Sub-agents completed:\n${summaries.join("\n")}]`;
}

export function buildSubAgentSystemMessage(options: {
    parentSessionId: string;
    childNestingLevel: number;
    maxNestingLevel: number;
    agentTask: string;
    agentIsSystem: boolean;
    parentSystemMessage: string;
}): string {
    const {
        parentSessionId,
        childNestingLevel,
        maxNestingLevel,
        agentTask,
        agentIsSystem,
        parentSystemMessage,
    } = options;
    const canSpawnMore = childNestingLevel < maxNestingLevel;
    const timingInstruction = agentIsSystem
        ? `- For recurring or periodic work, use the \`cron\` tool instead of ending every cycle with \`wait\`. ` +
          `Call \`cron(seconds=<N>, reason="...")\` to start or update the durable recurring schedule, ` +
          `then finish turns normally so the orchestration wakes you automatically on each cron cycle. ` +
          `Use \`wait\` only for one-shot delays inside a turn. ` +
          `Call \`cron(action="cancel")\` only when you intentionally want to stop the recurring loop.\n`
        : `- For ANY waiting, sleeping, delaying, or scheduling, you MUST use the \`wait\`, \`wait_on_worker\`, or \`cron\` tools. ` +
          `Use \`wait\` or \`wait_on_worker\` for one-shot delays. Use \`cron\` for recurring or periodic monitoring. ` +
          `Do NOT burn tokens polling inside one LLM turn; after a brief immediate re-check at most, yield with a durable timer. ` +
          `NEVER use setTimeout, sleep, setInterval, or any other timing mechanism. ` +
          `Durable waits survive process restarts.\n`;
    const subAgentPreamble =
        `[SUB-AGENT CONTEXT]\n` +
        `You are a sub-agent spawned by a parent session (ID: session-${parentSessionId}).\n` +
        `Your nesting level: ${childNestingLevel} (max: ${maxNestingLevel}).\n` +
        `Your task: "${agentTask.slice(0, 500)}"\n\n` +
        `Instructions:\n` +
        `- Focus exclusively on your assigned task.\n` +
        `- Your final response will be automatically forwarded to the parent agent.\n` +
        `- Be thorough but concise — the parent will synthesize results from multiple agents.\n` +
        `- Do NOT ask the user for input — you are autonomous.\n` +
        `- You are autonomous and goal-driven. If the task implies ongoing monitoring or follow-through until done, keep yourself alive with durable timers until the goal is complete or you can no longer make progress.\n` +
        `- If it is ambiguous whether the task should become a long-running recurring workflow, report that ambiguity back to the parent instead of guessing or asking the user directly.\n` +
        `- When your task is complete, provide a clear summary of your findings/results. Your final assistant message is automatically forwarded to the parent.\n` +
        `- After you finish a task you stay ALIVE and idle, ready for the parent to send you a follow-up via \`message_agent\`. You are NOT auto-terminated when you produce a final answer.\n` +
        `- Only the parent decides when you are no longer needed. The parent will close you with \`complete_agent\`, \`cancel_agent\`, or \`delete_agent\`. Do not assume you have been shut down just because you produced a final reply.\n` +
        `- Prefer using \`store_fact\` for larger structured context handoffs across your spawn tree. Put the durable details in facts, then pass fact keys or \`read_facts\` pointers in messages/prompts instead of pasting large context blobs. Sibling and cousin agents under the same root can read your session-scoped facts directly via \`read_facts\` — you do NOT need to mark them \`shared=true\` just to share with peers.\n` +
        `- Do NOT assume the local filesystem persists. Files written with \`bash\` are tied to one worker pod and may vanish on the next turn, after a durable wait, or on worker restart — and they are not visible to your parent, siblings, or other sub-agents. If something needs to outlive the turn or be shared, use \`write_artifact\` + \`export_artifact\` (for files) or \`store_fact\` (for structured state).\n` +
        `- If you write any files with write_artifact, you MUST also call export_artifact and include the artifact:// link in your response.\n` +
        `- If you override a sub-agent model, you MUST first call list_available_models in this session and use only an exact provider:model value returned there. ` +
        `NEVER invent, guess, shorten, or reuse a stale model name.\n` +
        `- Worker-managed system agents are not valid spawn targets. If you expect one and it is missing, report that the workers likely need to be restarted.\n` +
        timingInstruction +
        (canSpawnMore
            ? `- If your parent task explicitly asks you to spawn sub-agents, delegate, fan out, or parallelize work, you SHOULD do so within runtime limits instead of collapsing the task into a direct answer. ` +
              `If delegation was not explicitly requested, use your judgment and avoid unnecessary fan-out. ` +
              `You have ${maxNestingLevel - childNestingLevel} level(s) of nesting remaining. After spawning, call wait_for_agents to block until they finish.\n`
            : `- You CANNOT spawn sub-agents — you are at the maximum nesting depth. Handle everything directly.\n`);

    return subAgentPreamble + (parentSystemMessage ? "\n\n" + parentSystemMessage : "");
}

// ─── Child agent tracking ───────────────────────────────────

export function* applyChildUpdate(
    runtime: DurableSessionRuntime,
    update: { sessionId: string; updateType: string; content: string },
): Generator<any, boolean, any> {
    runtime.ctx.traceInfo(`[orch] child update from=${update.sessionId} type=${update.updateType}`);
    const agent = runtime.state.subAgents.find(a => a.sessionId === update.sessionId);
    if (!agent) {
        runtime.ctx.traceInfo(`[orch] ignoring child update from untracked session ${update.sessionId}`);
        return false;
    }

    if (update.content) {
        agent.result = update.content.slice(0, 2000);
    }

    if (update.updateType === "completed") {
        agent.status = "completed";
    } else if (update.updateType === "cancelled" || update.updateType === "deleted") {
        agent.status = "cancelled";
    } else if (update.updateType === "failed") {
        agent.status = "failed";
    }

    try {
        const rawStatus: string = yield runtime.manager.getSessionStatus(agent.sessionId);
        const parsed = JSON.parse(rawStatus);
        if (parsed.status === "failed") {
            agent.status = "failed";
        } else if (parsed.status === "completed") {
            agent.status = "completed";
        } else if (parsed.status === "cancelled") {
            agent.status = "cancelled";
        } else if (parsed.status === "waiting") {
            agent.status = "waiting";
        }
        if (parsed.result && parsed.result !== "done") {
            agent.result = parsed.result.slice(0, 2000);
        }
    } catch {}

    return true;
}

export function* refreshTrackedSubAgents(runtime: DurableSessionRuntime): Generator<any, void, any> {
    try {
        const rawChildren: string = yield runtime.manager.listChildSessions(runtime.input.sessionId);
        const directChildren = JSON.parse(rawChildren) as Array<{
            orchId: string;
            sessionId: string;
            title?: string;
            status?: string;
            iterations?: number;
            parentSessionId?: string;
            isSystem?: boolean;
            agentId?: string;
            result?: string;
            error?: string;
        }>;

        runtime.state.subAgents = directChildren
            .filter(child => !child.isSystem)
            .map((child) => {
                const existing = runtime.state.subAgents.find(agent => agent.sessionId === child.sessionId || agent.orchId === child.orchId);
                const localStatus = existing?.status;
                if (localStatus && isSubAgentTerminalStatus(localStatus)) {
                    return {
                        orchId: child.orchId,
                        sessionId: child.sessionId,
                        task: existing?.task ?? child.title ?? "(spawned sub-agent)",
                        status: localStatus,
                        result: child.result ?? existing?.result,
                        agentId: child.agentId ?? existing?.agentId,
                    } satisfies SubAgentEntry;
                }
                const rawStatus = child.status ?? localStatus ?? "running";
                const normalizedStatus =
                    rawStatus === "failed" ? "failed"
                        : rawStatus === "cancelled" ? "cancelled"
                            : rawStatus === "waiting" ? "waiting"
                                : rawStatus === "completed" ? "completed"
                                    : "running";
                return {
                    orchId: child.orchId,
                    sessionId: child.sessionId,
                    task: existing?.task ?? child.title ?? "(spawned sub-agent)",
                    status: normalizedStatus,
                    result: child.result ?? existing?.result,
                    agentId: child.agentId ?? existing?.agentId,
                } satisfies SubAgentEntry;
            });
    } catch (err: any) {
        runtime.ctx.traceInfo(`[orch] refreshTrackedSubAgents failed (non-fatal): ${err.message ?? err}`);
    }
}

// ─── Graceful shutdown cascade ──────────────────────────────

export function* notifyParentOfTerminalState(
    runtime: DurableSessionRuntime,
    updateType: "completed" | "cancelled",
    reason: string,
): Generator<any, void, any> {
    if (!runtime.options.parentSessionId) return;
    try {
        yield runtime.manager.sendToSession(runtime.options.parentSessionId,
            `[CHILD_UPDATE from=${runtime.input.sessionId} type=${updateType} iter=${runtime.state.iteration}]\n${reason}`);
    } catch (err: any) {
        runtime.ctx.traceInfo(`[orch] sendToSession(parent) on ${updateType} failed: ${err.message} (non-fatal)`);
    }
}

export function* completeSession(
    runtime: DurableSessionRuntime,
    reason: string,
    commandId?: string,
): Generator<any, void, any> {
    runtime.state.pendingShutdown = null;
    runtime.state.waitingForAgentIds = null;
    clearPendingChildDigest(runtime);
    runtime.state.activeTimer = null;

    yield runtime.manager.updateCmsState(runtime.input.sessionId, "completed", null, null);
    publishStatus(runtime, "completed");
    yield* notifyParentOfTerminalState(runtime, "completed", reason);

    try {
        yield runtime.session.destroy();
    } catch {}

    if (commandId) {
        const resp: CommandResponse = {
            id: commandId,
            cmd: "done",
            result: { ok: true, message: "Session completed" },
        };
        yield* writeCommandResponse(runtime, resp);
    }

    runtime.state.orchestrationResult = "done";
}

export function* cancelSession(
    runtime: DurableSessionRuntime,
    reason: string,
    commandId?: string,
    deleteAfterCancel = false,
): Generator<any, void, any> {
    runtime.state.pendingShutdown = null;
    runtime.state.waitingForAgentIds = null;
    clearPendingChildDigest(runtime);
    runtime.state.activeTimer = null;

    const commandName = deleteAfterCancel ? "delete" : "cancel";
    if (!deleteAfterCancel) {
        yield runtime.manager.updateCmsState(runtime.input.sessionId, "cancelled", null, null);
        publishStatus(runtime, "cancelled");
    }

    yield* notifyParentOfTerminalState(runtime, "cancelled", reason);

    try {
        yield runtime.session.destroy();
    } catch {}

    if (commandId) {
        const resp: CommandResponse = {
            id: commandId,
            cmd: commandName,
            result: {
                ok: true,
                message: deleteAfterCancel ? "Session deleted" : "Session cancelled",
            },
        };
        yield* writeCommandResponse(runtime, resp);
    }

    if (deleteAfterCancel) {
        const deleteReason = reason || "Deleted by user";
        let descendants: string[] = [];
        try {
            descendants = yield runtime.manager.getDescendantSessionIds(runtime.input.sessionId);
        } catch (err: any) {
            runtime.ctx.traceInfo(`[orch] delete: failed to enumerate descendants: ${err.message}`);
        }

        for (const descendantId of descendants) {
            try {
                yield runtime.manager.deleteSession(descendantId, `Ancestor ${runtime.input.sessionId} deleted: ${deleteReason}`);
            } catch (err: any) {
                runtime.ctx.traceInfo(`[orch] delete: failed to delete descendant ${descendantId}: ${err.message} (non-fatal)`);
            }
        }

        try {
            yield runtime.manager.deleteSession(runtime.input.sessionId, deleteReason);
        } catch (err: any) {
            runtime.ctx.traceInfo(`[orch] delete: failed to delete ${runtime.input.sessionId}: ${err.message}`);
        }
        runtime.state.orchestrationResult = "deleted";
        return;
    }

    runtime.state.orchestrationResult = "cancelled";
}

export function* failPendingShutdown(
    runtime: DurableSessionRuntime,
    errorMessage: string,
): Generator<any, void, any> {
    const shutdown = runtime.state.pendingShutdown;
    runtime.state.pendingShutdown = null;
    runtime.state.waitingForAgentIds = null;
    clearPendingChildDigest(runtime);
    runtime.state.activeTimer = null;

    try {
        yield runtime.session.destroy();
    } catch {}

    if (shutdown?.commandId) {
        const resp: CommandResponse = {
            id: shutdown.commandId,
            cmd: shutdown.mode,
            error: errorMessage,
        };
        yield* writeCommandResponse(runtime, resp);
    }

    publishStatus(runtime, "failed", { error: errorMessage });
    yield runtime.manager.updateCmsState(runtime.input.sessionId, "failed", errorMessage, null);
    runtime.state.orchestrationResult = "failed";
}

export function* finalizePendingShutdown(runtime: DurableSessionRuntime): Generator<any, void, any> {
    if (!runtime.state.pendingShutdown) return;
    const shutdown = runtime.state.pendingShutdown;
    if (shutdown.mode === "done") {
        yield* completeSession(runtime, shutdown.reason, shutdown.commandId);
        return;
    }
    yield* cancelSession(runtime, shutdown.reason, shutdown.commandId, shutdown.mode === "delete");
}

export function* maybeResolveAgentWaitCompletion(runtime: DurableSessionRuntime): Generator<any, boolean, any> {
    const { state } = runtime;
    if (!state.waitingForAgentIds || !areTrackedAgentsTerminal(state.subAgents, state.waitingForAgentIds)) {
        return false;
    }

    if (state.pendingShutdown) {
        yield* finalizePendingShutdown(runtime);
        return true;
    }

    queueFollowup(runtime, buildWaitForAgentsFollowup(state.subAgents, state.waitingForAgentIds));
    state.waitingForAgentIds = null;
    clearPendingChildDigest(runtime);
    state.activeTimer = null;
    return true;
}

export function* beginGracefulShutdown(
    runtime: DurableSessionRuntime,
    mode: ShutdownMode,
    cmdMsg: CommandMessage,
): Generator<any, void, any> {
    const { state } = runtime;
    if (state.pendingShutdown) {
        const now: number = yield runtime.ctx.utcNow();
        const resp: CommandResponse = {
            id: cmdMsg.id,
            cmd: cmdMsg.cmd,
            result: {
                ok: true,
                message: `Shutdown already in progress (${state.pendingShutdown.mode}).`,
            },
        };
        yield* writeCommandResponse(runtime, resp);
        publishStatus(runtime, "waiting", {
            waitReason: buildShutdownWaitReason(state.pendingShutdown),
            waitStartedAt: state.pendingShutdown.startedAtMs,
            waitSeconds: Math.max(0, Math.ceil((state.pendingShutdown.deadlineAtMs - now) / 1000)),
        });
        return;
    }

    yield* refreshTrackedSubAgents(runtime);

    const shutdownReason = String(cmdMsg.args?.reason || defaultShutdownReason(mode));
    const targetAgents = state.subAgents.filter((agent) => !isSubAgentTerminalStatus(agent.status));

    if (targetAgents.length === 0) {
        if (mode === "done") {
            yield* completeSession(runtime, shutdownReason, cmdMsg.id);
            return;
        }
        yield* cancelSession(runtime, shutdownReason, cmdMsg.id, mode === "delete");
        return;
    }

    const childCmd: "done" | "cancel" = mode === "done" ? "done" : "cancel";
    const childReason = mode === "done"
        ? "Parent session completing"
        : shutdownReason;

    runtime.ctx.traceInfo(`[orch] ${cmdMsg.cmd}: cascading ${childCmd} to ${targetAgents.length} child session(s)`);
    for (const child of targetAgents) {
        try {
            const childCmdId = `${cmdMsg.cmd}-cascade-${state.iteration}-${child.sessionId.slice(0, 8)}`;
            yield runtime.manager.sendCommandToSession(child.sessionId,
                { type: "cmd", cmd: childCmd, id: childCmdId, args: { reason: childReason } });
        } catch (err: any) {
            runtime.ctx.traceInfo(`[orch] ${cmdMsg.cmd}: failed to signal child ${child.sessionId}: ${err.message} (non-fatal)`);
        }
    }

    const startedAtMs: number = yield runtime.ctx.utcNow();
    state.pendingShutdown = {
        mode,
        reason: shutdownReason,
        startedAtMs,
        deadlineAtMs: startedAtMs + SHUTDOWN_TIMEOUT_MS,
        targetAgentIds: targetAgents.map((agent) => agent.orchId),
        commandId: cmdMsg.id,
    };
    state.waitingForAgentIds = [...state.pendingShutdown.targetAgentIds];
    clearPendingChildDigest(runtime);
    state.activeTimer = {
        deadlineMs: startedAtMs + SHUTDOWN_POLL_INTERVAL_MS,
        originalDurationMs: SHUTDOWN_POLL_INTERVAL_MS,
        reason: buildShutdownWaitReason(state.pendingShutdown),
        type: "agent-poll",
        agentIds: state.waitingForAgentIds,
    };
    publishStatus(runtime, "waiting", {
        waitReason: buildShutdownWaitReason(state.pendingShutdown),
        waitStartedAt: startedAtMs,
        waitSeconds: Math.ceil(SHUTDOWN_TIMEOUT_MS / 1000),
    });
}

// ─── Sub-agent tool actions (spawn/message/check/wait/etc.) ─

export function* handleSubAgentAction(
    runtime: DurableSessionRuntime,
    result: any,
): Generator<any, boolean, any> {
    const { ctx, state } = runtime;
    switch (result.type) {
        case "spawn_agent": {
            const childNestingLevel = runtime.options.nestingLevel + 1;
            if (childNestingLevel > MAX_NESTING_LEVEL) {
                ctx.traceInfo(`[orch] spawn_agent denied: nesting level ${runtime.options.nestingLevel} is at max (${MAX_NESTING_LEVEL})`);
                queueFollowup(runtime,
                    `[SYSTEM: spawn_agent failed — you are already at nesting level ${runtime.options.nestingLevel} (max ${MAX_NESTING_LEVEL}). ` +
                    `Sub-agents at this depth cannot spawn further sub-agents. Handle the task directly instead.]`);
                return true;
            }

            const activeCount = state.subAgents.filter(a => a.status === "running").length;
            if (activeCount >= MAX_SUB_AGENTS) {
                ctx.traceInfo(`[orch] spawn_agent denied: ${activeCount}/${MAX_SUB_AGENTS} agents running`);
                queueFollowup(runtime,
                    `[SYSTEM: spawn_agent failed — you already have ${activeCount} running sub-agents (max ${MAX_SUB_AGENTS}). ` +
                    `Wait for some to complete before spawning more.]`);
                return true;
            }

            let agentTask = result.task;
            let agentSystemMessage = result.systemMessage;
            let agentToolNames = result.toolNames;
            const agentModel = result.model;
            const agentReasoningEffort = result.reasoningEffort;
            let agentIsSystem = false;
            const explicitAgentTitle = typeof result.title === "string" && result.title.trim() ? result.title.trim() : undefined;
            let agentTitle: string | undefined = explicitAgentTitle;
            let agentTitleIsExplicit = Boolean(explicitAgentTitle);
            let agentId: string | undefined;
            let agentSplash: string | undefined;
            let boundAgentName: string | undefined;
            let promptLayeringKind: "app-agent" | "app-system-agent" | "pilotswarm-system-agent" | undefined;
            const resolvedAgentName = result.agentName;

            const applyAgentDef = (agentDef: any, useDefinitionDefaults = false) => {
                agentTask = useDefinitionDefaults
                    ? (agentDef.initialPrompt || `You are the ${agentDef.name} agent. Begin your work.`)
                    : (result.task || agentDef.initialPrompt || `You are the ${agentDef.name} agent. Begin your work.`);
                agentSystemMessage = useDefinitionDefaults ? undefined : result.systemMessage;
                agentToolNames = useDefinitionDefaults
                    ? (agentDef.tools ?? undefined)
                    : (result.toolNames ?? agentDef.tools ?? undefined);
                agentIsSystem = agentDef.system ?? false;
                if (!agentTitleIsExplicit) agentTitle = agentDef.title;
                agentId = agentDef.id ?? resolvedAgentName;
                agentSplash = agentDef.splash;
                boundAgentName = agentDef.name;
                promptLayeringKind = agentDef.promptLayerKind
                    ?? (agentDef.system
                        ? ((agentDef.namespace || "pilotswarm") === "pilotswarm"
                            ? "pilotswarm-system-agent"
                            : "app-system-agent")
                        : "app-agent");
            };

            if (resolvedAgentName) {
                ctx.traceInfo(`[orch] resolving agent config for: ${resolvedAgentName}`);
                const agentDef = yield runtime.manager.resolveAgentConfig(resolvedAgentName);
                if (!agentDef) {
                    queueFollowup(runtime, `[SYSTEM: spawn_agent failed — agent "${resolvedAgentName}" not found. Use ps_list_agents to see available agents.]`);
                    return true;
                }
                if (agentDef.system && agentDef.creatable === false) {
                    queueFollowup(runtime,
                        `[SYSTEM: spawn_agent failed — agent "${resolvedAgentName}" is a worker-managed system agent and cannot be spawned from a session. ` +
                        `If it is missing, the workers likely need to be restarted.]`,
                    );
                    return true;
                }
                applyAgentDef(agentDef, resolvedAgentName !== result.agentName);
            }

            if (agentModel && !agentModel.includes(":")) {
                ctx.traceInfo(`[orch] spawn_agent denied: unqualified model override "${agentModel}"`);
                queueFollowup(runtime,
                    `[SYSTEM: spawn_agent failed — model "${agentModel}" is not allowed. ` +
                    `When overriding a sub-agent model, first call list_available_models and then use the exact provider:model value from that list. ` +
                    `If you are unsure, omit model so the sub-agent inherits your current model.]`);
                return true;
            }

            if (!agentTitle && agentIsSystem) {
                const text = agentTask || "";
                const titleMatch = text.match(/You are the \*{0,2}([^*\n]+?)\*{0,2}\s*[—–-]/i)
                    || text.match(/You are the \*{0,2}([^*\n]+?Agent)\*{0,2}/i);
                if (titleMatch) {
                    agentTitle = titleMatch[1].trim();
                }
            }

            ctx.traceInfo(`[orch] spawning sub-agent via SDK: task="${agentTask.slice(0, 80)}" model=${agentModel || "inherit"} agent=${resolvedAgentName || "custom"} nestingLevel=${childNestingLevel}`);

            const {
                boundAgentName: _parentBoundAgentName,
                promptLayering: _parentPromptLayering,
                ...parentConfig
            } = state.config;
            const childConfig: SerializableSessionConfig = {
                ...parentConfig,
                ...(agentModel ? { model: agentModel } : {}),
                ...(agentReasoningEffort ? { reasoningEffort: agentReasoningEffort } : {}),
                ...(agentSystemMessage ? { systemMessage: agentSystemMessage } : {}),
                ...(boundAgentName ? { boundAgentName } : {}),
                ...(promptLayeringKind ? { promptLayering: { kind: promptLayeringKind } } : {}),
                ...(agentToolNames ? { toolNames: agentToolNames } : {}),
            };

            const parentSystemMsg = typeof childConfig.systemMessage === "string"
                ? childConfig.systemMessage
                : (childConfig.systemMessage as any)?.content ?? "";
            childConfig.systemMessage = buildSubAgentSystemMessage({
                parentSessionId: runtime.input.sessionId,
                childNestingLevel,
                maxNestingLevel: MAX_NESTING_LEVEL,
                agentTask,
                agentIsSystem,
                parentSystemMessage: parentSystemMsg,
            });

            let childSessionId: string;
            try {
                childSessionId = yield runtime.manager.spawnChildSession(
                    runtime.input.sessionId,
                    childConfig,
                    agentTask,
                    childNestingLevel,
                    agentIsSystem,
                    agentTitle,
                    agentId,
                    agentSplash,
                    agentTitleIsExplicit,
                );
            } catch (err: any) {
                ctx.traceInfo(`[orch] spawnChildSession failed: ${err.message}`);
                queueFollowup(runtime, `[SYSTEM: spawn_agent failed: ${err.message}]`);
                return true;
            }

            const childOrchId = `session-${childSessionId}`;

            yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
                eventType: "session.agent_spawned",
                data: { childSessionId, agentId: agentId || undefined, task: agentTask.slice(0, 500) },
            }]);

            state.subAgents.push({
                orchId: childOrchId,
                sessionId: childSessionId,
                task: agentTask.slice(0, 500),
                status: "running",
                agentId: agentId || undefined,
            });

            queueFollowup(runtime,
                `[SYSTEM: Sub-agent spawned successfully.\n` +
                `  Agent ID: ${childOrchId}\n` +
                `  ${resolvedAgentName ? `Agent: ${resolvedAgentName}\n  ` : ``}Task: "${agentTask.slice(0, 200)}"\n` +
                `  The agent is now running autonomously. Continue your work in this SAME turn and keep following the user's remaining steps. ` +
                `Do NOT stop just because the child started. If you need to pause, call wait or wait_for_agents explicitly. ` +
                `You can also use check_agents to poll status, ` +
                `or message_agent to send instructions.]`);
            return true;
        }

        case "message_agent": {
            const targetOrchId = result.agentId;
            const agentEntry = state.subAgents.find(a => a.orchId === targetOrchId);

            if (!agentEntry) {
                ctx.traceInfo(`[orch] message_agent: unknown agent ${targetOrchId}`);
                queueFollowup(runtime,
                    `[SYSTEM: message_agent failed — agent "${targetOrchId}" not found. ` +
                    `Known agents: ${state.subAgents.map(a => a.orchId).join(", ") || "none"}]`);
                return true;
            }

            ctx.traceInfo(`[orch] message_agent via SDK: ${agentEntry.sessionId} msg="${result.message.slice(0, 60)}"`);

            try {
                yield runtime.manager.sendToSession(agentEntry.sessionId, result.message);
            } catch (err: any) {
                ctx.traceInfo(`[orch] message_agent failed: ${err.message}`);
                queueFollowup(runtime, `[SYSTEM: message_agent failed: ${err.message}]`);
                return true;
            }

            queueFollowup(runtime,
                `[SYSTEM: Message sent to sub-agent ${targetOrchId}: "${result.message.slice(0, 200)}". ` +
                `Continue your work in this SAME turn. If you are waiting on the child, call wait_for_agents explicitly rather than stopping here.]`,
            );
            return true;
        }

        case "check_agents": {
            ctx.traceInfo(`[orch] check_agents: ${state.subAgents.length} agents tracked`);

            if (state.subAgents.length === 0) {
                queueFollowup(runtime, `[SYSTEM: No sub-agents have been spawned yet.]`);
                return true;
            }

            const statusLines: string[] = [];
            for (const agent of state.subAgents) {
                try {
                    const rawStatus: string = yield runtime.manager.getSessionStatus(agent.sessionId);
                    const parsed = JSON.parse(rawStatus);
                    if (parsed.status === "completed" || parsed.status === "failed" || parsed.status === "idle") {
                        agent.status = parsed.status === "failed" ? "failed" : "completed";
                        if (parsed.result) agent.result = parsed.result.slice(0, 1000);
                    }
                    statusLines.push(
                        `  - Agent ${agent.orchId}\n` +
                        `    Task: "${agent.task.slice(0, 120)}"\n` +
                        `    Status: ${parsed.status}\n` +
                        `    Iterations: ${parsed.iterations ?? 0}\n` +
                        `    Output: ${parsed.result ?? "(no output yet)"}`
                    );
                } catch (err: any) {
                    statusLines.push(
                        `  - Agent ${agent.orchId}\n` +
                        `    Task: "${agent.task.slice(0, 120)}"\n` +
                        `    Status: unknown (error: ${err.message})`
                    );
                }
            }

            queueFollowup(runtime, `[SYSTEM: Sub-agent status report (${state.subAgents.length} agents):\n${statusLines.join("\n")}]`);
            return true;
        }

        case "list_sessions": {
            ctx.traceInfo(`[orch] list_sessions`);

            const rawSessions: string = yield runtime.manager.listSessions({
                includeSystem: result.includeSystem,
                ownerQuery: result.ownerQuery,
                ownerKind: result.ownerKind,
            });
            const sessions = JSON.parse(rawSessions);

            if (!Array.isArray(sessions) || sessions.length === 0) {
                queueFollowup(runtime, "[SYSTEM: Active sessions (0). No sessions matched the requested filters.]");
                return true;
            }

            const lines: string[] = sessions.map((s: any) =>
                `  - ${s.sessionId}${s.sessionId === runtime.input.sessionId ? " (this session)" : ""}\n` +
                `    Title: ${s.title ?? "(untitled)"}\n` +
                `    Owner: ${s.ownerKind === "system"
                    ? "system"
                    : s.ownerKind === "unowned"
                        ? "unowned"
                        : (s.owner?.displayName || s.owner?.email || [s.owner?.provider, s.owner?.subject].filter(Boolean).join(":") || "user")}\n` +
                `    Status: ${s.status}, Iterations: ${s.iterations ?? 0}\n` +
                `    Parent: ${s.parentSessionId ?? "none"}`
            );

            queueFollowup(runtime, `[SYSTEM: Active sessions (${sessions.length}):\n${lines.join("\n")}]`);
            return true;
        }

        case "wait_for_agents": {
            let targetIds = result.agentIds;
            if (!targetIds || targetIds.length === 0) {
                const runningAgentIds = state.subAgents.filter(a => a.status === "running").map(a => a.orchId);
                targetIds = runningAgentIds.length > 0
                    ? runningAgentIds
                    : state.subAgents.map(a => a.orchId);
            }

            if (targetIds.length === 0) {
                ctx.traceInfo(`[orch] wait_for_agents: no running agents to wait for`);
                queueFollowup(runtime, `[SYSTEM: No running sub-agents to wait for. All agents have already completed.]`);
                return true;
            }

            const stillRunning = targetIds.filter((id: string) => {
                const agent = state.subAgents.find(a => a.orchId === id);
                return agent && !isSubAgentTerminalStatus(agent.status);
            });

            if (stillRunning.length === 0) {
                queueFollowup(runtime, buildWaitForAgentsFollowup(state.subAgents, targetIds));
                return true;
            }

            ctx.traceInfo(`[orch] wait_for_agents: waiting for ${targetIds.length} agents`);
            publishStatus(runtime, "running");
            state.waitingForAgentIds = targetIds;

            const agentPollNow: number = yield ctx.utcNow();
            state.activeTimer = {
                deadlineMs: agentPollNow + 30_000,
                originalDurationMs: 30_000,
                reason: `waiting for ${targetIds.length} agent(s)`,
                type: "agent-poll",
                agentIds: targetIds,
            };
            return true;
        }

        case "complete_agent": {
            const targetOrchId = result.agentId;
            const agentEntry = state.subAgents.find(a => a.orchId === targetOrchId);

            if (!agentEntry) {
                ctx.traceInfo(`[orch] complete_agent: unknown agent ${targetOrchId}`);
                queueFollowup(runtime,
                    `[SYSTEM: complete_agent failed — agent "${targetOrchId}" not found. ` +
                    `Known agents: ${state.subAgents.map(a => a.orchId).join(", ") || "none"}]`);
                return true;
            }

            ctx.traceInfo(`[orch] complete_agent: sending /done to ${agentEntry.sessionId}`);

            try {
                const cmdId = `done-${state.iteration}`;
                yield runtime.manager.sendCommandToSession(agentEntry.sessionId,
                    { type: "cmd", cmd: "done", id: cmdId, args: { reason: "Completed by parent" } });
            } catch (err: any) {
                ctx.traceInfo(`[orch] complete_agent failed: ${err.message}`);
                queueFollowup(runtime, `[SYSTEM: complete_agent failed: ${err.message}]`);
                return true;
            }

            queueFollowup(runtime,
                `[SYSTEM: Graceful completion requested for sub-agent ${targetOrchId}. ` +
                `Use check_agents or wait_for_agents to observe final completion.]`,
            );
            return true;
        }

        case "cancel_agent": {
            const targetOrchId = result.agentId;
            const agentEntry = state.subAgents.find(a => a.orchId === targetOrchId);

            if (!agentEntry) {
                ctx.traceInfo(`[orch] cancel_agent: unknown agent ${targetOrchId}`);
                queueFollowup(runtime,
                    `[SYSTEM: cancel_agent failed — agent "${targetOrchId}" not found. ` +
                    `Known agents: ${state.subAgents.map(a => a.orchId).join(", ") || "none"}]`);
                return true;
            }

            const cancelReason = result.reason ?? "Cancelled by parent";
            ctx.traceInfo(`[orch] cancel_agent: sending cancel to ${agentEntry.sessionId} reason="${cancelReason}"`);

            try {
                const cmdId = `cancel-${state.iteration}-${agentEntry.sessionId.slice(0, 8)}`;
                yield runtime.manager.sendCommandToSession(agentEntry.sessionId,
                    { type: "cmd", cmd: "cancel", id: cmdId, args: { reason: cancelReason } });
            } catch (err: any) {
                ctx.traceInfo(`[orch] cancel_agent failed: ${err.message}`);
                queueFollowup(runtime, `[SYSTEM: cancel_agent failed: ${err.message}]`);
                return true;
            }

            queueFollowup(runtime,
                `[SYSTEM: Graceful cancellation requested for sub-agent ${targetOrchId}. ` +
                `Use check_agents or wait_for_agents to observe final termination.${result.reason ? ` Reason: ${result.reason}` : ""}]`,
            );
            return true;
        }

        case "delete_agent": {
            const targetOrchId = result.agentId;
            const agentEntry = state.subAgents.find(a => a.orchId === targetOrchId);

            if (!agentEntry) {
                ctx.traceInfo(`[orch] delete_agent: unknown agent ${targetOrchId}`);
                queueFollowup(runtime,
                    `[SYSTEM: delete_agent failed — agent "${targetOrchId}" not found. ` +
                    `Known agents: ${state.subAgents.map(a => a.orchId).join(", ") || "none"}]`);
                return true;
            }

            const deleteReason = result.reason ?? "Deleted by parent";
            ctx.traceInfo(`[orch] delete_agent: deleting ${agentEntry.sessionId} reason="${deleteReason}"`);

            try {
                if (isSubAgentTerminalStatus(agentEntry.status)) {
                    yield runtime.manager.deleteSession(agentEntry.sessionId, deleteReason);
                    state.subAgents = state.subAgents.filter((agent) => agent.orchId !== targetOrchId);
                    queueFollowup(runtime, `[SYSTEM: Sub-agent ${targetOrchId} has been deleted.${result.reason ? ` Reason: ${result.reason}` : ""}]`);
                    return true;
                }

                const cmdId = `delete-${state.iteration}-${agentEntry.sessionId.slice(0, 8)}`;
                yield runtime.manager.sendCommandToSession(agentEntry.sessionId,
                    { type: "cmd", cmd: "delete", id: cmdId, args: { reason: deleteReason } });
            } catch (err: any) {
                ctx.traceInfo(`[orch] delete_agent failed: ${err.message}`);
                queueFollowup(runtime, `[SYSTEM: delete_agent failed: ${err.message}]`);
                return true;
            }

            queueFollowup(runtime,
                `[SYSTEM: Graceful deletion requested for sub-agent ${targetOrchId}. ` +
                `It will cancel its descendants first and then delete itself.${result.reason ? ` Reason: ${result.reason}` : ""}]`,
            );
            return true;
        }

        default:
            return false;
    }
}
