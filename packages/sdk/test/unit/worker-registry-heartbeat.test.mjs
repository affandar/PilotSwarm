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
