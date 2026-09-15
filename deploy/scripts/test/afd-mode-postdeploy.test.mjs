// Tests for deploy/scripts/lib/afd-mode-postdeploy.mjs.
//
// The module recovers from the AGIC first-boot RBAC race (empty AppGw backend
// pool → public AFD endpoint 504). Its az/kubectl calls are side-effectful, so
// we unit-test the pure health-counting logic directly and use structural
// source assertions for the orchestration + wiring (same approach as
// approve-pe.test.mjs / appgw-waf-rules.test.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { countHealthyServers } from "../lib/afd-mode-postdeploy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "..", "lib");
const moduleSrc = readFileSync(join(LIB, "afd-mode-postdeploy.mjs"), "utf8");
const waitRolloutSrc = readFileSync(join(LIB, "wait-rollout.mjs"), "utf8");

test("countHealthyServers: counts only servers reporting Healthy", () => {
  const servers = [
    { address: "10.0.0.1", health: "Healthy" },
    { address: "10.0.0.2", health: "Unhealthy" },
    { address: "10.0.0.3", health: "Healthy" },
    { address: "10.0.0.4", health: "Unknown" },
  ];
  assert.equal(countHealthyServers(servers), 2);
});

test("countHealthyServers: empty / non-array inputs return 0 (empty backend pool)", () => {
  assert.equal(countHealthyServers([]), 0);
  assert.equal(countHealthyServers(null), 0);
  assert.equal(countHealthyServers(undefined), 0);
  assert.equal(countHealthyServers("Healthy"), 0);
  assert.equal(countHealthyServers([null, undefined, {}]), 0);
});

test("module guards: no-ops unless EDGE_MODE is afd", () => {
  assert.match(
    moduleSrc,
    /if\s*\(\s*env\.EDGE_MODE\s*!==\s*["']afd["']\s*\)\s*return/,
    "applyAfdModePostDeploy must early-return when EDGE_MODE !== 'afd'",
  );
});

test("module skips (does not throw) when the AppGw handle is absent", () => {
  // Off-path partial runs (--steps skipped bicep) won't have
  // APPLICATION_GATEWAY_NAME in the env map; that must be a skip, not a hard
  // failure, so a worker-only redeploy doesn't error on a healthy edge.
  assert.match(moduleSrc, /APPLICATION_GATEWAY_NAME/);
  assert.match(moduleSrc, /skipping AGIC backend verification/i);
});

test("module remediates via a rollout restart of the AGIC deployment", () => {
  assert.match(moduleSrc, /"ingress-appgw-deployment"/);
  assert.match(moduleSrc, /"kube-system"/);
  assert.match(moduleSrc, /"rollout",\s*"restart"/);
});

test("module remediation is verified: restart is followed by a Healthy re-check that can fail loudly", () => {
  // The restart branch must re-poll for a Healthy backend and throw if it
  // never recovers, so a broken edge surfaces as a deploy failure.
  assert.match(moduleSrc, /waitForHealthyBackend/);
  assert.match(moduleSrc, /throw new Error/);
  assert.match(moduleSrc, /ErrorApplicationGatewayForbidden/);
});

test("wait-rollout.mjs wires the afd hook for the portal rollout", () => {
  assert.match(
    waitRolloutSrc,
    /import\s*\{\s*applyAfdModePostDeploy\s*\}\s*from\s*["']\.\/afd-mode-postdeploy\.mjs["']/,
    "wait-rollout.mjs must import applyAfdModePostDeploy",
  );
  assert.match(
    waitRolloutSrc,
    /service\s*===\s*["']portal["']\s*&&\s*env\.EDGE_MODE\s*===\s*["']afd["']/,
    "wait-rollout.mjs must call the hook only for the portal service in afd mode",
  );
  assert.match(waitRolloutSrc, /await\s+applyAfdModePostDeploy\(\s*\{\s*env,\s*kubeEnv\s*\}\s*\)/);
});
