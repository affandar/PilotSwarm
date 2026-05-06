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
    "cert-manager",
    "cert-manager-issuers",
    "worker",
    "portal",
  ]);
  assert.equal(m.services.worker.kind, "app");
  assert.equal(m.services["base-infra"].kind, "infra");
  assert.equal(m.services["cert-manager"].kind, "infra");
  assert.equal(m.services["cert-manager-issuers"].kind, "infra");
  assert.equal(m.regionShort.westus3, "wus3");
});

test("derived constants match prior hardcoded shape (regression contract)", () => {
  // ALL_SEQUENCE contract (was the headline assertion in all-mode.test.mjs).
  assert.deepEqual(ALL_SEQUENCE, [
    "global-infra",
    "base-infra",
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
  assert.deepEqual(SERVICE_TO_MODULES["cert-manager"], ["base-infra", "cert-manager"]);
  assert.deepEqual(SERVICE_TO_MODULES["cert-manager-issuers"], ["base-infra", "cert-manager-issuers"]);

  // MODULE_SCOPE: covers every named module exactly once.
  assert.equal(MODULE_SCOPE["global-infra"], "sub");
  assert.equal(MODULE_SCOPE["base-infra"], "group");
  assert.equal(MODULE_SCOPE.worker, "group");
  assert.equal(MODULE_SCOPE.portal, "group");
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

