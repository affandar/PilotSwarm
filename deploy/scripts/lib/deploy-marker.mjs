// Per-module deploy success marker (used to skip redundant Bicep deploys).
//
// Why this exists:
//   `deploy.mjs worker <env>` and `deploy.mjs portal <env>` each deploy
//   `[BaseInfra, <Service>]` per the per-service `deploy.json`. BaseInfra is
//   idempotent, but rerunning it is slow (RBAC waits, deploymentScripts) and
//   when a contributor runs both worker and portal back-to-back, BaseInfra
//   is redeployed twice for no benefit.
//
//   This marker records "the inputs to module M for env E hashed to H, and
//   the deploy succeeded at T." Before running `az deployment create`, we
//   compare current inputs to the marker; on match, we skip the az call and
//   reuse the bicep-outputs cache (already loaded into env at startup).
//
// Inputs hashed:
//   * templateHash — SHA256 of every `.bicep` file under
//       deploy/services/<Module>/bicep/  AND  deploy/services/common/bicep/
//     (Common is hashed because modules import from there.)
//   * paramsHash   — SHA256 of the rendered params JSON file (post-env
//     substitution). Captures every env-driven knob the deploy depends on.
//
// Marker file location:
//   deploy/.tmp/<envName>/<Module>.deploy-marker.json
//
// Bypass:
//   * `--force` on the deploy CLI ignores markers (deploy as if fresh).
//   * Deleting the marker file (or the whole `deploy/.tmp/<env>/` directory).
//   * `--clean` wipes the staging dir (per-service) but does NOT touch
//     env-wide markers — that's intentional, mirrors the bicep-outputs cache.
//
// IMPORTANT: a skipped deploy still needs its outputs in the env map. The
// bicep-outputs cache (`bicep-outputs-cache.mjs`) is loaded once at
// orchestrator startup; if the marker is present we trust the cache. If the
// cache file is missing we treat it as a marker miss (defensive).

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { REPO_ROOT, log } from "./common.mjs";

function markerPath(envName, moduleName) {
  return join(
    REPO_ROOT,
    "deploy",
    ".tmp",
    envName,
    `${moduleName}.deploy-marker.json`,
  );
}

function bicepOutputsCachePath(envName) {
  return join(REPO_ROOT, "deploy", ".tmp", envName, "bicep-outputs.cache.json");
}

// Recursively list `.bicep` files under `dir`, sorted by repo-relative path
// for stable hashing.
function listBicepFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(cur, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile() && name.endsWith(".bicep")) {
        out.push(full);
      }
    }
  }
  out.sort((a, b) =>
    relative(REPO_ROOT, a).split(sep).join("/").localeCompare(
      relative(REPO_ROOT, b).split(sep).join("/"),
    ),
  );
  return out;
}

// Hash all .bicep files under deploy/services/<Module>/bicep/ AND
// deploy/services/common/bicep/. Each file contributes
// `<repo-relative-path>\n<sha256-of-contents>\n` to the rolling hash so
// renames bust the hash too.
export function computeTemplateHash(moduleName) {
  const dirs = [
    join(REPO_ROOT, "deploy", "services", moduleName, "bicep"),
    join(REPO_ROOT, "deploy", "services", "Common", "bicep"),
  ];
  const files = dirs.flatMap(listBicepFiles);
  const h = createHash("sha256");
  for (const f of files) {
    const rel = relative(REPO_ROOT, f).split(sep).join("/");
    h.update(rel);
    h.update("\n");
    h.update(readFileSync(f));
    h.update("\n");
  }
  return h.digest("hex");
}

// Hash the rendered params file content (already env-substituted). Returns
// "" if the file is missing — caller should treat that as a marker miss.
export function computeParamsHash(renderedParamsPath) {
  if (!existsSync(renderedParamsPath)) return "";
  return createHash("sha256")
    .update(readFileSync(renderedParamsPath))
    .digest("hex");
}

export function loadMarker(envName, moduleName) {
  const p = markerPath(envName, moduleName);
  if (!existsSync(p)) return null;
  try {
    const obj = JSON.parse(readFileSync(p, "utf8"));
    if (!obj || typeof obj !== "object") return null;
    return obj;
  } catch {
    return null;
  }
}

export function saveMarker(envName, moduleName, marker) {
  const p = markerPath(envName, moduleName);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(marker, null, 2) + "\n", "utf8");
}

// Decide whether `moduleName` for `envName` can skip its `az deployment create`.
// Returns { skip: bool, reason: string }. The caller still renders params so
// we have a `renderedParamsPath` to hash.
export function shouldSkipDeploy({
  envName,
  moduleName,
  templateHash,
  paramsHash,
  force,
}) {
  if (force) return { skip: false, reason: "force" };
  const marker = loadMarker(envName, moduleName);
  if (!marker) return { skip: false, reason: "no marker" };
  if (marker.templateHash !== templateHash) {
    return { skip: false, reason: "template changed" };
  }
  if (marker.paramsHash !== paramsHash) {
    return { skip: false, reason: "params changed" };
  }
  // Defensive: the bicep-outputs cache is what feeds env vars to downstream
  // services when we skip. If it's missing the marker is meaningless.
  if (!existsSync(bicepOutputsCachePath(envName))) {
    return { skip: false, reason: "outputs cache missing" };
  }
  return { skip: true, reason: "marker hit" };
}

// Exported for tests.
export const _internals = { markerPath, bicepOutputsCachePath, listBicepFiles };
