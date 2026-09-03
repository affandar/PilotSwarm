import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
    isProviderStatePoll,
    PROVIDER_STATE_POLL_PATTERNS,
    PROVIDER_STATE_POLL_REDIRECT,
} from "../../dist/managed-session.js";

const managedSessionSource = readFileSync(
    fileURLToPath(new URL("../../src/managed-session.ts", import.meta.url)),
    "utf8",
);

// Reasons that describe polling external, provider-owned async state. A durable
// `wait` timer must never be used for these — they belong on the
// start_external_operation + system_wait observed-condition path.
const PROVIDER_STATE_REASONS = [
    "Waiting for the pull-request validation build policy to pass",
    "Poll until the code coverage policy completes",
    "Wait for the release pipeline to finish",
    "Waiting for the required build to complete",
    "Awaiting the gated build to pass",
    "Wait for pull request policy evaluation to finish",
    "wait until the validation build is complete",
    "Waiting for code coverage results before advancing",
    "poll the PR until required policies are approved",
    "waiting for the build to finish running",
];

// Reasons that are legitimate durable waits unrelated to provider-owned CI/policy
// state. These must pass through untouched.
const LEGITIMATE_REASONS = [
    "Waiting for the user to reply to a clarifying question",
    "Give the local dev server a moment to boot before probing it",
    "Sleep 30 seconds before retrying the transient file read",
    "Pause before sending the next chat message to the sub-agent",
    "Hold until tomorrow's scheduled digest run",
    "",
];

test("provider-owned state polls are detected", () => {
    for (const reason of PROVIDER_STATE_REASONS) {
        assert.equal(
            isProviderStatePoll(reason),
            true,
            `expected provider-state poll to be detected: ${reason}`,
        );
    }
});

test("legitimate durable waits are not misclassified as provider-state polls", () => {
    for (const reason of LEGITIMATE_REASONS) {
        assert.equal(
            isProviderStatePoll(reason),
            false,
            `expected reason to pass through untouched: ${reason || "(empty)"}`,
        );
    }
});

test("an empty or missing reason never trips the guardrail", () => {
    assert.equal(isProviderStatePoll(""), false);
    assert.equal(isProviderStatePoll(undefined), false);
    assert.equal(isProviderStatePoll(null), false);
});

test("detection is case-insensitive", () => {
    assert.equal(isProviderStatePoll("WAIT FOR THE BUILD POLICY"), true);
    assert.equal(isProviderStatePoll("wait for the build policy"), true);
});

test("the pattern set is non-empty and every entry is a global-safe regex", () => {
    assert.ok(PROVIDER_STATE_POLL_PATTERNS.length > 0);
    for (const pattern of PROVIDER_STATE_POLL_PATTERNS) {
        assert.ok(pattern instanceof RegExp);
        // Guardrail patterns must be stateless (no /g) so repeated .test() calls
        // over the pattern array do not depend on lastIndex.
        assert.equal(pattern.global, false, `pattern must not be global: ${pattern}`);
    }
});

test("the redirect message names the durable observed-condition path", () => {
    assert.match(PROVIDER_STATE_POLL_REDIRECT, /^BLOCKED:/);
    assert.match(PROVIDER_STATE_POLL_REDIRECT, /start_external_operation/);
    assert.match(PROVIDER_STATE_POLL_REDIRECT, /system_wait/);
    assert.match(PROVIDER_STATE_POLL_REDIRECT, /requiredPolicyDisplayNames/);
    assert.match(PROVIDER_STATE_POLL_REDIRECT, /requireAllBlockingPolicies/);
});

test("the wait tool description steers away from provider-state polling", () => {
    // The added guidance lives in DEFAULT_WAIT_TOOL_DESCRIPTION; assert the
    // distinctive phrases appear so the model is told, up front, to route
    // provider-owned async state through the observed-condition path.
    assert.match(
        managedSessionSource,
        /Do NOT use this tool to poll external provider-owned async state/,
    );
    assert.match(
        managedSessionSource,
        /call start_external_operation to register the gate, then system_wait/,
    );
    assert.match(managedSessionSource, /build policies/);
});

test("the wait handler blocks provider-state polls unless worker affinity is preserved", () => {
    // The guard runs before any timer is scheduled and honors the
    // preserveWorkerAffinity escape hatch for legitimate node-local waits.
    assert.match(
        managedSessionSource,
        /if\s*\(!args\.preserveWorkerAffinity && isProviderStatePoll\(reason\)\)\s*\{\s*return PROVIDER_STATE_POLL_REDIRECT;/,
    );
});
