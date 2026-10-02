/**
 * CMS retry helper for orchestration activities.
 *
 * Two policies:
 *
 * - `cmsRetryCritical`: 4 retries at 1s / 5s / 15s / 90s (5 total attempts).
 *   The first three handle transient blips (connection reset, deadlock,
 *   serialization failure, brief unavailability). The 90s tail handles
 *   database maintenance windows (failover, restart, connection storm).
 *   On exhaustion or non-transient error, the original error is thrown so
 *   the orchestration's own classification still works.
 *
 * - `cmsRetryBestEffort`: 1 retry at 3s (2 total attempts).
 *   For non-flow-critical writes (event log entries, etc.). On exhaustion or
 *   non-transient error, logs and returns `undefined` instead of throwing.
 *   Callers that don't care about the return value can ignore it.
 *
 * Delays carry bounded jitter so concurrent clients do not retry in lockstep.
 *
 * Only recognized transient datastore errors trigger a retry. Constraint
 * violations, syntax errors, and other deterministic failures propagate
 * immediately — retrying those just delays the inevitable.
 */

const CRITICAL_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 90_000];
const BEST_EFFORT_RETRY_DELAYS_MS = [3_000];
const RETRY_JITTER_FRACTION = 0.2;

export type CmsTransientCategory =
    | "connection_saturation"
    | "connection_exception"
    | "client_timeout"
    | "serialization_failure"
    | "deadlock_detected"
    | "query_canceled"
    | "server_unavailable";

interface TransientCategoryDefinition {
    tag: CmsTransientCategory;
    sqlStates?: ReadonlySet<string>;
    networkCodes?: ReadonlySet<string>;
    messagePatterns?: readonly RegExp[];
}

const TRANSIENT_CATEGORIES: readonly TransientCategoryDefinition[] = [
    {
        tag: "connection_saturation",
        sqlStates: new Set(["53300"]),
        messagePatterns: [
            /remaining connection slots are reserved/i,
            /too many clients already/i,
            /sorry, too many clients/i,
            /too many connections/i,
        ],
    },
    {
        tag: "connection_exception",
        sqlStates: new Set(["08000", "08001", "08003", "08004", "08006", "08007"]),
        networkCodes: new Set([
            "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "EHOSTUNREACH", "ENETUNREACH",
        ]),
        messagePatterns: [
            /Connection terminated unexpectedly/i,
            /server closed the connection unexpectedly/i,
            /timeout exceeded when trying to connect/i,
        ],
    },
    {
        tag: "client_timeout",
        messagePatterns: [
            /Connection terminated due to connection timeout/i,
            /Query read timeout/i,
        ],
    },
    { tag: "serialization_failure", sqlStates: new Set(["40001"]) },
    { tag: "deadlock_detected", sqlStates: new Set(["40P01"]) },
    { tag: "query_canceled", sqlStates: new Set(["57014"]) },
    { tag: "server_unavailable", sqlStates: new Set(["57P01", "57P02", "57P03"]) },
];

function errorCode(err: unknown): string | undefined {
    if (!err || typeof err !== "object") return undefined;
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
}

/**
 * Classifies a retryable datastore failure into a stable, bounded category.
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
export function classifyCmsError(err: unknown): CmsTransientCategory | undefined {
    if (!err || typeof err !== "object") return undefined;
    const code = errorCode(err);
    if (code) {
        for (const category of TRANSIENT_CATEGORIES) {
            if (category.sqlStates?.has(code) || category.networkCodes?.has(code)) {
                return category.tag;
            }
        }
        return undefined;
    }

    const message = typeof (err as { message?: unknown }).message === "string"
        ? (err as { message: string }).message
        : "";
    for (const category of TRANSIENT_CATEGORIES) {
        if (category.messagePatterns?.some((pattern) => pattern.test(message))) {
            return category.tag;
        }
    }
    return undefined;
}

export function isTransientCmsError(err: unknown): boolean {
    return classifyCmsError(err) !== undefined;
}

function jitter(delayMs: number): number {
    const spread = delayMs * RETRY_JITTER_FRACTION;
    return Math.max(0, Math.round(delayMs + (Math.random() * 2 - 1) * spread));
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
            const category = classifyCmsError(err);
            const transient = category !== undefined;
            const remaining = opts.delaysMs.slice(attempt);
            const exhausted = remaining.length === 0;
            const code = errorCode(err);
            const categoryTag = category ? ` category=${category}` : "";
            const codeTag = code ? ` code=${code}` : "";

            if (!transient || exhausted) {
                if (opts.swallow) {
                    const reason = transient ? "transient retries exhausted" : "non-transient";
                    opts.log?.(
                        `[cms-retry]${categoryTag} ${opts.label} failed after ${attempt + 1}/${maxAttempts} attempt(s) ` +
                        `(${reason})${codeTag}; swallowing: ${err?.message ?? err}`,
                    );
                    return undefined;
                }
                opts.log?.(
                    `[cms-retry]${categoryTag} ${opts.label} giving up after ${attempt + 1}/${maxAttempts} attempt(s) ` +
                    `(${transient ? "transient retries exhausted" : "non-transient"})${codeTag}: ${err?.message ?? err}`,
                );
                throw err;
            }

            const delay = jitter(remaining[0]);
            opts.log?.(
                `[cms-retry]${categoryTag} ${opts.label} transient failure (attempt ${attempt + 1}/${maxAttempts}), ` +
                `retrying in ${delay}ms${codeTag}: ${err?.message ?? err}`,
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
