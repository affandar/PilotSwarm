/**
 * Provider budgets — the runtime's half.
 *
 * See docs/proposals/providers-and-budgets.md. A session runs
 * `provider:model` and is charged to that provider. This module turns the
 * database's admission verdict into something the turn loop can act on, and
 * nothing more: the DECISION belongs to `cms_provider_check_turn`, because
 * the counters it judges are in that database. Splitting "read the numbers"
 * from "judge the numbers" across a process boundary would buy a pure
 * function and pay for it with two implementations that can disagree about
 * whether a session may run.
 *
 * What IS here is presentation and scheduling: how long a paused session
 * sleeps, what its wait says, and the pure window arithmetic the portal
 * needs to render a meter without asking the server.
 *
 * WHERE THE GATE RUNS. Inside the `runTurn` ACTIVITY, before the model is
 * touched. Activity bodies are not replay-frozen, so the check itself needs
 * no orchestration version. The POST-turn half does — see
 * schedulePostTurnContinuation in orchestration/turn.ts, and 1.0.69.
 *
 * FAILURE POSTURE: fail open. If the database cannot answer, the turn runs.
 * The counters are down too, so refusing would trade availability for the
 * enforcement of numbers nobody can currently read.
 */

export type BudgetPeriod = "day" | "week" | "month";

/** Why a session is waiting. The remedy differs for each, so the words must. */
export type BudgetPauseKind = "limit" | "allowance" | "hold" | "no_provider";

export interface BudgetRuleState {
    ruleId: string;
    providerName: string;
    period: BudgetPeriod;
    modelQualified: string | null;
    limitTokens: number;
    /** What the provider has spent this window, across everyone. */
    usedTokens: number;
    /** The viewer's ceiling, or null when the allowance is full. */
    ceilingTokens: number | null;
    /** The viewer's own spend this window, or null when there is no owner. */
    yourUsedTokens: number | null;
    windowStartUtc: string;
    resetsAtUtc: string;
}

export interface BudgetPause {
    kind: BudgetPauseKind;
    provider: string | null;
    modelRef?: string | null;
    ruleId?: string;
    period?: BudgetPeriod;
    modelQualified?: string | null;
    limitTokens?: number;
    usedTokens?: number;
    ceilingTokens?: number;
    yourUsedTokens?: number;
    /** When the pause lifts on its own. Null for a hold with no end. */
    resetsAtUtc?: string | null;
}

export interface TurnAdmission {
    verdict: "clear" | "paused" | "no_provider";
    /** The provider that pays, resolved in the session owner's namespace. */
    providerName: string | null;
    modelQualified: string | null;
    /** System sessions: never paused, still charged. */
    exempt: boolean;
    pause: BudgetPause | null;
    rules: BudgetRuleState[];
}

/**
 * A paused session sleeps until its reason expires — but never longer than
 * this. The durable timer is only the BACKSTOP: what normally wakes a
 * session is the change itself (a limit raised, an allowance widened, a hold
 * released, a missing provider created), which fires an immediate wake. The
 * cap exists for the case where that wake is missed, and for the two pauses
 * that have no natural expiry at all — an indefinite hold, and a provider
 * that does not exist. Six hours means a session can never be stranded for
 * more than a quarter of a day by a lost signal, at the cost of four cheap
 * re-checks a day: a re-check that still blocks costs no tokens, because the
 * gate runs before the model.
 */
export const MAX_BUDGET_WAIT_SECONDS = 6 * 60 * 60;

/** Below this, sleeping is pointless — the window is about to turn over. */
export const MIN_BUDGET_WAIT_SECONDS = 5;

const PERIOD_LABEL: Record<BudgetPeriod, string> = {
    day: "daily",
    week: "weekly",
    month: "monthly",
};

/** Deterministic small-integer seed from a session id. */
export function budgetJitterSeed(sessionId: string): number {
    let h = 0;
    for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) | 0;
    return Math.abs(h);
}

/**
 * Spread wake-ups so every session waiting on the same limit does not
 * stampede the database at the same instant. Scales to the wait: five
 * minutes suits a daily reset and would oversleep a short window many times
 * over. The seed must be deterministic for the caller, because the
 * orchestration replays — the same inputs must produce the same delay.
 */
export function budgetWakeJitterMs(waitMs: number, seed: number): number {
    const cap = Math.min(5 * 60 * 1000, Math.max(1_000, Math.floor(waitMs * 0.1)));
    const normalized = ((seed % 997) + 997) % 997;
    return Math.floor((normalized / 997) * cap);
}

/**
 * How long to sleep. A pause with no natural end (an indefinite hold, a
 * provider that does not exist) sleeps the full backstop; everything else
 * sleeps until it expires, capped.
 */
export function budgetWaitSeconds(pause: BudgetPause, nowMs: number, sessionId = ""): number {
    const resetMs = pause.resetsAtUtc ? Date.parse(pause.resetsAtUtc) : NaN;
    let seconds: number;
    if (!Number.isFinite(resetMs)) {
        seconds = MAX_BUDGET_WAIT_SECONDS;
    } else {
        const remainingMs = Math.max(0, resetMs - nowMs);
        const jittered = remainingMs + budgetWakeJitterMs(remainingMs, budgetJitterSeed(sessionId));
        seconds = Math.ceil(jittered / 1000);
    }
    return Math.max(MIN_BUDGET_WAIT_SECONDS, Math.min(MAX_BUDGET_WAIT_SECONDS, seconds));
}

function whenClause(pause: BudgetPause): string {
    if (!pause.resetsAtUtc) return "";
    const iso = String(pause.resetsAtUtc).replace(/\.\d{3}Z$/, "Z").replace("T", " ");
    return ` Resets ${iso}.`;
}

/**
 * The sentence a person reads on a waiting session. It names the control
 * that would release it, because the remedy is different for each kind: a
 * limit needs raising, an allowance needs widening, a hold needs releasing,
 * and a missing provider needs creating (or the session switching model).
 */
export function budgetWaitReason(pause: BudgetPause): string {
    const provider = pause.provider || "this session's provider";
    switch (pause.kind) {
        case "no_provider":
            return pause.provider
                ? `No provider named ${pause.provider}. This session waits until that name exists again, or until it is switched to another provider and model.`
                : `This session's model does not name a provider, so nothing can pay for it. Switch it to a provider and model.`;
        case "hold":
            return pause.resetsAtUtc
                ? `${provider} is on hold.${whenClause(pause)}`
                : `${provider} is on hold until an administrator releases it.`;
        case "allowance": {
            const period = pause.period ? PERIOD_LABEL[pause.period] : "";
            return `Your ${period} allowance on ${provider} is used up. The provider has room; your share of it does not.${whenClause(pause)}`;
        }
        case "limit":
        default: {
            const period = pause.period ? PERIOD_LABEL[pause.period] : "";
            const scope = pause.modelQualified ? ` for ${pause.modelQualified}` : "";
            return `${provider} has reached its ${period} limit${scope}.${whenClause(pause)}`;
        }
    }
}

/** Normalize whatever the database returned into the runtime's shape. */
export function toTurnAdmission(row: any): TurnAdmission {
    const rules = Array.isArray(row?.rules) ? row.rules : [];
    return {
        verdict: (row?.verdict as TurnAdmission["verdict"]) || "clear",
        providerName: row?.provider_name ?? row?.providerName ?? null,
        modelQualified: row?.model_qualified ?? row?.modelQualified ?? null,
        exempt: row?.exempt === true,
        pause: (row?.pause as BudgetPause) ?? null,
        rules: rules.map((r: any) => ({
            ruleId: String(r.ruleId),
            providerName: String(r.providerName),
            period: r.period as BudgetPeriod,
            modelQualified: r.modelQualified ?? null,
            limitTokens: Number(r.limitTokens ?? 0),
            usedTokens: Number(r.usedTokens ?? 0),
            ceilingTokens: r.ceilingTokens === null || r.ceilingTokens === undefined
                ? null : Number(r.ceilingTokens),
            yourUsedTokens: r.yourUsedTokens === null || r.yourUsedTokens === undefined
                ? null : Number(r.yourUsedTokens),
            windowStartUtc: String(r.windowStartUtc),
            resetsAtUtc: String(r.resetsAtUtc),
        })),
    };
}

/**
 * The gate's answer, as the turn loop wants it: either nothing (run the
 * turn) or the `wait` TurnResult that parks the session. A `wait` is what
 * the orchestration already knows how to make durable — a timer, a waiting
 * status, a wait_started event, and a resume that re-enters this same gate.
 */
export function admissionToWait(
    admission: TurnAdmission,
    sessionId: string,
    nowMs: number,
): { type: "wait"; seconds: number; reason: string; budget: true } | null {
    if (admission.exempt) return null;
    if (admission.verdict === "clear") return null;
    const pause = admission.pause ?? { kind: "limit", provider: admission.providerName };
    return {
        type: "wait",
        seconds: budgetWaitSeconds(pause, nowMs, sessionId),
        reason: budgetWaitReason(pause),
        // A TYPED flag, not a marker buried in the reader-facing text. The
        // orchestration reads it to decide whether an INTERRUPTED wait may
        // be re-armed after the turn that interrupted it: an ordinary
        // `wait()` the agent asked for must be resumed, but a budget pause
        // must not be, because that same turn already re-asked the gate and
        // got a fresh answer. Re-arming it would put a session that was just
        // released straight back to sleep. The flag rides the durable timer
        // state, so it survives a continue-as-new.
        budget: true,
    };
}

/**
 * What a woken session is told. It is not a message from a person, and the
 * transcript should not read as though somebody typed it: the change that
 * released the session already happened, and all this does is get the
 * orchestration to ask the gate again.
 */
// The [SYSTEM: prefix is LOAD-BEARING: it is what isInternalSystemPrompt
// keys on, so the nudge lands in the transcript as a system.message. Without
// it the wake painted "Internal wake-up: …" into the conversation as words
// the USER said — live-observed the first day the wake actually fired.
export const PROVIDER_BUDGET_WAKE_PROMPT =
    "[SYSTEM: The budget that paused this session has changed. "
    + "The user did not send a new message. Continue with your task.]";
