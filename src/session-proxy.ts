import type { SessionManager } from "./session-manager.js";
import type { SessionBlobStore } from "./blob-store.js";
import type { SessionCatalogProvider } from "./cms.js";
import type { SerializableSessionConfig, TurnResult, OrchestrationInput } from "./types.js";
import { DurableCopilotClient } from "./client.js";
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
        runTurn(prompt: string) {
            return ctx.scheduleActivityOnSession(
                "runTurn",
                { sessionId, prompt, config },
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
        /** Spawn a child session via the DurableCopilotClient SDK. Returns the generated child session ID. */
        spawnChildSession(parentSessionId: string, config: any, task: string, nestingLevel?: number) {
            return ctx.scheduleActivity("spawnChildSession", { parentSessionId, config, task, nestingLevel });
        },
        /** Send a message to a session via the DurableCopilotClient SDK. */
        sendToSession(sessionId: string, message: string) {
            return ctx.scheduleActivity("sendToSession", { sessionId, message });
        },
        /** Send a raw command (JSON) directly to a session's event queue. */
        sendCommandToSession(sessionId: string, command: any) {
            return ctx.scheduleActivity("sendCommandToSession", { sessionId, command });
        },
        /** Get the status of a session via the DurableCopilotClient SDK. */
        getSessionStatus(sessionId: string) {
            return ctx.scheduleActivity("getSessionStatus", { sessionId });
        },
        /** List all sessions via the DurableCopilotClient SDK. */
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
    };
}

// ─── Activity Registration ───────────────────────────────────────
// Thin dispatchers — each is a one-liner that calls the corresponding
// SessionManager or ManagedSession method.

export function registerActivities(
    runtime: any,
    sessionManager: SessionManager,
    blobStore: SessionBlobStore | null,
    githubToken?: string,
    catalog?: SessionCatalogProvider | null,
    provider?: any,
    storeUrl?: string,
    cmsSchema?: string,
    /** Client-level config forwarded to ephemeral DurableCopilotClient instances (e.g. spawnChildSession). */
    clientConfig?: {
        blobEnabled?: boolean;
        duroxideSchema?: string;
    },
) {
    // ── runTurn ──────────────────────────────────────────────
    runtime.registerActivity("runTurn", async (
        activityCtx: any,
        input: { sessionId: string; prompt: string; config: SerializableSessionConfig },
    ): Promise<TurnResult> => {
        activityCtx.traceInfo(`[runTurn] session=${input.sessionId}`);

        const session = await sessionManager.getOrCreate(input.sessionId, input.config);

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
            if (catalog && !isTimerPrompt) {
                catalog.recordEvents(input.sessionId, [{
                    eventType: "user.message",
                    data: { content: input.prompt },
                }]).catch((err: any) => {
                    activityCtx.traceInfo(`[runTurn] CMS recordEvent (user) failed: ${err}`);
                });
            }

            const result = await session.runTurn(enrichedPrompt, {
                onEvent,
                modelSummary: sessionManager.getModelSummary(),
            });
            if (cancelled) return { type: "cancelled" };

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
                    await catalog.updateSession(input.sessionId, { title });
                    activityCtx.traceInfo(`[summarizeSession] title="${title}"`);
                }
                return title;
            } catch (err: any) {
                activityCtx.traceInfo(`[summarizeSession] failed: ${err.message}`);
                try { await sdk.stop(); } catch {}
                return "";
            }
        });
    }

    // ── spawnChildSession ─────────────────────────────────────
    // Creates a child session via the DurableCopilotClient SDK.
    // Generates a random UUID for the child session ID internally.
    // Goes through the full SDK path: CMS registration + orchestration startup.
    runtime.registerActivity("spawnChildSession", async (
        activityCtx: any,
        input: { parentSessionId: string; config: SerializableSessionConfig; task: string; nestingLevel?: number },
    ): Promise<string> => {
        const childSessionId = crypto.randomUUID();
        activityCtx.traceInfo(`[spawnChildSession] child=${childSessionId} parent=${input.parentSessionId} nesting=${input.nestingLevel ?? 0}`);
        if (!storeUrl) throw new Error("No storeUrl — cannot create DurableCopilotClient");

        const sdkClient = new DurableCopilotClient({
            store: storeUrl,
            cmsSchema,
            // Forward blob/dehydration config so child orchestrations inherit the parent's settings
            ...(clientConfig?.blobEnabled != null && { blobEnabled: clientConfig.blobEnabled }),
            ...(clientConfig?.duroxideSchema != null && { duroxideSchema: clientConfig.duroxideSchema }),
        });
        try {
            await sdkClient.start();

            // Create the child session via the SDK — handles CMS row + orchestration start
            const session = await sdkClient.createSession({
                sessionId: childSessionId,
                parentSessionId: input.parentSessionId,
                nestingLevel: input.nestingLevel,
                model: input.config.model,
                systemMessage: input.config.systemMessage,
                toolNames: input.config.toolNames,
                waitThreshold: input.config.waitThreshold,
            });

            // Fire the initial task prompt (non-blocking: just enqueues)
            await session.send(input.task);

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
        if (!storeUrl) throw new Error("No storeUrl — cannot create DurableCopilotClient");

        const sdkClient = new DurableCopilotClient({
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
        if (!storeUrl) throw new Error("No storeUrl — cannot create DurableCopilotClient");

        const sdkClient = new DurableCopilotClient({
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
    // Gets the status of a session via the DurableCopilotClient SDK.
    runtime.registerActivity("getSessionStatus", async (
        activityCtx: any,
        input: { sessionId: string },
    ): Promise<string> => {
        activityCtx.traceInfo(`[getSessionStatus] session=${input.sessionId}`);
        if (!storeUrl) throw new Error("No storeUrl — cannot create DurableCopilotClient");

        const sdkClient = new DurableCopilotClient({
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
    // Lists all sessions via the DurableCopilotClient SDK.
    runtime.registerActivity("listSessions", async (
        activityCtx: any,
        _input: {},
    ): Promise<string> => {
        activityCtx.traceInfo(`[listSessions]`);
        if (!storeUrl) throw new Error("No storeUrl — cannot create DurableCopilotClient");

        const sdkClient = new DurableCopilotClient({
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
        if (!storeUrl) throw new Error("No storeUrl — cannot create DurableCopilotClient");

        const sdkClient = new DurableCopilotClient({
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
        if (!storeUrl) throw new Error("No storeUrl — cannot create DurableCopilotClient");

        const sdkClient = new DurableCopilotClient({
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
}
