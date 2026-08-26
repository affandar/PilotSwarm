/**
 * Freezing 1.0.69 and opening 1.0.70.
 *
 * WHY THE BUMP: the provider-budget stash (orchestration/turn.ts) records a
 * prompt the gate refused as a durable `user.message`, so a refused prompt is
 * not silently lost. It recorded EVERY refused prompt that way — including an
 * agent's own bootstrap kickoff — with no sender on the event. A user-role
 * message with no sender renders from the READER's perspective, so a session
 * the gate blocked at creation opened with the agent's own instructions under
 * the reader's name.
 *
 * That is the one path that can put a bootstrap prompt in a transcript at all:
 * runTurn refuses to record one (`!input.bootstrap`). Fixing it changes what
 * the orchestration yields, and durable replay matches on the yield sequence —
 * so 1.0.69 had to be frozen rather than edited, or a session paused mid-flight
 * would break on wake.
 *
 * These tests pin the freeze itself. They are structural because that is what
 * the invariant IS: which file a version resolves to, and what it calls itself.
 *
 * Run: node --test test/unit/orchestration-freeze-1-0-70.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../src");
const read = (rel) => readFileSync(join(SRC, rel), "utf8");

test("the latest version is 1.0.70", () => {
    assert.match(
        read("orchestration-version.ts"),
        /export const DURABLE_SESSION_LATEST_VERSION = "1\.0\.70";/,
    );
});

test("1.0.69 is frozen in its own directory, not the live one", () => {
    assert.ok(existsSync(join(SRC, "orchestration_1_0_69/index.ts")), "the frozen copy must exist");
    const registry = read("orchestration-registry.ts");
    assert.match(
        registry,
        /import \{ durableSessionOrchestration_1_0_69 \} from "\.\/orchestration_1_0_69\/index\.js";/,
        "1.0.69 must resolve to the FROZEN directory — pointing it at ./orchestration/ is the bug this guards",
    );
    assert.match(
        registry,
        /import \{ durableSessionOrchestration_1_0_70 \} from "\.\/orchestration\/index\.js";/,
        "the live directory is 1.0.70 now",
    );
    assert.match(registry, /\{ version: "1\.0\.69", handler: durableSessionOrchestration_1_0_69 \}/);
    assert.match(
        registry,
        /\{ version: DURABLE_SESSION_LATEST_VERSION, handler: durableSessionOrchestration_1_0_70 \}/,
    );
});

test("a frozen orchestration self-identifies with its OWN version", () => {
    // The 49751fb lesson, recorded in 1.0.68's own comment: a frozen file that
    // reads the moving latest reports the wrong version for replay and tracing
    // the moment the next bump lands.
    assert.match(
        read("orchestration_1_0_69/runtime.ts"),
        /export const CURRENT_ORCHESTRATION_VERSION = "1\.0\.69";/,
    );
    assert.doesNotMatch(
        read("orchestration_1_0_69/runtime.ts"),
        /CURRENT_ORCHESTRATION_VERSION = DURABLE_SESSION_LATEST_VERSION/,
        "a frozen version must not follow the moving latest",
    );
    // The live one SHOULD follow it — that is what makes the next bump one edit.
    assert.match(
        read("orchestration/runtime.ts"),
        /export const CURRENT_ORCHESTRATION_VERSION = DURABLE_SESSION_LATEST_VERSION;/,
    );
});

test("the frozen copy keeps the OLD behaviour, unstamped", () => {
    // If the freeze accidentally captured the fix, it is not a record of what
    // 1.0.69 actually did, and replaying a 1.0.69 session would diverge.
    const frozen = read("orchestration_1_0_69/turn.ts");
    const stash = frozen.slice(frozen.indexOf("function* stashBudgetRefusedPrompt"));
    const record = stash.slice(0, stash.indexOf("stash.push("));
    assert.match(record, /budgetQueued: true/, "the frozen stash still records the refused prompt");
    assert.doesNotMatch(record, /sender:/, "…and still records it bare — that IS 1.0.69");
});

test("the live 1.0.70 stamps a bootstrap kickoff so it is not read as the reader's own", () => {
    const live = read("orchestration/turn.ts");
    const stash = live.slice(live.indexOf("function* stashBudgetRefusedPrompt"));
    const record = stash.slice(0, stash.indexOf("stash.push("));
    assert.match(record, /budgetQueued: true/, "still records it — the prompt must not be lost");
    assert.match(
        record,
        /isBootstrap \? \{ sender: \{ kind: "system"/,
        "a bootstrap kickoff is stamped as machine-authored",
    );
    // The flag has to actually arrive, or the stamp never fires.
    assert.match(live, /isBootstrap\?: boolean,/, "stashBudgetRefusedPrompt takes the flag");
    assert.match(
        live,
        /stashBudgetRefusedPrompt\(runtime, sourcePrompt, clientMessageIds, isBootstrap\)/,
        "and is given it at the call site",
    );
    assert.match(
        live,
        /handleTurnResult\(runtime, result, prompt, cycleOrigin, clientMessageIds, promptIsBootstrap\)/,
        "which in turn receives it from the running turn",
    );
});

test("a real person's refused message is still recorded, and NOT stamped as machine-authored", () => {
    // The stash exists so a refused prompt is not lost and the outbox's
    // optimistic ✓ becomes true. Stamping a human's message as system would
    // fold it into a collapsed row and hide what they actually said — a worse
    // bug than the one being fixed.
    const live = read("orchestration/turn.ts");
    const stash = live.slice(live.indexOf("function* stashBudgetRefusedPrompt"));
    const record = stash.slice(0, stash.indexOf("stash.push("));
    assert.match(
        record,
        /\.\.\.\(isBootstrap \?/,
        "the stamp must be conditional on isBootstrap, never unconditional",
    );
    assert.match(record, /clientMessageIds: ids/, "a human message keeps the ids the outbox acks by");
});
