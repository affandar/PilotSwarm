// Post-deploy wiring for EDGE_MODE=afd (AGIC first-boot RBAC-race recovery).
//
// On a fresh stamp, AKS brings up the AGIC (Application Gateway Ingress
// Controller) addon pod at roughly the same moment BaseInfra bicep creates
// AGIC's role assignments (Contributor on the AppGw, Reader on its RG — see
// services/base-infra/bicep/agic-rbac.bicep). Azure RBAC propagation lags by
// minutes, so AGIC's first reconcile 403s ("ErrorApplicationGatewayForbidden")
// and it CrashLoopBackOffs. Once the roles land AGIC stops crashing, but with
// no pending Ingress-change event it goes idle and never programs the portal
// Ingress into the AppGw backend pool. The pool stays empty → the AFD origin
// health probe to /api/health fails → the public endpoint returns 504
// indefinitely, even though the portal pod is healthy in-cluster.
//
// Fix: after the portal rollout, verify the AppGw has a Healthy portal
// backend. If it doesn't, force `kubectl rollout restart` on AGIC so it
// re-GETs the (empty) gateway and re-PUTs the backend pool now that its roles
// are in place, then wait for the backend to go Healthy. Idempotent: an
// already-healthy stamp short-circuits before the restart; if we do restart,
// AGIC re-applies identical config and the live listener keeps serving.
//
// Runs only on the Portal rollout in afd mode. private-mode portal rollouts
// no-op this helper (see private-mode-postdeploy.mjs for that path).

import { run, log } from "./common.mjs";

const AGIC_DEPLOYMENT = "ingress-appgw-deployment";
const AGIC_NAMESPACE = "kube-system";
const HEALTH_POLL_INTERVAL_SEC = 10;
// Pre-restart probe: on a warm redeploy the backend is usually already
// Healthy, so a short window short-circuits before any needless restart.
const PRECHECK_TIMEOUT_SEC = 60;
// Post-restart: AGIC reconcile + AppGw on-demand probe can take a couple of
// minutes to flip Healthy on a cold stamp.
const RECOVERY_TIMEOUT_SEC = 300;

export async function applyAfdModePostDeploy({ env, kubeEnv }) {
  if (env.EDGE_MODE !== "afd") return;

  const appGw = (env.APPLICATION_GATEWAY_NAME || "").trim();
  const rg = (env.RESOURCE_GROUP || "").trim();
  if (!appGw || !rg) {
    // afd mode but no AppGw handle in env → BaseInfra bicep outputs weren't
    // merged this run (e.g. `--steps` skipped bicep). Don't fail: the edge
    // may already be healthy from a prior full deploy. Skip verification.
    log(
      "info",
      "[afd-postdeploy] APPLICATION_GATEWAY_NAME/RESOURCE_GROUP not in env map; skipping AGIC backend verification.",
    );
    return;
  }

  log("info", `[afd-postdeploy] verifying AppGw '${appGw}' has a Healthy portal backend`);
  if (await waitForHealthyBackend({ rg, appGw, timeoutSec: PRECHECK_TIMEOUT_SEC })) {
    log("ok", "[afd-postdeploy] AppGw backend already Healthy; AGIC reconcile is good.");
    return;
  }

  log(
    "warn",
    `[afd-postdeploy] AppGw '${appGw}' has no Healthy backend — restarting AGIC to recover from the first-boot RBAC race`,
  );
  run("kubectl", ["rollout", "restart", `deployment/${AGIC_DEPLOYMENT}`, "-n", AGIC_NAMESPACE], {
    env: kubeEnv,
  });
  run(
    "kubectl",
    ["rollout", "status", `deployment/${AGIC_DEPLOYMENT}`, "-n", AGIC_NAMESPACE, "--timeout", "120s"],
    { env: kubeEnv },
  );

  log("info", "[afd-postdeploy] waiting for AGIC to program a Healthy portal backend");
  if (await waitForHealthyBackend({ rg, appGw, timeoutSec: RECOVERY_TIMEOUT_SEC })) {
    log("ok", "[afd-postdeploy] AppGw portal backend Healthy after AGIC restart; edge is green.");
    return;
  }

  throw new Error(
    `[afd-postdeploy] AppGw '${appGw}' still has no Healthy portal backend after restarting AGIC — ` +
      "the public AFD endpoint will return 504. Inspect AGIC's identity grants and logs:\n" +
      `  kubectl logs -n ${AGIC_NAMESPACE} deploy/${AGIC_DEPLOYMENT} --previous  (look for ErrorApplicationGatewayForbidden)\n` +
      `AGIC needs Contributor on the AppGw and Reader on '${rg}' (services/base-infra/bicep/agic-rbac.bicep).`,
  );
}

// Poll AppGw backend health until at least one server reports Healthy or the
// deadline passes. `show-backend-health` triggers an on-demand probe and can
// transiently fail while the gateway is updating, so failures are swallowed
// and retried. Always runs at least one probe even when timeoutSec is 0.
async function waitForHealthyBackend({ rg, appGw, timeoutSec }) {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const probe = run(
      "az",
      [
        "network",
        "application-gateway",
        "show-backend-health",
        "-g",
        rg,
        "-n",
        appGw,
        "--query",
        "backendAddressPools[].backendHttpSettingsCollection[].servers[]",
        "-o",
        "json",
      ],
      { capture: true, allowFail: true },
    );
    if (probe.status === 0) {
      let servers;
      try {
        servers = JSON.parse(probe.stdout || "[]");
      } catch {
        servers = [];
      }
      if (countHealthyServers(servers) > 0) return true;
    }
    if (Date.now() >= deadline) return false;
    await sleep(HEALTH_POLL_INTERVAL_SEC * 1000);
  }
}

// Pure: count backend servers reporting Healthy. Exported for unit tests.
export function countHealthyServers(servers) {
  if (!Array.isArray(servers)) return 0;
  return servers.filter((s) => s && s.health === "Healthy").length;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
