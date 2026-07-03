// Tests for the new-env.mjs scaffolder.
//
// Run: node --test deploy/scripts/test/new-env.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

import { renderLocalEnv, deriveTargets, INPUTS, scaffoldFoundryDeploymentsJson } from "../new-env.mjs";
import { REPO_ROOT } from "../lib/common.mjs";

const SCRIPT = join(REPO_ROOT, "deploy", "scripts", "new-env.mjs");
const LOCAL_DIR = join(REPO_ROOT, "deploy", "envs", "local");
const TEST_NAME = "scafftst";
const TEST_FILE = join(LOCAL_DIR, TEST_NAME, ".env");

function cleanup() {
  const d = join(LOCAL_DIR, TEST_NAME);
  if (existsSync(d)) rmSync(d, { recursive: true, force: true });
}

function runScript(args) {
  // Disable interactive prompts: provide all inputs via flags.
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

const FULL_ARGS = (name = TEST_NAME) => [
  name,
  "--subscription",
  "00000000-0000-0000-0000-000000000000",
  "--location",
  "westus3",
];

test("deriveTargets follows enterprise naming patterns", () => {
  const t = deriveTargets({
    name: "foo",
    subscription: "sub-id",
    location: "westus3",
    regionShort: "wus3",
  });
  assert.equal(t.RESOURCE_PREFIX, "psfoo");
  assert.equal(t.RESOURCE_GROUP, "psfoo-wus3-rg");
  assert.equal(t.GLOBAL_RESOURCE_PREFIX, "psfooglobal");
  assert.equal(t.GLOBAL_RESOURCE_GROUP, "psfooglobal");
  assert.equal(t.PORTAL_RESOURCE_NAME, "psfoo-wus3-portal");
  assert.equal(t.SUBSCRIPTION_ID, "sub-id");
  assert.equal(t.LOCATION, "westus3");
});

test("renderLocalEnv produces expected substitutions", () => {
  const targets = deriveTargets({
    name: "foo",
    subscription: "",
    location: "westus3",
    regionShort: "wus3",
  });
  const out = renderLocalEnv({ name: "foo", targets });
  assert.match(out, /^RESOURCE_PREFIX=psfoo$/m);
  assert.match(out, /^RESOURCE_GROUP=psfoo-wus3-rg$/m);
  assert.match(out, /^GLOBAL_RESOURCE_PREFIX=psfooglobal$/m);
  assert.match(out, /^GLOBAL_RESOURCE_GROUP=psfooglobal$/m);
  assert.match(out, /^PORTAL_RESOURCE_NAME=psfoo-wus3-portal$/m);
  assert.match(out, /^SUBSCRIPTION_ID=$/m);
  assert.match(out, /^LOCATION=westus3$/m);
  // Template static defaults flow through verbatim — local envs are
  // standalone (no runtime cascade).
  assert.match(out, /^NAMESPACE=pilotswarm$/m);
  assert.match(out, /^AZURE_TENANT_ID=72f988bf-86f1-41af-91ab-2d7cd011db47$/m);
  assert.match(out, /^EDGE_MODE=afd$/m);
  assert.match(out, /^TLS_SOURCE=letsencrypt$/m);
});

test("scaffolder creates local/<name>/.env (happy path)", () => {
  cleanup();
  try {
    const r = runScript(FULL_ARGS());
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.ok(existsSync(TEST_FILE));
    const content = readFileSync(TEST_FILE, "utf8");
    assert.match(content, /^RESOURCE_PREFIX=psscafftst$/m);
    assert.match(content, /^RESOURCE_GROUP=psscafftst-wus3-rg$/m);
    assert.match(content, /^GLOBAL_RESOURCE_PREFIX=psscafftstglobal$/m);
    assert.match(content, /^SUBSCRIPTION_ID=00000000-0000-0000-0000-000000000000$/m);
  } finally {
    cleanup();
  }
});

test("scaffolder refuses to overwrite without --force", () => {
  cleanup();
  try {
    mkdirSync(dirname(TEST_FILE), { recursive: true });
    writeFileSync(TEST_FILE, "EXISTING=1\n", "utf8");
    const r = runScript(FULL_ARGS());
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Refusing to overwrite/);
    assert.equal(readFileSync(TEST_FILE, "utf8"), "EXISTING=1\n");
  } finally {
    cleanup();
  }
});

test("scaffolder overwrites with --force", () => {
  cleanup();
  try {
    mkdirSync(dirname(TEST_FILE), { recursive: true });
    writeFileSync(TEST_FILE, "EXISTING=1\n", "utf8");
    const r = runScript([...FULL_ARGS(), "--force"]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const content = readFileSync(TEST_FILE, "utf8");
    assert.match(content, /^RESOURCE_PREFIX=psscafftst$/m);
    assert.doesNotMatch(content, /EXISTING=1/);
  } finally {
    cleanup();
  }
});

test("scaffolder rejects reserved names", () => {
  for (const r of ["dev", "prod"]) {
    const proc = runScript(FULL_ARGS(r));
    assert.notEqual(proc.status, 0);
    assert.match(proc.stderr, /reserved env name/);
  }
});

test("scaffolder rejects invalid names", () => {
  for (const bad of ["1abc", "Foo", "foo-bar", "foo_bar", "x123456789012"]) {
    const proc = runScript(FULL_ARGS(bad));
    assert.notEqual(proc.status, 0);
    assert.match(proc.stderr, /Invalid env name/);
  }
});

test("scaffolder errors on unknown location without --region-short", () => {
  cleanup();
  const proc = runScript([
    TEST_NAME,
    "--subscription",
    "00000000-0000-0000-0000-000000000000",
    "--location",
    "antarcticasouth",
  ]);
  assert.notEqual(proc.status, 0);
  assert.match(proc.stderr, /region-short is required/);
});

test("scaffolder accepts explicit --region-short for unknown location", () => {
  cleanup();
  try {
    const r = runScript([
      TEST_NAME,
      "--subscription",
      "00000000-0000-0000-0000-000000000000",
      "--location",
      "antarcticasouth",
      "--region-short",
      "ans",
    ]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const content = readFileSync(TEST_FILE, "utf8");
    assert.match(content, /^LOCATION=antarcticasouth$/m);
    assert.match(content, /^RESOURCE_GROUP=psscafftst-ans-rg$/m);
    assert.match(content, /^PORTAL_RESOURCE_NAME=psscafftst-ans-portal$/m);
  } finally {
    cleanup();
  }
});

test("scaffolder warns about empty operator-required keys (FR-003 warn-and-continue)", () => {
  // afd-letsencrypt overlay requires ACME_EMAIL. FULL_ARGS provides
  // --subscription and --location but not --acme-email, so the scaffolder
  // must warn (not throw) and still write the .env. Authoritative hard-gate
  // is deploy.mjs:validateRequiredEnv at deploy time.
  cleanup();
  try {
    const r = runScript(FULL_ARGS());
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const out = `${r.stdout}\n${r.stderr}`;
    assert.match(
      out,
      /empty required keys[^]*ACME_EMAIL/,
      `expected ACME_EMAIL warning in scaffolder output:\n${out}`,
    );
    assert.match(
      out,
      /Hand-edit deploy\/envs\/local\/scafftst\/\.env/,
      `expected fix-it hint pointing at the .env path:\n${out}`,
    );
    assert.ok(existsSync(TEST_FILE), "scaffolder must still write .env after warn");
  } finally {
    cleanup();
  }
});

test("scaffolder does NOT warn when operator-required keys are provided", () => {
  cleanup();
  try {
    const r = runScript([...FULL_ARGS(), "--acme-email", "ops@example.com"]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const out = `${r.stdout}\n${r.stderr}`;
    assert.doesNotMatch(
      out,
      /empty required keys/,
      `did not expect empty-keys warning when ACME_EMAIL is set:\n${out}`,
    );
  } finally {
    cleanup();
  }
});

test("scaffolder shows usage with --help", () => {
  const r = runScript(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage: npm run deploy:new-env --/);
});

test("INPUTS schema covers every CLI flag rendered in --help", () => {
  // Regression guard: usage() and parseArgs both iterate INPUTS, so a missing
  // schema entry would silently drop both surfaces. Verify every --flag in
  // --help output corresponds to an INPUTS entry (or the boolean FLAGS list).
  const r = runScript(["--help"]);
  assert.equal(r.status, 0);
  const flagsInHelp = [...r.stdout.matchAll(/^\s+(--[a-z][a-z-]*)/gm)].map((m) => m[1]);
  const inputFlags = INPUTS.map((i) => i.flag).filter(Boolean);
  for (const f of inputFlags) {
    assert.ok(flagsInHelp.includes(f), `--help is missing schema flag ${f}`);
  }
  // Every input has the minimal required schema fields and either declares
  // a prompt (declarative) or supplies a custom `interactive` override.
  for (const i of INPUTS) {
    assert.ok(i.argKey, "INPUTS entry missing argKey");
    assert.ok(i.help, `INPUTS entry ${i.argKey} missing help`);
    const isDeclarative = typeof i.prompt === "string";
    const isImperative = typeof i.interactive === "function";
    assert.ok(
      isDeclarative || isImperative,
      `${i.argKey} must define either a string \`prompt\` or an \`interactive\` override`,
    );
  }
});

test("deriveTargets foundryEnabled=y populates FOUNDRY_* keys", () => {
  const t = deriveTargets({
    name: "foo",
    location: "westus3",
    regionShort: "wus3",
    foundryEnabled: "y",
  });
  assert.equal(t.FOUNDRY_ENABLED, "true");
  assert.equal(t.FOUNDRY_DEPLOYMENTS_FILE, "deploy/envs/local/foo/foundry-deployments.json");
});

test("deriveTargets foundryEnabled=n leaves FOUNDRY_DEPLOYMENTS_FILE empty", () => {
  const t = deriveTargets({
    name: "foo",
    location: "westus3",
    regionShort: "wus3",
    foundryEnabled: "n",
  });
  assert.equal(t.FOUNDRY_ENABLED, "false");
  assert.equal(t.FOUNDRY_DEPLOYMENTS_FILE, "");
});

test("scaffolder writes foundry-deployments.json when --foundry-enabled=y", () => {
  cleanup();
  try {
    const r = runScript([...FULL_ARGS(), "--foundry-enabled", "y"]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const foundryPath = join(LOCAL_DIR, TEST_NAME, "foundry-deployments.json");
    assert.ok(existsSync(foundryPath), "foundry-deployments.json should be scaffolded");
    const body = readFileSync(foundryPath, "utf8");
    // Must be valid JSON (az parses it as @file param).
    const parsed = JSON.parse(body);
    assert.ok(Array.isArray(parsed), "scaffolded contents must be a JSON array");
  } finally {
    cleanup();
  }
});

test("scaffolder skips foundry-deployments.json when --foundry-enabled=n", () => {
  cleanup();
  try {
    const r = runScript([...FULL_ARGS(), "--foundry-enabled", "n"]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const foundryPath = join(LOCAL_DIR, TEST_NAME, "foundry-deployments.json");
    assert.ok(!existsSync(foundryPath), "foundry file must not be written when disabled");
  } finally {
    cleanup();
  }
});

test("scaffoldFoundryDeploymentsJson emits an entry per preferred model offered in the region", () => {
  const availableModels = [
    { model: { format: "OpenAI", name: "gpt-5", version: "2025-08-07" } },
    { model: { format: "OpenAI", name: "gpt-5-mini", version: "2024-07-18" } },
    { model: { format: "OpenAI", name: "gpt-5-mini", version: "2025-08-07" } },
    // gpt-5-nano deliberately not offered → must be skipped, not emitted
    { model: { format: "OpenAI", name: "irrelevant", version: "2099-01-01" } },
  ];
  const body = scaffoldFoundryDeploymentsJson({ availableModels });
  const arr = JSON.parse(body);
  assert.ok(Array.isArray(arr));
  const names = arr.map((e) => e.name).sort();
  assert.deepEqual(names, ["gpt-5", "gpt-5-mini"]);
  // Picks the latest available version for each model
  const mini = arr.find((e) => e.name === "gpt-5-mini");
  assert.equal(mini.model.version, "2025-08-07");
  // Sku shape is preserved
  assert.equal(mini.sku.name, "GlobalStandard");
  assert.equal(typeof mini.sku.capacity, "number");
});

test("scaffoldFoundryDeploymentsJson returns an empty array when catalog lookup failed", () => {
  // Caller passes null when az is unavailable
  const body = scaffoldFoundryDeploymentsJson({ availableModels: null });
  assert.deepEqual(JSON.parse(body), []);
});

test("scaffoldFoundryDeploymentsJson returns an empty array when no preferred models are offered", () => {
  const availableModels = [
    { model: { format: "OpenAI", name: "some-other-model", version: "2099-01-01" } },
  ];
  const body = scaffoldFoundryDeploymentsJson({ availableModels });
  assert.deepEqual(JSON.parse(body), []);
});

test("deriveTargets composes PORTAL_HOSTNAME from HOST + PRIVATE_DNS_ZONE in private mode", () => {
  const t = deriveTargets({
    name: "foo",
    location: "westus3",
    regionShort: "wus3",
    edgeMode: "private",
    host: "portal",
    privateDnsZone: "pilotswarm.internal",
    tlsSource: "akv-selfsigned",
  });
  assert.equal(t.EDGE_MODE, "private");
  assert.equal(t.HOST, "portal");
  assert.equal(t.PRIVATE_DNS_ZONE, "pilotswarm.internal");
  assert.equal(t.PORTAL_HOSTNAME, "portal.pilotswarm.internal");
  assert.equal(t.TLS_SOURCE, "akv-selfsigned");
});

test("deriveTargets leaves PORTAL_HOSTNAME empty in afd mode (bicep derives it)", () => {
  const t = deriveTargets({
    name: "foo",
    location: "westus3",
    regionShort: "wus3",
    edgeMode: "afd",
    tlsSource: "letsencrypt",
  });
  assert.equal(t.EDGE_MODE, "afd");
  assert.equal(t.HOST, "");
  assert.equal(t.PRIVATE_DNS_ZONE, "");
  assert.equal(t.PORTAL_HOSTNAME, "");
});

test("scaffolder rejects unsupported combo afd + akv-selfsigned non-interactively", () => {
  const r = runScript([
    ...FULL_ARGS(),
    "--edge-mode", "afd",
    "--tls-source", "akv-selfsigned",
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unsupported combination edge-mode=afd \+ tls-source=akv-selfsigned/);
});

test("scaffolder rejects unsupported combo private + letsencrypt non-interactively", () => {
  const r = runScript([
    ...FULL_ARGS(),
    "--edge-mode", "private",
    "--tls-source", "letsencrypt",
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unsupported combination edge-mode=private \+ tls-source=letsencrypt/);
});

test("scaffolder accepts private + akv-selfsigned with HOST and PRIVATE_DNS_ZONE", () => {
  cleanup();
  try {
    const r = runScript([
      ...FULL_ARGS(),
      "--edge-mode", "private",
      "--tls-source", "akv-selfsigned",
      "--host", "portal",
      "--private-dns-zone", "pilotswarm.internal",
    ]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const content = readFileSync(TEST_FILE, "utf8");
    assert.match(content, /^EDGE_MODE=private$/m);
    assert.match(content, /^TLS_SOURCE=akv-selfsigned$/m);
    assert.match(content, /^HOST=portal$/m);
    assert.match(content, /^PRIVATE_DNS_ZONE=pilotswarm\.internal$/m);
    assert.match(content, /^PORTAL_HOSTNAME=portal\.pilotswarm\.internal$/m);
  } finally {
    cleanup();
  }
});

// ─── VPN Gateway P2S scaffolder UX ────────────────────────────────────────
//
// VPN questions are asked only after edge/tls have been selected. The
// declarative INPUTS pipeline drives the prompts; a hard combo gate in
// main() refuses with a named error before any .env is written when the
// requested edge/tls combo is incompatible with VPN. CIDR-overlap checks
// reuse validateVpnGatewayCombo (no duplicated arithmetic).
//
// VPN_GATEWAY_SKU and VPN_AAD_AUDIENCE are NOT prompted — they flow
// through unchanged from template.env defaults (VpnGw2AZ, c632b3df-...).
// The unsupported keys VPN_AAD_TENANT_ID, VPN_PRIVATE_DNS_MODE,
// PRIVATE_DNS_ZONE_ID, VPN_AAD_USERS_GROUP_NAME_HINT must NEVER be emitted.

test("deriveTargets emits VPN_GATEWAY_ENABLED=true with custom pool when vpnEnabled=y", () => {
  const t = deriveTargets({
    name: "foo",
    location: "westus3",
    regionShort: "wus3",
    edgeMode: "afd",
    tlsSource: "akv",
    vpnEnabled: "y",
    vpnClientAddressPool: "172.16.222.0/24",
  });
  assert.equal(t.VPN_GATEWAY_ENABLED, "true");
  assert.equal(t.VPN_CLIENT_ADDRESS_POOL, "172.16.222.0/24");
  // SKU and AAD audience are NOT in deriveTargets' return — they flow
  // from template.env so the operator gets the documented defaults.
  assert.ok(!("VPN_GATEWAY_SKU" in t), "VPN_GATEWAY_SKU must come from template.env");
  assert.ok(!("VPN_AAD_AUDIENCE" in t), "VPN_AAD_AUDIENCE must come from template.env");
  // Dropped-from-spec keys must never be threaded.
  for (const dropped of [
    "VPN_AAD_TENANT_ID",
    "VPN_PRIVATE_DNS_MODE",
    "PRIVATE_DNS_ZONE_ID",
    "VPN_AAD_USERS_GROUP_NAME_HINT",
  ]) {
    assert.ok(!(dropped in t), `${dropped} was dropped from the spec — must not be emitted`);
  }
});

test("deriveTargets emits VPN_GATEWAY_ENABLED=false and omits pool override when vpnEnabled=n", () => {
  const t = deriveTargets({
    name: "foo",
    location: "westus3",
    regionShort: "wus3",
    vpnEnabled: "n",
  });
  assert.equal(t.VPN_GATEWAY_ENABLED, "false");
  assert.ok(!("VPN_CLIENT_ADDRESS_POOL" in t),
    "pool override should be omitted when VPN is disabled (template default flows through)");
});

test("scaffolder writes VPN keys at expected defaults on afd+akv with --vpn-enabled y", () => {
  cleanup();
  try {
    const r = runScript([
      ...FULL_ARGS(),
      "--edge-mode", "afd",
      "--tls-source", "akv",
      "--vpn-enabled", "y",
    ]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const content = readFileSync(TEST_FILE, "utf8");
    // Two prompted keys land at their defaults.
    assert.match(content, /^VPN_GATEWAY_ENABLED=true$/m);
    assert.match(content, /^VPN_CLIENT_ADDRESS_POOL=172\.16\.200\.0\/24$/m);
    // Two template-default keys flow through verbatim.
    assert.match(content, /^VPN_GATEWAY_SKU=VpnGw2AZ\b/m);
    assert.match(content, /^VPN_AAD_AUDIENCE=c632b3df-fb67-4d84-bdcf-b95ad541b5c8\b/m);
    // Dropped-from-spec keys must NOT be present.
    for (const dropped of [
      "VPN_AAD_TENANT_ID",
      "VPN_PRIVATE_DNS_MODE",
      "PRIVATE_DNS_ZONE_ID",
      "VPN_AAD_USERS_GROUP_NAME_HINT",
    ]) {
      assert.doesNotMatch(content, new RegExp(`^${dropped}=`, "m"),
        `${dropped} was dropped from the spec but appeared in scaffolded .env`);
    }
  } finally {
    cleanup();
  }
});

test("scaffolder refuses VPN on afd+letsencrypt with a named [vpn-incompatible-combo] error", () => {
  cleanup();
  try {
    const r = runScript([
      ...FULL_ARGS(),
      "--edge-mode", "afd",
      "--tls-source", "letsencrypt",
      "--vpn-enabled", "y",
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /\[vpn-incompatible-combo\]/);
    assert.match(r.stderr, /TLS_SOURCE must be 'akv'/);
    // Hard refusal: no .env written.
    assert.ok(!existsSync(TEST_FILE), "scaffolder must not write .env when VPN combo is rejected");
  } finally {
    cleanup();
  }
});

test("scaffolder refuses VPN on private+akv with a named [vpn-incompatible-combo] error", () => {
  cleanup();
  try {
    const r = runScript([
      ...FULL_ARGS(),
      "--edge-mode", "private",
      "--tls-source", "akv",
      "--host", "portal",
      "--private-dns-zone", "pilotswarm.internal",
      "--vpn-enabled", "y",
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /\[vpn-incompatible-combo\]/);
    assert.match(r.stderr, /EDGE_MODE must be 'afd'/);
    assert.ok(!existsSync(TEST_FILE), "scaffolder must not write .env when VPN combo is rejected");
  } finally {
    cleanup();
  }
});

test("scaffolder accepts a custom non-overlapping VPN_CLIENT_ADDRESS_POOL", () => {
  cleanup();
  try {
    const r = runScript([
      ...FULL_ARGS(),
      "--edge-mode", "afd",
      "--tls-source", "akv",
      "--vpn-enabled", "y",
      "--vpn-client-address-pool", "192.168.99.0/24",
    ]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const content = readFileSync(TEST_FILE, "utf8");
    assert.match(content, /^VPN_GATEWAY_ENABLED=true$/m);
    assert.match(content, /^VPN_CLIENT_ADDRESS_POOL=192\.168\.99\.0\/24$/m);
  } finally {
    cleanup();
  }
});

test("scaffolder rejects an overlapping VPN_CLIENT_ADDRESS_POOL with a pool-overlap error", () => {
  cleanup();
  try {
    // Default VNet CIDR is 10.20.0.0/16; this /24 sits inside it.
    const r = runScript([
      ...FULL_ARGS(),
      "--edge-mode", "afd",
      "--tls-source", "akv",
      "--vpn-enabled", "y",
      "--vpn-client-address-pool", "10.20.50.0/24",
    ]);
    assert.notEqual(r.status, 0);
    const out = `${r.stdout}\n${r.stderr}`;
    assert.match(
      out,
      /VPN_CLIENT_ADDRESS_POOL .*overlaps the stamp VNet CIDR/,
      `expected pool-overlap error in scaffolder output:\n${out}`,
    );
    assert.ok(!existsSync(TEST_FILE), "scaffolder must not write .env when pool overlaps VNet");
  } finally {
    cleanup();
  }
});

test("scaffolder emits the post-scaffold VPN reminder block on success", () => {
  cleanup();
  try {
    const r = runScript([
      ...FULL_ARGS(),
      "--edge-mode", "afd",
      "--tls-source", "akv",
      "--vpn-enabled", "y",
    ]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const out = `${r.stdout}\n${r.stderr}`;
    // Reminder header is unmistakable.
    assert.match(out, /VPN Gateway P2S — required out-of-band setup/);
    // CA policy: target app id, named-users-group, MFA, do-not-require-compliance.
    assert.match(out, /c632b3df-fb67-4d84-bdcf-b95ad541b5c8/);
    assert.match(out, /Conditional Access/i);
    assert.match(out, /NAMED users group/);
    assert.match(out, /require MFA/);
    assert.match(out, /do NOT require device compliance/);
    // Legacy audience override.
    assert.match(out, /41b23e61-6c1e-4545-b367-cd054e0ed4b4/);
    // Cost + time disclosure.
    assert.match(out, /\$450\/month/);
    assert.match(out, /Private DNS Resolver/);
    assert.match(out, /45\+ minutes/);
    // Docs pointer (referenced by section name in the AKS deploy guide).
    assert.match(out, /docs\/developer\/deploy\/aks\.md/);
    assert.match(out, /Optional: VPN Gateway P2S/);
  } finally {
    cleanup();
  }
});

test("scaffolder VPN=no path emits no VPN reminder block (regression guard)", () => {
  cleanup();
  try {
    // Default for --vpn-enabled is n; we still pass it explicitly to make
    // intent obvious to future readers.
    const r = runScript([...FULL_ARGS(), "--vpn-enabled", "n"]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const out = `${r.stdout}\n${r.stderr}`;
    assert.doesNotMatch(out, /VPN Gateway P2S — required out-of-band setup/);
    assert.doesNotMatch(out, /Conditional Access/);
    const content = readFileSync(TEST_FILE, "utf8");
    // Template default carries through unchanged.
    assert.match(content, /^VPN_GATEWAY_ENABLED=false$/m);
  } finally {
    cleanup();
  }
});

// ─── yes/true normalisation drift ────────────────────────────────────────
//
// Regression guard: --vpn-enabled accepts y|yes|true (and JS boolean true
// from programmatic callers), but deriveTargets() previously only
// honoured literal "y" / boolean true, so `--vpn-enabled yes` and
// `--vpn-enabled true` silently scaffolded VPN_GATEWAY_ENABLED=false with
// no reminder. main() and deriveTargets()
// must agree, via normaliseYesNo(), on every yes/no input.

for (const truthy of ["yes", "true"]) {
  test(`scaffolder --vpn-enabled ${truthy} enables VPN and emits the reminder block`, () => {
    cleanup();
    try {
      const r = runScript([
        ...FULL_ARGS(),
        "--edge-mode", "afd",
        "--tls-source", "akv",
        "--vpn-enabled", truthy,
      ]);
      assert.equal(r.status, 0, r.stderr || r.stdout);
      const content = readFileSync(TEST_FILE, "utf8");
      assert.match(content, /^VPN_GATEWAY_ENABLED=true$/m,
        `--vpn-enabled ${truthy} must scaffold VPN_GATEWAY_ENABLED=true`);
      const out = `${r.stdout}\n${r.stderr}`;
      assert.match(out, /VPN Gateway P2S — required out-of-band setup/,
        `--vpn-enabled ${truthy} must emit the post-scaffold reminder block`);
    } finally {
      cleanup();
    }
  });
}

test("deriveTargets honours boolean vpnEnabled=true (programmatic callers)", () => {
  const t = deriveTargets({
    name: "foo",
    location: "westus3",
    regionShort: "wus3",
    vpnEnabled: true,
    vpnClientAddressPool: "172.16.222.0/24",
  });
  assert.equal(t.VPN_GATEWAY_ENABLED, "true");
  assert.equal(t.VPN_CLIENT_ADDRESS_POOL, "172.16.222.0/24");
});

test("deriveTargets honours string 'yes' / 'true' for vpnEnabled (CLI normalisation)", () => {
  for (const v of ["yes", "true", "YES"]) {
    const t = deriveTargets({
      name: "foo",
      location: "westus3",
      regionShort: "wus3",
      vpnEnabled: v,
    });
    assert.equal(t.VPN_GATEWAY_ENABLED, "true",
      `vpnEnabled='${v}' must yield VPN_GATEWAY_ENABLED=true`);
  }
});

test("deriveTargets honours boolean foundryEnabled=true and string 'yes' (audit fix)", () => {
  // Sister-key normalisation audit: foundryEnabled exhibited the same
  // drift as vpnEnabled. Both now route through normaliseYesNo().
  for (const v of [true, "yes", "true", "y", "YES"]) {
    const t = deriveTargets({
      name: "foo",
      location: "westus3",
      regionShort: "wus3",
      foundryEnabled: v,
    });
    assert.equal(t.FOUNDRY_ENABLED, "true",
      `foundryEnabled='${v}' must yield FOUNDRY_ENABLED=true`);
    assert.equal(t.FOUNDRY_DEPLOYMENTS_FILE, "deploy/envs/local/foo/foundry-deployments.json");
  }
});

// ─── Reminder block: VPN client profile download ─────────────────────────

test("VPN reminder block includes Azure portal download path for VPN client profile", () => {
  cleanup();
  try {
    const r = runScript([
      ...FULL_ARGS(),
      "--edge-mode", "afd",
      "--tls-source", "akv",
      "--vpn-enabled", "y",
    ]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const out = `${r.stdout}\n${r.stderr}`;
    // Portal navigation path: Resource group → <gateway> → Point-to-site → Download.
    assert.match(out, /VPN client profile/i);
    assert.match(out, /Resource group/);
    assert.match(out, /Point-to-site configuration/);
    assert.match(out, /Download VPN client/);
    // CLI alternative is documented for scriptability (the supported subcommand is
    // `vpn-client generate --authentication-method EAPTLS`; the helper script in
    // deploy/scripts/auth/Get-VpnClientProfile.ps1 is the preferred path).
    assert.match(out, /Get-VpnClientProfile\.ps1/);
    assert.match(out, /az network vnet-gateway vpn-client generate\b/);
    assert.match(out, /--authentication-method EAPTLS/);
  } finally {
    cleanup();
  }
});

// ─── INPUTS prompt-order placement ───────────────────────────────────────
//
// vpnEnabled / vpnClientAddressPool must come immediately after tlsSource
// so the [vpn-incompatible-combo] gate fires before any secret prompts.
// Previously they sat at the end of INPUTS, which let the operator type
// secrets only to be refused after.

test("INPUTS places vpnEnabled / vpnClientAddressPool immediately after tlsSource", () => {
  const order = INPUTS.map((i) => i.argKey);
  const tlsIdx = order.indexOf("tlsSource");
  const vpnIdx = order.indexOf("vpnEnabled");
  const poolIdx = order.indexOf("vpnClientAddressPool");
  assert.ok(tlsIdx >= 0, "tlsSource must exist in INPUTS");
  assert.equal(vpnIdx, tlsIdx + 1,
    "vpnEnabled must immediately follow tlsSource so the combo gate fires before secrets");
  assert.equal(poolIdx, tlsIdx + 2,
    "vpnClientAddressPool must immediately follow vpnEnabled");
  // And both must come BEFORE foundryEnabled / host / acmeEmail (which
  // are downstream of the early gate).
  const downstreamKeys = ["host", "privateDnsZone", "portalHostname", "acmeEmail", "foundryEnabled"];
  for (const k of downstreamKeys) {
    const idx = order.indexOf(k);
    if (idx >= 0) {
      assert.ok(idx > poolIdx, `${k} must come after vpnClientAddressPool, got ${idx} <= ${poolIdx}`);
    }
  }
});

// ─── Help/error wording — akv-only ───────────────────────────────────────

test("--vpn-enabled help text does not advertise akv-selfsigned as compatible", () => {
  const vpn = INPUTS.find((i) => i.argKey === "vpnEnabled");
  assert.ok(vpn, "vpnEnabled INPUT must exist");
  const helpText = Array.isArray(vpn.help) ? vpn.help.join(" ") : String(vpn.help ?? "");
  assert.doesNotMatch(helpText, /akv-selfsigned/,
    "spec mandates TLS_SOURCE=akv only; akv-selfsigned must not appear in VPN help text");
  const yDesc = vpn.choiceDescriptions?.y ?? "";
  assert.doesNotMatch(yDesc, /akv\*/,
    "menu choice description must not use akv* (which suggested akv|akv-selfsigned)");
  assert.doesNotMatch(yDesc, /akv-selfsigned/);
});

test("[vpn-incompatible-combo] error wording does not allow akv-selfsigned", () => {
  cleanup();
  try {
    // akv-selfsigned forces edge-mode=private (per unsupportedReason),
    // so we exercise the akv-selfsigned-incompatible path explicitly.
    const r = runScript([
      ...FULL_ARGS(),
      "--edge-mode", "private",
      "--host", "portal",
      "--private-dns-zone", "pilotswarm.internal",
      "--tls-source", "akv-selfsigned",
      "--vpn-enabled", "y",
    ]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /\[vpn-incompatible-combo\]/);
    // Must NOT advertise akv-selfsigned as a way to satisfy the gate.
    assert.doesNotMatch(r.stderr, /akv-selfsigned\)/,
      "error message must not say '(or akv-selfsigned)' — spec mandates akv only");
    assert.doesNotMatch(r.stderr, /'akv' or 'akv-selfsigned'/,
      "error message must not list akv-selfsigned as an acceptable TLS_SOURCE for VPN");
  } finally {
    cleanup();
  }
});

// ─── SSL_CERT_DOMAIN_SUFFIX prompt (akv + VPN) ────────────────────────────
//
// SSL_CERT_DOMAIN_SUFFIX is userRequired on the afd-akv overlay (cert
// subject = <resourceName>.<suffix>) AND is consumed by the VPN combo
// gate as the managed Private DNS zone name. The scaffolder prompts for
// it whenever tlsSource=akv so operators don't have to hand-edit the
// .env between scaffold and deploy.

test("--ssl-cert-domain-suffix flows through to SSL_CERT_DOMAIN_SUFFIX in scaffolded .env", () => {
  cleanup();
  try {
    const r = runScript([
      ...FULL_ARGS(),
      "--edge-mode", "afd",
      "--tls-source", "akv",
      "--ssl-cert-domain-suffix", "dev.example.com",
    ]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const content = readFileSync(TEST_FILE, "utf8");
    assert.match(content, /^SSL_CERT_DOMAIN_SUFFIX=dev\.example\.com$/m);
  } finally {
    cleanup();
  }
});

test("--ssl-cert-domain-suffix INPUT has lowercase transform (validates interactive UX)", () => {
  const ssl = INPUTS.find((i) => i.argKey === "sslCertDomainSuffix");
  assert.ok(ssl, "sslCertDomainSuffix INPUT must exist");
  assert.equal(ssl.transform, "lowercase",
    "interactive prompt should lowercase free-form input (matches host/privateDnsZone)");
});

test("--ssl-cert-domain-suffix flows through on afd+akv+VPN combo", () => {
  cleanup();
  try {
    const r = runScript([
      ...FULL_ARGS(),
      "--edge-mode", "afd",
      "--tls-source", "akv",
      "--vpn-enabled", "y",
      "--ssl-cert-domain-suffix", "stamp.contoso.test",
    ]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const content = readFileSync(TEST_FILE, "utf8");
    assert.match(content, /^SSL_CERT_DOMAIN_SUFFIX=stamp\.contoso\.test$/m);
    // VPN is also enabled — the suffix doubles as the managed Private
    // DNS zone name. Both must coexist in the rendered .env.
    assert.match(content, /^VPN_GATEWAY_ENABLED=true$/m);
  } finally {
    cleanup();
  }
});

test("scaffolder warns when tlsSource=akv but no --ssl-cert-domain-suffix is supplied", () => {
  cleanup();
  try {
    // Non-interactive run without the new flag — promptIf is gated on
    // tlsSource=akv but readline is closed, so the value lands empty.
    // Contract validation in main() must warn (not throw) so the
    // operator gets a .env they can fix by hand if needed. deploy.mjs
    // is the hard gate.
    const r = runScript([
      ...FULL_ARGS(),
      "--edge-mode", "afd",
      "--tls-source", "akv",
    ]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const out = `${r.stdout}\n${r.stderr}`;
    assert.match(out, /SSL_CERT_DOMAIN_SUFFIX/,
      "scaffolder must warn that SSL_CERT_DOMAIN_SUFFIX is unset for tlsSource=akv");
    const content = readFileSync(TEST_FILE, "utf8");
    // Template default flows through unchanged (empty).
    assert.match(content, /^SSL_CERT_DOMAIN_SUFFIX=$/m);
  } finally {
    cleanup();
  }
});

test("scaffolder does NOT prompt for ssl-cert-domain-suffix on tlsSource=letsencrypt", () => {
  cleanup();
  try {
    const r = runScript([
      ...FULL_ARGS(),
      "--edge-mode", "afd",
      "--tls-source", "letsencrypt",
      "--acme-email", "ops@example.com",
    ]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const content = readFileSync(TEST_FILE, "utf8");
    // On afd-letsencrypt the overlay contract stubs SSL_CERT_DOMAIN_SUFFIX
    // to "unused" — that's a deploy-time concern, not a scaffolder one.
    // The key point is that the scaffolder did not prompt for it (which
    // would have stalled the non-interactive run waiting for input).
    assert.match(content, /^SSL_CERT_DOMAIN_SUFFIX=unused$/m);
    // No warning about a missing suffix — letsencrypt doesn't consume it.
    const out = `${r.stdout}\n${r.stderr}`;
    assert.doesNotMatch(out, /requires SSL_CERT_DOMAIN_SUFFIX/);
  } finally {
    cleanup();
  }
});

test("--ssl-cert-domain-suffix INPUT is gated on tlsSource=akv (promptIf)", () => {
  const ssl = INPUTS.find((i) => i.argKey === "sslCertDomainSuffix");
  assert.ok(ssl, "sslCertDomainSuffix INPUT must exist");
  assert.ok(typeof ssl.promptIf === "function", "sslCertDomainSuffix must be gated by promptIf");
  assert.equal(ssl.promptIf({ tlsSource: "akv" }), true);
  assert.equal(ssl.promptIf({ tlsSource: "letsencrypt" }), false);
  assert.equal(ssl.promptIf({ tlsSource: "akv-selfsigned" }), false);
});
