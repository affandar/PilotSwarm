// GitOps manifest staging (Phase 4).
//
// Mirrors deploy/gitops/<service>/ into <staging>/gitops/<service>/ verbatim
// (base + overlays/<variant> directory tree), then overlays the substituted .env
// produced by substitute-env.mjs.
//
// Overlay-variant selection per service (kept in lock-step with each service's
// FluxConfig `kustomizationPath` in the corresponding bicep):
//
//   worker, cert-manager, cert-manager-issuers
//     → single `default` overlay (per-env values flow in via the staged .env
//       so a per-env directory split adds no value)
//   portal (Phase 2)
//     → combo-keyed: `${EDGE_MODE}-${TLS_SOURCE simplified}`
//       (`afd-letsencrypt`, `afd-akv`, `private-akv`; `akv-selfsigned`
//       collapses to `akv` because it shares the `private-akv` overlay)

import { cpSync, existsSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, log } from "./common.mjs";
import { substituteOverlayEnv } from "./substitute-env.mjs";
import { computeSpcKeysHash } from "./spc-keys-hash.mjs";

// Files inside the staged GitOps tree that contain `__PLACEHOLDER__`-style
// tokens which need substitution against the env map. Each entry maps a
// service-relative path → array of placeholder→envKey rules.
//
// Why an allow-list (not blanket scan): GitOps base files are otherwise
// passed through verbatim (yaml/json/toml). A targeted list keeps the
// substitution surface explicit and grep-able. To extend, add a new entry
// here and a `__PLACEHOLDER__` token in the matching base file.
//
// Empty / unset env values are tolerated: the placeholder stays unresolved
// in the staged file, the catalog provider that references the missing
// env var fails its own load at runtime, and the stamp degrades to its
// remaining providers. This matches the worker's `env:VAR` resolver
// semantics (a referenced-but-unset env var disables the provider).
const PLACEHOLDER_FILES = {
  worker: [
    {
      relPath: "base/model_providers.json",
      tokens: [
        // Foundry data-plane endpoint, emitted by base-infra (see
        // foundry.bicep / FOUNDRY_ENDPOINT alias). Empty when the stamp
        // has foundryEnabled=false → token stays in the file → catalog
        // load skips the Foundry providers at runtime. Trailing slash
        // safety: Foundry's `endpoint` output ends in `/`, the catalog
        // appends `/openai/v1` → we collapse `//` to `/` after
        // substitution.
        { placeholder: "__FOUNDRY_ENDPOINT__", envKey: "FOUNDRY_ENDPOINT" },
      ],
    },
  ],
  // Portal mirrors worker's catalog: stage-manifests copies the same
  // model_providers.json from worker/base into portal staging tree so
  // PilotSwarmManagementClient.listModels() in the portal returns the
  // same set of models. The Foundry endpoint substitution applies the
  // same way.
  portal: [
    {
      relPath: "base/model_providers.json",
      tokens: [
        { placeholder: "__FOUNDRY_ENDPOINT__", envKey: "FOUNDRY_ENDPOINT" },
      ],
    },
  ],
};

function applyPlaceholderRules({ service, stagedServiceRoot, env }) {
  const rules = PLACEHOLDER_FILES[service];
  if (!rules || rules.length === 0) return;
  for (const fileRule of rules) {
    const abs = join(stagedServiceRoot, fileRule.relPath);
    if (!existsSync(abs)) {
      // Skip silently — the base layout may legitimately omit a file in
      // some configurations (e.g. portal not yet wired with a catalog).
      continue;
    }
    let body = readFileSync(abs, "utf8");
    let resolved = 0;
    let unresolved = 0;
    for (const { placeholder, envKey } of fileRule.tokens) {
      if (!body.includes(placeholder)) continue;
      const raw = env[envKey];
      const value = raw == null ? "" : String(raw);
      if (value === "") {
        unresolved++;
        continue;
      }
      // Strip trailing slash so `<endpoint>/openai/v1` stays clean.
      const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
      body = body.split(placeholder).join(normalized);
      resolved++;
    }
    writeFileSync(abs, body);
    log(
      "info",
      `[stage-manifests] ${fileRule.relPath}: substituted ${resolved} placeholder(s)` +
        (unresolved > 0 ? `, ${unresolved} left unresolved (env values empty/unset)` : ""),
    );
  }
}

// Resolve which overlay directory under deploy/gitops/<service>/overlays/
// the deploy script should substitute + stage. Mirrors the bicep
// `kustomizationPath` for each service. Exported for testability.
export function resolveOverlayName({ service, envName, env }) {
  if (service === "portal") {
    const edgeMode = (env.EDGE_MODE || "afd").toLowerCase();
    const rawTls = (env.TLS_SOURCE || "letsencrypt").toLowerCase();
    // akv-selfsigned shares the private-akv overlay (the only delta is
    // the AKV issuer name, set by Portal bicep — kustomize sees nothing
    // different). Keep this in lock-step with Portal/bicep/main.bicep
    // `kustomizationPath`.
    const tlsSource = rawTls === "akv-selfsigned" ? "akv" : rawTls;
    return `${edgeMode}-${tlsSource}`;
  }
  // worker, cert-manager, cert-manager-issuers all use a single overlay.
  // envName is unused but retained in the signature for symmetry / future use.
  return "default";
}

// Stage <service> into <stagingDir>/gitops/<service>/. Returns the absolute
// path to the staged service tree (which is what publish-manifests uploads).
export function stageManifests({ service, envName, env, stagingDir }) {
  const srcRoot = join(REPO_ROOT, "deploy", "gitops", service);
  if (!existsSync(srcRoot)) {
    throw new Error(`GitOps tree missing for service '${service}': ${srcRoot}`);
  }

  const stagedServiceRoot = join(stagingDir, "gitops", service);

  // Deterministic regeneration (EC-9): wipe the prior staged tree.
  if (existsSync(stagedServiceRoot)) rmSync(stagedServiceRoot, { recursive: true, force: true });
  mkdirSync(stagedServiceRoot, { recursive: true });

  // Copy verbatim (Node 20+ stdlib).
  cpSync(srcRoot, stagedServiceRoot, { recursive: true });
  log("info", `Staged ${srcRoot} → ${stagedServiceRoot}`);

  // Portal needs the same model catalog as the worker so its
  // PilotSwarmManagementClient.listModels() returns the same set. Single
  // source of truth lives at deploy/gitops/worker/base/model_providers.json;
  // we copy it into the portal staging tree before kustomize runs. The
  // portal/base/kustomization.yaml configMapGenerator references this
  // file. Local `kustomize build` on the source tree will fail (file
  // intentionally absent) — all real builds go through deploy.mjs →
  // stage-manifests first.
  if (service === "portal") {
    const workerCatalog = join(REPO_ROOT, "deploy", "gitops", "worker", "base", "model_providers.json");
    const portalCatalog = join(stagedServiceRoot, "base", "model_providers.json");
    if (!existsSync(workerCatalog)) {
      throw new Error(
        `Cannot stage portal: worker catalog missing at ${workerCatalog}. ` +
          `Portal model_providers.json is sourced from the worker base.`,
      );
    }
    cpSync(workerCatalog, portalCatalog);
    log("info", `Staged worker model_providers.json → portal/base/model_providers.json`);
  }

  // Substitute the per-service overlay .env in place inside the staged
  // tree. See `resolveOverlayName` above for the per-service rule.
  const overlayName = resolveOverlayName({ service, envName, env });
  const overlaySrc = join(srcRoot, "overlays", overlayName, ".env");
  const overlayDst = join(stagedServiceRoot, "overlays", overlayName, ".env");
  if (!existsSync(overlaySrc)) {
    throw new Error(
      `Overlay .env missing for ${service}/${overlayName}: ${overlaySrc}\n` +
        `(env '${envName}' resolved overlay='${overlayName}' for service '${service}'` +
        (service === "portal"
          ? `; derived from EDGE_MODE='${env.EDGE_MODE || "afd"}' + TLS_SOURCE='${env.TLS_SOURCE || "letsencrypt"}'`
          : "") +
        `)`,
    );
  }
  // Stamp the SPC-keys hash into the env map for services that have a
  // SecretProviderClass + envFrom pattern. The kustomize replacements
  // component reads `data.SPC_KEYS_HASH` from the generated env ConfigMap
  // and writes it into the Deployment pod-template annotation, forcing
  // a rolling update whenever the SPC's projected key set changes. See
  // deploy/scripts/lib/spc-keys-hash.mjs for the full rationale.
  if (service === "worker" || service === "portal") {
    env.SPC_KEYS_HASH = computeSpcKeysHash({ service });
  }

  // The cp above already produced a copy at overlayDst; we now overwrite it
  // with the substituted version.
  const { substituted } = substituteOverlayEnv({
    srcPath: overlaySrc,
    dstPath: overlayDst,
    envMap: env,
  });
  log("ok", `Substituted ${substituted.length} overlay .env keys → ${overlayDst}`);

  // Apply placeholder substitution to allow-listed base files (e.g.
  // model_providers.json's __FOUNDRY_ENDPOINT__).
  applyPlaceholderRules({ service, stagedServiceRoot, env });

  return stagedServiceRoot;
}
