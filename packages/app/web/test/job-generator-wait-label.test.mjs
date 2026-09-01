import assert from "node:assert/strict";
import test from "node:test";
import {
    JOB_WAIT_GLOSSARY,
    describeJobWait,
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
