/**
 * Freezing 1.0.70 and opening 1.0.71, then freezing 1.0.71 before 1.0.72.
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

test("the latest version is 1.0.79", () => {
    assert.match(
        read("orchestration-version.ts"),
        /export const DURABLE_SESSION_LATEST_VERSION = "1\.0\.79";/,
    );
});

test("1.0.70 through 1.0.78 are frozen in their own directories", () => {
    assert.ok(existsSync(join(SRC, "orchestration_1_0_70/index.ts")), "the frozen copy must exist");
    assert.ok(existsSync(join(SRC, "orchestration_1_0_71/index.ts")), "the latest frozen copy must exist");
    assert.ok(existsSync(join(SRC, "orchestration_1_0_73/index.ts")), "the newest frozen copy must exist");
    const registry = read("orchestration-registry.ts");
    assert.match(
        registry,
        /import \{ durableSessionOrchestration_1_0_70 \} from "\.\/orchestration_1_0_70\/index\.js";/,
        "1.0.70 must resolve to the FROZEN directory — pointing it at ./orchestration/ is the bug this guards",
    );
    assert.match(
        registry,
        /import \{ durableSessionOrchestration_1_0_71 \} from "\.\/orchestration_1_0_71\/index\.js";/,
        "1.0.71 must resolve to its frozen directory",
    );
    assert.match(
        registry,
        /import \{ durableSessionOrchestration_1_0_73 \} from "\.\/orchestration_1_0_73\/index\.js";/,
        "1.0.73 must resolve to its frozen directory now that 1.0.79 is the live latest",
    );
    assert.match(registry, /import \{ durableSessionOrchestration_1_0_79 \} from "\.\/orchestration\/index\.js";/);
    assert.match(registry, /\{ version: "1\.0\.70", handler: durableSessionOrchestration_1_0_70 \}/);
    assert.match(registry, /\{ version: "1\.0\.71", handler: durableSessionOrchestration_1_0_71 \}/);
    assert.match(registry, /\{ version: "1\.0\.73", handler: durableSessionOrchestration_1_0_73 \}/);
    assert.match(
        registry,
        /\{ version: DURABLE_SESSION_LATEST_VERSION, handler: durableSessionOrchestration_1_0_79 \}/,
    );
    assert.match(registry, /import \{ durableSessionOrchestration_1_0_72 \} from "\.\/orchestration_1_0_72\/index\.js";/);
    assert.match(registry, /\{ version: "1\.0\.72", handler: durableSessionOrchestration_1_0_72 \}/);
    assert.match(read("orchestration_1_0_72/runtime.ts"), /CURRENT_ORCHESTRATION_VERSION = "1\.0\.72";/);
    assert.match(read("orchestration_1_0_72/index.ts"), /export function\* durableSessionOrchestration_1_0_72\(/);
    assert.match(registry, /\{ version: "1\.0\.73", handler: durableSessionOrchestration_1_0_73 \}/);
    assert.match(read("orchestration_1_0_73/runtime.ts"), /CURRENT_ORCHESTRATION_VERSION = "1\.0\.73";/);
    assert.match(read("orchestration_1_0_73/index.ts"), /export function\* durableSessionOrchestration_1_0_73\(/);
    // 1.0.78 is upstream's last live tree, frozen here so the fork's combined
    // 1.0.79 can open without rewriting the history it inherited.
    for (const patch of [74, 75, 76, 77, 78]) {
        assert.match(registry, new RegExp(`import \\{ durableSessionOrchestration_1_0_${patch} \\} from "\\.\\/orchestration_1_0_${patch}\\/index\\.js";`));
        assert.match(registry, new RegExp(`\\{ version: "1\\.0\\.${patch}", handler: durableSessionOrchestration_1_0_${patch} \\}`));
        assert.match(read(`orchestration_1_0_${patch}/runtime.ts`), new RegExp(`CURRENT_ORCHESTRATION_VERSION = "1\\.0\\.${patch}";`));
        assert.match(read(`orchestration_1_0_${patch}/index.ts`), new RegExp(`export function\\* durableSessionOrchestration_1_0_${patch}\\(`));
    }
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
        read("orchestration_1_0_71/runtime.ts"),
        /export const CURRENT_ORCHESTRATION_VERSION = "1\.0\.71";/,
    );
    assert.doesNotMatch(
        read("orchestration_1_0_71/runtime.ts"),
        /CURRENT_ORCHESTRATION_VERSION = DURABLE_SESSION_LATEST_VERSION/,
        "the new frozen version must not follow the moving latest",
    );
    assert.match(
        read("orchestration_1_0_73/runtime.ts"),
        /export const CURRENT_ORCHESTRATION_VERSION = "1\.0\.73";/,
    );
    assert.doesNotMatch(
        read("orchestration_1_0_73/runtime.ts"),
        /CURRENT_ORCHESTRATION_VERSION = DURABLE_SESSION_LATEST_VERSION/,
        "the newest frozen version must not follow the moving latest",
    );
    assert.match(
        read("orchestration_1_0_78/runtime.ts"),
        /export const CURRENT_ORCHESTRATION_VERSION = "1\.0\.78";/,
    );
    assert.doesNotMatch(
        read("orchestration_1_0_78/runtime.ts"),
        /CURRENT_ORCHESTRATION_VERSION = DURABLE_SESSION_LATEST_VERSION/,
        "1.0.78 was the live tree until 1.0.79 opened — the freeze must pin it",
    );
    assert.match(
        read("orchestration/runtime.ts"),
        /export const CURRENT_ORCHESTRATION_VERSION = DURABLE_SESSION_LATEST_VERSION;/,
    );
    assert.match(read("orchestration/index.ts"), /export function\* durableSessionOrchestration_1_0_79\(/);
    assert.match(read("orchestration_1_0_78/index.ts"), /export function\* durableSessionOrchestration_1_0_78\(/);
    assert.match(read("orchestration_1_0_73/index.ts"), /export function\* durableSessionOrchestration_1_0_73\(/);
    assert.match(read("orchestration_1_0_71/index.ts"), /export function\* durableSessionOrchestration_1_0_71\(/);
    assert.match(read("orchestration_1_0_70/index.ts"), /export function\* durableSessionOrchestration_1_0_70\(/);
});

test("only the live 1.0.79 orchestration is owner-affinity aware", () => {
    // WHY THE BUMP: 1.0.74 routes a session's children (and the regen
    // distiller) to the worker that owns the parent by scheduling
    // spawnChildSession2 / runRegenSpawnDistiller2 instead of the base names.
    // That changes the durable yield sequence, so 1.0.73 is frozen rather than
    // edited. The freeze is the invariant: which proxy each version builds.
    //
    // 1.0.79 is the first version that builds BOTH: upstream's named-agent
    // handoff contract (versioned names, capability tag, child-result
    // provenance) and this fork's owner-aware spawn routing. Upstream's own
    // live tree is frozen as 1.0.78 with the handoff contract alone, so the
    // combination never masquerades as a version somebody else already shipped.
    assert.match(
        read("orchestration/runtime.ts"),
        /createSessionManagerProxy\(ctx, "agent-handoff-v2", \{\s*childResultProvenance: true,\s*ownerAwareRouting: true,\s*\}\)/,
        "the live 1.0.79 orchestration builds the handoff-contract + owner-aware proxy",
    );
    assert.match(
        read("orchestration/runtime.ts"),
        /createSessionProxy\(ctx, input\.sessionId, state\.affinityKey, state\.config, "agent-handoff-v2"\)/,
        "and its session proxy opts into the handoff contract",
    );
    assert.match(
        read("orchestration_1_0_78/runtime.ts"),
        /createSessionManagerProxy\(ctx, "agent-handoff-v2", \{ childResultProvenance: true \}\)/,
        "frozen 1.0.78 keeps upstream's contract-only proxy",
    );
    assert.doesNotMatch(
        read("orchestration_1_0_78/runtime.ts"),
        /ownerAwareRouting/,
        "a frozen version must not gain owner-aware routing after the fact",
    );
    assert.match(
        read("orchestration_1_0_73/runtime.ts"),
        /createSessionManagerProxy\(ctx\)/,
        "frozen 1.0.73 must keep the plain proxy — base activity names only",
    );
    assert.doesNotMatch(
        read("orchestration_1_0_73/runtime.ts"),
        /ownerAwareRouting/,
        "a frozen version must not gain owner-aware routing after the fact",
    );
    const sp = read("session-proxy.ts");
    // The proxy schedules the "2" activity names ONLY when owner-aware, and
    // both names resolve to the same handler so every version replays.
    assert.match(sp, /options\.ownerAwareRouting \? "spawnChildSession2" : "spawnChildSession"/);
    assert.match(sp, /options\.ownerAwareRouting \? "runRegenSpawnDistiller2" : "runRegenSpawnDistiller"/);
    assert.match(sp, /runtime\.registerActivity\("spawnChildSession2", spawnChildSessionActivity\)/);
    assert.match(sp, /runtime\.registerActivity\("runRegenSpawnDistiller2", runRegenSpawnDistillerActivity\)/);
});

test("runTurn keeps repo/owner isolation while the handoff contract rides the activity name", () => {
    // Duroxide carries ONE tag per activity. The capability tag and the
    // repo/owner affinity tag cannot both ride runTurn, so the affinity tag —
    // a security boundary that holds for EVERY version — is applied last, and
    // the contract is represented by the versioned name plus the fail-closed
    // tag-routing check.
    const routing = read("activity-routing.ts");
    assert.match(routing, /export const AGENT_HANDOFF_CAPABILITY = "pilotswarm\.agent-handoff\.v2";/);
    assert.match(routing, /runTurn: "runTurnV3",/);
    assert.match(routing, /runTurn2: "runTurnEpochV3",/);
    assert.match(
        routing,
        /throw new Error\("Agent handoff requires Duroxide activity tag routing support"\)/,
        "routing must fail closed when the SDK cannot express tags",
    );
    assert.match(
        routing,
        /export function runTurnRoutingTag\(/,
        "owner/repo affinity tagging must survive the handoff merge",
    );
    const sp = read("session-proxy.ts");
    assert.match(sp, /routedActivityName\(turnMeta\?\.epochStart \? "runTurn2" : "runTurn", routingContract\)/);
    assert.match(sp, /return runTurnTask\.withTag\(runTurnRoutingTag\(config\)\);/);
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

test("the live orchestration retains the 1.0.71 user-turn delivery", () => {
    const live = read("orchestration/turn.ts");
    assert.match(live, /import \{ appendSystemContextBlock, splitSystemContextBlock \} from "\.\.\/prompt-system-context\.js";/);
    const park = live.indexOf("state.config.turnSystemPrompt = turnSystemPrompt;");
    assert.ok(park >= 0, "turnSystemPrompt is still set — session-proxy records it as system.message");
    const after = live.slice(park, park + 400);
    assert.match(after, /state\.config\.systemContextInPrompt = true;/, "the flag tells session-manager not to render it");
    assert.match(after, /prompt = appendSystemContextBlock\(prompt, turnSystemPrompt\);/, "and the prompt carries it");
});

test("the live orchestration retains the 1.0.71 retry behavior", () => {
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
