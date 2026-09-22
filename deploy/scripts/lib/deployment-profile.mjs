import { SEED_SECRETS_UNSET_SENTINEL } from "./seed-secrets.mjs";

export const DBMIGRATE_PRIVATE_PROFILE = "dbmigrate-private";
export const DEPLOYMENT_PROFILES = ["standard", DBMIGRATE_PRIVATE_PROFILE];

const REQUIRED_VALUES = {
  STRICT_PRIVATE: "true",
  GPT_ONLY: "true",
  EDGE_MODE: "private",
  TLS_SOURCE: "akv",
  ACR_SKU: "Premium",
  FOUNDRY_ENABLED: "true",
  VPN_GATEWAY_ENABLED: "false",
  DEPLOY_POSTGRES: "true",
  PILOTSWARM_USE_MANAGED_IDENTITY: "1",
  PORTAL_AUTH_PROVIDER: "entra",
  PORTAL_AUTH_ALLOW_UNAUTHENTICATED: "false",
  PORTAL_AUTHZ_DEFAULT_ROLE: "none",
  AUTHZ_ENFORCE_OWNERSHIP: "true",
  AUTHZ_ADMIN_SCOPE: "cluster",
  SESSIONS_DEFAULT_VISIBILITY: "private",
  SESSIONS_SYSTEM_VISIBILITY: "admin",
};

const REQUIRED_NONEMPTY = [
  "SUBSCRIPTION_ID",
  "PORTAL_AUTH_ENTRA_TENANT_ID",
  "PORTAL_AUTH_ENTRA_CLIENT_ID",
  "PORTAL_AUTHZ_ADMIN_GROUPS",
  "PORTAL_AUTHZ_USER_GROUPS",
  "MONITOR_ALERT_EMAIL",
  "FOUNDRY_DEPLOYMENTS_FILE",
];

function normalized(value) {
  return String(value ?? "").trim();
}

export function dbmigratePrivateOverrides() {
  return {
    DEPLOYMENT_PROFILE: DBMIGRATE_PRIVATE_PROFILE,
    STRICT_PRIVATE: "true",
    GPT_ONLY: "true",
    EDGE_MODE: "private",
    TLS_SOURCE: "akv",
    ACR_SKU: "Premium",
    FOUNDRY_ENABLED: "true",
    VPN_GATEWAY_ENABLED: "false",
    AKS_SYSTEM_POOL_INITIAL_COUNT: "1",
    AKS_SYSTEM_POOL_MIN_COUNT: "1",
    AKS_SYSTEM_POOL_MAX_COUNT: "2",
    AKS_USER_POOL_INITIAL_COUNT: "2",
    AKS_USER_POOL_MIN_COUNT: "1",
    AKS_USER_POOL_MAX_COUNT: "4",
    POSTGRES_BACKUP_RETENTION_DAYS: "14",
    STORAGE_DELETE_RETENTION_DAYS: "14",
  };
}

export function dbmigratePrivatePortalDefaults() {
  return {
    PORTAL_AUTH_PROVIDER: "entra",
    PORTAL_AUTH_ALLOW_UNAUTHENTICATED: "false",
    PORTAL_AUTHZ_DEFAULT_ROLE: "none",
    AUTHZ_ENFORCE_OWNERSHIP: "true",
    AUTHZ_ADMIN_SCOPE: "cluster",
    SESSIONS_DEFAULT_VISIBILITY: "private",
    SESSIONS_SYSTEM_VISIBILITY: "admin",
  };
}

export function validateDeploymentProfile(env) {
  const profile = normalized(env.DEPLOYMENT_PROFILE || "standard").toLowerCase();
  if (!DEPLOYMENT_PROFILES.includes(profile)) {
    return [`DEPLOYMENT_PROFILE='${env.DEPLOYMENT_PROFILE}' must be one of ${DEPLOYMENT_PROFILES.join(", ")}.`];
  }
  if (profile !== DBMIGRATE_PRIVATE_PROFILE) return [];

  const errors = [];
  for (const [key, expected] of Object.entries(REQUIRED_VALUES)) {
    if (normalized(env[key]).toLowerCase() !== expected.toLowerCase()) {
      errors.push(`${key} must be '${expected}' for ${DBMIGRATE_PRIVATE_PROFILE}.`);
    }
  }

  for (const key of REQUIRED_NONEMPTY) {
    const value = normalized(env[key]);
    if (!value || value === SEED_SECRETS_UNSET_SENTINEL || value === "unused") {
      errors.push(`${key} must be set for ${DBMIGRATE_PRIVATE_PROFILE}.`);
    }
  }

  const counts = [
    ["AKS_SYSTEM_POOL_INITIAL_COUNT", 1, 1],
    ["AKS_SYSTEM_POOL_MIN_COUNT", 1, 1],
    ["AKS_SYSTEM_POOL_MAX_COUNT", 1, 2],
    ["AKS_USER_POOL_INITIAL_COUNT", 1, 2],
    ["AKS_USER_POOL_MIN_COUNT", 1, 1],
    ["AKS_USER_POOL_MAX_COUNT", 1, 4],
  ];
  for (const [key, minimum, maximum] of counts) {
    const value = Number(env[key]);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      errors.push(`${key} must be an integer between ${minimum} and ${maximum} for ${DBMIGRATE_PRIVATE_PROFILE}.`);
    }
  }

  const systemMin = Number(env.AKS_SYSTEM_POOL_MIN_COUNT);
  const systemInitial = Number(env.AKS_SYSTEM_POOL_INITIAL_COUNT);
  const systemMax = Number(env.AKS_SYSTEM_POOL_MAX_COUNT);
  const userMin = Number(env.AKS_USER_POOL_MIN_COUNT);
  const userInitial = Number(env.AKS_USER_POOL_INITIAL_COUNT);
  const userMax = Number(env.AKS_USER_POOL_MAX_COUNT);
  if (!(systemMin <= systemInitial && systemInitial <= systemMax)) {
    errors.push("AKS system pool counts must satisfy min <= initial <= max.");
  }
  if (!(userMin <= userInitial && userInitial <= userMax)) {
    errors.push("AKS user pool counts must satisfy min <= initial <= max.");
  }

  const backupDays = Number(env.POSTGRES_BACKUP_RETENTION_DAYS);
  if (!Number.isInteger(backupDays) || backupDays < 14 || backupDays > 35) {
    errors.push("POSTGRES_BACKUP_RETENTION_DAYS must be an integer from 14 through 35.");
  }
  const deleteDays = Number(env.STORAGE_DELETE_RETENTION_DAYS);
  if (!Number.isInteger(deleteDays) || deleteDays < 14 || deleteDays > 365) {
    errors.push("STORAGE_DELETE_RETENTION_DAYS must be an integer from 14 through 365.");
  }

  return errors;
}
