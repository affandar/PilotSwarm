// Tests for env name policy + loadEnv resolution rules.
//
// Run: node --test deploy/scripts/test/local-env.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  loadEnv,
  envFilePath,
  templateEnvPath,
  validateLocalEnvName,
  RESERVED_ENV_NAMES,
  REPO_ROOT,
} from "../lib/common.mjs";

const ENV_DIR = join(REPO_ROOT, "deploy", "envs");
const LOCAL_DIR = join(ENV_DIR, "local");

// Use a deterministic test name; clean up before/after.
const TEST_NAME = "tstenv";
const TEST_FILE = join(LOCAL_DIR, TEST_NAME, "env");

function cleanup() {
  const dir = join(LOCAL_DIR, TEST_NAME);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

test("validateLocalEnvName accepts valid names", () => {
  for (const ok of ["a", "foo", "sandbox", "abc123", "x12345678901"]) {
    assert.doesNotThrow(() => validateLocalEnvName(ok));
  }
});

test("validateLocalEnvName rejects invalid names", () => {
  for (const bad of ["", "1abc", "ABC", "foo-bar", "foo_bar", "x123456789012", "Foo"]) {
    assert.throws(() => validateLocalEnvName(bad), /Invalid env name/);
  }
});

test("validateLocalEnvName rejects reserved names", () => {
  for (const r of RESERVED_ENV_NAMES) {
    assert.throws(() => validateLocalEnvName(r), /reserved env name/);
  }
});

test("envFilePath resolves local names to deploy/envs/local/<name>/env", () => {
  assert.equal(envFilePath("foo"), join(ENV_DIR, "local", "foo", "env"));
});

test("envFilePath rejects reserved names", () => {
  for (const r of RESERVED_ENV_NAMES) {
    assert.throws(() => envFilePath(r), /reserved env name/);
  }
});

test("templateEnvPath points at deploy/envs/template.env", () => {
  assert.equal(templateEnvPath(), join(ENV_DIR, "template.env"));
});

test("loadEnv reads the local env file standalone (no template cascade)", () => {
  cleanup();
  try {
    mkdirSync(dirname(TEST_FILE), { recursive: true });
    writeFileSync(
      TEST_FILE,
      [
        "SUBSCRIPTION_ID=00000000-0000-0000-0000-000000000000",
        `RESOURCE_PREFIX=ps${TEST_NAME}`,
        `RESOURCE_GROUP=ps${TEST_NAME}-wus3-rg`,
        "NAMESPACE=pilotswarm",
        "LOCATION=westus3",
        "",
      ].join("\n"),
      "utf8",
    );

    const { env, sources } = loadEnv(TEST_NAME);
    assert.equal(env.RESOURCE_PREFIX, `ps${TEST_NAME}`);
    assert.equal(env.RESOURCE_GROUP, `ps${TEST_NAME}-wus3-rg`);
    assert.equal(env.SUBSCRIPTION_ID, "00000000-0000-0000-0000-000000000000");
    assert.equal(env.NAMESPACE, "pilotswarm");
    assert.equal(env.LOCATION, "westus3");
    // Sources reflect the standalone read.
    assert.equal(sources.base, null);
    assert.equal(sources.local, TEST_FILE);
  } finally {
    cleanup();
  }
});

test("loadEnv does NOT cascade values from template.env", () => {
  cleanup();
  try {
    mkdirSync(dirname(TEST_FILE), { recursive: true });
    // Write a deliberately sparse local file. Keys present only in
    // template.env (NAMESPACE, AZURE_TENANT_ID, etc.) must NOT leak in.
    writeFileSync(TEST_FILE, "RESOURCE_PREFIX=ps" + TEST_NAME + "\n", "utf8");
    const { env } = loadEnv(TEST_NAME);
    assert.equal(env.RESOURCE_PREFIX, `ps${TEST_NAME}`);
    assert.equal(env.NAMESPACE, undefined);
    assert.equal(env.AZURE_TENANT_ID, undefined);
    assert.equal(env.EDGE_MODE, undefined);
  } finally {
    cleanup();
  }
});

test("loadEnv() throws helpful message when local env is missing", () => {
  cleanup();
  assert.throws(
    () => loadEnv(TEST_NAME),
    new RegExp(`deploy:new-env -- ${TEST_NAME}`),
  );
});

test("loadEnv('foo') with invalid name throws name-validation error", () => {
  assert.throws(() => loadEnv("Foo"), /Invalid env name/);
  assert.throws(() => loadEnv("foo-bar"), /Invalid env name/);
});

test("loadEnv() rejects reserved env names", () => {
  for (const r of RESERVED_ENV_NAMES) {
    assert.throws(() => loadEnv(r), /reserved env name/);
  }
});
