import type { SessionManager } from "./session-manager.js";
import type { SessionBlobStore } from "./blob-store.js";
import type { SessionCatalogProvider } from "./cms.js";
import type { SerializableSessionConfig, TurnResult, OrchestrationInput } from "./types.js";
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
}
