// Manifest publish to Flux Storage Bucket (Phase 4, FR-009 upload).
//
// Uploads the staged GitOps tree's CONTENTS (not a zip!) to the Azure Storage
// container that the Flux Bucket points at, as individual blobs. The cluster's
// existing Flux Kustomization with `kustomizationPath: ./` reconciles the new
// blob set on its next interval.
//
// Uses `az storage blob upload-batch --auth-mode login` — caller must have
// `Storage Blob Data Contributor` (or higher) on the storage account. The
// BaseInfra Bicep module grants that role at storage-account creation time:
//   - enterprise / production runs:  granted to the enterprise deploy UAMI (enterprise-deploy-rbac.bicep)
//   - Local `npm run deploy`: granted to the signed-in AAD user (storage.bicep
//     conditional role assignment, driven by the `localDeploymentPrincipalId`
//     param that deploy-bicep.mjs populates from `az ad signed-in-user`).
// So this step does not need to do any role assignment of its own.
//
// `--overwrite` is mandatory: Flux config never changes container; we always
// rewrite the same blobs (matches DeployApplicationManifest.sh post-unzip
// semantic). ETags rotate but content hash is identical for unchanged inputs.

import { run, log } from "./common.mjs";

export async function publishManifests({ service, envName, env, stagedServiceRoot }) {
  const account = env.DEPLOYMENT_STORAGE_ACCOUNT_NAME;
  if (!account) {
    throw new Error(
      "DEPLOYMENT_STORAGE_ACCOUNT_NAME must be set " +
        "(seed in deploy/envs/local/<env>/env or run --steps bicep first).",
    );
  }
  // Container name is derived from the service name, not from
  // `DEPLOYMENT_STORAGE_CONTAINER_NAME`. The latter is a single shared env
  // alias for the bicep-emitted `manifestsContainerName` output; with multiple
  // services in one env, the cache holds whichever value the LAST bicep run
  // wrote, so reading it during a `--steps manifests`-only run for a different
  // service uploads to the wrong container. The convention `<service>-manifests`
  // is enforced by every service's main.bicep (cert-manager-manifests,
  // cert-manager-issuers-manifests, worker-manifests, portal-manifests), so we
  // can compute it locally and stay decoupled from cache state.
  const container = `${service}-manifests`;

  // Enumerate the local source tree (blob keys are POSIX-relative paths).
  const { readdirSync, statSync } = await import("node:fs");
  const { join, posix, sep } = await import("node:path");
  function walk(dir, base = "") {
    const out = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = base ? `${base}/${name}` : name;
      const st = statSync(full);
      if (st.isDirectory()) out.push(...walk(full, rel));
      else out.push(rel.split(sep).join(posix.sep));
    }
    return out;
  }
  const localBlobs = new Set(walk(stagedServiceRoot));

  // Enumerate destination blobs and delete any that are not in the local tree.
  // `upload-batch --overwrite` only overwrites collisions; it leaves stale
  // blobs in place. That previously caused mixed manifest trees when a
  // container had been written to by a different (incorrect) service.
  log("info", `az storage blob list --account-name ${account} --container-name ${container} (delete-first sync)`);
  const listResult = run(
    "az",
    [
      "storage",
      "blob",
      "list",
      "--auth-mode",
      "login",
      "--account-name",
      account,
      "--container-name",
      container,
      "--query",
      "[].name",
      "-o",
      "tsv",
    ],
    { capture: true },
  );
  const remoteBlobs = listResult.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const stale = remoteBlobs.filter((b) => !localBlobs.has(b));
  if (stale.length > 0) {
    log("info", `Deleting ${stale.length} stale blob(s) from ${account}/${container}`);
    for (const blobName of stale) {
      run("az", [
        "storage",
        "blob",
        "delete",
        "--auth-mode",
        "login",
        "--account-name",
        account,
        "--container-name",
        container,
        "--name",
        blobName,
      ]);
    }
  }

  log(
    "info",
    `az storage blob upload-batch (account=${account}, container=${container}, source=${stagedServiceRoot})`,
  );
  run("az", [
    "storage",
    "blob",
    "upload-batch",
    "--auth-mode",
    "login",
    "--account-name",
    account,
    "--destination",
    container,
    "--source",
    stagedServiceRoot,
    "--overwrite",
  ]);
  log("ok", `Published ${service}/${envName} manifest tree to ${account}/${container}`);
}
