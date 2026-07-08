/**
 * runTurn preamble/postamble rules + crash matrix
 * (session-lifecycle-protocol §4.2 and §4.4 F1–F6, in-process form).
 *
 * Crashes are simulated at the protocol's named fault points by aborting a
 * step (throw-action fault injection) and re-running the preamble exactly
 * as a duroxide activity retry would — same inputs, fresh execution. The
 * oracle after every scenario: version chain gap-free, no dirty dir ever
 * trusted, already-committed turns never re-run.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemSessionStore } from "../../src/session-store.ts";
import { runTurnCommit, runTurnPreamble } from "../../src/session-lifecycle.ts";
import {
    clearTurnSentinel,
    readSnapshotMarker,
    readTurnSentinel,
    writeSnapshotMarker,
    writeTurnSentinel,
} from "../../src/snapshot-protocol.ts";
import { makeSessionLayout } from "../helpers/snapshot-conformance.js";

const roots = [];
afterEach(() => {
    delete process.env.PILOTSWARM_FAULT_INJECT;
    for (const root of roots.splice(0)) {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    }
});

function makeHarness() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-lifecycle-"));
    roots.push(root);
    const sessionStateDir = path.join(root, "session-state");
    fs.mkdirSync(sessionStateDir, { recursive: true });
    const store = new FilesystemSessionStore(path.join(root, "session-store"), sessionStateDir);
    const sessionId = `lc-${randomUUID()}`;
    const calls = [];
    const countingStore = {
        probeSnapshot: (...args) => { calls.push("probe"); return store.probeSnapshot(...args); },
        commitSnapshot: (...args) => { calls.push("commit"); return store.commitSnapshot(...args); },
        hydrateSnapshot: (...args) => { calls.push("hydrate"); return store.hydrateSnapshot(...args); },
    };
    let warmDropped = 0;
    const ctxFor = (expectedVersion, turnKey) => ({
        store: countingStore,
        sessionStateDir,
        sessionId,
        expectedVersion,
        turnKey,
        dropWarmSession: async () => { warmDropped++; },
        trace: () => {},
    });
    return {
        root, sessionStateDir, store, sessionId, calls,
        ctxFor,
        sessionDir: path.join(sessionStateDir, sessionId),
        droppedWarm: () => warmDropped,
    };
}

/** Run a full healthy turn: preamble → sentinel → (mutate) → commit. */
async function runHealthyTurn(h, expectedVersion, turnKey, mutation = `turn-${turnKey}`) {
    const ctx = h.ctxFor(expectedVersion, turnKey);
    const pre = await runTurnPreamble(ctx);
    if (pre.kind === "already-committed") return { pre };
    writeTurnSentinel(h.sessionDir, turnKey);
    fs.appendFileSync(path.join(h.sessionDir, "events.jsonl"), `{"m":"${mutation}"}\n`);
    const result = { type: "completed", content: `did ${mutation}` };
    const committed = await runTurnCommit(ctx, pre.baseVersion, result);
    return { pre, committed, result };
}

describe("turn lifecycle preamble", () => {
    it("warm-starts after a single probe (store-wins) when the marker matches the store version+hash", async () => {
        const h = makeHarness();
        makeSessionLayout(h.sessionStateDir, h.sessionId);
        const { committed } = await runHealthyTurn(h, 0, "t1");
        expect(committed.version).toBe(1);
        h.calls.length = 0;

        // Store-wins does ONE metadata probe per turn (never trusting the
        // orchestration's stale expectedVersion); when the local marker names
        // the stored version AND content hash, it warm-starts without hydrating.
        const pre = await runTurnPreamble(h.ctxFor(1, "t2"));
        expect(pre.kind).toBe("warm");
        expect(pre.baseVersion).toBe(1);
        expect(h.calls).toEqual(["probe"]); // one HEAD, then trust local
    });

    it("keeps a clean unmarked dir when the orchestration has no committed version (legacy continuity)", async () => {
        const h = makeHarness();
        makeSessionLayout(h.sessionStateDir, h.sessionId, "warm-legacy");
        const pre = await runTurnPreamble(h.ctxFor(0, "t1"));
        expect(pre.kind).toBe("warm");
        expect(pre.baseVersion).toBe(0);
        // Continuity is probe-gated: an unmarked dir is only trusted after
        // confirming the store holds no versioned chain (a crash inside
        // already-committed recovery of turn 1 leaves exactly this shape).
        expect(h.calls).toEqual(["probe"]);
    });

    it("resolves from the store when an unmarked dir hides a versioned chain (double-crash on turn 1)", async () => {
        const h = makeHarness();
        makeSessionLayout(h.sessionStateDir, h.sessionId);
        // Turn 1 committed (v1 under t1), then crash erased marker+sentinel
        // (hydrate-swap completed, marker write lost). Local dir looks like
        // pristine legacy continuity — but the store knows better.
        await runHealthyTurn(h, 0, "t1");
        fs.rmSync(path.join(h.sessionDir, ".ps-snapshot-version"), { force: true });

        // Retry of turn 1 (same turnKey): must take already-committed
        // recovery, NOT warm-trust the unmarked dir and re-run the body.
        const pre = await runTurnPreamble(h.ctxFor(0, "t1"));
        expect(pre.kind).toBe("already-committed");
        expect(pre.version).toBe(1);

        // A DIFFERENT turn against the same shape hydrates the chain.
        fs.rmSync(path.join(h.sessionDir, ".ps-snapshot-version"), { force: true });
        const pre2 = await runTurnPreamble(h.ctxFor(0, "t9"));
        expect(pre2.kind).toBe("hydrated");
        expect(pre2.baseVersion).toBe(1);
    });

    it("distrusts a marker orphaned by a torn delete (no session layout)", async () => {
        const h = makeHarness();
        makeSessionLayout(h.sessionStateDir, h.sessionId, "orig");
        await runHealthyTurn(h, 0, "t1");

        // Torn recursive delete: session files gone, marker survived.
        for (const f of ["workspace.yaml", "session.db", "events.jsonl"]) {
            fs.rmSync(path.join(h.sessionDir, f), { force: true });
        }
        const pre = await runTurnPreamble(h.ctxFor(1, "t2"));
        expect(pre.kind).toBe("hydrated"); // store copy restored, marker not trusted
        expect(pre.baseVersion).toBe(1);
        expect(fs.existsSync(path.join(h.sessionDir, "workspace.yaml"))).toBe(true);
    });

    it("store-wins: store ahead under a foreign turnKey hydrates the stored version (no fence)", async () => {
        const h = makeHarness();
        makeSessionLayout(h.sessionStateDir, h.sessionId);
        await runHealthyTurn(h, 0, "t1");
        await runHealthyTurn(h, 1, "t2");

        // A stale attempt scheduled against v1 wakes up after the store has
        // advanced to v2 under a different key. The old protocol FENCED here
        // (threw SnapshotConflictError) and bricked the session — this is the
        // incident. Store-wins simply hydrates whatever the store holds and
        // proceeds from it.
        fs.rmSync(h.sessionDir, { recursive: true, force: true });
        const pre = await runTurnPreamble(h.ctxFor(1, "t-zombie"));
        expect(pre.kind).toBe("hydrated");
        expect(pre.baseVersion).toBe(2);
    });

    it("store-wins: a same-version content mismatch (rule-breaking restore) forces a hydrate", async () => {
        const h = makeHarness();
        makeSessionLayout(h.sessionStateDir, h.sessionId);
        await runHealthyTurn(h, 0, "t1"); // store v1 (hash H), marker v1 (hash H)

        // Version alone would warm-start. But the marker's content hash no
        // longer matches the store's v1 — the store's v1 content was swapped
        // out-of-band (an operator restore over the same version number). The
        // ETag CAS cannot see that; the hash gate must, and hydrate the store.
        const stored = await h.store.probeSnapshot(h.sessionId);
        const bogus = "0".repeat(64);
        expect(stored.contentHash).not.toBe(bogus);
        writeSnapshotMarker(h.sessionDir, { version: 1, turnKey: "t1", contentHash: bogus });

        const pre = await runTurnPreamble(h.ctxFor(1, "t2"));
        expect(pre.kind).toBe("hydrated");
        expect(pre.baseVersion).toBe(1);
    });

    it("store-wins: a store below the local marker hydrates and flags regressed", async () => {
        const h = makeHarness();
        makeSessionLayout(h.sessionStateDir, h.sessionId);
        await runHealthyTurn(h, 0, "t1"); // store v1, marker v1

        // Local marker advanced past the store — the store was restored from an
        // OLDER backup (or lost data). Store wins: hydrate what it holds, and
        // report `regressed` so the caller emits session.snapshot_regressed.
        writeSnapshotMarker(h.sessionDir, { version: 5, turnKey: "t-old", contentHash: "0".repeat(64) });
        const pre = await runTurnPreamble(h.ctxFor(5, "t2"));
        expect(pre.kind).toBe("hydrated");
        expect(pre.baseVersion).toBe(1);
        expect(pre.regressed).toEqual({ markerVersion: 5, storeVersion: 1 });
    });

    it("hydrates exactly the stored version when the marker is missing or stale", async () => {
        const h = makeHarness();
        makeSessionLayout(h.sessionStateDir, h.sessionId, "original");
        await runHealthyTurn(h, 0, "t1");
        await runHealthyTurn(h, 1, "t2");

        // Simulate a different worker: no local dir at all.
        fs.rmSync(h.sessionDir, { recursive: true, force: true });
        const pre = await runTurnPreamble(h.ctxFor(2, "t3"));
        expect(pre.kind).toBe("hydrated");
        expect(pre.baseVersion).toBe(2);
        expect(readSnapshotMarker(h.sessionDir)?.version).toBe(2);
        expect(h.droppedWarm()).toBeGreaterThan(0);

        // Simulate the stale-worker case (G4): marker rolled back to v1
        // with old file content — must hydrate FORWARD, never resume stale.
        writeSnapshotMarker(h.sessionDir, { version: 1 });
        fs.writeFileSync(path.join(h.sessionDir, "events.jsonl"), "stale\n");
        const pre2 = await runTurnPreamble(h.ctxFor(2, "t3b"));
        expect(pre2.kind).toBe("hydrated");
        expect(pre2.baseVersion).toBe(2);
        expect(fs.readFileSync(path.join(h.sessionDir, "events.jsonl"), "utf8")).toContain('"m":"turn-t2"');
    });

    it("distrusts a sentinel'd dir even when the marker matches (F1: mid-turn crash, same worker)", async () => {
        const h = makeHarness();
        makeSessionLayout(h.sessionStateDir, h.sessionId);
        await runHealthyTurn(h, 0, "t1");

        // Crash mid-turn-2: sentinel written, body half-applied, no commit.
        writeTurnSentinel(h.sessionDir, "t2");
        fs.appendFileSync(path.join(h.sessionDir, "events.jsonl"), '{"half":"applied"}\n');

        const pre = await runTurnPreamble(h.ctxFor(1, "t2"));
        expect(pre.kind).toBe("hydrated"); // clean v1 restored, dirt discarded
        expect(pre.baseVersion).toBe(1);
        expect(readTurnSentinel(h.sessionDir)).toBeNull();
        expect(fs.readFileSync(path.join(h.sessionDir, "events.jsonl"), "utf8")).not.toContain("half");
    });

    it("recovers an already-committed turn without re-running the body (F3/F4: crash after CAS)", async () => {
        const h = makeHarness();
        makeSessionLayout(h.sessionStateDir, h.sessionId);
        await runHealthyTurn(h, 0, "t1");

        // Attempt of turn 2 that crashed between CAS and marker update:
        // run the real commit, then restore pre-commit local state.
        const ctx = h.ctxFor(1, "t2");
        writeTurnSentinel(h.sessionDir, "t2");
        fs.appendFileSync(path.join(h.sessionDir, "events.jsonl"), '{"m":"turn-2"}\n');
        const storedResult = { type: "completed", content: "turn 2 output" };
        await runTurnCommit(ctx, 1, storedResult);
        // Crash simulation: undo c3/c4 — marker back to v1, sentinel back.
        writeSnapshotMarker(h.sessionDir, { version: 1, turnKey: "t1" });
        writeTurnSentinel(h.sessionDir, "t2");

        // duroxide retry of the SAME turn (same turnKey):
        const pre = await runTurnPreamble(h.ctxFor(1, "t2"));
        expect(pre.kind).toBe("already-committed");
        expect(pre.version).toBe(2);
        expect(pre.result).toEqual(storedResult);
        expect(readSnapshotMarker(h.sessionDir)?.version).toBe(2);
        expect(readTurnSentinel(h.sessionDir)).toBeNull();
    });

    it("falls back to fresh when the store is empty (W3), wiping dirty state", async () => {
        const h = makeHarness();
        makeSessionLayout(h.sessionStateDir, h.sessionId);
        writeTurnSentinel(h.sessionDir, "t1");

        const pre = await runTurnPreamble(h.ctxFor(3, "t1"));
        expect(pre.kind).toBe("fresh");
        expect(pre.lossy).toBe(true); // expected v3 but store had nothing
        expect(fs.existsSync(h.sessionDir)).toBe(false);
    });

    it("trusts a clean local dir over an empty store (best available data)", async () => {
        const h = makeHarness();
        makeSessionLayout(h.sessionStateDir, h.sessionId, "only-copy");
        writeSnapshotMarker(h.sessionDir, { version: 4 });
        // Store empty (never committed / store lost) but dir is clean.
        const pre = await runTurnPreamble(h.ctxFor(7, "t1"));
        expect(pre.kind).toBe("warm");
        expect(pre.baseVersion).toBe(4);
        expect(fs.existsSync(h.sessionDir)).toBe(true);
    });
});

describe("turn lifecycle commit", () => {
    it("chains commits and round-trips the result via .ps-turn-commit.json", async () => {
        const h = makeHarness();
        makeSessionLayout(h.sessionStateDir, h.sessionId);
        const r1 = await runHealthyTurn(h, 0, "t1");
        const r2 = await runHealthyTurn(h, 1, "t2");
        expect(r1.committed.version).toBe(1);
        expect(r2.committed.version).toBe(2);
        const marker = readSnapshotMarker(h.sessionDir);
        expect(marker.version).toBe(2);
        expect(marker.turnKey).toBe("t2");
        expect(readTurnSentinel(h.sessionDir)).toBeNull();

        // The committed result must ride inside the snapshot.
        fs.rmSync(h.sessionDir, { recursive: true, force: true });
        await h.store.hydrateSnapshot(h.sessionId);
        const commitFile = JSON.parse(fs.readFileSync(path.join(h.sessionDir, ".ps-turn-commit.json"), "utf8"));
        expect(commitFile.turnKey).toBe("t2");
        expect(commitFile.result).toEqual(r2.result);
    });

    it("restores the winner's state and result when a racing duplicate committed first", async () => {
        const h = makeHarness();
        makeSessionLayout(h.sessionStateDir, h.sessionId);
        await runHealthyTurn(h, 0, "t1");

        // Racing attempt B (the winner) of turn 2: divergent content + its
        // own recorded result, committed under the SAME turnKey.
        const winnerResult = { type: "completed", content: "winner output" };
        fs.appendFileSync(path.join(h.sessionDir, "events.jsonl"), '{"who":"winner"}\n');
        const winnerCommitFile = path.join(h.sessionDir, ".ps-turn-commit.json");
        fs.writeFileSync(winnerCommitFile, JSON.stringify({ turnKey: "t2", result: winnerResult }));
        await h.store.commitSnapshot(h.sessionId, { baseVersion: 1, turnKey: "t2" });

        // Loser attempt A: different local mutation, same turn, commits last.
        fs.writeFileSync(path.join(h.sessionDir, "events.jsonl"), '{"who":"loser"}\n');
        const ctx = h.ctxFor(1, "t2");
        writeTurnSentinel(h.sessionDir, "t2");
        const outcome = await runTurnCommit(ctx, 1, { type: "completed", content: "loser output" });

        expect(outcome.alreadyCommitted).toBe(true);
        expect(outcome.version).toBe(2);
        expect(outcome.storedResult).toEqual(winnerResult); // §3.2 restore-not-replay
        // Local state is the winner's lineage, marker matches, sentinel gone.
        expect(fs.readFileSync(path.join(h.sessionDir, "events.jsonl"), "utf8")).toContain("winner");
        expect(readSnapshotMarker(h.sessionDir)?.version).toBe(2);
        expect(readTurnSentinel(h.sessionDir)).toBeNull();
    });

    it("F6b: crash between tar rename and meta rename leaves the store consistent at the old version", async () => {
        const h = makeHarness();
        makeSessionLayout(h.sessionStateDir, h.sessionId, "golden");
        await runHealthyTurn(h, 0, "t1");
        const v1Events = fs.readFileSync(path.join(h.sessionDir, "events.jsonl"), "utf8");

        // Attempt of turn 2 that dies between the two renames.
        process.env.PILOTSWARM_FAULT_INJECT = "store.commit.tar-renamed:throw";
        const ctx = h.ctxFor(1, "t2");
        writeTurnSentinel(h.sessionDir, "t2");
        fs.appendFileSync(path.join(h.sessionDir, "events.jsonl"), '{"m":"turn2-partial"}\n');
        await expect(runTurnCommit(ctx, 1, { type: "completed", content: "x" })).rejects.toThrow(/fault-injection/);
        delete process.env.PILOTSWARM_FAULT_INJECT;

        // The meta rename is the commit point: the store still reports v1
        // and hydrates v1 bytes — never post-turn bytes under the old label.
        const probe = await h.store.probeSnapshot(h.sessionId);
        expect(probe.version).toBe(1);
        expect(probe.turnKey).toBe("t1");
        fs.rmSync(h.sessionDir, { recursive: true, force: true });
        const hydrated = await h.store.hydrateSnapshot(h.sessionId);
        expect(hydrated.version).toBe(1);
        expect(fs.readFileSync(path.join(h.sessionDir, "events.jsonl"), "utf8")).toBe(v1Events);
    });

    it("store-wins: a foreign CAS advance leaves the turn unpublished (superseded), sentinel dirty, no throw", async () => {
        const h = makeHarness();
        makeSessionLayout(h.sessionStateDir, h.sessionId);
        await runHealthyTurn(h, 0, "t1");

        // A foreign worker advances the store to v2 out-of-band while our turn
        // (based on v1) runs — the H3 mid-turn landing.
        await h.store.commitSnapshot(h.sessionId, { baseVersion: 1, turnKey: "t-foreign" });

        const ctx = h.ctxFor(1, "t-mine");
        writeTurnSentinel(h.sessionDir, "t-mine");
        // Old protocol threw (brick). Store-wins gives up the publish: the turn
        // result still returns to the orchestration, but the store is NOT
        // advanced and the next preamble rehydrates the winner.
        const committed = await runTurnCommit(ctx, 1, { type: "completed", content: "x" });
        expect(committed.published).toBe(false);
        expect(committed.unpublishedReason).toBe("superseded");
        // The winner's store coordinates ride out on the outcome so the emitted
        // snapshot_unpublished event can name what superseded this turn (F3).
        expect(committed.observedStoreVersion).toBe(2);
        expect(committed.observedStoreTurnKey).toBe("t-foreign");
        // Sentinel must survive so the next preamble distrusts the dir and
        // rehydrates the foreign winner (v2).
        expect(readTurnSentinel(h.sessionDir)).not.toBeNull();
    });

    it("store-wins: after a superseded commit the next turn rehydrates the winner and commits — no stuck loop (incident self-heal)", async () => {
        const h = makeHarness();
        makeSessionLayout(h.sessionStateDir, h.sessionId);
        await runHealthyTurn(h, 0, "t1"); // store v1

        // A discarded/foreign turn advances the store to v2 while our turn runs.
        await h.store.commitSnapshot(h.sessionId, { baseVersion: 1, turnKey: "t-zombie" });

        // Our turn (base v1) commits → superseded, sentinel left dirty.
        const ctx2 = h.ctxFor(1, "t2");
        writeTurnSentinel(h.sessionDir, "t2");
        fs.appendFileSync(path.join(h.sessionDir, "events.jsonl"), '{"m":"superseded-turn"}\n');
        const superseded = await runTurnCommit(ctx2, 1, { type: "completed", content: "x" });
        expect(superseded.published).toBe(false);

        // The NEXT turn must NOT loop forever (the old brick did). It sees the
        // dirty sentinel + store v2, rehydrates v2, and commits v3 cleanly.
        const t3 = await runHealthyTurn(h, 1, "t3");
        expect(t3.pre.kind).toBe("hydrated");
        expect(t3.pre.baseVersion).toBe(2);
        expect(t3.committed.published).toBe(true);
        expect(t3.committed.version).toBe(3);
    });

    it("a user-stopped turn is NOT committed, so the next turn re-hydrates and commits without a CAS conflict", async () => {
        // Regression: stop-turn snapshot CAS divergence (waldemort session
        // 0addb1e1, 2026-07-07). A user Stop during a long turn made the
        // race-loser runTurn commit its snapshot (v+1), but the orchestration
        // discarded the turn and kept state.snapshotVersion at the base — so
        // every later turn failed "Snapshot CAS conflict: expected N, found
        // N+1". The fix: runTurnCommit skips the commit for a "stopped" result.
        const h = makeHarness();
        makeSessionLayout(h.sessionStateDir, h.sessionId);

        // Turn 1 commits v1.
        const t1 = await runHealthyTurn(h, 0, "t1");
        expect(t1.committed.version).toBe(1);

        // Turn 2 runs, but the user clicks Stop mid-flight: ManagedSession
        // reclassifies the unwind as { type: "stopped" }. The commit MUST be
        // skipped — committing here is the divergence bug.
        const ctx2 = h.ctxFor(1, "t2");
        const pre2 = await runTurnPreamble(ctx2);
        expect(pre2.kind).toBe("warm");
        expect(pre2.baseVersion).toBe(1);
        writeTurnSentinel(h.sessionDir, "t2");
        fs.appendFileSync(path.join(h.sessionDir, "events.jsonl"), '{"m":"partial-stopped-turn"}\n');
        const stopped = await runTurnCommit(ctx2, pre2.baseVersion, { type: "stopped", reason: "Stopped by user" });

        // Commit skipped: outcome carries the BASE version, the store did NOT
        // advance (would be 2 without the guard), and the sentinel is left
        // dirty so the partial turn is distrusted.
        expect(stopped.version).toBe(1);
        expect(stopped.alreadyCommitted).toBe(false);
        expect((await h.store.probeSnapshot(h.sessionId)).version).toBe(1);
        expect(readTurnSentinel(h.sessionDir)).not.toBeNull();

        // Turn 3 (the next real turn) sees the dirty sentinel, resolves from the
        // store at v1, and commits v2 cleanly — the zombie-duplicate fence that
        // produced the CAS conflict never fires.
        const ctx3 = h.ctxFor(1, "t3");
        const pre3 = await runTurnPreamble(ctx3);
        expect(pre3.kind).toBe("hydrated");
        expect(pre3.baseVersion).toBe(1);
        writeTurnSentinel(h.sessionDir, "t3");
        fs.appendFileSync(path.join(h.sessionDir, "events.jsonl"), '{"m":"turn3"}\n');
        const t3 = await runTurnCommit(ctx3, pre3.baseVersion, { type: "completed", content: "turn3" });
        expect(t3.version).toBe(2);
        expect(t3.alreadyCommitted).toBe(false);
    });

    it("F2: crash before the CAS write → retry re-runs the turn from clean state", async () => {
        const h = makeHarness();
        makeSessionLayout(h.sessionStateDir, h.sessionId);
        await runHealthyTurn(h, 0, "t1");

        // Attempt: sentinel + mutation, then the CAS write itself aborts.
        process.env.PILOTSWARM_FAULT_INJECT = "store.commit.before-write:throw";
        const ctx = h.ctxFor(1, "t2");
        writeTurnSentinel(h.sessionDir, "t2");
        fs.appendFileSync(path.join(h.sessionDir, "events.jsonl"), '{"half":"turn2"}\n');
        await expect(runTurnCommit(ctx, 1, { type: "completed", content: "x" })).rejects.toThrow(/fault-injection/);
        delete process.env.PILOTSWARM_FAULT_INJECT;

        // Retry (fresh activity): nothing committed, dirty dir discarded,
        // body re-runs on clean v1 and commits v2.
        const retry = await runHealthyTurn(h, 1, "t2", "turn2-retry");
        expect(retry.pre.kind).toBe("hydrated");
        expect(retry.committed.version).toBe(2);
        const probe = await h.store.probeSnapshot(h.sessionId);
        expect(probe.version).toBe(2);
        expect(probe.turnKey).toBe("t2");
    });

    it("F6: crash mid-hydrate never leaves a plausible-looking dir", async () => {
        const h = makeHarness();
        makeSessionLayout(h.sessionStateDir, h.sessionId, "golden");
        await runHealthyTurn(h, 0, "t1");
        const goldenEvents = fs.readFileSync(path.join(h.sessionDir, "events.jsonl"), "utf8");

        // Make local dirty + crash the hydrate right before the atomic swap.
        writeTurnSentinel(h.sessionDir, "t2");
        fs.writeFileSync(path.join(h.sessionDir, "events.jsonl"), "dirty\n");
        process.env.PILOTSWARM_FAULT_INJECT = "store.hydrate.before-swap:throw";
        await expect(runTurnPreamble(h.ctxFor(1, "t2"))).rejects.toThrow(/fault-injection/);
        delete process.env.PILOTSWARM_FAULT_INJECT;

        // The old dir survived intact (swap never happened), sentinel still
        // marks it dirty; no half-extracted dir was left in its place.
        expect(fs.readFileSync(path.join(h.sessionDir, "events.jsonl"), "utf8")).toBe("dirty\n");
        expect(readTurnSentinel(h.sessionDir)).not.toBeNull();

        // Retry completes the hydrate and restores golden state.
        const pre = await runTurnPreamble(h.ctxFor(1, "t2"));
        expect(pre.kind).toBe("hydrated");
        expect(fs.readFileSync(path.join(h.sessionDir, "events.jsonl"), "utf8")).toBe(goldenEvents);
        clearTurnSentinel(h.sessionDir);
    });

    it("chaos: random crash points over a 12-turn conversation stay gap-free and lossless", { timeout: 60_000 }, async () => {
        const h = makeHarness();
        makeSessionLayout(h.sessionStateDir, h.sessionId);
        const faultPoints = [
            null,
            "store.commit.before-write:throw",
            "store.hydrate.before-swap:throw",
            null,
            "turn.commit.after-cas:throw",
        ];
        let expected = 0;
        for (let turn = 1; turn <= 12; turn++) {
            const turnKey = `chaos-t${turn}`;
            const fault = faultPoints[(turn * 7) % faultPoints.length];
            if (fault) {
                process.env.PILOTSWARM_FAULT_INJECT = fault;
                try {
                    await runHealthyTurn(h, expected, turnKey, `chaos-${turn}`);
                } catch {
                    // crashed attempt — a retry follows below
                }
                delete process.env.PILOTSWARM_FAULT_INJECT;
            }
            // The (re)try that duroxide would issue:
            const attempt = await runHealthyTurn(h, expected, turnKey, `chaos-${turn}`);
            const version = attempt.committed?.version ?? attempt.pre.version;
            expect(version).toBe(expected + 1); // I1: gap-free chain
            expected = version;
        }
        const probe = await h.store.probeSnapshot(h.sessionId);
        expect(probe.version).toBe(12);
        expect(readTurnSentinel(h.sessionDir)).toBeNull();
        expect(readSnapshotMarker(h.sessionDir)?.version).toBe(12);
    });
});
