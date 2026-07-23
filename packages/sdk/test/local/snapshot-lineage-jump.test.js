/**
 * Layer 2 of the store-wins snapshot protocol (docs/proposals/snapshot-store-wins.md):
 * the 1.0.59 orchestration version bump that adds the `session.snapshot_lineage_jump`
 * observability event at the turn-result adoption site.
 *
 * Two things must hold and are guarded here:
 *   1. VERSION CEREMONY — 1.0.58 through 1.0.64 are frozen and registered;
 *      latest is 1.0.65.
 *   2. FREEZE BOUNDARY — the durable yield exists from 1.0.59 onward, never in
 *      frozen 1.0.58 (in-flight 1.0.58 histories recorded WITHOUT it and would
 *      fail replay against a mutated handler — the beae878 incident class).
 *   3. BEHAVIOUR — the event fires when the adopted store version jumps past
 *      prior+1 (a discarded/foreign turn published in the gap), and NOT on a
 *      normal +1 advance.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    DURABLE_SESSION_ORCHESTRATION_REGISTRY as REGISTRY,
    DURABLE_SESSION_LATEST_VERSION as LATEST,
} from "../../src/orchestration-registry.ts";
import * as dispatcher from "../../src/orchestration.ts";

describe("orchestration version registry", () => {
    it("latest is 1.0.66, registered, and exported from the dispatcher", () => {
        expect(LATEST).toBe("1.0.66");
        const latest = REGISTRY.find((e) => e.version === LATEST);
        expect(latest?.handler).toBeTypeOf("function");
        expect(latest.handler.name).toBe("durableSessionOrchestration_1_0_66");
        expect(dispatcher.durableSessionOrchestration_1_0_66).toBeTypeOf("function");
    });

    it("freezes 1.0.64 and 1.0.65 as distinct registered handlers", () => {
        const latest = REGISTRY.find((e) => e.version === LATEST);
        for (const version of ["1.0.64", "1.0.65"]) {
            const frozen = REGISTRY.find((e) => e.version === version);
            expect(frozen?.handler).toBeTypeOf("function");
            expect(frozen.handler.name).toBe(`durableSessionOrchestration_${version.replaceAll(".", "_")}`);
            expect(frozen.handler).not.toBe(latest.handler); // frozen != latest
        }
    });

    it("frozen 1.0.64 and 1.0.65 hardcode their own version strings", () => {
        // A frozen dir must never derive its identity from the floating
        // DURABLE_SESSION_LATEST_VERSION: a frozen handler that believes it
        // is latest never upgrades in-flight histories and can diverge on
        // replayed continue-as-news (the beae878 incident class).
        const frozen164 = readFileSync(new URL("../../src/orchestration_1_0_64/runtime.ts", import.meta.url), "utf8");
        const frozen165 = readFileSync(new URL("../../src/orchestration_1_0_65/runtime.ts", import.meta.url), "utf8");
        expect(frozen164).toMatch(/CURRENT_ORCHESTRATION_VERSION\s*=\s*"1\.0\.64"/);
        expect(frozen165).toMatch(/CURRENT_ORCHESTRATION_VERSION\s*=\s*"1\.0\.65"/);
    });

    it("registry versions are unique and strictly monotonic, floor still present", () => {
        const versions = REGISTRY.map((e) => e.version);
        expect(new Set(versions).size).toBe(versions.length); // no duplicates
        const patch = versions.map((v) => Number(v.split(".")[2]));
        for (let i = 1; i < patch.length; i += 1) {
            expect(patch[i]).toBeGreaterThan(patch[i - 1]); // gap-free, increasing
        }
        expect(versions).toContain("1.0.47"); // compatibility floor still registered
    });
});

describe("orchestration 1.0.58 freeze boundary (replay safety)", () => {
    const frozenTurn = readFileSync(new URL("../../src/orchestration_1_0_58/turn.ts", import.meta.url), "utf8");
    const frozen159Turn = readFileSync(new URL("../../src/orchestration_1_0_59/turn.ts", import.meta.url), "utf8");
    const frozen160Runtime = readFileSync(new URL("../../src/orchestration_1_0_60/runtime.ts", import.meta.url), "utf8");
    const workingTurn = readFileSync(new URL("../../src/orchestration/turn.ts", import.meta.url), "utf8");
    const frozenRuntime = readFileSync(new URL("../../src/orchestration_1_0_58/runtime.ts", import.meta.url), "utf8");
    const frozen159Runtime = readFileSync(new URL("../../src/orchestration_1_0_59/runtime.ts", import.meta.url), "utf8");

    it("the snapshot_lineage_jump yield exists from 1.0.59 onward, not in frozen 1.0.58", () => {
        // This yield is the schedule change that required the version bump.
        expect(workingTurn).toContain("session.snapshot_lineage_jump");
        expect(frozen159Turn).toContain("session.snapshot_lineage_jump");
        expect(frozenTurn).not.toContain("session.snapshot_lineage_jump");
    });

    it("frozen 1.0.58 hardcodes its own version string", () => {
        expect(frozenRuntime).toMatch(/CURRENT_ORCHESTRATION_VERSION\s*=\s*"1\.0\.58"/);
    });

    it("frozen 1.0.59 hardcodes its own version string", () => {
        expect(frozen159Runtime).toMatch(/CURRENT_ORCHESTRATION_VERSION\s*=\s*"1\.0\.59"/);
    });

    it("frozen 1.0.60 hardcodes its own version string", () => {
        expect(frozen160Runtime).toMatch(/CURRENT_ORCHESTRATION_VERSION\s*=\s*"1\.0\.60"/);
    });

    it("1.0.59 retires expectedVersion from the runTurn input; frozen 1.0.58 still sends it", () => {
        // Store-wins: the worker reconciles against the store's own version, so
        // the orchestration's belief is dead on the wire. The latest sends only
        // turnKey; the frozen handler keeps the field its histories recorded.
        expect(workingTurn).toContain("snapshot: { turnKey: snapshotTurnKey }");
        expect(workingTurn).not.toMatch(/snapshot: \{ expectedVersion/);
        expect(frozenTurn).toMatch(/snapshot: \{ expectedVersion: state\.snapshotVersion, turnKey/);
    });
});

// Behavioural firing of the lineage-jump yield is driven end-to-end through the
// real orchestration turn harness in child-update-batching.test.js
// ("snapshot_lineage_jump behaviour" describe), which owns the proven
// runThroughTurn driver.
