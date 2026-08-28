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
                sourceType: "kusto",
                sourceConfig: { query: "SampleRecords | take 10" },
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
