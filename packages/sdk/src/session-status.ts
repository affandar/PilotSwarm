import type { SessionRow } from "./cms.js";
import type {
    PilotSwarmSessionStatus,
    SessionResponsePayload,
    SessionStatusSignal,
} from "./types.js";

type TerminalSessionLike = {
    parentSessionId?: string | null;
    isSystem?: boolean;
    rowState?: string | null;
    status?: string | null;
    orchestrationStatus?: string | null;
    cronActive?: boolean;
    cronInterval?: number;
    turnResultType?: string | null;
    latestResponseType?: SessionResponsePayload["type"] | null;
};

export function isCompletedTerminalSession(input: TerminalSessionLike): boolean {
    const hasParent = typeof input.parentSessionId === "string" && input.parentSessionId.length > 0;
    if (!hasParent || input.isSystem) return false;
    if (input.cronActive === true) return false;
    if (typeof input.cronInterval === "number" && input.cronInterval > 0) return false;

    if (input.status === "completed" || input.rowState === "completed") return true;

    if (input.orchestrationStatus !== "Completed") return false;

    return input.turnResultType === "completed" || input.latestResponseType === "completed";
}

export function deriveSessionStatus(input: TerminalSessionLike): PilotSwarmSessionStatus {
    if (input.orchestrationStatus === "Failed") return "failed";
    if (isCompletedTerminalSession(input)) return "completed";
    if (input.orchestrationStatus === "Running" && !input.status) {
        if (input.rowState === "error" || input.rowState === "failed" || input.rowState === "completed") {
            return "running";
        }
    }
    return (input.status || input.rowState || "pending") as PilotSwarmSessionStatus;
}

export function shouldSyncCompletedStatus(input: TerminalSessionLike): boolean {
    return isCompletedTerminalSession(input) && input.rowState !== "completed";
}

export function shouldSyncFailedStatus(input: TerminalSessionLike): boolean {
    return input.orchestrationStatus === "Failed" && input.rowState !== "failed";
}

export function deriveStatusFromCmsAndRuntime(opts: {
    row?: SessionRow | null;
    customStatus?: SessionStatusSignal | any;
    latestResponse?: SessionResponsePayload | null;
    orchestrationStatus?: string | null;
}): PilotSwarmSessionStatus {
    const row = opts.row ?? null;
    const customStatus = opts.customStatus ?? {};
    return deriveSessionStatus({
        parentSessionId: row?.parentSessionId,
        isSystem: row?.isSystem,
        rowState: row?.state,
        status: customStatus?.status,
        orchestrationStatus: opts.orchestrationStatus ?? undefined,
        cronActive: customStatus?.cronActive === true,
        cronInterval: typeof customStatus?.cronInterval === "number" ? customStatus.cronInterval : undefined,
        turnResultType: customStatus?.turnResult?.type,
        latestResponseType: opts.latestResponse?.type,
    });
}

/**
 * A row parked on error/failed while the orchestration is still Running is
 * usually stale: the worker died mid-turn and the runtime re-dispatched.
 * Returns the state to write back, or null when the row must be left alone.
 *
 * Null when the runtime ITSELF says error/failed. The worker just wrote that
 * row (a turn ended in error, retries pending) and the detail read reports
 * the same error to the caller. Rewriting the row to "running" here made the
 * list (row-based) and the detail (runtime-based) disagree, and the portal
 * flipped the Warning card off and on with every poll.
 */
export function resolveStaleRunningRowRecovery(input: {
    rowState?: string | null;
    status?: string | null;
    orchestrationStatus?: string | null;
}): string | null {
    if (input.orchestrationStatus !== "Running") return null;
    if (input.rowState !== "error" && input.rowState !== "failed") return null;
    const status = typeof input.status === "string" ? input.status : "";
    if (status === "error" || status === "failed") return null;
    return status || "running";
}

