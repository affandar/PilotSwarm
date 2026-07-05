/**
 * LITERAL crash matrix (session lifecycle protocol §4.4) — real process
 * kills at exact protocol boundaries, real duroxide re-dispatch, real LLM
 * turns, shared filesystem snapshot store across separate worker processes.
 *
 * Each scenario:
 *   1. forks worker A with PILOTSWARM_FAULT_INJECT armed (exit(137) at a
 *      named boundary, usually on the 2nd hit so turn 1 commits healthy),
 *   2. runs turn 1 healthy, sends turn 2, and watches A die AT the boundary,
 *   3. forks a clean worker B; duroxide re-dispatches the in-flight turn
 *      (work-item lock 2s + session lock ~30s reclaim),
 *   4. asserts the ORACLE: the client gets a reply, the store's version
 *      chain is exactly right (recovery must never double-commit a turn),
 *      the recovering worker's dir ends clean (marker == store version, no
 *      sentinel), and no lossy replay occurred.
 *
 * The invariant distinguishing pre-CAS from post-CAS kills:
 *   - kill BEFORE the CAS  → the turn re-RUNS on B  → store ends at v2
 *     because B committed it (B hydrates v1 first).
 *   - kill AFTER the CAS   → already-committed recovery → store ends at v2
 *     because A committed it; B must NOT commit again (v3 would mean the
 *     turn double-applied).
 * A follow-up turn 3 then proves the session converged (v3, correct reply).
 */
import { describe, it, beforeAll, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { PilotSwarmClient } from "../helpers/local-workers.js";
import { forkKillWorker, expectFaultDeath, killStoreDir } from "../helpers/kill-harness.js";
import { FilesystemSessionStore } from "../../src/session-store.ts";
import { readSnapshotMarker, readTurnSentinel } from "../../src/snapshot-protocol.ts";
import { ONEWORD_CONFIG } from "../helpers/fixtures.js";
import { assert, assertEqual } from "../helpers/assertions.js";

// Each scenario pays ~30-40s of duroxide session-lock reclaim after the
// kill (work-item lock is tuned to 2s; the session lock is not exposed).
const TIMEOUT = 420_000;
const REPLY_TIMEOUT = 240_000;
const getEnv = useSuiteEnv(import.meta.url);

beforeAll(async () => { await preflightChecks(); });

const liveWorkers = [];
afterEach(async () => {
    for (const w of liveWorkers.splice(0)) {
        try { await w.stop(); } catch {}
    }
});

function storeFor(env) {
    const storeDir = killStoreDir(env);
    return { store: new FilesystemSessionStore(storeDir, env.sessionStateDir), storeDir };
}

function makeClient(env) {
    return new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
    });
}

/**
 * Shared scenario driver: healthy turn 1 on A, kill A at `fault` during
 * turn 2, recover on B, verify the oracle, then prove convergence with
 * turn 3.
 *
 * @param {"reran"|"recovered"} turn2Mode  pre-CAS kills re-run the turn on
 *   B; post-CAS kills must adopt A's commit without re-committing.
 */
async function runKillScenario(env, { name, fault, turn2Mode }) {
    const { store } = storeFor(env);
    const workerA = forkKillWorker(env, `${name}-a`, { faultInject: fault });
    liveWorkers.push(workerA);
    await workerA.ready;

    const client = makeClient(env);
    await client.start();
    let workerB = null;
    try {
        const session = await client.createSession(ONEWORD_CONFIG);
        const sessionId = session.sessionId;

        // Turn 1: healthy commit on A (fault fires on 2nd hit).
        const r1 = await session.sendAndWait("What is 2+2? Answer with just the number.", REPLY_TIMEOUT);
        assert(r1 && r1.length > 0, `${name}: turn 1 should reply`);
        const v1 = await store.probeSnapshot(sessionId);
        assertEqual(v1.version, 1, `${name}: turn 1 must commit v1`);

        // Turn 2: worker A dies AT the armed boundary.
        await session.send("What is 3+3? Answer with just the number.");
        await expectFaultDeath(workerA, name);

        // Recovery: clean worker B; duroxide re-dispatches the turn.
        workerB = forkKillWorker(env, `${name}-b`);
        liveWorkers.push(workerB);
        await workerB.ready;

        const r2 = await session.wait(REPLY_TIMEOUT);
        assert(r2 && r2.length > 0, `${name}: recovered turn 2 should reply (got: ${r2})`);

        // Version-chain oracle: v2 exactly — never v3 (a post-CAS kill that
        // re-committed would double-apply the turn), never v1 (a pre-CAS
        // kill whose re-run vanished).
        const v2 = await store.probeSnapshot(sessionId);
        assertEqual(v2.version, 2, `${name}: after recovery the store must be at exactly v2 (${turn2Mode})`);

        // B's local dir must end clean: marker at the committed version,
        // sentinel cleared, real session files present.
        const bDir = join(workerB.stateDir, sessionId);
        assert(existsSync(join(bDir, "workspace.yaml")), `${name}: worker B should hold the hydrated session`);
        assertEqual(readSnapshotMarker(bDir)?.version, 2, `${name}: worker B marker must match the store`);
        assert(readTurnSentinel(bDir) === null, `${name}: no sentinel may survive recovery`);

        // No lossy replay: the recovery path must have been store-driven.
        assert(
            !workerB.logs.some((l) => l.includes("lossy") || l.includes("SnapshotConflict")),
            `${name}: worker B must not take a lossy or conflicted path:\n${workerB.logs.filter((l) => l.includes("lossy") || l.includes("SnapshotConflict")).join("\n")}`,
        );

        // Convergence: turn 3 runs normally on B and extends the chain.
        const r3 = await session.sendAndWait("What is 5+5? Answer with just the number.", REPLY_TIMEOUT);
        assert(r3 && r3.length > 0, `${name}: turn 3 should reply`);
        const v3 = await store.probeSnapshot(sessionId);
        assertEqual(v3.version, 3, `${name}: turn 3 must commit v3`);
    } finally {
        await client.stop();
    }
}

describe("Literal fault injection: real kills at protocol boundaries", () => {
    it("F2-live: kill before the CAS write → turn re-runs from clean committed state", { timeout: TIMEOUT }, async () => {
        await runKillScenario(getEnv(), {
            name: "f2",
            fault: "turn.commit.before-cas:exit:2",
            turn2Mode: "reran",
        });
    });

    it("F3-live: kill after the CAS, before the marker → already-committed recovery, no re-run", { timeout: TIMEOUT }, async () => {
        await runKillScenario(getEnv(), {
            name: "f3",
            fault: "turn.commit.after-cas:exit:2",
            turn2Mode: "recovered",
        });
    });

    it("F4-live: kill after the marker, before the sentinel clear → recovery via sentinel distrust", { timeout: TIMEOUT }, async () => {
        await runKillScenario(getEnv(), {
            name: "f4",
            fault: "turn.commit.after-marker:exit:2",
            turn2Mode: "recovered",
        });
    });

    it("F5-live: kill after the full commit, before duroxide records completion → idempotent retry", { timeout: TIMEOUT }, async () => {
        await runKillScenario(getEnv(), {
            name: "f5",
            fault: "turn.commit.after-sentinel-clear:exit:2",
            turn2Mode: "recovered",
        });
    });

    it("F6b-live: kill between the tar rename and the meta rename → store stays consistent, turn re-runs", { timeout: TIMEOUT }, async () => {
        await runKillScenario(getEnv(), {
            name: "f6b",
            fault: "store.commit.tar-renamed:exit:2",
            turn2Mode: "reran",
        });
    });

    it("F6-live: worker dies mid-hydrate swap → next worker hydrates atomically and completes the turn", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const { store } = storeFor(env);

        // Phase 1: healthy turn 1 on A, then hard-kill A (plain crash — the
        // session must migrate).
        const workerA = forkKillWorker(env, "f6-a");
        liveWorkers.push(workerA);
        await workerA.ready;
        const client = makeClient(env);
        await client.start();
        let sessionId;
        try {
            const session = await client.createSession(ONEWORD_CONFIG);
            sessionId = session.sessionId;
            const r1 = await session.sendAndWait("What is 2+2? Answer with just the number.", REPLY_TIMEOUT);
            assert(r1 && r1.length > 0, "f6: turn 1 should reply");
            await workerA.killHard();

            // Phase 2: worker B armed to die mid-hydrate swap on its first
            // hydrate; the pending turn 2 kills it.
            const workerB = forkKillWorker(env, "f6-b", { faultInject: "store.hydrate.before-swap:exit:1" });
            liveWorkers.push(workerB);
            await workerB.ready;
            await session.send("What is 3+3? Answer with just the number.");
            await expectFaultDeath(workerB, "f6");

            // B must not have left a plausible-looking half-hydrated dir:
            // the swap never happened, so either nothing or no marker.
            const bDir = join(workerB.stateDir, sessionId);
            assert(readSnapshotMarker(bDir) === null, "f6: half-hydrated dir must not carry a version marker");

            // Phase 3: clean worker C completes the turn losslessly.
            const workerC = forkKillWorker(env, "f6-c");
            liveWorkers.push(workerC);
            await workerC.ready;
            const r2 = await session.wait(REPLY_TIMEOUT);
            assert(r2 && r2.length > 0, `f6: recovered turn 2 should reply (got: ${r2})`);
            const probe = await store.probeSnapshot(sessionId);
            assertEqual(probe.version, 2, "f6: turn 2 must commit v2 exactly once");
            const cDir = join(workerC.stateDir, sessionId);
            assertEqual(readSnapshotMarker(cDir)?.version, 2, "f6: worker C marker must match the store");
            assert(
                !workerC.logs.some((l) => l.includes("lossy")),
                "f6: recovery must be store-driven, not lossy",
            );
        } finally {
            await client.stop();
        }
    });
});
