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
        /** Spawn a child session via the DurableCopilotClient SDK. */
        spawnChildSession(childSessionId: string, parentSessionId: string, config: any, task: string) {
            return ctx.scheduleActivity("spawnChildSession", { childSessionId, parentSessionId, config, task });
        },
        /** Send a message to a session via the DurableCopilotClient SDK. */
        sendToSession(sessionId: string, message: string) {
            return ctx.scheduleActivity("sendToSession", { sessionId, message });
        },
        /** Get the status of a session via the DurableCopilotClient SDK. */
        getSessionStatus(sessionId: string) {
            return ctx.scheduleActivity("getSessionStatus", { sessionId });
        },
        /** @deprecated Send a child_updates event to a parent orchestration. Use sendToSession instead. */
        notifyParent(parentOrchId: string, childOrchId: string, childSessionId: string, update: any) {
            return ctx.scheduleActivity("notifyParent", { parentOrchId, childOrchId, childSessionId, update });
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

            const result = await session.runTurn(enrichedPrompt, { onEvent });
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
    // Goes through the full SDK path: CMS registration + orchestration startup.
    runtime.registerActivity("spawnChildSession", async (
        activityCtx: any,
        input: { childSessionId: string; parentSessionId: string; config: SerializableSessionConfig; task: string },
    ): Promise<string> => {
        activityCtx.traceInfo(`[spawnChildSession] child=${input.childSessionId} parent=${input.parentSessionId}`);
        if (!storeUrl) throw new Error("No storeUrl — cannot create DurableCopilotClient");

        const sdkClient = new DurableCopilotClient({
            store: storeUrl,
            cmsSchema,
        });
        try {
            await sdkClient.start();

            // Create the child session via the SDK — handles CMS row + orchestration start
            const session = await sdkClient.createSession({
                sessionId: input.childSessionId,
                parentSessionId: input.parentSessionId,
                model: input.config.model,
                systemMessage: input.config.systemMessage,
                toolNames: input.config.toolNames,
                waitThreshold: input.config.waitThreshold,
            });

            // Fire the initial task prompt (non-blocking: just enqueues)
            await session.send(input.task);

            activityCtx.traceInfo(`[spawnChildSession] session created and task sent: ${input.childSessionId}`);
            return input.childSessionId;
        } finally {
            await sdkClient.stop();
        }
    });

    // ── sendToSession ───────────────────────────────────────
    // Sends a message to any session via the DurableCopilotClient SDK.
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
            const session = await sdkClient.resumeSession(input.sessionId);
            await session.send(input.message);
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
}
