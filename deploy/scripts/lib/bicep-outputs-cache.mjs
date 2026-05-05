// Per-env cache of Bicep deployment outputs.
//
// Why this exists:
//   When you run a single service (e.g. `worker`), its Bicep step depends on
//   outputs from upstream services that have already been deployed in earlier
//   `all` runs (GlobalInfra → BaseInfra → Worker/Portal). Without a cache, you
//   either have to re-run the whole chain in-process every time, or seed
//   FRONT_DOOR_PROFILE_NAME, ACR_NAME, etc. into env files by hand.
//
// Behavior:
//   - Cache file lives at deploy/.tmp/<env>/bicep-outputs.cache.json
//     (per-env scoping; --clean wipes the parent staging dir and busts it).
//   - Stored as a flat { KEY: value } JSON map in the same shape we merge into
//     the in-process env map after a successful Bicep deployment.
//   - loadCache(envName, env) merges cached keys into env *without* overwriting
//     anything already set (env files + CLI overrides win).
//   - saveCache(envName, addedKeys, env) appends/overwrites only the keys that
//     a Bicep deploy just produced. Pre-existing entries for other modules
//     stay intact, so a partial run (e.g. just `worker`) doesn't drop
//     GlobalInfra/BaseInfra outputs from a prior run.
//
// Cache scope: keyed by env (path) and incrementally accumulated as stages
// run. There is no time-based expiry — `--clean` or deleting the file busts
// it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ROOT, log } from "./common.mjs";

function cachePath(envName) {
  return join(REPO_ROOT, "deploy", ".tmp", envName, "bicep-outputs.cache.json");
}

export function loadCache(envName, env) {
  const p = cachePath(envName);
  if (!existsSync(p)) return 0;
  let cached;
  try {
    cached = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    log("info", `Bicep outputs cache at ${p} is unreadable (${e.message}); ignoring.`);
    return 0;
  }
  if (!cached || typeof cached !== "object") return 0;
  let merged = 0;
  for (const [k, v] of Object.entries(cached)) {
    if (v === null || v === undefined || v === "") continue;
    if (env[k] !== undefined && env[k] !== "") continue;
    env[k] = v;
    merged++;
  }
  if (merged > 0) log("info", `Loaded ${merged} cached Bicep outputs from ${p}`);
  return merged;
}

export function saveCache(envName, addedKeys, env) {
  if (!addedKeys || addedKeys.length === 0) return;
  const p = cachePath(envName);
  let cached = {};
  if (existsSync(p)) {
    try {
      cached = JSON.parse(readFileSync(p, "utf8")) || {};
    } catch {
      cached = {};
    }
  }
  let changed = 0;
  for (const k of addedKeys) {
    const v = env[k];
    if (v === undefined || v === null || v === "") continue;
    if (cached[k] !== v) {
      cached[k] = v;
      changed++;
    }
  }
  if (changed === 0) return;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cached, null, 2) + "\n", "utf8");
  log("info", `Updated Bicep outputs cache (${changed} keys) → ${p}`);
}
