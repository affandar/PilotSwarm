// Database provisioning intent is independent of connection/auth settings.
// Keep this helper free of I/O so env loading and parameter rendering agree.

export const DATABASE_URL_KEYS = Object.freeze([
  "DATABASE_URL",
  "PILOTSWARM_CMS_FACTS_DATABASE_URL",
]);

export const DATABASE_ENV_DEFAULTS = Object.freeze({
  DEPLOY_POSTGRES: "true",
  PILOTSWARM_BLOB_USE_MANAGED_IDENTITY: "1",
});

export const DATABASE_INPUT_KEYS = Object.freeze([
  ...Object.keys(DATABASE_ENV_DEFAULTS),
  "PILOTSWARM_USE_MANAGED_IDENTITY",
  "PILOTSWARM_DB_AAD_USER",
  ...DATABASE_URL_KEYS.flatMap((key) => [key, `${key}_SECRET_NAME`, `${key}_SECRET_VERSION`]),
]);

export function deploysPostgres(env) {
  const value = String(env.DEPLOY_POSTGRES ?? "true").trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error("DEPLOY_POSTGRES must be true or false (legacy 1 or 0 is also accepted).");
}

export function databaseUsesManagedIdentity(env) {
  const value = String(env.PILOTSWARM_USE_MANAGED_IDENTITY ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["", "0", "false", "no", "off"].includes(value)) return false;
  throw new Error("PILOTSWARM_USE_MANAGED_IDENTITY must select database auth: 1/true or 0/false.");
}

function nonempty(value) {
  return value != null && String(value).trim() !== "";
}

function validateDatabaseUrl(key, value, useManagedIdentity) {
  let url;
  try {
    url = new URL(value);
  } catch {
    // URL's native error includes the input, which can contain a password.
    throw new Error(`${key} must be a PostgreSQL connection URL; its value is not logged.`);
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname ||
      url.pathname.length <= 1 || /[\r\n\0]/.test(value)) {
    throw new Error(`${key} must be a PostgreSQL connection URL with a host and database name.`);
  }
  if (useManagedIdentity && (url.password || url.searchParams.has("password"))) {
    throw new Error(
      `${key} contains a password but database managed identity is enabled. ` +
      "Use a passwordless URL with PILOTSWARM_DB_AAD_USER, or set " +
      "PILOTSWARM_USE_MANAGED_IDENTITY=0; Blob auth remains independent.",
    );
  }
}

// Called by database-consuming stages, never by startup composition.
// An explicit secret name means the operator has already populated this vault.
export function validateDatabaseConfig(env, { requireVersions = false } = {}) {
  if (deploysPostgres(env)) return { byo: false, secrets: [] };

  if (!nonempty(env.PILOTSWARM_USE_MANAGED_IDENTITY)) {
    throw new Error(
      "DEPLOY_POSTGRES=false requires an explicit database auth choice: " +
      "PILOTSWARM_USE_MANAGED_IDENTITY=0 (password) or 1 (Entra). Blob auth is separate.",
    );
  }
  const useManagedIdentity = databaseUsesManagedIdentity(env);
  if (useManagedIdentity && !nonempty(env.PILOTSWARM_DB_AAD_USER)) {
    throw new Error("BYO database managed identity requires PILOTSWARM_DB_AAD_USER registered on the external database.");
  }

  const missing = DATABASE_URL_KEYS.filter((key) =>
    !nonempty(env[key]) && !nonempty(env[`${key}_SECRET_NAME`]));
  if (missing.length) {
    throw new Error(
      `DEPLOY_POSTGRES=false requires ${missing.join(" and ")} or their *_SECRET_NAME references. ` +
      "Supply URLs for seed-secrets, or existing secret names in the environment's Key Vault.",
    );
  }

  const secrets = DATABASE_URL_KEYS.map((key) => {
    const value = nonempty(env[key]) ? String(env[key]) : undefined;
    const name = nonempty(env[`${key}_SECRET_NAME`])
      ? String(env[`${key}_SECRET_NAME`]).trim()
      : key.toLowerCase().replaceAll("_", "-");
    if (!/^[A-Za-z0-9-]{1,127}$/.test(name)) {
      throw new Error(`${key}_SECRET_NAME must be a valid Key Vault secret name (letters, digits, hyphens; 1-127 characters).`);
    }
    if (["github-token", "anthropic-api-key", "azure-oai-key"].includes(name.toLowerCase())) {
      throw new Error(`${key}_SECRET_NAME must not overwrite a model credential.`);
    }
    if (value !== undefined) validateDatabaseUrl(key, value, useManagedIdentity);
    const version = nonempty(env[`${key}_SECRET_VERSION`])
      ? String(env[`${key}_SECRET_VERSION`]).trim()
      : undefined;
    if ((requireVersions || version !== undefined) && !/^[a-fA-F0-9]{32}$/.test(version ?? "")) {
      throw new Error(
        `${key}_SECRET_VERSION must be resolved before staging BYO manifests. ` +
        "Use deploy.mjs --steps manifests, which resolves Key Vault versions without exporting secret values.",
      );
    }
    return { key, name, value, version };
  });
  if (secrets[0].name.toLowerCase() === secrets[1].name.toLowerCase() &&
      secrets[0].value !== undefined && secrets[1].value !== undefined &&
      secrets[0].value !== secrets[1].value) {
    throw new Error("BYO database URLs with different values must use different Key Vault secret names.");
  }
  return { byo: true, useManagedIdentity, secrets };
}

export function databaseOverlayOmittedKeys(env) {
  return [
    ...(!deploysPostgres(env) ? DATABASE_URL_KEYS : []),
    ...(!databaseUsesManagedIdentity(env) ? ["PILOTSWARM_DB_AAD_USER"] : []),
  ];
}
