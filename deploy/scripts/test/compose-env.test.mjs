// Tests for compose-env.mjs.
//
// Run: node --test deploy/scripts/test/compose-env.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { composeDerivedEnv } from "../lib/compose-env.mjs";
import { deploysPostgres, validateDatabaseConfig } from "../lib/database-env.mjs";

test("composes DATABASE_URL from POSTGRES_FQDN with bootstrap defaults", () => {
  const env = { POSTGRES_FQDN: "ps.example.postgres.database.azure.com" };
  composeDerivedEnv(env);
  assert.equal(
    env.DATABASE_URL,
    "postgresql://pilotswarm:PilotSwarmDev_BootstrapOnly!9876@ps.example.postgres.database.azure.com:5432/pilotswarm?sslmode=require",
  );
});

test("DATABASE_URL composition honors POSTGRES_ADMIN_LOGIN/PASSWORD/DATABASE overrides", () => {
  const env = {
    POSTGRES_FQDN: "ps.example.postgres.database.azure.com",
    POSTGRES_ADMIN_LOGIN: "myadmin",
    POSTGRES_ADMIN_PASSWORD: "supersecret",
    POSTGRES_DATABASE_NAME: "mydb",
  };
  composeDerivedEnv(env);
  assert.equal(
    env.DATABASE_URL,
    "postgresql://myadmin:supersecret@ps.example.postgres.database.azure.com:5432/mydb?sslmode=require",
  );
});

test("DATABASE_URL composition is a no-op when DATABASE_URL is already set", () => {
  const env = {
    POSTGRES_FQDN: "ps.example.postgres.database.azure.com",
    DATABASE_URL: "postgresql://prefilled@host:5432/db?sslmode=require",
  };
  composeDerivedEnv(env);
  assert.equal(env.DATABASE_URL, "postgresql://prefilled@host:5432/db?sslmode=require");
});

test("DATABASE_URL composition is skipped when POSTGRES_FQDN is missing", () => {
  const env = {};
  composeDerivedEnv(env);
  assert.equal(env.DATABASE_URL, undefined);
});

test("composes AZURE_STORAGE_ACCOUNT_URL stripping the trailing slash from BLOB_CONTAINER_ENDPOINT", () => {
  const env = { BLOB_CONTAINER_ENDPOINT: "https://acct.blob.core.windows.net/" };
  composeDerivedEnv(env);
  assert.equal(env.AZURE_STORAGE_ACCOUNT_URL, "https://acct.blob.core.windows.net");
});

test("AZURE_STORAGE_ACCOUNT_URL strips multiple trailing slashes", () => {
  const env = { BLOB_CONTAINER_ENDPOINT: "https://acct.blob.core.windows.net///" };
  composeDerivedEnv(env);
  assert.equal(env.AZURE_STORAGE_ACCOUNT_URL, "https://acct.blob.core.windows.net");
});

test("AZURE_STORAGE_ACCOUNT_URL composition is a no-op when already set", () => {
  const env = {
    BLOB_CONTAINER_ENDPOINT: "https://acct.blob.core.windows.net/",
    AZURE_STORAGE_ACCOUNT_URL: "https://prefilled.blob.core.windows.net",
  };
  composeDerivedEnv(env);
  assert.equal(env.AZURE_STORAGE_ACCOUNT_URL, "https://prefilled.blob.core.windows.net");
});

test("PILOTSWARM_DB_AAD_USER is aliased from POSTGRES_AAD_ADMIN_PRINCIPAL_NAME", () => {
  const env = { POSTGRES_AAD_ADMIN_PRINCIPAL_NAME: "ps-csi-mid" };
  composeDerivedEnv(env);
  assert.equal(env.PILOTSWARM_DB_AAD_USER, "ps-csi-mid");
});

test("PILOTSWARM_CMS_FACTS_DATABASE_URL composes a passwordless URL using the AAD user", () => {
  const env = {
    POSTGRES_FQDN: "ps.example.postgres.database.azure.com",
    POSTGRES_AAD_ADMIN_PRINCIPAL_NAME: "ps-csi-mid",
  };
  composeDerivedEnv(env);
  assert.equal(env.PILOTSWARM_DB_AAD_USER, "ps-csi-mid");
  assert.equal(
    env.PILOTSWARM_CMS_FACTS_DATABASE_URL,
    "postgresql://ps-csi-mid@ps.example.postgres.database.azure.com:5432/pilotswarm?sslmode=require",
  );
});

test("PILOTSWARM_CMS_FACTS_DATABASE_URL URL-encodes the AAD user segment", () => {
  // Real CSI UAMI principal names don't contain reserved chars but we still
  // want defensive encoding so a future principal name (e.g. with '+' or
  // '@') doesn't produce an invalid URL.
  const env = {
    POSTGRES_FQDN: "ps.example.postgres.database.azure.com",
    PILOTSWARM_DB_AAD_USER: "user+name@tenant",
  };
  composeDerivedEnv(env);
  assert.match(env.PILOTSWARM_CMS_FACTS_DATABASE_URL, /^postgresql:\/\/user%2Bname%40tenant@/);
});

test("composeDerivedEnv is fully idempotent (running it twice doesn't change anything)", () => {
  const env = {
    POSTGRES_FQDN: "ps.example.postgres.database.azure.com",
    POSTGRES_AAD_ADMIN_PRINCIPAL_NAME: "ps-csi-mid",
    BLOB_CONTAINER_ENDPOINT: "https://acct.blob.core.windows.net/",
  };
  composeDerivedEnv(env);
  const snapshot = JSON.stringify(env);
  composeDerivedEnv(env);
  assert.equal(JSON.stringify(env), snapshot);
});

test("simulates the deploy flow: empty cache, then bicep merges BaseInfra outputs, then re-compose", () => {
  // Fresh `all` run scenario the production bug uncovered.
  const env = { LOCATION: "westus3" };
  composeDerivedEnv(env); // startup pass: nothing to compose
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.AZURE_STORAGE_ACCOUNT_URL, undefined);
  assert.equal(env.PILOTSWARM_CMS_FACTS_DATABASE_URL, undefined);

  // Bicep stage merges BaseInfra outputs into env.
  env.POSTGRES_FQDN = "ps.example.postgres.database.azure.com";
  env.POSTGRES_AAD_ADMIN_PRINCIPAL_NAME = "ps-csi-mid";
  env.BLOB_CONTAINER_ENDPOINT = "https://acct.blob.core.windows.net/";

  // Post-bicep pass: composes everything for the manifests stage.
  composeDerivedEnv(env);
  assert.ok(env.DATABASE_URL);
  assert.equal(env.AZURE_STORAGE_ACCOUNT_URL, "https://acct.blob.core.windows.net");
  assert.equal(env.PILOTSWARM_DB_AAD_USER, "ps-csi-mid");
  assert.ok(env.PILOTSWARM_CMS_FACTS_DATABASE_URL);
});

// ─── Bring-your-own database (DEPLOY_POSTGRES=0) ───

test("DEPLOY_POSTGRES=0 drops stale cached POSTGRES_* instead of composing from them", () => {
  // The per-env Bicep outputs cache still holds the previously provisioned
  // server, and composeDerivedEnv runs BEFORE the bicep stage. Without the
  // guard, PILOTSWARM_CMS_FACTS_DATABASE_URL would be built from the OLD host
  // while DATABASE_URL points at the supplied one.
  const env = {
    DEPLOY_POSTGRES: "0",
    POSTGRES_FQDN: "old-stamp-pg.postgres.database.azure.com",
    POSTGRES_AAD_ADMIN_PRINCIPAL_NAME: "old-stamp-uami",
    DATABASE_URL: "postgresql://u:p@byo.example.com:5432/app?sslmode=require",
    PILOTSWARM_CMS_FACTS_DATABASE_URL: "postgresql://u:p@byo.example.com:5432/app?sslmode=require",
    PILOTSWARM_USE_MANAGED_IDENTITY: "0",
  };
  composeDerivedEnv(env);
  assert.equal(env.POSTGRES_FQDN, undefined);
  assert.equal(env.POSTGRES_AAD_ADMIN_PRINCIPAL_NAME, undefined);
  assert.equal(env.PILOTSWARM_DB_AAD_USER, undefined);
  assert.ok(!env.DATABASE_URL.includes("old-stamp-pg"));
  assert.ok(!env.PILOTSWARM_CMS_FACTS_DATABASE_URL.includes("old-stamp-pg"));
});

test("DEPLOY_POSTGRES=0 requires both connection strings", () => {
  const env = { DEPLOY_POSTGRES: "0", PILOTSWARM_USE_MANAGED_IDENTITY: "0" };
  assert.doesNotThrow(() => composeDerivedEnv(env), "composition must allow infra/build-only runs");
  assert.throws(
    () => validateDatabaseConfig(env),
    /requires DATABASE_URL and PILOTSWARM_CMS_FACTS_DATABASE_URL/,
  );
  assert.throws(
    () => validateDatabaseConfig({ ...env, DATABASE_URL: "postgresql://u:p@h:5432/d" }),
    /requires PILOTSWARM_CMS_FACTS_DATABASE_URL/,
  );
});

test("DEPLOY_POSTGRES=0 forces an explicit auth decision", () => {
  const base = {
    DEPLOY_POSTGRES: "0",
    DATABASE_URL: "postgresql://u:p@byo.example.com:5432/app",
    PILOTSWARM_CMS_FACTS_DATABASE_URL: "postgresql://u:p@byo.example.com:5432/app",
  };
  // The template default is PILOTSWARM_USE_MANAGED_IDENTITY=1, an attribute of
  // the provisioned stamp server. Inheriting it silently with a supplied
  // password URL is the trap this guards.
  assert.throws(
    () => validateDatabaseConfig({ ...base, PILOTSWARM_USE_MANAGED_IDENTITY: "1" }),
    /requires PILOTSWARM_DB_AAD_USER/,
  );
  const entra = {
    ...base, PILOTSWARM_USE_MANAGED_IDENTITY: "1", PILOTSWARM_DB_AAD_USER: "byo-principal",
    DATABASE_URL: "postgresql://byo-principal@byo.example.com/app",
    PILOTSWARM_CMS_FACTS_DATABASE_URL: "postgresql://byo-principal@byo.example.com/app",
  };
  composeDerivedEnv(entra);
  assert.doesNotThrow(() => validateDatabaseConfig(entra));
  assert.equal(entra.PILOTSWARM_DB_AAD_USER, "byo-principal");
  const pwd = { ...base, PILOTSWARM_USE_MANAGED_IDENTITY: "0" };
  composeDerivedEnv(pwd);
  assert.doesNotThrow(() => validateDatabaseConfig(pwd));
  assert.equal(pwd.DATABASE_URL, base.DATABASE_URL);
});

test("all supported false forms suppress stale outputs before and after Bicep", () => {
  for (const flag of ["false", " FALSE ", false, "0", 0]) {
    const env = {
      DEPLOY_POSTGRES: flag,
      POSTGRES_FQDN: "stale.invalid",
      POSTGRES_AAD_ADMIN_PRINCIPAL_NAME: "stale-user",
      DATABASE_URL: "postgresql://byo:p@byo.invalid/app",
    };
    composeDerivedEnv(env);
    assert.equal(env.PILOTSWARM_CMS_FACTS_DATABASE_URL, undefined);
    assert.equal(env.PILOTSWARM_DB_AAD_USER, undefined);
    assert.equal(env.POSTGRES_FQDN, undefined);
    env.POSTGRES_FQDN = "";
    env.POSTGRES_AAD_ADMIN_PRINCIPAL_NAME = "";
    composeDerivedEnv(env);
    assert.equal(env.PILOTSWARM_CMS_FACTS_DATABASE_URL, undefined);
    assert.equal(env.DATABASE_URL, "postgresql://byo:p@byo.invalid/app");
  }
});

test("provisioning boolean accepts legacy true forms and rejects invalid input", () => {
  for (const flag of ["true", " TRUE ", true, "1", 1, undefined]) {
    assert.equal(deploysPostgres({ DEPLOY_POSTGRES: flag }), true);
  }
  for (const flag of ["", "no", "fales", "2", "secret-should-not-be-logged"]) {
    assert.throws(() => deploysPostgres({ DEPLOY_POSTGRES: flag }), (error) => {
      assert.match(error.message, /DEPLOY_POSTGRES must be true or false/);
      assert.ok(!error.message.includes("secret-should-not-be-logged"));
      return true;
    });
  }
});

test("DEPLOY_POSTGRES=1 and unset both keep the provisioned path unchanged", () => {
  for (const deployPostgres of ["1", undefined]) {
    const env = {
      POSTGRES_FQDN: "stamp-pg.postgres.database.azure.com",
      POSTGRES_AAD_ADMIN_PRINCIPAL_NAME: "stamp-uami",
    };
    if (deployPostgres !== undefined) env.DEPLOY_POSTGRES = deployPostgres;
    composeDerivedEnv(env);
    assert.ok(env.DATABASE_URL.includes("stamp-pg.postgres.database.azure.com"));
    assert.equal(env.PILOTSWARM_DB_AAD_USER, "stamp-uami");
    assert.ok(env.PILOTSWARM_CMS_FACTS_DATABASE_URL.includes("stamp-uami"));
  }
});
