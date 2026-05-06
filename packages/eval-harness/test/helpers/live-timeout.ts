/**
 * Timeout helpers for LIVE eval-harness tests.
 *
 * Production-grade timeout discipline:
 *   - LIVE multi-cell tests (matrix / multi-trial / variant) compute their
 *     vitest per-`it` timeout from the actual planned cell count at test
 *     runtime, not a baked-in constant. This handles env-scaled tests like
 *     `LIVE_MATRIX_MODELS`, `LIVE_ABLATION_MODELS`, `PROMPT_TESTING_MODELS`,
 *     and `PROMPT_TESTING_TRIALS` without silently under-timeouting.
 *
 *   - The formula is:
 *
 *         timeout = (perCellTimeoutMs × cells) + setupHeadroomMs + slackMs
 *
 *     where:
 *       perCellTimeoutMs : the LiveDriver inner timeout (per-LLM-call cap)
 *       cells            : models × trials × samples × variants (whichever apply)
 *       setupHeadroomMs  : worker/client/env construction + teardown (default 60s)
 *       slackMs          : LLM jitter and runtime variance (default 30s)
 *
 *   - The function returns a number suitable for vitest's third arg to it():
 *         it("name", async () => { ... }, computeLiveTestTimeout({ ... }));
 */

export interface ComputeLiveTimeoutOptions {
    /** LiveDriver per-LLM-call timeout in ms (typically 240_000 or 300_000). */
    perCellTimeoutMs: number;
    /** Number of sequential cells the test will execute. */
    cells: number;
    /** Setup/teardown headroom (worker/client/env construct/destroy). Default 60s. */
    setupHeadroomMs?: number;
    /** Slack for LLM jitter / DB pressure. Default 30s. */
    slackMs?: number;
    /** Lower bound for timeout. Default 60s. */
    minTimeoutMs?: number;
}

const DEFAULT_SETUP_HEADROOM_MS = 60_000;
const DEFAULT_SLACK_MS = 30_000;
const DEFAULT_MIN_TIMEOUT_MS = 60_000;

/**
 * Compute a vitest per-`it` timeout for a LIVE test that runs N sequential
 * cells. Always returns a positive integer ≥ minTimeoutMs.
 */
export function computeLiveTestTimeout(opts: ComputeLiveTimeoutOptions): number {
    if (!Number.isFinite(opts.perCellTimeoutMs) || opts.perCellTimeoutMs <= 0) {
        throw new Error(`computeLiveTestTimeout: perCellTimeoutMs must be > 0, got ${opts.perCellTimeoutMs}`);
    }
    if (!Number.isFinite(opts.cells) || opts.cells <= 0 || !Number.isInteger(opts.cells)) {
        throw new Error(`computeLiveTestTimeout: cells must be a positive integer, got ${opts.cells}`);
    }
    const setupHeadroomMs = opts.setupHeadroomMs ?? DEFAULT_SETUP_HEADROOM_MS;
    const slackMs = opts.slackMs ?? DEFAULT_SLACK_MS;
    const minTimeoutMs = opts.minTimeoutMs ?? DEFAULT_MIN_TIMEOUT_MS;
    if (setupHeadroomMs < 0) {
        throw new Error(`computeLiveTestTimeout: setupHeadroomMs must be >= 0, got ${setupHeadroomMs}`);
    }
    if (slackMs < 0) {
        throw new Error(`computeLiveTestTimeout: slackMs must be >= 0, got ${slackMs}`);
    }
    const computed = (opts.perCellTimeoutMs * opts.cells) + setupHeadroomMs + slackMs;
    return Math.max(computed, minTimeoutMs);
}

/**
 * Parse a comma-separated env var into a non-empty string array, or fall
 * back to a default. Used for env vars like `LIVE_MATRIX_MODELS`,
 * `PROMPT_TESTING_MODELS` that scale the cell count.
 */
export function parseEnvList(envVarName: string, fallback: string[] = []): string[] {
    const raw = process.env[envVarName];
    if (!raw) return [...fallback];
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Hard caps on env-driven cell-count axes for LIVE matrix tests. A user
 * setting these env vars to absurd values (e.g. `LIVE_MATRIX_MODELS=20`)
 * almost certainly indicates a misconfigured CI run rather than an
 * intentional multi-hour LIVE budget. Validation here surfaces it loudly
 * so the test author can either lower the count or explicitly raise the
 * cap by editing the constant — never by silently expanding the timeout.
 */
export const LIVE_MAX_MODELS = 16;
export const LIVE_MAX_TRIALS = 10;

/**
 * Validate an env-derived cell-count axis against a documented hard cap.
 * Throws with an actionable message if exceeded.
 */
export function assertLiveAxisWithinCap(
    envVarName: string,
    value: number,
    cap: number,
): void {
    if (value > cap) {
        throw new Error(
            `${envVarName}=${value} exceeds the LIVE harness cap of ${cap}. ` +
            `Either lower the env value or raise the cap in test/helpers/live-timeout.ts ` +
            `intentionally — silently expanding LIVE timeouts hides cost regressions.`,
        );
    }
}

/**
 * Parse a non-negative integer env var with a default. Throws if the value
 * is provided but invalid (so a typo like `PROMPT_TESTING_TRIALS=foo` fails
 * loudly instead of silently falling back).
 */
export function parseEnvInt(envVarName: string, fallback: number): number {
    const raw = process.env[envVarName];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        throw new Error(`Invalid ${envVarName}=${raw} — expected non-negative integer.`);
    }
    return n;
}
