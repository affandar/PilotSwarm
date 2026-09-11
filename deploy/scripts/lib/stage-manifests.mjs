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
import { loadDeployManifest, resolveEnvTemplate } from "./services-manifest.mjs";

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
      relPath: "base/deployment.yaml",
      tokens: [
        { placeholder: "__WORKER_REPLICAS__", envKey: "WORKER_REPLICAS" },
      ],
    },
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
        {
          placeholder: "__FOUNDRY_ENDPOINT__",
          envKey: "FOUNDRY_ENDPOINT",
          trimTrailingSlash: true,
        },
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
        {
          placeholder: "__FOUNDRY_ENDPOINT__",
          envKey: "FOUNDRY_ENDPOINT",
          trimTrailingSlash: true,
        },
      ],
    },
    // FR-013: Substitute the portal TLS cert name into the tls-akv +
    // edge-appgw components. Source of truth is the `portalTlsCertName`
    // bicep param → FR-022 OUTPUT_ALIAS (`portalTlsCertName: "PORTAL_TLS_CERT_NAME"`)
    // → env map. Defaulted to `pilotswarm-portal-tls` in stageManifests()
    // below for kustomize-build-only paths that never invoke bicep.
    {
      relPath: "components/tls-akv/secret-provider-class-tls.yaml",
      tokens: [
        { placeholder: "__PORTAL_TLS_CERT_NAME__", envKey: "PORTAL_TLS_CERT_NAME" },
      ],
    },
    {
      relPath: "components/tls-akv/kustomization.yaml",
      tokens: [
        { placeholder: "__PORTAL_TLS_CERT_NAME__", envKey: "PORTAL_TLS_CERT_NAME" },
      ],
    },
    {
      relPath: "components/edge-appgw/kustomization.yaml",
      tokens: [
        { placeholder: "__PORTAL_TLS_CERT_NAME__", envKey: "PORTAL_TLS_CERT_NAME" },
      ],
    },
  ],
  "git-repo-worker": [
    {
      relPath: "base/model_providers.json",
      tokens: [
        {
          placeholder: "__FOUNDRY_ENDPOINT__",
          envKey: "FOUNDRY_ENDPOINT",
          trimTrailingSlash: true,
        },
      ],
    },
  ],
};

function appendOverlayEnvMaps({ service, serviceManifest, overlayDst, env }) {
  const mapKeys = serviceManifest?.gitops?.overlayEnvMaps ?? [];
  if (mapKeys.length === 0) return;

  const existing = readFileSync(overlayDst, "utf8");
  const existingKeys = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Z_][A-Z0-9_]*)=/)?.[1])
      .filter(Boolean),
  );
  const appended = [];
  for (const mapKey of mapKeys) {
    const raw = String(env[mapKey] ?? "").trim();
    if (!raw) continue;
    for (const pair of raw.split(";")) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const separator = trimmed.indexOf("=");
      if (separator < 1) {
        throw new Error(
          `[stage-manifests] ${service} ${mapKey} entry is not NAME=value: '${trimmed}'.`,
        );
      }
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1);
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
        throw new Error(
          `[stage-manifests] ${service} ${mapKey} has invalid env name '${key}'.`,
        );
      }
      if (existingKeys.has(key)) {
        throw new Error(
          `[stage-manifests] ${service} ${mapKey} cannot override declared overlay key '${key}'.`,
        );
      }
      existingKeys.add(key);
      appended.push(`${key}=${value}`);
    }
  }
  if (appended.length > 0) {
    writeFileSync(
      overlayDst,
      `${existing.replace(/\s*$/, "")}\n${appended.join("\n")}\n`,
    );
    log("ok", `Appended ${appended.length} ${service} deployment-defined env value(s)`);
  }
}

function applyPlaceholderRules({ service, serviceManifest, stagedServiceRoot, env }) {
  const manifestRules = (serviceManifest?.gitops?.placeholders ?? []).map((rule) => ({
    relPath: rule.path,
    required: rule.required,
    tokens: rule.envKeys.map((envKey) => ({
      placeholder: `__${envKey}__`,
      envKey,
    })),
  }));
  const rules = [...(PLACEHOLDER_FILES[service] ?? []), ...manifestRules];
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
    for (const { placeholder, envKey, trimTrailingSlash = false } of fileRule.tokens) {
      if (!body.includes(placeholder)) continue;
      const raw = env[envKey];
      const value = raw == null ? "" : String(raw);
      if (value === "") {
        unresolved++;
        continue;
      }
      const normalized = trimTrailingSlash && value.endsWith("/")
        ? value.slice(0, -1)
        : value;
      body = body.split(placeholder).join(normalized);
      resolved++;
    }
    writeFileSync(abs, body);
    if (fileRule.required && unresolved > 0) {
      const missing = fileRule.tokens
        .filter(({ placeholder, envKey }) => body.includes(placeholder) && !env[envKey])
        .map(({ envKey }) => envKey);
      throw new Error(
        `[stage-manifests] ${service}/${fileRule.relPath} requires: ${missing.join(", ")}.`,
      );
    }
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
    // Hard-fail when EDGE_MODE or TLS_SOURCE is missing from the env Map.
    // The silent default was a footgun — operators got an unexpected
    // overlay when they forgot to scaffold the env. The pre-deploy
    // contract gate in deploy.mjs (overlay-contracts validateRequiredEnv)
    // catches the same class of error for the deploy path, but stage-
    // manifests can also be called from rendering paths that bypass
    // deploy (e.g. CI scaffolds), so we keep an independent guard here.
    // See deploy/scripts/lib/overlay-contracts.mjs for the per-overlay
    // roster of inputs.
    if (!env.EDGE_MODE || !env.TLS_SOURCE) {
      const missing = [
        !env.EDGE_MODE ? "EDGE_MODE" : null,
        !env.TLS_SOURCE ? "TLS_SOURCE" : null,
      ].filter(Boolean).join(", ");
      throw new Error(
        `[stage-manifests] ${missing} must be set in deploy/envs/local/${envName}/.env ` +
          `for the portal overlay. The previous silent default ` +
          `(EDGE_MODE=afd, TLS_SOURCE=letsencrypt) has been removed ` +
          `(see deploy/scripts/lib/overlay-contracts.mjs for the per-overlay roster).`,
      );
    }
    const edgeMode = env.EDGE_MODE.toLowerCase();
    const rawTls = env.TLS_SOURCE.toLowerCase();
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
  const serviceManifest = loadDeployManifest().services[service];
  const sourceService = resolveEnvTemplate(
    serviceManifest?.gitops?.source ?? service,
    env,
    `${service} gitops.source`,
    { SERVICE: service },
  );
  const srcRoot = join(REPO_ROOT, "deploy", "gitops", sourceService);
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
  if (service === "portal" || service === "git-repo-worker") {
    const workerCatalog = join(REPO_ROOT, "deploy", "gitops", "worker", "base", "model_providers.json");
    const targetCatalog = join(stagedServiceRoot, "base", "model_providers.json");
    if (!existsSync(workerCatalog)) {
      throw new Error(
        `Cannot stage ${service}: worker catalog missing at ${workerCatalog}.`,
      );
    }
    cpSync(workerCatalog, targetCatalog);
    log(
      "info",
      `Staged worker model_providers.json → ${service}/base/model_providers.json`,
    );
  }

  // Substitute the per-service overlay .env in place inside the staged
  // tree. See `resolveOverlayName` above for the per-service rule.
  const overlayName = serviceManifest?.gitops?.overlay
    ? resolveEnvTemplate(
        serviceManifest.gitops.overlay,
        env,
        `${service} gitops.overlay`,
        { SERVICE: service },
      )
    : resolveOverlayName({ service, envName, env });
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
  if (
    service === "worker" ||
    service === "portal" ||
    service === "git-repo-worker"
  ) {
    env.SPC_KEYS_HASH = computeSpcKeysHash({ service });
  }

  // FR-013: Default PORTAL_TLS_CERT_NAME so kustomize-build-only paths
  // (gitops-build tests, local renders, deploys that skip --steps=bicep)
  // still produce a coherent SPC + Ingress. Production deploys override
  // this from the portal bicep `portalTlsCertName` param via FR-022
  // OUTPUT_ALIAS (`portalTlsCertName: "PORTAL_TLS_CERT_NAME"`).
  if (service === "portal" && !env.PORTAL_TLS_CERT_NAME) {
    env.PORTAL_TLS_CERT_NAME = "pilotswarm-portal-tls";
  }

  // The cp above already produced a copy at overlayDst; we now overwrite it
  // with the substituted version.
  const { substituted } = substituteOverlayEnv({
    srcPath: overlaySrc,
    dstPath: overlayDst,
    envMap: env,
    optionalKeys: serviceManifest?.gitops?.optionalEnvKeys ?? [],
  });
  log("ok", `Substituted ${substituted.length} overlay .env keys → ${overlayDst}`);
  appendOverlayEnvMaps({ service, serviceManifest, overlayDst, env });

  // Apply placeholder substitution to allow-listed base files (e.g.
  // model_providers.json's __FOUNDRY_ENDPOINT__).
  applyPlaceholderRules({ service, serviceManifest, stagedServiceRoot, env });

  return stagedServiceRoot;
}
