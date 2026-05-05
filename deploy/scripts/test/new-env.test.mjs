// Tests for the new-env.mjs scaffolder.
//
// Run: node --test deploy/scripts/test/new-env.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

import { renderLocalEnv, deriveTargets, INPUTS } from "../new-env.mjs";
import { REPO_ROOT } from "../lib/common.mjs";

const SCRIPT = join(REPO_ROOT, "deploy", "scripts", "new-env.mjs");
const LOCAL_DIR = join(REPO_ROOT, "deploy", "envs", "local");
const TEST_NAME = "scafftst";
const TEST_FILE = join(LOCAL_DIR, TEST_NAME, "env");

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

test("deriveTargets follows EV2 naming patterns", () => {
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

test("scaffolder creates local/<name>/env (happy path)", () => {
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
