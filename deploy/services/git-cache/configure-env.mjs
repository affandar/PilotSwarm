function requireValue(env, key) {
  const value = String(env[key] ?? "").trim();
  if (!value) {
    throw new Error(`[git-cache] requires ${key}.`);
  }
  env[key] = value;
  return value;
}

export function configureEnv(
  env,
  { phase = "initial", imageTag = null, imageTagExplicit = false } = {},
) {
  const gitCacheOs = String(env.GIT_CACHE_OS || env.WORKER_OS || "linux").trim().toLowerCase();
  if (!["linux", "windows"].includes(gitCacheOs)) {
    throw new Error(
      `GIT_CACHE_OS must be 'linux' or 'windows'; got ` +
        `'${env.GIT_CACHE_OS || env.WORKER_OS}'.`,
    );
  }
  env.GIT_CACHE_OS = gitCacheOs;

  for (const key of [
    "DEPLOY_INSTANCE",
    "REPO_NAME",
    "REPO_URL",
    "NODE_POOL_NAME",
    "ADO_PAT_KEYVAULT_SECRET_URI",
  ]) {
    requireValue(env, key);
  }

  if (env.DEPLOY_INSTANCE !== env.REPO_NAME) {
    throw new Error(
      `[git-cache] --instance ('${env.DEPLOY_INSTANCE}') must match ` +
        `REPO_NAME ('${env.REPO_NAME}').`,
    );
  }
  const nodePoolNameMaxLength = gitCacheOs === "windows" ? 6 : 12;
  const nodePoolNamePattern = new RegExp(
    `^[a-z][a-z0-9]{0,${nodePoolNameMaxLength - 1}}$`,
  );
  if (!nodePoolNamePattern.test(env.NODE_POOL_NAME)) {
    throw new Error(
      `NODE_POOL_NAME must be 1-${nodePoolNameMaxLength} lowercase alphanumeric characters ` +
        `and start with a letter for ${gitCacheOs} node pools; ` +
        `got '${env.NODE_POOL_NAME}'.`,
    );
  }

  let patUri;
  try {
    patUri = new URL(env.ADO_PAT_KEYVAULT_SECRET_URI);
  } catch {
    throw new Error(
      `ADO_PAT_KEYVAULT_SECRET_URI must be a valid Azure Key Vault secret URI; ` +
        `got '${env.ADO_PAT_KEYVAULT_SECRET_URI}'.`,
    );
  }
  const hostMatch = patUri.hostname.match(/^([a-zA-Z0-9-]+)\.vault\.azure\.net$/i);
  const pathParts = patUri.pathname.split("/").filter(Boolean);
  if (
    patUri.protocol !== "https:" ||
    !hostMatch ||
    pathParts.length !== 2 ||
    pathParts[0].toLowerCase() !== "secrets"
  ) {
    throw new Error(
      `ADO_PAT_KEYVAULT_SECRET_URI must match ` +
        `https://<vault>.vault.azure.net/secrets/<secret>; ` +
        `versioned secret URIs are not supported because the CSI mount would otherwise load ` +
        `a different version than requested.`,
    );
  }
  env.GIT_CACHE_PAT_KEYVAULT_NAME = hostMatch[1];
  env.GIT_CACHE_PAT_SECRET_NAME = pathParts[1];

  env.FETCH_INTERVAL_SECONDS ||= "3600";
  env.FETCH_JITTER_SECONDS ||= "300";
  env.CACHE_HOSTPATH ||= gitCacheOs === "windows"
    ? "C:\\git-cache"
    : "/var/lib/pilotswarm-git-cache";
  const expectedCacheRoot = gitCacheOs === "windows" ? "C:\\git-cache" : "/mnt/git-cache";
  if (env.CACHE_ROOT && env.CACHE_ROOT !== expectedCacheRoot) {
    throw new Error(
      `CACHE_ROOT must be '${expectedCacheRoot}' for ${gitCacheOs} git-cache so it ` +
        `matches the container volume mount; got '${env.CACHE_ROOT}'.`,
    );
  }
  env.CACHE_ROOT = expectedCacheRoot;
  env.CACHE_MAX_UNAVAILABLE ||= "1";
  env.CACHE_MEM_LIMIT ||= "1Gi";
  env.CACHE_NOT_READY_TAINT_KEY ||= "pilotswarm.io/cache-not-ready";

  const resourcePrefix = `pilotswarm-git-cache-${env.DEPLOY_INSTANCE}`;
  env.GIT_CACHE_DAEMONSET_NAME = `git-cache-${env.DEPLOY_INSTANCE}-${gitCacheOs}`;
  env.GIT_CACHE_SERVICE_ACCOUNT_NAME = resourcePrefix;
  env.GIT_CACHE_NODE_PATCHER_NAME = `${resourcePrefix}-node-patcher`;
  env.GIT_CACHE_SECRET_PROVIDER_CLASS_NAME = `${resourcePrefix}-secrets`;
  env.GIT_CACHE_SCRIPTS_CONFIG_MAP_NAME = `${resourcePrefix}-scripts`;

  if (!/^[1-9][0-9]*$/.test(env.FETCH_INTERVAL_SECONDS)) {
    throw new Error(`FETCH_INTERVAL_SECONDS must be a positive integer; got '${env.FETCH_INTERVAL_SECONDS}'.`);
  }
  if (!/^[0-9]+$/.test(env.FETCH_JITTER_SECONDS)) {
    throw new Error(`FETCH_JITTER_SECONDS must be a non-negative integer; got '${env.FETCH_JITTER_SECONDS}'.`);
  }
  if (!/^[1-9][0-9]*%?$/.test(env.CACHE_MAX_UNAVAILABLE)) {
    throw new Error(
      `CACHE_MAX_UNAVAILABLE must be a positive integer or percentage; got '${env.CACHE_MAX_UNAVAILABLE}'.`,
    );
  }
  if (!/^[1-9][0-9]*(?:\.[0-9]+)?(?:E|P|T|G|M|K|Ei|Pi|Ti|Gi|Mi|Ki)?$/.test(env.CACHE_MEM_LIMIT)) {
    throw new Error(`CACHE_MEM_LIMIT must be a Kubernetes memory quantity; got '${env.CACHE_MEM_LIMIT}'.`);
  }
  if (phase === "manifests") {
    if (gitCacheOs === "linux") {
      env.GIT_CACHE_IMAGE ||= "alpine/git:2.45.2";
    } else if (!env.GIT_CACHE_IMAGE) {
      if (!imageTagExplicit) {
        throw new Error(
          "Windows git-cache requires GIT_CACHE_IMAGE or an explicit --image-tag " +
            "for an already-published pilotswarm-worker-win image.",
        );
      }
      if (!env.ACR_LOGIN_SERVER || !imageTag) {
        throw new Error(
          "Windows git-cache requires GIT_CACHE_IMAGE or ACR_LOGIN_SERVER plus an image tag.",
        );
      }
      env.GIT_CACHE_IMAGE =
        `${env.ACR_LOGIN_SERVER}/pilotswarm-worker-win:${imageTag}`;
    }
  }

  return gitCacheOs;
}
