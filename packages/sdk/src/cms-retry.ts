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
 * - `cmsRetryBestEffort`: 3 retries at 1s / 4s / 12s (4 total attempts).
 *   For non-flow-critical writes (event log entries, etc.). A single short
 *   retry is not enough to ride out a connection storm — when `max_connections`
 *   is momentarily exhausted (many worker pods contending for the same server),
 *   the pool keeps failing to acquire for several seconds, and dropping the
 *   write silently loses observability events (e.g. `tool.execution_complete`,
 *   which the streaming client depends on). The short exponential ladder gives
 *   the storm time to clear while still bounding the added post-turn latency.
 *   On exhaustion or non-transient error, logs and returns `undefined` instead
 *   of throwing. Callers that don't care about the return value can ignore it.
 *
 * All delays carry ±20% jitter so that a fleet of pods that hit the same
 * connection ceiling at the same moment does not retry in lockstep (a
 * thundering herd that would keep the server saturated).
 *
 * Only PostgreSQL transient errors trigger a retry. Constraint violations,
 * syntax errors, and other deterministic failures propagate immediately —
 * retrying those just delays the inevitable.
 */

const CRITICAL_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 90_000];
const BEST_EFFORT_RETRY_DELAYS_MS = [1_000, 4_000, 12_000];

/** ±20% multiplicative jitter to de-correlate retries across pods. */
const RETRY_JITTER_FRACTION = 0.2;

function jitter(delayMs: number): number {
    const spread = delayMs * RETRY_JITTER_FRACTION;
    return Math.max(0, Math.round(delayMs + (Math.random() * 2 - 1) * spread));
}

/**
 * Transient error taxonomy.
 *
 * Every retryable failure is grouped into exactly one CATEGORY. A category is a
 * generic bucket — `{ tag, sqlStates, networkCodes, messagePatterns }` — so new
 * kinds of transient (e.g. a future rate-limit or replica-lag class) are added
 * by appending one row here, with no change to the retry loop or the callers.
 *
 * The category `tag` is surfaced in the retry logs (`category=<tag>`), so
 * connection-slot exhaustion is analyzable/alertable on its own WITHOUT being a
 * separate code path — it is simply the `connection_saturation` bucket. Anything
 * not covered by a category is non-transient and propagates immediately.
 *
 * SQLSTATE references (postgres docs):
 *   08xxx — connection exception family
 *   40001 — serialization failure (could not serialize access due to concurrent update)
 *   40P01 — deadlock detected
 *   53300 — too many connections   53400 — configuration limit exceeded
 *   57014 — query canceled (e.g. statement_timeout)
 *   57P01/02/03 — admin shutdown / crash shutdown / cannot connect now
 */
interface TransientCategory {
    /** Stable, greppable identifier surfaced in logs as `category=<tag>`. */
    readonly tag: string;
    /** PostgreSQL SQLSTATEs in this bucket. */
    readonly sqlStates?: ReadonlySet<string>;
    /** node-pg / libuv network error codes (also carried on `err.code`). */
    readonly networkCodes?: ReadonlySet<string>;
    /**
     * Message shapes for CODELESS variants only. These are matched solely when
     * the error has no structured `code` (see `classifyCmsError`). Keep them
     * tight — broad matchers catch natural pool teardown during shutdown, and
     * retrying a deliberately-closed pool just delays the inevitable.
     */
    readonly messagePatterns?: readonly RegExp[];
}

const TRANSIENT_CATEGORIES: readonly TransientCategory[] = [
    {
        // Server `max_connections` reached, or the pool cannot hand out a client.
        // A fleet of contending worker pods produces this when the limit is too
        // low; alert on `category=connection_saturation` to raise the limit /
        // shrink the per-pod pool rather than chasing it as a generic blip.
        tag: "connection_saturation",
        sqlStates: new Set(["53300", "53400"]),
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
    { tag: "serialization_failure", sqlStates: new Set(["40001"]) },
    { tag: "deadlock_detected", sqlStates: new Set(["40P01"]) },
    { tag: "query_canceled", sqlStates: new Set(["57014"]) },
    // admin shutdown / crash shutdown / cannot connect now (starting/stopping)
    { tag: "server_unavailable", sqlStates: new Set(["57P01", "57P02", "57P03"]) },
];

/** Extract the SQLSTATE / network `code` from a pg error, if present. */
function cmsErrorCode(err: unknown): string | undefined {
    if (!err || typeof err !== "object") return undefined;
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
}

/**
 * Classify `err` into a transient CATEGORY tag, or `undefined` if it is not a
 * retryable transient.
 *
 * If the error has a structured `code`, the code is the verdict — we do NOT fall
 * through to the message patterns. Otherwise a non-transient SQLSTATE (e.g. a
 * constraint violation whose message happens to contain "connection") would be
 * retried. Message patterns therefore apply only to codeless errors.
 */
export function classifyCmsError(err: unknown): string | undefined {
    if (!err || typeof err !== "object") return undefined;
    const code = cmsErrorCode(err);
    if (code) {
        for (const cat of TRANSIENT_CATEGORIES) {
            if (cat.sqlStates?.has(code) || cat.networkCodes?.has(code)) return cat.tag;
        }
        return undefined;
    }
    const message = typeof (err as { message?: unknown }).message === "string"
        ? (err as { message: string }).message
        : "";
    for (const cat of TRANSIENT_CATEGORIES) {
        if (cat.messagePatterns?.some((re) => re.test(message))) return cat.tag;
    }
    return undefined;
}

/** Returns true if `err` looks like a retryable PG transient (any category). */
export function isTransientCmsError(err: unknown): boolean {
    return classifyCmsError(err) !== undefined;
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
            const code = cmsErrorCode(err);
            const codeTag = code ? ` sqlstate=${code}` : "";
            // Generic, greppable category marker so any transient bucket (today:
            // connection_saturation, connection_exception, serialization_failure,
            // deadlock_detected, query_canceled, server_unavailable) can be
            // analyzed/alerted on its own without a bespoke code path.
            const catTag = category ? ` [category=${category}]` : "";

            if (!transient || exhausted) {
                if (opts.swallow) {
                    const reason = transient ? "transient retries exhausted" : "non-transient";
                    opts.log?.(
                        `[cms-retry]${catTag} ${opts.label} failed after ${attempt + 1}/${maxAttempts} attempt(s) ` +
                        `(${reason})${codeTag}; swallowing: ${err?.message ?? err}`,
                    );
                    return undefined;
                }
                opts.log?.(
                    `[cms-retry]${catTag} ${opts.label} giving up after ${attempt + 1}/${maxAttempts} attempt(s) ` +
                    `(${transient ? "transient retries exhausted" : "non-transient"})${codeTag}: ${err?.message ?? err}`,
                );
                throw err;
            }

            const delay = jitter(remaining[0]);
            opts.log?.(
                `[cms-retry]${catTag} ${opts.label} transient failure (attempt ${attempt + 1}/${maxAttempts}), ` +
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
