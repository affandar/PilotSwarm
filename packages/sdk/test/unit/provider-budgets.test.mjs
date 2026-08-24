/**
 * Provider budgets — the pure runtime half.
 *
 * Everything that DECIDES lives in SQL (see migration 0051 and
 * test/local/provider-budgets.test.js). What is left in TypeScript is
 * scheduling and words: how long a paused session sleeps, what its wait
 * says, and the shape the database's row becomes. This file pins that.
 *
 * NOTE: imports from dist/, so `npm run build -w packages/sdk` must have run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    MAX_BUDGET_WAIT_SECONDS,
    MIN_BUDGET_WAIT_SECONDS,
    admissionToWait,
    budgetJitterSeed,
    budgetWaitReason,
    budgetWaitSeconds,
    budgetWakeJitterMs,
    toTurnAdmission,
} from "../../dist/provider-budgets.js";

const NOW = Date.parse("2026-03-14T12:00:00.000Z");
const IN_TWO_HOURS = "2026-03-14T14:00:00.000Z";

const clear = { verdict: "clear", provider_name: "team", exempt: false, pause: null, rules: [] };

// ── how long a pause sleeps ──────────────────────────────────────────

test("a pause sleeps until its reason expires", () => {
    const s = budgetWaitSeconds({ kind: "limit", provider: "team", resetsAtUtc: IN_TWO_HOURS }, NOW);
    // Two hours, plus at most 10% of jitter.
    assert.ok(s >= 7200, `expected at least 7200s, got ${s}`);
    assert.ok(s <= 7200 * 1.1 + 1, `expected roughly 7200s, got ${s}`);
});

test("a pause with no natural end sleeps the backstop, not forever", () => {
    // An indefinite hold and a provider that does not exist both lift only
    // when a person acts. The timer is the safety net for a missed wake.
    for (const pause of [
        { kind: "hold", provider: "team", resetsAtUtc: null },
        { kind: "no_provider", provider: "gone" },
    ]) {
        assert.equal(budgetWaitSeconds(pause, NOW), MAX_BUDGET_WAIT_SECONDS);
    }
});

test("a long window is capped, so a lost wake cannot strand a session for a month", () => {
    const s = budgetWaitSeconds(
        { kind: "limit", provider: "team", resetsAtUtc: "2026-04-01T00:00:00.000Z" }, NOW);
    assert.equal(s, MAX_BUDGET_WAIT_SECONDS);
});

test("a reset that has already passed still sleeps a moment rather than spinning", () => {
    const s = budgetWaitSeconds(
        { kind: "limit", provider: "team", resetsAtUtc: "2026-03-14T11:59:59.000Z" }, NOW);
    assert.equal(s, MIN_BUDGET_WAIT_SECONDS);
});

test("an unparseable reset is treated as no reset at all", () => {
    assert.equal(
        budgetWaitSeconds({ kind: "limit", provider: "team", resetsAtUtc: "not a date" }, NOW),
        MAX_BUDGET_WAIT_SECONDS);
});

test("jitter is deterministic for a session, because the orchestration replays", () => {
    const pause = { kind: "limit", provider: "team", resetsAtUtc: IN_TWO_HOURS };
    const a = budgetWaitSeconds(pause, NOW, "session-abc");
    const b = budgetWaitSeconds(pause, NOW, "session-abc");
    assert.equal(a, b, "the same session must compute the same delay every replay");
});

test("jitter spreads different sessions apart", () => {
    const pause = { kind: "limit", provider: "team", resetsAtUtc: IN_TWO_HOURS };
    const spread = new Set(
        ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => budgetWaitSeconds(pause, NOW, id)));
    assert.ok(spread.size > 1, "every session woke at the same instant — that is a stampede");
});

test("jitter never exceeds five minutes, however long the wait", () => {
    const week = 7 * 24 * 60 * 60 * 1000;
    for (const seed of [0, 1, 500, 996, 12345]) {
        assert.ok(budgetWakeJitterMs(week, seed) <= 5 * 60 * 1000);
    }
});

test("jitter is never negative, even for a negative seed", () => {
    assert.ok(budgetWakeJitterMs(60_000, -12345) >= 0);
    assert.ok(budgetJitterSeed("anything") >= 0);
});

// ── what a paused session says ───────────────────────────────────────

test("each pause names the control that would release it", () => {
    const limit = budgetWaitReason({
        kind: "limit", provider: "azure-prod", period: "day", resetsAtUtc: IN_TWO_HOURS });
    assert.match(limit, /azure-prod/);
    assert.match(limit, /daily limit/);
    assert.match(limit, /Resets 2026-03-14 14:00:00Z/);

    const allowance = budgetWaitReason({
        kind: "allowance", provider: "azure-prod", period: "week", resetsAtUtc: IN_TWO_HOURS });
    assert.match(allowance, /allowance/);
    // The distinction that matters: the provider is fine, your share is not.
    assert.match(allowance, /provider has room/);

    const hold = budgetWaitReason({ kind: "hold", provider: "azure-prod", resetsAtUtc: null });
    assert.match(hold, /on hold/);
    assert.match(hold, /administrator/);

    const missing = budgetWaitReason({ kind: "no_provider", provider: "carol-ghcp" });
    assert.match(missing, /No provider named carol-ghcp/);
    // Both ways out are named, because neither happens on its own.
    assert.match(missing, /switched to another provider/);
});

test("a limit on one model says which model", () => {
    const reason = budgetWaitReason({
        kind: "limit", provider: "team", period: "month",
        modelQualified: "team:gpt-5.4", resetsAtUtc: IN_TWO_HOURS });
    assert.match(reason, /team:gpt-5\.4/);
});

test("a model reference with no provider explains what to do about it", () => {
    const reason = budgetWaitReason({ kind: "no_provider", provider: null });
    assert.match(reason, /does not name a provider/);
});

// ── the gate's answer ────────────────────────────────────────────────

test("a clear verdict produces no wait", () => {
    assert.equal(admissionToWait(toTurnAdmission(clear), "s1", NOW), null);
});

test("machinery is never paused, whatever the verdict says", () => {
    // Belt and braces: the database already exempts system sessions, and
    // this is the second guard. A paused Token Manager is a cluster where
    // nobody can raise the limit that paused it.
    const exempt = toTurnAdmission({
        verdict: "paused", provider_name: "team", exempt: true,
        pause: { kind: "limit", provider: "team" }, rules: [],
    });
    assert.equal(admissionToWait(exempt, "s1", NOW), null);
});

test("a paused verdict becomes a wait that is flagged as a budget wait", () => {
    const wait = admissionToWait(toTurnAdmission({
        verdict: "paused", provider_name: "team", exempt: false,
        pause: { kind: "limit", provider: "team", period: "day", resetsAtUtc: IN_TWO_HOURS },
        rules: [],
    }), "s1", NOW);
    assert.equal(wait.type, "wait");
    // The flag is what stops the orchestration re-arming this pause after
    // the turn that woke it — see orchestration/turn.ts.
    assert.equal(wait.budget, true);
    assert.ok(wait.seconds > 0);
    assert.match(wait.reason, /team/);
});

test("a missing provider becomes a wait too, not an error", () => {
    const wait = admissionToWait(toTurnAdmission({
        verdict: "no_provider", provider_name: "gone", exempt: false,
        pause: { kind: "no_provider", provider: "gone" }, rules: [],
    }), "s1", NOW);
    assert.equal(wait.type, "wait");
    assert.equal(wait.budget, true);
});

test("a paused verdict with no pause record still parks the session", () => {
    // Defensive: a verdict this module cannot explain must not become a
    // silent 'run the turn'.
    const wait = admissionToWait(toTurnAdmission({
        verdict: "paused", provider_name: "team", exempt: false, pause: null, rules: [],
    }), "s1", NOW);
    assert.ok(wait, "a paused session with no reason must still wait");
});

// ── the database's row becomes an object ─────────────────────────────

test("rule states carry both the provider's number and the viewer's own", () => {
    const a = toTurnAdmission({
        verdict: "clear", provider_name: "team", model_qualified: "team:gpt", exempt: false, pause: null,
        rules: [{
            ruleId: "r1", providerName: "team", period: "day", modelQualified: null,
            limitTokens: 1000, usedTokens: 400, ceilingTokens: 200, yourUsedTokens: 150,
            windowStartUtc: "2026-03-14T00:00:00.000Z", resetsAtUtc: "2026-03-15T00:00:00.000Z",
        }],
    });
    assert.equal(a.rules.length, 1);
    assert.equal(a.rules[0].limitTokens, 1000);
    assert.equal(a.rules[0].usedTokens, 400);
    assert.equal(a.rules[0].ceilingTokens, 200);
    assert.equal(a.rules[0].yourUsedTokens, 150);
});

test("a full allowance leaves the per-person columns null, not zero", () => {
    // Zero would render as "you have used none of your share" on a provider
    // where no such share exists.
    const a = toTurnAdmission({
        verdict: "clear", provider_name: "team", exempt: false, pause: null,
        rules: [{
            ruleId: "r1", providerName: "team", period: "day", modelQualified: null,
            limitTokens: 1000, usedTokens: 400, ceilingTokens: null, yourUsedTokens: null,
            windowStartUtc: "2026-03-14T00:00:00.000Z", resetsAtUtc: "2026-03-15T00:00:00.000Z",
        }],
    });
    assert.equal(a.rules[0].ceilingTokens, null);
    assert.equal(a.rules[0].yourUsedTokens, null);
});

test("an empty row is read as clear rather than throwing", () => {
    const a = toTurnAdmission({});
    assert.equal(a.verdict, "clear");
    assert.equal(a.providerName, null);
    assert.deepEqual(a.rules, []);
});
