import { describe, it, expect } from "vitest";
import {
    normalizeWakeOn,
    readWakeOn,
    classifyChildUpdate,
    shouldWakeParentForChildUpdate,
    shouldWakeParentForChildDigest,
    isHeartbeatText,
    DEFAULT_CHILD_WAKE_POLICY,
} from "../../src/child-notifications.ts";

describe("child-notifications: normalizeWakeOn", () => {
    it("defaults missing/invalid to material_change", () => {
        expect(normalizeWakeOn(undefined)).toBe("material_change");
        expect(normalizeWakeOn(null)).toBe("material_change");
        expect(normalizeWakeOn(42)).toBe("material_change");
        expect(normalizeWakeOn("garbage")).toBe("material_change");
        expect(DEFAULT_CHILD_WAKE_POLICY).toBe("material_change");
    });
    it("accepts canonical values", () => {
        expect(normalizeWakeOn("any")).toBe("any");
        expect(normalizeWakeOn("material_change")).toBe("material_change");
        expect(normalizeWakeOn("completion")).toBe("completion");
    });
    it("accepts tolerant aliases", () => {
        expect(normalizeWakeOn("ANY")).toBe("any");
        expect(normalizeWakeOn("always")).toBe("any");
        expect(normalizeWakeOn("material")).toBe("material_change");
        expect(normalizeWakeOn("done")).toBe("completion");
        expect(normalizeWakeOn("finished")).toBe("completion");
    });
    it("readWakeOn handles missing contract", () => {
        expect(readWakeOn(null)).toBe("material_change");
        expect(readWakeOn(undefined)).toBe("material_change");
        expect(readWakeOn({})).toBe("material_change");
        expect(readWakeOn({ wakeOn: "any" })).toBe("any");
    });
});

describe("child-notifications: heartbeat classifier", () => {
    it("flags explicit heartbeat phrases", () => {
        expect(isHeartbeatText("No change")).toBe(true);
        expect(isHeartbeatText("no drift")).toBe(true);
        expect(isHeartbeatText("Heartbeat")).toBe(true);
        expect(isHeartbeatText("Nothing to report")).toBe(true);
        expect(isHeartbeatText("Cycle quiet")).toBe(true);
    });
    it("does not flag arbitrary text as heartbeat", () => {
        expect(isHeartbeatText("Found 3 new issues in the watcher.")).toBe(false);
        expect(isHeartbeatText("Build broken on main.")).toBe(false);
    });
});

describe("child-notifications: classifyChildUpdate", () => {
    it("treats error kind as error", () => {
        expect(classifyChildUpdate({ kind: "error" })).toBe("error");
    });
    it("treats cancelled as completion", () => {
        expect(classifyChildUpdate({ kind: "cancelled" })).toBe("completion");
    });
    it("completed with verdict is completion", () => {
        expect(classifyChildUpdate({ kind: "completed", result: { verdict: "success" } })).toBe("completion");
        expect(classifyChildUpdate({ kind: "completed", result: { verdict: "blocked" } })).toBe("completion");
        expect(classifyChildUpdate({ kind: "completed", result: { verdict: "failed" } })).toBe("completion");
    });
    it("explicit material flag wins", () => {
        expect(classifyChildUpdate({ kind: "progress", material: true })).toBe("material");
        expect(classifyChildUpdate({ kind: "progress", material: false })).toBe("heartbeat");
    });
    it("heartbeat text in wait/progress is heartbeat", () => {
        expect(classifyChildUpdate({ kind: "wait", summary: "No change" })).toBe("heartbeat");
        expect(classifyChildUpdate({ kind: "progress", summary: "Heartbeat" })).toBe("heartbeat");
    });
    it("unknown text defaults to material", () => {
        expect(classifyChildUpdate({ kind: "progress", summary: "Found a new defect in service X." })).toBe("material");
    });
    it("missing summary on progress is unknown", () => {
        expect(classifyChildUpdate({ kind: "progress" })).toBe("unknown");
    });
});

describe("child-notifications: shouldWakeParentForChildUpdate", () => {
    it("policy=any wakes for heartbeats", () => {
        const d = shouldWakeParentForChildUpdate({
            update: { kind: "progress", summary: "No change" },
            contract: { wakeOn: "any" },
        });
        expect(d.wake).toBe(true);
        expect(d.policy).toBe("any");
    });

    it("policy=material_change suppresses heartbeat", () => {
        const d = shouldWakeParentForChildUpdate({
            update: { kind: "wait", summary: "No change" },
            contract: { wakeOn: "material_change" },
        });
        expect(d.wake).toBe(false);
        expect(d.classification).toBe("heartbeat");
    });

    it("policy=material_change wakes for material change", () => {
        const d = shouldWakeParentForChildUpdate({
            update: { kind: "progress", summary: "ADO item ID 1234 transitioned to Ready for Review." },
        });
        expect(d.wake).toBe(true);
        expect(d.policy).toBe("material_change");
    });

    it("policy=material_change conservatively wakes for unknown", () => {
        const d = shouldWakeParentForChildUpdate({
            update: { kind: "progress" },
            contract: { wakeOn: "material_change" },
        });
        expect(d.wake).toBe(true);
        expect(d.classification).toBe("unknown");
    });

    it("policy=completion suppresses ordinary progress", () => {
        const d = shouldWakeParentForChildUpdate({
            update: { kind: "progress", summary: "Found 2 new things." },
            contract: { wakeOn: "completion" },
        });
        expect(d.wake).toBe(false);
    });

    it("policy=completion suppresses a finished task reply without a terminal verdict", () => {
        const d = shouldWakeParentForChildUpdate({
            update: {
                kind: "completed",
                summary: "Resolution complete. All 11 customers were processed and the result fact was stored.",
            },
            contract: { wakeOn: "completion" },
        });
        expect(d.classification).toBe("material");
        expect(d.wake).toBe(false);
    });

    it("policy=material_change wakes for the Waldemort finite task result", () => {
        const d = shouldWakeParentForChildUpdate({
            update: {
                kind: "completed",
                summary: "Resolution complete. All 11 customers were processed and the result fact was stored.",
            },
            contract: { wakeOn: "material_change" },
        });
        expect(d.classification).toBe("material");
        expect(d.wake).toBe(true);
    });

    it("policy=completion wakes on terminal completion", () => {
        const d = shouldWakeParentForChildUpdate({
            update: { kind: "completed", result: { verdict: "success" } },
            contract: { wakeOn: "completion" },
        });
        expect(d.wake).toBe(true);
    });

    it("policy=completion wakes on error", () => {
        const d = shouldWakeParentForChildUpdate({
            update: { kind: "error" },
            contract: { wakeOn: "completion" },
        });
        expect(d.wake).toBe(true);
    });
});

describe("child-notifications: shouldWakeParentForChildDigest", () => {
    it("empty digest does not wake", () => {
        const d = shouldWakeParentForChildDigest([]);
        expect(d.wake).toBe(false);
    });

    it("all-heartbeat digest does not wake", () => {
        const d = shouldWakeParentForChildDigest([
            { update: { kind: "progress", summary: "No change" } },
            { update: { kind: "wait", summary: "Heartbeat" } },
        ]);
        expect(d.wake).toBe(false);
    });

    it("mixed digest wakes if any update is material", () => {
        const d = shouldWakeParentForChildDigest([
            { update: { kind: "progress", summary: "No change" } },
            { update: { kind: "progress", summary: "Found new failure in pipeline run #42." } },
        ]);
        expect(d.wake).toBe(true);
    });
});

describe("child-notifications: cron-origin (cyclic) completions", () => {
    // A quiet periodic cron/cron_at cycle ends as a plain `completed` turn with no
    // terminal verdict (cron re-arms automatically, so the child does not call
    // wait()). The orchestration marks such turns `cyclic: true`. Under
    // material_change/completion these must not wake the parent, regardless of
    // prose. The decision still respects wakeOn (any still wakes). Non-cyclic
    // completions are unchanged so genuine finished answers still reach the parent.

    // ── classifier contract (direct, one assertion per intended rule) ──
    it("classifyChildUpdate: cyclic completion w/o verdict is heartbeat", () => {
        expect(classifyChildUpdate({ kind: "completed", summary: "Quiet.", cyclic: true })).toBe("heartbeat");
        expect(classifyChildUpdate({ kind: "completed", cyclic: true })).toBe("heartbeat"); // no summary
        expect(classifyChildUpdate({ kind: "completed", summary: "", cyclic: true })).toBe("heartbeat"); // empty summary
    });
    it("classifyChildUpdate: cyclic completion with material:false is heartbeat", () => {
        expect(classifyChildUpdate({ kind: "completed", summary: "anything at all", cyclic: true, material: false })).toBe("heartbeat");
    });
    it("classifyChildUpdate: non-cyclic completion is unchanged", () => {
        expect(classifyChildUpdate({ kind: "completed", summary: "Done — report ready." })).toBe("material");
        // legacy explicit-heartbeat path preserved for non-cyclic completions
        expect(classifyChildUpdate({ kind: "completed", summary: "No change", material: false })).toBe("heartbeat");
    });

    // ── observable wake behavior (assert wake + policy, not the internal label) ──
    it("cyclic quiet completion does not wake under default (material_change)", () => {
        const d = shouldWakeParentForChildUpdate({
            update: { kind: "completed", summary: "Quiet.", cyclic: true },
        }); // contract omitted → default policy path
        expect(d.policy).toBe("material_change");
        expect(d.wake).toBe(false);
    });
    it("cyclic completion does not wake with arbitrary quiet prose", () => {
        // The live wake-storm came from prose no phrase list can match.
        const d = shouldWakeParentForChildUpdate({
            update: { kind: "completed", summary: "Same 23-id set, notes objectId unchanged. Quiet — ending silently.", cyclic: true },
            contract: { wakeOn: "material_change" },
        });
        expect(d.wake).toBe(false);
    });
    it("cyclic completion with no summary does not wake", () => {
        const d = shouldWakeParentForChildUpdate({
            update: { kind: "completed", cyclic: true },
            contract: { wakeOn: "material_change" },
        });
        expect(d.wake).toBe(false);
    });
    it("cyclic quiet completion does not wake under wakeOn=completion", () => {
        const d = shouldWakeParentForChildUpdate({
            update: { kind: "completed", summary: "Quiet.", cyclic: true },
            contract: { wakeOn: "completion" },
        });
        expect(d.wake).toBe(false);
    });
    it("blocked cycle report wakes under wakeOn=completion", () => {
        const d = shouldWakeParentForChildUpdate({
            update: { kind: "completed", summary: "Blocked reading source.", cyclic: true, material: true, result: { verdict: "blocked" } },
            contract: { wakeOn: "completion" },
        });
        expect(d.wake).toBe(true);
    });

    // ── guard rails: the fix must NOT over-suppress real signals ──
    it("GUARD: non-cyclic completion still wakes (genuine finished answer)", () => {
        const d = shouldWakeParentForChildUpdate({
            update: { kind: "completed", summary: "Done — here is the report you asked for." },
            contract: { wakeOn: "material_change" },
        });
        expect(d.wake).toBe(true);
    });
    it("GUARD: non-cyclic completion with no summary still wakes", () => {
        const d = shouldWakeParentForChildUpdate({
            update: { kind: "completed" },
            contract: { wakeOn: "material_change" },
        });
        expect(d.wake).toBe(true);
    });
    it("GUARD: cyclic completion with explicit material:true wakes (escalation)", () => {
        const d = shouldWakeParentForChildUpdate({
            update: { kind: "completed", summary: "Found a new blocker this cycle.", cyclic: true, material: true },
            contract: { wakeOn: "material_change" },
        });
        expect(d.wake).toBe(true);
    });
    it("GUARD: cyclic completion with a terminal verdict wakes (completion)", () => {
        const d = shouldWakeParentForChildUpdate({
            update: { kind: "completed", summary: "All done.", cyclic: true, result: { verdict: "success" } },
            contract: { wakeOn: "material_change" },
        });
        expect(d.wake).toBe(true);
    });
    it("GUARD: cyclic quiet completion still wakes under wakeOn=any", () => {
        const d = shouldWakeParentForChildUpdate({
            update: { kind: "completed", summary: "Quiet.", cyclic: true },
            contract: { wakeOn: "any" },
        });
        expect(d.wake).toBe(true);
    });

    // ── scope: wait-loop watchers (kind:"wait") are intentionally NOT changed here ──
    it("SCOPE: non-cyclic wait-loop quiet prose still wakes under material_change", () => {
        const d = shouldWakeParentForChildUpdate({
            update: { kind: "wait", summary: "Same as before, ending silently." },
            contract: { wakeOn: "material_change" },
        });
        expect(d.wake).toBe(true);
    });

    // ── digest path consumes the same classifier ──
    it("digest: all-cyclic-quiet batch does not wake", () => {
        const d = shouldWakeParentForChildDigest([
            { update: { kind: "completed", summary: "Quiet.", cyclic: true } },
            { update: { kind: "completed", summary: "Nothing this cycle, ending.", cyclic: true } },
        ]);
        expect(d.wake).toBe(false);
    });
    it("digest: cyclic-quiet plus one material wakes", () => {
        const d = shouldWakeParentForChildDigest([
            { update: { kind: "completed", summary: "Quiet.", cyclic: true } },
            { update: { kind: "completed", summary: "New blocker found.", cyclic: true, material: true } },
        ]);
        expect(d.wake).toBe(true);
    });
    it("digest: blocked cycle report wakes under completion policy", () => {
        const d = shouldWakeParentForChildDigest([
            {
                update: { kind: "completed", summary: "Blocked reading source.", cyclic: true, material: true, result: { verdict: "blocked" } },
                contract: { wakeOn: "completion" },
            },
        ]);
        expect(d.wake).toBe(true);
    });
});
