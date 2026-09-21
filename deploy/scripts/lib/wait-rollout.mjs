// Rollout verification (Phase 5, FR-010).
//
// For app services with a `rollout` block in their deploy.json: forces Flux to
// pull the just-uploaded Bucket artifact and apply it, waits for the Deployment
// to roll out, and verifies the live image tag matches what we expected to push.
//
// Why `flux reconcile` instead of `kubectl wait kustomization --for=condition=Ready`:
// the Ready condition is sticky — it remains True from the prior reconciliation
// against the *previous* Bucket revision, so `kubectl wait` can return
// immediately while the Bucket source is still polling for the blobs we just
// uploaded (default poll interval is 2m). `flux reconcile kustomization X
// --with-source` blocks until the source is re-fetched AND the kustomization
// applies that new revision, which is the actual condition the script needs
// before asserting on live image tags.
//
// For services without a `rollout` block (infra-only): no-op.
//
// Kubeconfig hygiene: we acquire AKS credentials into a per-env file under
// `<stagingDir>/kubeconfig` and pass that via the `KUBECONFIG` env var to all
// kubectl invocations. We never touch the user's `~/.kube/config`, so a
// developer who already has another cluster as their `current-context` won't
// have it silently overwritten by `az aks get-credentials`.

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { run, log } from "./common.mjs";
import { loadDeployManifest } from "./services-manifest.mjs";
import { applyPrivateModePostDeploy } from "./private-mode-postdeploy.mjs";

const FLUX_NAMESPACE = "flux-system";
const ROLLOUT_TIMEOUT = "10m";

function rolloutFor(service) {
  const m = loadDeployManifest();
  return m.services[service]?.rollout ?? null;
}

export async function waitRollout({ service, envName, env, imageTag, stagingDir }) {
  const rollout = rolloutFor(service);
  if (!rollout) {
    log("info", `No Deployments for service '${service}'; skipping rollout wait.`);
    return;
  }
  const deployName = rollout.deployment;

  const namespace = env.NAMESPACE;
  if (!namespace) {
    throw new Error(
      `NAMESPACE is empty in the env map; cannot wait for rollout of ${service}.`,
    );
  }

  const kubeEnv = ensureKubeContext(env, stagingDir);

  // Azure FluxConfig wraps each kustomization key as `<configName>-<key>`.
  // Our `flux-config.bicep` passes `configName` as both the FluxConfig name
  // and the single kustomization key, so the resulting Kustomization is
  // named `<service>-<service>` (e.g. `worker-worker`).
  const kustomizationName = `${service}-${service}`;

  // 1) Force Flux to pull the just-uploaded Bucket artifact and apply it. We
  //    can't trust `kubectl wait kustomization --for=condition=Ready` here:
  //    Ready is sticky from the prior reconcile, so it returns immediately
  //    against the stale revision while the Bucket source has yet to re-poll.
  //    `flux reconcile --with-source` blocks until the source artifact is
  //    refreshed AND the kustomization applies it (writes a new
  //    `status.lastAppliedRevision`).
  log(
    "info",
    `flux reconcile kustomization ${kustomizationName} -n ${FLUX_NAMESPACE} --with-source --timeout=${ROLLOUT_TIMEOUT}`,
  );
  run(
    "flux",
    [
      "reconcile",
      "kustomization",
      kustomizationName,
      "-n",
      FLUX_NAMESPACE,
      "--with-source",
      `--timeout=${ROLLOUT_TIMEOUT}`,
    ],
    { env: kubeEnv },
  );

  // 2) Now that Flux has applied the manifests, wait for the Deployment to
  //    finish rolling.
  log("info", `kubectl rollout status deployment/${deployName} -n ${namespace} --timeout=${ROLLOUT_TIMEOUT}`);
  run(
    "kubectl",
    [
      "rollout",
      "status",
      `deployment/${deployName}`,
      "-n",
      namespace,
      "--timeout",
      ROLLOUT_TIMEOUT,
    ],
    { env: kubeEnv },
  );

  // 3) Verify live image tag matches what we expected to push.
  const result = run(
    "kubectl",
    [
      "get",
      "deployment",
      deployName,
      "-n",
      namespace,
      "-o",
      "jsonpath={.spec.template.spec.containers[0].image}",
    ],
    { capture: true, env: kubeEnv },
  );
  const liveImage = (result.stdout || "").trim();
  if (!liveImage.endsWith(`:${imageTag}`)) {
    throw new Error(
      `Live image tag mismatch for ${service}/${envName}: deployment shows '${liveImage}' but expected tag '${imageTag}'. ` +
        `The just-pushed image was not applied even after 'flux reconcile --with-source'. ` +
        `Inspect with: 'kubectl describe kustomization/${kustomizationName} -n ${FLUX_NAMESPACE}' and 'flux get sources bucket -n ${FLUX_NAMESPACE}'.`,
    );
  }
  log("ok", `Rollout verified: ${service} → ${liveImage}`);

  // Portal in private mode: patch the web-app-routing addon's default
  // NginxIngressController CR for an internal LB, wait for the ILB IP,
  // and upsert the Private DNS Zone A record for HOST -> ILB. afd-mode
  // and non-portal services no-op.
  if (service === "portal" && env.EDGE_MODE === "private") {
    await applyPrivateModePostDeploy({ env, kubeEnv });
  }
}

// Acquire AKS credentials into a per-env kubeconfig file and return a
// `process.env`-shaped object with `KUBECONFIG` pointing at it. The user's
// global `~/.kube/config` is left untouched — important when a developer is
// also actively working with other clusters from the same shell. Returns the
// caller's process.env unchanged when AKS_CLUSTER_NAME or RESOURCE_GROUP are
// missing; the surrounding kubectl call's error will surface naturally.
function ensureKubeContext(env, stagingDir) {
  const cluster = env.AKS_CLUSTER_NAME;
  const rg = env.RESOURCE_GROUP;
  if (!cluster || !rg) {
    log(
      "info",
      "Skipping az aks get-credentials (AKS_CLUSTER_NAME or RESOURCE_GROUP not set in env map)",
    );
    return process.env;
  }
  if (!stagingDir) {
    throw new Error("ensureKubeContext: stagingDir is required to write a per-env kubeconfig.");
  }
  mkdirSync(stagingDir, { recursive: true });
  const kubeconfigPath = join(stagingDir, "kubeconfig");
  log(
    "info",
    `az aks get-credentials -g ${rg} -n ${cluster} --file ${kubeconfigPath} --overwrite-existing`,
  );
  run("az", [
    "aks",
    "get-credentials",
    "--resource-group",
    rg,
    "--name",
    cluster,
    "--file",
    kubeconfigPath,
    "--overwrite-existing",
    "-o",
    "none",
  ]);
  return { ...process.env, KUBECONFIG: kubeconfigPath };
}
