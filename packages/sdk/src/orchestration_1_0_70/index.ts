/**
 * Durable session orchestration v1.0.70 — FROZEN.
 *
 * Frozen at the v0.5.51 release state. 1.0.71 changes WHERE a turn's
 * `[SYSTEM: …]` wake-up note is delivered: 1.0.70 parks it in
 * `config.turnSystemPrompt`, which session-manager renders into the SYSTEM
 * message, so every wake-up rewrote the first bytes of the request and
 * threw away the provider's prefix cache (measured on chk: 12% cache hit on
 * the first call after a wake-up vs 93–99% when the system message is
 * stable). 1.0.71 keeps the note in the user turn instead. That changes the
 * prompt string the orchestration yields to runTurn, and durable replay
 * matches on the yield sequence — so 1.0.70 is frozen here. Replay-only
 * maintenance from here; live development continues in ../orchestration/.
 *
 * Flat event loop backed by a KV FIFO work buffer:
 *   1. `createRuntime` builds the mutable runtime and runs startup gates.
 *   2. `runLoop` repeatedly drains the durable message queue + timer fires into
 *      the KV FIFO, dispatches one unit of work, and continues-as-new when idle.
 *
 * Module layout:
 *   - state.ts     types, constants, createInitialState
 *   - utils.ts     pure helpers (prompt parsing, context usage, error checks)
 *   - lifecycle.ts status, releaseAffinity, commands, child digest, CAN
 *   - queue.ts     KV FIFO, drain, decide
 *   - turn.ts      processPrompt, handleTurnResult, processTimer
 *   - agents.ts    sub-agent tracking, tool actions, shutdown cascade
 *   - runtime.ts   createRuntime, runLoop
 *
 * @internal
 */
import type { OrchestrationInput } from "../types.js";
import { CURRENT_ORCHESTRATION_VERSION, createRuntime, runLoop } from "./runtime.js";
import { DURABLE_SESSION_LATEST_VERSION } from "../orchestration-version.js";

export { CURRENT_ORCHESTRATION_VERSION };

export function* durableSessionOrchestration_1_0_70(
    ctx: any,
    input: OrchestrationInput,
): Generator<any, string, any> {
    const runtime = yield* createRuntime(ctx, input, {
        currentVersion: CURRENT_ORCHESTRATION_VERSION,
        latestVersion: DURABLE_SESSION_LATEST_VERSION,
    });
    if (runtime.state.orchestrationResult !== null) return runtime.state.orchestrationResult;
    return yield* runLoop(runtime);
}
