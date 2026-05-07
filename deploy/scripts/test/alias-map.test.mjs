// Unit tests for the FR-022 alias map (deploy-bicep.mjs).
//
// Run: node --test deploy/scripts/test/alias-map.test.mjs
//   or: npm run test:deploy-scripts
//
// Covers:
//   - Explicit OUTPUT_ALIAS overrides (e.g. keyVaultName → KV_NAME).
//   - manifestsContainerName → DEPLOYMENT_STORAGE_CONTAINER_NAME (post-refactor:
//     each per-service bicep emits its own; no _WORKER/_PORTAL suffixes).
//   - Default camelCase → UPPER_SNAKE fallback rule.

import { test } from "node:test";
import assert from "node:assert/strict";

import { _internals } from "../lib/deploy-bicep.mjs";

const { OUTPUT_ALIAS, aliasFor } = _internals;

test("explicit OUTPUT_ALIAS overrides take precedence", () => {
  assert.equal(OUTPUT_ALIAS.keyVaultName, "KV_NAME");
  assert.equal(OUTPUT_ALIAS.acrLoginServer, "ACR_LOGIN_SERVER");
  assert.equal(OUTPUT_ALIAS.acrName, "ACR_NAME");
  assert.equal(OUTPUT_ALIAS.aksClusterName, "AKS_CLUSTER_NAME");
  assert.equal(OUTPUT_ALIAS.blobContainerEndpoint, "BLOB_CONTAINER_ENDPOINT");
  assert.equal(OUTPUT_ALIAS.deploymentStorageAccountName, "DEPLOYMENT_STORAGE_ACCOUNT_NAME");
  // Workload-identity UAMI clientId from BaseInfra `csiIdentityClientId`
  // output → cascades into env Map under WORKLOAD_IDENTITY_CLIENT_ID so
  // the manifests step's overlay `.env` substitution gets the real value
  // automatically (no manual seed required after BaseInfra deploys).
  assert.equal(OUTPUT_ALIAS.csiIdentityClientId, "WORKLOAD_IDENTITY_CLIENT_ID");
  // BaseInfra-created approver UAMI cascades into Portal Bicep's
  // `approvalManagedIdentityId` param via APPROVAL_MANAGED_IDENTITY_ID.
  assert.equal(OUTPUT_ALIAS.approverIdentityResourceId, "APPROVAL_MANAGED_IDENTITY_ID");
});

test("post-refactor: manifestsContainerName resolves to single env key", () => {
  assert.equal(
    OUTPUT_ALIAS.manifestsContainerName,
    "DEPLOYMENT_STORAGE_CONTAINER_NAME",
    "Each per-service bicep emits manifestsContainerName; deploy.mjs is service-scoped per invocation.",
  );
  assert.ok(
    !("workerManifestsContainerName" in OUTPUT_ALIAS),
    "Pre-refactor _WORKER alias should be removed",
  );
  assert.ok(
    !("portalManifestsContainerName" in OUTPUT_ALIAS),
    "Pre-refactor _PORTAL alias should be removed",
  );
});

test("default camelCase → UPPER_SNAKE rule", () => {
  assert.equal(aliasFor("frontDoorProfileName"), "FRONT_DOOR_PROFILE_NAME");
  assert.equal(aliasFor("simpleKey"), "SIMPLE_KEY");
  assert.equal(aliasFor("oneTwo"), "ONE_TWO");
});

test("default rule: handles single-word lowerCamel keys", () => {
  assert.equal(aliasFor("foo"), "FOO");
});

test("default rule: handles ALL-CAPS acronyms inside camelCase", () => {
  assert.equal(aliasFor("myACRName"), "MY_ACR_NAME");
  assert.equal(aliasFor("kvURI"), "KV_URI");
});

test("default rule: digits boundary handled", () => {
  assert.equal(aliasFor("stamp1Name"), "STAMP1_NAME");
});

test("Foundry endpoint output aliases to FOUNDRY_ENDPOINT", () => {
  assert.equal(
    OUTPUT_ALIAS.foundryEndpoint,
    "FOUNDRY_ENDPOINT",
    "base-infra emits foundryEndpoint when foundryEnabled; manifests substitution uses __FOUNDRY_ENDPOINT__ in worker model_providers.json",
  );
  assert.equal(
    OUTPUT_ALIAS.foundryAccountName,
    "FOUNDRY_ACCOUNT_NAME",
  );
});
