// Unit tests for deploy/scripts/lib/services-manifest.mjs and the manifest-driven
// constants in service-info.mjs. Validates schema, cross-references, and the
// regression contract that derived constants match the previously-hardcoded
// shape (so consumers don't need to change).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadDeployManifest,
  validateRootManifest,
  validateServiceManifest,
  defaultPipelineForKind,
  pipelineForService,
  modulesFor,
} from "../lib/services-manifest.mjs";
import {
  SERVICE_IMAGE_INFO,
  SERVICE_TO_MODULES,
  MODULE_SCOPE,
  ALL_SEQUENCE,
  ALL_MODE_MODULES,
} from "../lib/service-info.mjs";

// ───────────────────────── Real manifest (repo) ─────────────────────────

test("real manifest loads and matches the canonical service shape", () => {
  const m = loadDeployManifest();
  assert.deepEqual(m.allSequence, [
    "global-infra",
    "base-infra",
    "pls-anchor",
    "cert-manager",
    "cert-manager-issuers",
    "worker",
    "portal",
  ]);
  assert.equal(m.services.worker.kind, "app");
  assert.equal(m.services["base-infra"].kind, "infra");
  assert.equal(m.services["pls-anchor"].kind, "infra");
  assert.equal(m.services["cert-manager"].kind, "infra");
  assert.equal(m.services["cert-manager-issuers"].kind, "infra");
  assert.equal(m.regionShort.westus3, "wus3");
});

test("derived constants match prior hardcoded shape (regression contract)", () => {
  // ALL_SEQUENCE contract (was the headline assertion in all-mode.test.mjs).
  assert.deepEqual(ALL_SEQUENCE, [
    "global-infra",
    "base-infra",
    "pls-anchor",
    "cert-manager",
    "cert-manager-issuers",
    "worker",
    "portal",
  ]);

  // SERVICE_IMAGE_INFO: only app services.
  assert.deepEqual(Object.keys(SERVICE_IMAGE_INFO).sort(), ["portal", "worker"]);
  assert.equal(SERVICE_IMAGE_INFO.worker.dockerImageRepo, "pilotswarm-worker");
  assert.equal(SERVICE_IMAGE_INFO.portal.dockerfile, "deploy/Dockerfile.portal");

  // SERVICE_TO_MODULES: dependency-inclusive single-service deploy.
  assert.deepEqual(SERVICE_TO_MODULES.worker, ["base-infra", "worker"]);
  assert.deepEqual(SERVICE_TO_MODULES.portal, ["base-infra", "portal"]);
  assert.deepEqual(SERVICE_TO_MODULES["base-infra"], ["base-infra"]);
  assert.deepEqual(SERVICE_TO_MODULES["global-infra"], ["global-infra"]);
  assert.deepEqual(SERVICE_TO_MODULES["pls-anchor"], ["base-infra", "pls-anchor"]);
  assert.deepEqual(SERVICE_TO_MODULES["cert-manager"], ["base-infra", "cert-manager"]);
  assert.deepEqual(SERVICE_TO_MODULES["cert-manager-issuers"], ["base-infra", "cert-manager-issuers"]);

  // MODULE_SCOPE: covers every named module exactly once.
  assert.equal(MODULE_SCOPE["global-infra"], "sub");
  assert.equal(MODULE_SCOPE["base-infra"], "group");
  assert.equal(MODULE_SCOPE.worker, "group");
  assert.equal(MODULE_SCOPE.portal, "group");
  assert.equal(MODULE_SCOPE["pls-anchor"], "group");
  assert.equal(MODULE_SCOPE["cert-manager"], "group");
  assert.equal(MODULE_SCOPE["cert-manager-issuers"], "group");

  // ALL_MODE_MODULES: exactly one module per service (no redundant redeploys).
  for (const svc of ALL_SEQUENCE) {
    assert.equal(ALL_MODE_MODULES[svc].length, 1, `${svc} all-mode should have 1 module`);
  }
  assert.deepEqual(ALL_MODE_MODULES.worker, ["worker"]);
  assert.deepEqual(ALL_MODE_MODULES.portal, ["portal"]);
});

test("pipelineForService respects defaults by kind", () => {
  const m = loadDeployManifest();
  assert.deepEqual(pipelineForService(m.services.worker, m.root), [
    "build", "bicep", "push", "manifests", "rollout",
  ]);
  assert.deepEqual(pipelineForService(m.services["base-infra"], m.root), ["bicep", "seed-secrets"]);
  assert.deepEqual(defaultPipelineForKind("infra", m.root), ["bicep"]);
});

test("default app pipeline orders push before manifests (FR-014 regression)", () => {
  // FR-014: consumers (Flux) must not see new manifests until the image has been
  // pushed to ACR. The canonical app pipeline must therefore place `push`
  // strictly before `manifests`.
  const m = loadDeployManifest();
  for (const svc of ["worker", "portal"]) {
    const pipeline = pipelineForService(m.services[svc], m.root);
    const pushIdx = pipeline.indexOf("push");
    const manifestsIdx = pipeline.indexOf("manifests");
    assert.ok(pushIdx >= 0, `${svc} pipeline must contain 'push'`);
    assert.ok(manifestsIdx >= 0, `${svc} pipeline must contain 'manifests'`);
    assert.ok(
      pushIdx < manifestsIdx,
      `${svc} pipeline must place 'push' before 'manifests' (got ${pipeline.join(",")})`,
    );
  }
});

test("modulesFor returns single-mode vs all-mode views", () => {
  const m = loadDeployManifest();
  assert.deepEqual(
    modulesFor(m.services.worker, "single").map((x) => x.name),
    ["base-infra", "worker"],
  );
  assert.deepEqual(
    modulesFor(m.services.worker, "all").map((x) => x.name),
    ["worker"],
  );
});

// ───────────────────────── Pure validator ─────────────────────────

test("validateRootManifest rejects malformed shapes", () => {
  assert.equal(validateRootManifest(null).length, 1);
  assert.ok(validateRootManifest({ schemaVersion: 2, infraOrder: [], services: [] }).some((e) => /schemaVersion/.test(e)));
  assert.ok(
    validateRootManifest({ schemaVersion: 1, infraOrder: ["x"], services: ["x"] })
      .some((e) => /both infraOrder and services/.test(e)),
  );
  assert.ok(
    validateRootManifest({ schemaVersion: 1, infraOrder: ["A"], services: [] })
      .some((e) => /invalid name 'A'/.test(e)),
  );
  assert.equal(
    validateRootManifest({ schemaVersion: 1, infraOrder: ["a"], services: ["b"] }).length,
    0,
  );
});

test("validateServiceManifest enforces required fields and cross-rules", () => {
  // missing kind
  assert.ok(
    validateServiceManifest(
      { schemaVersion: 1, name: "x", bicep: { modules: [{ name: "x", scope: "group" }] } },
      "x/deploy.json",
    ).some((e) => /kind/.test(e)),
  );
  // app kind requires image
  assert.ok(
    validateServiceManifest(
      {
        schemaVersion: 1, name: "x", kind: "app",
        bicep: { modules: [{ name: "x", scope: "group" }] },
      },
      "x/deploy.json",
    ).some((e) => /requires 'image'/.test(e)),
  );
  // valid infra
  assert.equal(
    validateServiceManifest(
      {
        schemaVersion: 1, name: "x", kind: "infra",
        bicep: { modules: [{ name: "x", scope: "group" }] },
      },
      "x/deploy.json",
    ).length,
    0,
  );
  // bad scope
  assert.ok(
    validateServiceManifest(
      {
        schemaVersion: 1, name: "x", kind: "infra",
        bicep: { modules: [{ name: "x", scope: "tenant" }] },
      },
      "x/deploy.json",
    ).some((e) => /scope/.test(e)),
  );
});

test("validateServiceManifest rejects rollout missing namespace (FR-012)", () => {
  const errs = validateServiceManifest(
    {
      schemaVersion: 1, name: "x", kind: "app",
      bicep: { modules: [{ name: "x", scope: "group" }] },
      image: { repo: "x", dockerfile: "x" },
      rollout: { deployment: "x-dep" },
    },
    "x/deploy.json",
  );
  assert.ok(
    errs.some((e) => /rollout\.namespace must be a non-empty string/.test(e)),
    `expected namespace error, got: ${errs.join("; ")}`,
  );
});

test("validateServiceManifest rejects rollout with empty-string namespace (FR-012)", () => {
  const errs = validateServiceManifest(
    {
      schemaVersion: 1, name: "x", kind: "app",
      bicep: { modules: [{ name: "x", scope: "group" }] },
      image: { repo: "x", dockerfile: "x" },
      rollout: { deployment: "x-dep", namespace: "" },
    },
    "x/deploy.json",
  );
  assert.ok(
    errs.some((e) => /rollout\.namespace must be a non-empty string/.test(e)),
  );
});

test("validateServiceManifest accepts rollout with deployment + namespace (FR-012)", () => {
  const errs = validateServiceManifest(
    {
      schemaVersion: 1, name: "x", kind: "app",
      bicep: { modules: [{ name: "x", scope: "group" }] },
      image: { repo: "x", dockerfile: "x" },
      rollout: { deployment: "x-dep", namespace: "x-ns" },
    },
    "x/deploy.json",
  );
  assert.equal(errs.length, 0, `expected no errors, got: ${errs.join("; ")}`);
});

test("validateServiceManifest rejects plural rollouts field outright (FR-012)", () => {
  const errs = validateServiceManifest(
    {
      schemaVersion: 1, name: "x", kind: "app",
      bicep: { modules: [{ name: "x", scope: "group" }] },
      image: { repo: "x", dockerfile: "x" },
      rollout: { deployment: "x-dep", namespace: "x-ns" },
      rollouts: [{ kind: "Deployment", name: "y" }],
    },
    "x/deploy.json",
  );
  assert.ok(
    errs.some((e) => /'rollouts' is not supported/.test(e) && /single 'rollout'/.test(e)),
    `expected plural-rejection error directing to singular, got: ${errs.join("; ")}`,
  );
});

test("validateServiceManifest rejects plural rollouts even without singular present (FR-012)", () => {
  const errs = validateServiceManifest(
    {
      schemaVersion: 1, name: "x", kind: "app",
      bicep: { modules: [{ name: "x", scope: "group" }] },
      image: { repo: "x", dockerfile: "x" },
      rollouts: [{ kind: "Deployment", name: "y" }],
    },
    "x/deploy.json",
  );
  assert.ok(errs.some((e) => /'rollouts' is not supported/.test(e)));
});

test("real portal and worker manifests declare rollout.namespace (FR-012)", () => {
  const m = loadDeployManifest();
  for (const svc of ["portal", "worker"]) {
    const r = m.services[svc]?.rollout;
    assert.ok(r, `${svc} should have a rollout block`);
    assert.equal(typeof r.namespace, "string");
    assert.ok(r.namespace.length > 0, `${svc} rollout.namespace must be non-empty`);
  }
});

// ───────────────────────── Loader (synthetic dir) ─────────────────────────

function makeFakeServicesDir() {
  const dir = mkdtempSync(join(tmpdir(), "ps-deploy-manifest-"));
  return dir;
}

function writeJson(path, obj) {
  writeFileSync(path, JSON.stringify(obj, null, 2));
}

test("loader rejects when service folder for manifest entry is missing", () => {
  const dir = makeFakeServicesDir();
  try {
    writeJson(join(dir, "deploy-manifest.json"), {
      schemaVersion: 1, infraOrder: ["foo"], services: [],
    });
    assert.throws(() => loadDeployManifest({ servicesDir: dir, force: true }), /no matching service folder/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loader rejects orphan service folder not in root manifest", () => {
  const dir = makeFakeServicesDir();
  try {
    writeJson(join(dir, "deploy-manifest.json"), {
      schemaVersion: 1, infraOrder: ["x"], services: [],
    });
    mkdirSync(join(dir, "X"));
    writeJson(join(dir, "X", "deploy.json"), {
      schemaVersion: 1, name: "x", kind: "infra",
      bicep: { modules: [{ name: "x", scope: "group" }] },
    });
    // Add an orphan with a deploy.json
    mkdirSync(join(dir, "Stray"));
    writeJson(join(dir, "Stray", "deploy.json"), {
      schemaVersion: 1, name: "stray", kind: "infra",
      bicep: { modules: [{ name: "S", scope: "group" }] },
    });
    assert.throws(
      () => loadDeployManifest({ servicesDir: dir, force: true }),
      /not in deploy-manifest\.json/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loader cross-checks kind against infraOrder/services placement", () => {
  const dir = makeFakeServicesDir();
  try {
    writeJson(join(dir, "deploy-manifest.json"), {
      schemaVersion: 1, infraOrder: [], services: ["x"],
    });
    mkdirSync(join(dir, "X"));
    // Listed in services but kind=infra → mismatch.
    writeJson(join(dir, "X", "deploy.json"), {
      schemaVersion: 1, name: "x", kind: "infra",
      bicep: { modules: [{ name: "x", scope: "group" }] },
    });
    assert.throws(
      () => loadDeployManifest({ servicesDir: dir, force: true }),
      /kind must be 'app'/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});




// alwaysRedeploy boolean validator (modules + allModeModules).
test("validateServiceManifest accepts modules[].alwaysRedeploy: true", () => {
  const svc = {
    schemaVersion: 1,
    name: "x",
    kind: "infra",
    bicep: {
      modules: [{ name: "x", scope: "group", alwaysRedeploy: true }],
    },
  };
  const errs = validateServiceManifest(svc, "x/deploy.json");
  assert.deepEqual(errs, []);
});

test("validateServiceManifest rejects modules[].alwaysRedeploy with non-boolean", () => {
  const svc = {
    schemaVersion: 1,
    name: "x",
    kind: "infra",
    bicep: {
      modules: [{ name: "x", scope: "group", alwaysRedeploy: "yes" }],
    },
  };
  const errs = validateServiceManifest(svc, "x/deploy.json");
  assert.ok(
    errs.some((e) => /alwaysRedeploy must be a boolean/.test(e)),
    `expected alwaysRedeploy error, got: ${JSON.stringify(errs)}`,
  );
});

test("validateServiceManifest validates alwaysRedeploy in allModeModules too", () => {
  const svc = {
    schemaVersion: 1,
    name: "x",
    kind: "infra",
    bicep: {
      modules: [{ name: "x", scope: "group" }],
      allModeModules: [{ name: "x", scope: "group", alwaysRedeploy: 0 }],
    },
  };
  const errs = validateServiceManifest(svc, "x/deploy.json");
  assert.ok(
    errs.some((e) => /allModeModules.*alwaysRedeploy must be a boolean/.test(e)),
    `expected allModeModules alwaysRedeploy error, got: ${JSON.stringify(errs)}`,
  );
});

// MODULE_ALWAYS_REDEPLOY projection drift check: the export must always
// reflect whatever modules in the real manifest set alwaysRedeploy: true.
// Looser-invariant (no hardcoded list) so adding/removing flags in deploy.json
// doesn't require updating the test.
test("MODULE_ALWAYS_REDEPLOY projection matches the real manifest's alwaysRedeploy flags", async () => {
  const { MODULE_ALWAYS_REDEPLOY } = await import("../lib/service-info.mjs");
  const m = loadDeployManifest({ force: true });
  const expected = {};
  for (const svc of Object.values(m.services)) {
    const all = [...svc.bicep.modules, ...(svc.bicep.allModeModules ?? [])];
    for (const mod of all) {
      if (mod.alwaysRedeploy === true) expected[mod.name] = true;
    }
  }
  assert.deepEqual(MODULE_ALWAYS_REDEPLOY, expected);
});

// Drift-check: every common/*.bicep transitively referenced from a service
// main.bicep AND containing a Microsoft.Resources/deploymentScripts without a
// forceUpdateTag binding must be owned by a top-level module with
// alwaysRedeploy: true. Regex-based scanner (no AST); promote to a full parser
// only when 3+ services consume the same common bicep file.
test("drift: rerunnable common/*.bicep deploymentScripts are owned by alwaysRedeploy:true modules", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const { dirname, resolve, join: pJoin } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const m = loadDeployManifest({ force: true });

  const serviceMains = [];
  for (const [svcName, svc] of Object.entries(m.services)) {
    const mainPath = pJoin(REPO_ROOT, "deploy", "services", svcName, "bicep", "main.bicep");
    if (!existsSync(mainPath)) continue;
    const all = [...svc.bicep.modules, ...(svc.bicep.allModeModules ?? [])];
    serviceMains.push({ svcName, mainPath, mainText: readFileSync(mainPath, "utf8"), modules: all });
  }

  const MODULE_REF_RE = /module\s+\w+\s+'([^']+)'/g;
  const DEPLOY_SCRIPT_RE = /Microsoft\.Resources\/deploymentScripts/;
  // Only flag drifts in `common/*.bicep` files; service-local bicep manages
  // its own rerun policy.
  const isCommonBicep = (p) => /[\\/]common[\\/].+\.bicep$/.test(p);
  // Accept any forceUpdateTag binding (literal utcNow() OR a param bound to
  // utcNow() at the caller — both achieve per-deploy reruns).
  const FORCE_UPDATE_RE = /forceUpdateTag\s*:/;

  const drifts = [];
  for (const { svcName, mainPath, mainText, modules } of serviceMains) {
    const queue = [mainPath];
    const seen = new Set();
    while (queue.length > 0) {
      const cur = queue.shift();
      if (seen.has(cur)) continue;
      seen.add(cur);
      const text = cur === mainPath ? mainText : (existsSync(cur) ? readFileSync(cur, "utf8") : "");
      if (!text) continue;
      if (isCommonBicep(cur) && DEPLOY_SCRIPT_RE.test(text) && !FORCE_UPDATE_RE.test(text)) {
        const anyAlways = modules.some((mod) => mod.alwaysRedeploy === true);
        if (!anyAlways) {
          drifts.push(
            `${svcName}: ${cur.replace(REPO_ROOT, "")} contains a deploymentScript without ` +
              `forceUpdateTag: utcNow(), but no top-level module entry for '${svcName}' ` +
              `has alwaysRedeploy: true. Add the flag in deploy/services/${svcName}/deploy.json ` +
              `or add forceUpdateTag: utcNow() to the script.`,
          );
        }
      }
      let m2;
      MODULE_REF_RE.lastIndex = 0;
      while ((m2 = MODULE_REF_RE.exec(text)) !== null) {
        const ref = m2[1];
        if (!ref.endsWith(".bicep")) continue;
        const next = resolve(dirname(cur), ref);
        queue.push(next);
      }
    }
  }

  assert.deepEqual(drifts, [], `drift detected:\n${drifts.join("\n")}`);
});
