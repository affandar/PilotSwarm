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
  const missing = validateRequiredEnv({ edgeMode: "afd", tlsSource: "akv", env });
  assert.deepEqual(missing, []);
});

test("validateRequiredEnv reports SSL_CERT_DOMAIN_SUFFIX missing on afd-akv", () => {
  const env = {};
  const missing = validateRequiredEnv({ edgeMode: "afd", tlsSource: "akv", env });
  assert.ok(missing.includes("SSL_CERT_DOMAIN_SUFFIX"));
});

test("validateRequiredEnv reports ACME_EMAIL missing on afd-letsencrypt", () => {
  const env = {};
  const missing = validateRequiredEnv({
    edgeMode: "afd",
    tlsSource: "letsencrypt",
    env,
  });
  assert.ok(missing.includes("ACME_EMAIL"));
});

test("validateRequiredEnv catches malformed ACME_EMAIL", () => {
  const env = { ACME_EMAIL: "not-an-email" };
  const missing = validateRequiredEnv({
    edgeMode: "afd",
    tlsSource: "letsencrypt",
    env,
  });
  assert.ok(missing.includes("ACME_EMAIL"));
});

test("validateRequiredEnv requires HOST/PRIVATE_DNS_ZONE/AKS_VNET_ID for private-akv", () => {
  const env = {};
  const missing = validateRequiredEnv({
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
