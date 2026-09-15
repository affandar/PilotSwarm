// Tests for the base-infra agent-pool preflight (reconcileAgentPools) helpers
// in deploy-bicep.mjs, plus the --replace-pools CLI flag on deploy.mjs.
//
// Why this exists: a managedCluster PUT cannot ADD a pool to an existing
// cluster, nor change a pool's IMMUTABLE fields (vmSize, osType/osSKU,
// osDisk*) in place. reconcileAgentPools() converges the live pools to the
// desired AGENT_POOLS_FILE via the per-pool API before the PUT. These unit
// tests pin the two pure helpers that decide WHAT the reconcile does:
//   * immutablePoolDiffs() — which fields force a destructive replacement.
//   * poolAddArgs()        — the `az aks nodepool add` argv for a desired pool.
// A --help smoke test keeps the destructive flag documented.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { immutablePoolDiffs, poolAddArgs } from "../lib/deploy-bicep.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DEPLOY_MJS = resolve(here, "..", "deploy.mjs");

// A desired pool as Generate-AgentPools.ps1 emits it.
const desired = {
  name: "dsmain",
  mode: "User",
  count: 10,
  vmSize: "Standard_D16ds_v5",
  osType: "Windows",
  osSKU: "Windows2022",
  osDiskSizeGB: 512,
  osDiskType: "Ephemeral",
  enableAutoScaling: false,
  scaleDownMode: "Delete",
  nodeLabels: { "pilotswarm.io/git-cache-repo": "dsmaindev" },
  nodeTaints: ["pilotswarm.io/cache-not-ready=true:NoSchedule", "os=windows:NoSchedule"],
};

// The live shape `az aks nodepool show` returns (note osSku / osDiskSizeGb casing).
function liveFrom(overrides = {}) {
  return {
    name: "dsmain",
    mode: "User",
    count: 10,
    vmSize: "Standard_D16ds_v5",
    osType: "Windows",
    osSku: "Windows2022",
    osDiskSizeGb: 512,
    osDiskType: "Ephemeral",
    vnetSubnetId: "/subscriptions/x/subnets/aks-subnet",
    ...overrides,
  };
}

test("immutablePoolDiffs: identical pool → no diffs", () => {
  assert.deepEqual(immutablePoolDiffs(desired, liveFrom()), []);
});

test("immutablePoolDiffs: vmSize change is a replacement trigger", () => {
  const diffs = immutablePoolDiffs(desired, liveFrom({ vmSize: "Standard_D32ds_v5" }));
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].field, "vmSize");
  assert.equal(diffs[0].live, "Standard_D32ds_v5");
  assert.equal(diffs[0].desired, "Standard_D16ds_v5");
});

test("immutablePoolDiffs: osDiskType + osDiskSizeGB changes both trigger", () => {
  const diffs = immutablePoolDiffs(
    desired,
    liveFrom({ osDiskType: "Managed", osDiskSizeGb: 1200 }),
  );
  const fields = diffs.map((d) => d.field).sort();
  assert.deepEqual(fields, ["osDiskSizeGB", "osDiskType"]);
});

test("immutablePoolDiffs: MUTABLE drift (count/labels/taints) is NOT a diff", () => {
  const live = liveFrom({
    count: 3,
    nodeLabels: { "pilotswarm.io/git-cache-repo": "other" },
  });
  assert.deepEqual(immutablePoolDiffs(desired, live), []);
});

test("immutablePoolDiffs: osDiskSizeGB compares numerically (string vs number)", () => {
  // Live returns a number; a string in the desired file must still match.
  const diffs = immutablePoolDiffs({ ...desired, osDiskSizeGB: "512" }, liveFrom());
  assert.deepEqual(diffs, []);
});

test("immutablePoolDiffs: undeclared desired field is not forced", () => {
  const partial = { name: "dsmain", vmSize: "Standard_D16ds_v5" };
  // osDiskType absent from desired → live's value is left alone.
  assert.deepEqual(immutablePoolDiffs(partial, liveFrom({ osDiskType: "Managed" })), []);
});

test("poolAddArgs: maps the desired pool to a faithful `az aks nodepool add` argv", () => {
  const args = poolAddArgs(desired, {
    cluster: "pssqlmortwus2-aks",
    rg: "pssqlmortwus2-wus2-rg",
    subnetId: "/subscriptions/x/subnets/aks-subnet",
  });
  const joined = args.join(" ");
  assert.ok(joined.startsWith("aks nodepool add "), joined);
  assert.ok(joined.includes("--cluster-name pssqlmortwus2-aks"));
  assert.ok(joined.includes("--resource-group pssqlmortwus2-wus2-rg"));
  assert.ok(joined.includes("--name dsmain"));
  assert.ok(joined.includes("--node-vm-size Standard_D16ds_v5"));
  assert.ok(joined.includes("--node-count 10"));
  assert.ok(joined.includes("--os-type Windows"));
  assert.ok(joined.includes("--os-sku Windows2022"));
  assert.ok(joined.includes("--node-osdisk-size 512"));
  assert.ok(joined.includes("--node-osdisk-type Ephemeral"));
  assert.ok(joined.includes("--vnet-subnet-id /subscriptions/x/subnets/aks-subnet"));
});

test("poolAddArgs: labels and taints pass as separate argv tokens after their flag", () => {
  const args = poolAddArgs(desired, { cluster: "c", rg: "r", subnetId: null });
  const li = args.indexOf("--labels");
  assert.notEqual(li, -1, "expected --labels");
  assert.equal(args[li + 1], "pilotswarm.io/git-cache-repo=dsmaindev");
  const ti = args.indexOf("--node-taints");
  assert.notEqual(ti, -1, "expected --node-taints");
  assert.equal(args[ti + 1], "pilotswarm.io/cache-not-ready=true:NoSchedule");
  assert.equal(args[ti + 2], "os=windows:NoSchedule");
  // subnetId null → no --vnet-subnet-id appended.
  assert.ok(!args.includes("--vnet-subnet-id"));
});

test("poolAddArgs: autoscaling pool emits --enable-cluster-autoscaler + bounds", () => {
  const auto = { name: "userpool", vmSize: "Standard_D4ds_v5", enableAutoScaling: true, minCount: 1, maxCount: 10 };
  const args = poolAddArgs(auto, { cluster: "c", rg: "r" }).join(" ");
  assert.ok(args.includes("--enable-cluster-autoscaler"));
  assert.ok(args.includes("--min-count 1"));
  assert.ok(args.includes("--max-count 10"));
});

test("deploy.mjs --help advertises --replace-pools and marks it destructive", () => {
  const r = spawnSync(process.execPath, [DEPLOY_MJS, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0, `--help should exit 0, got ${r.status}: ${r.stderr}`);
  const out = `${r.stdout}\n${r.stderr}`;
  assert.match(out, /--replace-pools/, `expected --replace-pools in help:\n${out}`);
  assert.match(out, /DESTRUCTIVE/i, `help should flag --replace-pools as destructive:\n${out}`);
});

test("deploy.mjs rejects an unknown flag (regression: parser still strict)", () => {
  const r = spawnSync(process.execPath, [DEPLOY_MJS, "all", "dev", "--replace-pool"], {
    encoding: "utf8",
  });
  assert.notEqual(r.status, 0, "a typo'd --replace-pool (singular) must not be silently accepted");
  assert.match(`${r.stdout}\n${r.stderr}`, /Unknown flag: --replace-pool/);
});
