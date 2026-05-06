// SPC keys hash — declarative SPC-vs-Deployment coupling.
//
// Computes a short stable hash from the sorted list of env-var keys that the
// service's SecretProviderClass projects into its synthesized K8s Secret
// (i.e. the `secretObjects[].data[].key` list). The deploy pipeline plumbs
// the result into the overlay-generated env ConfigMap as `SPC_KEYS_HASH`,
// and the per-service `*-replacements` kustomize component substitutes it
// into a pod-template annotation:
//
//   spec.template.metadata.annotations:
//     pilotswarm.dev/spc-keys-hash: <12-char-hex>
//
// Why this exists: `envFrom: secretRef` reads the K8s Secret only at
// container start. When the SPC's projected key set grows in a deploy,
// the CSI driver synthesizes the Secret asynchronously after the volume
// mount returns, racing the new pod's container start. Pods can come up
// with a stale Secret snapshot and miss the new key. By hashing the key
// list and stamping the hash on the pod template, any change to the
// projected key set forces a rolling update — Kubernetes won't see the
// existing pods as matching the new template, so it rolls fresh ones,
// and by the time those new pods schedule, the K8s Secret is already
// stable from the prior pods' mounts.
//
// This addresses Mode 2 of `docs/bugreports/envfrom-secret-staleness-and-secretstore-proposal.md`.
// Mode 1 (value rotation without redeploy) is fixed by the SecretStore
// proposal in that bugreport — out of scope here.
//
// Source-of-truth note: the lists below MUST mirror
// `deploy/gitops/<service>/base/secret-provider-class.yaml`'s
// `secretObjects[].data[].key` entries. Adding/removing a key in either
// place without the other defeats the guarantee. Both files cross-
// reference each other in comments.

import { createHash } from "node:crypto";

// Worker SPC: keys projected from `copilot-worker-secrets`.
// Mirror of deploy/gitops/worker/base/secret-provider-class.yaml
// `secretObjects[0].data[].key`.
const WORKER_SPC_KEYS = [
  "ANTHROPIC_API_KEY",
  "AZURE_OAI_KEY",
  "GITHUB_TOKEN",
];

// Portal SPC: keys projected from `pilotswarm-portal-secrets`.
// Mirror of deploy/gitops/portal/base/secret-provider-class.yaml
// `secretObjects[0].data[].key`.
//
// Why portal carries the same LLM creds as the worker (GITHUB_TOKEN,
// ANTHROPIC_API_KEY, AZURE_OAI_KEY) even though it doesn't invoke models:
// PilotSwarmManagementClient at start filters providers by env-resolvable
// creds and validates the configured defaultModel. Without these the portal
// crashes with "No credentialed models are available after provider
// filtering" on a stamp where defaultModel points at a github-copilot model.
// Mirrors legacy deploy/k8s/portal-deployment.yaml which shared the
// worker's `copilot-runtime-secrets` envFrom.
const PORTAL_SPC_KEYS = [
  "ANTHROPIC_API_KEY",
  "AZURE_OAI_KEY",
  "GITHUB_TOKEN",
  "PORTAL_AUTH_ALLOW_UNAUTHENTICATED",
  "PORTAL_AUTH_ENTRA_ADMIN_GROUPS",
  "PORTAL_AUTH_ENTRA_CLIENT_ID",
  "PORTAL_AUTH_ENTRA_TENANT_ID",
  "PORTAL_AUTH_ENTRA_USER_GROUPS",
  "PORTAL_AUTH_PROVIDER",
  "PORTAL_AUTHZ_ADMIN_GROUPS",
  "PORTAL_AUTHZ_DEFAULT_ROLE",
  "PORTAL_AUTHZ_USER_GROUPS",
];

const SPC_KEYS_BY_SERVICE = {
  worker: WORKER_SPC_KEYS,
  portal: PORTAL_SPC_KEYS,
};

/**
 * Compute the 12-char SPC-keys hash for a service.
 *
 * @param {{ service: "worker" | "portal" | string }} args
 * @returns {string} 12-char lowercase hex digest
 */
export function computeSpcKeysHash({ service }) {
  const keys = SPC_KEYS_BY_SERVICE[service];
  if (!keys) {
    throw new Error(
      `computeSpcKeysHash: unknown service '${service}'. ` +
        `Known services: ${Object.keys(SPC_KEYS_BY_SERVICE).join(", ")}.`,
    );
  }
  // Sort to make the hash invariant of declaration order. The list is
  // already sorted at the source, but defensive against future edits.
  const sorted = [...keys].sort();
  const digest = createHash("sha256").update(sorted.join("\n")).digest("hex");
  return digest.slice(0, 12);
}

// Exported for testing.
export const _SPC_KEYS_BY_SERVICE = SPC_KEYS_BY_SERVICE;
