import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stageManifests } from "../lib/stage-manifests.mjs";
import { manifestContainerName } from "../lib/publish-manifests.mjs";
import { resolveRolloutSpec } from "../lib/wait-rollout.mjs";
import { configureEnv } from "../../services/git-repo-worker/configure-env.mjs";

function repoWorkerEnv(extra = {}) {
  return {
    DEPLOY_INSTANCE: "sample-repo",
    REPO_NAME: "sample-repo",
    REPO_URL: "https://example.test/project/_git/sample-repo",
    WORKER_OS: "windows",
    CACHE_HOSTPATH: "C:\\git-cache",
    WORKER_MEM_LIMIT: "8Gi",
    GIT_REPO_WORKER_IMAGE:
      "example.azurecr.io/private-sample-worker:published-20260910",
    KV_NAME: "sample-kv",
    WORKLOAD_IDENTITY_CLIENT_ID: "00000000-0000-0000-0000-000000000000",
    AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000000",
    AZURE_STORAGE_ACCOUNT_URL: "https://sample.blob.core.windows.net/",
    PILOTSWARM_CMS_FACTS_DATABASE_URL:
      "postgresql://sample@sample:5432/sample?sslmode=require",
    PILOTSWARM_DB_AAD_USER: "sample",
    DATABASE_URL: "******sample:5432/sample?sslmode=require",
    FOUNDRY_ENDPOINT: "",
    ...extra,
  };
}

test("git-repo-worker stages a Windows fleet with an exact external image", () => {
  const stagingDir = mkdtempSync(join(tmpdir(), "ps-git-repo-worker-win-"));
  const env = repoWorkerEnv({
    WORKER_EXTRA_ENV: "FLEET_TOOL_MODE=headless;SECOND_VALUE=a=b",
  });
  configureEnv(env, { phase: "manifests" });
  const stagedRoot = stageManifests({
    service: "git-repo-worker",
    envName: "dev",
    env,
    stagingDir,
  });
  const daemonset = readFileSync(
    join(stagedRoot, "components", "windows", "daemonset.yaml"),
    "utf8",
  );
  const overlayEnv = readFileSync(
    join(stagedRoot, "overlays", "windows", ".env"),
    "utf8",
  );
  assert.match(daemonset, /maxUnavailable: 50%/);
  assert.match(
    overlayEnv,
    /GIT_REPO_WORKER_IMAGE=example\.azurecr\.io\/private-sample-worker:published-20260910/,
  );
  assert.match(overlayEnv, /GIT_REPO_WORKER_SERVICE_ACCOUNT_NAME=pilotswarm-git-cache-sample-repo/);
  assert.match(
    overlayEnv,
    /PILOTSWARM_IMAGE_REF=example\.azurecr\.io\/private-sample-worker:published-20260910/,
  );
  assert.match(overlayEnv, /FLEET_TOOL_MODE=headless/);
  assert.match(overlayEnv, /SECOND_VALUE=a=b/);
  assert.ok(!daemonset.includes("__WORKER_MAX_UNAVAILABLE__"));
});

test("git-repo-worker stages the Linux fleet variant", () => {
  const stagingDir = mkdtempSync(join(tmpdir(), "ps-git-repo-worker-linux-"));
  const env = repoWorkerEnv({
    WORKER_OS: "linux",
    CACHE_HOSTPATH: "/var/lib/pilotswarm-git-cache",
    GIT_REPO_WORKER_IMAGE: "example.azurecr.io/sample-worker:published",
  });
  configureEnv(env, { phase: "manifests" });
  const stagedRoot = stageManifests({
    service: "git-repo-worker",
    envName: "dev",
    env,
    stagingDir,
  });
  const overlayEnv = readFileSync(
    join(stagedRoot, "overlays", "linux", ".env"),
    "utf8",
  );
  assert.match(overlayEnv, /GIT_CACHE_ROOT=\/mnt\/git-cache/);
  assert.match(
    overlayEnv,
    /GIT_ENLISTMENT_HOSTPATH=\/var\/lib\/pilotswarm-git-cache-enlistment/,
  );
});

test("git-repo-worker loads explicit file-backed MCP defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "ps-git-repo-worker-mcp-"));
  const valuesDir = join(root, "values");
  mkdirSync(valuesDir);
  const overlay = join(valuesDir, "sample-repo.env");
  const mcp = join(valuesDir, "sample-repo.mcp.json");
  writeFileSync(overlay, "DEFAULT_MCP_FILE=sample-repo.mcp.json\n");
  writeFileSync(
    mcp,
    JSON.stringify({ servers: { ado: { type: "http", url: "https://example.test" } } }),
  );
  const env = repoWorkerEnv({ DEFAULT_MCP_FILE: "sample-repo.mcp.json" });
  configureEnv(env, { envOverlays: [overlay] });
  assert.equal(
    env.DEFAULT_MCP_JSON,
    '{"servers":{"ado":{"type":"http","url":"https://example.test"}}}',
  );
});

test("git-repo-worker rejects missing image and malformed deployment env", () => {
  assert.throws(
    () =>
      configureEnv(repoWorkerEnv({ GIT_REPO_WORKER_IMAGE: "" }), {
        phase: "manifests",
      }),
    /requires GIT_REPO_WORKER_IMAGE/,
  );
  assert.throws(
    () =>
      configureEnv(repoWorkerEnv({ GIT_REPO_WORKER_IMAGE: "not-a-full-image" }), {
        phase: "manifests",
      }),
    /complete tagged or digest image reference/,
  );
  assert.throws(
    () => configureEnv(repoWorkerEnv({ WORKER_EXTRA_ENV: "not-a-pair" })),
    /not NAME=value/,
  );
  assert.throws(
    () => configureEnv(repoWorkerEnv({ DEPLOY_INSTANCE: "other-repo" })),
    /must match REPO_NAME/,
  );
});

test("git-repo-worker uses isolated manifests and exact image verification", () => {
  assert.equal(
    manifestContainerName("git-repo-worker", {
      DEPLOY_INSTANCE: "sample-repo",
    }),
    "repo-worker-sample-repo-manifests",
  );
  const env = repoWorkerEnv({
    GIT_REPO_WORKER_IMAGE:
      "example.azurecr.io/private-sample-worker:published",
  });
  configureEnv(env);
  assert.deepEqual(
    resolveRolloutSpec({
      service: "git-repo-worker",
      env,
    }),
    {
      resourceName: "copilot-runtime-git-worker-sample-repo-windows",
      resourceKind: "daemonset",
      namespace: "pilotswarm",
      kustomizationName:
        "git-repo-worker-sample-repo-git-repo-worker-sample-repo",
      verifyImage: true,
      expectedImage: "example.azurecr.io/private-sample-worker:published",
      prerequisites: [
        {
          kind: "serviceaccount",
          name: "pilotswarm-git-cache-sample-repo",
          namespace: "pilotswarm",
        },
      ],
      timeout: "30m",
    },
  );
});

test("git-repo-worker manifest container fits a maximum-length instance", () => {
  const name = manifestContainerName("git-repo-worker", {
    DEPLOY_INSTANCE: "a".repeat(40),
  });
  assert.ok(name.length <= 63, `${name} exceeds the Azure container-name limit`);
});

test("git-repo-worker resource names fit Kubernetes limits", () => {
  const instance = "a".repeat(40);
  const env = repoWorkerEnv({
    DEPLOY_INSTANCE: instance,
    REPO_NAME: instance,
  });
  configureEnv(env);
  assert.ok(env.GIT_REPO_WORKER_DAEMONSET_NAME.length <= 63);
  assert.ok(env.GIT_REPO_WORKER_SECRET_NAME.length <= 63);
  assert.ok(env.GIT_REPO_WORKER_SECRET_PROVIDER_CLASS_NAME.length <= 63);
  assert.ok(env.GIT_REPO_WORKER_SERVICE_ACCOUNT_NAME.length <= 63);
  assert.ok(env.GIT_REPO_WORKER_FLUX_KUSTOMIZATION_NAME.length <= 62);
  assert.equal(
    env.GIT_REPO_WORKER_FLUX_KUSTOMIZATION_NAME,
    `git-repo-worker-${instance}-rw`,
  );
});
