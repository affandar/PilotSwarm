import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PgSessionCatalog } from "../../dist/index.js";

const databaseUrl = process.env.DATABASE_URL;
const catalogUrl = process.env.PILOTSWARM_CMS_FACTS_DATABASE_URL || databaseUrl;
const useManagedIdentity = ["1", "true", "yes", "on"].includes(
    (process.env.PILOTSWARM_USE_MANAGED_IDENTITY || "").trim().toLowerCase(),
);
const aadUser = process.env.PILOTSWARM_DB_AAD_USER || process.env.PILOTSWARM_AAD_DB_USER;

test("Postgres JobGenerator reconciliation is exactly-once and retains session history", {
    skip: !catalogUrl,
    timeout: 120_000,
}, async () => {
    const schema = `jobgen_${randomUUID().replaceAll("-", "")}`;
    const catalog = await PgSessionCatalog.create(catalogUrl, schema, {
        useManagedIdentity,
        aadUser,
    });
    try {
        await catalog.initialize();
        const created = await catalog.createJobGenerator({
            name: "integration",
            owner: { provider: "test", subject: "owner" },
            cadenceSeconds: 60,
            definition: {
                sourceType: "test-source",
                sourceConfig: { filter: "sample-records" },
            },
        });
        const { generator, definition } = created;
        assert.equal(definition.version, 1);
        assert.equal(generator.activeDefinitionId, definition.definitionId);
        assert.equal((await catalog.listJobGenerators({ provider: "test", subject: "owner" })).length, 1);
        assert.equal((await catalog.listJobGenerators({ provider: "test", subject: "other" })).length, 0);

        const claimed = await catalog.claimDueJobGenerators("worker-1", 1, 60);
        assert.equal(claimed.length, 1);
        const { cycle } = await catalog.beginJobGeneratorCycle(generator.generatorId, "worker-1");
        const first = await catalog.reconcileJobGeneratorDiscoveries(cycle.cycleId, [
            { key: "source-record-42", payload: { id: 42 } },
        ]);
        const retry = await catalog.reconcileJobGeneratorDiscoveries(cycle.cycleId, [
            { key: "source-record-42", payload: { id: 42, revision: 2 } },
        ]);
        assert.equal(first[0].created, true);
        assert.equal(first[0].definitionId, definition.definitionId);
        assert.equal(retry[0].created, false);
        assert.equal(retry[0].jobId, first[0].jobId);
        assert.equal(retry[0].sourcePayload.revision, 2);

        const reserved = await catalog.reserveJobSession(first[0].jobId, cycle.cycleId, "worker-1", "session-1");
        const repeatedReservation = await catalog.reserveJobSession(
            first[0].jobId,
            cycle.cycleId,
            "worker-1",
            "session-other",
        );
        assert.equal(repeatedReservation.sessionId, reserved.sessionId);
        const stateRuns = await catalog.listJobStateRuns(first[0].jobId);
        assert.equal(stateRuns.length, 1);
        assert.equal(stateRuns[0].stateName, "Initial");
        assert.equal(stateRuns[0].stateRevision, 1);
        assert.equal(stateRuns[0].sessionId, reserved.sessionId);
        await catalog.attachJobSession(first[0].jobId, reserved.sessionId, cycle.cycleId, "worker-1");
        assert.equal((await catalog.listJobSessions(first[0].jobId))[0].status, "unacked");
        await catalog.acknowledgeJobSession(reserved.sessionId);
        assert.equal((await catalog.listJobSessions(first[0].jobId))[0].status, "active");
        await catalog.replaceJobSession(first[0].jobId, "session-2");
        const history = await catalog.listJobSessions(first[0].jobId);
        assert.deepEqual(history.map((entry) => entry.sessionId), ["session-1", "session-2"]);
        assert.equal(history.filter((entry) => entry.isCurrent).length, 1);
        assert.equal(history[0].status, "replaced");

        await catalog.completeJobGeneratorCycle({
            cycleId: cycle.cycleId,
            workerId: "worker-1",
            status: "succeeded",
            watermark: "next",
            discoveredCount: 1,
            createdCount: 1,
        });
        const aggregate = (await catalog.listJobGenerators())[0];
        assert.equal(aggregate.materializedJobs, 1);
        assert.equal(aggregate.watermark, "next");
    } finally {
        await catalog.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await catalog.close();
    }
});

test("Postgres Job cleanup is owner-scoped, idempotent, and fenced from stale work", {
    skip: !catalogUrl,
    timeout: 120_000,
}, async () => {
    const schema = `jobcleanup_${randomUUID().replaceAll("-", "")}`;
    const catalog = await PgSessionCatalog.create(catalogUrl, schema, {
        useManagedIdentity,
        aadUser,
    });
    const owner = { provider: "test", subject: "owner", displayName: "Owner" };
    try {
        await catalog.initialize();
        await catalog.createSession("tree-root");
        await catalog.createSession("tree-child", { parentSessionId: "tree-root" });
        await catalog.beginSessionTreeDeletion("tree-root");
        assert.equal(await catalog.isSessionActive("tree-root"), false);
        assert.deepEqual(
            await catalog.getDescendantSessionIdsIncludingDeleted("tree-root"),
            ["tree-child"],
        );
        await assert.rejects(
            catalog.createSession("tree-late-child", { parentSessionId: "tree-root" }),
            /fenced for deletion/,
        );

        const { generator } = await catalog.createJobGenerator({
            name: "cleanup",
            owner,
            cadenceSeconds: 60,
            definition: {
                sourceType: "test-source",
                sourceConfig: { filter: "sample-records" },
            },
        });
        await catalog.claimDueJobGenerators("worker-1", 1, 60);
        const { cycle } = await catalog.beginJobGeneratorCycle(generator.generatorId, "worker-1");
        const jobs = await catalog.reconcileJobGeneratorDiscoveries(cycle.cycleId, [
            { key: "delete-me", payload: { id: 1 } },
            { key: "keep-me", payload: { id: 2 } },
        ]);
        const deletedJob = jobs.find((job) => job.jobKey === "delete-me");
        assert.ok(deletedJob);
        await catalog.reserveJobSession(deletedJob.jobId, cycle.cycleId, "worker-1", "session-delete");

        await assert.rejects(
            catalog.beginJobCleanup({
                jobId: deletedJob.jobId,
                actor: { provider: "test", subject: "other" },
            }),
            (error) => error.code === "NOT_FOUND",
        );

        const jobPlan = await catalog.beginJobCleanup({ jobId: deletedJob.jobId, actor: owner });
        assert.equal(jobPlan.alreadyDeleted, false);
        assert.deepEqual(jobPlan.sessionIds, ["session-delete"]);
        assert.deepEqual(
            await catalog.recordJobCleanupSessions(
                "job",
                deletedJob.jobId,
                ["session-delete", "session-child"],
            ),
            ["session-child", "session-delete"],
        );
        assert.deepEqual(
            (await catalog.listJobGeneratorJobs(generator.generatorId)).map((job) => job.jobKey),
            ["keep-me"],
        );
        assert.equal((await catalog.getJob(deletedJob.jobId, true)).lifecycleState, "cancelled");
        await assert.rejects(
            catalog.replaceJobSession(deletedJob.jobId, "session-stale"),
            /Job is terminal/,
        );
        assert.deepEqual(
            await catalog.reconcileJobGeneratorDiscoveries(cycle.cycleId, [
                { key: "delete-me", payload: { id: 1, stale: true } },
            ]),
            [],
        );
        await catalog.completeJobCleanup("job", deletedJob.jobId, {
            status: "completed",
            deletedSessionCount: 1,
        });

        const repeatedJobPlan = await catalog.beginJobCleanup({ jobId: deletedJob.jobId, actor: owner });
        assert.equal(repeatedJobPlan.alreadyDeleted, true);
        assert.deepEqual(repeatedJobPlan.sessionIds, ["session-child", "session-delete"]);
        await catalog.completeJobCleanup("job", deletedJob.jobId, {
            status: "failed",
            error: "late concurrent failure",
        });
        const tombstone = await catalog.pool.query(
            `SELECT cleanup_status, cleanup_error
             FROM "${schema}".job_cleanup_tombstones
             WHERE aggregate_type = 'job' AND aggregate_id = $1`,
            [deletedJob.jobId],
        );
        assert.equal(tombstone.rows[0].cleanup_status, "completed");
        assert.equal(tombstone.rows[0].cleanup_error, null);

        const generatorPlan = await catalog.beginJobGeneratorCleanup({
            generatorId: generator.generatorId,
            actor: owner,
        });
        assert.equal(generatorPlan.alreadyDeleted, false);
        assert.equal((await catalog.listJobGenerators()).length, 0);
        assert.equal((await catalog.listJobGeneratorJobs(generator.generatorId)).length, 0);
        assert.equal((await catalog.claimDueJobGenerators("worker-2", 1, 60)).length, 0);
        await assert.rejects(
            catalog.registerJobGenerator({
                generatorId: generator.generatorId,
                name: "resurrected",
                owner,
                cadenceSeconds: 60,
            }),
            /JOB_GENERATOR_DELETED/,
        );

        const replacement = await catalog.createJobGenerator({
            name: "cleanup",
            owner,
            cadenceSeconds: 60,
            definition: {
                sourceType: "test-source",
                sourceConfig: { filter: "sample-records" },
            },
        });
        assert.notEqual(replacement.generator.generatorId, generator.generatorId);
    } finally {
        await catalog.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await catalog.close();
    }
});
