// Phase 7 (SC-019): static validation of the live-smoke workflow YAML.
//
// Asserts the workflow is workflow_dispatch-only (no push/pr/schedule
// triggers), that it requests `id-token: write` permission for OIDC
// federation, and that the env-load → AKS-credentials → smoke
// invocation wiring uses the canonical RESOURCE_GROUP /
// AKS_CLUSTER_NAME key names from deploy/envs/template.env (not
// the rubber-duck-bug `$RG` / `$CLUSTER` shorthand, which would be
// silently empty and produce a confusing failure mode).
//
// Run: node --test deploy/scripts/test/live-smoke-workflow.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const WORKFLOW_PATH = resolve(REPO_ROOT, ".github", "workflows", "live-smoke-obo.yml");

function loadWorkflow() {
    const raw = readFileSync(WORKFLOW_PATH, "utf8");
    return { raw, doc: yaml.parse(raw) };
}

test("live-smoke-obo.yml exists and parses as YAML", () => {
    const { doc } = loadWorkflow();
    assert.ok(doc, "workflow YAML did not parse");
    assert.equal(typeof doc.name, "string");
});

test("FR-028: workflow_dispatch is the only trigger (no push/pr/schedule)", () => {
    const { doc } = loadWorkflow();
    // YAML parses the bare key `on:` as the boolean true. Accept both
    // `doc.on` and `doc[true]` for resilience against the parser's
    // YAML-1.1 boolean coercion.
    const onBlock = doc.on ?? doc[true];
    assert.ok(onBlock, "workflow has no 'on' block");
    assert.ok(onBlock.workflow_dispatch, "workflow_dispatch trigger missing");
    assert.equal(onBlock.push, undefined, "push trigger must not be present");
    assert.equal(onBlock.pull_request, undefined, "pull_request trigger must not be present");
    assert.equal(onBlock.schedule, undefined, "schedule trigger must not be present");
});

test("workflow_dispatch declares 'stamp' (required) and 'profile' inputs", () => {
    const { doc } = loadWorkflow();
    const onBlock = doc.on ?? doc[true];
    const inputs = onBlock.workflow_dispatch?.inputs ?? {};
    assert.ok(inputs.stamp, "stamp input missing");
    assert.equal(inputs.stamp.required, true, "stamp input must be required");
    assert.ok(inputs.profile, "profile input missing");
});

test("job has permissions.id-token: write for Azure OIDC login", () => {
    const { doc } = loadWorkflow();
    const job = Object.values(doc.jobs ?? {})[0];
    assert.ok(job, "no job found");
    assert.equal(job.permissions?.["id-token"], "write", "id-token: write permission required for OIDC");
});

test("job has permissions.contents: read", () => {
    const { doc } = loadWorkflow();
    const job = Object.values(doc.jobs ?? {})[0];
    assert.equal(job.permissions?.contents, "read", "contents: read permission required");
});

test("env-load step exports RESOURCE_GROUP and AKS_CLUSTER_NAME (canonical names from template.env)", () => {
    const { doc } = loadWorkflow();
    const job = Object.values(doc.jobs ?? {})[0];
    const steps = job.steps ?? [];
    const loadStep = steps.find((s) => /load.*stamp.*env/i.test(s.name ?? ""));
    assert.ok(loadStep, "no 'Load stamp env' step found");
    const script = loadStep.run ?? "";
    assert.match(script, /RESOURCE_GROUP/, "load step must reference RESOURCE_GROUP (not $RG)");
    assert.match(script, /AKS_CLUSTER_NAME/, "load step must reference AKS_CLUSTER_NAME (not $CLUSTER)");
    assert.doesNotMatch(script, /\$RG\b/, "load step must NOT use the shorthand $RG");
    assert.doesNotMatch(script, /\$CLUSTER\b/, "load step must NOT use the shorthand $CLUSTER");
});

test("Load-stamp-env step runs BEFORE Acquire-AKS-credentials step", () => {
    const { doc } = loadWorkflow();
    const job = Object.values(doc.jobs ?? {})[0];
    const steps = job.steps ?? [];
    const loadIdx = steps.findIndex((s) => /load.*stamp.*env/i.test(s.name ?? ""));
    const aksIdx = steps.findIndex((s) => /aks.*credentials/i.test(s.name ?? ""));
    assert.ok(loadIdx >= 0, "Load stamp env step missing");
    assert.ok(aksIdx >= 0, "Acquire AKS credentials step missing");
    assert.ok(loadIdx < aksIdx, "Load stamp env must come before Acquire AKS credentials");
});

test("`az aks get-credentials` references $RESOURCE_GROUP and $AKS_CLUSTER_NAME (canonical names)", () => {
    const { doc } = loadWorkflow();
    const job = Object.values(doc.jobs ?? {})[0];
    const steps = job.steps ?? [];
    const aksStep = steps.find((s) => /aks.*credentials/i.test(s.name ?? ""));
    const script = aksStep?.run ?? "";
    assert.match(script, /az aks get-credentials/, "az aks get-credentials missing");
    assert.match(script, /\$RESOURCE_GROUP/, "must reference $RESOURCE_GROUP (not $RG)");
    assert.match(script, /\$AKS_CLUSTER_NAME/, "must reference $AKS_CLUSTER_NAME (not $CLUSTER)");
});

test("smoke run step uses --auth from-env (CI cannot satisfy device-code)", () => {
    const { doc } = loadWorkflow();
    const job = Object.values(doc.jobs ?? {})[0];
    const steps = job.steps ?? [];
    const smokeStep = steps.find((s) => /smoke/i.test(s.name ?? "") && /run/i.test(s.name ?? ""));
    assert.ok(smokeStep, "Run smoke step missing");
    const script = smokeStep.run ?? "";
    assert.match(script, /pilotswarm smoke/, "smoke step must invoke `pilotswarm smoke`");
    assert.match(script, /--auth\s+from-env/, "smoke step must pass --auth from-env (device-code is interactive)");
    assert.match(script, /--skip-kube-bootstrap/, "smoke step must pass --skip-kube-bootstrap because the workflow already runs az aks get-credentials");
});

test("smoke run step injects both OBO_SMOKE_USER_*_TOKEN secrets via env block", () => {
    const { doc } = loadWorkflow();
    const job = Object.values(doc.jobs ?? {})[0];
    const steps = job.steps ?? [];
    const smokeStep = steps.find((s) => /smoke/i.test(s.name ?? "") && /run/i.test(s.name ?? ""));
    const env = smokeStep?.env ?? {};
    assert.ok(env.OBO_SMOKE_USER_ADMISSION_TOKEN, "OBO_SMOKE_USER_ADMISSION_TOKEN must be injected via env");
    assert.ok(env.OBO_SMOKE_USER_DOWNSTREAM_TOKEN, "OBO_SMOKE_USER_DOWNSTREAM_TOKEN must be injected via env");
    assert.match(String(env.OBO_SMOKE_USER_ADMISSION_TOKEN), /secrets\.OBO_SMOKE_USER_ADMISSION_TOKEN/);
    assert.match(String(env.OBO_SMOKE_USER_DOWNSTREAM_TOKEN), /secrets\.OBO_SMOKE_USER_DOWNSTREAM_TOKEN/);
});
