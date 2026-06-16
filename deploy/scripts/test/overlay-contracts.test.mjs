// Regression tests for deploy/scripts/lib/overlay-contracts.mjs.
//
// The scan-based assertion below is the recurrence guard for the
// "operator only discovers the missing key when substitute-env.mjs
// fails mid-deploy" class of bug — every key in every overlay's actual
// .env file must have a documented role in the contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readFileSync as _read } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  OVERLAY_CONTRACTS,
  resolveOverlayKey,
  getContract,
  validateRequiredEnv,
  validateVpnGatewayCombo,
  applyStubKeys,
  EDGE_MODES,
  TLS_SOURCES,
  DEFAULT_EDGE_MODE,
  DEFAULT_TLS_SOURCE,
} from "../lib/overlay-contracts.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const OVERLAYS_DIR = join(REPO_ROOT, "deploy", "gitops", "portal", "overlays");

function readOverlayEnvKeys(overlay) {
  const path = join(OVERLAYS_DIR, overlay, ".env");
  const raw = readFileSync(path, "utf8");
  const keys = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    keys.push(key);
  }
  return keys;
}

test("resolveOverlayKey collapses akv-selfsigned to akv", () => {
  assert.equal(
    resolveOverlayKey({ edgeMode: "afd", tlsSource: "akv-selfsigned" }),
    "afd-akv",
  );
  assert.equal(
    resolveOverlayKey({ edgeMode: "private", tlsSource: "akv-selfsigned" }),
    "private-akv",
  );
});

test("resolveOverlayKey honors JS defaults when inputs are blank", () => {
  assert.equal(resolveOverlayKey({}), `${DEFAULT_EDGE_MODE}-${DEFAULT_TLS_SOURCE}`);
});

test("EDGE_MODES + TLS_SOURCES match the canonical contract universe", () => {
  assert.deepEqual([...EDGE_MODES].sort(), ["afd", "private"]);
  assert.deepEqual([...TLS_SOURCES].sort(), ["akv", "akv-selfsigned", "letsencrypt"]);
});

test("OVERLAY_CONTRACTS has an entry for every (edge,tls) overlay directory", () => {
  for (const overlay of ["afd-akv", "afd-letsencrypt", "private-akv"]) {
    assert.ok(
      OVERLAY_CONTRACTS[overlay],
      `OVERLAY_CONTRACTS missing entry for overlay '${overlay}'`,
    );
  }
});

// Scanner: every literal key in every overlay's .env file must appear in
// exactly one role bucket. Adding a new key to an overlay .env without
// adding it to the contract fails this test.
for (const overlay of ["afd-akv", "afd-letsencrypt", "private-akv"]) {
  test(`overlay-contracts: every '${overlay}' .env key has a contract role`, () => {
    const envKeys = readOverlayEnvKeys(overlay);
    const c = OVERLAY_CONTRACTS[overlay];
    const allRoles = new Set([
      ...c.userRequiredEnvKeys,
      ...c.composedEnvKeys,
      ...c.stubKeys,
      ...c.bicepOutputKeys,
    ]);
    const missing = envKeys.filter((k) => !allRoles.has(k));
    assert.deepEqual(
      missing,
      [],
      `Overlay '${overlay}' has env keys with no role in OVERLAY_CONTRACTS: ${missing.join(", ")}.`,
    );
  });
}

test("afd-akv requires SSL_CERT_DOMAIN_SUFFIX", () => {
  assert.ok(
    OVERLAY_CONTRACTS["afd-akv"].userRequiredEnvKeys.includes("SSL_CERT_DOMAIN_SUFFIX"),
    "afd-akv must require SSL_CERT_DOMAIN_SUFFIX",
  );
});

test("PORTAL_HOSTNAME is tracked as a bicep-output on all three overlays", () => {
  for (const overlay of ["afd-akv", "afd-letsencrypt", "private-akv"]) {
    assert.ok(
      OVERLAY_CONTRACTS[overlay].bicepOutputKeys.includes("PORTAL_HOSTNAME"),
      `${overlay} must list PORTAL_HOSTNAME in bicepOutputKeys`,
    );
  }
});

// === validateRequiredEnv ====================================================

test("validateRequiredEnv passes on a fully-populated afd-akv env", () => {
  const env = { SSL_CERT_DOMAIN_SUFFIX: "portal.example.com" };
  const result = validateRequiredEnv({ edgeMode: "afd", tlsSource: "akv", env });
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.combo, []);
});

test("validateRequiredEnv reports SSL_CERT_DOMAIN_SUFFIX missing on afd-akv", () => {
  const env = {};
  const { missing, combo } = validateRequiredEnv({ edgeMode: "afd", tlsSource: "akv", env });
  assert.ok(missing.includes("SSL_CERT_DOMAIN_SUFFIX"));
  assert.deepEqual(combo, []);
});

test("validateRequiredEnv reports ACME_EMAIL missing on afd-letsencrypt", () => {
  const env = {};
  const { missing } = validateRequiredEnv({
    edgeMode: "afd",
    tlsSource: "letsencrypt",
    env,
  });
  assert.ok(missing.includes("ACME_EMAIL"));
});

test("validateRequiredEnv catches malformed ACME_EMAIL", () => {
  const env = { ACME_EMAIL: "not-an-email" };
  const { missing } = validateRequiredEnv({
    edgeMode: "afd",
    tlsSource: "letsencrypt",
    env,
  });
  assert.ok(missing.includes("ACME_EMAIL"));
});

test("validateRequiredEnv requires HOST/PRIVATE_DNS_ZONE/AKS_VNET_ID for private-akv", () => {
  const env = {};
  const { missing } = validateRequiredEnv({
    edgeMode: "private",
    tlsSource: "akv",
    env,
  });
  for (const k of ["HOST", "PRIVATE_DNS_ZONE", "AKS_VNET_ID"]) {
    assert.ok(missing.includes(k), `expected ${k} missing, got ${missing.join(",")}`);
  }
});

// === applyStubKeys ==========================================================

test("applyStubKeys stamps `unused` for blank stubKeys on private-akv", () => {
  const env = {};
  applyStubKeys({ edgeMode: "private", tlsSource: "akv", env });
  for (const k of [
    "FRONT_DOOR_PROFILE_NAME",
    "APPLICATION_GATEWAY_NAME",
    "SSL_CERT_DOMAIN_SUFFIX",
    "ACME_EMAIL",
  ]) {
    assert.equal(env[k], "unused", `${k} should be stubbed`);
  }
});

test("applyStubKeys stamps `unused` for blank stubKeys on afd-akv", () => {
  const env = {};
  applyStubKeys({ edgeMode: "afd", tlsSource: "akv", env });
  for (const k of ["PRIVATE_DNS_ZONE", "AKS_VNET_ID", "ACME_EMAIL"]) {
    assert.equal(env[k], "unused", `${k} should be stubbed`);
  }
});

test("applyStubKeys does not overwrite a non-empty existing value", () => {
  const env = { ACME_EMAIL: "real@example.com" };
  applyStubKeys({ edgeMode: "afd", tlsSource: "akv", env });
  assert.equal(env.ACME_EMAIL, "real@example.com");
});

test("getContract throws for an unknown overlay key", () => {
  assert.throws(
    () => getContract({ edgeMode: "nonsense", tlsSource: "letsencrypt" }),
    /no contract for resolved overlay/,
  );
});

// FR-004: bicep tlsSource default matches the JS DEFAULT_TLS_SOURCE.
test("bicep portal main.bicep tlsSource default matches DEFAULT_TLS_SOURCE", () => {
  const bicepPath = join(
    REPO_ROOT,
    "deploy",
    "services",
    "portal",
    "bicep",
    "main.bicep",
  );
  const raw = readFileSync(bicepPath, "utf8");
  // Locate the `param tlsSource string = '<default>'` declaration.
  const m = raw.match(/param\s+tlsSource\s+string\s*=\s*'([^']+)'/);
  assert.ok(m, "tlsSource param default declaration not found in portal main.bicep");
  assert.equal(
    m[1],
    DEFAULT_TLS_SOURCE,
    `bicep tlsSource default '${m[1]}' must match overlay-contracts DEFAULT_TLS_SOURCE '${DEFAULT_TLS_SOURCE}'`,
  );
});

// === validateVpnGatewayCombo (Spec FR-001/FR-008/FR-014) ====================

const VPN_BASE_ENV = Object.freeze({
  VPN_GATEWAY_ENABLED: "true",
  SSL_CERT_DOMAIN_SUFFIX: "portal.example.com",
  VPN_CLIENT_ADDRESS_POOL: "172.16.200.0/24",
  AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000000",
});

test("validateVpnGatewayCombo: disabled (unset) → empty regardless of other VPN env", () => {
  const env = {
    EDGE_MODE: "private",
    TLS_SOURCE: "letsencrypt",
    VPN_CLIENT_ADDRESS_POOL: "10.20.50.0/24", // would overlap default VNet
  };
  assert.deepEqual(
    validateVpnGatewayCombo({ edgeMode: "private", tlsSource: "letsencrypt", env }),
    [],
  );
});

test("validateVpnGatewayCombo: disabled (literal 'false') → empty", () => {
  const env = { ...VPN_BASE_ENV, VPN_GATEWAY_ENABLED: "false" };
  assert.deepEqual(
    validateVpnGatewayCombo({ edgeMode: "private", tlsSource: "letsencrypt", env }),
    [],
  );
});

test("validateVpnGatewayCombo: valid combo (afd + akv + suffix + non-overlapping pool) → empty", () => {
  const env = { ...VPN_BASE_ENV };
  assert.deepEqual(
    validateVpnGatewayCombo({ edgeMode: "afd", tlsSource: "akv", env }),
    [],
  );
});

test("validateVpnGatewayCombo: TLS_SOURCE=letsencrypt → vpn-requires-akv", () => {
  const env = { ...VPN_BASE_ENV };
  const errs = validateVpnGatewayCombo({ edgeMode: "afd", tlsSource: "letsencrypt", env });
  assert.ok(errs.includes("vpn-requires-akv"), `got: ${errs.join(",")}`);
});

test("validateVpnGatewayCombo: EDGE_MODE=private → vpn-requires-afd", () => {
  const env = { ...VPN_BASE_ENV };
  const errs = validateVpnGatewayCombo({ edgeMode: "private", tlsSource: "akv", env });
  assert.ok(errs.includes("vpn-requires-afd"), `got: ${errs.join(",")}`);
});

test("validateVpnGatewayCombo: missing SSL_CERT_DOMAIN_SUFFIX → vpn-requires-domain-suffix", () => {
  const env = { ...VPN_BASE_ENV, SSL_CERT_DOMAIN_SUFFIX: "" };
  const errs = validateVpnGatewayCombo({ edgeMode: "afd", tlsSource: "akv", env });
  assert.ok(errs.includes("vpn-requires-domain-suffix"), `got: ${errs.join(",")}`);
});

test("validateVpnGatewayCombo: overlapping pool (10.20.50.0/24 inside default 10.20.0.0/16) → vpn-pool-overlap", () => {
  const env = { ...VPN_BASE_ENV, VPN_CLIENT_ADDRESS_POOL: "10.20.50.0/24" };
  const errs = validateVpnGatewayCombo({ edgeMode: "afd", tlsSource: "akv", env });
  assert.ok(errs.includes("vpn-pool-overlap"), `got: ${errs.join(",")}`);
});

test("validateVpnGatewayCombo: non-overlapping pool (172.16.200.0/24) → no overlap error", () => {
  const env = { ...VPN_BASE_ENV };
  const errs = validateVpnGatewayCombo({ edgeMode: "afd", tlsSource: "akv", env });
  assert.ok(!errs.includes("vpn-pool-overlap"), `got: ${errs.join(",")}`);
});

test("validateVpnGatewayCombo: malformed pool CIDR → vpn-pool-overlap (fail-closed)", () => {
  const env = { ...VPN_BASE_ENV, VPN_CLIENT_ADDRESS_POOL: "not-a-cidr" };
  const errs = validateVpnGatewayCombo({ edgeMode: "afd", tlsSource: "akv", env });
  assert.ok(errs.includes("vpn-pool-overlap"), `got: ${errs.join(",")}`);
});

test("validateVpnGatewayCombo: respects VNET_CIDR override when supplied", () => {
  // If operator overrides VNET_CIDR to 10.99.0.0/16, the default-pool
  // 172.16.200.0/24 still doesn't overlap. Sanity: 10.99.50.0/24 would.
  const env = { ...VPN_BASE_ENV, VNET_CIDR: "10.99.0.0/16", VPN_CLIENT_ADDRESS_POOL: "10.99.50.0/24" };
  const errs = validateVpnGatewayCombo({ edgeMode: "afd", tlsSource: "akv", env });
  assert.ok(errs.includes("vpn-pool-overlap"), `got: ${errs.join(",")}`);
});

test("validateRequiredEnv returns vpn combo errors in a separate channel from missing[]", () => {
  // afd-akv overlay so the baseline required key (SSL_CERT_DOMAIN_SUFFIX)
  // is exercised; with VPN enabled and TLS_SOURCE=letsencrypt we'd switch
  // overlays, so use afd-akv + letsencrypt? No — overlay is resolved from
  // (edgeMode,tlsSource). Use afd-akv overlay = (afd, akv); but then the
  // VPN combo is satisfied. To get a vpn-* error through the validator
  // entrypoint, flip EDGE_MODE to 'private' and use the private-akv
  // overlay which requires HOST/PRIVATE_DNS_ZONE/AKS_VNET_ID anyway.
  const env = {
    VPN_GATEWAY_ENABLED: "true",
    SSL_CERT_DOMAIN_SUFFIX: "portal.example.com",
    AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000000",
    HOST: "h",
    PRIVATE_DNS_ZONE: "z",
    AKS_VNET_ID: "v",
  };
  const { missing, combo } = validateRequiredEnv({ edgeMode: "private", tlsSource: "akv", env });
  // Combo errors live in `combo`, NOT in `missing` — that's the contract
  // change being guarded here (regression: pre-Phase-2-followup the
  // vpn-requires-afd code was pushed onto `missing` and rendered with the
  // wrong error string + a misleading scaffolder hint).
  assert.deepEqual(missing, [], `combo errors leaked into missing[]: ${missing.join(",")}`);
  const codes = combo.map((c) => c.code);
  assert.ok(codes.includes("vpn-requires-afd"), `got: ${codes.join(",")}`);
  // Each combo entry is a {code, message, hint} object with non-empty
  // strings — guards against accidental shape drift.
  for (const e of combo) {
    assert.equal(typeof e.code, "string");
    assert.ok(e.message && typeof e.message === "string", `empty message on ${e.code}`);
    assert.ok(e.hint && typeof e.hint === "string", `empty hint on ${e.code}`);
    // The hint MUST NOT direct operators at the scaffolder — re-running
    // new-env.mjs would clobber operator edits, and the underlying problem
    // isn't an unset key, it's a bad combination of values.
    assert.ok(
      !/new-env|deploy:new-env/i.test(e.hint),
      `combo hint for ${e.code} must not point at the scaffolder: ${e.hint}`,
    );
  }
});

test("validateRequiredEnv: vpn-requires-tenant-id surfaces a hint pointing at the env file", () => {
  // IMPROVE-1: blanked AZURE_TENANT_ID with VPN enabled should fail-closed
  // pre-deploy with a clear named error, instead of falling through to
  // the bicep `param tenantId string = ''` default.
  const env = {
    VPN_GATEWAY_ENABLED: "true",
    SSL_CERT_DOMAIN_SUFFIX: "portal.example.com",
    AZURE_TENANT_ID: "   ", // whitespace-only → treated as empty
    VPN_CLIENT_ADDRESS_POOL: "172.16.200.0/24",
  };
  const { combo } = validateRequiredEnv({ edgeMode: "afd", tlsSource: "akv", env });
  const tenantErr = combo.find((c) => c.code === "vpn-requires-tenant-id");
  assert.ok(tenantErr, `expected vpn-requires-tenant-id; got: ${combo.map((c) => c.code).join(",")}`);
  assert.match(tenantErr.message, /AZURE_TENANT_ID/);
  assert.match(tenantErr.hint, /\.env/);
});

test("validateVpnGatewayCombo: missing AZURE_TENANT_ID → vpn-requires-tenant-id", () => {
  const env = { ...VPN_BASE_ENV, AZURE_TENANT_ID: "" };
  const errs = validateVpnGatewayCombo({ edgeMode: "afd", tlsSource: "akv", env });
  assert.ok(errs.includes("vpn-requires-tenant-id"), `got: ${errs.join(",")}`);
});

test("validateVpnGatewayCombo: whitespace-only AZURE_TENANT_ID → vpn-requires-tenant-id", () => {
  const env = { ...VPN_BASE_ENV, AZURE_TENANT_ID: "   " };
  const errs = validateVpnGatewayCombo({ edgeMode: "afd", tlsSource: "akv", env });
  assert.ok(errs.includes("vpn-requires-tenant-id"), `got: ${errs.join(",")}`);
});

test("VPN combo-error hints never reference the nonexistent deploy/docs/ tree", () => {
  // describeVpnComboError is a private function — scan the source as the
  // regression guard. Any reintroduction (in a hint or even a comment) of
  // a `deploy/docs/` path would be a regression: that directory doesn't
  // exist; the canonical operator doc is `docs/deploying-to-aks.md`.
  // Final-review C-1 follow-up.
  const src = readFileSync(
    join(REPO_ROOT, "deploy", "scripts", "lib", "overlay-contracts.mjs"),
    "utf8",
  );
  assert.ok(
    !src.includes("deploy/docs/"),
    "overlay-contracts.mjs still contains a deploy/docs/ reference",
  );
});

