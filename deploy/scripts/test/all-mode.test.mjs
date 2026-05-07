// Unit tests for the `all` aggregate mode wiring.
//
// `all` is a virtual service in deploy.mjs that iterates ALL_SEQUENCE,
// applying user-requested --steps to each item, scoping each service's
// Bicep deploy to its own module (ALL_MODE_MODULES) so we don't redundantly
// re-deploy BaseInfra when worker/portal run.
//
// These tests cover the pure helpers; they do NOT spawn `az` or `node`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { ALL_SEQUENCE, ALL_MODE_MODULES, SERVICE_TO_MODULES } from "../lib/service-info.mjs";
import { defaultPipelineFor, resolveSteps } from "../lib/stages.mjs";
import { validateService, ALL_SERVICE, SERVICES } from "../lib/common.mjs";

test("ALL_SEQUENCE matches the enterprise services.json infraOrder + service order", () => {
  // The enterprise path deploy/services/services.json: infraOrder = ["GlobalInfra","BaseInfra"], then
  // services Worker, Portal. The OSS aggregate mirrors that ordering and
  // appends cert-manager + cert-manager-issuers (OSS-only Let's Encrypt
  // path; the enterprise path stays on the akv path and skips them via deploy.mjs).
  assert.deepEqual(ALL_SEQUENCE, [
    "global-infra",
    "base-infra",
    "cert-manager",
    "cert-manager-issuers",
    "worker",
    "portal",
  ]);
});

test("ALL_MODE_MODULES has exactly one module per service (no redundant redeploys)", () => {
  for (const svc of ALL_SEQUENCE) {
    const mods = ALL_MODE_MODULES[svc];
    assert.ok(Array.isArray(mods) && mods.length === 1, `${svc} should have 1 module in all-mode`);
  }
  // The single module per service should equal the LAST module of its
  // single-service module list — i.e. all-mode strips the leading dependencies
  // (base-infra) that single-service mode redeploys for safety.
  assert.equal(ALL_MODE_MODULES.worker[0], SERVICE_TO_MODULES.worker.at(-1));
  assert.equal(ALL_MODE_MODULES.portal[0], SERVICE_TO_MODULES.portal.at(-1));
  assert.equal(ALL_MODE_MODULES["base-infra"][0], "base-infra");
  assert.equal(ALL_MODE_MODULES["global-infra"][0], "global-infra");
  assert.equal(ALL_MODE_MODULES["cert-manager"][0], "cert-manager");
  assert.equal(ALL_MODE_MODULES["cert-manager-issuers"][0], "cert-manager-issuers");
});

test("validateService accepts 'all' as a virtual aggregate", () => {
  assert.doesNotThrow(() => validateService(ALL_SERVICE));
  assert.equal(ALL_SERVICE, "all");
  // and rejects unknown services with a message that mentions 'all'
  try {
    validateService("nope");
    assert.fail("expected throw");
  } catch (e) {
    assert.match(e.message, /'all'/);
  }
  // Concrete services list is derived from the deploy manifest, so adding a
  // service folder + manifest entry automatically extends it. Snapshot the
  // current set so accidental removals are caught.
  assert.deepEqual(
    [...SERVICES].sort(),
    ["base-infra", "cert-manager", "cert-manager-issuers", "global-infra", "portal", "worker"],
  );
});

test("step intersection: --steps bicep applies to every service in ALL_SEQUENCE", () => {
  for (const svc of ALL_SEQUENCE) {
    const resolved = resolveSteps("bicep", svc);
    const effective = resolved.filter((s) => defaultPipelineFor(svc).includes(s));
    assert.deepEqual(effective, ["bicep"], `${svc} should run bicep`);
  }
});

test("step intersection: --steps manifests,rollout skips infra-only services", () => {
  // Pure infra services (global-infra, base-infra) have default pipeline = [bicep]
  // / [bicep, seed-secrets], so their effective intersection with
  // [manifests,rollout] is empty.
  for (const svc of ["global-infra", "base-infra"]) {
    const resolved = resolveSteps("manifests,rollout", svc);
    const effective = resolved.filter((s) => defaultPipelineFor(svc).includes(s));
    assert.deepEqual(effective, [], `${svc} should be skipped for app-only steps`);
  }
  // cert-manager / cert-manager-issuers are infra-kind but DO publish manifests
  // (their pipeline override is [bicep, manifests]) — manifests survives the
  // intersection, rollout does not.
  for (const svc of ["cert-manager", "cert-manager-issuers"]) {
    const resolved = resolveSteps("manifests,rollout", svc);
    const effective = resolved.filter((s) => defaultPipelineFor(svc).includes(s));
    assert.deepEqual(effective, ["manifests"], `${svc} should publish manifests but not rollout`);
  }
  // Worker and portal (default pipeline = full chain) keep both.
  for (const svc of ["worker", "portal"]) {
    const resolved = resolveSteps("manifests,rollout", svc);
    const effective = resolved.filter((s) => defaultPipelineFor(svc).includes(s));
    assert.deepEqual(effective, ["manifests", "rollout"], `${svc} should run app-only steps`);
  }
});

test("default (no --steps) full all-mode runs full pipeline for app services, bicep for infra", () => {
  const expected = {
    "global-infra": ["bicep"],
    "base-infra": ["bicep", "seed-secrets"],
    "cert-manager": ["bicep", "manifests"],
    "cert-manager-issuers": ["bicep", "manifests"],
    worker: ["build", "bicep", "push", "manifests", "rollout"],
    portal: ["build", "bicep", "push", "manifests", "rollout"],
  };
  for (const svc of ALL_SEQUENCE) {
    const resolved = resolveSteps(null, svc); // no --steps → defaultPipelineFor(svc)
    const effective = resolved.filter((s) => defaultPipelineFor(svc).includes(s));
    assert.deepEqual(effective, expected[svc], `${svc} default pipeline mismatch`);
  }
});
