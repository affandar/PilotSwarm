// Tests for placeholder-substitution inside the staged GitOps tree.
// Covers the worker `model_providers.json` __FOUNDRY_ENDPOINT__ rule that
// wires the bicep-emitted FOUNDRY_ENDPOINT env value into the catalog the
// worker pod consumes.
//
// Run: node --test deploy/scripts/test/foundry-substitute.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stageManifests } from "../lib/stage-manifests.mjs";
import { REPO_ROOT } from "../lib/common.mjs";

// Helper: copy the real worker base/* into a fixture root, swap out
// model_providers.json with a known shape, drop a minimal overlay so
// stageManifests doesn't fail on the .env step.
function buildFixtureWorkerTree(stagingDir, modelProvidersBody) {
  // We use the real `deploy/gitops/worker` tree (it already has overlays/default/.env)
  // but replace its base/model_providers.json with a controlled fixture body for
  // assertion stability. stageManifests cp's from REPO_ROOT, so we instead point
  // the test at staging post-cp and inspect the result.
  const stageRoot = join(stagingDir, "gitops", "worker");
  return stageRoot;
}

test("__FOUNDRY_ENDPOINT__ in model_providers.json is substituted from FOUNDRY_ENDPOINT", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ps-foundry-sub-"));
  try {
    const env = {
      // Provide every key the worker overlay .env needs so the substitute
      // step doesn't fail-closed before we reach the placeholder rules.
      KV_NAME: "kvtest",
      WORKLOAD_IDENTITY_CLIENT_ID: "00000000-0000-0000-0000-000000000000",
      AZURE_TENANT_ID: "tenanttest",
      DATABASE_URL: "postgres://test",
      AZURE_STORAGE_ACCOUNT_URL: "https://example.blob.core.windows.net",
      AZURE_STORAGE_CONTAINER: "copilot-sessions",
      DEPLOYMENT_STORAGE_ACCOUNT_NAME: "satest",
      DEPLOYMENT_STORAGE_CONTAINER_NAME: "worker-manifests",
      ACR_LOGIN_SERVER: "acrtest.azurecr.io",
      NAMESPACE: "pilotswarm",
      RESOURCE_PREFIX: "pstest",
      AKS_CLUSTER_NAME: "pstest-aks",
      WORKER_IMAGE_TAG: "test",
      IMAGE: "acrtest.azurecr.io/pilotswarm-worker:test",
      PILOTSWARM_USE_MANAGED_IDENTITY: "1",
      PILOTSWARM_CMS_FACTS_DATABASE_URL: "postgres://test/cms",
      PILOTSWARM_DB_AAD_USER: "uami",
      LOCATION: "westus3",
      FOUNDRY_ENDPOINT: "https://pstest-aif.cognitiveservices.azure.com/",
    };
    const stagedRoot = stageManifests({
      service: "worker",
      envName: "test",
      env,
      stagingDir: tmp,
    });
    const catalog = readFileSync(join(stagedRoot, "base", "model_providers.json"), "utf8");
    assert.ok(
      !catalog.includes("__FOUNDRY_ENDPOINT__"),
      "placeholder must be substituted out when FOUNDRY_ENDPOINT is set",
    );
    assert.ok(
      catalog.includes("https://pstest-aif.cognitiveservices.azure.com/openai/v1"),
      "endpoint should be present with /openai/v1 suffix and no double slash",
    );
    assert.ok(
      !catalog.includes(".azure.com//openai/v1"),
      "trailing slash on endpoint should be collapsed",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("__FOUNDRY_ENDPOINT__ stays unresolved when FOUNDRY_ENDPOINT is empty/unset", () => {
  // When the stamp has foundryEnabled=false, the bicep emits an empty
  // string for FOUNDRY_ENDPOINT. We let the placeholder remain in the
  // staged file so the catalog provider load skips at runtime (env:VAR
  // resolves to undefined → provider not loaded). This must NOT throw.
  const tmp = mkdtempSync(join(tmpdir(), "ps-foundry-sub-disabled-"));
  try {
    const env = {
      KV_NAME: "kvtest",
      WORKLOAD_IDENTITY_CLIENT_ID: "00000000-0000-0000-0000-000000000000",
      AZURE_TENANT_ID: "tenanttest",
      DATABASE_URL: "postgres://test",
      AZURE_STORAGE_ACCOUNT_URL: "https://example.blob.core.windows.net",
      AZURE_STORAGE_CONTAINER: "copilot-sessions",
      DEPLOYMENT_STORAGE_ACCOUNT_NAME: "satest",
      DEPLOYMENT_STORAGE_CONTAINER_NAME: "worker-manifests",
      ACR_LOGIN_SERVER: "acrtest.azurecr.io",
      NAMESPACE: "pilotswarm",
      RESOURCE_PREFIX: "pstest",
      AKS_CLUSTER_NAME: "pstest-aks",
      WORKER_IMAGE_TAG: "test",
      IMAGE: "acrtest.azurecr.io/pilotswarm-worker:test",
      PILOTSWARM_USE_MANAGED_IDENTITY: "1",
      PILOTSWARM_CMS_FACTS_DATABASE_URL: "postgres://test/cms",
      PILOTSWARM_DB_AAD_USER: "uami",
      LOCATION: "westus3",
      FOUNDRY_ENDPOINT: "",
    };
    const stagedRoot = stageManifests({
      service: "worker",
      envName: "test",
      env,
      stagingDir: tmp,
    });
    const catalog = readFileSync(join(stagedRoot, "base", "model_providers.json"), "utf8");
    assert.ok(
      catalog.includes("__FOUNDRY_ENDPOINT__"),
      "placeholder must remain when FOUNDRY_ENDPOINT is empty (graceful degrade)",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
