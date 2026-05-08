// Derived env-map values composed from BaseInfra Bicep outputs.
//
// These keys are referenced by overlay .env files (worker-env / portal-env
// ConfigMaps) and by the substitute-env stage — but they aren't direct Bicep
// outputs. They're composed from the Bicep outputs that ARE captured (by
// deploy-bicep.mjs's FR-022 alias map):
//
//   POSTGRES_FQDN, POSTGRES_AAD_ADMIN_PRINCIPAL_NAME, BLOB_CONTAINER_ENDPOINT
//
// Composition is idempotent (each branch checks `!env.<KEY>`) and must be
// invoked both at startup (so cached outputs from a previous run are
// composed) AND after every `bicep` stage in the per-service loop (so a
// fresh `all` run, where the cache starts empty, also composes the values
// before the manifests stage substitutes them into overlay .env files).
//
// Pure: mutates the env map in-place, no side effects beyond that and the
// log lines.

import { log } from "./common.mjs";

export function composeDerivedEnv(env) {
  // DATABASE_URL — overlay ConfigMap value, NOT a KV secret in the
  // bicep-deploy path (see deploy/gitops/worker/base/secret-provider-class.yaml).
  // Embeds the deterministic bootstrap admin password from postgres.bicep.
  // The password is identical on every stamp and never reaches a real
  // production cluster (prod uses the enterprise path, where Postgres comes with
  // AAD-only auth).
  if (!env.DATABASE_URL && env.POSTGRES_FQDN) {
    const pgUser = env.POSTGRES_ADMIN_LOGIN || "pilotswarm";
    const pgDb = env.POSTGRES_DATABASE_NAME || "pilotswarm";
    const pgPwd = env.POSTGRES_ADMIN_PASSWORD || "PilotSwarmDev_BootstrapOnly!9876";
    env.DATABASE_URL = `postgresql://${pgUser}:${pgPwd}@${env.POSTGRES_FQDN}:5432/${pgDb}?sslmode=require`;
    log("info", `Composed DATABASE_URL for overlay from POSTGRES_FQDN.`);
  }

  // AZURE_STORAGE_ACCOUNT_URL — for the worker-env ConfigMap. The
  // bicep-deploy worker runs with PILOTSWARM_USE_MANAGED_IDENTITY=1 and
  // authenticates to Azure Blob Storage via the federated CSI UAMI — no
  // shared key. createSessionBlobStore() reads this URL from env. Strip
  // any trailing slash so the value is the canonical account-level form.
  if (!env.AZURE_STORAGE_ACCOUNT_URL && env.BLOB_CONTAINER_ENDPOINT) {
    env.AZURE_STORAGE_ACCOUNT_URL = env.BLOB_CONTAINER_ENDPOINT.replace(/\/+$/, "");
    log("info", `Composed AZURE_STORAGE_ACCOUNT_URL for overlay from BLOB_CONTAINER_ENDPOINT.`);
  }

  // PILOTSWARM_DB_AAD_USER + PILOTSWARM_CMS_FACTS_DATABASE_URL — passwordless
  // AAD URL for CMS + facts pools (pg-pool-factory.ts uses an AAD token
  // callback). The `user@` segment must match the AAD principal name
  // registered as a Postgres administrator (postgres.bicep
  // `aadAdminPrincipalName` → POSTGRES_AAD_ADMIN_PRINCIPAL_NAME). Duroxide
  // stays on the password URL (DATABASE_URL above) because its
  // PostgresProvider has no token-callback hook upstream.
  if (!env.PILOTSWARM_DB_AAD_USER && env.POSTGRES_AAD_ADMIN_PRINCIPAL_NAME) {
    env.PILOTSWARM_DB_AAD_USER = env.POSTGRES_AAD_ADMIN_PRINCIPAL_NAME;
  }
  if (
    !env.PILOTSWARM_CMS_FACTS_DATABASE_URL &&
    env.POSTGRES_FQDN &&
    env.PILOTSWARM_DB_AAD_USER
  ) {
    const pgDb = env.POSTGRES_DATABASE_NAME || "pilotswarm";
    env.PILOTSWARM_CMS_FACTS_DATABASE_URL =
      `postgresql://${encodeURIComponent(env.PILOTSWARM_DB_AAD_USER)}@${env.POSTGRES_FQDN}:5432/${pgDb}?sslmode=require`;
    log("info", `Composed PILOTSWARM_CMS_FACTS_DATABASE_URL (passwordless AAD URL) for CMS + facts.`);
  }
}
