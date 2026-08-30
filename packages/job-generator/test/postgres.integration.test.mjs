import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PgSessionCatalog } from "pilotswarm-sdk";
import { JobGeneratorController } from "../dist/controller.js";

const databaseUrl = process.env.DATABASE_URL;
const catalogUrl = process.env.PILOTSWARM_CMS_FACTS_DATABASE_URL || databaseUrl;
const useManagedIdentity = ["1", "true", "yes", "on"].includes(
    (process.env.PILOTSWARM_USE_MANAGED_IDENTITY || "").trim().toLowerCase(),
);
const aadUser = process.env.PILOTSWARM_DB_AAD_USER || process.env.PILOTSWARM_AAD_DB_USER;

test("controller materialization and durable Job lifecycle transitions", {
    skip: !catalogUrl,
    timeout: 180_000,
}, async () => {
    const schema = `jobgen_controller_${randomUUID().replaceAll("-", "")}`;
    const catalog = await PgSessionCatalog.create(catalogUrl, schema, {
        useManagedIdentity,
        aadUser,
    });
    try {
        await catalog.initialize();
        const registrations = await Promise.all([
            catalog.createJobGenerator({
                name: "first-owner-generator",
                owner: { provider: "test", subject: "owner-a" },
                cadenceSeconds: 60,
                definition: {
                    sourceType: "kusto",
                    sourceConfig: { query: "SourceRecords | take 10" },
                },
            }),
            catalog.createJobGenerator({
                name: "second-owner-generator",
                owner: { provider: "test", subject: "owner-b" },
                cadenceSeconds: 60,
                definition: {
                    sourceType: "kusto",
                    sourceConfig: { query: "SourceRecords | take 10" },
                },
            }),
        ]);
        const abort = new AbortController();
        let evaluationCount = 0;
        const controller = new JobGeneratorController({
            store: catalog,
            evaluators: new Map([["kusto", {
                type: "kusto",
                async evaluate({ generator }) {
                    evaluationCount += 1;
                    if (evaluationCount === registrations.length) abort.abort();
                    return {
                        discoveries: [{
                            key: `record-${generator.owner.subject}`,
                            payload: { owner: generator.owner.subject },
                        }],
                        watermark: { completed: true },
                    };
                },
            }]]),
            workerId: "integration-controller",
            induceSessions: false,
        });

        await controller.run(abort.signal);
        assert.equal(evaluationCount, 2);
        for (const { generator } of registrations) {
            const jobs = await catalog.listJobGeneratorJobs(generator.generatorId);
            assert.equal(jobs.length, 1);
            assert.equal(jobs[0].sourcePayload.owner, generator.owner.subject);
            const cycles = await catalog.listJobGeneratorCycles(generator.generatorId);
            assert.equal(cycles.length, 1);
            assert.equal(cycles[0].status, "succeeded");
        }

        const lifecycleRegistration = await catalog.createJobGenerator({
            name: "lifecycle-generator",
            owner: { provider: "test", subject: "lifecycle-owner" },
            cadenceSeconds: 60,
            definition: {
                sourceType: "kusto",
                sourceConfig: { query: "SourceRecords | take 1" },
                lifecycleDefinition: {
                    lifecycle: {
                        name: "Example",
                        initialState: "Diagnosed",
                    },
                },
                validationGates: [{
                    type: "external_operation",
                    name: "Integration validation",
                    beforeState: "Fixed",
                    provider: "mock",
                    kind: "pvs",
                }],
            },
        });
        const lifecycleWorker = "lifecycle-controller";
        const [claimed] = await catalog.claimDueJobGenerators(lifecycleWorker, 1, 300);
        assert.equal(claimed.generatorId, lifecycleRegistration.generator.generatorId);
        const { cycle } = await catalog.beginJobGeneratorCycle(
            lifecycleRegistration.generator.generatorId,
            lifecycleWorker,
        );
        const [job] = await catalog.reconcileJobGeneratorDiscoveries(cycle.cycleId, [{
            key: "record-42",
            payload: { id: 42 },
        }]);
        assert.equal(job.currentState, "Diagnosed");
        assert.equal(job.stateRevision, 1);

        const firstSession = await catalog.reserveJobSession(
            job.jobId,
            cycle.cycleId,
            lifecycleWorker,
            "lifecycle-session-1",
        );
        await catalog.prepareJobStateRun({
            sessionId: firstSession.sessionId,
            expectedState: "Diagnosed",
            expectedRevision: 1,
            stateOwner: "user",
            sourceId: "user-lifecycle",
            sourcePath: "Example.Diagnosed.md",
            sourceCommit: "abc123",
            markdownSha256: "a".repeat(64),
            allowedOutcomes: [{ outcome: "Fixed", toState: "Fixed" }],
            terminal: false,
        });
        // The git worker can start the durable turn before the controller's
        // post-send attach returns; acknowledgement must be race-safe.
        await catalog.acknowledgeJobSession(firstSession.sessionId, "git-worker-1");
        await catalog.attachJobSession(
            job.jobId,
            firstSession.sessionId,
            cycle.cycleId,
            lifecycleWorker,
        );
        await catalog.setJobSessionExecutionStatus(firstSession.sessionId, "waiting");
        assert.equal((await catalog.getJob(job.jobId)).lifecycleState, "blocked");
        await assert.rejects(
            catalog.completeJobState({
                sessionId: firstSession.sessionId,
                outcome: "Fixed",
                summary: "A system-waiting state must not advance.",
            }),
            /not the active current run/,
        );
        await catalog.acknowledgeJobSession(firstSession.sessionId, "git-worker-1");
        assert.equal((await catalog.getJob(job.jobId)).lifecycleState, "active");
        await catalog.setJobSessionExecutionStatus(firstSession.sessionId, "input_required");
        assert.equal((await catalog.getJob(job.jobId)).lifecycleState, "blocked");
        await catalog.acknowledgeJobSession(firstSession.sessionId, "git-worker-1");
        assert.equal((await catalog.getJob(job.jobId)).lifecycleState, "active");
        await assert.rejects(
            catalog.completeJobState({
                sessionId: firstSession.sessionId,
                outcome: "Rejected",
                summary: "This must not commit.",
            }),
            /not allowed/,
        );
        const operation = await catalog.startJobExternalOperation({
            sessionId: firstSession.sessionId,
            provider: "mock",
            kind: "pvs",
            operationKey: "integration",
            request: { result: { passed: true } },
            nextPollAt: new Date(Date.now() - 1_000),
        });
        const replayedOperation = await catalog.startJobExternalOperation({
            sessionId: firstSession.sessionId,
            provider: "mock",
            kind: "pvs",
            operationKey: "integration",
            request: { result: { passed: false }, delayMs: 30_000 },
        });
        assert.equal(replayedOperation.operationId, operation.operationId);
        assert.equal(
            (await catalog.getJobExternalOperation(firstSession.sessionId, operation.operationId)).signalKey,
            operation.signalKey,
        );
        await assert.rejects(
            catalog.completeJobState({
                sessionId: firstSession.sessionId,
                outcome: "Fixed",
                summary: "The validation gate must reject pending work.",
            }),
            /requires completed external operation evidence/,
        );
        const [claimedOperation] = await catalog.claimDueJobExternalOperations(
            "mock",
            "mock-producer-1",
        );
        assert.equal(claimedOperation.operationId, operation.operationId);
        await catalog.completeJobExternalOperation({
            operationId: operation.operationId,
            workerId: "mock-producer-1",
            status: "succeeded",
            result: { passed: true },
            evidence: { runId: "pvs-integration-1" },
        });
        const replacementSession = await catalog.replaceJobSession(
            job.jobId,
            "lifecycle-session-1-replacement",
        );
        await catalog.prepareJobStateRun({
            sessionId: replacementSession.sessionId,
            expectedState: "Diagnosed",
            expectedRevision: 1,
            stateOwner: "user",
            sourceId: "user-lifecycle",
            sourcePath: "Example.Diagnosed.md",
            sourceCommit: "abc123",
            markdownSha256: "a".repeat(64),
            allowedOutcomes: [{ outcome: "Fixed", toState: "Fixed" }],
            terminal: false,
        });
        await catalog.attachJobSession(
            job.jobId,
            replacementSession.sessionId,
            cycle.cycleId,
            lifecycleWorker,
        );
        await catalog.acknowledgeJobSession(replacementSession.sessionId, "git-worker-2");
        const reboundOperation = await catalog.startJobExternalOperation({
            sessionId: replacementSession.sessionId,
            provider: "mock",
            kind: "pvs",
            operationKey: "integration",
            request: {},
        });
        assert.equal(reboundOperation.operationId, operation.operationId);
        assert.equal(reboundOperation.createdSessionId, firstSession.sessionId);
        assert.equal(reboundOperation.sessionId, replacementSession.sessionId);
        assert.equal(
            await catalog.getJobExternalOperation(firstSession.sessionId, operation.operationId),
            null,
        );
        assert.equal(
            (await catalog.getJobExternalOperation(replacementSession.sessionId, operation.operationId)).operationId,
            operation.operationId,
        );

        await catalog.setJobSessionExecutionStatus(replacementSession.sessionId, "waiting");
        assert.equal(
            await catalog.recordJobExternalOperationWait(
                replacementSession.sessionId,
                operation.signalKey,
                "started",
            ),
            true,
        );
        await catalog.recordEvents(replacementSession.sessionId, [{
            eventType: "session.system_wait_started",
            data: { signalKey: operation.signalKey },
        }], "git-worker-2");
        const [claimedSignal] = await catalog.claimJobExternalOperationSignals("mock-producer-1");
        assert.equal(claimedSignal.operationId, operation.operationId);
        assert.equal(claimedSignal.sessionId, replacementSession.sessionId);
        await catalog.markJobExternalOperationSignalDelivered(
            operation.operationId,
            "mock-producer-1",
        );
        assert.equal(
            await catalog.recordJobExternalOperationWait(
                replacementSession.sessionId,
                operation.signalKey,
                "completed",
            ),
            true,
        );
        await catalog.recordEvents(replacementSession.sessionId, [{
            eventType: "session.system_wait_completed",
            data: { signalKey: operation.signalKey },
        }], "git-worker-2");
        await catalog.acknowledgeJobSession(replacementSession.sessionId, "git-worker-2");
        const firstEntry = await catalog.completeJobState({
            sessionId: replacementSession.sessionId,
            outcome: "Fixed",
            summary: "Diagnosed the issue and applied the fix.",
        });
        assert.equal(firstEntry.sequence, 1);
        assert.equal(firstEntry.fromState, "Diagnosed");
        assert.equal(firstEntry.toState, "Fixed");
        assert.equal((await catalog.getJob(job.jobId)).currentState, "Fixed");

        const secondSession = await catalog.reserveJobSession(
            job.jobId,
            cycle.cycleId,
            lifecycleWorker,
            "lifecycle-session-2",
        );
        await catalog.prepareJobStateRun({
            sessionId: secondSession.sessionId,
            expectedState: "Fixed",
            expectedRevision: 2,
            stateOwner: "platform",
            sourceId: "platform-lifecycle",
            sourcePath: "Standard.Fixed.md",
            sourceCommit: "def456",
            markdownSha256: "b".repeat(64),
            allowedOutcomes: [],
            terminal: true,
        });
        await catalog.attachJobSession(
            job.jobId,
            secondSession.sessionId,
            cycle.cycleId,
            lifecycleWorker,
        );
        await catalog.acknowledgeJobSession(secondSession.sessionId, "git-worker-2");
        await assert.rejects(
            catalog.completeJobState({
                sessionId: secondSession.sessionId,
                outcome: "Done",
                summary: "This must not commit.",
            }),
            /must not specify an outcome/,
        );
        const terminalEntry = await catalog.completeJobState({
            sessionId: secondSession.sessionId,
            summary: "Verified the fix and completed delivery.",
        });
        assert.equal(terminalEntry.sequence, 2);
        assert.equal(terminalEntry.fromState, "Fixed");
        assert.equal(terminalEntry.toState, "Fixed");
        const completedJob = await catalog.getJob(job.jobId);
        assert.equal(completedJob.lifecycleState, "completed");
        assert.equal(completedJob.currentState, "Fixed");
        assert.equal(
            (await catalog.listJobSessions(job.jobId)).find((entry) => entry.sessionId === secondSession.sessionId).status,
            "completed",
        );
        assert.deepEqual(
            (await catalog.listJobJournal(job.jobId)).map((entry) => entry.summary),
            [
                "Diagnosed the issue and applied the fix.",
                "Verified the fix and completed delivery.",
            ],
        );

        const replay = await catalog.completeJobState({
            sessionId: replacementSession.sessionId,
            outcome: "Fixed",
            summary: "A replay does not append another entry.",
        });
        assert.equal(replay.journalEntryId, firstEntry.journalEntryId);
        assert.equal((await catalog.listJobJournal(job.jobId)).length, 2);
        await catalog.completeJobGeneratorCycle({
            cycleId: cycle.cycleId,
            workerId: lifecycleWorker,
            status: "succeeded",
            discoveredCount: 1,
            createdCount: 1,
        });
    } finally {
        await catalog.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await catalog.close();
    }
});
