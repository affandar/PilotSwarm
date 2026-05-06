// Post-deploy wiring for EDGE_MODE=private (Phase 2 follow-up).
//
// Two responsibilities, both deferred from bicep because the inputs aren't
// known until AKS is up + Flux has applied the Portal manifests:
//
//   1. Patch the AKS web-app-routing addon's default NginxIngressController
//      CR so its LoadBalancer Service is exposed as an internal-only ILB
//      (annotation `service.beta.kubernetes.io/azure-load-balancer-internal`
//      = "true"). Bicep can't own this — the CR is reconciled by the addon
//      operator after the cluster comes up, not declared as a bicep
//      resource.
//
//   2. Resolve the addon's LB Service IP (now internal) and write/refresh
//      an A record on the Private DNS Zone provisioned by Portal bicep.
//      Idempotent: removes any stale record-set first, then re-creates.
//
// Run only on the Portal rollout in private mode. afd-mode portal rollouts
// no-op this helper.

import { run, log } from "./common.mjs";

const APP_ROUTING_NS = "app-routing-system";
const NGINX_CR_NAME = "default";
const NGINX_SVC_NAME = "nginx";
// `kubectl wait` cannot wait on an arbitrary jsonpath being non-empty
// across all kubectl versions; we poll instead. 10 minutes is generous —
// the addon usually patches the Service in under a minute.
const ILB_POLL_INTERVAL_SEC = 5;
const ILB_POLL_TIMEOUT_SEC = 600;

export async function applyPrivateModePostDeploy({ env, kubeEnv }) {
  if (env.EDGE_MODE !== "private") return;

  const host = (env.HOST || "").trim();
  const zone = (env.PRIVATE_DNS_ZONE || "").trim();
  const rg = (env.RESOURCE_GROUP || "").trim();
  if (!host || !zone || !rg) {
    throw new Error(
      `applyPrivateModePostDeploy: missing one of HOST='${host}', PRIVATE_DNS_ZONE='${zone}', RESOURCE_GROUP='${rg}'. ` +
        `These are normally populated by new-env / BaseInfra; re-run \`deploy bicep\` first.`,
    );
  }

  log("info", `[private-postdeploy] patching NginxIngressController/${NGINX_CR_NAME} for internal LB`);
  patchInternalLb(kubeEnv);

  log("info", `[private-postdeploy] waiting for ${APP_ROUTING_NS}/${NGINX_SVC_NAME} internal LB IP`);
  const ilbIp = await waitForIlbIp(kubeEnv);
  log("ok", `[private-postdeploy] internal LB IP: ${ilbIp}`);

  log("info", `[private-postdeploy] upserting A record ${host}.${zone} -> ${ilbIp} in RG ${rg}`);
  upsertPrivateDnsARecord({ rg, zone, host, ilbIp });
  log("ok", `[private-postdeploy] private DNS A record reconciled`);
}

function patchInternalLb(kubeEnv) {
  // `kubectl patch --type=merge` is idempotent: if the annotation is
  // already present, it's a no-op. The addon controller reconciles the
  // change onto the underlying Service within seconds.
  const patch = JSON.stringify({
    spec: {
      loadBalancerAnnotations: {
        "service.beta.kubernetes.io/azure-load-balancer-internal": "true",
      },
    },
  });
  run(
    "kubectl",
    [
      "patch",
      "nginxingresscontroller",
      NGINX_CR_NAME,
      "--type=merge",
      "-p",
      patch,
    ],
    { env: kubeEnv },
  );
}

async function waitForIlbIp(kubeEnv) {
  const deadline = Date.now() + ILB_POLL_TIMEOUT_SEC * 1000;
  while (Date.now() < deadline) {
    const probe = run(
      "kubectl",
      [
        "get",
        "svc",
        NGINX_SVC_NAME,
        "-n",
        APP_ROUTING_NS,
        "-o",
        "jsonpath={.status.loadBalancer.ingress[0].ip}",
      ],
      { capture: true, allowFail: true, env: kubeEnv },
    );
    const ip = (probe.stdout || "").trim();
    if (ip && /^[0-9.]+$/.test(ip)) return ip;
    await sleep(ILB_POLL_INTERVAL_SEC * 1000);
  }
  throw new Error(
    `Timed out after ${ILB_POLL_TIMEOUT_SEC}s waiting for ${APP_ROUTING_NS}/${NGINX_SVC_NAME} to receive an internal LB IP. ` +
      `Check 'kubectl describe svc ${NGINX_SVC_NAME} -n ${APP_ROUTING_NS}' for Azure LB events.`,
  );
}

// Idempotent A-record upsert. `az network private-dns record-set a create`
// fails when the record-set already exists, and `add-record` accumulates
// rather than replacing — so we delete-then-recreate. Safe because the
// portal record-set is owned exclusively by this script.
function upsertPrivateDnsARecord({ rg, zone, host, ilbIp }) {
  // Best-effort delete; ignore "not found".
  run(
    "az",
    [
      "network",
      "private-dns",
      "record-set",
      "a",
      "delete",
      "--resource-group",
      rg,
      "--zone-name",
      zone,
      "--name",
      host,
      "--yes",
      "-o",
      "none",
    ],
    { allowFail: true },
  );

  run("az", [
    "network",
    "private-dns",
    "record-set",
    "a",
    "create",
    "--resource-group",
    rg,
    "--zone-name",
    zone,
    "--name",
    host,
    "-o",
    "none",
  ]);

  run("az", [
    "network",
    "private-dns",
    "record-set",
    "a",
    "add-record",
    "--resource-group",
    rg,
    "--zone-name",
    zone,
    "--record-set-name",
    host,
    "--ipv4-address",
    ilbIp,
    "-o",
    "none",
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
