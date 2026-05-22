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

test("portal: throws when EDGE_MODE / TLS_SOURCE are absent (FR-001)", () => {
  // The previous silent default (afd-letsencrypt) was a footgun — operators
  // got an unexpected overlay when they forgot to scaffold the env. The
  // contract gate now hard-fails with both selector names mentioned.
  assert.throws(
    () => resolveOverlayName({ service: "portal", envName: "dev", env: {} }),
    (err) => {
      assert.match(err.message, /EDGE_MODE/);
      assert.match(err.message, /TLS_SOURCE/);
      assert.match(err.message, /overlay-contracts\.mjs/);
      return true;
    },
  );
});

test("portal: throws when only EDGE_MODE is set", () => {
  assert.throws(
    () => resolveOverlayName({ service: "portal", envName: "dev", env: { EDGE_MODE: "afd" } }),
    /TLS_SOURCE/,
  );
});

test("portal: throws when only TLS_SOURCE is set", () => {
  assert.throws(
    () => resolveOverlayName({ service: "portal", envName: "dev", env: { TLS_SOURCE: "letsencrypt" } }),
    /EDGE_MODE/,
  );
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
      // Portal config keys (non-credentials). Stubbed with non-empty values
      // so substituteOverlayEnv's fail-closed gate passes; this test cares
      // about model_providers.json copy, not portal-config values.
      PORTAL_AUTH_PROVIDER: "none",
      PORTAL_AUTH_ENTRA_TENANT_ID: "00000000-0000-0000-0000-000000000000",
      PORTAL_AUTH_ENTRA_CLIENT_ID: "00000000-0000-0000-0000-000000000000",
      PORTAL_AUTH_ALLOW_UNAUTHENTICATED: "false",
      PORTAL_AUTH_ENTRA_ADMIN_GROUPS: "__PS_UNSET__",
      PORTAL_AUTH_ENTRA_USER_GROUPS: "__PS_UNSET__",
      PORTAL_AUTHZ_DEFAULT_ROLE: "viewer",
      PORTAL_AUTHZ_ADMIN_GROUPS: "__PS_UNSET__",
      PORTAL_AUTHZ_USER_GROUPS: "__PS_UNSET__",
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

// ─── FR-013: PORTAL_TLS_CERT_NAME placeholder substitution ───

function makePortalEnv(extra = {}) {
  return {
    EDGE_MODE: "afd",
    TLS_SOURCE: "akv",
    FOUNDRY_ENDPOINT: "",
    SPC_KEYS_HASH: "placeholder",
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
    PORTAL_AUTH_PROVIDER: "none",
    PORTAL_AUTH_ENTRA_TENANT_ID: "00000000-0000-0000-0000-000000000000",
    PORTAL_AUTH_ENTRA_CLIENT_ID: "00000000-0000-0000-0000-000000000000",
    PORTAL_AUTH_ALLOW_UNAUTHENTICATED: "false",
    PORTAL_AUTH_ENTRA_ADMIN_GROUPS: "__PS_UNSET__",
    PORTAL_AUTH_ENTRA_USER_GROUPS: "__PS_UNSET__",
    PORTAL_AUTHZ_DEFAULT_ROLE: "viewer",
    PORTAL_AUTHZ_ADMIN_GROUPS: "__PS_UNSET__",
    PORTAL_AUTHZ_USER_GROUPS: "__PS_UNSET__",
    ...extra,
  };
}

test("stageManifests(portal): PORTAL_TLS_CERT_NAME override propagates to tls-akv + edge-appgw (FR-013)", () => {
  const stagingDir = mkdtempSync(join(tmpdir(), "ps-stage-tls-override-"));
  const stagedRoot = stageManifests({
    service: "portal",
    envName: "dev",
    env: makePortalEnv({ PORTAL_TLS_CERT_NAME: "custom-tls-cert" }),
    stagingDir,
  });
  const spcPath = join(stagedRoot, "components", "tls-akv", "secret-provider-class-tls.yaml");
  const tlsAkvKust = join(stagedRoot, "components", "tls-akv", "kustomization.yaml");
  const edgeAppgwKust = join(stagedRoot, "components", "edge-appgw", "kustomization.yaml");
  for (const p of [spcPath, tlsAkvKust, edgeAppgwKust]) {
    assert.ok(existsSync(p), `expected staged file at ${p}`);
    const body = readFileSync(p, "utf8");
    assert.ok(
      !body.includes("__PORTAL_TLS_CERT_NAME__"),
      `staged file ${p} still contains the placeholder; substitution did not run`,
    );
    assert.ok(
      body.includes("custom-tls-cert"),
      `staged file ${p} does not contain the override value`,
    );
  }
});

test("stageManifests(portal): PORTAL_TLS_CERT_NAME defaults to pilotswarm-portal-tls when unset (FR-013)", () => {
  const stagingDir = mkdtempSync(join(tmpdir(), "ps-stage-tls-default-"));
  const env = makePortalEnv();
  delete env.PORTAL_TLS_CERT_NAME;
  const stagedRoot = stageManifests({
    service: "portal",
    envName: "dev",
    env,
    stagingDir,
  });
  const spcPath = join(stagedRoot, "components", "tls-akv", "secret-provider-class-tls.yaml");
  const body = readFileSync(spcPath, "utf8");
  assert.ok(
    !body.includes("__PORTAL_TLS_CERT_NAME__"),
    "staged SPC still contains the placeholder; default substitution did not run",
  );
  assert.ok(
    body.includes("pilotswarm-portal-tls"),
    "staged SPC does not contain the documented default value",
  );
  // Defaulting is observable via the env map being mutated.
  assert.equal(env.PORTAL_TLS_CERT_NAME, "pilotswarm-portal-tls");
});
