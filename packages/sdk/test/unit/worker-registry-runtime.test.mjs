import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmWorker } from "../../dist/worker.js";

const PROVENANCE_ENV = [
    "PILOTSWARM_APPLICATION_VERSION",
    "PILOTSWARM_SOURCE_COMMIT",
    "PILOTSWARM_BUILD_ID",
    "PILOTSWARM_UNRELATED_METADATA",
];

function createWorker(options = {}) {
    return new PilotSwarmWorker({
        store: "sqlite::memory:",
        ...options,
    });
}

function attachCatalog(worker, heartbeats) {
    worker._catalog = {
        async workerHeartbeat(payload) {
            heartbeats.push(payload);
        },
        async close() {},
    };
}

async function withEnvironment(values, callback) {
    const original = Object.fromEntries(PROVENANCE_ENV.map((name) => [name, process.env[name]]));
    for (const name of PROVENANCE_ENV) {
        if (values[name] === undefined) delete process.env[name];
        else process.env[name] = values[name];
    }
    try {
        return await callback();
    } finally {
        for (const name of PROVENANCE_ENV) {
            if (original[name] === undefined) delete process.env[name];
            else process.env[name] = original[name];
        }
    }
}

test("registry heartbeats publish only bounded runtime provenance fields", async () => {
    await withEnvironment({
        PILOTSWARM_APPLICATION_VERSION: "environment-version",
        PILOTSWARM_SOURCE_COMMIT: "0123456789abcdef",
        PILOTSWARM_BUILD_ID: "environment-build",
        PILOTSWARM_UNRELATED_METADATA: "not-published",
    }, async () => {
        const worker = createWorker({
            workerProvenance: {
                applicationVersion: " 2.4.0 ",
                buildId: `build\n${"x".repeat(200)}`,
                unexpected: "also-not-published",
            },
        });
        const heartbeats = [];
        attachCatalog(worker, heartbeats);

        await worker._reportAgentWorkerState();

        const provenance = heartbeats[0].info.provenance;
        for (const key of [
            "applicationVersion",
            "architecture",
            "buildId",
            "nodeVersion",
            "platform",
            "sdkVersion",
            "sourceCommit",
        ]) {
            assert.ok(Object.hasOwn(provenance, key), `missing provenance field ${key}`);
        }
        assert.equal(provenance.applicationVersion, "2.4.0");
        assert.equal(provenance.sourceCommit, "0123456789abcdef");
        assert.equal(provenance.buildId.length, 128);
        assert.doesNotMatch(provenance.buildId, /[\r\n]/);
        assert.doesNotMatch(JSON.stringify(provenance), /not-published/);
        assert.equal(typeof provenance.sdkVersion, "string");
        assert.equal(provenance.nodeVersion, process.version);
        assert.equal(provenance.platform, process.platform);
        assert.equal(provenance.architecture, process.arch);

        process.env.PILOTSWARM_SOURCE_COMMIT = "changed-after-registration";
        await worker._reportAgentWorkerState();
        assert.equal(heartbeats[1].info, heartbeats[0].info);
        assert.equal(heartbeats[1].info.provenance.sourceCommit, "0123456789abcdef");
        await worker.stop();
    });
});

test("package-less workers keep heartbeating and stop cleanly", async () => {
    const worker = createWorker();
    const heartbeats = [];
    attachCatalog(worker, heartbeats);
    worker._agentPackagesRefreshMs = 5;

    worker._startConfigurationPolling();
    await new Promise((resolve) => setTimeout(resolve, 24));
    assert.ok(heartbeats.length >= 2);

    await worker.stop();
    const stoppedAt = heartbeats.length;
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(heartbeats.length, stoppedAt);
});

test("package-less workers publish draining before leaving the registry", async () => {
    const worker = createWorker();
    const heartbeats = [];
    attachCatalog(worker, heartbeats);
    worker._workerPhase = "ready";

    await worker.gracefulShutdown();

    assert.equal(heartbeats.at(-1)?.phase, "draining");
});
