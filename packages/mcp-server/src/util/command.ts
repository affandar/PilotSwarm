import { randomUUID } from "node:crypto";
import type { CommandResponse, PilotSwarmManagementClient } from "pilotswarm-sdk";

// Local alias matches what mgmt.getCommandResponse() returns. The full
// SessionCommandResponse type from the SDK is internal; CommandResponse
// (id / cmd / result? / error?) is the public-API shape we consume.
type CommandResponseLike = CommandResponse & { version?: number; emittedAt?: number };

export class CommandRejectedError extends Error {
    readonly cmd: string;
    readonly cmdId: string;
    readonly response: CommandResponseLike;

    constructor(response: CommandResponseLike) {
        super(response.error ?? `Command "${response.cmd}" was rejected with no error message`);
        this.name = "CommandRejectedError";
        this.cmd = response.cmd;
        this.cmdId = response.id;
        this.response = response;
    }
}

export class CommandTimeoutError extends Error {
    readonly cmd: string;
    readonly cmdId: string;
    readonly timeoutMs: number;

    constructor(cmd: string, cmdId: string, timeoutMs: number) {
        super(`Timed out after ${timeoutMs}ms waiting for response to command "${cmd}" (id=${cmdId})`);
        this.name = "CommandTimeoutError";
        this.cmd = cmd;
        this.cmdId = cmdId;
        this.timeoutMs = timeoutMs;
    }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 200;

/**
 * Send a command to a session's orchestration and wait for the orchestration's
 * response.
 *
 * The bare `mgmt.sendCommand(...)` call is fire-and-forget — it returns once the
 * command is enqueued, regardless of whether the orchestration ultimately
 * accepts it. Unknown commands (e.g. anything other than the orchestration's
 * recognized set: `set_model` / `list_models` / `get_info` / `done` /
 * `cancel` / `delete`) are queued, processed, and rejected with
 * `error: "Unknown command: ..."` written to KV — but the caller never sees
 * that error if it doesn't poll.
 *
 * This helper closes the loop: enqueue with a fresh `cmdId`, poll the
 * orchestration's KV-backed response channel until the response shows up,
 * then return the response or throw `CommandRejectedError` /
 * `CommandTimeoutError`.
 *
 * @param mgmt - PilotSwarmManagementClient instance
 * @param sessionId - target session id
 * @param cmd - command name (e.g. "set_model")
 * @param args - command-specific arguments
 * @param opts.timeoutMs - max time to wait for the orchestration's response
 *   (default 15s)
 * @param opts.pollIntervalMs - KV poll interval (default 200ms)
 * @param opts.signal - optional abort signal
 * @throws CommandRejectedError if the orchestration writes an `error` response
 * @throws CommandTimeoutError if no response shows up within `timeoutMs`
 */
export async function sendCommandAndWait(
    mgmt: PilotSwarmManagementClient,
    sessionId: string,
    cmd: string,
    args?: Record<string, unknown>,
    opts?: {
        timeoutMs?: number;
        pollIntervalMs?: number;
        signal?: AbortSignal;
    },
): Promise<CommandResponseLike> {
    const cmdId = randomUUID();
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollIntervalMs = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    await mgmt.sendCommand(sessionId, { cmd, id: cmdId, ...(args ? { args } : {}) });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (opts?.signal?.aborted) throw opts.signal.reason ?? new Error("Aborted");
        const response = await mgmt.getCommandResponse(sessionId, cmdId);
        if (response) {
            if (response.error) throw new CommandRejectedError(response);
            return response;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
    }

    throw new CommandTimeoutError(cmd, cmdId, timeoutMs);
}
