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

import { stageManifests, validateGptOnlyCatalog } from "../lib/stage-manifests.mjs";
import {
  dbmigratePrivateOverrides,
  dbmigratePrivatePortalDefaults,
  validateDeploymentProfile,
} from "../lib/deployment-profile.mjs";
import { sanitizeFoundryResult } from "../validate-foundry-smoke.mjs";
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
      PILOTSWARM_TURN_TIMEOUT_MS: "1200000",
      PILOTSWARM_LIVE_TURN: "0",
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
      PILOTSWARM_TURN_TIMEOUT_MS: "1200000",
      PILOTSWARM_LIVE_TURN: "0",
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

test("GPT-only catalog rejects non-GPT providers and requires a resolved Foundry endpoint", () => {
  const env = {
    GPT_ONLY: "true",
    FOUNDRY_ENABLED: "true",
    FOUNDRY_ENDPOINT: "https://example.cognitiveservices.azure.com",
  };
  assert.doesNotThrow(() =>
    validateGptOnlyCatalog(
      {
        providers: [{ id: "azure-foundry", type: "openai", models: [{ name: "gpt-5.4-mini" }] }],
        defaultModel: "azure-foundry:gpt-5.4-mini",
      },
      env,
    ),
  );
  assert.throws(
    () =>
      validateGptOnlyCatalog(
        {
          providers: [{ id: "anthropic", type: "anthropic", models: [{ name: "claude-sonnet" }] }],
          defaultModel: "anthropic:claude-sonnet",
        },
        env,
      ),
    /only provider must be azure-foundry/,
  );
  assert.throws(
    () =>
      validateGptOnlyCatalog(
        {
          providers: [{ id: "azure-foundry", type: "openai", models: [{ name: "gpt-5.4-mini" }] }],
          defaultModel: "azure-foundry:gpt-5.4-mini",
        },
        { ...env, FOUNDRY_ENDPOINT: "" },
      ),
    /FOUNDRY_ENDPOINT must be resolved/,
  );
});

test("DBMigrate private profile fails closed on insecure auth or missing operational inputs", () => {
  const valid = {
    ...dbmigratePrivateOverrides(),
    ...dbmigratePrivatePortalDefaults(),
    SUBSCRIPTION_ID: "00000000-0000-0000-0000-000000000000",
    PORTAL_AUTH_ENTRA_TENANT_ID: "11111111-1111-1111-1111-111111111111",
    PORTAL_AUTH_ENTRA_CLIENT_ID: "22222222-2222-2222-2222-222222222222",
    PORTAL_AUTHZ_ADMIN_GROUPS: "33333333-3333-3333-3333-333333333333",
    PORTAL_AUTHZ_USER_GROUPS: "44444444-4444-4444-4444-444444444444",
    MONITOR_ALERT_EMAIL: "oncall@example.invalid",
    FOUNDRY_DEPLOYMENTS_FILE: "deploy/envs/local/test/foundry-deployments.json",
    DEPLOY_POSTGRES: "true",
    PILOTSWARM_USE_MANAGED_IDENTITY: "1",
  };
  assert.deepEqual(validateDeploymentProfile(valid), []);
  const errors = validateDeploymentProfile({
    ...valid,
    AUTHZ_ENFORCE_OWNERSHIP: "false",
    MONITOR_ALERT_EMAIL: "",
    AKS_USER_POOL_MAX_COUNT: "10",
  });
  assert.ok(errors.some((e) => e.includes("AUTHZ_ENFORCE_OWNERSHIP")));
  assert.ok(errors.some((e) => e.includes("MONITOR_ALERT_EMAIL")));
  assert.ok(errors.some((e) => e.includes("AKS_USER_POOL_MAX_COUNT")));
});

test("Foundry smoke evidence classifies policy rejection without retaining prompt content", async () => {
  const headers = new Headers({ "apim-request-id": "request-123" });
  const response = {
    url: "https://example.cognitiveservices.azure.com/openai/v1/chat/completions",
    status: 400,
    ok: false,
    headers,
  };
  const payload = {
    error: {
      code: "content_filter",
      innererror: {
        code: "ResponsibleAIPolicyViolation",
        content_filter_result: { jailbreak: { detected: true, filtered: true } },
      },
    },
  };
  const requestBody = {
    model: "gpt-5.4-mini",
    messages: [{ role: "system", content: "sensitive representative prompt" }],
  };
  const evidence = sanitizeFoundryResult({ response, payload, requestBody });
  assert.equal(evidence.policyRejected, true);
  assert.equal(evidence.jailbreak.detected, true);
  assert.equal(evidence.jailbreak.filtered, true);
  assert.equal(evidence.requestId, "request-123");
  assert.equal(JSON.stringify(evidence).includes("sensitive representative prompt"), false);
});
