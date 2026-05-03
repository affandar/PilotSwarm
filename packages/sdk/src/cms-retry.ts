/**
 * CMS retry helper for orchestration activities.
 *
 * Two policies:
 *
 * - `cmsRetryCritical`: 4 retries at 1s / 5s / 15s / 90s (5 total attempts).
 *   The first three handle transient blips (connection reset, deadlock,
 *   serialization failure, brief unavailability). The 90s tail handles
 *   PostgreSQL maintenance windows (failover, restart, connection storm).
 *   On exhaustion or non-transient error, the original error is thrown so
 *   the orchestration's own classification still works.
 *
 * - `cmsRetryBestEffort`: 1 retry at 3s (2 total attempts).
 *   For non-flow-critical writes (event log entries, etc.). On exhaustion or
 *   non-transient error, logs and returns `undefined` instead of throwing.
 *   Callers that don't care about the return value can ignore it.
 *
 * Only PostgreSQL transient errors trigger a retry. Constraint violations,
 * syntax errors, and other deterministic failures propagate immediately —
 * retrying those just delays the inevitable.
 */

const CRITICAL_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 90_000];
const BEST_EFFORT_RETRY_DELAYS_MS = [3_000];

/**
 * PostgreSQL SQLSTATEs and node-pg / network error codes we treat as transient.
 *
 * SQLSTATE references (postgres docs):
 *   08xxx — connection exception family
 *   40001 — serialization failure (could not serialize access due to concurrent update)
 *   40P01 — deadlock detected
 *   53300 — too many connections
 *   57014 — query canceled (e.g. statement_timeout)
 *   57P01 — admin shutdown
 *   57P02 — crash shutdown
 *   57P03 — cannot connect now (still starting up / shutting down)
 */
const TRANSIENT_SQL_STATES = new Set([
    "08000", "08001", "08003", "08004", "08006", "08007",  // connection exception
    "40001",                                                // serialization_failure
    "40P01",                                                // deadlock_detected
    "53300",                                                // too_many_connections
    "57014",                                                // query_canceled
    "57P01", "57P02", "57P03",                              // admin/crash/cannot_connect
]);

const TRANSIENT_NETWORK_CODES = new Set([
    "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "EHOSTUNREACH", "ENETUNREACH",
]);

const TRANSIENT_MESSAGE_PATTERNS: RegExp[] = [
    /Connection terminated unexpectedly/i,
    /server closed the connection unexpectedly/i,
    /timeout exceeded when trying to connect/i,
];

/**
 * Returns true if `err` looks like a retryable PG transient.
 *
 * If the error has a structured `code`, the code is the verdict — we do not
 * fall through to the message regex. Otherwise a non-transient SQLSTATE (e.g.
 * a constraint violation whose message happens to contain "connection") would
 * be retried.
 *
 * The message-only patterns are deliberately tight. Broader matchers (e.g.
 * "connection closed", "client has encountered a connection error") catch
 * natural pool teardown during normal shutdown — retrying against a
 * deliberately-closed pool just delays the inevitable.
 */
export function isTransientCmsError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const e = err as { code?: unknown; message?: unknown };
    const code = typeof e.code === "string" ? e.code : undefined;
    if (code) return TRANSIENT_SQL_STATES.has(code) || TRANSIENT_NETWORK_CODES.has(code);
    const message = typeof e.message === "string" ? e.message : "";
    return TRANSIENT_MESSAGE_PATTERNS.some((re) => re.test(message));
}

interface RetryRunOptions {
    label: string;
    delaysMs: readonly number[];
    swallow: boolean;
    log?: (msg: string) => void;
}

async function runWithRetry<T>(fn: () => Promise<T>, opts: RetryRunOptions): Promise<T | undefined> {
    let attempt = 0;
    const maxAttempts = opts.delaysMs.length + 1;
    while (true) {
        try {
            return await fn();
        } catch (err: any) {
            const transient = isTransientCmsError(err);
            const remaining = opts.delaysMs.slice(attempt);
            const exhausted = remaining.length === 0;

            if (!transient || exhausted) {
                if (opts.swallow) {
                    const reason = transient ? "transient retries exhausted" : "non-transient";
                    opts.log?.(
                        `[cms-retry] ${opts.label} failed after ${attempt + 1}/${maxAttempts} attempt(s) ` +
                        `(${reason}); swallowing: ${err?.message ?? err}`,
                    );
                    return undefined;
                }
                throw err;
            }

            const delay = remaining[0];
            opts.log?.(
                `[cms-retry] ${opts.label} transient failure (attempt ${attempt + 1}/${maxAttempts}), ` +
                `retrying in ${delay}ms: ${err?.message ?? err}`,
            );
            await new Promise<void>((resolve) => setTimeout(resolve, delay));
            attempt++;
        }
    }
}

export async function cmsRetryCritical<T>(
    label: string,
    fn: () => Promise<T>,
    log?: (msg: string) => void,
): Promise<T> {
    const result = await runWithRetry(fn, {
        label,
        delaysMs: CRITICAL_RETRY_DELAYS_MS,
        swallow: false,
        log,
    });
    return result as T;
}

export async function cmsRetryBestEffort<T>(
    label: string,
    fn: () => Promise<T>,
    log?: (msg: string) => void,
): Promise<T | undefined> {
    return await runWithRetry(fn, {
        label,
        delaysMs: BEST_EFFORT_RETRY_DELAYS_MS,
        swallow: true,
        log,
    });
}
