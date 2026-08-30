/**
 * Freezing 1.0.70 and opening 1.0.71.
 *
 * WHY THE BUMP: a wake-up (timer end, cron fire, child update) hands the model
 * a `[SYSTEM: …]` note. ≤1.0.70 parked it in `config.turnSystemPrompt`, which
 * session-manager rendered into the `last_instructions` section of the SYSTEM
 * message. The note differs on every wake-up, so the first bytes of every
 * request differed and the provider dropped the prefix cache behind them.
 * Measured on waldemort chk, first call after a wake-up within the cache TTL:
 * 12% cache hit when the system message changed, 93% (GHCP) / 99%
 * (Anthropic-direct) when it did not.
 *
 * 1.0.71 delivers the note at the tail of the USER turn as a
 * `<system_context>` block (prompt-system-context.ts). That changes the prompt
 * string the orchestration yields to runTurn, and durable replay matches on
 * the yield sequence — so 1.0.70 is frozen rather than edited.
 *
 * These tests pin the freeze and the shape of the fix. They are structural
 * because that is what the invariant IS: which file a version resolves to,
 * what it calls itself, and which delivery path each version uses.
 *
 * Run: node --test test/unit/orchestration-freeze-1-0-71.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../src");
const read = (rel) => readFileSync(join(SRC, rel), "utf8");

test("the latest version is 1.0.71", () => {
    assert.match(
        read("orchestration-version.ts"),
        /export const DURABLE_SESSION_LATEST_VERSION = "1\.0\.71";/,
    );
});

test("1.0.70 is frozen in its own directory, not the live one", () => {
    assert.ok(existsSync(join(SRC, "orchestration_1_0_70/index.ts")), "the frozen copy must exist");
    const registry = read("orchestration-registry.ts");
    assert.match(
        registry,
        /import \{ durableSessionOrchestration_1_0_70 \} from "\.\/orchestration_1_0_70\/index\.js";/,
        "1.0.70 must resolve to the FROZEN directory — pointing it at ./orchestration/ is the bug this guards",
    );
    assert.match(
        registry,
        /import \{ durableSessionOrchestration_1_0_71 \} from "\.\/orchestration\/index\.js";/,
        "the live directory is 1.0.71 now",
    );
    assert.match(registry, /\{ version: "1\.0\.70", handler: durableSessionOrchestration_1_0_70 \}/);
    assert.match(
        registry,
        /\{ version: DURABLE_SESSION_LATEST_VERSION, handler: durableSessionOrchestration_1_0_71 \}/,
    );
    // The previous freeze must still be intact — a bump must never unfreeze.
    assert.match(registry, /from "\.\/orchestration_1_0_69\/index\.js";/);
});

test("a frozen orchestration self-identifies with its OWN version", () => {
    // The 49751fb lesson: a frozen file that reads the moving latest reports
    // the wrong version for replay and tracing the moment the next bump lands.
    assert.match(
        read("orchestration_1_0_70/runtime.ts"),
        /export const CURRENT_ORCHESTRATION_VERSION = "1\.0\.70";/,
    );
    assert.doesNotMatch(
        read("orchestration_1_0_70/runtime.ts"),
        /CURRENT_ORCHESTRATION_VERSION = DURABLE_SESSION_LATEST_VERSION/,
        "a frozen version must not follow the moving latest",
    );
    assert.match(
        read("orchestration/runtime.ts"),
        /export const CURRENT_ORCHESTRATION_VERSION = DURABLE_SESSION_LATEST_VERSION;/,
    );
    assert.match(read("orchestration/index.ts"), /export function\* durableSessionOrchestration_1_0_71\(/);
    assert.match(read("orchestration_1_0_70/index.ts"), /export function\* durableSessionOrchestration_1_0_70\(/);
});

test("the frozen 1.0.70 keeps the OLD delivery: note parked for the system message, nothing in the prompt", () => {
    // If the freeze captured the fix, it is not a record of what 1.0.70 did,
    // and replaying a 1.0.70 session would yield a different prompt string.
    const frozen = read("orchestration_1_0_70/turn.ts");
    assert.doesNotMatch(frozen, /appendSystemContextBlock/, "the frozen copy must not append the block");
    assert.doesNotMatch(frozen, /systemContextInPrompt/, "…and must not set the flag");
    assert.match(frozen, /state\.config\.turnSystemPrompt = turnSystemPrompt;/, "it still parks the note");
    assert.match(
        frozen,
        /\.\.\.\(rc\.turnSystemPrompt \? \{ systemPrompt: rc\.turnSystemPrompt \} : \{\}\),/,
        "and still forwards it as systemPrompt on retry — that IS 1.0.70",
    );
});

test("the live 1.0.71 delivers the note inside the user turn and flags it", () => {
    const live = read("orchestration/turn.ts");
    assert.match(live, /import \{ appendSystemContextBlock, splitSystemContextBlock \} from "\.\.\/prompt-system-context\.js";/);
    const park = live.indexOf("state.config.turnSystemPrompt = turnSystemPrompt;");
    assert.ok(park >= 0, "turnSystemPrompt is still set — session-proxy records it as system.message");
    const after = live.slice(park, park + 400);
    assert.match(after, /state\.config\.systemContextInPrompt = true;/, "the flag tells session-manager not to render it");
    assert.match(after, /prompt = appendSystemContextBlock\(prompt, turnSystemPrompt\);/, "and the prompt carries it");
});

test("the live 1.0.71 retries from the prompt alone — never the note twice", () => {
    // The note is inside sourcePrompt. Forwarding turnSystemPrompt too would
    // land it in pendingSystemPrompt and append it a second time.
    const live = read("orchestration/turn.ts");
    const fn = live.slice(live.indexOf("function retryContinueOverrides"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    assert.doesNotMatch(body, /systemPrompt: rc\.turnSystemPrompt/, "no systemPrompt on the retry input");
    assert.match(body, /prompt: rc\.sourcePrompt,/, "the prompt always rides — including for a system-only turn");
    assert.match(body, /rc\.systemOnlyTurn \? \{ bootstrapPrompt: true \}/, "a system-only turn keeps its bootstrap flag");
});

test("session-manager renders the note into the system message ONLY for unflagged (≤1.0.70) turns", () => {
    const sm = read("session-manager.ts");
    assert.match(
        sm,
        /latest\.systemContextInPrompt \? undefined : latest\.turnSystemPrompt,/,
        "the guard is what keeps 1.0.70 sessions working through the hand-off window",
    );
});

test("session-proxy strips the block from the persisted user.message and still records the note", () => {
    const sp = read("session-proxy.ts");
    assert.match(sp, /import \{ splitSystemContextBlock \} from "\.\/prompt-system-context\.js";/);
    assert.match(sp, /const promptForRecord = input\.config\?\.systemContextInPrompt\s*\? splitSystemContextBlock\(input\.prompt\)\.prompt\s*: input\.prompt;/);
    assert.match(sp, /const eventData: Record<string, unknown> = \{ content: promptForRecord \};/);
    // The note's own event is unchanged: still gated on turnSystemPrompt.
    assert.match(sp, /if \(catalog && input\.config\.turnSystemPrompt && !isRetryAttempt\)/);
});
