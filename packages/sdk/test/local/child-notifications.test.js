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
