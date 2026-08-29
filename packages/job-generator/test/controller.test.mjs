import test from "node:test";
import assert from "node:assert/strict";
import { JobGeneratorController, PilotSwarmInitialSessionFactory } from "../dist/controller.js";

const now = new Date();

function generator() {
    return {
        generatorId: "generator-1",
        name: "test",
        owner: { provider: "test", subject: "owner" },
        cadenceSeconds: 60,
        operationalState: "enabled",
        activeDefinitionId: "definition-1",
        nextRunAt: now,
        watermark: null,
        totalCycles: 0,
        successfulCycles: 0,
        failedCycles: 0,
        materializedJobs: 0,
        lastCycleAt: null,
        lastError: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        createdAt: now,
        updatedAt: now,
    };
}

function definition() {
    return {
        definitionId: "definition-1",
        generatorId: "generator-1",
        version: 1,
        sourceType: "ado_wiql",
        sourceConfig: {},
        lifecycleDefinition: {},
        affinities: {},
        validationGates: [],
        guardrails: {},
        createdBy: null,
        createdAt: now,
    };
}

class FakeStore {
    jobs = new Map();
    sessions = new Map();
    cycles = [];
    activeDefinitionId = "definition-1";
    nextCycle = 1;
    nextSession = 1;

    async claimDueJobGenerators() {
        return [generator()];
    }
    async beginJobGeneratorCycle() {
        return {
            cycle: {
                cycleId: `cycle-${this.nextCycle++}`,
                generatorId: "generator-1",
                definitionId: this.activeDefinitionId,
                status: "running",
                claimedBy: "worker",
                watermarkBefore: null,
                watermarkAfter: null,
                discoveredCount: 0,
                createdCount: 0,
                error: null,
                startedAt: now,
                completedAt: null,
            },
            definition: { ...definition(), definitionId: this.activeDefinitionId },
        };
    }
    async reconcileJobGeneratorDiscoveries(cycleId, discoveries) {
        return discoveries.map(({ key, payload }) => {
            let job = this.jobs.get(key);
            const created = !job;
            if (!job) {
                job = {
                    jobId: `job-${this.jobs.size + 1}`,
                    generatorId: "generator-1",
                    definitionId: this.activeDefinitionId,
                    jobKey: key,
                    sourcePayload: payload,
                    lifecycleState: "pending_session",
                    firstSeenCycleId: cycleId,
                    lastSeenCycleId: cycleId,
                    firstDiscoveredAt: now,
                    lastDiscoveredAt: now,
                    sessionAttempts: 0,
                    sessionError: null,
                    createdAt: now,
                    updatedAt: now,
                };
                this.jobs.set(key, job);
            }
            job.lastSeenCycleId = cycleId;
            return { ...job, created, needsSession: !this.sessions.has(job.jobId) };
        });
    }
    async reserveJobSession(jobId) {
        const existing = this.sessions.get(jobId)?.find((entry) => entry.isCurrent);
        if (existing) return existing;
        const association = {
            associationId: `association-${this.nextSession}`,
            jobId,
            sessionId: `session-${this.nextSession++}`,
            ordinal: 1,
            isCurrent: true,
            status: "reserved",
            error: null,
            reservedAt: now,
            attachedAt: null,
            endedAt: null,
        };
        this.sessions.set(jobId, [association]);
        return association;
    }
    async listJobSessions(jobId) {
        return this.sessions.get(jobId) ?? [];
    }
    async listJobsNeedingSession() {
        return [...this.jobs.values()].filter((job) => {
            const current = this.sessions.get(job.jobId)?.find((entry) => entry.isCurrent);
            return current?.status !== "unacked" && current?.status !== "active";
        });
    }
    async getJobGeneratorDefinition(definitionId) {
        return { ...definition(), definitionId };
    }
    async attachJobSession(jobId, sessionId) {
        const current = this.sessions.get(jobId).find((entry) => entry.sessionId === sessionId);
        current.status = "unacked";
        current.attachedAt = now;
    }
    async failJobSession(jobId, sessionId, error) {
        const current = this.sessions.get(jobId).find((entry) => entry.sessionId === sessionId);
        current.status = "failed";
        current.error = error;
    }
    async completeJobGeneratorCycle(input) {
        this.cycles.push(input);
    }
    replace(jobId, sessionId) {
        const history = this.sessions.get(jobId);
        const current = history.find((entry) => entry.isCurrent);
        current.isCurrent = false;
        current.status = "replaced";
        const next = {
            ...current,
            associationId: `association-${history.length + 1}`,
            sessionId,
            ordinal: history.length + 1,
            isCurrent: true,
            status: "active",
        };
        history.push(next);
        return next;
    }
}

function evaluator() {
    return {
        type: "ado_wiql",
        async evaluate() {
            return { discoveries: [{ key: "stable-1", payload: { id: 1 } }], watermark: "next" };
        },
    };
}

test("repeated reconciliation creates one Job and one initial session", async () => {
    const store = new FakeStore();
    const createdSessions = [];
    const controller = new JobGeneratorController({
        store,
        evaluators: new Map([["ado_wiql", evaluator()]]),
        sessionFactory: {
            async createInitialSession({ association }) {
                createdSessions.push(association.sessionId);
            },
        },
        workerId: "worker",
        logger: { info() {}, warn() {}, error() {} },
    });
    await controller.runOnce();
    await controller.runOnce();
    assert.equal(store.jobs.size, 1);
    assert.deepEqual(createdSessions, ["session-1"]);
    assert.equal(store.sessions.get("job-1").length, 1);
    assert.deepEqual(store.cycles.map((cycle) => cycle.createdCount), [1, 0]);
});

test("materialization-only mode does not reserve sessions when explicitly selected", async () => {
    const store = new FakeStore();
    const messages = [];
    const controller = new JobGeneratorController({
        store,
        evaluators: new Map([["ado_wiql", evaluator()]]),
        induceSessions: false,
        workerId: "worker",
        logger: { info(message) { messages.push(message); }, warn() {}, error() {} },
    });
    await controller.runOnce();
    assert.equal(store.jobs.size, 1);
    assert.equal(store.sessions.size, 0);
    assert.ok(messages.some((message) => message === "[job-generator] poll claimed=1"));
    assert.ok(messages.some((message) => message.includes("evaluating source=ado_wiql")));
    assert.deepEqual(store.cycles.map((cycle) => ({
        status: cycle.status,
        discoveredCount: cycle.discoveredCount,
        createdCount: cycle.createdCount,
    })), [{ status: "succeeded", discoveredCount: 1, createdCount: 1 }]);
});

test("session failure retries the reserved session without duplicating the Job", async () => {
    const store = new FakeStore();
    const attempted = [];
    let fail = true;
    const controller = new JobGeneratorController({
        store,
        evaluators: new Map([["ado_wiql", evaluator()]]),
        sessionFactory: {
            async createInitialSession({ association }) {
                attempted.push(association.sessionId);
                if (fail) {
                    fail = false;
                    throw new Error("session API unavailable");
                }
            },
        },
        induceSessions: true,
        workerId: "worker",
        logger: { info() {}, warn() {}, error() {} },
    });
    await controller.runOnce();
    await controller.runOnce();
    assert.equal(store.jobs.size, 1);
    assert.deepEqual(attempted, ["session-1", "session-1"]);
    assert.equal(store.sessions.get("job-1").length, 1);
    assert.equal(store.sessions.get("job-1")[0].status, "unacked");
    assert.deepEqual(store.cycles.map((cycle) => cycle.status), ["failed", "succeeded"]);
});

test("session failure retries even when the source no longer returns the Job", async () => {
    const store = new FakeStore();
    let evaluation = 0;
    let attempts = 0;
    const controller = new JobGeneratorController({
        store,
        evaluators: new Map([["ado_wiql", {
            type: "ado_wiql",
            async evaluate() {
                evaluation += 1;
                return {
                    discoveries: evaluation === 1 ? [{ key: "stable-1", payload: { id: 1 } }] : [],
                };
            },
        }]]),
        sessionFactory: {
            async createInitialSession() {
                attempts += 1;
                if (attempts === 1) throw new Error("session API unavailable");
            },
        },
        induceSessions: true,
        workerId: "worker",
        logger: { info() {}, warn() {}, error() {} },
    });
    await controller.runOnce();
    await controller.runOnce();
    assert.equal(attempts, 2);
    assert.equal(store.jobs.size, 1);
    assert.equal(store.sessions.get("job-1")[0].status, "unacked");
});

test("session retry uses the Job's pinned definition after a new version is activated", async () => {
    const store = new FakeStore();
    const attemptedDefinitions = [];
    let fail = true;
    const controller = new JobGeneratorController({
        store,
        evaluators: new Map([["ado_wiql", evaluator()]]),
        sessionFactory: {
            async createInitialSession({ definition: jobDefinition }) {
                attemptedDefinitions.push(jobDefinition.definitionId);
                if (fail) {
                    fail = false;
                    throw new Error("session API unavailable");
                }
            },
        },
        induceSessions: true,
        workerId: "worker",
        logger: { info() {}, warn() {}, error() {} },
    });
    await controller.runOnce();
    store.activeDefinitionId = "definition-2";
    await controller.runOnce();
    assert.deepEqual(attemptedDefinitions, ["definition-1", "definition-1"]);
    assert.equal(store.jobs.get("stable-1").definitionId, "definition-1");
});

test("Job identity survives replacement while prior sessions remain history", async () => {
    const store = new FakeStore();
    const association = await store.reserveJobSession("job-1");
    await store.attachJobSession("job-1", association.sessionId);
    store.replace("job-1", "session-2");
    const history = await store.listJobSessions("job-1");
    assert.equal(history.length, 2);
    assert.deepEqual(history.map((entry) => entry.sessionId), ["session-1", "session-2"]);
    assert.equal(history.filter((entry) => entry.isCurrent).length, 1);
    assert.equal(history[0].status, "replaced");
});

test("continuous mode retries after a transient claim failure", async () => {
    const store = new FakeStore();
    const errors = [];
    const abort = new AbortController();
    let attempts = 0;
    store.claimDueJobGenerators = async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("database temporarily unavailable");
        abort.abort();
        return [];
    };
    const controller = new JobGeneratorController({
        store,
        evaluators: new Map(),
        induceSessions: false,
        pollIntervalMs: 1,
        logger: { info() {}, warn() {}, error(...args) { errors.push(args); } },
    });

    await controller.run(abort.signal);

    assert.equal(attempts, 2);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /polling failed/);
});

test("controller rejects invalid continuous-loop settings", () => {
    const store = new FakeStore();
    assert.throws(
        () => new JobGeneratorController({
            store,
            evaluators: new Map(),
            induceSessions: false,
            pollIntervalMs: 0,
        }),
        /pollIntervalMs must be a positive integer/,
    );
});

test("rediscovered terminal Jobs are not reserved again", async () => {
    const store = new FakeStore();
    store.reconcileJobGeneratorDiscoveries = async () => [{
        ...{
            jobId: "job-completed",
            generatorId: "generator-1",
            definitionId: "definition-1",
            jobKey: "stable-1",
            sourcePayload: { id: 1 },
            lifecycleState: "completed",
            currentState: "Done",
            stateRevision: 2,
            currentStateEnteredAt: now,
            firstSeenCycleId: "cycle-1",
            lastSeenCycleId: "cycle-1",
            firstDiscoveredAt: now,
            lastDiscoveredAt: now,
            sessionAttempts: 1,
            sessionError: null,
            createdAt: now,
            updatedAt: now,
        },
        created: false,
        needsSession: false,
    }];
    store.listJobsNeedingSession = async () => [];
    store.reserveJobSession = async () => {
        throw new Error("terminal Job must not be reserved");
    };
    const controller = new JobGeneratorController({
        store,
        evaluators: new Map([["ado_wiql", evaluator()]]),
        sessionFactory: {
            async createInitialSession() {
                throw new Error("terminal Job must not create a session");
            },
        },
        workerId: "worker",
        logger: { info() {}, warn() {}, error() {} },
    });

    await controller.runOnce();
    assert.equal(store.cycles[0].status, "succeeded");
});

test("lifecycle session loads exact state Markdown, journal, and completion tool", async () => {
    const created = [];
    const sent = [];
    const prepared = [];
    const client = {
        async createSession(config) {
            created.push(config);
            return {
                async send(prompt, options) {
                    sent.push({ prompt, options });
                },
            };
        },
    };
    const factory = new PilotSwarmInitialSessionFactory(client, {
        reader: {
            async readStateMarkdown(source, sourcePath) {
                if (source.sourceId !== "user-lifecycle") return null;
                assert.equal(sourcePath, "automation/Example.Diagnosed.md");
                return [
                    "# Diagnose",
                    "",
                    "Use the repository evidence.",
                    "",
                    "## Possible next states",
                    "- [Fixed](./Example.Fixed.md)",
                ].join("\n");
            },
        },
        store: {
            async listJobJournal(jobId) {
                assert.equal(jobId, "job-1");
                return [{
                    sequence: 1,
                    fromState: "Initial",
                    toState: "Diagnosed",
                    outcome: "Diagnosed",
                    sessionId: "session-previous",
                    summary: "Collected the failing query and logs.",
                }];
            },
            async prepareJobStateRun(input) {
                prepared.push(input);
                return {};
            },
        },
    });

    await factory.createInitialSession({
        generator: generator(),
        definition: {
            ...definition(),
            lifecycleDefinition: {
                name: "Example",
                initialState: "Initial",
                sources: [{
                    sourceId: "user-lifecycle",
                    owner: "user",
                    filePrefix: "Example",
                    basePath: "automation",
                    repositoryUrl: "https://github.com/example/repository",
                    resolvedCommit: "abc123",
                }],
                session: { toolNames: ["read_file"] },
            },
        },
        job: {
            jobId: "job-1",
            generatorId: "generator-1",
            definitionId: "definition-1",
            jobKey: "source-42",
            sourcePayload: { id: 42 },
            lifecycleState: "pending_session",
            currentState: "Diagnosed",
            stateRevision: 2,
            currentStateEnteredAt: now,
            firstSeenCycleId: "cycle-1",
            lastSeenCycleId: "cycle-1",
            firstDiscoveredAt: now,
            lastDiscoveredAt: now,
            sessionAttempts: 1,
            sessionError: null,
            createdAt: now,
            updatedAt: now,
        },
        association: {
            associationId: "association-1",
            jobId: "job-1",
            sessionId: "session-2",
            stateRunId: "state-run-2",
            ordinal: 2,
            isCurrent: true,
            status: "reserved",
            error: null,
            reservedAt: now,
            attachedAt: null,
            endedAt: null,
        },
    });

    assert.deepEqual(created[0].toolNames, ["read_file", "complete_state"]);
    assert.equal(prepared[0].sessionId, "session-2");
    assert.equal(prepared[0].sourcePath, "automation/Example.Diagnosed.md");
    assert.deepEqual(prepared[0].allowedOutcomes, [{ outcome: "Fixed", toState: "Fixed" }]);
    assert.equal(prepared[0].terminal, false);
    assert.match(sent[0].prompt, /Collected the failing query and logs/);
    assert.match(sent[0].prompt, /follow its Session reference/);
    assert.match(sent[0].prompt, /do not create a duplicate after resume/);
    assert.match(sent[0].prompt, /For a human decision, call ask_user/);
    assert.match(sent[0].prompt, /call system_wait with the durable correlation key/);
    assert.match(sent[0].prompt, /preserve the outcome, evidence, durable identifiers or references/);
    assert.match(sent[0].prompt, /Use the repository evidence/);
    assert.match(sent[0].prompt, /Allowed outcomes: Fixed/);
    assert.deepEqual(sent[0].options.clientMessageIds, ["job-generator:job-1:state:2"]);
});
