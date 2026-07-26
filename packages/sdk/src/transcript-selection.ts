/**
 * Transcript Selection — choosing WHICH messages a regen distiller reads.
 *
 * Deliberately dependency-free and side-effect-free: no CMS, no artifact
 * store, no clock, no randomness. It takes an array of messages and returns
 * a selection. That makes it testable in isolation (fixtures + an LLM-judge
 * suite) without standing up a session, and keeps it safe to call from a
 * durable activity, where a retry must reproduce the identical result.
 *
 * The default strategy is EXCHANGE-CLUSTERED salience:
 *
 *   A long agent transcript is mostly assistant self-talk — status pings,
 *   cron re-arms, "no new signal" cycle reports. The parts that carry intent
 *   are the exchanges: a user says something and the agent responds, possibly
 *   over several turns. Those clusters are what a resumed session needs; the
 *   unattached machinery between them is what it can afford to lose.
 *
 *   So salience is defined structurally rather than lexically: distance to
 *   the nearest user message. No keyword lists to tune, no model call, and it
 *   degrades sensibly on transcripts with few user messages (it simply keeps
 *   more of the surrounding context per exchange).
 */

/** A transcript message as the selector sees it. */
export interface SelectableMessage {
    /** Monotonic order key (CMS seq). Ties break on array position. */
    seq: number;
    /** Only "user" and "assistant" participate; "system" is dropped up front. */
    role: "user" | "assistant" | "system";
    /** Message text; used for size accounting only. */
    text: string;
}

export interface SelectionOptions {
    /** Total messages to keep. Default 1000. */
    budget?: number;
    /**
     * Split of the budget between the head and tail halves of the
     * transcript. Default 0.5 — first 500 / last 500 at a 1000 budget.
     */
    headFraction?: number;
    /**
     * How many messages after a user message still count as part of that
     * exchange (the agent's reply may span several turns). Default 6.
     */
    exchangeWindow?: number;
}

export interface SelectionElision {
    /** Selected message this gap follows (null = gap precedes everything kept). */
    afterSeq: number | null;
    /** How many messages were dropped. */
    count: number;
    /** Inclusive seq range of the dropped run. */
    span: [number, number];
}

export interface SelectionResult {
    /** Chosen messages, chronological. */
    selected: SelectableMessage[];
    /** Gaps between kept messages, so the distiller never infers continuity. */
    elisions: SelectionElision[];
    strategy: string;
    stats: {
        inputTotal: number;
        systemDropped: number;
        eligible: number;
        selectedCount: number;
        headSelected: number;
        tailSelected: number;
        userKept: number;
        droppedCount: number;
    };
}

export interface TranscriptSelectionStrategy {
    readonly name: string;
    describe(): string;
    select(messages: SelectableMessage[], options?: SelectionOptions): SelectionResult;
}

const DEFAULT_BUDGET = 1_000;
const DEFAULT_HEAD_FRACTION = 0.5;
const DEFAULT_EXCHANGE_WINDOW = 6;

/**
 * Salience = proximity to a user message, scored on the eligible (non-system)
 * sequence. A user message scores highest; an assistant message scores by how
 * close it sits to the user message it answers.
 *
 * Messages AFTER a user message score higher than messages before it at the
 * same distance: the reply to a question is the substance, whereas the turns
 * preceding a question are usually the routine the user interrupted.
 */
export function scoreByExchangeProximity(
    messages: SelectableMessage[],
    exchangeWindow: number = DEFAULT_EXCHANGE_WINDOW,
): number[] {
    const n = messages.length;
    const scores = new Array<number>(n).fill(0);
    if (n === 0) return scores;

    // Distance to the nearest user message at or before each index.
    const sinceUser = new Array<number>(n).fill(Number.POSITIVE_INFINITY);
    let d = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i += 1) {
        d = messages[i].role === "user" ? 0 : (d === Number.POSITIVE_INFINITY ? d : d + 1);
        sinceUser[i] = d;
    }
    // Distance to the nearest user message at or after each index.
    const untilUser = new Array<number>(n).fill(Number.POSITIVE_INFINITY);
    d = Number.POSITIVE_INFINITY;
    for (let i = n - 1; i >= 0; i -= 1) {
        d = messages[i].role === "user" ? 0 : (d === Number.POSITIVE_INFINITY ? d : d + 1);
        untilUser[i] = d;
    }

    const window = Math.max(1, exchangeWindow);
    for (let i = 0; i < n; i += 1) {
        if (messages[i].role === "user") {
            // A user message is never dropped while budget remains.
            scores[i] = Number.POSITIVE_INFINITY;
            continue;
        }
        // Replies decay across the window; lead-ins decay twice as fast.
        const after = sinceUser[i] <= window ? 1 - (sinceUser[i] - 1) / (window + 1) : 0;
        const before = untilUser[i] <= window ? (1 - (untilUser[i] - 1) / (window + 1)) * 0.5 : 0;
        scores[i] = Math.max(after, before, 0);
    }
    return scores;
}

/**
 * Take `count` items from `pool` (indices into `messages`) by descending
 * score. Ties — including the vast tail of zero-scored filler — break on
 * position so the result is deterministic and never clumps: for equal
 * scores the EARLIER message wins in the head half and the LATER one in the
 * tail half, which keeps each half anchored at its own edge.
 */
function takeTopScored(
    pool: number[],
    scores: number[],
    count: number,
    prefer: "earliest" | "latest",
): number[] {
    if (count <= 0) return [];
    if (pool.length <= count) return pool.slice();
    const ordered = pool.slice().sort((a, b) => {
        // COMPARE, never subtract: user messages score +Infinity, and
        // Infinity - Infinity is NaN. A NaN comparator result is coerced to
        // "equal", so the stable sort silently preserved ascending order and
        // the `latest` preference never applied — on a user-dense chat the
        // NEWEST messages were dropped, the exact opposite of the intent.
        //
        // Written as two one-sided comparisons rather than `!==` + `<` so that
        // a NaN score (unreachable today, but one refactor away) falls through
        // to the positional tie-break instead of making the comparator
        // non-antisymmetric — which is the same class of bug, relocated.
        if (scores[a] > scores[b]) return -1;
        if (scores[b] > scores[a]) return 1;
        return prefer === "earliest" ? a - b : b - a;
    });
    return ordered.slice(0, count).sort((a, b) => a - b);
}

/**
 * Fill a budget from `pool`, split between the transcript's head and tail
 * halves so both ends survive. Unused budget in one half flows to the other
 * rather than being lost.
 */
function fillHalves(
    pool: number[],
    scores: number[],
    budget: number,
    headFraction: number,
    mid: number,
): number[] {
    if (budget <= 0 || pool.length === 0) return [];
    const head = pool.filter((i) => i < mid);
    const tail = pool.filter((i) => i >= mid);
    const headBudget = Math.min(budget, Math.round(budget * headFraction));
    const tailBudget = budget - headBudget;

    let headPick = takeTopScored(head, scores, headBudget, "earliest");
    let tailPick = takeTopScored(tail, scores, tailBudget, "latest");
    const headSlack = headBudget - headPick.length;
    const tailSlack = tailBudget - tailPick.length;
    if (headSlack > 0 && tailPick.length < tail.length) {
        tailPick = takeTopScored(tail, scores, tailBudget + headSlack, "latest");
    } else if (tailSlack > 0 && headPick.length < head.length) {
        headPick = takeTopScored(head, scores, headBudget + tailSlack, "earliest");
    }
    return headPick.concat(tailPick);
}

function buildElisions(
    eligible: SelectableMessage[],
    keptIdx: number[],
): SelectionElision[] {
    const elisions: SelectionElision[] = [];
    const kept = new Set(keptIdx);
    let runStart: number | null = null;
    let lastKeptSeq: number | null = null;

    for (let i = 0; i < eligible.length; i += 1) {
        if (kept.has(i)) {
            if (runStart !== null) {
                elisions.push({
                    afterSeq: lastKeptSeq,
                    count: i - runStart,
                    span: [eligible[runStart].seq, eligible[i - 1].seq],
                });
                runStart = null;
            }
            lastKeptSeq = eligible[i].seq;
        } else if (runStart === null) {
            runStart = i;
        }
    }
    if (runStart !== null) {
        elisions.push({
            afterSeq: lastKeptSeq,
            count: eligible.length - runStart,
            span: [eligible[runStart].seq, eligible[eligible.length - 1].seq],
        });
    }
    return elisions;
}

/**
 * Exchange-clustered selection: drop system messages, split the remainder in
 * half, and fill each half with its most salient messages — first N from the
 * head, last N from the tail.
 */
export const exchangeClusteredStrategy: TranscriptSelectionStrategy = {
    name: "exchange-clustered",
    describe() {
        return "Keeps user↔assistant exchanges: system messages dropped, budget split "
            + "between the transcript's head and tail, each filled by proximity to a user message.";
    },
    select(messages: SelectableMessage[], options: SelectionOptions = {}): SelectionResult {
        const budget = Math.max(0, Math.floor(options.budget ?? DEFAULT_BUDGET));
        const headFraction = Math.min(1, Math.max(0, options.headFraction ?? DEFAULT_HEAD_FRACTION));
        const exchangeWindow = Math.max(1, Math.floor(options.exchangeWindow ?? DEFAULT_EXCHANGE_WINDOW));

        const input = messages.slice().sort((a, b) => a.seq - b.seq);
        const eligible = input.filter((m) => m.role !== "system");
        const systemDropped = input.length - eligible.length;

        const baseStats = {
            inputTotal: input.length,
            systemDropped,
            eligible: eligible.length,
        };

        // Halve on message position, so "first 500 / last 500" means the most
        // salient of the first half and of the second half — not the first 500
        // messages, which would be pure recency-blindness.
        const mid = Math.floor(eligible.length / 2);
        const finish = (keptIdx: number[]): SelectionResult => {
            const selected = keptIdx.map((i) => eligible[i]);
            return {
                selected,
                elisions: buildElisions(eligible, keptIdx),
                strategy: this.name,
                stats: {
                    ...baseStats,
                    selectedCount: selected.length,
                    // Counted by position, so these never claim a split that
                    // did not happen.
                    headSelected: keptIdx.filter((i) => i < mid).length,
                    tailSelected: keptIdx.filter((i) => i >= mid).length,
                    userKept: selected.filter((m) => m.role === "user").length,
                    droppedCount: eligible.length - selected.length,
                },
            };
        };

        // Everything fits: no selection is better than any selection.
        if (eligible.length <= budget) {
            return finish(eligible.map((_, i) => i));
        }

        const scores = scoreByExchangeProximity(eligible, exchangeWindow);

        // Reserve in PRIORITY TIERS, globally, before any positional split.
        //
        // Splitting first was wrong: the halves each spent their own budget,
        // so a +Infinity user message in a user-dense half lost to a
        // zero-score filler message in a quiet half. On the shape this module
        // exists for — a chatty setup phase followed by a long autonomous run
        // — that dropped real user turns while keeping cron noise, breaking
        // the invariant this file documents.
        const kept = new Set<number>();

        // Tier 0 — the first and last eligible messages. The opening states
        // the mission and the closing states where the work actually stands;
        // neither is recoverable from anything else in the transcript.
        for (const anchor of [0, eligible.length - 1]) {
            if (kept.size < budget) kept.add(anchor);
        }

        // Tier 1 — user messages. Never dropped while budget remains. Only
        // when the users alone overflow the budget does the head/tail split
        // apply to them, keeping the earliest and latest exchanges.
        const users: number[] = [];
        for (let i = 0; i < eligible.length; i += 1) {
            if (eligible[i].role === "user" && !kept.has(i)) users.push(i);
        }
        for (const i of fillHalves(users, scores, budget - kept.size, headFraction, mid)) {
            kept.add(i);
        }

        // Tier 2 — everything else, by salience, head and tail balanced.
        const rest: number[] = [];
        for (let i = 0; i < eligible.length; i += 1) {
            if (!kept.has(i)) rest.push(i);
        }
        for (const i of fillHalves(rest, scores, budget - kept.size, headFraction, mid)) {
            kept.add(i);
        }

        return finish([...kept].sort((a, b) => a - b));
    },
};

const REGISTRY = new Map<string, TranscriptSelectionStrategy>([
    [exchangeClusteredStrategy.name, exchangeClusteredStrategy],
]);

export function registerSelectionStrategy(strategy: TranscriptSelectionStrategy): void {
    REGISTRY.set(strategy.name, strategy);
}

export function resolveSelectionStrategy(name?: string): TranscriptSelectionStrategy {
    if (name) {
        const found = REGISTRY.get(name);
        if (found) return found;
    }
    return exchangeClusteredStrategy;
}

export function listSelectionStrategies(): TranscriptSelectionStrategy[] {
    return [...REGISTRY.values()];
}

/** Convenience wrapper: resolve by name and run. */
export function selectTranscript(
    messages: SelectableMessage[],
    options: SelectionOptions & { strategy?: string } = {},
): SelectionResult {
    return resolveSelectionStrategy(options.strategy).select(messages, options);
}
