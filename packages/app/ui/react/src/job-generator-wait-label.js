// Canonical presentation of durable Job waits.
//
// The control plane persists three durable wait kinds (see JobWaitKind in the
// SDK CMS): "response", "observed_condition", and "timer". The portal must
// surface the *specific* durable reason a Job is parked rather than the earlier
// ambiguous "human wait" / "system wait" phrasing, and must visibly distinguish
// response waits (a human answers in the session; there is an answer control)
// from observed-condition waits (an external provider such as Azure DevOps is
// authoritative, no worker is retained, and there is no answer control).

function normalizeWaitKey(value) {
    return String(value ?? "").trim().toLowerCase();
}

// In-product glossary explaining why a Job is parked, grounded in each wait
// kind's authoritative completion contract. Rendered as contextual help in the
// Job inspector so operators do not have to infer the difference between a wait
// they can answer and one that only an external authority can satisfy.
export const JOB_WAIT_GLOSSARY = Object.freeze([
    Object.freeze({
        kind: "response",
        title: "Response wait",
        rationale: "The Job is waiting for a human decision. Open the session to answer;"
            + " the answer is submitted directly and resumes the state run.",
    }),
    Object.freeze({
        kind: "observed_condition",
        title: "Observed-condition wait",
        rationale: "The Job is waiting for an external authority (for example Azure DevOps)"
            + " to report a condition such as human code review or pull request completion."
            + " There is no answer control and no worker is retained; the platform observes"
            + " the provider and resumes when the condition is satisfied.",
    }),
    Object.freeze({
        kind: "timer",
        title: "Scheduled wait",
        rationale: "The Job is waiting for a scheduled time. No worker is retained; the state"
            + " run resumes automatically when the timer elapses.",
    }),
]);

export function jobWaitGlossaryEntry(kind) {
    const normalized = normalizeWaitKey(kind);
    return JOB_WAIT_GLOSSARY.find((entry) => entry.kind === normalized) || null;
}

function waitPredicateKind(wait) {
    return normalizeWaitKey(wait?.predicate?.kind || wait?.prompt?.kind);
}

// Human-readable label for the observed condition a wait is blocked on.
export function describeObservedConditionPredicate(wait) {
    const predicateKind = waitPredicateKind(wait);
    if (predicateKind === "required_reviewers" || predicateKind === "required_reviewer_approval") {
        return { reason: "Awaiting human code review", predicateLabel: "human code review" };
    }
    if (predicateKind === "pull_request_completion" || predicateKind === "pr_completion") {
        return { reason: "Awaiting PR completion", predicateLabel: "pull request completion" };
    }
    return {
        reason: "Awaiting external condition",
        predicateLabel: predicateKind ? predicateKind.replaceAll("_", " ") : "the external condition",
    };
}

function normalizeConditionState(value) {
    const token = String(value ?? "").trim().toLowerCase();
    if (["satisfied", "approved", "notapplicable", "not_applicable", "success", "succeeded",
        "passed", "completed", "true", "done", "ready"].includes(token)) {
        return "satisfied";
    }
    if (["failed", "rejected", "broken", "error", "false", "cancelled", "canceled"].includes(token)) {
        return "failed";
    }
    return "pending";
}

// Normalize an observed-condition wait's latest observation into a flat list of
// the individual conditions the platform is evaluating, each tagged with whether
// it is satisfied, still pending, or failed. The portal renders one row per
// condition with a status glyph. This is observer-agnostic: an observer may emit
// an explicit `conditions` array (preferred going forward), otherwise the
// conditions are derived from the stock pull-request-approval evidence shape
// (required reviewers + blocking branch policies).
export function describeObservedConditionChecks(wait) {
    if (!wait || wait.kind !== "observed_condition") return [];
    const observation = wait.latestObservation;
    if (!observation || typeof observation !== "object") return [];

    const overrides = new Set(
        Array.isArray(wait.conditionOverrides) ? wait.conditionOverrides : [],
    );
    const finalize = (check) => {
        const overridden = overrides.has(check.key);
        return {
            ...check,
            overridden,
            state: overridden ? "satisfied" : check.state,
        };
    };

    if (Array.isArray(observation.conditions)) {
        return observation.conditions.map((condition, index) => {
            const rawState = condition.state
                ?? (condition.satisfied === true ? "satisfied"
                    : condition.satisfied === false ? "pending" : condition.status);
            return finalize({
                key: String(condition.key ?? condition.id ?? condition.label ?? index),
                label: String(condition.label ?? condition.name ?? `Condition ${index + 1}`),
                state: normalizeConditionState(rawState),
                detail: condition.detail ? String(condition.detail) : null,
            });
        });
    }

    const checks = [];
    const reviewers = Array.isArray(observation.requiredReviewers) ? observation.requiredReviewers : [];
    for (const reviewer of reviewers) {
        const name = reviewer.displayName || reviewer.uniqueName || "required reviewer";
        checks.push(finalize({
            key: `reviewer:${reviewer.id ?? reviewer.uniqueName ?? name}`,
            label: `Review · ${name}`,
            state: reviewer.approved === true || Number(reviewer.vote) >= 5 ? "satisfied" : "pending",
            detail: null,
        }));
    }
    const policies = Array.isArray(observation.policies) ? observation.policies : [];
    for (const policy of policies) {
        if (policy.isEnabled === false || policy.isBlocking === false) continue;
        const name = policy.displayName || policy.typeName || "policy";
        checks.push(finalize({
            key: `policy:${policy.configurationId ?? policy.evaluationId ?? name}`,
            label: `Policy · ${name}`,
            state: normalizeConditionState(policy.status),
            detail: policy.status ? String(policy.status) : null,
        }));
    }
    return checks;
}

// Short badge label for a Job wait (used for state-run status chips and the
// transition inspector heading). Preserves the historical outputs so existing
// callers keep their exact copy.
export function persistedJobWaitLabel(wait) {
    if (!wait) return null;
    if (wait.status !== "pending") {
        return wait.kind === "response" ? "Decision received" : "Condition satisfied";
    }
    if (wait.kind === "response") return "Awaiting decision";
    if (wait.kind === "timer") return "Awaiting scheduled time";
    return describeObservedConditionPredicate(wait).reason;
}

function providerLabelFor(wait) {
    return wait?.provider ? String(wait.provider).replaceAll("_", " ") : null;
}

// Rich descriptor for a *pending* Job wait, used both by the durable transition
// timeline (synthetic parked entry) and the Job inspector. When the wait row is
// unavailable, `statusFallback` (the state-run status) is used to infer whether
// the Job is parked on a response wait ("input_required") or an
// observed-condition wait ("waiting").
export function describeJobWait(wait, statusFallback = null) {
    const descriptor = describeJobWaitInternal(wait, statusFallback);
    descriptor.glossary = jobWaitGlossaryEntry(descriptor.kind);
    return descriptor;
}

function describeJobWaitInternal(wait, statusFallback) {
    if (!wait) {
        const isResponse = statusFallback === "input_required";
        return {
            kind: isResponse ? "response" : "observed_condition",
            isResponseWait: isResponse,
            answerable: isResponse,
            retainsWorker: false,
            reason: isResponse ? "Awaiting decision" : "Awaiting external condition",
            providerLabel: null,
            predicateLabel: null,
            timelineLabel: isResponse ? "Response wait parked" : "Observed-condition wait parked",
            timelineDetail: isResponse
                ? "No worker is runnable until a human answers in the session."
                : "No worker is retained until the observed condition is satisfied.",
        };
    }
    const reason = persistedJobWaitLabel(wait);
    if (wait.kind === "response") {
        const answerable = wait.status === "pending";
        return {
            kind: "response",
            isResponseWait: true,
            answerable,
            retainsWorker: false,
            reason,
            providerLabel: null,
            predicateLabel: null,
            timelineLabel: answerable ? "Response wait parked" : "Response received",
            timelineDetail: "No worker is runnable until a human answers in the session.",
        };
    }
    if (wait.kind === "timer") {
        return {
            kind: "timer",
            isResponseWait: false,
            answerable: false,
            retainsWorker: false,
            reason,
            providerLabel: null,
            predicateLabel: null,
            timelineLabel: "Scheduled wait pending",
            timelineDetail: "No worker is runnable until the scheduled time arrives.",
        };
    }
    const predicate = describeObservedConditionPredicate(wait);
    const providerLabel = providerLabelFor(wait);
    return {
        kind: "observed_condition",
        isResponseWait: false,
        answerable: false,
        retainsWorker: false,
        reason,
        providerLabel,
        predicateLabel: predicate.predicateLabel,
        timelineLabel: "Observed-condition wait parked",
        timelineDetail: providerLabel
            ? `${providerLabel} state is authoritative; no worker is retained until ${predicate.predicateLabel} is observed.`
            : `No worker is retained until ${predicate.predicateLabel} is observed.`,
    };
}
