import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stageManifests } from "../lib/stage-manifests.mjs";
import { manifestContainerName } from "../lib/publish-manifests.mjs";
import { resolveRolloutSpec } from "../lib/wait-rollout.mjs";
import { boundedDeploymentName } from "../lib/deploy-bicep.mjs";
import { configureEnv } from "../../services/git-cache/configure-env.mjs";

function gitCacheEnv(extra = {}) {
  return {
    DEPLOY_INSTANCE: "sample-repo",
    REPO_NAME: "sample-repo",
    REPO_URL: "https://example.test/project/_git/sample-repo",
    WORKER_OS: "linux",
    FETCH_INTERVAL_SECONDS: "3600",
    FETCH_JITTER_SECONDS: "300",
    CACHE_HOSTPATH: "/var/lib/pilotswarm-git-cache",
    CACHE_MAX_UNAVAILABLE: "1",
    CACHE_MEM_LIMIT: "1Gi",
    NODE_POOL_NAME: "samplerepo",
    NODE_COUNT: "1",
    NODE_VM_SIZE: "Standard_D4ds_v5",
    NODE_OSDISK_SIZE_GB: "128",
    NODE_OSDISK_TYPE: "Managed",
    ADO_PAT_KEYVAULT_SECRET_URI:
      "https://sample-kv.vault.azure.net/secrets/git-cache-ado-pat",
    WORKLOAD_IDENTITY_CLIENT_ID: "00000000-0000-0000-0000-000000000000",
    AZURE_TENANT_ID: "00000000-0000-0000-0000-000000000000",
    ...extra,
  };
}

test("git-cache stages and renders the Linux manifest variant", () => {
  const stagingDir = mkdtempSync(join(tmpdir(), "ps-git-cache-linux-"));
  const env = gitCacheEnv();
  configureEnv(env, { phase: "manifests", imageTag: "test" });
  const stagedRoot = stageManifests({
    service: "git-cache",
    envName: "dev",
    env,
    stagingDir,
  });
  const daemonset = readFileSync(
    join(stagedRoot, "components", "linux", "daemonset.yaml"),
    "utf8",
  );
  const rbac = readFileSync(join(stagedRoot, "base", "rbac.yaml"), "utf8");
  const secrets = readFileSync(
    join(stagedRoot, "base", "secret-provider-class.yaml"),
    "utf8",
  );
  const overlayEnv = readFileSync(
    join(stagedRoot, "overlays", "linux", ".env"),
    "utf8",
  );
  const replacements = readFileSync(
    join(stagedRoot, "components", "replacements", "kustomization.yaml"),
    "utf8",
  );
  assert.match(daemonset, /envFrom:/);
  assert.match(rbac, /name: pilotswarm-git-cache/);
  assert.match(secrets, /keyvaultName: "placeholder"/);
  assert.match(secrets, /objectName: git-cache-ado-pat/);
  assert.match(daemonset, /ADO_PAT_FILE/);
  assert.match(daemonset, /azure\.workload\.identity\/use: "true"/);
  assert.match(overlayEnv, /REPO_NAME=sample-repo/);
  assert.match(overlayEnv, /REPO_URL=https:\/\/example\.test\/project\/_git\/sample-repo/);
  assert.match(replacements, /data\.GIT_CACHE_DAEMONSET_NAME/);
  assert.ok(!daemonset.includes("__REPO_NAME__"));
});

test("git-cache stages and renders the Windows manifest variant", () => {
  const stagingDir = mkdtempSync(join(tmpdir(), "ps-git-cache-windows-"));
  const env = gitCacheEnv({
    WORKER_OS: "windows",
    NODE_POOL_NAME: "win001",
    CACHE_HOSTPATH: "C:\\git-cache",
    CACHE_MEM_LIMIT: "4Gi",
    GIT_CACHE_IMAGE: "example.azurecr.io/pilotswarm-worker-win:test",
  });
  configureEnv(env, { phase: "manifests", imageTag: "test" });
  const stagedRoot = stageManifests({
    service: "git-cache",
    envName: "dev",
    env,
    stagingDir,
  });
  const daemonset = readFileSync(
    join(stagedRoot, "components", "windows", "daemonset.yaml"),
    "utf8",
  );
  const rbac = readFileSync(join(stagedRoot, "base", "rbac.yaml"), "utf8");
  const secrets = readFileSync(
    join(stagedRoot, "base", "secret-provider-class.yaml"),
    "utf8",
  );
  const overlayEnv = readFileSync(
    join(stagedRoot, "overlays", "windows", ".env"),
    "utf8",
  );
  assert.match(daemonset, /name: git-cache/);
  assert.match(daemonset, /serviceAccountName: pilotswarm-git-cache/);
  assert.match(overlayEnv, /GIT_CACHE_IMAGE=example\.azurecr\.io\/pilotswarm-worker-win:test/);
  assert.match(
    overlayEnv,
    /GIT_CACHE_SERVICE_ACCOUNT_NAME=pilotswarm-git-cache-sample-repo/,
  );
  assert.match(rbac, /name: pilotswarm-git-cache/);
  assert.match(secrets, /objectName: git-cache-ado-pat/);
  assert.match(daemonset, /ADO_PAT_FILE/);
  assert.match(daemonset, /azure\.workload\.identity\/use: "true"/);
  assert.match(daemonset, /timeoutSeconds: 5/);
  assert.ok(!daemonset.includes("__IMAGE__"));
});

test("git-cache derives CSI values from its Key Vault secret URI", () => {
  const env = gitCacheEnv();
  configureEnv(env);
  assert.equal(env.GIT_CACHE_PAT_KEYVAULT_NAME, "sample-kv");
  assert.equal(env.GIT_CACHE_PAT_SECRET_NAME, "git-cache-ado-pat");
});

test("git-cache rejects versioned Key Vault secret URIs", () => {
  assert.throws(
    () =>
      configureEnv(
        gitCacheEnv({
          ADO_PAT_KEYVAULT_SECRET_URI:
            "https://sample-kv.vault.azure.net/secrets/git-cache-ado-pat/version-1",
        }),
      ),
    /versioned secret URIs are not supported/,
  );
});

test("git-cache rejects invalid node-pool and Key Vault inputs", () => {
  assert.throws(
    () => configureEnv(gitCacheEnv({ NODE_POOL_NAME: "invalid-pool-name" })),
    /NODE_POOL_NAME/,
  );
  assert.throws(
    () => configureEnv(gitCacheEnv({
      ADO_PAT_KEYVAULT_SECRET_URI: "https://example.test/not-a-secret",
    })),
    /must match/,
  );
});

test("Windows git-cache requires an explicit published image or image tag", () => {
  const implicitEnv = gitCacheEnv({
    WORKER_OS: "windows",
    NODE_POOL_NAME: "win001",
    ACR_LOGIN_SERVER: "example.azurecr.io",
  });
  assert.throws(
    () =>
      configureEnv(implicitEnv, {
        phase: "manifests",
        imageTag: "dev-implicit",
      }),
    /explicit --image-tag/,
  );

  const explicitEnv = gitCacheEnv({
    WORKER_OS: "windows",
    NODE_POOL_NAME: "win001",
    ACR_LOGIN_SERVER: "example.azurecr.io",
  });
  configureEnv(explicitEnv, {
    phase: "manifests",
    imageTag: "published-tag",
    imageTagExplicit: true,
  });
  assert.equal(
    explicitEnv.GIT_CACHE_IMAGE,
    "example.azurecr.io/pilotswarm-worker-win:published-tag",
  );
});

test("git-cache enforces OS-specific AKS node-pool name limits", () => {
  assert.doesNotThrow(() =>
    configureEnv(gitCacheEnv({ NODE_POOL_NAME: "linuxpool123" })),
  );
  assert.throws(
    () =>
      configureEnv(
        gitCacheEnv({
          WORKER_OS: "windows",
          NODE_POOL_NAME: "winpool1",
        }),
      ),
    /1-6 .* for windows node pools/,
  );
  assert.doesNotThrow(() =>
    configureEnv(
      gitCacheEnv({
        WORKER_OS: "windows",
        NODE_POOL_NAME: "win001",
      }),
    ),
  );
});

test("git-cache rejects a cache root outside the mounted hostPath", () => {
  assert.throws(
    () => configureEnv(gitCacheEnv({ CACHE_ROOT: "/other-path" })),
    /CACHE_ROOT must be '\/mnt\/git-cache'/,
  );
});

test("git-cache rejects a mismatched instance and repository name", () => {
  assert.throws(
    () => configureEnv(gitCacheEnv({ DEPLOY_INSTANCE: "other-repo" })),
    /must match REPO_NAME/,
  );
});

test("git-cache uses an instance-isolated manifest container", () => {
  assert.equal(
    manifestContainerName("git-cache", { DEPLOY_INSTANCE: "sample-repo" }),
    "git-cache-sample-repo-manifests",
  );
  assert.equal(manifestContainerName("worker", {}), "worker-manifests");
});

test("git-cache rollout resolves to its instance DaemonSet and Flux config", () => {
  assert.deepEqual(
    resolveRolloutSpec({
      service: "git-cache",
      env: { DEPLOY_INSTANCE: "sample-repo", GIT_CACHE_OS: "windows" },
    }),
    {
      resourceName: "git-cache-sample-repo-windows",
      resourceKind: "daemonset",
      namespace: "pilotswarm",
      kustomizationName: "git-cache-sample-repo-git-cache-sample-repo",
      verifyImage: false,
      expectedImage: null,
      prerequisites: [],
      timeout: "30m",
    },
  );
});

test("instance-qualified ARM deployment names stay within Azure's limit", () => {
  const raw = `git-cache-${"a".repeat(40)}-${"b".repeat(12)}-westus3`;
  const bounded = boundedDeploymentName(raw);
  assert.equal(bounded.length, 64);
  assert.equal(bounded, boundedDeploymentName(raw));
  assert.match(bounded, /-[a-f0-9]{8}$/);
});
