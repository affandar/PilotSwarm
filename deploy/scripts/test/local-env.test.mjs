// Tests for env name policy + loadEnv resolution rules.
//
// Run: node --test deploy/scripts/test/local-env.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

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
const TEST_FILE = join(LOCAL_DIR, TEST_NAME, ".env");

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

test("envFilePath resolves local names to deploy/envs/local/<name>/.env", () => {
  assert.equal(envFilePath("foo"), join(ENV_DIR, "local", "foo", ".env"));
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

test("loadEnv overlays an external env file before process-env overrides", () => {
  cleanup();
  const overlayDir = mkdtempSync(join(tmpdir(), "pilotswarm-env-overlay-"));
  const overlayFile = join(overlayDir, "worker.env");
  try {
    mkdirSync(dirname(TEST_FILE), { recursive: true });
    writeFileSync(
      TEST_FILE,
      [
        "VALUE=local",
        "LOCAL_ONLY=local",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      overlayFile,
      [
        "VALUE=overlay",
        "OVERLAY_ONLY=overlay",
        "",
      ].join("\n"),
      "utf8",
    );

    const overlayArgument = relative(process.cwd(), overlayFile);
    const { env, sources } = loadEnv(TEST_NAME, {
      overlayEnvFile: overlayArgument,
      processEnv: {
        VALUE: "process",
        OVERLAY_ONLY: "process",
        UNRELATED: "ignored",
      },
    });

    test("loadEnv applies repeated external overlays in order", () => {
      const dir = mkdtempSync(join(tmpdir(), "ps-overlay-order-"));
      const first = join(dir, "first.env");
      const second = join(dir, "second.env");
      writeFileSync(first, "ORDER=first\nFIRST_ONLY=yes\n");
      writeFileSync(second, "ORDER=second\nSECOND_ONLY=yes\n");
      try {
        const { env, sources } = loadEnv(TEST_NAME, {
          overlayEnvFiles: [first, second],
          processEnv: {},
        });
        assert.equal(env.ORDER, "second");
        assert.equal(env.FIRST_ONLY, "yes");
        assert.equal(env.SECOND_ONLY, "yes");
        assert.deepEqual(sources.overlays, [resolve(first), resolve(second)]);
        assert.equal(sources.overlay, resolve(second));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    assert.equal(env.VALUE, "process");
    assert.equal(env.LOCAL_ONLY, "local");
    assert.equal(env.OVERLAY_ONLY, "process");
    assert.equal(env.UNRELATED, undefined);
    assert.equal(sources.local, TEST_FILE);
    assert.equal(sources.overlay, resolve(overlayArgument));
  } finally {
    cleanup();
    rmSync(overlayDir, { recursive: true, force: true });
  }
});

test("loadEnv rejects a missing external env file", () => {
  cleanup();
  try {
    mkdirSync(dirname(TEST_FILE), { recursive: true });
    writeFileSync(TEST_FILE, "VALUE=local\n", "utf8");
    assert.throws(
      () => loadEnv(TEST_NAME, { overlayEnvFile: join(dirname(TEST_FILE), "missing.env") }),
      /External env file not found or not a file/,
    );
  } finally {
    cleanup();
  }
});

test("loadEnv composes a STAMP_ENV_FILE pointer as the base-most overlay", () => {
  cleanup();
  const dir = mkdtempSync(join(tmpdir(), "ps-stamp-env-"));
  const stampFile = join(dir, "pststenv.env");
  const cliOverlay = join(dir, "cli.env");
  try {
    mkdirSync(dirname(TEST_FILE), { recursive: true });
    // Local stub: secrets/paths + pointer. Shared config lives in the stamp file.
    writeFileSync(
      TEST_FILE,
      [
        `STAMP_ENV_FILE=${stampFile}`,
        "GITHUB_TOKEN=local-secret",
        "SHARED=local",
        "",
      ].join("\n"),
      "utf8",
    );
    // Versioned stamp file wins over the local stub for shared config.
    writeFileSync(
      stampFile,
      ["SHARED=stamp", "STAMP_ONLY=stamp", "CLI_KEY=stamp", ""].join("\n"),
      "utf8",
    );
    // Explicit --env-overlay still wins over the stamp file.
    writeFileSync(cliOverlay, ["CLI_KEY=cli", ""].join("\n"), "utf8");

    const { env, sources } = loadEnv(TEST_NAME, {
      overlayEnvFiles: [cliOverlay],
      processEnv: {},
    });

    assert.equal(env.SHARED, "stamp"); // stamp file wins over local stub
    assert.equal(env.STAMP_ONLY, "stamp");
    assert.equal(env.GITHUB_TOKEN, "local-secret"); // stub-only key preserved
    assert.equal(env.CLI_KEY, "cli"); // explicit overlay wins over stamp file
    assert.equal(sources.stampEnvFile, resolve(stampFile));
    assert.deepEqual(sources.overlays, [resolve(stampFile), resolve(cliOverlay)]);
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadEnv lets process.env STAMP_ENV_FILE override the stub pointer", () => {
  cleanup();
  const dir = mkdtempSync(join(tmpdir(), "ps-stamp-env-proc-"));
  const stubStamp = join(dir, "stub.env");
  const procStamp = join(dir, "proc.env");
  try {
    mkdirSync(dirname(TEST_FILE), { recursive: true });
    writeFileSync(TEST_FILE, `STAMP_ENV_FILE=${stubStamp}\nSHARED=local\n`, "utf8");
    writeFileSync(stubStamp, "WHICH=stub\n", "utf8");
    writeFileSync(procStamp, "WHICH=proc\n", "utf8");

    const { env, sources } = loadEnv(TEST_NAME, {
      processEnv: { STAMP_ENV_FILE: procStamp },
    });

    assert.equal(env.WHICH, "proc");
    assert.equal(sources.stampEnvFile, resolve(procStamp));
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadEnv does not double-apply a STAMP_ENV_FILE also passed explicitly", () => {
  cleanup();
  const dir = mkdtempSync(join(tmpdir(), "ps-stamp-env-dedupe-"));
  const stampFile = join(dir, "stamp.env");
  try {
    mkdirSync(dirname(TEST_FILE), { recursive: true });
    writeFileSync(TEST_FILE, `STAMP_ENV_FILE=${stampFile}\n`, "utf8");
    writeFileSync(stampFile, "SHARED=stamp\n", "utf8");

    const { env, sources } = loadEnv(TEST_NAME, {
      overlayEnvFiles: [stampFile],
      processEnv: {},
    });

    assert.equal(env.SHARED, "stamp");
    assert.deepEqual(sources.overlays, [resolve(stampFile)]);
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadEnv rejects a missing STAMP_ENV_FILE pointer", () => {
  cleanup();
  try {
    mkdirSync(dirname(TEST_FILE), { recursive: true });
    writeFileSync(
      TEST_FILE,
      `STAMP_ENV_FILE=${join(dirname(TEST_FILE), "missing-stamp.env")}\n`,
      "utf8",
    );
    assert.throws(() => loadEnv(TEST_NAME), /External env file not found or not a file/);
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
