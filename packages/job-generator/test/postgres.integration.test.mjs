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

test("one continuous controller materializes due generators across owners", {
    skip: !catalogUrl,
    timeout: 120_000,
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
    } finally {
        await catalog.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await catalog.close();
    }
});
