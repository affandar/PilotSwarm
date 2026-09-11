// Focused CLI parsing tests for deploy.mjs. These cases exit before any
// Azure, Docker, Flux, or Kubernetes preflight can run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { REPO_ROOT } from "../lib/common.mjs";

const DEPLOY_SCRIPT = join(REPO_ROOT, "deploy", "scripts", "deploy.mjs");

function runDeploy(args) {
  return spawnSync(process.execPath, [DEPLOY_SCRIPT, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
}

test("deploy help documents the external env overlay", () => {
  const result = runDeploy(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--env-overlay <path>/);
  assert.match(result.stdout, /--instance <name>/);
  assert.match(result.stdout, /push,render,manifests/);
});

test("deploy accepts equals-form env overlay before help", () => {
  const result = runDeploy(["--env-overlay=composition.env", "--help"]);
  assert.equal(result.status, 0, result.stderr);
});

test("deploy rejects env overlay without a path", () => {
  const result = runDeploy(["worker", "tstenv", "--env-overlay"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--env-overlay requires a path/);
});

test("deploy accepts repeated env overlay flags in command-line order", () => {
  const result = runDeploy([
    "--env-overlay",
    "first.env",
    "--env-overlay=second.env",
    "--help",
  ]);
  assert.equal(result.status, 0, result.stderr);
});

test("git-cache requires an instance", () => {
  const result = runDeploy(["git-cache", "tstenv"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires --instance/);
});

test("git-repo-worker requires an instance", () => {
  const result = runDeploy(["git-repo-worker", "tstenv"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires --instance/);
});

test("deploy rejects invalid instance names", () => {
  const result = runDeploy(["git-cache", "tstenv", "--instance", "SQL Repo"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid deploy instance/);
});

test("deploy rejects instance names that produce invalid storage containers", () => {
  const result = runDeploy(["git-cache", "tstenv", "--instance", "sql--repo"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid deploy instance/);
});
