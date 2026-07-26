// The deterministic package is the guaranteed floor for regeneration — what a
// reborn session boots from when no LLM distiller runs. It used to carry only
// the FIRST USER MESSAGE as the mission, which loses how the mission was
// actually agreed: the ask, the agent'"'"'s read-back, and the constraints that
// followed. It now carries the opening exchange, bounded.
import test from "node:test";
import assert from "node:assert/strict";
import { assembleRegenClosure, deterministicPackage, renderBootstrap } from "../../dist/regen-worker.js";

const mk = (seq, role, content) => ({ seq, eventType: role === "u" ? "user.message" : "assistant.message", data: { content }, createdAt: new Date(0) });

function catalogWith(rows) {
    return {
        getSessionEvents: async (_id, after, limit) => rows.slice(0, limit),
        getSessionEventsBefore: async (_id, _before, limit) => rows.slice(-limit),
        getDescendantSessionIds: async () => [],
    };
}

test("the opening carries the first 10 messages, not just the first", async () => {
    const rows = [];
    for (let i = 1; i <= 30; i++) rows.push(mk(i, i % 2 ? "u" : "a", `msg-${i}`));
    const closure = await assembleRegenClosure({ catalog: catalogWith(rows) }, "s1");
    const lines = closure.opening.split("\n");
    assert.equal(lines.length, 10, "exactly 10 opening messages");
    assert.match(lines[0], /^USER: msg-1$/);
    assert.match(lines[1], /^ASSISTANT: msg-2$/);
    assert.match(lines[9], /^ASSISTANT: msg-10$/);
    assert.ok(!closure.opening.includes("msg-11"), "stops at 10");
});

test("the opening is capped at 4k characters", async () => {
    const rows = [];
    for (let i = 1; i <= 10; i++) rows.push(mk(i, i % 2 ? "u" : "a", "x".repeat(3000)));
    const closure = await assembleRegenClosure({ catalog: catalogWith(rows) }, "s1");
    assert.ok(closure.opening.length <= 4000 + 16, `capped, got ${closure.opening.length}`);
    assert.ok(closure.opening.startsWith("USER: xxx"), "keeps the earliest messages whole first");
});

test("the deterministic package and bootstrap carry it", async () => {
    const rows = [];
    for (let i = 1; i <= 12; i++) rows.push(mk(i, i % 2 ? "u" : "a", `open-${i}`));
    const closure = await assembleRegenClosure({ catalog: catalogWith(rows) }, "s1");
    const pkg = deterministicPackage(closure);
    assert.ok(pkg.openingContext.includes("open-1"));
    assert.ok(pkg.openingContext.includes("open-10"));
    const boot = renderBootstrap(pkg, { epoch: 1, packageArtifactId: "p.json" });
    assert.match(boot, /HOW THIS SESSION OPENED/);
    assert.ok(boot.indexOf("HOW THIS SESSION OPENED") < boot.indexOf("RECENT CONVERSATION TAIL"), "opening precedes tail");
});
