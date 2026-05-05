// Coverage for `resolveOverlayName` — the per-service overlay variant rule.
// After the dev/prod-collapse refactor, worker/cert-manager/cert-manager-issuers
// always resolve to a single `default` overlay; only Portal keeps a multi-variant
// matrix keyed by EDGE_MODE × TLS_SOURCE.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveOverlayName } from "../lib/stage-manifests.mjs";

test("worker → default (no env.OVERLAY logic)", () => {
  const got = resolveOverlayName({
    service: "worker",
    envName: "dev",
    env: {},
  });
  assert.equal(got, "default");
});

test("worker → default regardless of envName", () => {
  const got = resolveOverlayName({
    service: "worker",
    envName: "chkrawtestps",
    env: {},
  });
  assert.equal(got, "default");
});

test("cert-manager → default (not affected by EDGE_MODE/TLS_SOURCE)", () => {
  const got = resolveOverlayName({
    service: "cert-manager",
    envName: "dev",
    env: { EDGE_MODE: "private", TLS_SOURCE: "akv" },
  });
  assert.equal(got, "default");
});

test("cert-manager-issuers → default", () => {
  const got = resolveOverlayName({
    service: "cert-manager-issuers",
    envName: "prod",
    env: {},
  });
  assert.equal(got, "default");
});

test("portal: afd + letsencrypt → afd-letsencrypt", () => {
  const got = resolveOverlayName({
    service: "portal",
    envName: "dev",
    env: { EDGE_MODE: "afd", TLS_SOURCE: "letsencrypt" },
  });
  assert.equal(got, "afd-letsencrypt");
});

test("portal: afd + akv → afd-akv", () => {
  const got = resolveOverlayName({
    service: "portal",
    envName: "prod",
    env: { EDGE_MODE: "afd", TLS_SOURCE: "akv" },
  });
  assert.equal(got, "afd-akv");
});

test("portal: private + akv → private-akv", () => {
  const got = resolveOverlayName({
    service: "portal",
    envName: "dev",
    env: { EDGE_MODE: "private", TLS_SOURCE: "akv" },
  });
  assert.equal(got, "private-akv");
});

test("portal: private + akv-selfsigned collapses to private-akv (shared overlay)", () => {
  const got = resolveOverlayName({
    service: "portal",
    envName: "dev",
    env: {
      EDGE_MODE: "private",
      TLS_SOURCE: "akv-selfsigned",
    },
  });
  assert.equal(got, "private-akv");
});

test("portal: defaults (no EDGE_MODE / TLS_SOURCE) → afd-letsencrypt", () => {
  // Mirrors deploy.mjs validation defaults so a fresh dev env that
  // forgets to set the new keys still resolves to a real overlay.
  const got = resolveOverlayName({
    service: "portal",
    envName: "dev",
    env: {},
  });
  assert.equal(got, "afd-letsencrypt");
});

test("portal: case-insensitive on EDGE_MODE / TLS_SOURCE", () => {
  // deploy.mjs lowercases these but defensive callers may not.
  const got = resolveOverlayName({
    service: "portal",
    envName: "dev",
    env: { EDGE_MODE: "Private", TLS_SOURCE: "AKV-SelfSigned" },
  });
  assert.equal(got, "private-akv");
});



// ─── stageManifests integration: portal pulls model_providers.json from worker base ───
import { stageManifests } from "../lib/stage-manifests.mjs";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("stageManifests(portal): copies worker base model_providers.json into portal staging tree", () => {
  const stagingDir = mkdtempSync(join(tmpdir(), "ps-stage-"));
  const stagedRoot = stageManifests({
    service: "portal",
    envName: "dev",
    env: {
      EDGE_MODE: "afd",
      TLS_SOURCE: "letsencrypt",
      FOUNDRY_ENDPOINT: "",
      SPC_KEYS_HASH: "placeholder",
      // Stub all overlay placeholders so substituteOverlayEnv passes;
      // this test cares about model_providers.json copy, not env values.
      IMAGE: "stub.azurecr.io/p:t",
      NAMESPACE: "pilotswarm",
      KV_NAME: "stub-kv",
      WORKLOAD_IDENTITY_CLIENT_ID: "00000000-0000-0000-0000-000000000000",
      AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000000",
      PORTAL_HOSTNAME: "stub.example.com",
      PILOTSWARM_USE_MANAGED_IDENTITY: "1",
      AZURE_STORAGE_ACCOUNT_URL: "https://stub.blob.core.windows.net/",
      PILOTSWARM_CMS_FACTS_DATABASE_URL: "postgresql://u@h:5432/d?sslmode=require",
      PILOTSWARM_DB_AAD_USER: "stub",
      DATABASE_URL: "postgresql://u:p@h:5432/d?sslmode=require",
    },
    stagingDir,
  });
  const portalCatalog = join(stagedRoot, "base", "model_providers.json");
  assert.ok(existsSync(portalCatalog), `portal staged catalog missing at ${portalCatalog}`);
  const portalContent = readFileSync(portalCatalog, "utf8");
  assert.match(portalContent, /"providers"\s*:/);
  // Source-of-truth invariant: byte-equality (FOUNDRY_ENDPOINT="" so no
  // placeholder substitution actually happens in either tree).
  const workerCatalog = readFileSync(
    join(process.cwd(), "deploy", "gitops", "worker", "base", "model_providers.json"),
    "utf8",
  );
  assert.equal(portalContent, workerCatalog, "portal staged catalog must byte-match worker base catalog");
});
