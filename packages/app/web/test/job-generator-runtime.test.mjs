import test from "node:test";
import assert from "node:assert/strict";
import { PortalRuntime } from "../runtime.js";

const alice = {
    principal: {
        provider: "dev",
        subject: "alice",
        email: "alice@example.test",
        displayName: "Alice",
    },
    authorization: { allowed: true, role: "user", reason: "test", matchedGroups: [] },
};

const bob = {
    principal: {
        provider: "dev",
        subject: "bob",
        email: "bob@example.test",
        displayName: "Bob",
    },
    authorization: { allowed: true, role: "user", reason: "test", matchedGroups: [] },
};

const admin = {
    principal: {
        provider: "dev",
        subject: "admin",
        email: "admin@example.test",
        displayName: "Admin",
    },
    authorization: { allowed: true, role: "admin", reason: "test", matchedGroups: [] },
};

function createRuntime() {
    const calls = [];
    const generators = new Map([
        ["g-alice", {
            generatorId: "g-alice",
            name: "Alice Generator",
            owner: { provider: "dev", subject: "alice" },
            activeDefinitionId: "d-alice",
        }],
        ["g-bob", {
            generatorId: "g-bob",
            name: "Bob Generator",
            owner: { provider: "dev", subject: "bob" },
            activeDefinitionId: "d-bob",
        }],
    ]);
    const runtime = Object.create(PortalRuntime.prototype);
    runtime.started = true;
    runtime.startPromise = null;
    runtime.authz = { enforce: true, defaultVisibility: "private", systemVisibility: "read" };
    runtime._breakGlassSeen = new Map();
    runtime.transport = {
        async listJobGenerators(owner) {
            calls.push({ method: "listJobGenerators", owner });
            return [...generators.values()].filter((generator) => (
                !owner
                || (generator.owner.provider === owner.provider && generator.owner.subject === owner.subject)
            ));
        },
        async createJobGenerator(input) {
            calls.push({ method: "createJobGenerator", input });
            return {
                generator: {
                    generatorId: "g-created",
                    name: input.name,
                    owner: input.owner,
                    activeDefinitionId: "d-created",
                },
                definition: { definitionId: "d-created", generatorId: "g-created", version: 1 },
            };
        },
        async publishJobGeneratorDefinition(input) {
            calls.push({ method: "publishJobGeneratorDefinition", input });
            return { definitionId: "d-alice-v2", generatorId: input.generatorId, version: 2, ...input };
        },
        async getJobGenerator(generatorId) {
            return generators.get(generatorId) ?? null;
        },
        async getJobGeneratorDefinition(definitionId) {
            const generatorId = definitionId === "d-alice" ? "g-alice" : definitionId === "d-bob" ? "g-bob" : null;
            if (!generatorId) throw new Error("not found");
            return { definitionId, generatorId, version: 1 };
        },
        async getJob(jobId) {
            if (jobId === "j-alice") return { jobId, generatorId: "g-alice" };
            if (jobId === "j-bob") return { jobId, generatorId: "g-bob" };
            return null;
        },
        async listJobGeneratorDefinitions() { return []; },
        async listJobGeneratorJobs() { return []; },
        async listJobGeneratorCycles() { return []; },
        async listJobSessions() { return []; },
        async listJobStateRuns() { return []; },
        async listJobJournal() { return []; },
        async getWorkerTimeline(workerNodeId, options) {
            calls.push({ method: "getWorkerTimeline", workerNodeId, options });
            return [{ timelineId: "event:1", workerNodeId }];
        },
        async recordAuthzAudit(entry) { calls.push({ method: "audit", entry }); },
    };
    return { runtime, calls };
}

test("JobGenerator registration stamps the authenticated owner", async () => {
    const { runtime, calls } = createRuntime();
    const result = await runtime.call("createJobGenerator", {
        name: "HelloWorld",
        cadenceSeconds: 300,
        definition: {
            sourceType: "kusto",
            sourceConfig: { query: "SampleRecords | take 10" },
            lifecycleDefinition: { states: {} },
            affinities: { repo: "sample-repo" },
            validationGates: [],
            guardrails: { maxOutstandingJobs: 5 },
        },
    }, alice);
    assert.equal(result.generator.generatorId, "g-created");
    const create = calls.find((call) => call.method === "createJobGenerator");
    assert.deepEqual(create.input.owner, alice.principal);
    assert.equal(create.input.definition.createdBy, "alice");
});

test("JobGenerator listing is owner-scoped for users", async () => {
    const { runtime, calls } = createRuntime();
    const rows = await runtime.call("listJobGenerators", {}, alice);
    assert.deepEqual(rows.map((row) => row.generatorId), ["g-alice"]);
    assert.deepEqual(calls.find((call) => call.method === "listJobGenerators").owner, alice.principal);
});

test("JobGenerator, definition, and Job reads do not expose another owner's resources", async () => {
    const { runtime } = createRuntime();
    assert.equal((await runtime.call("getJobGenerator", { generatorId: "g-alice" }, alice)).generatorId, "g-alice");
    await assert.rejects(
        runtime.call("getJobGenerator", { generatorId: "g-bob" }, alice),
        (error) => error.code === "NOT_FOUND",
    );
    await assert.rejects(
        runtime.call("getJobGeneratorDefinition", { definitionId: "d-bob" }, alice),
        (error) => error.code === "NOT_FOUND",
    );
    await assert.rejects(
        runtime.call("listJobSessions", { jobId: "j-bob" }, alice),
        (error) => error.code === "NOT_FOUND",
    );
    await assert.rejects(
        runtime.call("listJobStateRuns", { jobId: "j-bob" }, alice),
        (error) => error.code === "NOT_FOUND",
    );
    await assert.rejects(
        runtime.call("listJobJournal", { jobId: "j-bob" }, alice),
        (error) => error.code === "NOT_FOUND",
    );
});

test("Job state runs and journal are exposed for an owned Job", async () => {
    const { runtime } = createRuntime();
    assert.deepEqual(
        await runtime.call("listJobStateRuns", { jobId: "j-alice" }, alice),
        [],
    );
    assert.deepEqual(
        await runtime.call("listJobJournal", { jobId: "j-alice" }, alice),
        [],
    );
});

test("worker timeline forwards bounded filters for administrators", async () => {
    const { runtime, calls } = createRuntime();
    const result = await runtime.call("getWorkerTimeline", {
        workerNodeId: "pod-a",
        since: "2026-08-29T00:00:00.000Z",
        limit: 50,
    }, admin);

    assert.deepEqual(result, [{ timelineId: "event:1", workerNodeId: "pod-a" }]);
    assert.deepEqual(calls.find((call) => call.method === "getWorkerTimeline"), {
        method: "getWorkerTimeline",
        workerNodeId: "pod-a",
        options: {
            since: "2026-08-29T00:00:00.000Z",
            limit: 50,
        },
    });
});

test("publishing a definition is owner-gated and stamps the authenticated principal", async () => {
    const { runtime, calls } = createRuntime();
    const definition = await runtime.call("publishJobGeneratorDefinition", {
        generatorId: "g-alice",
        definition: {
            sourceType: "kusto",
            sourceConfig: { query: "SampleRecords | take 10" },
            lifecycleDefinition: { states: {} },
            affinities: {},
            validationGates: [],
            guardrails: {},
        },
    }, alice);
    assert.equal(definition.version, 2);
    const publish = calls.find((call) => call.method === "publishJobGeneratorDefinition");
    assert.equal(publish.input.createdBy, "alice");

    await assert.rejects(
        runtime.call("publishJobGeneratorDefinition", {
            generatorId: "g-bob",
            definition: {
                sourceType: "kusto",
                sourceConfig: {},
            },
        }, alice),
        (error) => error.code === "NOT_FOUND",
    );
});

test("JobGenerator registration rejects malformed definition contracts", async () => {
    const { runtime } = createRuntime();
    await assert.rejects(
        runtime.call("createJobGenerator", {
            name: "Bad",
            cadenceSeconds: 5,
            definition: { sourceType: "shell", sourceConfig: {} },
        }, alice),
        (error) => error.code === "INVALID_REQUEST",
    );
});
