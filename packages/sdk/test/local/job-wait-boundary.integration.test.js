/**
 * Job wait-boundary resume integration tests (black-box).
 *
 * Regression coverage for the started-boundary strand bug: a job that parks on
 * an external-operation wait must eventually deliver its RESUME SIGNAL so the
 * worker can wake the job back up. Delivery is gated on the wait's
 * `wait_started_at` boundary being recorded; when the boundary was missed the
 * job stranded forever.
 *
 * Rather than reading internal columns, these tests drive the SAME public
 * catalog API a worker uses and observe the ONE externally meaningful outcome:
 * whether `claimJobExternalOperationSignals` hands back the operation's resume
 * signal. That is the observable that decides "does the parked job wake up?",
 * so it validates the fix behaviourally instead of trusting our internal
 * bookkeeping — a hacked implementation that stamps the wrong row would still
 * fail to make the signal claimable and would be caught here.
 *
 * End-to-end resume path exercised:
 *   startJobExternalOperation   (producer registers the wait, job parks)
 *     -> setJobSessionExecutionStatus('waiting')   (authoritative wait_started_at stamp)
 *     -> claimDueJobExternalOperations             (poller leases the operation)
 *     -> completeJobExternalOperation('succeeded') (external result satisfies the wait)
 *     -> claimJobExternalOperationSignals          (OBSERVABLE: resume signal delivered)
 *
 * The suite asserts:
 *   1. Happy path: a parked wait that is satisfied yields a claimable resume
 *      signal — the parked job wakes up.
 *   2. Negative control: an unparked wait (its `wait_started_at` never stamped)
 *      yields NO resume signal even after it is satisfied — this reproduces the
 *      strand and proves the happy-path assertion has teeth.
 *   3. Alternate stamp source: recording the best-effort started boundary EVENT
 *      also unblocks resume, so either stamp path independently wakes the job.
 *   4. No-throw contract: an unmatched started boundary returns false instead of
 *      throwing — a throw would fail the whole recordSessionEvent activity under
 *      cmsRetryCritical and strand the job anyway.
 */

import { describe, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assertEqual } from "../helpers/assertions.js";
import { PgSessionCatalogProvider } from "../../src/index.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

async function directQuery(env, sql, params = []) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: env.store });
    try {
        await client.connect();
        return await client.query(sql, params);
    } finally {
        try { await client.end(); } catch {}
    }
}

/**
 * Seed the minimal FK chain for an active, current job state run so that
 * catalog.startJobExternalOperation() can attach an observed-condition wait to
 * it exactly as production does. There is no public API to stand up a whole job
 * pipeline, so this fixture is unavoidable scaffolding; the ASSERTIONS below
 * stay black-box (public API only).
 *
 * @returns the ids of the seeded rows.
 */
async function seedActiveStateRun(env, {
    sessionId,
    stateName = "FixProposed",
    stateRevision = 2,
}) {
    const suffix = sessionId.replace(/[^a-z0-9]/gi, "").slice(0, 12);
    const ids = {
        generatorId: `gen-${suffix}`,
        definitionId: `def-${suffix}`,
        cycleId: `cyc-${suffix}`,
        jobId: `job-${suffix}`,
        stateRunId: `run-${suffix}`,
        associationId: `assoc-${suffix}`,
    };
    const s = env.cmsSchema;

    await directQuery(
        env,
        `INSERT INTO "${s}".job_generators (generator_id, name, owner_provider, owner_subject, cadence_seconds)
         VALUES ($1, 'wait-boundary-test', 'test', 'owner', 60)`,
        [ids.generatorId],
    );
    await directQuery(
        env,
        `INSERT INTO "${s}".job_generator_definitions (definition_id, generator_id, version, source_type)
         VALUES ($1, $2, 1, 'test-source')`,
        [ids.definitionId, ids.generatorId],
    );
    await directQuery(
        env,
        `INSERT INTO "${s}".job_generator_cycles (cycle_id, generator_id, definition_id, claimed_by)
         VALUES ($1, $2, $3, 'worker-test')`,
        [ids.cycleId, ids.generatorId, ids.definitionId],
    );
    await directQuery(
        env,
        `INSERT INTO "${s}".jobs (
             job_id, generator_id, definition_id, job_key,
             first_seen_cycle_id, last_seen_cycle_id,
             lifecycle_state, current_state, state_revision
         )
         VALUES ($1, $2, $3, $4, $5, $5, 'active', $6, $7)`,
        [ids.jobId, ids.generatorId, ids.definitionId, `key-${suffix}`, ids.cycleId, stateName, stateRevision],
    );
    await directQuery(
        env,
        `INSERT INTO "${s}".job_state_runs (
             state_run_id, job_id, definition_id, state_name, state_revision, status, session_id
         )
         VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
        [ids.stateRunId, ids.jobId, ids.definitionId, stateName, stateRevision, sessionId],
    );
    await directQuery(
        env,
        `INSERT INTO "${s}".job_sessions (
             association_id, job_id, session_id, ordinal, is_current, status, state_run_id
         )
         VALUES ($1, $2, $3, 1, TRUE, 'active', $4)`,
        [ids.associationId, ids.jobId, sessionId, ids.stateRunId],
    );

    return ids;
}

/**
 * Drive the poll-and-complete leg a worker performs against an external
 * operation: acquire the poll lease, then report the external result that
 * satisfies the wait. Public API only.
 */
async function pollAndComplete(catalog, workerId, operationId) {
    const leased = await catalog.claimDueJobExternalOperations("ado", workerId, 25, 60);
    assertEqual(
        leased.some((row) => row.operationId === operationId),
        true,
        "the freshly started operation must be immediately poll-claimable",
    );
    await catalog.completeJobExternalOperation({
        operationId,
        workerId,
        status: "succeeded",
        result: { buildId: "12345", outcome: "succeeded" },
        evidence: { url: "https://example.test/build/12345" },
    });
}

/** True iff the operation's resume signal is deliverable (the job would wake). */
async function resumeSignalClaimable(catalog, workerId, operationId) {
    const signals = await catalog.claimJobExternalOperationSignals(workerId, 25, 30);
    return signals.some((row) => row.operationId === operationId);
}

describe("Job wait boundary resume", () => {
    it("delivers a resume signal for a parked wait once it is satisfied", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        const sessionId = "sess-resume-happy";

        try {
            await catalog.initialize();
            await seedActiveStateRun(env, { sessionId, stateName: "FixProposed", stateRevision: 2 });

            const op = await catalog.startJobExternalOperation({
                sessionId,
                provider: "ado",
                kind: "build",
                operationKey: "default",
                detectionMode: "poll",
            });

            // The session durably parks: this is the authoritative wait_started_at
            // stamp that makes the eventual resume signal deliverable.
            await catalog.setJobSessionExecutionStatus(sessionId, "waiting");

            // A poller observes the external result and satisfies the wait.
            await pollAndComplete(catalog, "worker-poll", op.operationId);

            const claimable = await resumeSignalClaimable(catalog, "worker-signal", op.operationId);
            assertEqual(claimable, true, "a parked, satisfied wait must yield a claimable resume signal");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("never delivers a resume signal for a wait that never recorded its start (strand)", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        const sessionId = "sess-resume-strand";

        try {
            await catalog.initialize();
            await seedActiveStateRun(env, { sessionId, stateName: "FixProposed", stateRevision: 2 });

            const op = await catalog.startJobExternalOperation({
                sessionId,
                provider: "ado",
                kind: "build",
                operationKey: "default",
                detectionMode: "poll",
            });

            // Reproduce the strand: the session never records its wait start
            // (no park, no boundary event), so wait_started_at stays NULL. The
            // wait is still satisfied by the poller...
            await pollAndComplete(catalog, "worker-poll", op.operationId);

            // ...but the resume signal must NOT be claimable — the job would
            // strand. This is the negative control: it proves the happy-path
            // assertion is not trivially always true.
            const claimable = await resumeSignalClaimable(catalog, "worker-signal", op.operationId);
            assertEqual(claimable, false, "an unstarted wait must never yield a resume signal");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("delivers a resume signal when only the best-effort started boundary was recorded", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        const sessionId = "sess-resume-event";

        try {
            await catalog.initialize();
            await seedActiveStateRun(env, { sessionId, stateName: "FixProposed", stateRevision: 2 });

            const op = await catalog.startJobExternalOperation({
                sessionId,
                provider: "ado",
                kind: "build",
                operationKey: "default",
                detectionMode: "poll",
            });

            // Do NOT park. Instead record the best-effort started boundary event
            // (the session.system_wait_started path). It must independently
            // unblock resume, so either stamp source wakes the job.
            const matched = await catalog.recordJobWaitBoundary(sessionId, op.signalKey, "started");
            assertEqual(matched, true, "the started boundary should match its own wait by identity");

            await pollAndComplete(catalog, "worker-poll", op.operationId);

            const claimable = await resumeSignalClaimable(catalog, "worker-signal", op.operationId);
            assertEqual(claimable, true, "a recorded started boundary must also yield a claimable resume signal");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("returns false without throwing for a started boundary that can never match", async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        const sessionId = "sess-started-nomatch";

        try {
            await catalog.initialize();
            await seedActiveStateRun(env, { sessionId, stateName: "FixProposed", stateRevision: 2 });
            await catalog.startJobExternalOperation({
                sessionId,
                provider: "ado",
                kind: "build",
                operationKey: "default",
                detectionMode: "poll",
            });

            // A signal key that matches no wait row simulates the boundary event
            // racing ahead of (or diverging from) the wait row. It must return
            // false — NOT throw — because recordJobExternalOperationWait runs
            // under cmsRetryCritical (no retry on non-transient errors); a throw
            // would fail the whole recordSessionEvent activity and drop the batch.
            const matched = await catalog.recordJobWaitBoundary(
                sessionId,
                "signal-that-never-appears",
                "started",
            );
            assertEqual(matched, false, "unmatched started boundary must return false, not throw");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);
});
