/**
 * Child notification policy helpers.
 *
 * Implements the decision logic described in the
 * "Child Contract Notification Policy" proposal:
 *
 *   - `wakeOn: "any"`             - wake parent for any child update
 *   - `wakeOn: "material_change"` - wake parent for material changes only
 *                                    (default; suppresses clear heartbeats)
 *   - `wakeOn: "completion"`      - wake parent only on terminal/blocked/error
 *
 * `wakeOn` only controls AUTONOMOUS parent wakeups. Explicit parent tools such
 * as `check_agents` and `wait_for_agents` always reveal child state regardless
 * of policy.
 *
 * This module is intentionally pure and side-effect-free so it is easy to
 * unit test and safe to call from orchestration helpers.
 *
 * @module
 */

import type { ChildSessionResult, ChildSessionVerdict, ChildSessionContract } from "./types.js";

export type ChildWakePolicy = "any" | "material_change" | "completion";

export type ChildUpdateClassification =
    | "heartbeat"
    | "material"
    | "completion"
    | "error"
    | "unknown";

/** Compact representation of a child update suitable for wake-decision logic. */
export interface ChildUpdateSnapshot {
    /** Kind of orchestration update being delivered to the parent. */
    kind: "completed" | "wait" | "progress" | "error" | "cancelled";
    /** Last assistant content / summary text emitted by the child. */
    summary?: string;
    /** Structured child result if available (final or interim). */
    result?: Partial<ChildSessionResult>;
    /** Optional explicit material flag from the child (overrides classifier). */
    material?: boolean;
}

/** Default policy when a contract is missing or unset. */
export const DEFAULT_CHILD_WAKE_POLICY: ChildWakePolicy = "material_change";

const ALL_POLICIES: ReadonlySet<ChildWakePolicy> = new Set(["any", "material_change", "completion"]);

/** Normalize an arbitrary input value to a valid `ChildWakePolicy`. */
export function normalizeWakeOn(value: unknown): ChildWakePolicy {
    if (typeof value !== "string") return DEFAULT_CHILD_WAKE_POLICY;
    const lower = value.trim().toLowerCase();
    if (ALL_POLICIES.has(lower as ChildWakePolicy)) return lower as ChildWakePolicy;
    // tolerant aliases
    if (lower === "always" || lower === "all") return "any";
    if (lower === "material" || lower === "change") return "material_change";
    if (lower === "done" || lower === "finished") return "completion";
    return DEFAULT_CHILD_WAKE_POLICY;
}

/** Read `wakeOn` off a contract (or a contract-shaped record) safely. */
export function readWakeOn(contract: Partial<ChildSessionContract> | Record<string, unknown> | null | undefined): ChildWakePolicy {
    if (!contract || typeof contract !== "object") return DEFAULT_CHILD_WAKE_POLICY;
    return normalizeWakeOn((contract as Record<string, unknown>)["wakeOn"]);
}

/**
 * Conservative no-op classifier.
 *
 * Returns true only for clear heartbeat/no-op text. Unknown / arbitrary
 * natural-language summaries default to material under `material_change`.
 */
export function isHeartbeatText(text: string | undefined): boolean {
    if (!text) return false;
    const trimmed = text.trim().toLowerCase();
    if (!trimmed) return true;
    // Common short heartbeat phrases.
    const heartbeats = [
        "no change",
        "no changes",
        "no drift",
        "no new change",
        "no new changes",
        "no new reportable change",
        "no new reportable changes",
        "no update",
        "no updates",
        "nothing to report",
        "nothing new",
        "cycle quiet",
        "quiet cycle",
        "still watching",
        "still monitoring",
        "no material change",
        "no material changes",
        "heartbeat",
        "unchanged",
        "no_change",
    ];
    if (heartbeats.includes(trimmed)) return true;
    // Allow short statements that start with a heartbeat phrase + trailing punctuation.
    for (const h of heartbeats) {
        if (trimmed === h + "." || trimmed === h + "!") return true;
    }
    return false;
}

const TERMINAL_VERDICTS: ReadonlySet<ChildSessionVerdict> = new Set([
    "success",
    "partial",
    "blocked",
    "failed",
    "cancelled",
    "timed_out",
]);

/** Classify a child update for wake-decision purposes. */
export function classifyChildUpdate(update: ChildUpdateSnapshot): ChildUpdateClassification {
    if (update.kind === "error") return "error";

    // Treat cancelled as completion for routing purposes (parent should know).
    if (update.kind === "cancelled") return "completion";

    // Completed turn with a recognized terminal verdict.
    if (update.kind === "completed") {
        const verdict = update.result?.verdict;
        if (verdict && TERMINAL_VERDICTS.has(verdict)) {
            if (verdict === "blocked" || verdict === "failed" || verdict === "timed_out") return "completion";
            return "completion";
        }
        // Completed turn without a verdict — treat as material so parent sees the summary.
        return update.material === false && isHeartbeatText(update.summary) ? "heartbeat" : "material";
    }

    // Explicit material flag from the child wins.
    if (update.material === true) return "material";
    if (update.material === false) return "heartbeat";

    // Structured verdict hints during a wait/progress turn.
    const verdictHint = (update.result as Record<string, unknown> | undefined)?.verdict;
    if (typeof verdictHint === "string") {
        const v = verdictHint.toLowerCase();
        if (v === "heartbeat" || v === "unchanged" || v === "no_change") return "heartbeat";
    }

    // Fall back to text classification.
    if (isHeartbeatText(update.summary)) return "heartbeat";
    if (!update.summary) return "unknown";
    return "material";
}

export interface ParentWakeDecisionInput {
    update: ChildUpdateSnapshot;
    contract?: Partial<ChildSessionContract> | Record<string, unknown> | null;
}

export interface ParentWakeDecision {
    wake: boolean;
    policy: ChildWakePolicy;
    classification: ChildUpdateClassification;
    reason: string;
}

/**
 * Decide whether the parent session should be woken for the given child update.
 *
 * The conservative rule: when the helper cannot confidently classify an
 * update as a heartbeat under `material_change`, it wakes the parent
 * rather than risk silently swallowing important work.
 */
export function shouldWakeParentForChildUpdate(input: ParentWakeDecisionInput): ParentWakeDecision {
    const policy = readWakeOn(input.contract ?? null);
    const classification = classifyChildUpdate(input.update);

    if (policy === "any") {
        return { wake: true, policy, classification, reason: "policy=any" };
    }

    if (policy === "completion") {
        if (classification === "completion" || classification === "error") {
            return { wake: true, policy, classification, reason: `policy=completion classification=${classification}` };
        }
        return { wake: false, policy, classification, reason: `policy=completion classification=${classification}` };
    }

    // material_change (default)
    if (classification === "heartbeat") {
        return { wake: false, policy, classification, reason: "policy=material_change classification=heartbeat" };
    }
    return { wake: true, policy, classification, reason: `policy=material_change classification=${classification}` };
}

/**
 * Evaluate a batch of pending child updates against the parent's active wait.
 *
 * Used as the digest-defense guard described in the proposal: a heartbeat-only
 * batch should not interrupt an active parent cron wait; a mixed batch with
 * any material update wakes the parent.
 */
export function shouldWakeParentForChildDigest(updates: Array<ParentWakeDecisionInput>): ParentWakeDecision {
    if (updates.length === 0) {
        return { wake: false, policy: DEFAULT_CHILD_WAKE_POLICY, classification: "unknown", reason: "empty digest" };
    }
    let firstHeartbeat: ParentWakeDecision | undefined;
    for (const u of updates) {
        const d = shouldWakeParentForChildUpdate(u);
        if (d.wake) return d;
        if (!firstHeartbeat) firstHeartbeat = d;
    }
    return firstHeartbeat!;
}
