// Service-level image and Bicep wiring.
//
// Historically these were hardcoded constants. As of the OSS deploy-manifest
// refactor, they are DERIVED at module-load time from
// `deploy/services/deploy-manifest.json` + `deploy/services/<svc>/deploy.json`
// via `services-manifest.mjs`. Existing exports are preserved so consumers
// (`deploy.mjs`, `deploy-bicep.mjs`, `push-image.mjs`, tests) need no change.
//
// To inspect or modify the source of truth, edit the JSON files. To add a new
// service, drop a `deploy/services/<svc>/deploy.json` and list it under
// `infraOrder` or `services` in the root manifest.

import { loadDeployManifest } from "./services-manifest.mjs";

const _m = loadDeployManifest();

// Services that produce a container image, plus how to build it.
// Source: each per-service deploy.json with an `image` block.
export const SERVICE_IMAGE_INFO = Object.fromEntries(
  Object.entries(_m.services)
    .filter(([, svc]) => svc.image != null)
    .map(([name, svc]) => [
      name,
      {
        dockerImageRepo: svc.image.repo,
        dockerfile: svc.image.dockerfile,
        buildWorkspaces: svc.image.buildWorkspaces ?? ["packages/sdk"],
      },
    ]),
);

// Service → ordered Bicep modules to deploy (single-service mode). For app
// services this includes their dependencies (BaseInfra) so a stand-alone
// `deploy worker` invocation guarantees the cluster is up to date.
export const SERVICE_TO_MODULES = Object.fromEntries(
  Object.entries(_m.services).map(([name, svc]) => [
    name,
    svc.bicep.modules.map((m) => m.name),
  ]),
);

// Module → az deployment scope. Built up by walking every module entry across
// all services; consistency (a module always has the same scope) is enforced
// by the manifest validator.
export const MODULE_SCOPE = (() => {
  const scope = {};
  for (const svc of Object.values(_m.services)) {
    const all = [...svc.bicep.modules, ...(svc.bicep.allModeModules ?? [])];
    for (const m of all) scope[m.name] = m.scope;
  }
  return scope;
})();

// Canonical end-to-end bring-up sequence for `deploy.mjs all <env>`. Comes
// straight from the manifest's infraOrder + services.
export const ALL_SEQUENCE = [..._m.allSequence];

// In `all` mode, each service's Bicep step deploys ONLY its own module —
// dependencies were already deployed by an earlier item in the sequence within
// the same invocation. This avoids redundant idempotent re-deploys.
export const ALL_MODE_MODULES = Object.fromEntries(
  Object.entries(_m.services).map(([name, svc]) => [
    name,
    (svc.bicep.allModeModules ?? svc.bicep.modules).map((m) => m.name),
  ]),
);
