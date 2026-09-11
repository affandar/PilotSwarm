import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";

import { computeSpcKeysHash } from "../../scripts/lib/spc-keys-hash.mjs";

function requireValue(env, key) {
  const value = String(env[key] ?? "").trim();
  if (!value) throw new Error(`[git-repo-worker] requires ${key}.`);
  env[key] = value;
  return value;
}

function boundedName(value, maxLength = 63) {
  if (value.length <= maxLength) return value;
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${value.slice(0, maxLength - hash.length - 1).replace(/-+$/, "")}-${hash}`;
}

function resolveConfigFile(pathValue, envOverlays) {
  if (isAbsolute(pathValue)) return pathValue;
  for (const overlay of [...envOverlays].reverse()) {
    const candidate = resolve(dirname(overlay), pathValue);
    if (existsSync(candidate)) return candidate;
  }
  return resolve(pathValue);
}

function loadDefaultMcp(env, envOverlays) {
  const fileValue = String(env.DEFAULT_MCP_FILE ?? "").trim();
  if (!fileValue) return;
  const path = resolveConfigFile(fileValue, envOverlays);
  if (!existsSync(path)) {
    throw new Error(`[git-repo-worker] DEFAULT_MCP_FILE not found: ${path}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `[git-repo-worker] DEFAULT_MCP_FILE is not valid JSON (${path}): ${error.message}`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !parsed.servers ||
    typeof parsed.servers !== "object" ||
    Array.isArray(parsed.servers)
  ) {
    throw new Error(
      `[git-repo-worker] DEFAULT_MCP_FILE must contain a JSON object with a 'servers' map: ${path}`,
    );
  }
  env.DEFAULT_MCP_JSON = JSON.stringify(parsed);
}

export function configureEnv(
  env,
  { phase = "initial", envOverlays = [] } = {},
) {
  const os = String(env.WORKER_OS || "linux").trim().toLowerCase();
  if (!["linux", "windows"].includes(os)) {
    throw new Error(`WORKER_OS must be 'linux' or 'windows'; got '${env.WORKER_OS}'.`);
  }
  env.GIT_REPO_WORKER_OS = os;

  for (const key of ["DEPLOY_INSTANCE", "REPO_NAME", "REPO_URL", "CACHE_HOSTPATH"]) {
    requireValue(env, key);
  }
  if (env.DEPLOY_INSTANCE !== env.REPO_NAME) {
    throw new Error(
      `[git-repo-worker] --instance ('${env.DEPLOY_INSTANCE}') must match ` +
        `REPO_NAME ('${env.REPO_NAME}').`,
    );
  }
  if (
    (os === "windows" && !/^[A-Za-z]:\\/.test(env.CACHE_HOSTPATH)) ||
    (os === "linux" && !env.CACHE_HOSTPATH.startsWith("/"))
  ) {
    throw new Error(
      `CACHE_HOSTPATH must be an absolute ${os} path; got '${env.CACHE_HOSTPATH}'.`,
    );
  }

  env.WORKER_MAX_UNAVAILABLE ||= "50%";
  env.WORKER_MEM_LIMIT ||= os === "windows" ? "4Gi" : "2Gi";
  env.PILOTSWARM_TURN_TIMEOUT_MS ||= "1200000";
  env.PILOTSWARM_LIVE_TURN ||= "0";
  env.PILOTSWARM_USE_MANAGED_IDENTITY ||= "1";
  env.AZURE_STORAGE_CONTAINER ||= "copilot-sessions";
  env.PLUGIN_SPEC ||= "";
  env.ADO_PAT_KEYVAULT_SECRET_URI ||= "";
  env.REPO_MCP_ALLOW ||= "";
  env.REPO_MCP_REMOTE_ONLY ||= "";
  env.ADO_NUGET_FEED_URLS ||= "";
  env.DEFAULT_MCP_JSON ||= "";
  env.CALLER_AUTH_KEYVAULT_NAME ||= env.KV_NAME || "";
  env.CALLER_AUTH_ENV_TOKENS ||= "";
  env.PILOTSWARM_TURN_INACTIVITY_TIMEOUT_MS ||= "";
  env.WORKER_EXTRA_ENV ||= "";

  if (!/^[1-9][0-9]*%?$/.test(env.WORKER_MAX_UNAVAILABLE)) {
    throw new Error(
      `WORKER_MAX_UNAVAILABLE must be a positive integer or percentage; ` +
        `got '${env.WORKER_MAX_UNAVAILABLE}'.`,
    );
  }
  if (
    !/^[1-9][0-9]*(?:\.[0-9]+)?(?:E|P|T|G|M|K|Ei|Pi|Ti|Gi|Mi|Ki)?$/.test(
      env.WORKER_MEM_LIMIT,
    )
  ) {
    throw new Error(
      `WORKER_MEM_LIMIT must be a Kubernetes memory quantity; got '${env.WORKER_MEM_LIMIT}'.`,
    );
  }
  for (const pair of env.WORKER_EXTRA_ENV.split(";").filter((value) => value.trim())) {
    if (!/^[A-Z_][A-Z0-9_]*=/.test(pair.trim())) {
      throw new Error(`WORKER_EXTRA_ENV entry is not NAME=value: '${pair.trim()}'.`);
    }
  }

  loadDefaultMcp(env, envOverlays);

  const prefix = `repo-worker-${env.DEPLOY_INSTANCE}`;
  const fluxConfigName = `git-repo-worker-${env.DEPLOY_INSTANCE}`;
  const fluxKustomizationKey =
    fluxConfigName.length * 2 + 1 <= 62 ? fluxConfigName : "rw";
  env.GIT_REPO_WORKER_DAEMONSET_NAME =
    boundedName(`copilot-runtime-git-worker-${env.DEPLOY_INSTANCE}-${os}`);
  env.GIT_REPO_WORKER_FLUX_KUSTOMIZATION_NAME =
    `${fluxConfigName}-${fluxKustomizationKey}`;
  env.GIT_REPO_WORKER_SERVICE_ACCOUNT_NAME =
    `pilotswarm-git-cache-${env.DEPLOY_INSTANCE}`;
  env.GIT_REPO_WORKER_SECRET_PROVIDER_CLASS_NAME = `${prefix}-secrets`;
  env.GIT_REPO_WORKER_SECRET_NAME = `${prefix}-secrets`;
  env.PILOTSWARM_WORKER_DISPLAY_NAME = `${env.REPO_NAME} worker`;
  env.PILOTSWARM_WORKER_TAGS = `repo:${env.REPO_NAME}`;
  env.GIT_CACHE_REPO = env.REPO_NAME;
  env.GIT_CACHE_ROOT = os === "windows" ? "C:\\git-cache" : "/mnt/git-cache";
  env.GIT_CACHE_MIRROR =
    os === "windows"
      ? `C:\\git-cache\\${env.REPO_NAME}.git`
      : `/mnt/git-cache/${env.REPO_NAME}.git`;
  env.GIT_CACHE_READY_FILE =
    os === "windows"
      ? `C:\\git-cache\\${env.REPO_NAME}.ready`
      : `/mnt/git-cache/${env.REPO_NAME}.ready`;
  env.GIT_ENLISTMENT_HOSTPATH = `${env.CACHE_HOSTPATH}-enlistment`;
  env.GIT_ENLISTMENT_ROOT = os === "windows" ? "C:\\enlistment" : "/mnt/enlistment";
  env.WORKER_READY_FILE =
    os === "windows"
      ? "C:\\copilot-home\\worker.ready"
      : "/home/node/.copilot/worker.ready";
  env.SPC_KEYS_HASH = computeSpcKeysHash({ service: "git-repo-worker" });

  if (phase === "manifests") {
    requireValue(env, "GIT_REPO_WORKER_IMAGE");
    if (
      !/^[^\s/]+(?:\/[^\s/]+)+(?:@sha256:[a-f0-9]{64}|:[^/:\s]+)$/i.test(
        env.GIT_REPO_WORKER_IMAGE,
      )
    ) {
      throw new Error(
        `GIT_REPO_WORKER_IMAGE must be a complete tagged or digest image reference; ` +
          `got '${env.GIT_REPO_WORKER_IMAGE}'.`,
      );
    }
    env.PILOTSWARM_IMAGE_REF = env.GIT_REPO_WORKER_IMAGE;
    for (const key of [
      "KV_NAME",
      "WORKLOAD_IDENTITY_CLIENT_ID",
      "AZURE_TENANT_ID",
      "AZURE_STORAGE_ACCOUNT_URL",
      "PILOTSWARM_CMS_FACTS_DATABASE_URL",
      "PILOTSWARM_DB_AAD_USER",
      "DATABASE_URL",
    ]) {
      requireValue(env, key);
    }
  }
  return os;
}
