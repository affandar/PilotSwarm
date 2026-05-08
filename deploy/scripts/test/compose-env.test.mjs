// Tests for compose-env.mjs.
//
// Run: node --test deploy/scripts/test/compose-env.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { composeDerivedEnv } from "../lib/compose-env.mjs";

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
