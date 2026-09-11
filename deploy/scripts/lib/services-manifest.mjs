// OSS deploy manifest loader.
//
// Reads deploy/services/deploy-manifest.json + deploy/services/<svc>/deploy.json
// and exposes a single structured object the orchestrator consumes. Stdlib-only
// structural validator (zero deps) — checks shape, enums, references, and the
// invariant that every name in {infraOrder ∪ services ∪ standaloneServices} has a matching
// deploy.json file.
//
// Distinct from the enterprise services.json / service.json files that live alongside
// these in deploy/services/. Those will be migrated to a parent repo via
// submodule; this loader never touches them.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT } from "./common.mjs";

const SERVICES_DIR = join(REPO_ROOT, "deploy", "services");
const ROOT_MANIFEST = join(SERVICES_DIR, "deploy-manifest.json");

// ───────────────────────── Pure validator ─────────────────────────

/** @internal exported for tests */
export function validateRootManifest(obj, path = "deploy-manifest.json") {
  const errs = [];
  if (!obj || typeof obj !== "object") {
    return [`${path}: root must be an object`];
  }
  if (obj.schemaVersion !== 1) errs.push(`${path}: schemaVersion must be 1`);
  for (const key of ["infraOrder", "services", "standaloneServices"]) {
    if (key === "standaloneServices" && obj[key] === undefined) continue;
    if (!Array.isArray(obj[key])) {
      errs.push(`${path}: '${key}' must be an array`);
      continue;
    }
    const seen = new Set();
    for (const v of obj[key]) {
      if (typeof v !== "string" || !/^[a-z][a-z0-9-]*$/.test(v)) {
        errs.push(`${path}: '${key}' contains invalid name '${v}' (lowercase, [a-z0-9-])`);
      }
      if (seen.has(v)) errs.push(`${path}: '${key}' has duplicate '${v}'`);
      seen.add(v);
    }
  }
  const groups = ["infraOrder", "services", "standaloneServices"]
    .filter((key) => Array.isArray(obj[key]));
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      for (const name of obj[groups[i]]) {
        if (obj[groups[j]].includes(name)) {
          errs.push(`${path}: '${name}' appears in both ${groups[i]} and ${groups[j]}`);
        }
      }
    }
  }
  if (obj.regionShort != null) {
    if (typeof obj.regionShort !== "object" || Array.isArray(obj.regionShort)) {
      errs.push(`${path}: 'regionShort' must be an object`);
    } else {
      for (const [k, v] of Object.entries(obj.regionShort)) {
        if (typeof v !== "string" || !/^[a-z0-9]+$/.test(v)) {
          errs.push(`${path}: regionShort['${k}'] must be a lowercase alnum string`);
        }
      }
    }
  }
  if (obj.defaults?.pipelineByKind) {
    const p = obj.defaults.pipelineByKind;
    for (const kind of ["infra", "app"]) {
      if (!Array.isArray(p[kind])) errs.push(`${path}: defaults.pipelineByKind.${kind} must be an array`);
    }
  }
  return errs;
}

const VALID_STEPS = new Set(["build", "push", "bicep", "seed-secrets", "manifests", "rollout"]);
const VALID_SCOPES = new Set(["sub", "group"]);

/** @internal exported for tests */
export function validateServiceManifest(obj, path) {
  const errs = [];
  if (!obj || typeof obj !== "object") return [`${path}: root must be an object`];
  if (obj.schemaVersion !== 1) errs.push(`${path}: schemaVersion must be 1`);
  if (typeof obj.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(obj.name)) {
    errs.push(`${path}: 'name' must be a lowercase identifier`);
  }
  if (!["infra", "app"].includes(obj.kind)) errs.push(`${path}: 'kind' must be 'infra' or 'app'`);

  const checkModules = (arr, label) => {
    if (!Array.isArray(arr) || arr.length === 0) {
      errs.push(`${path}: bicep.${label} must be a non-empty array`);
      return;
    }
    for (const m of arr) {
      if (!m || typeof m !== "object") {
        errs.push(`${path}: bicep.${label} entry must be an object`);
        continue;
      }
      if (typeof m.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(m.name)) {
        errs.push(`${path}: bicep.${label}[].name must be kebab-case`);
      }
      if (!VALID_SCOPES.has(m.scope)) {
        errs.push(`${path}: bicep.${label}[].scope must be 'sub' or 'group'`);
      }
    }
  };
  if (!obj.bicep || typeof obj.bicep !== "object") {
    errs.push(`${path}: 'bicep' is required`);
  } else {
    checkModules(obj.bicep.modules, "modules");
    if (obj.bicep.allModeModules !== undefined) {
      checkModules(obj.bicep.allModeModules, "allModeModules");
    }
  }

  if (obj.image !== undefined) {
    if (!obj.image || typeof obj.image !== "object") errs.push(`${path}: 'image' must be an object`);
    else {
      if (typeof obj.image.repo !== "string") errs.push(`${path}: image.repo must be a string`);
      if (typeof obj.image.dockerfile !== "string") errs.push(`${path}: image.dockerfile must be a string`);
      if (obj.image.buildWorkspaces !== undefined) {
        if (!Array.isArray(obj.image.buildWorkspaces) || obj.image.buildWorkspaces.length === 0) {
          errs.push(`${path}: image.buildWorkspaces must be a non-empty array of workspace paths`);
        } else {
          for (const ws of obj.image.buildWorkspaces) {
            if (typeof ws !== "string" || ws.length === 0) {
              errs.push(`${path}: image.buildWorkspaces entries must be non-empty strings`);
            }
          }
        }
      }
    }
  }
  if (obj.rollout !== undefined) {
    if (!obj.rollout || typeof obj.rollout !== "object") errs.push(`${path}: 'rollout' must be an object`);
    else {
      if (!["Deployment", "DaemonSet"].includes(obj.rollout.kind)) {
        errs.push(`${path}: rollout.kind must be 'Deployment' or 'DaemonSet'`);
      }
      if (typeof obj.rollout.name !== "string" || obj.rollout.name.length === 0) {
        errs.push(`${path}: rollout.name must be a non-empty string`);
      }
      if (typeof obj.rollout.namespace !== "string" || obj.rollout.namespace.length === 0) {
        errs.push(`${path}: rollout.namespace must be a non-empty string`);
      }
      if (
        obj.rollout.fluxConfiguration !== undefined &&
        (typeof obj.rollout.fluxConfiguration !== "string" || obj.rollout.fluxConfiguration.length === 0)
      ) {
        errs.push(`${path}: rollout.fluxConfiguration must be a non-empty string`);
      }
      if (
        obj.rollout.fluxKustomization !== undefined &&
        (typeof obj.rollout.fluxKustomization !== "string" ||
          obj.rollout.fluxKustomization.length === 0)
      ) {
        errs.push(`${path}: rollout.fluxKustomization must be a non-empty string`);
      }
      if (
        obj.rollout.verifyImage !== undefined &&
        typeof obj.rollout.verifyImage !== "boolean"
      ) {
        errs.push(`${path}: rollout.verifyImage must be a boolean`);
      }
      if (
        obj.rollout.expectedImageEnv !== undefined &&
        (typeof obj.rollout.expectedImageEnv !== "string" ||
          !/^[A-Z][A-Z0-9_]*$/.test(obj.rollout.expectedImageEnv))
      ) {
        errs.push(`${path}: rollout.expectedImageEnv must be an env-key string`);
      }
      if (obj.rollout.prerequisites !== undefined) {
        if (!Array.isArray(obj.rollout.prerequisites)) {
          errs.push(`${path}: rollout.prerequisites must be an array`);
        } else {
          for (const prerequisite of obj.rollout.prerequisites) {
            if (
              !prerequisite ||
              typeof prerequisite !== "object" ||
              typeof prerequisite.kind !== "string" ||
              typeof prerequisite.name !== "string" ||
              typeof prerequisite.namespace !== "string" ||
              !prerequisite.kind ||
              !prerequisite.name ||
              !prerequisite.namespace
            ) {
              errs.push(
                `${path}: rollout.prerequisites entries require non-empty kind, name, and namespace`,
              );
            }
          }
        }
      }
      if (
        obj.rollout.timeout !== undefined &&
        (typeof obj.rollout.timeout !== "string" ||
          !/^[1-9][0-9]*(?:s|m|h)$/.test(obj.rollout.timeout))
      ) {
        errs.push(`${path}: rollout.timeout must be a positive duration such as '30m'`);
      }
    }
  }
  if (obj.rollouts !== undefined) {
    errs.push(
      `${path}: 'rollouts' is not supported in this code base; declare a single 'rollout' object instead`,
    );
  }
  if (obj.pipeline !== undefined) {
    if (!Array.isArray(obj.pipeline)) errs.push(`${path}: 'pipeline' must be an array`);
    else for (const s of obj.pipeline) {
      if (!VALID_STEPS.has(s)) errs.push(`${path}: pipeline contains invalid step '${s}'`);
    }
  }
  if (obj.instanceRequired !== undefined && typeof obj.instanceRequired !== "boolean") {
    errs.push(`${path}: 'instanceRequired' must be a boolean`);
  }
  if (
    obj.configurationModule !== undefined &&
    (typeof obj.configurationModule !== "string" || !obj.configurationModule.endsWith(".mjs"))
  ) {
    errs.push(`${path}: 'configurationModule' must be an .mjs path`);
  }
  if (obj.gitops !== undefined) {
    if (!obj.gitops || typeof obj.gitops !== "object" || Array.isArray(obj.gitops)) {
      errs.push(`${path}: 'gitops' must be an object`);
    } else {
      for (const key of ["source", "overlay", "manifestContainer"]) {
        if (
          obj.gitops[key] !== undefined &&
          (typeof obj.gitops[key] !== "string" || obj.gitops[key].length === 0)
        ) {
          errs.push(`${path}: gitops.${key} must be a non-empty string`);
        }
      }
      if (obj.gitops.placeholders !== undefined) {
        if (!Array.isArray(obj.gitops.placeholders)) {
          errs.push(`${path}: gitops.placeholders must be an array`);
        } else {
          for (const rule of obj.gitops.placeholders) {
            if (!rule || typeof rule !== "object") {
              errs.push(`${path}: gitops.placeholders entries must be objects`);
              continue;
            }
            if (typeof rule.path !== "string" || rule.path.length === 0) {
              errs.push(`${path}: gitops.placeholders[].path must be a non-empty string`);
            }
            if (
              !Array.isArray(rule.envKeys) ||
              rule.envKeys.length === 0 ||
              rule.envKeys.some((key) => typeof key !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(key))
            ) {
              errs.push(`${path}: gitops.placeholders[].envKeys must contain env-key strings`);
            }
            if (rule.required !== undefined && typeof rule.required !== "boolean") {
              errs.push(`${path}: gitops.placeholders[].required must be a boolean`);
            }
          }
        }
        for (const key of ["optionalEnvKeys", "overlayEnvMaps"]) {
          if (obj.gitops[key] !== undefined) {
            if (
              !Array.isArray(obj.gitops[key]) ||
              obj.gitops[key].some(
                (value) =>
                  typeof value !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(value),
              )
            ) {
              errs.push(`${path}: gitops.${key} must contain env-key strings`);
            }
          }
        }
      }
    }
  }
  // Cross-field rules.
  if (obj.kind === "app") {
    const pipeline = Array.isArray(obj.pipeline) ? obj.pipeline : null;
    if (!obj.image && (!pipeline || pipeline.includes("build") || pipeline.includes("push"))) {
      errs.push(
        `${path}: kind=app requires 'image' unless an explicit pipeline omits build and push`,
      );
    }
  }
  return errs;
}

// ───────────────────────── Loader ─────────────────────────

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

let _cache = null;

/**
 * Load + validate the OSS deploy manifests. Cached for the process lifetime.
 * @param {{ servicesDir?: string, force?: boolean }} [opts]
 * @returns {{
 *   root: object,
 *   services: Record<string, object>,
 *   allSequence: string[],
 *   regionShort: Record<string, string>,
 * }}
 */
export function loadDeployManifest(opts = {}) {
  if (_cache && !opts.force && !opts.servicesDir) return _cache;

  const dir = opts.servicesDir ?? SERVICES_DIR;
  const rootPath = join(dir, "deploy-manifest.json");
  if (!existsSync(rootPath)) {
    throw new Error(`Deploy manifest not found: ${rootPath}`);
  }
  const root = readJson(rootPath);
  const errs = validateRootManifest(root, "deploy-manifest.json");

  const allSequence = [...(root.infraOrder ?? []), ...(root.services ?? [])];
  const registeredServices = [...allSequence, ...(root.standaloneServices ?? [])];
  const services = {};
  // Service name ↔ folder canonicalization: lowercase + strip hyphens. Both
  // service names and folders are now kebab-case (e.g. "cert-manager"), but
  // the canon function lets a folder rename or any case-only divergence keep
  // working forward-compat without churning every reference.
  const canon = (s) => s.toLowerCase().replace(/-/g, "");
  const allFolders = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];

  for (const name of registeredServices) {
    const folder = allFolders.find((f) => canon(f) === canon(name));
    if (!folder) {
      errs.push(`deploy-manifest.json: '${name}' has no matching service folder under deploy/services/`);
      continue;
    }
    const svcPath = join(dir, folder, "deploy.json");
    if (!existsSync(svcPath)) {
      errs.push(`${folder}/deploy.json: missing`);
      continue;
    }
    const svc = readJson(svcPath);
    const rel = `${folder}/deploy.json`;
    errs.push(...validateServiceManifest(svc, rel));
    if (svc.name && svc.name !== name) {
      errs.push(`${rel}: name '${svc.name}' does not match manifest entry '${name}'`);
    }
    // Cross-check kind vs root placement.
    const inInfra = (root.infraOrder ?? []).includes(name);
    const inServiceSequence = (root.services ?? []).includes(name);
    if (inInfra && svc.kind !== "infra") errs.push(`${rel}: kind must be 'infra' (listed in infraOrder)`);
    if (inServiceSequence && svc.kind !== "app") errs.push(`${rel}: kind must be 'app' (listed in services)`);

    services[name] = svc;
  }

  // Catch service folders with a deploy.json that aren't referenced in the root.
  const sequenceCanonical = new Set(registeredServices.map(canon));
  for (const folder of allFolders) {
    if (sequenceCanonical.has(canon(folder))) continue;
    const svcPath = join(dir, folder, "deploy.json");
    if (existsSync(svcPath)) {
      errs.push(
        `${folder}/deploy.json: present but '${folder}' is not in deploy-manifest.json ` +
          `infraOrder/services/standaloneServices`,
      );
    }
  }

  if (errs.length) {
    throw new Error(`Invalid deploy manifests:\n  - ${errs.join("\n  - ")}`);
  }

  const result = {
    root,
    services,
    allSequence,
    regionShort: { ...(root.regionShort ?? {}) },
  };
  if (!opts.servicesDir) _cache = result;
  return result;
}

// ───────────────────────── Derived views ─────────────────────────

export function defaultPipelineForKind(kind, root) {
  const map = root?.defaults?.pipelineByKind;
  if (map && Array.isArray(map[kind])) return [...map[kind]];
  return kind === "infra" ? ["bicep"] : ["build", "bicep", "push", "manifests", "rollout"];
}

export function pipelineForService(svc, root) {
  if (Array.isArray(svc?.pipeline)) return [...svc.pipeline];
  return defaultPipelineForKind(svc.kind, root);
}

export function resolveEnvTemplate(value, env, label, extra = {}) {
  const unresolved = [];
  const values = { ...env, ...extra };
  const resolved = value.replace(/__([A-Z][A-Z0-9_]*)__/g, (_match, key) => {
    const replacement = values[key];
    if (replacement === undefined || replacement === null || replacement === "") {
      unresolved.push(key);
      return `__${key}__`;
    }
    return String(replacement);
  });
  if (unresolved.length > 0) {
    throw new Error(`${label} has unresolved env tokens: ${unresolved.join(", ")}`);
  }
  return resolved;
}

export async function configureServiceEnv({
  service,
  env,
  phase = "initial",
  imageTag = null,
  imageTagExplicit = false,
  envOverlays = [],
}) {
  const serviceManifest = loadDeployManifest().services[service];
  const moduleRel = serviceManifest?.configurationModule;
  if (!moduleRel) return;

  const serviceDir = resolve(SERVICES_DIR, service);
  const modulePath = resolve(serviceDir, moduleRel);
  if (!modulePath.startsWith(`${serviceDir}${sep}`) || !existsSync(modulePath)) {
    throw new Error(
      `${service}/deploy.json configurationModule must resolve to an existing file ` +
        `inside ${serviceDir}: ${moduleRel}`,
    );
  }

  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.configureEnv !== "function") {
    throw new Error(`${moduleRel} must export configureEnv(env, context).`);
  }
  await module.configureEnv(env, {
    phase,
    imageTag,
    imageTagExplicit,
    envOverlays,
    service,
  });
}

/**
 * Resolve the modules to deploy for a service in the given mode.
 * @param {object} svc per-service manifest
 * @param {"single"|"all"} mode
 * @returns {Array<{name:string, scope:string}>}
 */
export function modulesFor(svc, mode) {
  if (mode === "all" && Array.isArray(svc.bicep.allModeModules)) {
    return svc.bicep.allModeModules.map((m) => ({ ...m }));
  }
  return svc.bicep.modules.map((m) => ({ ...m }));
}
