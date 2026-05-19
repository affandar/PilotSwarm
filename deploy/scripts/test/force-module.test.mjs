// Tests for the `--force-module <name>` CLI flag on deploy.mjs.
//
// Two layers of coverage:
//   1. --help smoke: the flag stays documented in printHelp().
//   2. Behavior: `deployBicep({ forceModules: [m] })` causes `shouldSkipDeploy`
//      to receive `force=true` ONLY for module `m`, leaving every other
//      module's marker logic alone. This is SC-010's "advances only the named
//      module's deploy marker" check, exercised at the unit boundary where the
//      decision is actually made.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const DEPLOY_MJS = resolve(here, "..", "deploy.mjs");

test("deploy.mjs --help advertises --force-module", () => {
  const r = spawnSync(process.execPath, [DEPLOY_MJS, "--help"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `--help should exit 0, got ${r.status}: ${r.stderr}`);
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(
    out,
    /--force-module/,
    `expected --force-module in help output:\n${out}`,
  );
  assert.match(
    out,
    /Repeatable/i,
    `help output should note --force-module is repeatable:\n${out}`,
  );
});

test("deploy.mjs rejects --force-module with no value", () => {
  const r = spawnSync(process.execPath, [DEPLOY_MJS, "all", "dev", "--force-module"], {
    encoding: "utf8",
  });
  assert.notEqual(r.status, 0, "should exit non-zero when --force-module has no value");
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(
    out,
    /--force-module/,
    `error should reference the offending flag:\n${out}`,
  );
});

// Install lib mocks ONCE at module scope. node:test's per-test
// `t.mock.module` re-mocks affect only FRESH imports — deploy-bicep is
// cached after the first dynamic import, so its bindings stick. We instead
// expose a mutable `skipCalls` array that each test resets.
import { mock } from "node:test";

const skipCalls = [];

mock.module("../lib/common.mjs", {
  namedExports: {
    log: () => {},
    run: () => ({ stdout: "", stderr: "", status: 0 }),
    runJson: () => ({}),
    REPO_ROOT: process.cwd(),
  },
});
mock.module("../lib/render-params.mjs", {
  namedExports: {
    renderParams: ({ module }) => ({
      renderedPath: `/tmp/${module}.params.json`,
      substituted: [],
    }),
  },
});
mock.module("../lib/deploy-marker.mjs", {
  namedExports: {
    computeTemplateHash: () => "tmpl-hash",
    computeParamsHash: () => "params-hash",
    shouldSkipDeploy: ({ moduleName, force }) => {
      skipCalls.push({ moduleName, force: force === true });
      return { skip: true, reason: "test-stub" };
    },
    saveMarker: () => {},
  },
});
mock.module("../lib/bicep-outputs-cache.mjs", {
  namedExports: { saveCache: () => {} },
});
mock.module("../lib/validate-foundry-deployments.mjs", {
  namedExports: { assertFoundryDeploymentsValid: () => {} },
});

function resetCalls() {
  skipCalls.length = 0;
}

test("deployBicep: --force-module targets ONLY the named module", async () => {
  resetCalls();
  const { deployBicep } = await import("../lib/deploy-bicep.mjs");

  // `worker` service expands to ['base-infra', 'worker']; force only 'worker'.
  await deployBicep({
    service: "worker",
    envName: "dev",
    env: {},
    region: "westus2",
    stagingDir: "/tmp/force-module-test",
    moduleListOverride: ["base-infra", "worker"],
    force: false,
    forceModules: ["worker"],
  });

  const byModule = Object.fromEntries(skipCalls.map((c) => [c.moduleName, c.force]));
  assert.equal(
    byModule["worker"],
    true,
    `worker should be forced, got force=${byModule["worker"]}; calls=${JSON.stringify(skipCalls)}`,
  );
  assert.equal(
    byModule["base-infra"],
    false,
    `base-infra should NOT be forced, got force=${byModule["base-infra"]}; calls=${JSON.stringify(skipCalls)}`,
  );
});

test("deployBicep: no --force-module leaves every module unforced", async () => {
  resetCalls();
  const { deployBicep } = await import("../lib/deploy-bicep.mjs");

  await deployBicep({
    service: "worker",
    envName: "dev",
    env: {},
    region: "westus2",
    stagingDir: "/tmp/force-module-test",
    moduleListOverride: ["base-infra", "worker"],
    force: false,
    forceModules: [],
  });

  for (const c of skipCalls) {
    assert.equal(
      c.force,
      false,
      `module ${c.moduleName} should not be forced by default; calls=${JSON.stringify(skipCalls)}`,
    );
  }
});

test("deployBicep: --force-module accepts repeated names", async () => {
  resetCalls();
  const { deployBicep } = await import("../lib/deploy-bicep.mjs");

  await deployBicep({
    service: "worker",
    envName: "dev",
    env: {},
    region: "westus2",
    stagingDir: "/tmp/force-module-test",
    moduleListOverride: ["base-infra", "worker"],
    force: false,
    forceModules: ["base-infra", "worker"],
  });

  const byModule = Object.fromEntries(skipCalls.map((c) => [c.moduleName, c.force]));
  assert.equal(byModule["base-infra"], true, "base-infra should be forced");
  assert.equal(byModule["worker"], true, "worker should be forced");
});
