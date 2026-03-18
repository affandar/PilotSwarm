import type { SessionManager } from "./session-manager.js";
import type { SessionStateStore } from "./session-store.js";
import type { SessionCatalogProvider } from "./cms.js";
import { SESSION_STATE_MISSING_PREFIX, type SerializableSessionConfig, type TurnResult, type OrchestrationInput } from "./types.js";
import type { AgentConfig } from "./agent-loader.js";
import { systemChildAgentUUID } from "./agent-loader.js";
import { PilotSwarmClient } from "./client.js";
import os from "node:os";

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
        runTurn(prompt: string, bootstrap?: boolean, turnIndex?: number) {
            return ctx.scheduleActivityOnSession(
                "runTurn",
                { sessionId, prompt, config, ...(bootstrap ? { bootstrap: true } : {}), ...(turnIndex != null ? { turnIndex } : {}) },
                affinityKey,
            );
        },
        dehydrate(reason: string) {
            return ctx.scheduleActivityOnSession(
                "dehydrateSession",
                { sessionId, reason },
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
    /** Client-level config forwarded to ephemeral PilotSwarmClient instances (e.g. spawnChildSession). */
    clientConfig?: {
        blobEnabled?: boolean;
        duroxideSchema?: string;
    },
    /** Loaded system agents — used by resolveAgentConfig activity. */
    systemAgents?: AgentConfig[],
    /** Worker-level session policy — used by getWorkerSessionPolicy activity. */
    workerSessionPolicy?: import("./types.js").SessionPolicy | null,
    /** Names of loaded non-system agents — used by getWorkerSessionPolicy activity. */
    workerAllowedAgentNames?: string[],
    /** Loaded user-creatable agents — used by resolveAgentConfig activity. */
    userAgents?: Array<{ name: string; description?: string; prompt: string; tools?: string[] | null; namespace?: string; id?: string; title?: string; initialPrompt?: string; splash?: string; parent?: string; promptLayerKind?: "app-agent" | "app-system-agent" | "pilotswarm-system-agent" }>,
) {
    // ── runTurn ──────────────────────────────────────────────
    runtime.registerActivity("runTurn", async (
        activityCtx: any,
        input: { sessionId: string; prompt: string; config: SerializableSessionConfig; bootstrap?: boolean; turnIndex?: number },
    ): Promise<TurnResult> => {
        activityCtx.traceInfo(`[runTurn] session=${input.sessionId}`);

        let session;
        try {
            session = await sessionManager.getOrCreate(input.sessionId, input.config, {
                turnIndex: input.turnIndex,
            });
        } catch (err: any) {
            const message = err?.message || String(err);
            if (message.includes(SESSION_STATE_MISSING_PREFIX)) {
                if (catalog) {
                    await catalog.updateSession(input.sessionId, {
                        state: "failed",
                        lastError: message,
                    }).catch(() => {});
                }
                return { type: "error", message };
            }
            throw err;
        }

        // Cooperative cancellation: poll for lock steal
        let cancelled = false;
        const cancelPoll = setInterval(() => {
            if (activityCtx.isCancelled()) {
                cancelled = true;
                session.abort();
                clearInterval(cancelPoll);
            }
        }, 2_000);

        try {
            // Inject host info so LLM knows which worker it's on
            const hostname = os.hostname();
            const enrichedPrompt = `[SYSTEM: Running on host "${hostname}".]\n\n${input.prompt}`;

            // Build onEvent callback: write each non-ephemeral event to CMS as it fires
            const EPHEMERAL_TYPES = new Set([
                "assistant.message_delta",
                "assistant.reasoning_delta",
                "user.message", // Already recorded explicitly above — skip the SDK's duplicate
            ]);
            const onEvent = catalog
                ? (event: { eventType: string; data: unknown }) => {
                    if (EPHEMERAL_TYPES.has(event.eventType)) return;
                    catalog.recordEvents(input.sessionId, [event]).catch((err: any) => {
                        activityCtx.traceInfo(`[runTurn] CMS recordEvent failed: ${err}`);
                    });
                }
                : undefined;

            // Record the user prompt as a CMS event before running the turn.
            // Skip internal timer continuation prompts — they're system-generated, not user input.
            const isTimerPrompt = /^The \d+ second wait is now complete\./i.test(input.prompt);
            if (catalog && !isTimerPrompt && !input.bootstrap) {
                catalog.recordEvents(input.sessionId, [{
                    eventType: "user.message",
                    data: { content: input.prompt },
                }]).catch((err: any) => {
                    activityCtx.traceInfo(`[runTurn] CMS recordEvent (user) failed: ${err}`);
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
            const result = await session.runTurn(enrichedPrompt, {
                onEvent,
                modelSummary: sessionManager.getModelSummary(),
                bootstrap: input.bootstrap,
            });
            activityCtx.traceInfo(`[runTurn] ManagedSession.runTurn completed for ${input.sessionId} type=${result.type}`);
            if (cancelled) return { type: "cancelled" };

            // ── Activity-level writeback: sync turn result → CMS ──
            // This lets listSessions() read entirely from CMS without
            // hitting duroxide for every session's customStatus.
            if (catalog) {
                const statusMap: Record<string, string> = {
                    completed: "idle", // orchestration decides idle vs completed; default to idle
                    wait: "waiting",
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
        }
    });

    // ── dehydrateSession ────────────────────────────────────
    runtime.registerActivity("dehydrateSession", async (
        _ctx: any,
        input: { sessionId: string; reason?: string },
    ): Promise<void> => {
        await sessionManager.dehydrate(input.sessionId, input.reason ?? "unknown");
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
    if (githubToken) {
        runtime.registerActivity("listModels", async (
            activityCtx: any,
            _input: Record<string, unknown>,
        ): Promise<string> => {
            activityCtx.traceInfo("[listModels] fetching");
            const { CopilotClient } = await import("@github/copilot-sdk");
            const sdk = new CopilotClient({ githubToken });
            try {
                await sdk.start();
                const models = await sdk.listModels();
                return JSON.stringify(models.map((m: any) => ({ id: m.id })));
            } finally {
                try { await sdk.stop(); } catch {}
            }
        });
    }

    // ── summarizeSession ────────────────────────────────────
    // Fetches recent conversation from CMS, asks a lightweight LLM
    // for a 3-5 word title, and writes it back to CMS.
    if (githubToken && catalog) {
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

            // Use a one-shot CopilotSession to generate the title
            const { CopilotClient: SdkClient } = await import("@github/copilot-sdk");
            const sdk = new SdkClient({ githubToken });
            try {
                await sdk.start();
                const tempSession = await sdk.createSession({ model: "gpt-4o-mini", onPermissionRequest: async () => ({ kind: "approved" as const }) });
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
    // Resolves a loaded agent definition by name. Used by spawn_agent
    // with agent_name to look up the agent's prompt, tools, and initial prompt.
    runtime.registerActivity("resolveAgentConfig", async (
        _activityCtx: any,
        input: { agentName: string },
    ): Promise<{ name: string; prompt: string; tools?: string[]; initialPrompt?: string; title?: string; system?: boolean; id?: string; parent?: string; splash?: string; namespace?: string; promptLayerKind?: "app-agent" | "app-system-agent" | "pilotswarm-system-agent" } | null> => {
        const agents: Array<any> = [...(systemAgents ?? []), ...(userAgents ?? []).map(a => ({ ...a, system: false }))];
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
        const isDeterministicSystemChild = Boolean(input.isSystem && input.agentId);
        const childSessionId = isDeterministicSystemChild
            ? systemChildAgentUUID(input.parentSessionId, input.agentId!)
            : crypto.randomUUID();
        activityCtx.traceInfo(`[spawnChildSession] child=${childSessionId} parent=${input.parentSessionId} nesting=${input.nestingLevel ?? 0} isSystem=${input.isSystem ?? false} agent=${input.agentId ?? "custom"}`);
        if (!storeUrl) throw new Error("No storeUrl — cannot create PilotSwarmClient");

        const sdkClient = new PilotSwarmClient({
            store: storeUrl,
            cmsSchema,
            // Forward blob/dehydration config so child orchestrations inherit the parent's settings
            ...(clientConfig?.blobEnabled != null && { blobEnabled: clientConfig.blobEnabled }),
            ...(clientConfig?.duroxideSchema != null && { duroxideSchema: clientConfig.duroxideSchema }),
        });
        try {
            await sdkClient.start();

            if (isDeterministicSystemChild && catalog) {
                const existing = await catalog.getSession(childSessionId);
                if (existing && !["completed", "failed", "terminated"].includes(existing.state)) {
                    activityCtx.traceInfo(`[spawnChildSession] reusing existing live system child: ${childSessionId}`);
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

            // Create the child session via the SDK — handles CMS row + orchestration start
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
            });

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
                await catalog.updateSession(childSessionId, meta);
            }

            // Fire the initial task prompt (non-blocking: just enqueues).
            // This prompt is orchestration-generated bootstrap state for the child
            // session, not an actual user-authored message inside that child chat.
            await session.send(input.task, { bootstrap: true });

            activityCtx.traceInfo(`[spawnChildSession] session created and task sent: ${childSessionId}`);
            return childSessionId;
        } finally {
            await sdkClient.stop();
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
        });
        try {
            await sdkClient.start();
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
                    state: "completed",
                    lastError: input.reason ? `Cancelled: ${input.reason}` : "Cancelled",
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
}
