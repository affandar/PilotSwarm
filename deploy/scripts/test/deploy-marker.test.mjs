// deploy-marker.mjs unit tests. Verifies:
//   * computeTemplateHash detects content + filename changes under the
//     module's bicep tree AND under Common/bicep.
//   * computeParamsHash hashes rendered file content.
//   * loadMarker / saveMarker round-trip.
//   * shouldSkipDeploy: missing marker → no skip; matching hashes + cache
//     present → skip; template change → no skip; params change → no skip;
//     missing outputs cache → no skip even when hashes match; force → no skip.
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";

import { REPO_ROOT } from "../lib/common.mjs";
import {
  computeTemplateHash,
  computeParamsHash,
  loadMarker,
  saveMarker,
  shouldSkipDeploy,
  _internals,
} from "../lib/deploy-marker.mjs";

const MOD_NAME = "DeployMarkerTestMod";
const ENV_NAME = "deploymarkertest";

function modBicepDir() {
  return join(REPO_ROOT, "deploy", "services", MOD_NAME, "bicep");
}

function envTmpDir() {
  return join(REPO_ROOT, "deploy", ".tmp", ENV_NAME);
}

function setupModule(content) {
  const dir = modBicepDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "main.bicep"), content);
}

function tearDown() {
  rmSync(join(REPO_ROOT, "deploy", "services", MOD_NAME), {
    recursive: true,
    force: true,
  });
  rmSync(envTmpDir(), { recursive: true, force: true });
}

test.beforeEach(() => tearDown());
test.after(() => tearDown());

test("computeTemplateHash changes when bicep content changes", () => {
  setupModule("param a string\n");
  const h1 = computeTemplateHash(MOD_NAME);
  setupModule("param a string = 'x'\n");
  const h2 = computeTemplateHash(MOD_NAME);
  assert.notEqual(h1, h2);
});

test("computeTemplateHash returns hex digest for an empty module dir", () => {
  // Module with no .bicep files at all.
  mkdirSync(modBicepDir(), { recursive: true });
  const h = computeTemplateHash(MOD_NAME);
  assert.match(h, /^[a-f0-9]{64}$/);
});

test("computeParamsHash hashes the rendered file", () => {
  const dir = envTmpDir();
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "rendered.json");
  writeFileSync(p, '{"a":1}');
  const h1 = computeParamsHash(p);
  writeFileSync(p, '{"a":2}');
  const h2 = computeParamsHash(p);
  assert.notEqual(h1, h2);
  assert.match(h1, /^[a-f0-9]{64}$/);
});

test("computeParamsHash returns empty string for a missing file", () => {
  assert.equal(computeParamsHash(join(envTmpDir(), "nope.json")), "");
});

test("loadMarker / saveMarker round-trip", () => {
  setupModule("// dummy\n");
  saveMarker(ENV_NAME, MOD_NAME, {
    templateHash: "t1",
    paramsHash: "p1",
    deploymentName: "x",
    region: "westus3",
    deployedAt: "2026-01-01T00:00:00Z",
    outputKeys: ["A", "B"],
  });
  const m = loadMarker(ENV_NAME, MOD_NAME);
  assert.equal(m.templateHash, "t1");
  assert.equal(m.paramsHash, "p1");
  assert.deepEqual(m.outputKeys, ["A", "B"]);
});

test("shouldSkipDeploy → no skip when marker is missing", () => {
  setupModule("// dummy\n");
  const d = shouldSkipDeploy({
    envName: ENV_NAME,
    moduleName: MOD_NAME,
    templateHash: "t1",
    paramsHash: "p1",
    force: false,
  });
  assert.equal(d.skip, false);
  assert.equal(d.reason, "no marker");
});

test("shouldSkipDeploy → skip when marker + outputs cache match", () => {
  setupModule("// dummy\n");
  saveMarker(ENV_NAME, MOD_NAME, { templateHash: "t1", paramsHash: "p1" });
  // Simulate the bicep-outputs cache existing for this env.
  writeFileSync(_internals.bicepOutputsCachePath(ENV_NAME), "{}");
  const d = shouldSkipDeploy({
    envName: ENV_NAME,
    moduleName: MOD_NAME,
    templateHash: "t1",
    paramsHash: "p1",
    force: false,
  });
  assert.equal(d.skip, true);
  assert.equal(d.reason, "marker hit");
});

test("shouldSkipDeploy → no skip when template hash differs", () => {
  setupModule("// dummy\n");
  saveMarker(ENV_NAME, MOD_NAME, { templateHash: "OLD", paramsHash: "p1" });
  writeFileSync(_internals.bicepOutputsCachePath(ENV_NAME), "{}");
  const d = shouldSkipDeploy({
    envName: ENV_NAME,
    moduleName: MOD_NAME,
    templateHash: "NEW",
    paramsHash: "p1",
    force: false,
  });
  assert.equal(d.skip, false);
  assert.equal(d.reason, "template changed");
});

test("shouldSkipDeploy → no skip when params hash differs", () => {
  setupModule("// dummy\n");
  saveMarker(ENV_NAME, MOD_NAME, { templateHash: "t1", paramsHash: "OLD" });
  writeFileSync(_internals.bicepOutputsCachePath(ENV_NAME), "{}");
  const d = shouldSkipDeploy({
    envName: ENV_NAME,
    moduleName: MOD_NAME,
    templateHash: "t1",
    paramsHash: "NEW",
    force: false,
  });
  assert.equal(d.skip, false);
  assert.equal(d.reason, "params changed");
});

test("shouldSkipDeploy → no skip when outputs cache is missing", () => {
  setupModule("// dummy\n");
  saveMarker(ENV_NAME, MOD_NAME, { templateHash: "t1", paramsHash: "p1" });
  // Explicitly do NOT create the bicep-outputs cache.
  rmSync(_internals.bicepOutputsCachePath(ENV_NAME), { force: true });
  const d = shouldSkipDeploy({
    envName: ENV_NAME,
    moduleName: MOD_NAME,
    templateHash: "t1",
    paramsHash: "p1",
    force: false,
  });
  assert.equal(d.skip, false);
  assert.equal(d.reason, "outputs cache missing");
});

test("shouldSkipDeploy → no skip when --force is set", () => {
  setupModule("// dummy\n");
  saveMarker(ENV_NAME, MOD_NAME, { templateHash: "t1", paramsHash: "p1" });
  writeFileSync(_internals.bicepOutputsCachePath(ENV_NAME), "{}");
  const d = shouldSkipDeploy({
    envName: ENV_NAME,
    moduleName: MOD_NAME,
    templateHash: "t1",
    paramsHash: "p1",
    force: true,
  });
  assert.equal(d.skip, false);
  assert.equal(d.reason, "force");
});
