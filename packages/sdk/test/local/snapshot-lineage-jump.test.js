/**
 * Layer 2 of the store-wins snapshot protocol (docs/proposals/snapshot-store-wins.md):
 * the 1.0.59 orchestration version bump that adds the `session.snapshot_lineage_jump`
 * observability event at the turn-result adoption site.
 *
 * Two things must hold and are guarded here:
 *   1. VERSION CEREMONY — 1.0.58 is frozen and still registered; latest is 1.0.59.
 *   2. FREEZE BOUNDARY — the new durable yield exists ONLY in the latest handler,
 *      never in frozen 1.0.58 (in-flight 1.0.58 histories recorded WITHOUT it and
 *      would fail replay against a mutated handler — the beae878 incident class).
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

describe("orchestration version registry (1.0.59 store-wins bump)", () => {
    it("latest is 1.0.59, registered, and exported from the dispatcher", () => {
        expect(LATEST).toBe("1.0.59");
        const latest = REGISTRY.find((e) => e.version === LATEST);
        expect(latest?.handler).toBeTypeOf("function");
        expect(latest.handler.name).toBe("durableSessionOrchestration_1_0_59");
        expect(dispatcher.durableSessionOrchestration_1_0_59).toBeTypeOf("function");
    });

    it("freezes 1.0.58 as a distinct registered handler", () => {
        const frozen = REGISTRY.find((e) => e.version === "1.0.58");
        const latest = REGISTRY.find((e) => e.version === LATEST);
        expect(frozen?.handler).toBeTypeOf("function");
        expect(frozen.handler.name).toBe("durableSessionOrchestration_1_0_58");
        expect(frozen.handler).not.toBe(latest.handler); // frozen != latest
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
    const workingTurn = readFileSync(new URL("../../src/orchestration/turn.ts", import.meta.url), "utf8");
    const frozenRuntime = readFileSync(new URL("../../src/orchestration_1_0_58/runtime.ts", import.meta.url), "utf8");

    it("the snapshot_lineage_jump yield exists ONLY in the latest, not in frozen 1.0.58", () => {
        // This yield is the schedule change that required the version bump.
        expect(workingTurn).toContain("session.snapshot_lineage_jump");
        expect(frozenTurn).not.toContain("session.snapshot_lineage_jump");
    });

    it("frozen 1.0.58 hardcodes its own version string", () => {
        expect(frozenRuntime).toMatch(/CURRENT_ORCHESTRATION_VERSION\s*=\s*"1\.0\.58"/);
    });
});

// Behavioural firing of the lineage-jump yield is driven end-to-end through the
// real orchestration turn harness in child-update-batching.test.js
// ("snapshot_lineage_jump behaviour" describe), which owns the proven
// runThroughTurn driver.
