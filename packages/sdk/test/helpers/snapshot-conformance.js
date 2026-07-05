/**
 * Versioned CAS snapshot-store conformance suite
 * (docs/proposals/session-lifecycle-protocol.md §4.1).
 *
 * One suite, every backend: the protocol's correctness rests on all
 * implementations agreeing on version monotonicity, CAS semantics,
 * idempotent commit retries, and atomic hydrates.
 *
 * The context factory returns:
 *   { store, sessionStateDir, newSessionId(), writeLegacySnapshot(id) }
 * `store` must implement SessionStateStore + VersionedSnapshotStore over
 * `sessionStateDir`.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SnapshotConflictError } from "../../src/snapshot-protocol.ts";

export function makeSessionLayout(sessionStateDir, sessionId, seedText = "seed") {
    const dir = path.join(sessionStateDir, sessionId);
    fs.mkdirSync(path.join(dir, "checkpoints"), { recursive: true });
    fs.mkdirSync(path.join(dir, "files"), { recursive: true });
    fs.writeFileSync(path.join(dir, "workspace.yaml"), "cwd: /tmp\n");
    fs.writeFileSync(path.join(dir, "session.db"), `db-${seedText}`);
    fs.writeFileSync(path.join(dir, "events.jsonl"), `{"seed":"${seedText}"}\n`);
    fs.writeFileSync(path.join(dir, "files", "notes.md"), `notes ${seedText}\n`);
    return dir;
}

function digestSessionDir(dir) {
    const hash = crypto.createHash("sha256");
    const walk = (current, rel = "") => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            // Protocol-local files are intentionally outside snapshot equality.
            if (entry.name.startsWith(".ps-snapshot-version") || entry.name.startsWith(".ps-turn-inprogress")) continue;
            if (entry.name.match(/^inuse\..+\.lock$/)) continue;
            const abs = path.join(current, entry.name);
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                hash.update(`d:${relPath}\n`);
                walk(abs, relPath);
            } else {
                hash.update(`f:${relPath}:`);
                hash.update(fs.readFileSync(abs));
                hash.update("\n");
            }
        }
    };
    walk(dir);
    return hash.digest("hex");
}

export function registerSnapshotConformanceSuite(label, makeContext, { timeout = 120_000 } = {}) {
    describe(label, () => {
        it("creates version 1 from an empty store and probes it back", { timeout }, async () => {
            const ctx = await makeContext();
            const id = ctx.newSessionId();
            makeSessionLayout(ctx.sessionStateDir, id, "v1");

            const committed = await ctx.store.commitSnapshot(id, { baseVersion: 0, turnKey: "turn-a" });
            expect(committed.version).toBe(1);
            expect(committed.alreadyCommitted).toBe(false);
            expect(committed.contentHash).toMatch(/^[0-9a-f]{64}$/);

            const probe = await ctx.store.probeSnapshot(id);
            expect(probe.exists).toBe(true);
            expect(probe.version).toBe(1);
            expect(probe.turnKey).toBe("turn-a");
            expect(probe.contentHash).toBe(committed.contentHash);
        });

        it("advances the chain monotonically and only from the stored base", { timeout }, async () => {
            const ctx = await makeContext();
            const id = ctx.newSessionId();
            makeSessionLayout(ctx.sessionStateDir, id, "gen1");
            const v1 = await ctx.store.commitSnapshot(id, { baseVersion: 0, turnKey: "t1" });
            expect(v1.version).toBe(1);

            fs.appendFileSync(path.join(ctx.sessionStateDir, id, "events.jsonl"), '{"turn":2}\n');
            const v2 = await ctx.store.commitSnapshot(id, { baseVersion: 1, turnKey: "t2" });
            expect(v2.version).toBe(2);
            expect(v2.contentHash).not.toBe(v1.contentHash);
        });

        it("treats a same-turnKey retry at base+1 as idempotent success", { timeout }, async () => {
            const ctx = await makeContext();
            const id = ctx.newSessionId();
            makeSessionLayout(ctx.sessionStateDir, id, "retry");
            await ctx.store.commitSnapshot(id, { baseVersion: 0, turnKey: "t1" });
            const first = await ctx.store.commitSnapshot(id, { baseVersion: 1, turnKey: "t2" });
            expect(first.version).toBe(2);

            // The crashed-attempt retry: same turnKey, same base.
            const retry = await ctx.store.commitSnapshot(id, { baseVersion: 1, turnKey: "t2" });
            expect(retry.alreadyCommitted).toBe(true);
            expect(retry.version).toBe(2);
        });

        it("fences a foreign writer with SnapshotConflictError", { timeout }, async () => {
            const ctx = await makeContext();
            const id = ctx.newSessionId();
            makeSessionLayout(ctx.sessionStateDir, id, "fence");
            await ctx.store.commitSnapshot(id, { baseVersion: 0, turnKey: "t1" });
            await ctx.store.commitSnapshot(id, { baseVersion: 1, turnKey: "t2" });

            // A stale writer based on v1 with a DIFFERENT turn.
            let conflict = null;
            try {
                await ctx.store.commitSnapshot(id, { baseVersion: 1, turnKey: "t-foreign" });
            } catch (error) {
                conflict = error;
            }
            expect(conflict).toBeInstanceOf(SnapshotConflictError);
            expect(conflict.storedVersion).toBe(2);
            expect(conflict.storedTurnKey).toBe("t2");
        });

        it("hydrates byte-exact content, atomically replacing stale local state", { timeout }, async () => {
            const ctx = await makeContext();
            const id = ctx.newSessionId();
            const dir = makeSessionLayout(ctx.sessionStateDir, id, "golden");
            const goldenDigest = digestSessionDir(dir);
            await ctx.store.commitSnapshot(id, { baseVersion: 0, turnKey: "t1" });

            // Corrupt local state: stale garbage that must vanish.
            fs.writeFileSync(path.join(dir, "session.db"), "corrupted");
            fs.writeFileSync(path.join(dir, "garbage.tmp"), "junk");

            const hydrated = await ctx.store.hydrateSnapshot(id);
            expect(hydrated.version).toBe(1);
            expect(hydrated.turnKey).toBe("t1");
            expect(fs.existsSync(path.join(dir, "garbage.tmp"))).toBe(false);
            expect(digestSessionDir(dir)).toBe(goldenDigest);
        });

        it("reports legacy (unversioned) snapshots as version 0 and upgrades them on commit", { timeout }, async () => {
            const ctx = await makeContext();
            const id = ctx.newSessionId();
            makeSessionLayout(ctx.sessionStateDir, id, "legacy");
            await ctx.writeLegacySnapshot(id);

            const probe = await ctx.store.probeSnapshot(id);
            expect(probe.exists).toBe(true);
            expect(probe.version).toBe(0);
            expect(probe.legacy).toBe(true);

            const committed = await ctx.store.commitSnapshot(id, { baseVersion: 0, turnKey: "t1" });
            expect(committed.version).toBe(1);
            const upgraded = await ctx.store.probeSnapshot(id);
            expect(upgraded.legacy).toBeUndefined();
        });

        it("restarts the chain at base+1 when the store lost the snapshot", { timeout }, async () => {
            const ctx = await makeContext();
            const id = ctx.newSessionId();
            makeSessionLayout(ctx.sessionStateDir, id, "lost");
            // Orchestration believes v5 committed; the store has nothing.
            const committed = await ctx.store.commitSnapshot(id, { baseVersion: 5, turnKey: "t6" });
            expect(committed.version).toBe(6);
        });

        it("lets exactly one of N racing commits win; losers get the winner's coordinates", { timeout }, async () => {
            const ctx = await makeContext();
            const id = ctx.newSessionId();
            makeSessionLayout(ctx.sessionStateDir, id, "race");
            await ctx.store.commitSnapshot(id, { baseVersion: 0, turnKey: "t0" });

            const racers = ["r1", "r2", "r3", "r4"].map((turnKey) =>
                ctx.store.commitSnapshot(id, { baseVersion: 1, turnKey })
                    .then((result) => ({ status: "won", turnKey, result }))
                    .catch((error) => ({ status: "lost", turnKey, error })),
            );
            const outcomes = await Promise.all(racers);
            const winners = outcomes.filter((o) => o.status === "won");
            const losers = outcomes.filter((o) => o.status === "lost");
            expect(winners.length).toBe(1);
            expect(winners[0].result.version).toBe(2);
            expect(losers.length).toBe(3);
            for (const loser of losers) {
                expect(loser.error).toBeInstanceOf(SnapshotConflictError);
                expect(loser.error.storedVersion).toBe(2);
                expect(loser.error.storedTurnKey).toBe(winners[0].turnKey);
            }
        });

        it("fences legacy dehydrate/checkpoint from clobbering a versioned snapshot", { timeout }, async () => {
            const ctx = await makeContext();
            const id = ctx.newSessionId();
            const dir = makeSessionLayout(ctx.sessionStateDir, id, "protected");
            const committed = await ctx.store.commitSnapshot(id, { baseVersion: 0, turnKey: "t1" });

            // A stray legacy checkpoint (e.g. from an in-flight 1.0.56
            // execution) must not touch the CAS-protected chain.
            fs.appendFileSync(path.join(dir, "events.jsonl"), '{"stale":"writer"}\n');
            await ctx.store.checkpoint(id);
            const afterCheckpoint = await ctx.store.probeSnapshot(id);
            expect(afterCheckpoint.version).toBe(1);
            expect(afterCheckpoint.legacy).toBeUndefined();
            expect(afterCheckpoint.contentHash).toBe(committed.contentHash);

            // Legacy dehydrate degrades to release: no write, local freed.
            await ctx.store.dehydrate(id, { reason: "test" });
            expect(fs.existsSync(dir)).toBe(false);
            const afterDehydrate = await ctx.store.probeSnapshot(id);
            expect(afterDehydrate.version).toBe(1);
            expect(afterDehydrate.contentHash).toBe(committed.contentHash);
        });

        it("excludes the marker and sentinel from snapshots but ships .ps-turn-commit.json", { timeout }, async () => {
            const ctx = await makeContext();
            const id = ctx.newSessionId();
            const dir = makeSessionLayout(ctx.sessionStateDir, id, "excl");
            fs.writeFileSync(path.join(dir, ".ps-snapshot-version"), '{"version":999}');
            fs.writeFileSync(path.join(dir, ".ps-turn-inprogress"), '{"turnKey":"junk"}');
            fs.writeFileSync(path.join(dir, ".ps-turn-commit.json"), '{"turnKey":"t1","result":{"type":"completed","content":"hi"}}');

            await ctx.store.commitSnapshot(id, { baseVersion: 0, turnKey: "t1" });
            fs.rmSync(dir, { recursive: true, force: true });
            await ctx.store.hydrateSnapshot(id);

            expect(fs.existsSync(path.join(dir, ".ps-snapshot-version"))).toBe(false);
            expect(fs.existsSync(path.join(dir, ".ps-turn-inprogress"))).toBe(false);
            expect(fs.existsSync(path.join(dir, ".ps-turn-commit.json"))).toBe(true);
        });
    });
}
