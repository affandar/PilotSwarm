// Pipeline definition + --steps resolver for the OSS Node deploy orchestrator.
//
// Stages run in canonical pipeline order regardless of the order they are passed
// on the command line (FR-003). `noop` is a Phase-1 sentinel that runs only env
// load + preflight checks (validates the entry path on all platforms before any
// real stages exist).

import { loadDeployManifest, pipelineForService } from "./services-manifest.mjs";

// Canonical pipeline order. bicep runs BEFORE push because BaseInfra's outputs
// (ACR_NAME, ACR_LOGIN_SERVER, etc.) are required by push. seed-secrets runs
// after bicep so the Key Vault exists and the deployer has the role assignment
// (granted by Bicep at create time), and before rollout so the worker pods
// can mount the populated secrets via CSI on first start. Real stage modules
// are wired in Phases 2–5.
export const PIPELINE = ["build", "bicep", "seed-secrets", "push", "manifests", "rollout"];

// Default pipeline for a service (FR-008 / FR-010). Sourced from
// deploy/services/<svc>/deploy.json (optional `pipeline` override) +
// deploy/services/deploy-manifest.json defaults.pipelineByKind[kind].
// For infra-only services, the rollout stage is a no-op even if requested.
export function defaultPipelineFor(service) {
  const m = loadDeployManifest();
  const svc = m.services[service];
  if (!svc) return PIPELINE;
  return pipelineForService(svc, m.root);
}

// Parse --steps "a,b,c" into a canonical-ordered list, deduped, validated.
// Allows the special token "noop" only when it is the sole step (Phase 1 sentinel).
export function resolveSteps(stepsArg, service) {
  if (!stepsArg) return defaultPipelineFor(service);
  const requested = stepsArg
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (requested.length === 1 && requested[0] === "noop") return ["noop"];

  const valid = new Set(PIPELINE);
  for (const s of requested) {
    if (!valid.has(s)) {
      throw new Error(
        `Unknown step: '${s}'\nValid steps: ${PIPELINE.join(", ")}, or 'noop'.`,
      );
    }
  }
  // Order requested steps by canonical pipeline order, dedup.
  return PIPELINE.filter((s) => requested.includes(s));
}
