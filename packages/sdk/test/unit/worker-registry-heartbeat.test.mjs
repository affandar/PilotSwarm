import assert from "node:assert/strict";
import test from "node:test";
import { PilotSwarmWorker } from "../../dist/worker.js";
import { runTurnRoutingTag } from "../../dist/activity-routing.js";

function worker() {
    return new PilotSwarmWorker({
        store: "sqlite::memory:",
        blobUseManagedIdentity: false,
    });
}

const PROVENANCE_ENV = [
    "PILOTSWARM_WORKER_DISPLAY_NAME",
    "PILOTSWARM_APPLICATION_VERSION",
    "PILOTSWARM_SOURCE_COMMIT",
    "PILOTSWARM_BUILD_ID",
    "PILOTSWARM_IMAGE_REF",
    "PILOTSWARM_IMAGE_DIGEST",
    "IMAGE",
];

function withProvenanceEnv(values, callback) {
    const original = Object.fromEntries(PROVENANCE_ENV.map((name) => [name, process.env[name]]));
    for (const name of PROVENANCE_ENV) {
        if (values[name] === undefined) delete process.env[name];
        else process.env[name] = values[name];
    }
    try {
        return callback();
    } finally {
        for (const name of PROVENANCE_ENV) {
            if (original[name] === undefined) delete process.env[name];
            else process.env[name] = original[name];
        }
    }
}

test("package-less workers maintain and stop a dedicated registry heartbeat", async () => {
    const originalInterval = process.env.PILOTSWARM_WORKER_HEARTBEAT_MS;
    process.env.PILOTSWARM_WORKER_HEARTBEAT_MS = "5";
    const instance = worker();
    let beats = 0;
    instance._reportAgentWorkerState = async () => {
        beats += 1;
    };

    try {
        instance._startWorkerRegistryHeartbeat();
        assert.ok(instance._workerRegistryTimer);
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.ok(beats > 0);

        await instance.stop();
        assert.equal(instance._workerRegistryTimer, null);
        const stoppedAt = beats;
        await new Promise((resolve) => setTimeout(resolve, 15));
        assert.equal(beats, stoppedAt);
    } finally {
        await instance.stop();
        if (originalInterval === undefined) {
            delete process.env.PILOTSWARM_WORKER_HEARTBEAT_MS;
        } else {
            process.env.PILOTSWARM_WORKER_HEARTBEAT_MS = originalInterval;
        }
    }
});

test("graceful shutdown publishes draining whenever a registry catalog exists", async () => {
    const instance = worker();
    const phases = [];
    instance._catalog = {
        async close() {},
    };
    instance._reportAgentWorkerState = async () => {
        phases.push(instance._workerPhase);
    };

    await instance.gracefulShutdown();

    assert.deepEqual(phases, ["draining"]);
    assert.equal(instance._catalog, null);
});

test("owner-scoped repo workers do not advertise global repo serviceability", () => {
    const instance = new PilotSwarmWorker({
        store: "sqlite::memory:",
        blobUseManagedIdentity: false,
        workerOwner: { provider: "dev", subject: "alice" },
    });
    instance._workerTagFilter = {
        defaultAnd: [
            runTurnRoutingTag({
                repo: "sample-repo",
                ownerAffinity: { provider: "dev", subject: "alice" },
            }),
        ],
    };

    const info = instance._buildRegistrarInfo();
    assert.equal(info.repos, undefined);
    assert.deepEqual(info.ownerScopedRepos, ["sample-repo"]);
});

test("worker provenance is explicit and stable for the process lifetime", () => {
    withProvenanceEnv({
        PILOTSWARM_WORKER_DISPLAY_NAME: "AKS worker",
        PILOTSWARM_APPLICATION_VERSION: "2.4.0",
        PILOTSWARM_SOURCE_COMMIT: "0123456789abcdef",
        PILOTSWARM_BUILD_ID: "build-2048",
        PILOTSWARM_IMAGE_REF: "registry/pilotswarm-worker:build-2048",
        PILOTSWARM_IMAGE_DIGEST: "sha256:abcdef",
    }, () => {
        const instance = worker();
        const first = instance._buildRegistrarInfo();

        assert.equal(first.provenance.displayName, "AKS worker");
        assert.equal(first.provenance.hostname, first.runtime.hostname);
        assert.equal(first.provenance.processStartedAt, first.runtime.startedAt);
        assert.equal(first.provenance.sdkVersion, first.sdkVersion);
        assert.equal(first.provenance.applicationVersion, "2.4.0");
        assert.equal(first.provenance.sourceCommit, "0123456789abcdef");
        assert.equal(first.provenance.buildId, "build-2048");
        assert.deepEqual(first.provenance.image, {
            ref: "registry/pilotswarm-worker:build-2048",
            digest: "sha256:abcdef",
        });

        process.env.PILOTSWARM_BUILD_ID = "build-should-not-change";
        assert.equal(instance._buildRegistrarInfo(), first);
        assert.equal(instance._buildRegistrarInfo().provenance.buildId, "build-2048");
    });
});

test("worker health reports busy slots separately from resident sessions", () => {
    const instance = worker();
    const health = instance._collectWorkerHealth();

    assert.equal(health.activeSessions, 0);
    assert.deepEqual(health.workerSlots, { busy: 0, total: 2 });
});

test("new workers capture new provenance and options override environment values", () => {
    withProvenanceEnv({
        PILOTSWARM_WORKER_DISPLAY_NAME: "environment name",
        PILOTSWARM_APPLICATION_VERSION: "1.0.0",
        PILOTSWARM_SOURCE_COMMIT: undefined,
        PILOTSWARM_BUILD_ID: undefined,
        PILOTSWARM_IMAGE_REF: undefined,
        PILOTSWARM_IMAGE_DIGEST: undefined,
        IMAGE: "registry/worker:deployed",
    }, () => {
        const first = worker()._buildRegistrarInfo();
        const restarted = new PilotSwarmWorker({
            store: "sqlite::memory:",
            blobUseManagedIdentity: false,
            workerProvenance: {
                displayName: "configured name",
                applicationVersion: "2.0.0",
                sourceCommit: "new-commit",
                buildId: "new-build",
            },
        })._buildRegistrarInfo();

        assert.equal(first.provenance.displayName, "environment name");
        assert.equal(first.provenance.sourceCommit, null);
        assert.equal(first.provenance.buildId, null);
        assert.deepEqual(first.provenance.image, { ref: "registry/worker:deployed", digest: null });
        assert.equal(restarted.provenance.displayName, "configured name");
        assert.equal(restarted.provenance.applicationVersion, "2.0.0");
        assert.equal(restarted.provenance.sourceCommit, "new-commit");
        assert.equal(restarted.provenance.buildId, "new-build");
    });
});
