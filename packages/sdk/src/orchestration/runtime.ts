import type { OrchestrationInput } from "../types.js";
import { COMMAND_VERSION_KEY, RESPONSE_VERSION_KEY } from "../types.js";
import { createSessionManagerProxy, createSessionProxy } from "../session-proxy.js";
import { DURABLE_SESSION_LATEST_VERSION } from "../orchestration-version.js";
import {
    continueInput,
    publishStatus,
    readCounter,
    versionedContinueAsNew,
} from "./lifecycle.js";
import { decide, drain } from "./queue.js";
import {
    HISTORY_SIZE_CHECK_INTERVAL_ITERATIONS,
    MAX_HISTORY_SIZE_BEFORE_CONTINUE_AS_NEW_BYTES,
    MAX_ITERATIONS_PER_EXECUTION,
    createInitialState,
    deriveOptions,
    type DurableSessionRuntime,
} from "./state.js";

export const CURRENT_ORCHESTRATION_VERSION = DURABLE_SESSION_LATEST_VERSION;

/** Wraps `ctx.traceInfo` so every line is tagged with the running orchestration version. */
function installVersionedTracing(ctx: any, sourceVersion: string): void {
    const rawTraceInfo = typeof ctx.traceInfo === "function" ? ctx.traceInfo.bind(ctx) : null;
    if (!rawTraceInfo) return;
    const versionPrefix = sourceVersion === CURRENT_ORCHESTRATION_VERSION
        ? `[v${CURRENT_ORCHESTRATION_VERSION}]`
        : `[v${CURRENT_ORCHESTRATION_VERSION} from=${sourceVersion}]`;
    ctx.traceInfo = (message: string) => rawTraceInfo(`${versionPrefix} ${message}`);
}

/** Restore the active timer from continueAsNew input. */
function* restoreActiveTimer(runtime: DurableSessionRuntime): Generator<any, void, any> {
    if (!runtime.input.activeTimerState) return;
    const initNow: number = yield runtime.ctx.utcNow();
    const t = runtime.input.activeTimerState;
    runtime.state.activeTimer = {
        deadlineMs: initNow + (t.remainingMs ?? 0),
        originalDurationMs: t.originalDurationMs ?? t.remainingMs ?? 0,
        reason: t.reason,
        type: t.type,
        ...(t.shouldRehydrate ? { shouldRehydrate: true } : {}),
        ...(t.waitPlan ? { waitPlan: t.waitPlan } : {}),
        ...(t.content ? { content: t.content } : {}),
        ...(t.question ? { question: t.question } : {}),
        ...(t.choices ? { choices: t.choices } : {}),
        ...(t.allowFreeform !== undefined ? { allowFreeform: t.allowFreeform } : {}),
        ...(t.agentIds ? { agentIds: t.agentIds } : {}),
    };
}

/** Carry over a legacy single-message envelope from older orchestration versions. */
function applyLegacyPendingMessage(runtime: DurableSessionRuntime): void {
    if (!runtime.input.pendingMessage) return;
    const legacyMsg = runtime.input.pendingMessage as any;
    if (legacyMsg.prompt && !runtime.state.pendingPrompt) {
        runtime.state.pendingPrompt = legacyMsg.prompt;
        runtime.state.bootstrapPrompt = Boolean(legacyMsg.bootstrap);
        runtime.state.pendingRequiredTool = legacyMsg.requiredTool;
    } else {
        runtime.state.legacyPendingMessage = legacyMsg;
    }
}

/** Reject the orchestration up-front when policy disallows this start. */
function* enforceCreationPolicy(runtime: DurableSessionRuntime): Generator<any, void, any> {
    const { state, options, input } = runtime;
    if (state.iteration !== 0 || options.parentSessionId || options.isSystem) return;

    const workerPolicy: { policy: any; allowedAgentNames: string[] } = yield runtime.manager.getWorkerSessionPolicy();
    const policy = workerPolicy.policy;
    if (!policy || policy.creation?.mode !== "allowlist") return;

    const agentId = input.agentId;
    const allowedNames = workerPolicy.allowedAgentNames;
    if (!agentId && !policy.creation.allowGeneric) {
        runtime.ctx.traceInfo(`[orch] policy rejection: generic session not allowed`);
        publishStatus(runtime, "failed", { policyRejected: true });
        yield runtime.manager.updateCmsState(input.sessionId, "rejected");
        runtime.state.orchestrationResult = "[POLICY] Session rejected: generic sessions are not allowed by session creation policy.";
        return;
    }
    if (agentId && allowedNames.length > 0 && !allowedNames.includes(agentId)) {
        runtime.ctx.traceInfo(`[orch] policy rejection: agent "${agentId}" not in allowed list`);
        publishStatus(runtime, "failed", { policyRejected: true });
        yield runtime.manager.updateCmsState(input.sessionId, "rejected");
        runtime.state.orchestrationResult = `[POLICY] Session rejected: agent "${agentId}" is not in the allowed agent list.`;
    }
}

/** For top-level named-agent sessions, merge the agent definition's tools into the session config. */
function* resolveTopLevelAgentConfig(runtime: DurableSessionRuntime): Generator<any, void, any> {
    const { state, options, input } = runtime;
    if (state.iteration !== 0 || options.parentSessionId || !input.agentId || options.isSystem) return;

    const agentDef: any = yield runtime.manager.resolveAgentConfig(input.agentId);
    if (agentDef?.system && agentDef?.creatable === false) {
        const message =
            `Agent "${input.agentId}" is a worker-managed system agent and cannot be started manually. ` +
            `If it is missing, the workers likely need to be restarted.`;
        runtime.ctx.traceInfo(`[orch] top-level named session denied: ${message}`);
        publishStatus(runtime, "failed", { workerManagedAgent: true });
        yield runtime.manager.updateCmsState(input.sessionId, "failed", message);
        runtime.state.orchestrationResult = `[SYSTEM: ${message}]`;
        return;
    }
    if (agentDef) {
        const mergedToolNames = Array.from(new Set([
            ...(agentDef.tools ?? []),
            ...(state.config.toolNames ?? []),
        ]));
        if (mergedToolNames.length > 0) {
            state.config.toolNames = mergedToolNames;
            runtime.ctx.traceInfo(`[orch] merged top-level agent tools for ${input.agentId}: ${mergedToolNames.join(", ")}`);
        }
        runtime.session = createSessionProxy(runtime.ctx, input.sessionId, state.affinityKey, state.config);
    }
}

/**
 * Build the runtime, install versioned tracing, restore the timer state from
 * continueAsNew, run startup gates (creation policy + agent config resolution),
 * and trace the start banner. Returns a runtime ready for `runLoop`.
 *
 * If a startup gate sets `runtime.state.orchestrationResult`, the caller should
 * return that value immediately and skip the loop.
 */
export function* createRuntime(
    ctx: any,
    input: OrchestrationInput,
    versions: { currentVersion: string; latestVersion: string },
): Generator<any, DurableSessionRuntime, any> {
    const sourceVersion = typeof input.sourceOrchestrationVersion === "string" && input.sourceOrchestrationVersion
        ? input.sourceOrchestrationVersion
        : versions.currentVersion;
    installVersionedTracing(ctx, sourceVersion);

    const options = deriveOptions(input);
    const state = createInitialState(input, options);
    state.lastResponseVersion = readCounter(ctx, RESPONSE_VERSION_KEY);
    state.lastCommandVersion = readCounter(ctx, COMMAND_VERSION_KEY);

    const manager = createSessionManagerProxy(ctx);
    const session = createSessionProxy(ctx, input.sessionId, state.affinityKey, state.config);

    const runtime: DurableSessionRuntime = { ctx, input, versions, manager, session, state, options };

    yield* restoreActiveTimer(runtime);
    applyLegacyPendingMessage(runtime);

    ctx.traceInfo(
        `[orch] start: iter=${state.iteration} ` +
        `pending=${state.pendingPrompt ? `"${state.pendingPrompt.slice(0, 40)}"` : 'NONE'} ` +
        `queued=${state.pendingToolActions.length} hydrate=${state.needsHydration} ` +
        `blob=${state.blobEnabled} timer=${state.activeTimer?.type ?? 'none'}`,
    );

    yield* enforceCreationPolicy(runtime);
    if (state.orchestrationResult !== null) return runtime;

    yield* resolveTopLevelAgentConfig(runtime);
    return runtime;
}

/**
 * Flat event loop: drain the durable message queue + timer fires into the KV
 * FIFO, decide what to dispatch next, and continue-as-new when the loop has no
 * more buffered work.
 *
 * Each iteration is one of:
 *   - drain() pulls events from the durable queue (blocking when idle).
 *   - decide() pops one unit of work (tool action, prompt, FIFO item, digest).
 *   - if neither produced work and no timer/input is pending, CAN.
 *
 * Hard caps on this execution force a CAN to keep history size bounded.
 */
export function* runLoop(runtime: DurableSessionRuntime): Generator<any, string, any> {
    const { ctx, state } = runtime;
    while (true) {
        state.loopIteration++;

        // Safety cap on iterations per execution.
        if (state.loopIteration > MAX_ITERATIONS_PER_EXECUTION) {
            ctx.traceInfo(`[orch] iteration cap (${MAX_ITERATIONS_PER_EXECUTION}) — continuing as new`);
            yield* versionedContinueAsNew(runtime, continueInput(runtime));
            return "";
        }

        // Periodic history-size check forces a CAN before duroxide history grows too large.
        if (state.loopIteration % HISTORY_SIZE_CHECK_INTERVAL_ITERATIONS === 0) {
            try {
                const stats = yield runtime.manager.getOrchestrationStats(runtime.input.sessionId);
                const historySizeBytes = Number(stats?.historySizeBytes) || 0;
                if (historySizeBytes >= MAX_HISTORY_SIZE_BEFORE_CONTINUE_AS_NEW_BYTES) {
                    ctx.traceInfo(
                        `[orch] history size cap (${historySizeBytes} >= ${MAX_HISTORY_SIZE_BEFORE_CONTINUE_AS_NEW_BYTES}) ` +
                        `at loop ${state.loopIteration} — continuing as new`,
                    );
                    yield* versionedContinueAsNew(runtime, continueInput(runtime));
                    return "";
                }
            } catch (err: any) {
                ctx.traceInfo(`[orch] history size check failed at loop ${state.loopIteration}: ${err?.message ?? err}`);
            }
        }

        yield* drain(runtime);
        if (state.orchestrationResult !== null) return state.orchestrationResult;

        const didWork = yield* decide(runtime);
        if (state.orchestrationResult !== null) return state.orchestrationResult;

        if (didWork) continue;
        if (state.activeTimer) continue;        // drain will race the timer next iteration
        if (state.pendingInputQuestion) continue; // drain will block on dequeue for an answer

        ctx.traceInfo(`[orch] no buffered work, continuing as new`);
        yield* versionedContinueAsNew(runtime, continueInput(runtime));
        return "";
    }
}
