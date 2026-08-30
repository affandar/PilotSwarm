/**
 * P2/R1: a child's bare `wait` is a heartbeat (orchestration ≥1.0.71).
 *
 * On waldemort chk (2026-08-30), 20 of the 41 child updates that woke a
 * 690K-token manager for nothing were children saying "I am waiting". The
 * classifier now treats a wait as a heartbeat when the orchestration flags
 * it (`waitIsHeartbeat`), while keeping three ways for a child to interrupt
 * from a wait: `wait({material: true})`, a verdict hint, and the QUESTION
 * FOR PARENT coercion. Without the flag (≤1.0.70 executions) the old rule
 * holds, so their replay is unchanged.
 */

import { describe, expect, it } from "vitest";
import { classifyChildUpdate, shouldWakeParentForChildUpdate } from "../../src/child-notifications.ts";

describe("child wait notifications under the ≥1.0.71 flag", () => {
    it("a bare wait with prose is a heartbeat and does not wake the parent", () => {
        const update = { kind: "wait", summary: "Sleeping 60s, will re-check the deploy.", waitIsHeartbeat: true };
        expect(classifyChildUpdate(update)).toBe("heartbeat");
        expect(shouldWakeParentForChildUpdate({ update, contract: null }).wake).toBe(false);
    });

    it("wait({material: true}) still wakes the parent", () => {
        const update = { kind: "wait", summary: "Blocker: quota exhausted in westus3.", waitIsHeartbeat: true, material: true };
        expect(classifyChildUpdate(update)).toBe("material");
        expect(shouldWakeParentForChildUpdate({ update, contract: null }).wake).toBe(true);
    });

    it("the QUESTION FOR PARENT coercion is material — the child would hang otherwise", () => {
        const update = { kind: "wait", summary: "QUESTION FOR PARENT: may I delete the resource group?", waitIsHeartbeat: true };
        expect(classifyChildUpdate(update)).toBe("material");
    });

    it("a verdict hint on the wait is material; a heartbeat verdict is not", () => {
        expect(classifyChildUpdate({ kind: "wait", summary: "x", waitIsHeartbeat: true, result: { verdict: "blocked" } })).toBe("material");
        expect(classifyChildUpdate({ kind: "wait", summary: "x", waitIsHeartbeat: true, result: { verdict: "unchanged" } })).toBe("heartbeat");
    });

    it("without the flag (≤1.0.70) a wait with prose is still material — replay unchanged", () => {
        const update = { kind: "wait", summary: "Sleeping 60s, will re-check the deploy." };
        expect(classifyChildUpdate(update)).toBe("material");
        expect(shouldWakeParentForChildUpdate({ update, contract: null }).wake).toBe(true);
    });

    it("wakeOn=any still wakes for a flagged heartbeat wait (policy wins)", () => {
        const update = { kind: "wait", summary: "sleeping", waitIsHeartbeat: true };
        expect(shouldWakeParentForChildUpdate({ update, contract: { wakeOn: "any" } }).wake).toBe(true);
    });
});
