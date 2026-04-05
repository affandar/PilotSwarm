import type { SessionManager } from "./session-manager.js";
import type { SessionStateStore } from "./session-store.js";
import type { SessionCatalogProvider } from "./cms.js";
import { SESSION_STATE_MISSING_PREFIX, type SerializableSessionConfig, type TurnResult, type OrchestrationInput } from "./types.js";
import type { AgentConfig } from "./agent-loader.js";
import { systemChildAgentUUID } from "./agent-loader.js";
import { PilotSwarmClient } from "./client.js";
import { loadKnowledgeIndexFromFactStore } from "./knowledge-index.js";
import { mergePromptSections } from "./prompt-layering.js";
import os from "node:os";

const SESSION_RECOVERY_NOTICE =
    "[SYSTEM: The runtime recovered this session after the live Copilot session was lost on a worker. " +
    "Some very recent in-memory state may have been lost. Re-read the visible conversation and continue carefully from the latest durable state.]";

function normalizePromptText(text?: string): string {
    return String(text || "").replace(/\r\n/g, "\n").trim();
}

function isInternalSystemPrompt(text?: string): boolean {
    const normalized = normalizePromptText(text);
    if (!normalized) return false;

    return /^\[SYSTEM:/i.test(normalized)
        || /^\[CHILD_UPDATE\b/i.test(normalized)
        || /^Sub-agent spawned successfully\./i.test(normalized)
        || /^Message sent to sub-agent /i.test(normalized)
        || /^No sub-agents have been spawned yet\./i.test(normalized)
        || /^Sub-agent status report \(/i.test(normalized)
        || /^Active sessions \(/i.test(normalized)
        || /^Sub-agents completed:/i.test(normalized)
        || /^Sub-agent .* has been (completed gracefully|cancelled|deleted)\./i.test(normalized)
        || /^(spawn_agent|message_agent|check_agents|wait_for_agents|complete_agent|cancel_agent|delete_agent) failed/i.test(normalized);
}

function isLiveSessionLostErrorMessage(message?: string): boolean {
    const normalized = String(message || "");
    return /\bSession not found\b/i.test(normalized);
}

function buildUnrecoverableSessionLossMessage(sessionId: string, detail: string): string {
    return `${SESSION_STATE_MISSING_PREFIX} unrecoverable live Copilot session loss for ${sessionId}. ` +
        `The runtime attempted to resume or rehydrate the session, but recovery failed. ` +
        `Some very recent in-memory state may have been lost. ${detail}`;
}

// ─── SessionProxy ────────────────────────────────────────────────
// The orchestration's view of a specific ManagedSession.
// Each method maps 1:1 to an activity dispatched to the session's worker node.

export function createSessionProxy(
    ctx: any,
    sessionId: string,
    affinityKey: string,
    config: SerializableSessionConfig,
) {
    return {
        runTurn(
            prompt: string,
            bootstrap?: boolean,
            turnIndex?: number,
            turnMeta?: { parentSessionId?: string; nestingLevel?: number; requiredTool?: string; retryCount?: number },
        ) {
            return ctx.scheduleActivityOnSession(
                "runTurn",
                {
                    sessionId,
                    prompt,
                    config,
                    ...(bootstrap ? { bootstrap: true } : {}),
                    ...(turnIndex != null ? { turnIndex } : {}),
                    ...(turnMeta?.parentSessionId ? { parentSessionId: turnMeta.parentSessionId } : {}),
                    ...(turnMeta?.nestingLevel != null ? { nestingLevel: turnMeta.nestingLevel } : {}),
                    ...(turnMeta?.requiredTool ? { requiredTool: turnMeta.requiredTool } : {}),
                    ...(turnMeta?.retryCount != null ? { retryCount: turnMeta.retryCount } : {}),
                },
                affinityKey,
            );
        },
        dehydrate(reason: string, eventData?: Record<string, unknown>) {
            return ctx.scheduleActivityOnSession(
                "dehydrateSession",
                {
                    sessionId,
                    reason,
                    ...(eventData && Object.keys(eventData).length > 0 ? { eventData } : {}),
                },
                affinityKey,
            );
        },
        hydrate() {
            return ctx.scheduleActivityOnSession(
                "hydrateSession",
                { sessionId },
                affinityKey,
            );
        },
        needsHydration() {
            return ctx.scheduleActivityOnSession(
                "needsHydrationSession",
                { sessionId },
                affinityKey,
            );
        },
        destroy() {
            return ctx.scheduleActivityOnSession(
                "destroySession",
                { sessionId },
                affinityKey,
            );
        },
        checkpoint() {
            return ctx.scheduleActivityOnSession(
                "checkpointSession",
                { sessionId },
                affinityKey,
            );
        },
    };
}

export function buildRunTurnConfig(
    inputConfig: SerializableSessionConfig,
    hostname: string,
    fallbackAgentIdentity?: string,
): SerializableSessionConfig {
    const runConfig: SerializableSessionConfig = {
        ...inputConfig,
        turnSystemPrompt: mergePromptSections([
            inputConfig.turnSystemPrompt,
            `Running on host "${hostname}".`,
        ]),
    };

    if (!runConfig.agentIdentity && fallbackAgentIdentity) {
        runConfig.agentIdentity = fallbackAgentIdentity;
    }

    return runConfig;
}

// ─── SessionManagerProxy ─────────────────────────────────────────
// The orchestration's view of the SessionManager singleton.
// Operations that don't require session affinity.

export function createSessionManagerProxy(ctx: any) {
    return {
        listModels() {
            return ctx.scheduleActivity("listModels", {});
        },
        summarizeSession(sessionId: string) {
            return ctx.scheduleActivity("summarizeSession", { sessionId });
        },
        /** Spawn a child session via the PilotSwarmClient SDK. Returns the generated child session ID. */
        spawnChildSession(parentSessionId: string, config: any, task: string, nestingLevel?: number, isSystem?: boolean, title?: string, agentId?: string, splash?: string) {
            return ctx.scheduleActivity("spawnChildSession", { parentSessionId, config, task, nestingLevel, isSystem, title, agentId, splash });
        },
    /** Resolve a loaded agent config by name. Returns null if not found. */
    resolveAgentConfig(agentName: string) {
        return ctx.scheduleActivity("resolveAgentConfig", { agentName });
    },
        /** Send a message to a session via the PilotSwarmClient SDK. */
        sendToSession(sessionId: string, message: string) {
            return ctx.scheduleActivity("sendToSession", { sessionId, message });
        },
        /** Send a raw command (JSON) directly to a session's event queue. */
        sendCommandToSession(sessionId: string, command: any) {
            return ctx.scheduleActivity("sendCommandToSession", { sessionId, command });
        },
        /** Get the status of a session via the PilotSwarmClient SDK. */
        getSessionStatus(sessionId: string) {
            return ctx.scheduleActivity("getSessionStatus", { sessionId });
        },
        /** List all sessions via the PilotSwarmClient SDK. */
        listSessions() {
            return ctx.scheduleActivity("listSessions", {});
        },
        /** List direct child sessions of a session. */
        listChildSessions(parentSessionId: string) {
            return ctx.scheduleActivity("listChildSessions", { parentSessionId });
        },
        /** @deprecated Send a child_updates event to a parent orchestration. Use sendToSession instead. */
        notifyParent(parentOrchId: string, childOrchId: string, childSessionId: string, update: any) {
            return ctx.scheduleActivity("notifyParent", { parentOrchId, childOrchId, childSessionId, update });
        },
        /** Get all descendant session IDs of a session (children, grandchildren, etc.). */
        getDescendantSessionIds(sessionId: string) {
            return ctx.scheduleActivity("getDescendantSessionIds", { sessionId });
        },
        /** Cancel a session's orchestration (terminates immediately). */
        cancelSession(sessionId: string, reason?: string) {
            return ctx.scheduleActivity("cancelSession", { sessionId, reason });
        },
        /** Cancel a session's orchestration and delete it from CMS. */
        deleteSession(sessionId: string, reason?: string) {
            return ctx.scheduleActivity("deleteSession", { sessionId, reason });
        },
        /** Update a session's CMS state (e.g. "rejected" for policy violations). */
        updateCmsState(sessionId: string, state: string, lastError?: string) {
            return ctx.scheduleActivity("updateCmsState", { sessionId, state, ...(lastError ? { lastError } : {}) });
        },
        /** Get the worker's authoritative session policy + allowed agent names. */
        getWorkerSessionPolicy() {
            return ctx.scheduleActivity("getWorkerSessionPolicy", {});
        },
        /** Load curated skills and open asks from the knowledge pipeline. */
        loadKnowledgeIndex(cap?: number) {
            return ctx.scheduleActivity("loadKnowledgeIndex", { cap });
        },
        /** Record CMS lifecycle events from the orchestration (waits, spawns, cron, commands). */
        recordSessionEvent(sessionId: string, events: { eventType: string; data: unknown }[]) {
            return ctx.scheduleActivity("recordSessionEvent", { sessionId, events });
        },
    };
}

// ─── Activity Registration ───────────────────────────────────────
// Thin dispatchers — each is a one-liner that calls the corresponding
// SessionManager or ManagedSession method.

export function registerActivities(
    runtime: any,
    sessionManager: SessionManager,
    _sessionStore: SessionStateStore | null,
    githubToken?: string,
    catalog?: SessionCatalogProvider | null,
    provider?: any,
    storeUrl?: string,
    cmsSchema?: string,
    clientConfig?: {
        duroxideSchema?: string;
        factsSchema?: string;
    },
    /** Loaded system agents — used by resolveAgentConfig activity. */
    systemAgents?: AgentConfig[],
    /** Worker-level session policy — used by getWorkerSessionPolicy activity. */
    workerSessionPolicy?: import("./types.js").SessionPolicy | null,
    /** Names of loaded non-system agents — used by getWorkerSessionPolicy activity. */
    workerAllowedAgentNames?: string[],
    /** Loaded user-creatable agents — used by resolveAgentConfig activity. */
    userAgents?: Array<{ name: string; description?: string; prompt: string; tools?: string[] | null; namespace?: string; id?: string; title?: string; initialPrompt?: string; splash?: string; parent?: string; promptLayerKind?: "app-agent" | "app-system-agent" | "pilotswarm-system-agent" }>,
    /** Fact store instance for the loadKnowledgeIndex activity. */
    factStore?: import("./facts-store.js").FactStore | null,
    /** Worker node identifier — written on every CMS event for worker tracking. */
    workerNodeId?: string,
) {
    // ── runTurn ──────────────────────────────────────────────
    runtime.registerActivity("runTurn", async (
        activityCtx: any,
        input: {
            sessionId: string;
            prompt: string;
            config: SerializableSessionConfig;
            bootstrap?: boolean;
            turnIndex?: number;
            parentSessionId?: string;
            nestingLevel?: number;
            requiredTool?: string;
            retryCount?: number;
        },
    ): Promise<TurnResult> => {
        activityCtx.traceInfo(`[runTurn] session=${input.sessionId}`);

        const hostname = os.hostname();
        const MAX_SUB_AGENTS = 20;
        const MAX_NESTING_LEVEL = 2;
        let fallbackAgentIdentity: string | undefined;
        // Self-heal older persisted system sessions created before agentIdentity
        // was forwarded through worker bootstrap/orchestration input.
        if (!input.config.agentIdentity && catalog) {
            try {
                const row = await catalog.getSession(input.sessionId);
                fallbackAgentIdentity = row?.agentId ?? undefined;
            } catch {}
        }

        const runConfig = buildRunTurnConfig(input.config, hostname, fallbackAgentIdentity);

        const failForMissingState = async (message: string) => {
            if (catalog) {
                await catalog.updateSession(input.sessionId, {
                    state: "failed",
                    lastError: message,
                }).catch(() => {});
            }
            return { type: "error", message } as TurnResult;
        };

        let session: any = null;
        try {
            session = await sessionManager.getOrCreate(input.sessionId, runConfig, {
                turnIndex: input.turnIndex,
            });
        } catch (err: any) {
            const message = err?.message || String(err);
            if (message.includes(SESSION_STATE_MISSING_PREFIX)) {
                return await failForMissingState(message);
            }
            throw err;
        }

        let inlineSdkClient: PilotSwarmClient | null = null;
        let inlineSdkClientPromise: Promise<PilotSwarmClient> | null = null;
        const getInlineClient = async () => {
            if (inlineSdkClient) return inlineSdkClient;
            if (inlineSdkClientPromise) return await inlineSdkClientPromise;
            if (!storeUrl) throw new Error("No storeUrl — cannot create PilotSwarmClient");
            inlineSdkClientPromise = (async () => {
                const startedClient = new PilotSwarmClient({
                    store: storeUrl,
                    cmsSchema,
                    ...(clientConfig?.duroxideSchema != null && { duroxideSchema: clientConfig.duroxideSchema }),
                    ...(clientConfig?.factsSchema != null && { factsSchema: clientConfig.factsSchema }),
                });
                await startedClient.start();
                inlineSdkClient = startedClient;
                return startedClient;
            })();
            try {
                return await inlineSdkClientPromise;
            } finally {
                inlineSdkClientPromise = null;
            }
        };

        const normalizeAgentLookup = (value?: string) => (value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
        const resolveAgentConfigInline = (agentName: string) => {
            const agents: Array<any> = [
                ...(userAgents ?? []).map(a => ({ ...a, system: false, creatable: true })),
                ...(systemAgents ?? []).map(a => ({ ...a, creatable: false })),
            ];
            let lookupNamespace: string | undefined;
            let rawName = agentName;
            if (agentName.includes(":")) {
                const parts = agentName.split(":");
                lookupNamespace = parts[0];
                rawName = parts.slice(1).join(":");
            }
            const lookup = normalizeAgentLookup(rawName);
            const lookupBase = lookup.replace(/agent$/, "");
            return agents.find(a => {
                if (lookupNamespace && normalizeAgentLookup(a.namespace) !== normalizeAgentLookup(lookupNamespace)) return false;
                const candidates = [a.name, a.id, a.title].map(normalizeAgentLookup).filter(Boolean);
                return candidates.includes(lookup) || (lookupBase && candidates.includes(lookupBase));
            }) ?? null;
        };

        const loadDirectChildSessions = async () => {
            const sdkClient = await getInlineClient();
            const sessions = await sdkClient.listSessions();
            const directChildren = sessions.filter(s => s.parentSessionId === input.sessionId);
            return await Promise.all(directChildren.map(async (child) => {
                const info = await sdkClient._getSessionInfo(child.sessionId);
                return {
                    orchId: `session-${child.sessionId}`,
                    sessionId: child.sessionId,
                    title: info.title ?? child.title,
                    status: info.status,
                    iterations: info.iterations ?? child.iterations ?? 0,
                    parentSessionId: child.parentSessionId,
                    isSystem: child.isSystem ?? info.isSystem ?? false,
                    agentId: child.agentId ?? info.agentId,
                    result: info.result,
                    error: info.error,
                };
            }));
        };

        const resolveManagedChild = async (agentId: string) => {
            const targetOrchId = agentId.startsWith("session-") ? agentId : `session-${agentId}`;
            const children = await loadDirectChildSessions();
            const child = children.find(entry => entry.orchId === targetOrchId);
            if (!child) {
                throw new Error(
                    `agent "${targetOrchId}" not found. Known agents: ${children.filter(entry => !entry.isSystem).map(entry => entry.orchId).join(", ") || "none"}`,
                );
            }
            if (child.isSystem) {
                throw new Error(`agent "${targetOrchId}" is a worker-managed system agent and is not a controllable spawned sub-agent`);
            }
            return child;
        };

        const controlToolBridge = {
            spawnAgent: async (args: {
                agent_name?: string;
                task?: string;
                model?: string;
                system_message?: string;
                tool_names?: string[];
            }) => {
                try {
                    const childNestingLevel = (input.nestingLevel ?? 0) + 1;
                    if (childNestingLevel > MAX_NESTING_LEVEL) {
                        return `[SYSTEM: spawn_agent failed — you are already at nesting level ${input.nestingLevel ?? 0} (max ${MAX_NESTING_LEVEL}). ` +
                            `Sub-agents at this depth cannot spawn further sub-agents. Handle the task directly instead.]`;
                    }

                    const existingChildren = (await loadDirectChildSessions()).filter(child => !child.isSystem);
                    const activeCount = existingChildren.filter(child => child.status === "running").length;
                    if (activeCount >= MAX_SUB_AGENTS) {
                        return `[SYSTEM: spawn_agent failed — you already have ${activeCount} running sub-agents (max ${MAX_SUB_AGENTS}). ` +
                            `Wait for some to complete before spawning more.]`;
                    }

                    let agentTask = args.task || "";
                    let agentSystemMessage = args.system_message;
                    let agentToolNames = args.tool_names;
                    let agentModel = args.model;
                    let agentIsSystem = false;
                    let agentTitle: string | undefined;
                    let agentId: string | undefined;
                    let agentSplash: string | undefined;
                    let boundAgentName: string | undefined;
                    let promptLayeringKind: "app-agent" | "app-system-agent" | "pilotswarm-system-agent" | undefined;
                    let resolvedAgentName = args.agent_name;

                    const applyAgentDef = (agentDef: any, useDefinitionDefaults = false) => {
                        agentTask = useDefinitionDefaults
                            ? (agentDef.initialPrompt || `You are the ${agentDef.name} agent. Begin your work.`)
                            : (args.task || agentDef.initialPrompt || `You are the ${agentDef.name} agent. Begin your work.`);
                        agentSystemMessage = useDefinitionDefaults ? undefined : args.system_message;
                        agentToolNames = useDefinitionDefaults
                            ? (agentDef.tools ?? undefined)
                            : (args.tool_names ?? agentDef.tools ?? undefined);
                        agentIsSystem = agentDef.system ?? false;
                        agentTitle = agentDef.title;
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
                        const agentDef = resolveAgentConfigInline(resolvedAgentName);
                        if (!agentDef) {
                            return `[SYSTEM: spawn_agent failed — agent "${resolvedAgentName}" not found. Use list_agents to see available agents.]`;
                        }
                        if (agentDef.system && agentDef.creatable === false) {
                            return `[SYSTEM: spawn_agent failed — agent "${resolvedAgentName}" is a worker-managed system agent and cannot be spawned from a session. ` +
                                `If it is missing, the workers likely need to be restarted.]`;
                        }
                        applyAgentDef(agentDef, resolvedAgentName !== args.agent_name);
                    }

                    if (agentModel && !agentModel.includes(":")) {
                        return `[SYSTEM: spawn_agent failed — model "${agentModel}" is not allowed. ` +
                            `When overriding a sub-agent model, first call list_available_models and then use the exact provider:model value from that list. ` +
                            `If you are unsure, omit model so the sub-agent inherits your current model.]`;
                    }

                    if (agentId) {
                        const existingChild = existingChildren.find(child => child.agentId === agentId && child.status === "running");
                        if (existingChild) {
                            return `[SYSTEM: Agent "${resolvedAgentName || agentId}" is already running as sub-agent ${existingChild.orchId.slice(0, 16)}. ` +
                                `Use check_agents to see its status, or message_agent to communicate with it.]`;
                        }
                    }

                    const {
                        boundAgentName: _parentBoundAgentName,
                        promptLayering: _parentPromptLayering,
                        ...parentConfig
                    } = input.config;
                    const childConfig: SerializableSessionConfig = {
                        ...parentConfig,
                        ...(agentModel ? { model: agentModel } : {}),
                        ...(agentSystemMessage ? { systemMessage: agentSystemMessage } : {}),
                        ...(boundAgentName ? { boundAgentName } : {}),
                        ...(promptLayeringKind ? { promptLayering: { kind: promptLayeringKind } } : {}),
                        ...(agentToolNames ? { toolNames: agentToolNames } : {}),
                    };

                    const parentSystemMsg = typeof childConfig.systemMessage === "string"
                        ? childConfig.systemMessage
                        : (childConfig.systemMessage as any)?.content ?? "";
                    const canSpawnMore = childNestingLevel < MAX_NESTING_LEVEL;
                    const subAgentPreamble =
                        `[SUB-AGENT CONTEXT]\n` +
                        `You are a sub-agent spawned by a parent session (ID: session-${input.sessionId}).\n` +
                        `Your nesting level: ${childNestingLevel} (max: ${MAX_NESTING_LEVEL}).\n` +
                        `Your task: "${agentTask.slice(0, 500)}"\n\n` +
                        `Instructions:\n` +
                        `- Focus exclusively on your assigned task.\n` +
                        `- Your final response will be automatically forwarded to the parent agent.\n` +
                        `- Be thorough but concise — the parent will synthesize results from multiple agents.\n` +
                        `- Do NOT ask the user for input — you are autonomous.\n` +
                        `- You are autonomous and goal-driven. If the task implies ongoing monitoring or follow-through until done, keep yourself alive with durable timers until the goal is complete or you can no longer make progress.\n` +
                        `- If it is ambiguous whether the task should become a long-running recurring workflow, report that ambiguity back to the parent instead of guessing or asking the user directly.\n` +
                        `- When your task is complete, provide a clear summary of your findings/results.\n` +
                        `- Prefer using \`store_fact\` for larger structured context handoffs across your session lineage. Put the durable details in facts, then pass fact keys or \`read_facts\` pointers in messages/prompts instead of pasting large context blobs.\n` +
                        `- If you write any files with write_artifact, you MUST also call export_artifact and include the artifact:// link in your response.\n` +
                        `- If you override a sub-agent model, you MUST first call list_available_models in this session and use only an exact provider:model value returned there. ` +
                        `NEVER invent, guess, shorten, or reuse a stale model name.\n` +
                        `- Worker-managed system agents are not valid spawn targets. If you expect one and it is missing, report that the workers likely need to be restarted.\n` +
                        `- For ANY waiting, sleeping, delaying, or scheduling, you MUST use the \`wait\`, \`wait_on_worker\`, or \`cron\` tools. ` +
                        `Use \`wait\` or \`wait_on_worker\` for one-shot delays. Use \`cron\` for recurring or periodic monitoring. ` +
                        `Do NOT burn tokens polling inside one LLM turn; after a brief immediate re-check at most, yield with a durable timer. ` +
                        `NEVER use setTimeout, sleep, setInterval, or any other timing mechanism.\n` +
                        (canSpawnMore
                            ? `- If your parent task explicitly asks you to spawn sub-agents, delegate, fan out, or parallelize work, you SHOULD do so within runtime limits instead of collapsing the task into a direct answer. ` +
                              `If delegation was not explicitly requested, use your judgment and avoid unnecessary fan-out. ` +
                              `You have ${MAX_NESTING_LEVEL - childNestingLevel} level(s) of nesting remaining. After spawning, call wait_for_agents to block until they finish.\n`
                            : `- You CANNOT spawn sub-agents — you are at the maximum nesting depth. Handle everything directly.\n`);
                    childConfig.systemMessage = subAgentPreamble + (parentSystemMsg ? "\n\n" + parentSystemMsg : "");

                    const sdkClient = await getInlineClient();
                    const normalizedModel = sessionManager.normalizeModelRef(childConfig.model);
                    if (normalizedModel) childConfig.model = normalizedModel;

                    const childSession = await sdkClient.createSession({
                        parentSessionId: input.sessionId,
                        nestingLevel: childNestingLevel,
                        model: childConfig.model,
                        systemMessage: childConfig.systemMessage,
                        boundAgentName: childConfig.boundAgentName,
                        promptLayering: childConfig.promptLayering,
                        toolNames: childConfig.toolNames,
                        waitThreshold: childConfig.waitThreshold,
                        agentId,
                    });

                    if (catalog) {
                        const meta: Record<string, any> = {};
                        if (agentTitle && !agentIsSystem) meta.title = `${agentTitle}: ${childSession.sessionId.slice(0, 8)}`;
                        else if (agentTitle) meta.title = agentTitle;
                        if (agentId) meta.agentId = agentId;
                        if (agentSplash) meta.splash = agentSplash;
                        if (Object.keys(meta).length > 0) {
                            await catalog.updateSession(childSession.sessionId, meta);
                        }
                    }

                    await childSession.send(agentTask, { bootstrap: true });

                    if (catalog) {
                        await catalog.recordEvents(input.sessionId, [{
                            eventType: "session.agent_spawned",
                            data: { childSessionId: childSession.sessionId, agentId: agentId || undefined, task: agentTask.slice(0, 500) },
                        }], workerNodeId);
                    }

                    const childOrchId = `session-${childSession.sessionId}`;
                    return `[SYSTEM: Sub-agent spawned successfully.\n` +
                        `  Agent ID: ${childOrchId}\n` +
                        `  ${resolvedAgentName ? `Agent: ${resolvedAgentName}\n  ` : ``}Task: "${agentTask.slice(0, 200)}"\n` +
                        `  The agent is now running autonomously. Continue your work in this SAME turn and keep following the user's remaining steps. ` +
                        `Do NOT stop just because the child started. If your plan says to pause, call wait or wait_for_agents explicitly. ` +
                        `You can also use check_agents to poll status, ` +
                        `or message_agent to send instructions.]`;
                } catch (err: any) {
                    return `[SYSTEM: spawn_agent failed: ${err?.message || String(err)}]`;
                }
            },
            messageAgent: async (args: { agent_id: string; message: string }) => {
                try {
                    const child = await resolveManagedChild(args.agent_id);
                    const sdkClient = await getInlineClient();
                    await sdkClient._getDuroxideClient().enqueueEvent(
                        child.orchId,
                        "messages",
                        JSON.stringify({ prompt: args.message }),
                    );
                    return `[SYSTEM: Message sent to sub-agent ${child.orchId}: "${args.message.slice(0, 200)}". ` +
                        `Continue your work in this SAME turn. If you are waiting on the child, call wait_for_agents explicitly rather than stopping here.]`;
                } catch (err: any) {
                    return `[SYSTEM: message_agent failed: ${err?.message || String(err)}]`;
                }
            },
            checkAgents: async () => {
                try {
                    const children = (await loadDirectChildSessions()).filter(child => !child.isSystem);
                    if (children.length === 0) {
                        return `[SYSTEM: No sub-agents have been spawned yet.]`;
                    }
                    const statusLines = children.map((agent) =>
                        `  - Agent ${agent.orchId}\n` +
                        `    Title: ${agent.title ?? "(untitled)"}\n` +
                        `    Status: ${agent.status}\n` +
                        `    Iterations: ${agent.iterations ?? 0}\n` +
                        `    Output: ${agent.result ?? agent.error ?? "(no output yet)"}`
                    );
                    return `[SYSTEM: Sub-agent status report (${children.length} agents):\n${statusLines.join("\n")}]`;
                } catch (err: any) {
                    return `[SYSTEM: check_agents failed: ${err?.message || String(err)}]`;
                }
            },
            resolveWaitForAgents: async (agentIds?: string[]) => {
                const children = (await loadDirectChildSessions()).filter(child => !child.isSystem);
                if (agentIds && agentIds.length > 0) {
                    return await Promise.all(agentIds.map(async (agentId) => (await resolveManagedChild(agentId)).orchId));
                }
                const running = children.filter(child => child.status === "running").map(child => child.orchId);
                return running.length > 0 ? running : children.map(child => child.orchId);
            },
            listSessions: async () => {
                try {
                    const sdkClient = await getInlineClient();
                    const sessions = await sdkClient.listSessions();
                    const lines = sessions.map((s: any) =>
                        `  - ${s.sessionId}${s.sessionId === input.sessionId ? " (this session)" : ""}\n` +
                        `    Title: ${s.title ?? "(untitled)"}\n` +
                        `    Status: ${s.status}, Iterations: ${s.iterations ?? 0}\n` +
                        `    Parent: ${s.parentSessionId ?? "none"}`
                    );
                    return `[SYSTEM: Active sessions (${sessions.length}):\n${lines.join("\n")}]`;
                } catch (err: any) {
                    return `[SYSTEM: list_sessions failed: ${err?.message || String(err)}]`;
                }
            },
            completeAgent: async (args: { agent_id: string }) => {
                try {
                    const child = await resolveManagedChild(args.agent_id);
                    const sdkClient = await getInlineClient();
                    const cmdId = `done-inline-${Date.now()}`;
                    await sdkClient._getDuroxideClient().enqueueEvent(
                        child.orchId,
                        "messages",
                        JSON.stringify({ type: "cmd", cmd: "done", id: cmdId, args: { reason: "Completed by parent" } }),
                    );
                    return `[SYSTEM: Sub-agent ${child.orchId} has been completed gracefully.]`;
                } catch (err: any) {
                    return `[SYSTEM: complete_agent failed: ${err?.message || String(err)}]`;
                }
            },
            cancelAgent: async (args: { agent_id: string; reason?: string }) => {
                try {
                    const child = await resolveManagedChild(args.agent_id);
                    const sdkClient = await getInlineClient();
                    await (sdkClient as any).duroxideClient.cancelInstance(
                        child.orchId,
                        args.reason ?? "Cancelled by parent",
                    );
                    if (catalog) {
                        await catalog.updateSession(child.sessionId, {
                            state: "completed",
                            lastError: args.reason ? `Cancelled: ${args.reason}` : "Cancelled",
                        }).catch(() => {});
                    }
                    return `[SYSTEM: Sub-agent ${child.orchId} has been cancelled.${args.reason ? ` Reason: ${args.reason}` : ""}]`;
                } catch (err: any) {
                    return `[SYSTEM: cancel_agent failed: ${err?.message || String(err)}]`;
                }
            },
            deleteAgent: async (args: { agent_id: string; reason?: string }) => {
                try {
                    const child = await resolveManagedChild(args.agent_id);
                    const sdkClient = await getInlineClient();
                    await sdkClient.deleteSession(child.sessionId);
                    return `[SYSTEM: Sub-agent ${child.orchId} has been deleted.${args.reason ? ` Reason: ${args.reason}` : ""}]`;
                } catch (err: any) {
                    return `[SYSTEM: delete_agent failed: ${err?.message || String(err)}]`;
                }
            },
        } as const;

        // Cooperative cancellation: poll for lock steal
        let cancelled = false;
        const cancelPoll = setInterval(() => {
            if (activityCtx.isCancelled()) {
                cancelled = true;
                session?.abort?.();
                clearInterval(cancelPoll);
            }
        }, 2_000);

        try {
            // Build onEvent callback: write each non-ephemeral event to CMS as it fires
            const EPHEMERAL_TYPES = new Set([
                "assistant.message_delta",
                "assistant.reasoning_delta",
                "user.message", // Already recorded explicitly above — skip the SDK's duplicate
            ]);
            const onEvent = catalog
                ? (event: { eventType: string; data: unknown }) => {
                    if (EPHEMERAL_TYPES.has(event.eventType)) return;
                    if (event.eventType === "session.wait_started") {
                        const data = (event.data ?? {}) as { reason?: string };
                        catalog.updateSession(input.sessionId, {
                            state: "waiting",
                            waitReason: data.reason ?? null,
                            lastActiveAt: new Date(),
                        }).catch((err: any) => {
                            activityCtx.traceInfo(`[runTurn] CMS wait_started status update failed: ${err}`);
                        });
                    } else if (event.eventType === "session.input_required_started") {
                        const data = (event.data ?? {}) as { question?: string };
                        catalog.updateSession(input.sessionId, {
                            state: "input_required",
                            waitReason: data.question ?? null,
                            lastActiveAt: new Date(),
                        }).catch((err: any) => {
                            activityCtx.traceInfo(`[runTurn] CMS input_required_started status update failed: ${err}`);
                        });
                    }
                    catalog.recordEvents(input.sessionId, [event], workerNodeId).catch((err: any) => {
                        activityCtx.traceInfo(`[runTurn] CMS recordEvent failed: ${err}`);
                    });
                }
                : undefined;

            // Record the user prompt as a CMS event before running the turn.
            // Skip internal timer continuation prompts — they're system-generated, not user input.
            const isTimerPrompt = /^The \d+ second wait is now complete\./i.test(input.prompt);
            const isRetryAttempt = (input.retryCount ?? 0) > 0;
            if (catalog && input.config.turnSystemPrompt && !isRetryAttempt) {
                catalog.recordEvents(input.sessionId, [{
                    eventType: "system.message",
                    data: { content: input.config.turnSystemPrompt },
                }], workerNodeId).catch((err: any) => {
                    activityCtx.traceInfo(`[runTurn] CMS recordEvent (system) failed: ${err}`);
                });
            }
            if (catalog && !isTimerPrompt && !input.bootstrap && !isRetryAttempt) {
                const promptEventType = isInternalSystemPrompt(input.prompt) ? "system.message" : "user.message";
                catalog.recordEvents(input.sessionId, [{
                    eventType: promptEventType,
                    data: { content: input.prompt },
                }], workerNodeId).catch((err: any) => {
                    activityCtx.traceInfo(`[runTurn] CMS recordEvent (${promptEventType}) failed: ${err}`);
                });
            }

            // Mark session as "running" in CMS before the turn
            if (catalog) {
                await catalog.updateSession(input.sessionId, {
                    state: "running",
                    lastActiveAt: new Date(),
                }).catch((err: any) => {
                    activityCtx.traceInfo(`[runTurn] CMS pre-turn status update failed: ${err}`);
                });
            }

            activityCtx.traceInfo(`[runTurn] invoking ManagedSession.runTurn for ${input.sessionId}`);

            // Record turn_started CMS event
            if (catalog) {
                catalog.recordEvents(input.sessionId, [{
                    eventType: "session.turn_started",
                    data: { iteration: input.turnIndex ?? 0 },
                }], workerNodeId).catch((err: any) => {
                    activityCtx.traceInfo(`[runTurn] CMS turn_started event failed: ${err}`);
                });
            }

            const runTurnWithPrompt = async (targetSession: any, prompt: string) => {
                return await targetSession.runTurn(prompt, {
                    onEvent,
                    modelSummary: sessionManager.getModelSummary(),
                    bootstrap: input.bootstrap,
                    requiredTool: input.requiredTool,
                    controlToolBridge,
                });
            };

            let result = await runTurnWithPrompt(session, input.prompt);

            if (result.type === "error" && isLiveSessionLostErrorMessage((result as any).message)) {
                activityCtx.traceInfo(
                    `[runTurn] live Copilot session lost for ${input.sessionId}; invalidating warm session and attempting recovery`,
                );

                await sessionManager.invalidateWarmSession(input.sessionId).catch((err: any) => {
                    activityCtx.traceInfo(`[runTurn] warm-session invalidation failed (non-fatal): ${err?.message ?? err}`);
                });

                if (catalog) {
                    await catalog.recordEvents(input.sessionId, [{
                        eventType: "system.message",
                        data: {
                            content:
                                "The runtime recovered this session after the worker lost the live Copilot session. " +
                                "Some very recent in-memory state may have been lost.",
                        },
                    }], workerNodeId).catch((err: any) => {
                        activityCtx.traceInfo(`[runTurn] CMS recovery notice failed: ${err}`);
                    });
                }

                try {
                    session = await sessionManager.getOrCreate(input.sessionId, runConfig, {
                        turnIndex: input.turnIndex,
                    });
                } catch (err: any) {
                    const recoveryMessage = err?.message || String(err);
                    const fatalMessage = recoveryMessage.includes(SESSION_STATE_MISSING_PREFIX)
                        ? buildUnrecoverableSessionLossMessage(
                            input.sessionId,
                            recoveryMessage.slice(SESSION_STATE_MISSING_PREFIX.length).trim(),
                        )
                        : buildUnrecoverableSessionLossMessage(input.sessionId, recoveryMessage);
                    activityCtx.traceInfo(`[runTurn] unrecoverable session loss for ${input.sessionId}: ${fatalMessage}`);
                    return await failForMissingState(fatalMessage);
                }

                const recoveredPrompt = mergePromptSections([SESSION_RECOVERY_NOTICE, input.prompt]) || input.prompt;
                result = await runTurnWithPrompt(session, recoveredPrompt);

                if (result.type === "error" && isLiveSessionLostErrorMessage((result as any).message)) {
                    const fatalMessage = buildUnrecoverableSessionLossMessage(input.sessionId, (result as any).message);
                    activityCtx.traceInfo(`[runTurn] recovery re-run still reported lost session for ${input.sessionId}: ${fatalMessage}`);
                    return await failForMissingState(fatalMessage);
                }
            }

            if (
                input.parentSessionId
                && result.type === "completed"
                && typeof result.content === "string"
                && /^QUESTION FOR PARENT:/i.test(result.content.trim())
            ) {
                result = {
                    ...result,
                    type: "wait",
                    seconds: 60,
                    reason: "waiting for parent answer",
                    content: result.content.trim(),
                } as TurnResult;
            }
            activityCtx.traceInfo(`[runTurn] ManagedSession.runTurn completed for ${input.sessionId} type=${result.type}`);

            // Record turn_completed CMS event
            if (catalog) {
                catalog.recordEvents(input.sessionId, [{
                    eventType: "session.turn_completed",
                    data: { iteration: input.turnIndex ?? 0 },
                }], workerNodeId).catch((err: any) => {
                    activityCtx.traceInfo(`[runTurn] CMS turn_completed event failed: ${err}`);
                });
            }

            if (cancelled) return { type: "cancelled" };

            // ── Activity-level writeback: sync turn result → CMS ──
            // This lets listSessions() read entirely from CMS without
            // hitting duroxide for every session's customStatus.
            if (catalog) {
                const statusMap: Record<string, string> = {
                    completed: "idle", // orchestration decides idle vs completed; default to idle
                    wait: "waiting",
                    cron: "running",
                    input_required: "input_required",
                    error: "error",
                    cancelled: "idle",
                    spawn_agent: "running",
                    message_agent: "running",
                    check_agents: "running",
                    wait_for_agents: "waiting",
                    list_sessions: "running",
                    complete_agent: "running",
                    cancel_agent: "running",
                    delete_agent: "running",
                };
                const liveStatus = statusMap[result.type] ?? "idle";
                const updates: import("./cms.js").SessionRowUpdates = {
                    state: liveStatus,
                    lastActiveAt: new Date(),
                };
                if (result.type === "error") {
                    updates.lastError = (result as any).message ?? null;
                    updates.waitReason = null;
                } else if (result.type === "wait") {
                    updates.waitReason = (result as any).reason ?? null;
                    updates.lastError = null;
                } else if (result.type === "input_required") {
                    updates.waitReason = (result as any).question ?? null;
                    updates.lastError = null;
                } else {
                    updates.waitReason = null;
                    updates.lastError = null;
                }
                await catalog.updateSession(input.sessionId, updates).catch((err: any) => {
                    activityCtx.traceInfo(`[runTurn] CMS post-turn status writeback failed: ${err}`);
                });
            }

            return result;
        } finally {
            clearInterval(cancelPoll);
            const clientToStop: PilotSwarmClient | null = inlineSdkClient;
            if (clientToStop) {
                try { await (clientToStop as any).stop(); } catch {}
            }
        }
    });

    // ── dehydrateSession ────────────────────────────────────
    runtime.registerActivity("dehydrateSession", async (
        _ctx: any,
        input: { sessionId: string; reason?: string; eventData?: Record<string, unknown> },
    ): Promise<void> => {
        await sessionManager.dehydrate(input.sessionId, input.reason ?? "unknown");
        if (catalog) {
            const eventData = input.eventData && typeof input.eventData === "object"
                ? input.eventData
                : null;
            catalog.recordEvents(input.sessionId, [{
                eventType: "session.dehydrated",
                data: {
                    reason: input.reason ?? "unknown",
                    ...(eventData ?? {}),
                },
            }], workerNodeId).catch(() => {});
        }
    });

    runtime.registerActivity("needsHydrationSession", async (
        _activityCtx: any,
        input: { sessionId: string },
    ): Promise<boolean> => {
        return sessionManager.needsHydration(input.sessionId);
    });

    // ── hydrateSession ──────────────────────────────────────
    runtime.registerActivity("hydrateSession", async (
        _ctx: any,
        input: { sessionId: string },
    ): Promise<void> => {
        await sessionManager.hydrate(input.sessionId);
        if (catalog) {
            catalog.recordEvents(input.sessionId, [{
                eventType: "session.hydrated",
                data: {},
            }], workerNodeId).catch(() => {});
        }
    });

    // ── destroySession ──────────────────────────────────────
    runtime.registerActivity("destroySession", async (
        _ctx: any,
        input: { sessionId: string },
    ): Promise<void> => {
        await sessionManager.destroySession(input.sessionId);
    });

    // ── checkpointSession ───────────────────────────────────
    runtime.registerActivity("checkpointSession", async (
        _ctx: any,
        input: { sessionId: string },
    ): Promise<void> => {
        await sessionManager.checkpoint(input.sessionId);
    });

    // ── listModels ──────────────────────────────────────────
    // Always register — the model registry is the authoritative source.
    // Falls back to SDK listModels if a GitHub token is available.
    runtime.registerActivity("listModels", async (
        activityCtx: any,
        _input: Record<string, unknown>,
    ): Promise<string> => {
        activityCtx.traceInfo("[listModels] fetching");
        if (githubToken) {
            const { CopilotClient } = await import("@github/copilot-sdk");
            const sdk = new CopilotClient({ githubToken });
            try {
                await sdk.start();
                const models = await sdk.listModels();
                return JSON.stringify(models.map((m: any) => ({ id: m.id })));
            } finally {
                try { await sdk.stop(); } catch {}
            }
        }
        // No GitHub token — return empty (registry models are injected by the tool handler)
        return JSON.stringify([]);
    });

    // ── summarizeSession ────────────────────────────────────
    // Fetches recent conversation from CMS, asks a lightweight LLM
    // for a 3-5 word title, and writes it back to CMS.
    if (catalog) {
        runtime.registerActivity("summarizeSession", async (
            activityCtx: any,
            input: { sessionId: string },
        ): Promise<string> => {
            activityCtx.traceInfo(`[summarizeSession] session=${input.sessionId}`);

            // Never overwrite system session titles (e.g. "Sweeper Agent")
            const session = await catalog.getSession(input.sessionId);
            if (session?.isSystem) {
                activityCtx.traceInfo(`[summarizeSession] skipping system session`);
                return session.title || "";
            }
            if (session?.titleLocked) {
                activityCtx.traceInfo(`[summarizeSession] skipping locked title`);
                return session.title || "";
            }

            // Named agent sessions have a title prefix (e.g. "Alpha Agent: <shortId>").
            // Detect this so we can preserve the prefix after summarization.
            const agentTitlePrefix = session?.agentId && session?.title?.includes(": ")
                ? session.title.split(": ")[0]
                : null;

            const events = await catalog.getSessionEvents(input.sessionId, undefined, 50);
            if (!events || events.length === 0) return "";

            // Build a condensed conversation transcript
            const lines: string[] = [];
            for (const evt of events) {
                if (evt.eventType === "user.message") {
                    const content = (evt.data as any)?.content;
                    if (content) lines.push(`User: ${content.slice(0, 200)}`);
                } else if (evt.eventType === "assistant.message") {
                    const content = (evt.data as any)?.content;
                    if (content) lines.push(`Assistant: ${content.slice(0, 200)}`);
                }
            }
            if (lines.length === 0) return "";

            const transcript = lines.join("\n");
            const summaryPrompt =
                "Summarize the following conversation in exactly 3-5 words. " +
                "Return ONLY the summary, nothing else. No quotes, no punctuation at the end.\n\n" +
                transcript;

            // Use a one-shot CopilotSession to generate the title.
            // Prefer the default provider from the registry (works without GitHub token).
            const { CopilotClient: SdkClient } = await import("@github/copilot-sdk");
            const sdk = new SdkClient({ ...(githubToken ? { githubToken } : {}) });
            try {
                await sdk.start();
                // Resolve the default model + provider from the registry
                const defaultProvider = sessionManager.resolveDefaultProvider();
                const sessionOpts: any = {
                    onPermissionRequest: async () => ({ kind: "approved" as const }),
                };
                if (defaultProvider) {
                    sessionOpts.model = defaultProvider.modelName;
                    sessionOpts.provider = defaultProvider.sdkProvider;
                } else if (githubToken) {
                    sessionOpts.model = "gpt-4o-mini";
                } else {
                    activityCtx.traceInfo("[summarizeSession] no provider and no GitHub token — skipping");
                    await sdk.stop();
                    return "";
                }
                const tempSession = await sdk.createSession(sessionOpts);
                let title = "";
                await new Promise<void>((resolve, reject) => {
                    tempSession.on("assistant.message", (event: any) => {
                        title = (event.data?.content || "").trim();
                    });
                    tempSession.on("session.idle", () => resolve());
                    tempSession.on("session.error", (event: any) => reject(new Error(event.data?.message || "session error")));
                    tempSession.send({ prompt: summaryPrompt });
                });
                await sdk.stop();

                // Truncate to 60 chars max
                title = title.slice(0, 60);
                if (title) {
                    // Preserve named agent prefix: "Alpha Agent: <summary>"
                    const finalTitle = agentTitlePrefix ? `${agentTitlePrefix}: ${title}` : title;
                    await catalog.updateSession(input.sessionId, { title: finalTitle });
                    activityCtx.traceInfo(`[summarizeSession] title="${finalTitle}"`);
                }
                return title;
            } catch (err: any) {
                activityCtx.traceInfo(`[summarizeSession] failed: ${err.message}`);
                try { await sdk.stop(); } catch {}
                return "";
            }
        });
    }

    // ── resolveAgentConfig ────────────────────────────────────
    // Resolves a loaded agent definition by name. User-creatable agents return
    // creatable=true. Worker-managed system agents return creatable=false so
    // callers can surface a clear error instead of spawning them.
    runtime.registerActivity("resolveAgentConfig", async (
        _activityCtx: any,
        input: { agentName: string },
    ): Promise<{ name: string; prompt: string; tools?: string[]; initialPrompt?: string; title?: string; system?: boolean; id?: string; parent?: string; splash?: string; namespace?: string; promptLayerKind?: "app-agent" | "app-system-agent" | "pilotswarm-system-agent"; creatable?: boolean } | null> => {
        const agents: Array<any> = [
            ...(userAgents ?? []).map(a => ({ ...a, system: false, creatable: true })),
            ...(systemAgents ?? []).map(a => ({ ...a, creatable: false })),
        ];
        const normalize = (value?: string) => (value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
        // Support qualified names: "smelter:supervisor" → namespace="smelter", name="supervisor"
        let lookupNamespace: string | undefined;
        let rawName = input.agentName;
        if (input.agentName.includes(":")) {
            const parts = input.agentName.split(":");
            lookupNamespace = parts[0];
            rawName = parts.slice(1).join(":");
        }
        const lookup = normalize(rawName);
        // Also try without trailing "agent" suffix for fuzzy matching
        // (LLM often says "Sweeper agent" which normalizes to "sweeperagent", but id is "sweeper")
        const lookupBase = lookup.replace(/agent$/, "");
        const agent = agents.find(a => {
            // If namespace qualifier provided, check it matches
            if (lookupNamespace && normalize(a.namespace) !== normalize(lookupNamespace)) return false;
            const candidates = [a.name, a.id, a.title].map(normalize).filter(Boolean);
            return candidates.includes(lookup) || (lookupBase && candidates.includes(lookupBase));
        });
        if (!agent) return null;
        return {
            name: agent.name,
            prompt: agent.prompt,
            tools: agent.tools ?? undefined,
            initialPrompt: agent.initialPrompt ?? undefined,
            title: agent.title ?? undefined,
            system: agent.system ?? undefined,
            id: agent.id ?? undefined,
            parent: agent.parent ?? undefined,
            splash: agent.splash ?? undefined,
            namespace: agent.namespace ?? undefined,
            promptLayerKind: agent.promptLayerKind ?? undefined,
            creatable: agent.creatable ?? !agent.system,
        };
    });

    // ── spawnChildSession ─────────────────────────────────────
    // Creates a child session via the PilotSwarmClient SDK.
    // System child agents with a stable agentId use a deterministic UUID.
    // Other child sessions use a random UUID.
    // Goes through the full SDK path: CMS registration + orchestration startup.
    runtime.registerActivity("spawnChildSession", async (
        activityCtx: any,
        input: { parentSessionId: string; config: SerializableSessionConfig; task: string; nestingLevel?: number; isSystem?: boolean; title?: string; agentId?: string; splash?: string },
    ): Promise<string> => {
        const startedAt = Date.now();
        const trace = (message: string) => {
            activityCtx.traceInfo(`[spawnChildSession] +${Date.now() - startedAt}ms ${message}`);
        };
        const isDeterministicSystemChild = Boolean(input.isSystem && input.agentId);
        const childSessionId = isDeterministicSystemChild
            ? systemChildAgentUUID(input.parentSessionId, input.agentId!)
            : crypto.randomUUID();
        trace(`child=${childSessionId} parent=${input.parentSessionId} nesting=${input.nestingLevel ?? 0} isSystem=${input.isSystem ?? false} agent=${input.agentId ?? "custom"}`);
        if (!storeUrl) throw new Error("No storeUrl — cannot create PilotSwarmClient");

        const sdkClient = new PilotSwarmClient({
            store: storeUrl,
            cmsSchema,
            ...(clientConfig?.duroxideSchema != null && { duroxideSchema: clientConfig.duroxideSchema }),
            ...(clientConfig?.factsSchema != null && { factsSchema: clientConfig.factsSchema }),
            traceWriter: (message: string) => trace(message),
        });
        try {
            const clientStartAt = Date.now();
            await sdkClient.start();
            trace(`sdkClient.start done (${Date.now() - clientStartAt}ms)`);

            if (isDeterministicSystemChild && catalog) {
                const existingCheckAt = Date.now();
                const existing = await catalog.getSession(childSessionId);
                trace(`catalog.getSession existing check done (${Date.now() - existingCheckAt}ms)`);
                if (existing && !["completed", "failed", "terminated"].includes(existing.state)) {
                    trace(`reusing existing live system child: ${childSessionId}`);
                    return childSessionId;
                }
            }

            // Mark as system session BEFORE createSession so OrchestrationInput gets isSystem=true
            if (input.isSystem) {
                sdkClient.systemSessions.add(childSessionId);
            }

            // Child sessions may inherit a parent model that was created with a
            // bare alias such as "gpt-4.1". Normalize it here, but do not
            // require that the stored value is already provider-qualified.
            const normalizedModel = sessionManager.normalizeModelRef(input.config.model);
            if (normalizedModel) {
                input.config.model = normalizedModel;
            }
            trace(`model normalization done (${input.config.model ?? "inherit"})`);

            // Create the child session via the SDK — handles CMS row + orchestration start
            const createSessionAt = Date.now();
            const session = await sdkClient.createSession({
                sessionId: childSessionId,
                parentSessionId: input.parentSessionId,
                nestingLevel: input.nestingLevel,
                model: input.config.model,
                systemMessage: input.config.systemMessage,
                boundAgentName: input.config.boundAgentName,
                promptLayering: input.config.promptLayering,
                toolNames: input.config.toolNames,
                waitThreshold: input.config.waitThreshold,
                agentId: input.agentId,
            });
            trace(`sdkClient.createSession done (${Date.now() - createSessionAt}ms)`);

            // One-time metadata write: isSystem, title, agentId, splash
            const meta: Record<string, any> = {};
            if (input.isSystem) meta.isSystem = true;
            // Named agents get a prefixed title: "Agent Title: <shortId>"
            // System agents keep their fixed title as-is.
            if (input.title && !input.isSystem) {
                meta.title = `${input.title}: ${childSessionId.slice(0, 8)}`;
            } else if (input.title) {
                meta.title = input.title;
            }
            if (input.agentId) meta.agentId = input.agentId;
            if (input.splash) meta.splash = input.splash;
            if (Object.keys(meta).length > 0 && catalog) {
                const metaAt = Date.now();
                await catalog.updateSession(childSessionId, meta);
                trace(`catalog.updateSession meta done (${Date.now() - metaAt}ms)`);
            }

            // Fire the initial task prompt (non-blocking: just enqueues).
            // This prompt is orchestration-generated bootstrap state for the child
            // session, not an actual user-authored message inside that child chat.
            const sendAt = Date.now();
            await session.send(input.task, { bootstrap: true });
            trace(`session.send bootstrap done (${Date.now() - sendAt}ms)`);

            trace(`session created and task sent: ${childSessionId}`);
            return childSessionId;
        } finally {
            const clientStopAt = Date.now();
            await sdkClient.stop();
            trace(`sdkClient.stop done (${Date.now() - clientStopAt}ms total=${Date.now() - startedAt}ms)`);
        }
    });

    // ── sendToSession ───────────────────────────────────────
    // Sends a message to any session's orchestration event queue directly.
    // Does NOT call session.send() (which tries to start/resume the orchestration).
    // Instead, enqueues directly to the existing orchestration's "messages" queue.
    runtime.registerActivity("sendToSession", async (
        activityCtx: any,
        input: { sessionId: string; message: string },
    ): Promise<void> => {
        activityCtx.traceInfo(`[sendToSession] session=${input.sessionId} msg="${input.message.slice(0, 60)}"`);
        if (!storeUrl) throw new Error("No storeUrl — cannot create PilotSwarmClient");

        const sdkClient = new PilotSwarmClient({
            store: storeUrl,
            cmsSchema,
            ...(clientConfig?.duroxideSchema != null && { duroxideSchema: clientConfig.duroxideSchema }),
            ...(clientConfig?.factsSchema != null && { factsSchema: clientConfig.factsSchema }),
        });
        try {
            await sdkClient.start();
            const info = await (sdkClient as any)._getSessionInfo(input.sessionId);
            if (info?.status === "failed") {
                throw new Error(
                    `Session ${input.sessionId.slice(0, 8)} is a failed terminal orchestration and cannot accept new messages.`,
                );
            }
            if (
                info?.status === "completed"
                && info?.parentSessionId
                && !info?.isSystem
                && !info?.cronActive
                && !info?.cronInterval
            ) {
                throw new Error(
                    `Session ${input.sessionId.slice(0, 8)} is a completed terminal orchestration and cannot accept new messages.`,
                );
            }
            // Enqueue directly to the orchestration's event queue
            const orchestrationId = `session-${input.sessionId}`;
            await (sdkClient as any).duroxideClient.enqueueEvent(
                orchestrationId,
                "messages",
                JSON.stringify({ prompt: input.message }),
            );
            activityCtx.traceInfo(`[sendToSession] enqueued to ${orchestrationId}`);
        } finally {
            await sdkClient.stop();
        }
    });

    // ── sendCommandToSession ────────────────────────────────
    // Sends a raw JSON command directly to a session's orchestration event queue.
    // Unlike sendToSession, this does NOT wrap the payload in { prompt: ... }.
    runtime.registerActivity("sendCommandToSession", async (
        activityCtx: any,
        input: { sessionId: string; command: any },
    ): Promise<void> => {
        activityCtx.traceInfo(`[sendCommandToSession] session=${input.sessionId} cmd=${input.command?.cmd}`);
        if (!storeUrl) throw new Error("No storeUrl — cannot create PilotSwarmClient");

        const sdkClient = new PilotSwarmClient({
            store: storeUrl,
            cmsSchema,
            ...(clientConfig?.duroxideSchema != null && { duroxideSchema: clientConfig.duroxideSchema }),
            ...(clientConfig?.factsSchema != null && { factsSchema: clientConfig.factsSchema }),
        });
        try {
            await sdkClient.start();
            const orchestrationId = `session-${input.sessionId}`;
            await (sdkClient as any).duroxideClient.enqueueEvent(
                orchestrationId,
                "messages",
                JSON.stringify(input.command),
            );
            activityCtx.traceInfo(`[sendCommandToSession] enqueued to ${orchestrationId}`);
        } finally {
            await sdkClient.stop();
        }
    });

    // ── getSessionStatus ────────────────────────────────────
    // Gets the status of a session via the PilotSwarmClient SDK.
    runtime.registerActivity("getSessionStatus", async (
        activityCtx: any,
        input: { sessionId: string },
    ): Promise<string> => {
        activityCtx.traceInfo(`[getSessionStatus] session=${input.sessionId}`);
        if (!storeUrl) throw new Error("No storeUrl — cannot create PilotSwarmClient");

        const sdkClient = new PilotSwarmClient({
            store: storeUrl,
            cmsSchema,
            ...(clientConfig?.duroxideSchema != null && { duroxideSchema: clientConfig.duroxideSchema }),
            ...(clientConfig?.factsSchema != null && { factsSchema: clientConfig.factsSchema }),
        });
        try {
            await sdkClient.start();
            const info = await sdkClient._getSessionInfo(input.sessionId);
            return JSON.stringify({
                sessionId: info.sessionId,
                status: info.status,
                title: info.title,
                iterations: info.iterations,
                result: info.result,
                error: info.error,
            });
        } finally {
            await sdkClient.stop();
        }
    });

    // ── listSessions ────────────────────────────────────────
    // Lists all sessions via the PilotSwarmClient SDK.
    runtime.registerActivity("listSessions", async (
        activityCtx: any,
        _input: {},
    ): Promise<string> => {
        activityCtx.traceInfo(`[listSessions]`);
        if (!storeUrl) throw new Error("No storeUrl — cannot create PilotSwarmClient");

        const sdkClient = new PilotSwarmClient({
            store: storeUrl,
            cmsSchema,
            ...(clientConfig?.duroxideSchema != null && { duroxideSchema: clientConfig.duroxideSchema }),
            ...(clientConfig?.factsSchema != null && { factsSchema: clientConfig.factsSchema }),
        });
        try {
            await sdkClient.start();
            const sessions = await sdkClient.listSessions();
            return JSON.stringify(sessions.map(s => ({
                sessionId: s.sessionId,
                title: s.title,
                status: s.status,
                iterations: s.iterations,
                parentSessionId: s.parentSessionId,
                error: s.error,
            })));
        } finally {
            await sdkClient.stop();
        }
    });

    // ── listChildSessions ───────────────────────────────────
    // Lists direct child sessions of a parent with merged live status.
    runtime.registerActivity("listChildSessions", async (
        activityCtx: any,
        input: { parentSessionId: string },
    ): Promise<string> => {
        activityCtx.traceInfo(`[listChildSessions] parent=${input.parentSessionId}`);
        if (!storeUrl) throw new Error("No storeUrl — cannot create PilotSwarmClient");

        const sdkClient = new PilotSwarmClient({
            store: storeUrl,
            cmsSchema,
            ...(clientConfig?.duroxideSchema != null && { duroxideSchema: clientConfig.duroxideSchema }),
            ...(clientConfig?.factsSchema != null && { factsSchema: clientConfig.factsSchema }),
        });
        try {
            await sdkClient.start();
            const sessions = await sdkClient.listSessions();
            const directChildren = sessions.filter(s => s.parentSessionId === input.parentSessionId);
            const enriched = await Promise.all(directChildren.map(async (child) => {
                const info = await sdkClient._getSessionInfo(child.sessionId);
                return {
                    orchId: `session-${child.sessionId}`,
                    sessionId: child.sessionId,
                    title: info.title ?? child.title,
                    status: info.status,
                    iterations: info.iterations ?? child.iterations ?? 0,
                    parentSessionId: child.parentSessionId,
                    isSystem: child.isSystem ?? info.isSystem ?? false,
                    agentId: child.agentId ?? info.agentId,
                    result: info.result,
                    error: info.error,
                };
            }));
            return JSON.stringify(enriched);
        } finally {
            await sdkClient.stop();
        }
    });

    // ── notifyParent ────────────────────────────────────────
    // Sends a child_updates event to the parent orchestration so it can
    // wake up from durable sleep and process the child's result.
    // Uses raw enqueueEvent because it targets the "child_updates" queue,
    // not the standard "messages" queue that session.send() uses.
    runtime.registerActivity("notifyParent", async (
        activityCtx: any,
        input: { parentOrchId: string; childOrchId: string; childSessionId: string; update: any },
    ): Promise<void> => {
        activityCtx.traceInfo(`[notifyParent] parent=${input.parentOrchId} child=${input.childOrchId} type=${input.update?.type}`);
        if (!provider) throw new Error("No provider available");
        const { Client } = (await import("node:module")).createRequire(import.meta.url)("duroxide");
        const client = new Client(provider);
        await client.enqueueEvent(
            input.parentOrchId,
            "child_updates",
            JSON.stringify({
                childOrchId: input.childOrchId,
                childSessionId: input.childSessionId,
                ...input.update,
            }),
        );
    });

    // ── getDescendantSessionIds ──────────────────────────────
    // Returns all descendant session IDs (children, grandchildren, etc.)
    // Used by cancel/delete to cascade to grandchildren.
    runtime.registerActivity("getDescendantSessionIds", async (
        activityCtx: any,
        input: { sessionId: string },
    ): Promise<string[]> => {
        activityCtx.traceInfo(`[getDescendantSessionIds] session=${input.sessionId}`);
        if (!catalog) return [];
        const descendants = await catalog.getDescendantSessionIds(input.sessionId);
        activityCtx.traceInfo(`[getDescendantSessionIds] found ${descendants.length} descendants`);
        return descendants;
    });

    // ── cancelSession ───────────────────────────────────────
    // Cancels a session's orchestration (terminates immediately).
    runtime.registerActivity("cancelSession", async (
        activityCtx: any,
        input: { sessionId: string; reason?: string },
    ): Promise<void> => {
        activityCtx.traceInfo(`[cancelSession] session=${input.sessionId} reason=${input.reason ?? "none"}`);
        if (!storeUrl) throw new Error("No storeUrl — cannot create PilotSwarmClient");

        const sdkClient = new PilotSwarmClient({
            store: storeUrl,
            cmsSchema,
            ...(clientConfig?.duroxideSchema != null && { duroxideSchema: clientConfig.duroxideSchema }),
            ...(clientConfig?.factsSchema != null && { factsSchema: clientConfig.factsSchema }),
        });
        try {
            await sdkClient.start();
            const orchestrationId = `session-${input.sessionId}`;
            // Cancel the orchestration via duroxide
            await (sdkClient as any).duroxideClient.cancelInstance(
                orchestrationId,
                input.reason ?? "Cancelled by parent",
            );
            // Update CMS status
            if (catalog) {
                await catalog.updateSession(input.sessionId, {
                    state: "cancelled",
                    lastError: input.reason ? `Cancelled: ${input.reason}` : "Cancelled",
                    waitReason: null,
                });
            }
            activityCtx.traceInfo(`[cancelSession] cancelled ${orchestrationId}`);
        } finally {
            await sdkClient.stop();
        }
    });

    // ── deleteSession ───────────────────────────────────────
    // Cancels a session's orchestration AND removes it from CMS.
    runtime.registerActivity("deleteSession", async (
        activityCtx: any,
        input: { sessionId: string; reason?: string },
    ): Promise<void> => {
        activityCtx.traceInfo(`[deleteSession] session=${input.sessionId} reason=${input.reason ?? "none"}`);
        if (!storeUrl) throw new Error("No storeUrl — cannot create PilotSwarmClient");

        const sdkClient = new PilotSwarmClient({
            store: storeUrl,
            cmsSchema,
            ...(clientConfig?.duroxideSchema != null && { duroxideSchema: clientConfig.duroxideSchema }),
            ...(clientConfig?.factsSchema != null && { factsSchema: clientConfig.factsSchema }),
        });
        try {
            await sdkClient.start();
            // This does both: CMS soft-delete + duroxide cancel
            await sdkClient.deleteSession(input.sessionId);
            activityCtx.traceInfo(`[deleteSession] deleted session-${input.sessionId}`);
        } finally {
            await sdkClient.stop();
        }
    });

    // ── updateCmsState ─────────────────────────────────────
    // Updates a session's state in CMS (e.g. "rejected" for policy violations).
    if (catalog) {
        runtime.registerActivity("updateCmsState", async (
            activityCtx: any,
            input: { sessionId: string; state: string; lastError?: string },
        ): Promise<void> => {
            activityCtx.traceInfo(`[updateCmsState] session=${input.sessionId} state=${input.state}`);
            await catalog.updateSession(input.sessionId, {
                state: input.state,
                ...(input.lastError ? { lastError: input.lastError } : {}),
            });
        });
    }

    // ── getWorkerSessionPolicy ──────────────────────────────
    // Returns the worker's session policy and allowed agent names.
    // This is the authoritative source — even if a rogue client omits policy
    // from the OrchestrationInput, the orchestration can fetch it from the worker.
    runtime.registerActivity("getWorkerSessionPolicy", async (
        _activityCtx: any,
        _input: {},
    ): Promise<{ policy: import("./types.js").SessionPolicy | null; allowedAgentNames: string[] }> => {
        return {
            policy: workerSessionPolicy ?? null,
            allowedAgentNames: workerAllowedAgentNames ?? [],
        };
    });

    // ── loadKnowledgeIndex ──────────────────────────────────
    // Reads curated skills and open asks from the facts table for
    // injection into agent context before each turn.
    if (factStore) {
        runtime.registerActivity("loadKnowledgeIndex", async (
            activityCtx: any,
            input: { cap?: number },
        ): Promise<{ skills: Array<{ key: string; name: string; description: string }>; asks: Array<{ key: string; summary: string }> }> => {
            activityCtx.traceInfo("[loadKnowledgeIndex] loading curated skills and open asks");
            const cap = input.cap ?? 50;
            const { skills, asks } = await loadKnowledgeIndexFromFactStore(factStore, cap);

            activityCtx.traceInfo(`[loadKnowledgeIndex] ${skills.length} skills, ${asks.length} asks`);
            return { skills, asks };
        });
    }

    // ── recordSessionEvent ──────────────────────────────────
    // Lightweight CMS event recording for orchestration-level lifecycle events
    // (waits, spawns, cron, commands) that don't happen inside an existing activity.
    runtime.registerActivity("recordSessionEvent", async (
        _activityCtx: any,
        input: { sessionId: string; events: { eventType: string; data: unknown }[] },
    ): Promise<void> => {
        if (!catalog) return;
        await catalog.recordEvents(input.sessionId, input.events, workerNodeId);
    });
}
