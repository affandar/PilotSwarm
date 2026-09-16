import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDatabaseConfig, databaseOverlayOmittedKeys, DATABASE_URL_KEYS } from "../lib/database-env.mjs";

const passwordUrl = "postgresql://u:synthetic-password@shared.invalid/app?sslmode=require";
const base = {
  DEPLOY_POSTGRES: "false", PILOTSWARM_USE_MANAGED_IDENTITY: "0", KV_NAME: "test-vault",
  DATABASE_URL: passwordUrl, PILOTSWARM_CMS_FACTS_DATABASE_URL: passwordUrl,
};
const version = "a".repeat(32);

test("BYO validation accepts values or explicit references, without changing Blob auth", () => {
  const env = { ...base, PILOTSWARM_BLOB_USE_MANAGED_IDENTITY: "1" };
  const config = validateDatabaseConfig(env);
  assert.equal(config.useManagedIdentity, false);
  assert.equal(env.PILOTSWARM_BLOB_USE_MANAGED_IDENTITY, "1");
  assert.deepEqual(config.secrets.map((secret) => secret.name),
    ["database-url", "pilotswarm-cms-facts-database-url"]);
  assert.doesNotThrow(() => validateDatabaseConfig({
    ...env, DATABASE_URL: undefined, DATABASE_URL_SECRET_NAME: "preseeded",
  }));
});

test("BYO auth choice is explicit; Entra passwords, malformed URLs and invalid references fail without leaking values", () => {
  assert.throws(() => validateDatabaseConfig({ ...base, PILOTSWARM_USE_MANAGED_IDENTITY: undefined }), /explicit database auth/);
  assert.throws(() => validateDatabaseConfig({ ...base, PILOTSWARM_USE_MANAGED_IDENTITY: "1" }), /PILOTSWARM_DB_AAD_USER/);
  for (const extra of [
    { PILOTSWARM_USE_MANAGED_IDENTITY: "1", PILOTSWARM_DB_AAD_USER: "registered" },
    { DATABASE_URL: "malformed-synthetic-password" },
    { DATABASE_URL: "https://u:synthetic-password@shared.invalid/app" },
    { DATABASE_URL_SECRET_NAME: "bad/synthetic-password" },
    { DATABASE_URL_SECRET_NAME: "github-token" },
  ]) {
    assert.throws(() => validateDatabaseConfig({ ...base, ...extra }), (error) => {
      assert.ok(!error.message.includes("synthetic-password"));
      return true;
    });
  }
});

test("different URL values cannot overwrite the same secret object", () => {
  assert.throws(() => validateDatabaseConfig({
    ...base, DATABASE_URL_SECRET_NAME: "shared", PILOTSWARM_CMS_FACTS_DATABASE_URL_SECRET_NAME: "shared",
    PILOTSWARM_CMS_FACTS_DATABASE_URL: "postgresql://other:p@shared.invalid/app",
  }), /different values must use different/);
});

function mockAzure(t, responder = () => ({ stdout: "", status: 0, stderr: "" })) {
  const calls = [];
  const logs = [];
  t.mock.module("../lib/common.mjs", {
    namedExports: {
      log: (...args) => logs.push(args.join(" ")),
      run: (command, args, options) => {
        assert.equal(command, "az");
        calls.push({ args, options });
        return responder(args);
      },
    },
  });
  return { calls, logs };
}

test("seed stage sends URLs only to Key Vault and captures exact versions", async (t) => {
  const { calls, logs } = mockAzure(t, (args) => ({
    stdout: `https://test-vault.vault.azure.net/secrets/${args[args.indexOf("--name") + 1]}/${version}\n`,
    status: 0, stderr: "",
  }));
  const { seedDatabaseSecrets } = await import("../lib/database-secrets.mjs?seed");
  const env = { ...base };
  assert.equal(seedDatabaseSecrets(env), 2);
  assert.equal(env.DATABASE_URL_SECRET_VERSION, version);
  assert.equal(env.PILOTSWARM_CMS_FACTS_DATABASE_URL_SECRET_VERSION, version);
  assert.ok(calls.every(({ args, options }) =>
    args.slice(0, 3).join(" ") === "keyvault secret set" &&
    args[args.indexOf("--value") + 1] === passwordUrl &&
    args[args.indexOf("--query") + 1] === "id" && options.capture));
  assert.ok(!logs.join("\n").includes("synthetic-password"));
});

test("preseeded references are never overwritten; manifests resolve identifiers only", async (t) => {
  const { calls } = mockAzure(t, (args) => ({
    stdout: `https://test-vault.vault.azure.net/secrets/${args[args.indexOf("--name") + 1]}/${version}`,
    status: 0, stderr: "",
  }));
  const { seedDatabaseSecrets, resolveDatabaseSecretVersions } = await import("../lib/database-secrets.mjs?references");
  const env = {
    ...base, DATABASE_URL: undefined, PILOTSWARM_CMS_FACTS_DATABASE_URL: undefined,
    DATABASE_URL_SECRET_NAME: "external-runtime", PILOTSWARM_CMS_FACTS_DATABASE_URL_SECRET_NAME: "external-cms",
  };
  assert.equal(seedDatabaseSecrets(env), 0);
  assert.equal(calls.length, 0);
  resolveDatabaseSecretVersions(env);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ args }) =>
    args.slice(0, 3).join(" ") === "keyvault secret show" &&
    args[args.indexOf("--query") + 1] === "id" && !args.includes("--value")));
  resolveDatabaseSecretVersions(env);
  assert.equal(calls.length, 2, "resolved versions are reused within this invocation");
});

test("shared secret names seed once and invalid version identifiers fail closed", async (t) => {
  const { calls } = mockAzure(t, () => ({
    stdout: `https://test-vault.vault.azure.net/secrets/shared/${version}`, status: 0, stderr: "",
  }));
  const { seedDatabaseSecrets, resolveDatabaseSecretVersions } = await import("../lib/database-secrets.mjs?shared");
  const env = { ...base, DATABASE_URL_SECRET_NAME: "shared", PILOTSWARM_CMS_FACTS_DATABASE_URL_SECRET_NAME: "shared" };
  assert.equal(seedDatabaseSecrets(env), 1);
  assert.equal(calls.length, 1);
  assert.equal(env.DATABASE_URL_SECRET_VERSION, env.PILOTSWARM_CMS_FACTS_DATABASE_URL_SECRET_VERSION);
  assert.throws(() => resolveDatabaseSecretVersions({
    ...base, DATABASE_URL: undefined, PILOTSWARM_CMS_FACTS_DATABASE_URL: undefined,
    DATABASE_URL_SECRET_NAME: "different-name", PILOTSWARM_CMS_FACTS_DATABASE_URL_SECRET_NAME: "different-cms",
  }), /invalid database secret version identifier/);
});

test("provisioned stamps do not gain a new Key Vault requirement", async (t) => {
  const { calls } = mockAzure(t);
  const { seedDatabaseSecrets, resolveDatabaseSecretVersions } = await import("../lib/database-secrets.mjs?default");
  assert.equal(seedDatabaseSecrets({}), 0);
  resolveDatabaseSecretVersions({});
  assert.equal(calls.length, 0);
});

for (const pinned of [false, true]) {
  test(`supplied URLs must match the ${pinned ? "pinned" : "latest"} Key Vault version, without writes`, async (t) => {
    const { calls, logs } = mockAzure(t, (args) => ({
      stdout: JSON.stringify({
        id: `https://test-vault.vault.azure.net/secrets/${args[args.indexOf("--name") + 1]}/${version}`,
        value: passwordUrl,
      }),
      status: 0, stderr: "",
    }));
    const { resolveDatabaseSecretVersions } = await import(`../lib/database-secrets.mjs?verify-${pinned}`);
    const env = { ...base };
    if (pinned) for (const key of DATABASE_URL_KEYS) env[`${key}_SECRET_VERSION`] = version;
    resolveDatabaseSecretVersions(env);
    assert.equal(calls.length, 2);
    for (const { args, options } of calls) {
      assert.equal(args.slice(0, 3).join(" "), "keyvault secret show");
      assert.equal(args[args.indexOf("--query") + 1], "{id:id,value:value}");
      assert.equal(args.includes("--version"), pinned);
      assert.ok(options.capture && options.allowFail);
      assert.ok(!args.includes(passwordUrl));
    }
    for (const key of DATABASE_URL_KEYS) assert.equal(env[`${key}_SECRET_VERSION`], version);
    assert.ok(!logs.join("\n").includes("synthetic-password"));
  });
}

test("changed raw URLs cannot silently reuse a stored secret, even with an explicit version", async (t) => {
  const { calls } = mockAzure(t, () => ({
    stdout: JSON.stringify({
      id: `https://test-vault.vault.azure.net/secrets/database-url/${version}`,
      value: "postgresql://u:older-fixture-password@shared.invalid/app",
    }),
    status: 0, stderr: "",
  }));
  const { resolveDatabaseSecretVersions } = await import("../lib/database-secrets.mjs?mismatch");
  for (const selectedVersion of [undefined, version]) {
    assert.throws(() => resolveDatabaseSecretVersions({
      ...base, DATABASE_URL_SECRET_VERSION: selectedVersion,
    }), (error) => {
      assert.match(error.message, /differs from its Key Vault secret; run --steps seed-secrets/);
      assert.doesNotMatch(error.message, /synthetic-password|older-fixture-password/);
      return true;
    });
  }
  assert.equal(calls.length, 2);
});

test("verification failures never expose secret-bearing CLI output", async (t) => {
  let response;
  mockAzure(t, () => response);
  const { resolveDatabaseSecretVersions } = await import("../lib/database-secrets.mjs?private-errors");
  for (const candidate of [
    { status: 1, stdout: passwordUrl, stderr: passwordUrl },
    { status: 0, stdout: passwordUrl },
    { status: 0, stdout: JSON.stringify({ id: passwordUrl, value: null }) },
    { status: 0, stdout: JSON.stringify({ id: passwordUrl, value: passwordUrl }) },
    { status: 0, stdout: JSON.stringify({
      id: `https://test-vault.vault.azure.net/secrets/database-url/${"b".repeat(32)}`, value: passwordUrl,
    }) },
  ]) {
    response = { stderr: "", ...candidate };
    assert.throws(() => resolveDatabaseSecretVersions({
      ...base, DATABASE_URL_SECRET_VERSION: version,
    }), (error) => {
      assert.ok(!error.message.includes("synthetic-password"));
      assert.ok(!error.message.includes(passwordUrl));
      return true;
    });
  }
});

test("database ConfigMap omissions are scoped to BYO only", () => {
  for (const flag of ["0", "1"]) {
    assert.deepEqual(databaseOverlayOmittedKeys({
      DEPLOY_POSTGRES: "true", PILOTSWARM_USE_MANAGED_IDENTITY: flag,
    }), []);
  }
  assert.deepEqual(databaseOverlayOmittedKeys(base), [...DATABASE_URL_KEYS, "PILOTSWARM_DB_AAD_USER"]);
  assert.deepEqual(databaseOverlayOmittedKeys({
    ...base, PILOTSWARM_USE_MANAGED_IDENTITY: "1",
  }), [...DATABASE_URL_KEYS]);
});
