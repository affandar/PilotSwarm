// Exercise the supported CLI with real loading, cache, Bicep rendering,
// secret seeding and manifest staging. Only external CLIs are simulated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { REPO_ROOT, parseEnvFile, templateEnvPath } from "../lib/common.mjs";
import { ALL_SEQUENCE } from "../lib/service-info.mjs";
import { renderLocalEnv } from "../new-env.mjs";

const passwordUrl = "postgresql://u:cli-fixture-password@shared.invalid/testenv?sslmode=require";
let sequence = 0;

function fixture(t, overrides = {}, { omitFlag = false, staleCache = false, kvValues = {} } = {}) {
  const name = `byo${process.pid.toString(36)}${sequence++}`;
  const dir = mkdtempSync(join(tmpdir(), "ps-deploy-byo-"));
  const local = join(REPO_ROOT, "deploy/envs/local", name);
  mkdirSync(local, { recursive: true });
  const env = {
    ...parseEnvFile(templateEnvPath()),
    SUBSCRIPTION_ID: "fixture-subscription",
    RESOURCE_PREFIX: "psfixture", RESOURCE_GROUP: "psfixture-rg",
    GLOBAL_RESOURCE_PREFIX: "psfixtureglobal", GLOBAL_RESOURCE_GROUP: "psfixtureglobal-rg",
    PORTAL_RESOURCE_NAME: "psfixture-portal", ACME_EMAIL: "test@example.invalid",
    DEPLOY_POSTGRES: "false", PILOTSWARM_USE_MANAGED_IDENTITY: "0",
    KV_NAME: "test-vault", ACR_LOGIN_SERVER: "test.azurecr.io",
    WORKLOAD_IDENTITY_CLIENT_ID: "00000000-0000-0000-0000-000000000001",
    AZURE_STORAGE_ACCOUNT_URL: "https://test.blob.core.windows.net",
    DEPLOYMENT_STORAGE_ACCOUNT_NAME: "teststorage",
    ...overrides,
  };
  for (const service of ALL_SEQUENCE) {
    const path = join(REPO_ROOT, `deploy/services/${service}/bicep/${service}.params.template.json`);
    for (const match of readFileSync(path, "utf8").matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)) {
      if (!(match[1] in env)) env[match[1]] = "fixture-output";
    }
  }
  if (omitFlag) delete env.DEPLOY_POSTGRES;
  const scaffolded = renderLocalEnv({ name, targets: env });
  writeFileSync(join(local, ".env"), omitFlag
    ? scaffolded.replace(/^DEPLOY_POSTGRES=.*\n/m, "")
    : scaffolded);
  if (staleCache) {
    const path = join(REPO_ROOT, "deploy/.tmp", name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "bicep-outputs.cache.json"), JSON.stringify({
      POSTGRES_FQDN: "old-server.invalid", POSTGRES_AAD_ADMIN_PRINCIPAL_NAME: "old-role",
    }));
  }
  const cli = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const tool = path.basename(process.argv[1]);
const option = key => args[args.indexOf(key) + 1];
const safe = args.map((a, i) => args[i - 1] === "--value" ? "<redacted>" : a);
fs.appendFileSync(process.env.BYO_CALLS, JSON.stringify({tool, args: safe}) + "\\n");
if (tool === "docker") { console.error("fixture-build-preflight"); process.exit(45); }
if (args[0] === "--version") { console.log("fixture"); process.exit(0); }
if (args[0] === "account") { console.log("fixture-subscription"); process.exit(0); }
if (args[0] === "ad") process.exit(1);
if (args[0] === "group" && args[1] === "exists") { console.log("true"); process.exit(0); }
if (args[0] === "deployment" && args[2] === "show") {
  const value = x => ({type:"String", value:x});
  console.log(JSON.stringify({
    postgresFqdn: value(""), postgresAadAdminPrincipalName: value(""),
    keyVaultName: value("test-vault"), acrLoginServer: value("test.azurecr.io"),
    csiIdentityClientId: value("00000000-0000-0000-0000-000000000001"),
    blobContainerEndpoint: value("https://test.blob.core.windows.net"),
    deploymentStorageAccountName: value("teststorage"), backendHostName: value("portal.example.invalid")
  })); process.exit(0);
}
if (args[0] === "keyvault") {
  const name = option("--name");
  const values = JSON.parse(fs.readFileSync(process.env.BYO_KV, "utf8"));
  if (args[2] === "set" && args.includes("--value")) {
    values[name] = option("--value");
    fs.writeFileSync(process.env.BYO_KV, JSON.stringify(values));
  }
  if (args[2] === "show" && !Object.hasOwn(values, name)) {
    console.error("fixture-secret-not-found"); process.exit(44);
  }
  if (args[2] === "set" && ["database-url","pilotswarm-cms-facts-database-url"].includes(option("--name"))) {
    fs.appendFileSync(process.env.BYO_VALUES, JSON.stringify({name:option("--name"), value:option("--value")}) + "\\n");
  }
  if (args.includes("--query")) {
    const version = args.includes("--version") ? option("--version") : "a".repeat(32);
    const id = "https://test-vault.vault.azure.net/secrets/" + name + "/" + version;
    console.log(option("--query") === "{id:id,value:value}" ? JSON.stringify({id, value:values[name]}) : id);
  }
  process.exit(0);
}
`;
  for (const tool of ["az", "git", "docker"]) {
    writeFileSync(join(dir, tool), cli, { mode: 0o755 });
  }
  const callsFile = join(dir, "calls.jsonl");
  const valuesFile = join(dir, "values.jsonl");
  const kvFile = join(dir, "kv.json");
  writeFileSync(callsFile, "");
  writeFileSync(valuesFile, "");
  writeFileSync(kvFile, JSON.stringify(kvValues));
  t.after(() => {
    rmSync(local, { recursive: true, force: true });
    rmSync(join(REPO_ROOT, "deploy/.tmp", name), { recursive: true, force: true });
    for (const service of ALL_SEQUENCE) rmSync(join(REPO_ROOT, "deploy/.tmp", `${service}-${name}`), { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    name,
    run(service, steps, ambient = {}) {
      return spawnSync(process.execPath, [
        join(REPO_ROOT, "deploy/scripts/deploy.mjs"), service, name,
        "--steps", steps, "--image-tag", "fixture",
      ], {
        cwd: REPO_ROOT, encoding: "utf8",
        env: {
          ...process.env, ...ambient, PATH: `${dir}${delimiter}${process.env.PATH}`,
          BYO_CALLS: callsFile, BYO_VALUES: valuesFile, BYO_KV: kvFile,
        },
      });
    },
    calls: () => readFileSync(callsFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse),
    values: () => readFileSync(valuesFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse),
    stage: service => join(REPO_ROOT, "deploy/.tmp", `${service}-${name}`),
  };
}

test("build-only dispatch reaches build preflight without database settings", (t) => {
  const f = fixture(t);
  const result = f.run("worker", "build");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /=== \[worker\] build ===/);
  assert.match(result.stderr, /Required CLI not found or not runnable: docker/);
  assert.doesNotMatch(result.stderr, /requires DATABASE_URL|PILOTSWARM_DB_AAD_USER/);
});

for (const service of ["global-infra", "base-infra"]) {
  test(`${service} --steps bicep does not require BYO runtime credentials`, (t) => {
    const f = fixture(t);
    const result = f.run(service, "bicep");
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!f.calls().some(({ args }) => args[0] === "keyvault"));
    if (service === "base-infra") {
      const params = JSON.parse(readFileSync(join(f.stage(service), "base-infra.params.json"), "utf8"));
      assert.equal(params.parameters.deployPostgres.value, false);
    }
  });
}

test("old env without DEPLOY_POSTGRES reaches Bicep with a true boolean", (t) => {
  const f = fixture(t, {}, { omitFlag: true });
  const result = f.run("base-infra", "bicep");
  assert.equal(result.status, 0, result.stderr);
  const params = JSON.parse(readFileSync(join(f.stage("base-infra"), "base-infra.params.json"), "utf8"));
  assert.equal(params.parameters.deployPostgres.value, true);
});

test("runtime manifests reject absent BYO settings before publishing", (t) => {
  const f = fixture(t);
  const result = f.run("worker", "manifests");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires DATABASE_URL and PILOTSWARM_CMS_FACTS_DATABASE_URL/);
  assert.ok(!f.calls().some(({ args }) => args.includes("upload-batch")));
});

for (const staleCache of [false, true]) {
  test(`supported all path seeds and stages BYO through real modules (${staleCache ? "stale cache" : "fresh"})`, (t) => {
    const f = fixture(t, {
      DATABASE_URL: passwordUrl, PILOTSWARM_CMS_FACTS_DATABASE_URL: passwordUrl,
    }, { staleCache });
    const result = f.run("all", "bicep,seed-secrets,manifests");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.values().map(({ value }) => value), [passwordUrl, passwordUrl]);
    assert.ok(!`${result.stdout}${result.stderr}`.includes("cli-fixture-password"));
    for (const [service, overlay] of [["worker", "default"], ["portal", "afd-letsencrypt"]]) {
      const root = join(f.stage(service), "gitops", service);
      const env = readFileSync(join(root, "overlays", overlay, ".env"), "utf8");
      assert.doesNotMatch(env, /^(DATABASE_URL|PILOTSWARM_CMS_FACTS_DATABASE_URL|PILOTSWARM_DB_AAD_USER)=/m);
      assert.match(env, /^PILOTSWARM_BLOB_USE_MANAGED_IDENTITY=1$/m);
      const component = readFileSync(join(root, "components/database-secrets/kustomization.yaml"), "utf8");
      assert.ok(!component.includes("cli-fixture-password"));
      assert.match(component, /secretKeyRef/);
    }
    const cache = readFileSync(join(REPO_ROOT, "deploy/.tmp", f.name, "bicep-outputs.cache.json"), "utf8");
    assert.ok(!cache.includes("old-server.invalid") && !cache.includes("cli-fixture-password"));
  });
}

test("manifests-only resolves preseeded secret versions without seeding or exporting values", (t) => {
  const f = fixture(t, {
    DATABASE_URL_SECRET_NAME: "preseeded-runtime", PILOTSWARM_CMS_FACTS_DATABASE_URL_SECRET_NAME: "preseeded-cms",
  }, {
    kvValues: { "preseeded-runtime": passwordUrl, "preseeded-cms": passwordUrl },
  });
  const result = f.run("worker", "manifests");
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls().filter(({ args }) => args[0] === "keyvault");
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ args }) => args[2] === "show" && args[args.indexOf("--query") + 1] === "id"));
  assert.equal(f.values().length, 0);
});

test("provisioned manifests use stamp URLs, not ambient shell credentials", (t) => {
  const f = fixture(t, {
    DEPLOY_POSTGRES: "true", PILOTSWARM_USE_MANAGED_IDENTITY: "1",
    POSTGRES_FQDN: "stamp.invalid", POSTGRES_AAD_ADMIN_PRINCIPAL_NAME: "stamp-uami",
  });
  const ambient = "postgresql://u:ambient-fixture-password@wrong-database.invalid/app";
  const result = f.run("worker", "manifests", {
    DATABASE_URL: ambient, PILOTSWARM_CMS_FACTS_DATABASE_URL: ambient,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Ignoring process.env.DATABASE_URL while DEPLOY_POSTGRES=true/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /ambient-fixture-password/);
  const env = parseEnvFile(join(f.stage("worker"), "gitops/worker/overlays/default/.env"));
  assert.equal(new URL(env.DATABASE_URL).hostname, "stamp.invalid");
  assert.equal(new URL(env.PILOTSWARM_CMS_FACTS_DATABASE_URL).hostname, "stamp.invalid");
  assert.equal(env.PILOTSWARM_DB_AAD_USER, "stamp-uami");
});

test("manifests-only verifies unchanged raw URLs without seeding again", (t) => {
  const f = fixture(t, {
    DATABASE_URL: passwordUrl, PILOTSWARM_CMS_FACTS_DATABASE_URL: passwordUrl,
  }, {
    kvValues: { "database-url": passwordUrl, "pilotswarm-cms-facts-database-url": passwordUrl },
  });
  const result = f.run("worker", "manifests");
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls().filter(({ args }) => args[0] === "keyvault");
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ args }) => args[2] === "show" && args[args.indexOf("--query") + 1] === "{id:id,value:value}"));
  assert.equal(f.values().length, 0);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /cli-fixture-password/);
});

test("changed raw URLs fail manifests-only before publishing stale references", (t) => {
  const old = "postgresql://u:older-fixture-password@shared.invalid/testenv?sslmode=require";
  const f = fixture(t, {
    DATABASE_URL: passwordUrl, PILOTSWARM_CMS_FACTS_DATABASE_URL: passwordUrl,
  }, {
    kvValues: { "database-url": old, "pilotswarm-cms-facts-database-url": old },
  });
  const result = f.run("worker", "manifests");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /differs from its Key Vault secret; run --steps seed-secrets/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /cli-fixture-password|older-fixture-password/);
  assert.ok(!f.calls().some(({ args }) => args.includes("upload-batch") || args[2] === "set"));
  assert.equal(f.values().length, 0);
});
