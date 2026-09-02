/**
 * Always-safe diagnostics helpers for poison / latency forensics.
 *
 * Tracing a poisoned session historically meant hand-decoding duroxide
 * `history.event_data` JSON just to answer the first three questions of any
 * investigation: which process ran the turn, which duroxide build it was, and
 * whether the commit was slow enough to blow the queue lease (the seed of
 * poison). Surfacing that context as plain, always-on log lines turns a
 * multi-hour PG spelunk into a `grep`.
 *
 * Everything here is best-effort and never throws: diagnostics must not be
 * able to break a worker boot or a turn.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// duroxide is CommonJS; the SDK is ESM. Resolve it through a scoped require.
const require = createRequire(import.meta.url);

let _duroxideVersion: string | undefined;

/**
 * Version of the installed `duroxide` package this process is running.
 * Fleet/local version drift is invisible in duroxide's own logs, so we read
 * it once from the package metadata. Never throws — returns "unknown" if the
 * metadata can't be located.
 */
export function duroxideVersion(): string {
    if (_duroxideVersion !== undefined) return _duroxideVersion;
    try {
        _duroxideVersion = String(require("duroxide/package.json").version ?? "unknown");
        return _duroxideVersion;
    } catch {
        // A package `exports` map can hide package.json; fall back to resolving
        // the entry point and walking up to duroxide's own package.json.
        try {
            let dir = path.dirname(require.resolve("duroxide"));
            for (let i = 0; i < 8; i++) {
                const pj = path.join(dir, "package.json");
                if (fs.existsSync(pj)) {
                    const parsed = JSON.parse(fs.readFileSync(pj, "utf8"));
                    if (parsed?.name === "duroxide" && parsed?.version) {
                        _duroxideVersion = String(parsed.version);
                        return _duroxideVersion;
                    }
                }
                const parent = path.dirname(dir);
                if (parent === dir) break;
                dir = parent;
            }
        } catch {
            /* fall through to "unknown" */
        }
    }
    _duroxideVersion = "unknown";
    return _duroxideVersion;
}

/**
 * Stable identity of this worker/client process, stamped into diagnostic
 * banners so a poisoned session can be traced back to the exact process,
 * host and duroxide build that produced it.
 */
export function processIdentity(extra?: Record<string, unknown>): Record<string, unknown> {
    return {
        pid: process.pid,
        host: os.hostname(),
        duroxideVersion: duroxideVersion(),
        ...(extra ?? {}),
    };
}

// Bounded set so a long-lived worker doesn't leak; poison is rare, so the cap
// is generous and a full clear (rather than LRU) is acceptable.
const _loggedPoison = new Set<string>();
const POISON_LOG_CAP = 10_000;

/**
 * Log — exactly once per session — the moment a session is surfaced as
 * poisoned (or otherwise redelivery-exhausted), stamped with the process
 * identity and duroxide build. This is the breadcrumb that ties a CMS
 * `last_error` poison string back to the process/version that produced it,
 * without decoding duroxide history.
 */
export function logPoisonOnce(
    sessionId: string,
    failureMessage: string | null | undefined,
    source: string,
): void {
    if (!failureMessage) return;
    if (!/poison|exceeded \d+ attempts/i.test(failureMessage)) return;
    if (_loggedPoison.has(sessionId)) return;
    if (_loggedPoison.size >= POISON_LOG_CAP) _loggedPoison.clear();
    _loggedPoison.add(sessionId);
    console.warn(
        `[${source}] session surfaced as POISONED ` + JSON.stringify(processIdentity({
            session: sessionId,
            error: failureMessage,
        })),
    );
}
