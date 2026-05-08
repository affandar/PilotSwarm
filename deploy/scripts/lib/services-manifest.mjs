// OSS deploy manifest loader.
//
// Reads deploy/services/deploy-manifest.json + deploy/services/<svc>/deploy.json
// and exposes a single structured object the orchestrator consumes. Stdlib-only
// structural validator (zero deps) — checks shape, enums, references, and the
// invariant that every name in {infraOrder ∪ services} has a matching
// deploy.json file.
//
// Distinct from the enterprise services.json / service.json files that live alongside
// these in deploy/services/. Those will be migrated to a parent repo via
// submodule; this loader never touches them.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
  for (const key of ["infraOrder", "services"]) {
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
  if (Array.isArray(obj.infraOrder) && Array.isArray(obj.services)) {
    for (const s of obj.services) {
      if (obj.infraOrder.includes(s)) {
        errs.push(`${path}: '${s}' appears in both infraOrder and services`);
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
    else if (typeof obj.rollout.deployment !== "string") {
      errs.push(`${path}: rollout.deployment must be a string`);
    }
  }
  if (obj.pipeline !== undefined) {
    if (!Array.isArray(obj.pipeline)) errs.push(`${path}: 'pipeline' must be an array`);
    else for (const s of obj.pipeline) {
      if (!VALID_STEPS.has(s)) errs.push(`${path}: pipeline contains invalid step '${s}'`);
    }
  }
  // Cross-field rules.
  if (obj.kind === "app") {
    if (!obj.image) errs.push(`${path}: kind=app requires 'image'`);
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
  const services = {};
  // Service name ↔ folder canonicalization: lowercase + strip hyphens. Both
  // service names and folders are now kebab-case (e.g. "cert-manager"), but
  // the canon function lets a folder rename or any case-only divergence keep
  // working forward-compat without churning every reference.
  const canon = (s) => s.toLowerCase().replace(/-/g, "");
  const allFolders = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];

  for (const name of allSequence) {
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
    if (inInfra && svc.kind !== "infra") errs.push(`${rel}: kind must be 'infra' (listed in infraOrder)`);
    if (!inInfra && svc.kind !== "app") errs.push(`${rel}: kind must be 'app' (listed in services)`);

    services[name] = svc;
  }

  // Catch service folders with a deploy.json that aren't referenced in the root.
  const sequenceCanonical = new Set(allSequence.map(canon));
  for (const folder of allFolders) {
    if (sequenceCanonical.has(canon(folder))) continue;
    const svcPath = join(dir, folder, "deploy.json");
    if (existsSync(svcPath)) {
      errs.push(`${folder}/deploy.json: present but '${folder}' is not in deploy-manifest.json infraOrder/services`);
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
