/**
 * Worker registry (migration 0040) — heartbeat, directive resolution, shims.
 *
 * The subtle logic gets exhaustive coverage: three-level shallow-merge union
 * with worker > pool > fleet precedence, epoch = SUM (including the
 * coincidentally-equal case where max would miss a bump), uniform prune,
 * write-once vs per-beat fields, canonical worker-row and actuation-uniformity
 * enforcement, and the agent-packages fold-in shims staying continuous.
 *
 * Run: npx vitest run test/local/worker-registry.test.js
 */

import { describe, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { assert, assertEqual } from "../helpers/assertions.js";

const TIMEOUT = 120_000;
const getEnv = useSuiteEnv(import.meta.url);

async function expectError(promise, marker) {
    try {
        await promise;
    } catch (error) {
        assert(String(error?.message ?? error).includes(marker),
            `expected error containing ${marker}, got: ${error?.message ?? error}`);
        return;
    }
    throw new Error(`expected an error containing ${marker}, but the call succeeded`);
}

function beat(catalog, workerNodeId, overrides = {}) {
    return catalog.workerHeartbeat({
        workerNodeId,
        pool: "test-pool",
        phase: "ready",
        info: { sdkVersion: "t", consumes: ["d-test"] },
        health: { uptimeS: 1 },
        state: {},
        ...overrides,
    });
}

describe("worker registry", () => {
    it("heartbeat upsert: info/owner write-once, pool/phase/health per beat", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const id = `wr-upsert-${env.runId}`;
            await beat(catalog, id, {
                phase: "starting",
                owner: { provider: "test", subject: "laptop-owner" },
                info: { sdkVersion: "1.0.0", consumes: ["agent-packages"] },
                health: { uptimeS: 1 },
            });
            let row = (await catalog.listWorkers()).find((w) => w.workerNodeId === id);
            assertEqual(row.phase, "starting");
            assertEqual(row.pool, "test-pool");
            assertEqual(row.owner.subject, "laptop-owner");
            assertEqual(row.info.sdkVersion, "1.0.0");

            // Second beat: info/owner ignored, pool/phase/health replaced.
            await beat(catalog, id, {
                pool: "moved-pool",
                phase: "ready",
                owner: { provider: "test", subject: "SOMEONE-ELSE" },
                info: { sdkVersion: "9.9.9" },
                health: { uptimeS: 60, rssBytes: 123 },
            });
            row = (await catalog.listWorkers()).find((w) => w.workerNodeId === id);
            assertEqual(row.phase, "ready");
            assertEqual(row.pool, "moved-pool", "pool follows the beat (re-targeting)");
            assertEqual(row.owner.subject, "laptop-owner", "owner is write-once");
            assertEqual(row.info.sdkVersion, "1.0.0", "info is write-once");
            assertEqual(row.health.rssBytes, 123, "health replaced every beat");
        } finally {
            await catalog.close();
        }
    });

    it("uniform prune: hour-silent rows vanish; re-registration resets write-once fields", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const stale = `wr-stale-${env.runId}`;
            const fresh = `wr-fresh-${env.runId}`;
            await beat(catalog, stale, { info: { sdkVersion: "old" } });
            await beat(catalog, fresh);
            await catalog.pool.query(
                `UPDATE "${env.cmsSchema}".workers SET updated_at = now() - interval '2 hours' WHERE worker_node_id = $1`,
                [stale],
            );
            await beat(catalog, fresh);   // any heartbeat triggers the prune
            const ids = (await catalog.listWorkers()).map((w) => w.workerNodeId);
            assert(!ids.includes(stale), "hour-silent worker is gone — uniformly, no offline state");
            assert(ids.includes(fresh), "fresh worker survives");

            // The pruned identity returns: same id, info re-written (new row).
            await beat(catalog, stale, { info: { sdkVersion: "new" } });
            const back = (await catalog.listWorkers()).find((w) => w.workerNodeId === stale);
            assertEqual(back.info.sdkVersion, "new", "re-registration resets write-once fields");
        } finally {
            await catalog.close();
        }
    });

    it("three-level resolution: shallow-merge union, worker > pool > fleet, epoch = SUM", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const id = `wr-res-${env.runId}`;
            const domain = `d-res-${env.runId}`;

            await catalog.fleetDirectiveBump(domain, { desired: { a: "fleet", b: "fleet", c: "fleet" } });
            let directives = await beat(catalog, id);
            let d = directives.find((x) => x.domain === domain);
            assertEqual(d.epoch, 1);
            assertEqual(d.desired.a, "fleet");

            await catalog.fleetDirectiveBump(domain, { pool: "test-pool", desired: { b: "pool", d: "pool" } });
            directives = await beat(catalog, id);
            d = directives.find((x) => x.domain === domain);
            assertEqual(d.epoch, 2, "fleet(1) + pool(1)");
            assertEqual(d.desired.a, "fleet", "non-conflicting fleet key survives");
            assertEqual(d.desired.b, "pool", "pool overrides fleet");
            assertEqual(d.desired.d, "pool", "pool-only key present");

            await catalog.fleetDirectiveBump(domain, { workerNodeId: id, desired: { b: "worker", e: "worker" } });
            directives = await beat(catalog, id);
            d = directives.find((x) => x.domain === domain);
            assertEqual(d.epoch, 3, "fleet(1) + pool(1) + worker(1)");
            assertEqual(d.desired.b, "worker", "worker beats pool beats fleet");
            assertEqual(d.desired.c, "fleet");
            assertEqual(d.desired.d, "pool");
            assertEqual(d.desired.e, "worker");

            // A different worker in the same pool: no worker-level contribution.
            const other = `wr-res-other-${env.runId}`;
            const otherDirectives = await beat(catalog, other);
            const od = otherDirectives.find((x) => x.domain === domain);
            assertEqual(od.epoch, 2, "worker-scoped row contributes only to its worker");
            assertEqual(od.desired.b, "pool");
        } finally {
            await catalog.close();
        }
    });

    it("epoch SUM catches the bump that max would miss", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const id = `wr-sum-${env.runId}`;
            const domain = `d-sum-${env.runId}`;
            // fleet row at epoch 3, pool row at epoch 2 → max = 3, sum = 5.
            await catalog.fleetDirectiveBump(domain, { desired: { k: 1 } });
            await catalog.fleetDirectiveBump(domain, {});
            await catalog.fleetDirectiveBump(domain, {});
            await catalog.fleetDirectiveBump(domain, { pool: "test-pool", desired: { k: 2 } });
            await catalog.fleetDirectiveBump(domain, { pool: "test-pool" });
            let d = (await beat(catalog, id)).find((x) => x.domain === domain);
            assertEqual(d.epoch, 5, "3 + 2");

            // Bump the pool row 2 → 3: max stays 3 (MISSED); sum 5 → 6 (caught).
            await catalog.fleetDirectiveBump(domain, { pool: "test-pool" });
            d = (await beat(catalog, id)).find((x) => x.domain === domain);
            assertEqual(d.epoch, 6, "SUM changes on the bump max would miss");
        } finally {
            await catalog.close();
        }
    });

    it("write-side enforcement: canonical worker rows, uniform actuation, doorbell bumps", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const domain = `d-enf-${env.runId}`;
            await expectError(
                catalog.fleetDirectiveBump(domain, { pool: "p1", workerNodeId: "w1" }),
                "FLEET_DIRECTIVE_BAD_SCOPE",
            );
            await catalog.fleetDirectiveBump(domain, { desired: { x: 1 }, actuation: "external" });
            await expectError(
                catalog.fleetDirectiveBump(domain, { pool: "p1", actuation: "worker" }),
                "FLEET_DIRECTIVE_ACTUATION_MISMATCH",
            );
            // Doorbell: null desired keeps the payload, bumps the epoch.
            const epoch = await catalog.fleetDirectiveBump(domain, { actuation: "external" });
            assertEqual(epoch, 2);
            const row = (await catalog.getFleetDirectives()).find((r) => r.domain === domain);
            assertEqual(row.desired.x, 1, "doorbell bump keeps desired");
            assertEqual(row.actuation, "external");

            // agent-packages converges via the fleet-row shim only: scoped
            // rows would be silently dead + skew the summed epoch → rejected.
            await expectError(
                catalog.fleetDirectiveBump("agent-packages", { pool: "some-pool" }),
                "FLEET_DIRECTIVE_BAD_SCOPE",
            );

            // Canonical form is structural, not proc-only: a direct-SQL row
            // specializing BOTH pool and worker violates the table CHECK.
            await expectError(
                catalog.pool.query(
                    `INSERT INTO "${env.cmsSchema}".fleet_directives (domain, pool, worker_node_id) VALUES ($1, 'p', 'w')`,
                    [`d-nc-${env.runId}`],
                ),
                "fleet_directives_canonical_scope",
            );

            // Worker ids that would cross-match every worker-scoped
            // directive (or match nothing) are rejected at the heartbeat.
            await expectError(beat(catalog, "*"), "WORKER_ID_INVALID");
            await expectError(beat(catalog, "  "), "WORKER_ID_INVALID");
        } finally {
            await catalog.close();
        }
    });

    it("worker-scoped directives survive their worker's prune (the laptop case)", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const id = `wr-laptop-${env.runId}`;
            const domain = `d-laptop-${env.runId}`;
            await catalog.fleetDirectiveBump(domain, { desired: { base: true } });
            await catalog.fleetDirectiveBump(domain, { workerNodeId: id, desired: { mine: true } });
            await beat(catalog, id);
            await catalog.pool.query(
                `UPDATE "${env.cmsSchema}".workers SET updated_at = now() - interval '2 hours' WHERE worker_node_id = $1`,
                [id],
            );
            await beat(catalog, `wr-laptop-other-${env.runId}`);   // prunes the laptop
            assert(!(await catalog.listWorkers()).some((w) => w.workerNodeId === id), "laptop pruned");

            // It wakes up tomorrow: same id, directives reacquired.
            const directives = await beat(catalog, id);
            const d = directives.find((x) => x.domain === domain);
            assertEqual(d.desired.mine, true, "worker-scoped row outlives the worker and re-applies");
            assertEqual(d.epoch, 2, "fleet(1) + worker(1)");
        } finally {
            await catalog.close();
        }
    });

    it("agent-packages shims: one continuous counter, mixed-fleet union display", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            // Bumping via the legacy shim moves the directive AND the legacy read.
            const before = await catalog.agentRegistryEpoch();
            await catalog.pool.query(`SELECT "${env.cmsSchema}".cms_agent_registry_bump()`);
            const after = await catalog.agentRegistryEpoch();
            assertEqual(after, before + 1, "legacy bump/epoch shims ride the directive row");
            const directive = (await catalog.getFleetDirectives())
                .find((r) => r.domain === "agent-packages" && r.pool === "*" && r.workerNodeId === "*");
            assertEqual(directive.epoch, after, "one counter, no fork");

            // A NEW-path worker reports via heartbeat state; an OLD-path worker
            // via the legacy upsert; the union shim shows both, newest first.
            const newWorker = `wr-mixed-new-${env.runId}`;
            const oldWorker = `wr-mixed-old-${env.runId}`;
            await catalog.upsertAgentWorkerState(oldWorker, after, { "pkg-x": { semver: "1.0.0", status: "ok" } });
            await beat(catalog, newWorker, {
                state: { "agent-packages": { epoch: after, installed: { "pkg-x": { semver: "1.1.0", status: "ok" } } } },
            });
            const union = await catalog.listAgentWorkerState();
            const newRow = union.find((r) => r.workerNodeId === newWorker);
            const oldRow = union.find((r) => r.workerNodeId === oldWorker);
            assertEqual(newRow.installed["pkg-x"].semver, "1.1.0", "new-path worker surfaces from workers.state");
            assertEqual(oldRow.installed["pkg-x"].semver, "1.0.0", "old-path worker surfaces from the legacy table");
            assertEqual(newRow.epoch, after);

            // The seeded directive rides the worker-actuated protocol.
            const seeded = (await catalog.getFleetDirectives())
                .find((r) => r.domain === "agent-packages" && r.pool === "*" && r.workerNodeId === "*");
            assertEqual(seeded.actuation, "worker", "seeded agent-packages directive is worker-actuated");

            // One malformed state row (heterogeneous laptop builds) must not
            // take down the whole fleet listing — it degrades to epoch 0.
            const malformed = `wr-mixed-bad-${env.runId}`;
            await beat(catalog, malformed, {
                state: { "agent-packages": { epoch: "not-a-number", installed: { x: { status: "ok" } } } },
            });
            const unionWithBad = await catalog.listAgentWorkerState();
            const badRow = unionWithBad.find((r) => r.workerNodeId === malformed);
            assertEqual(badRow.epoch, 0, "malformed epoch degrades to 0 instead of throwing");
            assert(unionWithBad.some((r) => r.workerNodeId === newWorker), "healthy rows unaffected");
        } finally {
            await catalog.close();
        }
    });
});
