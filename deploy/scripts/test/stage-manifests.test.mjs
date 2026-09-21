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
    envName: "mytestenv",
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
import { mkdtempSync, existsSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
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

function byoEnv(extra = {}) {
  return makePortalEnv({
    DEPLOY_POSTGRES: "false",
    PILOTSWARM_USE_MANAGED_IDENTITY: "0",
    PILOTSWARM_DB_AAD_USER: undefined,
    DATABASE_URL: "postgresql://u:byo-password-not-for-configmaps@shared.invalid:5432/testenv?sslmode=require",
    PILOTSWARM_CMS_FACTS_DATABASE_URL: "postgresql://u:byo-password-not-for-configmaps@shared.invalid:5432/testenv?sslmode=require",
    DATABASE_URL_SECRET_VERSION: "a".repeat(32),
    PILOTSWARM_CMS_FACTS_DATABASE_URL_SECRET_VERSION: "b".repeat(32),
    AZURE_STORAGE_CONTAINER: "copilot-sessions",
    PILOTSWARM_TURN_TIMEOUT_MS: "1200000",
    PILOTSWARM_LIVE_TURN: "0",
    ...extra,
  });
}

function allFileText(dir) {
  return readdirSync(dir, { withFileTypes: true }).map((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? allFileText(path) : readFileSync(path, "utf8");
  }).join("\n");
}

for (const [service, edgeMode, tlsSource, overlay] of [
  ["worker", "afd", "letsencrypt", "default"],
  ["portal", "afd", "letsencrypt", "afd-letsencrypt"],
  ["portal", "afd", "akv", "afd-akv"],
  ["portal", "private", "akv-selfsigned", "private-akv"],
]) {
  test(`password BYO stages ${service}/${overlay} without AAD stubs or credential ConfigMaps`, (t) => {
    const stagingDir = mkdtempSync(join(tmpdir(), "ps-byo-stage-"));
    t.after(() => rmSync(stagingDir, { recursive: true, force: true }));
    const env = byoEnv({ EDGE_MODE: edgeMode, TLS_SOURCE: tlsSource });
    const root = stageManifests({ service, envName: "testenv", env, stagingDir });
    const overlayText = readFileSync(join(root, "overlays", overlay, ".env"), "utf8");
    for (const key of ["DATABASE_URL", "PILOTSWARM_CMS_FACTS_DATABASE_URL", "PILOTSWARM_DB_AAD_USER"]) {
      assert.doesNotMatch(overlayText, new RegExp(`^${key}=`, "m"));
    }
    assert.match(overlayText, /^PILOTSWARM_USE_MANAGED_IDENTITY=0$/m);
    assert.match(overlayText, /^PILOTSWARM_BLOB_USE_MANAGED_IDENTITY=1$/m);
    assert.ok(!allFileText(root).includes("byo-password-not-for-configmaps"), "no password in ANY uploaded file");
    const component = JSON.parse(readFileSync(join(root, "components/database-secrets/kustomization.yaml"), "utf8"));
    const patch = JSON.parse(component.patches[0].patch);
    const pod = patch.spec.template.spec;
    assert.equal(pod.containers[0].name, service);
    assert.deepEqual(pod.containers[0].env.map((entry) => entry.name),
      ["DATABASE_URL", "PILOTSWARM_CMS_FACTS_DATABASE_URL"]);
    assert.ok(pod.containers[0].env.every((entry) => entry.valueFrom.secretKeyRef && !("value" in entry)));
    const spc = JSON.parse(readFileSync(join(root, "components/database-secrets/secret-provider-class.yaml"), "utf8"));
    assert.match(spc.spec.parameters.objects, new RegExp(`objectVersion: ${"a".repeat(32)}`));
    assert.equal(spc.spec.parameters.keyvaultName, env.KV_NAME);
    assert.equal(pod.volumes[0].csi.volumeAttributes.secretProviderClass, spc.metadata.name);
    assert.equal(pod.containers[0].env[0].valueFrom.secretKeyRef.name, spc.spec.secretObjects[0].secretName);
    assert.match(readFileSync(join(root, "overlays", overlay, "kustomization.yaml"), "utf8"),
      /- \.\.\/\.\.\/components\/database-secrets/);
  });
}

test("BYO Entra keeps the real AAD user and projects passwordless URLs through CSI", (t) => {
  const stagingDir = mkdtempSync(join(tmpdir(), "ps-byo-aad-"));
  t.after(() => rmSync(stagingDir, { recursive: true, force: true }));
  const env = byoEnv({
    PILOTSWARM_USE_MANAGED_IDENTITY: "1",
    PILOTSWARM_DB_AAD_USER: "external-principal",
    DATABASE_URL: "postgresql://external-principal@shared.invalid/app?sslmode=require",
    PILOTSWARM_CMS_FACTS_DATABASE_URL: "postgresql://external-principal@shared.invalid/app?sslmode=require",
  });
  const root = stageManifests({ service: "worker", envName: "testenv", env, stagingDir });
  const text = readFileSync(join(root, "overlays/default/.env"), "utf8");
  assert.match(text, /^PILOTSWARM_DB_AAD_USER=external-principal$/m);
  assert.doesNotMatch(text, /^DATABASE_URL=/m);
});

test("secret-reference-only manifests work without loading database passwords", (t) => {
  const stagingDir = mkdtempSync(join(tmpdir(), "ps-byo-refs-"));
  t.after(() => rmSync(stagingDir, { recursive: true, force: true }));
  const env = byoEnv({
    DATABASE_URL: undefined, PILOTSWARM_CMS_FACTS_DATABASE_URL: undefined,
    DATABASE_URL_SECRET_NAME: "external-runtime", PILOTSWARM_CMS_FACTS_DATABASE_URL_SECRET_NAME: "external-cms",
  });
  const root = stageManifests({ service: "worker", envName: "testenv", env, stagingDir });
  const text = readFileSync(join(root, "components/database-secrets/secret-provider-class.yaml"), "utf8");
  assert.match(text, /external-runtime/);
  assert.match(text, /external-cms/);
});

test("rotated Key Vault versions change Secret references; unchanged versions are deterministic", (t) => {
  const stagingDir = mkdtempSync(join(tmpdir(), "ps-byo-rotation-"));
  t.after(() => rmSync(stagingDir, { recursive: true, force: true }));
  const render = (version) => {
    const root = stageManifests({
      service: "worker", envName: "testenv", stagingDir,
      env: byoEnv({ DATABASE_URL_SECRET_VERSION: version }),
    });
    return readFileSync(join(root, "components/database-secrets/kustomization.yaml"), "utf8");
  };
  const first = render("a".repeat(32));
  assert.equal(render("a".repeat(32)), first);
  assert.notEqual(render("c".repeat(32)), first);
});

test("runtime manifests fail before staging when BYO settings or versions are missing", (t) => {
  const stagingDir = mkdtempSync(join(tmpdir(), "ps-byo-invalid-"));
  t.after(() => rmSync(stagingDir, { recursive: true, force: true }));
  assert.throws(() => stageManifests({
    service: "worker", envName: "testenv", stagingDir,
    env: { DEPLOY_POSTGRES: "false", PILOTSWARM_USE_MANAGED_IDENTITY: "0" },
  }), /requires DATABASE_URL and PILOTSWARM_CMS_FACTS_DATABASE_URL/);
  assert.throws(() => stageManifests({
    service: "worker", envName: "testenv", stagingDir,
    env: byoEnv({ DATABASE_URL_SECRET_VERSION: undefined }),
  }), /DATABASE_URL_SECRET_VERSION/);
  assert.equal(existsSync(join(stagingDir, "gitops")), false);
});
