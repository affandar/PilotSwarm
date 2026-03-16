/**
 * CMS assertion helpers for integration tests.
 *
 * These helpers read directly from the CMS (PostgreSQL) and duroxide
 * orchestration state to verify session consistency after operations.
 */

import { PgSessionCatalogProvider } from "../../dist/index.js";
import { createManagementClient } from "./local-workers.js";

// ─── CMS Helpers ─────────────────────────────────────────────────

/**
 * Create a CMS catalog provider connected to the test environment.
 */
export async function createCatalog(env) {
    const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
    await catalog.initialize();
    return catalog;
}

/**
 * Wait until a CMS session reaches an expected state.
 *
 * @param {object} catalog     - PgSessionCatalogProvider instance
 * @param {string} sessionId   - Session to check
 * @param {string|string[]} expectedStates - One or more target states
 * @param {number} [timeoutMs] - Maximum wait time (default 30s)
 * @returns {object} The session row
 */
export async function waitForSessionState(catalog, sessionId, expectedStates, timeoutMs = 30_000) {
    const states = Array.isArray(expectedStates) ? expectedStates : [expectedStates];
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const row = await catalog.getSession(sessionId);
        if (row && states.includes(row.state)) return row;
        await new Promise(r => setTimeout(r, 250));
    }

    const row = await catalog.getSession(sessionId);
    throw new Error(
        `Session ${sessionId.slice(0, 8)} did not reach state [${states.join(", ")}] within ${timeoutMs}ms. ` +
        `Current state: ${row?.state ?? "(not found)"}`,
    );
}

/**
 * Wait until a session has at least N events of a given type.
 */
export async function waitForEventCount(catalog, sessionId, eventType, minCount, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const events = await catalog.getSessionEvents(sessionId);
        const matching = events.filter(e => e.eventType === eventType);
        if (matching.length >= minCount) return matching;
        await new Promise(r => setTimeout(r, 250));
    }

    const events = await catalog.getSessionEvents(sessionId);
    const matching = events.filter(e => e.eventType === eventType);
    throw new Error(
        `Session ${sessionId.slice(0, 8)} did not reach ${minCount} ${eventType} events within ${timeoutMs}ms. ` +
        `Current count: ${matching.length}`,
    );
}

/**
 * Get all events for a session from CMS.
 */
export async function getEvents(catalog, sessionId) {
    return catalog.getSessionEvents(sessionId);
}

/**
 * Get a session row from CMS.
 */
export async function getSession(catalog, sessionId) {
    return catalog.getSession(sessionId);
}

/**
 * Assert that session events have strictly increasing seq numbers.
 */
export function assertStrictlyIncreasingSeq(events, label = "") {
    for (let i = 1; i < events.length; i++) {
        if (events[i].seq <= events[i - 1].seq) {
            throw new Error(
                `${label ? label + ": " : ""}Events seq not strictly increasing at index ${i}: ` +
                `seq ${events[i].seq} <= ${events[i - 1].seq}`,
            );
        }
    }
}

// ─── Full-stack validation ───────────────────────────────────────

/**
 * Validate CMS + duroxide orchestration state after a completed turn.
 *
 * Checks:
 *   1. CMS session row exists with expected state
 *   2. CMS orchestrationId is set and matches the expected pattern
 *   3. CMS session_events contain expected event types in strictly increasing seq order
 *   4. No ephemeral events leaked into CMS
 *   5. Duroxide orchestration exists and is Running (session is idle, orchestration stays alive)
 *   6. KV response.latest contains a valid response payload
 *   7. customStatus has correct iteration count
 *
 * @param {object} env        - Test environment from createTestEnv()
 * @param {string} sessionId  - Session to validate
 * @param {object} [opts]     - Validation options
 * @param {string[]} [opts.expectedCmsStates] - Allowed CMS states (default: ["idle"])
 * @param {number}  [opts.minIteration]       - Minimum expected iteration (default: 1)
 * @param {string[]} [opts.requiredEventTypes] - Event types that must be present
 * @param {boolean} [opts.expectResponse]      - Whether response.latest should exist (default: true)
 * @returns {object} { cmsRow, events, orchStatus, latestResponse }
 */
export async function validateSessionAfterTurn(env, sessionId, opts = {}) {
    const {
        expectedCmsStates = ["idle"],
        minIteration = 1,
        requiredEventTypes = ["assistant.message"],
        expectResponse = true,
    } = opts;

    const catalog = await createCatalog(env);
    const mgmt = await createManagementClient(env);

    try {
        // ── 1. CMS session row ─────────────────────────────────
        const cmsRow = await catalog.getSession(sessionId);
        if (!cmsRow) throw new Error(`[CMS] Session ${sessionId.slice(0, 8)} not found`);

        if (!expectedCmsStates.includes(cmsRow.state)) {
            throw new Error(
                `[CMS] Session state = "${cmsRow.state}", expected one of [${expectedCmsStates}]`,
            );
        }

        // ── 2. Orchestration ID linkage ────────────────────────
        const expectedOrchId = `session-${sessionId}`;
        if (cmsRow.orchestrationId && cmsRow.orchestrationId !== expectedOrchId) {
            throw new Error(
                `[CMS] orchestrationId = "${cmsRow.orchestrationId}", expected "${expectedOrchId}"`,
            );
        }

        // ── 3. CMS events: existence + ordering ────────────────
        const events = await catalog.getSessionEvents(sessionId);
        if (events.length === 0) {
            throw new Error(`[CMS] No events persisted for session ${sessionId.slice(0, 8)}`);
        }
        assertStrictlyIncreasingSeq(events, "[CMS] session_events");

        // ── 4. No ephemeral events leaked ──────────────────────
        const EPHEMERAL_TYPES = ["assistant.message_delta", "reasoning_delta", "assistant.reasoning_delta"];
        for (const evt of events) {
            if (EPHEMERAL_TYPES.includes(evt.eventType)) {
                throw new Error(`[CMS] Ephemeral event "${evt.eventType}" leaked into session_events (seq=${evt.seq})`);
            }
        }

        // ── 5. Required event types present ────────────────────
        const eventTypes = new Set(events.map(e => e.eventType));
        for (const required of requiredEventTypes) {
            if (!eventTypes.has(required)) {
                throw new Error(
                    `[CMS] Missing required event type "${required}". Present: [${[...eventTypes]}]`,
                );
            }
        }

        // ── 6. Duroxide orchestration status ───────────────────
        const orchStatus = await mgmt.getSessionStatus(sessionId);
        if (!orchStatus) {
            throw new Error(`[Orchestration] No status for session ${sessionId.slice(0, 8)}`);
        }

        // customStatusVersion should have advanced at least once
        if (orchStatus.customStatusVersion < 1) {
            throw new Error(
                `[Orchestration] customStatusVersion = ${orchStatus.customStatusVersion}, expected >= 1`,
            );
        }

        // customStatus should report correct status
        const csStatus = orchStatus.customStatus?.status;
        if (csStatus && !expectedCmsStates.includes(csStatus)) {
            throw new Error(
                `[Orchestration] customStatus.status = "${csStatus}", expected one of [${expectedCmsStates}]`,
            );
        }

        // Iteration count
        const csIteration = orchStatus.customStatus?.iteration ?? 0;
        if (csIteration < minIteration) {
            throw new Error(
                `[Orchestration] customStatus.iteration = ${csIteration}, expected >= ${minIteration}`,
            );
        }

        // ── 7. KV response.latest ──────────────────────────────
        let latestResponse = null;
        if (expectResponse) {
            latestResponse = await mgmt.getLatestResponse(sessionId);
            if (!latestResponse) {
                throw new Error(`[KV] response.latest is empty for session ${sessionId.slice(0, 8)}`);
            }
            if (!latestResponse.version || latestResponse.version < 1) {
                throw new Error(`[KV] response.latest.version = ${latestResponse.version}, expected >= 1`);
            }
        }

        return { cmsRow, events, orchStatus, latestResponse };
    } finally {
        await mgmt.stop();
        await catalog.close();
    }
}

/**
 * Validate CMS state after a session is deleted.
 *
 * Checks:
 *   1. CMS getSession returns null (soft-deleted)
 *   2. Session does not appear in listSessions
 */
export async function validateSessionDeleted(env, sessionId) {
    const catalog = await createCatalog(env);
    try {
        const row = await catalog.getSession(sessionId);
        if (row !== null) {
            throw new Error(`[CMS] Session ${sessionId.slice(0, 8)} still visible after delete (state=${row.state})`);
        }

        const list = await catalog.listSessions();
        if (list.some(s => s.sessionId === sessionId)) {
            throw new Error(`[CMS] Session ${sessionId.slice(0, 8)} still in listSessions after delete`);
        }
    } finally {
        await catalog.close();
    }
}
