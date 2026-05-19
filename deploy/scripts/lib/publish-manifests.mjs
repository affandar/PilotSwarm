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
//
// === Publish ordering: upload-then-delete (FR-006, atomicity) ==============
//
// The previous order (delete-stale-first, then upload-batch) left a window
// between the delete and the subsequent upload where the manifest tree in
// blob storage was missing required files. If Flux reconciled inside that
// window, it would either fail the apply or partially reconcile a half-
// deleted tree.
//
// New order:
//   1. Upload every local blob FIRST (overwrite-in-place; individual blob
//      writes are atomic per Azure Blob semantics).
//   2. Re-list the container AFTER all uploads succeed, compute `toDelete`
//      as remote - local, and delete each stale blob with 3 retries
//      (1s/2s/4s exponential backoff).
//   3. If any upload throws, abort BEFORE the delete step — leaves the
//      prior tree intact, no partial state visible to Flux.
//   4. If a delete fails after all 3 retries are exhausted, throw with a
//      structured error listing the orphaned blob paths. Do not swallow
//      as a warning — orphan ghosts in Flux's source bucket are a real
//      failure, not noise.
//
// Trade-off accepted: a brief window of "extra files" rather than the
// prior "missing files" window. Flux + Kustomize tolerate extras
// transiently (orphan k8s resources are pruned by reconciliation), but
// reconciling against a missing-required file aborts the apply.

import { run, log } from "./common.mjs";

// Sleep helper for retry backoff. Exposed for test injection.
async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Delete one blob with 3 retries (1s, 2s, 4s exponential backoff). On
// exhaustion, throws with an `orphanedBlob` property attached for callers
// that want to aggregate the failure set. Pulled out for unit-test reach
// via runFn / sleepFn injection.
export async function deleteBlobWithRetry({ account, container, blobName, runFn = run, sleepFn = sleep }) {
  const backoffs = [1000, 2000, 4000];
  let lastErr = null;
  for (let attempt = 0; attempt < backoffs.length; attempt++) {
    try {
      runFn("az", [
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
      return; // success
    } catch (e) {
      lastErr = e;
      if (attempt < backoffs.length - 1) {
        log(
          "warn",
          `[publish-manifests] delete '${blobName}' attempt ${attempt + 1}/${backoffs.length} failed: ${e.message}. Retrying in ${backoffs[attempt]}ms.`,
        );
        await sleepFn(backoffs[attempt]);
      }
    }
  }
  const err = new Error(
    `[publish-manifests] failed to delete blob '${blobName}' after ${backoffs.length} retries: ${lastErr?.message ?? lastErr}`,
  );
  err.orphanedBlob = blobName;
  err.cause = lastErr;
  throw err;
}

export async function publishManifests({ service, envName, env, stagedServiceRoot }) {
  const account = env.DEPLOYMENT_STORAGE_ACCOUNT_NAME;
  if (!account) {
    throw new Error(
      "DEPLOYMENT_STORAGE_ACCOUNT_NAME must be set " +
        "(seed in deploy/envs/local/<env>/.env or run --steps bicep first).",
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

  // Step 1: upload-first. Abort the whole publish if upload throws — leaves
  // the prior manifest tree intact in the container (delete step has not
  // run yet, so no half-state is observable to Flux).
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

  // Step 2: re-list and delete stale blobs (remote - local). Each delete
  // gets 3 retries; on exhaustion we fail-loud with orphan paths.
  log("info", `az storage blob list --account-name ${account} --container-name ${container} (post-upload sweep)`);
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
    const orphans = [];
    let firstErr = null;
    for (const blobName of stale) {
      try {
        await deleteBlobWithRetry({ account, container, blobName });
      } catch (e) {
        orphans.push(blobName);
        firstErr ||= e;
      }
    }
    if (orphans.length > 0) {
      throw new Error(
        `[publish-manifests] FR-006 violation: ${orphans.length} stale blob(s) in ` +
          `${account}/${container} could not be deleted after 3 retries each: ` +
          `${orphans.join(", ")}. First failure: ${firstErr?.message ?? firstErr}`,
      );
    }
  }

  log("ok", `Published ${service}/${envName} manifest tree to ${account}/${container}`);
}
