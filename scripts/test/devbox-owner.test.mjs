// Functional test for the devbox worker preload (scripts/devbox-owner.mjs).
//
// Run: node --test scripts/test/devbox-owner.test.mjs
//
// This is a FUNCTIONAL test, not a unit test: devbox-owner.mjs is a preload
// whose whole contract is the side effect it has on process.env before the SDK
// worker constructor reads it. So we run the real script exactly as `worker:dev`
// does — `node --import ./scripts/devbox-owner.mjs` — in a child process with
// stubbed `gh`/`az` on PATH, then read back the resulting environment.
//
// The behavior under test is the devbox credential model: on a devbox with a
// signed-in Copilot user (the `copilot` CLI login under COPILOT_HOME) and no
// GITHUB_TOKEN, the SDK authenticates as that signed-in user when the worker
// resolves NO token — the tokenless CopilotClient path. If the preload instead
// injects a `gh auth token` into GITHUB_TOKEN, the worker stops using the
// signed-in user and hands the child a `gh` OAuth token, which GitHub does NOT
// accept for the Copilot exchange (HTTP 403) — turning a clean auth into a
// poisoned session. So the preload MUST NOT populate GITHUB_TOKEN from `gh`.
//
// Timeline this test pins:
//   - Before commit f3055c6b: the preload never touched GITHUB_TOKEN  -> PASS
//   - f3055c6b ("...identity canonical across restarts") added a
//     `gh auth token` -> GITHUB_TOKEN fallback                         -> FAIL
//   - After the fix (drop that fallback)                               -> PASS

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEVBOX_OWNER = join(__dirname, "..", "devbox-owner.mjs");
const IS_WIN = process.platform === "win32";

// A fake object id the stubbed `az ad signed-in-user show` returns.
const STUB_SUBJECT = "00000000-0000-0000-0000-000000000000";
// A fake token the stubbed `gh auth token` returns. If the preload injects it
// into GITHUB_TOKEN, that is the regression this test catches.
const STUB_GH_TOKEN = "gho_stubtokenstubtokenstubtokenstub01234";

/**
 * Create a throwaway directory of stub `gh`/`az` executables and return it so
 * the caller can prepend it to PATH. Cross-platform: `.cmd` shims on Windows,
 * executable shell scripts elsewhere.
 */
function makeStubBinDir() {
  const dir = mkdtempSync(join(tmpdir(), "devbox-owner-stubs-"));
  if (IS_WIN) {
    // `execFileSync("gh", [...], { shell: true })` runs via cmd.exe, which
    // resolves gh.cmd / az.cmd on PATH. Echo the canned value on any args.
    writeFileSync(join(dir, "gh.cmd"), `@echo ${STUB_GH_TOKEN}\r\n`);
    writeFileSync(join(dir, "az.cmd"), `@echo ${STUB_SUBJECT}\r\n`);
  } else {
    const gh = join(dir, "gh");
    const az = join(dir, "az");
    writeFileSync(gh, `#!/bin/sh\necho "${STUB_GH_TOKEN}"\n`);
    writeFileSync(az, `#!/bin/sh\necho "${STUB_SUBJECT}"\n`);
    chmodSync(gh, 0o755);
    chmodSync(az, 0o755);
  }
  return dir;
}

/**
 * Run devbox-owner.mjs as a `--import` preload with the given environment and
 * return the resulting env vars of interest (as the SDK worker would see them).
 */
function runPreload(env) {
  const marker = "__DEVBOX_OWNER_ENV__";
  const code =
    `process.stdout.write(${JSON.stringify(marker)} + JSON.stringify({` +
    `GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? null,` +
    `POD_NAME: process.env.POD_NAME ?? null,` +
    `OWNER_SUBJECT: process.env.PILOTSWARM_WORKER_OWNER_SUBJECT ?? null,` +
    `}));`;
  const res = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(DEVBOX_OWNER).href, "-e", code],
    { env, encoding: "utf8" },
  );
  assert.equal(res.status, 0, `preload exited non-zero:\n${res.stderr}\n${res.stdout}`);
  const idx = res.stdout.lastIndexOf(marker);
  assert.notEqual(idx, -1, `env marker not found in output:\n${res.stdout}`);
  return JSON.parse(res.stdout.slice(idx + marker.length));
}

/** Base child env: stubs on PATH, and all three preload targets unset. */
function baseEnv(stubDir) {
  const env = { ...process.env };
  // Prepend stub dir so the preload's gh/az resolve to our shims.
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH";
  env[pathKey] = stubDir + (IS_WIN ? ";" : ":") + (env[pathKey] || "");
  // Ensure each idempotent block runs its resolution path from a clean slate.
  delete env.GITHUB_TOKEN;
  delete env.POD_NAME;
  delete env.PILOTSWARM_WORKER_OWNER_PROVIDER;
  delete env.PILOTSWARM_WORKER_OWNER_SUBJECT;
  // Silence the cosmetic "no tags" warning; irrelevant to this test.
  env.PILOTSWARM_WORKER_TAGS = "repo:test";
  return env;
}

test("devbox preload does not inject GITHUB_TOKEN — signed-in-user auth is preserved", () => {
  const stubDir = makeStubBinDir();
  try {
    const out = runPreload(baseEnv(stubDir));

    // Core contract (flips with the regression): even though `gh auth token`
    // WOULD return a token (our stub proves the resolution path is reachable),
    // the preload must leave GITHUB_TOKEN unset so the worker resolves NO token
    // and the SDK authenticates as the signed-in Copilot user via COPILOT_HOME.
    assert.equal(
      out.GITHUB_TOKEN,
      null,
      "devbox-owner injected a GITHUB_TOKEN (from `gh auth token`); this disables " +
        "signed-in-user auth and feeds the child a non-Copilot token (HTTP 403 -> poison).",
    );

    // The rest of the preload's identity setup must be unaffected by the fix.
    assert.ok(out.POD_NAME, "POD_NAME should still be pinned by the preload");
    assert.equal(
      out.OWNER_SUBJECT,
      STUB_SUBJECT,
      "worker owner should still be resolved from the signed-in az identity",
    );
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
});

test("devbox preload honors an explicitly set GITHUB_TOKEN (fleet/CI override)", () => {
  const stubDir = makeStubBinDir();
  try {
    const env = baseEnv(stubDir);
    env.GITHUB_TOKEN = "explicit-token-value";
    const out = runPreload(env);
    assert.equal(
      out.GITHUB_TOKEN,
      "explicit-token-value",
      "an explicitly provided GITHUB_TOKEN must be left untouched",
    );
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
});
