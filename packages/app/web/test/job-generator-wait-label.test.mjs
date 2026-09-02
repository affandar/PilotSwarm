import assert from "node:assert/strict";
import test from "node:test";
import {
    JOB_WAIT_GLOSSARY,
    describeJobWait,
    describeObservedConditionChecks,
    describeObservedConditionPredicate,
    jobWaitGlossaryEntry,
    persistedJobWaitLabel,
} from "../../ui/react/src/job-generator-wait-label.js";

test("persistedJobWaitLabel names the specific durable reason for a pending wait", () => {
    assert.equal(persistedJobWaitLabel(null), null);
    assert.equal(
        persistedJobWaitLabel({ kind: "response", status: "pending" }),
        "Awaiting decision",
    );
    assert.equal(
        persistedJobWaitLabel({ kind: "timer", status: "pending" }),
        "Awaiting scheduled time",
    );
    assert.equal(
        persistedJobWaitLabel({
            kind: "observed_condition",
            status: "pending",
            predicate: { kind: "required_reviewers" },
        }),
        "Awaiting human code review",
    );
    assert.equal(
        persistedJobWaitLabel({
            kind: "observed_condition",
            status: "pending",
            predicate: { kind: "pull_request_completion" },
        }),
        "Awaiting PR completion",
    );
    assert.equal(
        persistedJobWaitLabel({
            kind: "observed_condition",
            status: "pending",
            predicate: { kind: "custom_gate" },
        }),
        "Awaiting external condition",
    );
});

test("persistedJobWaitLabel reports satisfaction once a wait is no longer pending", () => {
    assert.equal(
        persistedJobWaitLabel({ kind: "response", status: "satisfied" }),
        "Decision received",
    );
    assert.equal(
        persistedJobWaitLabel({ kind: "observed_condition", status: "satisfied" }),
        "Condition satisfied",
    );
});

test("describeJobWait marks a response wait as answerable in the session", () => {
    const info = describeJobWait({
        waitId: "wait-1",
        kind: "response",
        status: "pending",
        detectionMode: "direct_submission",
    });
    assert.equal(info.kind, "response");
    assert.equal(info.isResponseWait, true);
    assert.equal(info.answerable, true);
    assert.equal(info.reason, "Awaiting decision");
    assert.equal(info.timelineLabel, "Response wait parked");
    assert.match(info.timelineDetail, /answers in the session/);
    assert.equal(info.glossary.kind, "response");
});

test("describeJobWait surfaces provider, predicate and no-worker-retained for observed conditions", () => {
    const info = describeJobWait({
        waitId: "wait-2",
        kind: "observed_condition",
        status: "pending",
        detectionMode: "poll",
        provider: "azure_devops",
        predicate: { kind: "required_reviewers" },
    });
    assert.equal(info.kind, "observed_condition");
    assert.equal(info.isResponseWait, false);
    assert.equal(info.answerable, false);
    assert.equal(info.retainsWorker, false);
    assert.equal(info.providerLabel, "azure devops");
    assert.equal(info.predicateLabel, "human code review");
    assert.equal(info.reason, "Awaiting human code review");
    assert.equal(info.timelineLabel, "Observed-condition wait parked");
    assert.match(info.timelineDetail, /azure devops state is authoritative/);
    assert.match(info.timelineDetail, /no worker is retained/);
    assert.equal(info.glossary.kind, "observed_condition");
});

test("describeJobWait describes a timer wait as scheduled and unattended", () => {
    const info = describeJobWait({
        waitId: "wait-3",
        kind: "timer",
        status: "pending",
        detectionMode: "timer",
    });
    assert.equal(info.kind, "timer");
    assert.equal(info.answerable, false);
    assert.equal(info.reason, "Awaiting scheduled time");
    assert.equal(info.timelineLabel, "Scheduled wait pending");
    assert.equal(info.glossary.kind, "timer");
});

test("describeJobWait falls back to the state-run status when the wait row is unavailable", () => {
    const responseFallback = describeJobWait(null, "input_required");
    assert.equal(responseFallback.kind, "response");
    assert.equal(responseFallback.isResponseWait, true);
    assert.equal(responseFallback.answerable, true);
    assert.equal(responseFallback.timelineLabel, "Response wait parked");

    const observedFallback = describeJobWait(null, "waiting");
    assert.equal(observedFallback.kind, "observed_condition");
    assert.equal(observedFallback.isResponseWait, false);
    assert.equal(observedFallback.answerable, false);
    assert.equal(observedFallback.timelineLabel, "Observed-condition wait parked");
});

test("describeObservedConditionPredicate falls back to a readable predicate label", () => {
    assert.deepEqual(
        describeObservedConditionPredicate({ predicate: { kind: "pipeline_success" } }),
        { reason: "Awaiting external condition", predicateLabel: "pipeline success" },
    );
});

test("describeObservedConditionChecks returns nothing without an observed-condition observation", () => {
    assert.deepEqual(describeObservedConditionChecks(null), []);
    assert.deepEqual(describeObservedConditionChecks({ kind: "response", status: "pending" }), []);
    assert.deepEqual(
        describeObservedConditionChecks({ kind: "observed_condition", latestObservation: null }),
        [],
    );
});

test("describeObservedConditionChecks derives conditions from blocking policies and required reviewers", () => {
    const checks = describeObservedConditionChecks({
        kind: "observed_condition",
        latestObservation: {
            requiredReviewers: [
                { id: "r1", displayName: "Alice", vote: 10, approved: true },
                { id: "r2", displayName: "Bob", vote: 0, approved: false },
            ],
            policies: [
                { evaluationId: "p1", typeName: "Build", status: "approved", isEnabled: true, isBlocking: true },
                { evaluationId: "p2", typeName: "Build", status: "queued", isEnabled: true, isBlocking: true },
                { evaluationId: "p3", typeName: "Build", status: "rejected", isEnabled: true, isBlocking: true },
                { evaluationId: "p4", typeName: "Build", status: "queued", isEnabled: true, isBlocking: false },
                { evaluationId: "p5", typeName: "Build", status: "queued", isEnabled: false, isBlocking: true },
            ],
        },
    });
    assert.deepEqual(checks.map((check) => [check.label, check.state]), [
        ["Review · Alice", "satisfied"],
        ["Review · Bob", "pending"],
        ["Policy · Build", "satisfied"],
        ["Policy · Build", "pending"],
        ["Policy · Build", "failed"],
    ]);
});

test("describeObservedConditionChecks prefers an explicit conditions list from the observer", () => {
    const checks = describeObservedConditionChecks({
        kind: "observed_condition",
        latestObservation: {
            conditions: [
                { key: "review-agent", label: "Code Review Agent recommendation", satisfied: true },
                { key: "build-gate", label: "Required validation build", satisfied: false },
                { key: "broken", label: "Custom gate", state: "failed" },
            ],
        },
    });
    assert.deepEqual(checks.map((check) => [check.label, check.state]), [
        ["Code Review Agent recommendation", "satisfied"],
        ["Required validation build", "pending"],
        ["Custom gate", "failed"],
    ]);
});

test("describeObservedConditionChecks keys policies by configurationId for override stability", () => {
    const checks = describeObservedConditionChecks({
        kind: "observed_condition",
        latestObservation: {
            requiredReviewers: [{ id: "r2", displayName: "Bob", vote: 0, approved: false }],
            policies: [
                { configurationId: 4001, evaluationId: "eval-changes", displayName: "Required validation build", status: "queued", isEnabled: true, isBlocking: true },
            ],
        },
    });
    assert.deepEqual(checks.map((check) => check.key), [
        "reviewer:r2",
        "policy:4001",
    ]);
    assert.equal(checks.every((check) => check.overridden === false), true);
});

test("describeObservedConditionChecks reports and forces overridden conditions to satisfied", () => {
    const checks = describeObservedConditionChecks({
        kind: "observed_condition",
        conditionOverrides: ["policy:4001", "reviewer:r2"],
        latestObservation: {
            requiredReviewers: [{ id: "r2", displayName: "Bob", vote: 0, approved: false }],
            policies: [
                { configurationId: 4001, displayName: "Required validation build", status: "queued", isEnabled: true, isBlocking: true },
                { configurationId: 4002, displayName: "Secondary validation build", status: "queued", isEnabled: true, isBlocking: true },
            ],
        },
    });
    const byKey = Object.fromEntries(checks.map((check) => [check.key, check]));
    assert.equal(byKey["reviewer:r2"].overridden, true);
    assert.equal(byKey["reviewer:r2"].state, "satisfied");
    assert.equal(byKey["policy:4001"].overridden, true);
    assert.equal(byKey["policy:4001"].state, "satisfied");
    assert.equal(byKey["policy:4002"].overridden, false);
    assert.equal(byKey["policy:4002"].state, "pending");
});

test("the wait glossary covers every durable wait kind with a resume rationale", () => {
    assert.deepEqual(
        JOB_WAIT_GLOSSARY.map((entry) => entry.kind),
        ["response", "observed_condition", "timer"],
    );
    for (const entry of JOB_WAIT_GLOSSARY) {
        assert.equal(jobWaitGlossaryEntry(entry.kind), entry);
        assert.ok(entry.rationale.length > 0, `${entry.kind} has a rationale`);
    }
    assert.equal(jobWaitGlossaryEntry("unknown"), null);
});
