// Phase 4 (FR-006): upload-then-delete atomic publish with 3-retry
// delete + fail-loud on exhaustion. Mocks `run` from common.mjs via
// node:test mock.module.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeStagedTree() {
  const root = mkdtempSync(join(tmpdir(), "ps-publish-"));
  mkdirSync(join(root, "base"), { recursive: true });
  writeFileSync(join(root, "base", "kustomization.yaml"), "k:v\n");
  writeFileSync(join(root, "base", "deployment.yaml"), "k:v\n");
  return root;
}

// Helper: install a mock `run` that records calls and lets the test
// caller drive responses by az subcommand shape.
function installMock(t, { listOutput = "", failureMap = {} } = {}) {
  const calls = [];
  t.mock.module("../lib/common.mjs", {
    namedExports: {
      log: () => {},
      run: (cmd, args, opts = {}) => {
        calls.push({ cmd, args: [...args], opts });
        // Look up failure injection by joining the first few args.
        const key = args.slice(0, 4).join(" ");
        if (failureMap[key]) {
          const remaining = failureMap[key];
          if (remaining.count > 0) {
            remaining.count--;
            throw new Error(remaining.message || `mock failure for: ${key}`);
          }
        }
        if (
          cmd === "az" &&
          args[0] === "storage" &&
          args[1] === "blob" &&
          args[2] === "list"
        ) {
          return { stdout: listOutput, stderr: "", status: 0 };
        }
        return { stdout: "", stderr: "", status: 0 };
      },
      REPO_ROOT: process.cwd(),
    },
  });
  return calls;
}

test("FR-006 happy path: upload precedes list and any deletes", async (t) => {
  const calls = installMock(t, {
    // Container has one stale + one live blob; live blob name matches
    // a relative path in the staged tree.
    listOutput: "base/kustomization.yaml\nbase/stale.yaml\n",
  });
  const mod = await import("../lib/publish-manifests.mjs?fr6happy=" + Date.now());

  const stagedRoot = makeStagedTree();
  await mod.publishManifests({
    service: "portal",
    envName: "dev",
    env: { DEPLOYMENT_STORAGE_ACCOUNT_NAME: "acct" },
    stagedServiceRoot: stagedRoot,
  });

  const subs = calls
    .filter((c) => c.cmd === "az")
    .map((c) => c.args.slice(0, 3).join(" "));
  const idxUpload = subs.indexOf("storage blob upload-batch");
  const idxList = subs.indexOf("storage blob list");
  const idxDelete = subs.indexOf("storage blob delete");
  assert.ok(idxUpload >= 0, "expected an upload-batch call");
  assert.ok(idxList > idxUpload, "list must come AFTER upload (post-upload sweep)");
  assert.ok(idxDelete > idxList, "delete must come AFTER list");
});

test("FR-006 abort-on-upload-failure: no list/delete after upload throws", async (t) => {
  const calls = installMock(t, {
    listOutput: "base/stale.yaml\n",
    failureMap: {
      "storage blob upload-batch --auth-mode": { count: 1, message: "upload boom" },
    },
  });
  const mod = await import("../lib/publish-manifests.mjs?fr6upfail=" + Date.now());

  const stagedRoot = makeStagedTree();
  await assert.rejects(
    () =>
      mod.publishManifests({
        service: "portal",
        envName: "dev",
        env: { DEPLOYMENT_STORAGE_ACCOUNT_NAME: "acct" },
        stagedServiceRoot: stagedRoot,
      }),
    /upload boom/,
  );

  const subs = calls
    .filter((c) => c.cmd === "az")
    .map((c) => c.args.slice(0, 3).join(" "));
  assert.equal(
    subs.includes("storage blob list"),
    false,
    "list must NOT run when upload throws (prior tree stays intact)",
  );
  assert.equal(
    subs.includes("storage blob delete"),
    false,
    "delete must NOT run when upload throws",
  );
});

test("FR-006 transient delete failure retries and succeeds", async (t) => {
  // Stage one local blob; remote list returns one stale blob; first 2
  // delete attempts throw, third succeeds.
  const calls = installMock(t, {
    listOutput: "base/kustomization.yaml\nbase/stale.yaml\n",
    failureMap: {
      "storage blob delete --auth-mode": { count: 2, message: "transient" },
    },
  });
  const mod = await import("../lib/publish-manifests.mjs?fr6retry=" + Date.now());

  const stagedRoot = makeStagedTree();
  await mod.publishManifests({
    service: "portal",
    envName: "dev",
    env: { DEPLOYMENT_STORAGE_ACCOUNT_NAME: "acct" },
    stagedServiceRoot: stagedRoot,
  });

  const deleteCalls = calls.filter(
    (c) =>
      c.cmd === "az" &&
      c.args[0] === "storage" &&
      c.args[1] === "blob" &&
      c.args[2] === "delete",
  );
  assert.equal(deleteCalls.length, 3, "expected 3 delete attempts (2 fail + 1 success)");
});

test("FR-006 delete exhaustion: throws with orphan list (fail-loud)", async (t) => {
  installMock(t, {
    listOutput: "base/kustomization.yaml\nbase/ghost-a.yaml\nbase/ghost-b.yaml\n",
    failureMap: {
      // All 3 attempts per blob fail; both blobs are stale → 6 attempts
      // total, both should end up in the orphan list.
      "storage blob delete --auth-mode": { count: 6, message: "perma-403" },
    },
  });
  const mod = await import("../lib/publish-manifests.mjs?fr6exhaust=" + Date.now());

  const stagedRoot = makeStagedTree();
  await assert.rejects(
    () =>
      mod.publishManifests({
        service: "portal",
        envName: "dev",
        env: { DEPLOYMENT_STORAGE_ACCOUNT_NAME: "acct" },
        stagedServiceRoot: stagedRoot,
      }),
    (err) => {
      assert.match(err.message, /FR-006 violation/);
      assert.match(err.message, /base\/ghost-a\.yaml/);
      assert.match(err.message, /base\/ghost-b\.yaml/);
      return true;
    },
  );
});
