// Unit tests for the Bicep outputs cache.
//
// We exercise loadCache/saveCache against the real cache directory under
// deploy/.tmp/<envName>/, using a uniquely-named test env so there's no
// risk of colliding with a contributor's real deploy state. Each test case
// uses a fresh envName and the test cleans them up at process exit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadCache, saveCache } from "../lib/bicep-outputs-cache.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

function cachePath(envName) {
  return join(REPO_ROOT, "deploy", ".tmp", envName, "bicep-outputs.cache.json");
}

const createdEnvs = new Set();
function freshEnv(label) {
  const e = `__cache_test_${label}_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  createdEnvs.add(e);
  return e;
}

process.on("exit", () => {
  for (const e of createdEnvs) {
    try {
      rmSync(join(REPO_ROOT, "deploy", ".tmp", e), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

test("loadCache returns 0 when file is missing", () => {
  const env = {};
  const n = loadCache(freshEnv("missing"), env);
  assert.equal(n, 0);
  assert.deepEqual(env, {});
});

test("saveCache writes only the keys passed and merges into existing cache", () => {
  const envName = freshEnv("merge");
  saveCache(envName, ["FRONT_DOOR_PROFILE_NAME", "FRONT_DOOR_PROFILE_RESOURCE_GROUP"], {
    FRONT_DOOR_PROFILE_NAME: "fd-prof",
    FRONT_DOOR_PROFILE_RESOURCE_GROUP: "fd-rg",
    UNRELATED: "should-not-be-saved",
  });
  let onDisk = JSON.parse(readFileSync(cachePath(envName), "utf8"));
  assert.deepEqual(onDisk, {
    FRONT_DOOR_PROFILE_NAME: "fd-prof",
    FRONT_DOOR_PROFILE_RESOURCE_GROUP: "fd-rg",
  });

  // Second module's outputs should merge, not replace.
  saveCache(envName, ["ACR_NAME", "ACR_LOGIN_SERVER"], {
    ACR_NAME: "myacr",
    ACR_LOGIN_SERVER: "myacr.azurecr.io",
  });
  onDisk = JSON.parse(readFileSync(cachePath(envName), "utf8"));
  assert.deepEqual(onDisk, {
    FRONT_DOOR_PROFILE_NAME: "fd-prof",
    FRONT_DOOR_PROFILE_RESOURCE_GROUP: "fd-rg",
    ACR_NAME: "myacr",
    ACR_LOGIN_SERVER: "myacr.azurecr.io",
  });
});

test("loadCache merges into env without overwriting existing values", () => {
  const envName = freshEnv("load");
  mkdirSync(join(REPO_ROOT, "deploy", ".tmp", envName), { recursive: true });
  writeFileSync(
    cachePath(envName),
    JSON.stringify({
      ACR_NAME: "cached-acr",
      LOCATION: "westus3",
      FRONT_DOOR_PROFILE_NAME: "cached-fd",
    }),
    "utf8",
  );

  const env = { LOCATION: "eastus" }; // user-set value should win
  const n = loadCache(envName, env);
  assert.equal(n, 2, "expected 2 keys merged (LOCATION skipped because already set)");
  assert.equal(env.LOCATION, "eastus");
  assert.equal(env.ACR_NAME, "cached-acr");
  assert.equal(env.FRONT_DOOR_PROFILE_NAME, "cached-fd");
});

test("saveCache is a no-op when no keys produced any value", () => {
  const envName = freshEnv("empty");
  saveCache(envName, ["MISSING_KEY"], { OTHER: "x" });
  assert.equal(existsSync(cachePath(envName)), false);
  saveCache(envName, [], {});
  assert.equal(existsSync(cachePath(envName)), false);
});

test("loadCache survives a corrupt cache file", () => {
  const envName = freshEnv("corrupt");
  mkdirSync(join(REPO_ROOT, "deploy", ".tmp", envName), { recursive: true });
  writeFileSync(cachePath(envName), "{ this is not json", "utf8");
  const env = {};
  const n = loadCache(envName, env);
  assert.equal(n, 0);
  assert.deepEqual(env, {});
});
