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
  // `aadAdminPrincipalName` → POSTGRES_AAD_ADMIN_PRINCIPAL_NAME). The
  // duroxide orchestration store also honours the MI switch via
  // duroxide-node's native Entra path (PostgresProvider
  // .connectWithSchemaAndEntra, available since duroxide-node 0.1.25);
  // when PILOTSWARM_USE_MANAGED_IDENTITY=1 the worker reuses the same
  // AAD user / passwordless URL for the duroxide store too.
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

  // User OBO Propagation. The base-infra bicep emits oboKekKid
  // either as the un-versioned AKV key URL (when oboEnabled=true) or as
  // the substitute-env sentinel (when oboEnabled=false). For deploy flows
  // that skip the `bicep` step (e.g., `--steps manifests,rollout` without
  // a populated outputs cache) we fall back to the sentinel so substitute-
  // env stays satisfied. The worker / portal runtime strips sentinel
  // values at startup, so OBO is treated as truly unconfigured and the
  // existing principal-only envelope path engages (FR-002 backwards-compat).
  if (!env.OBO_KEK_KID) {
    env.OBO_KEK_KID = "__PS_UNSET__";
    log("info", `Composed OBO_KEK_KID fallback to __PS_UNSET__ sentinel (OBO not enabled or bicep output absent).`);
  }
  if (!env.PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE) {
    env.PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE = "__PS_UNSET__";
    log("info", `Composed PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE fallback to __PS_UNSET__ sentinel (OBO not enabled or scope not configured).`);
  }
  // Live-smoke harness (FR-026). Worker-only toggle that
  // gates the OBO smoke plugin's tool registration. Default to the
  // substitute-env sentinel so non-smoke stamps and stamps that
  // simply omit the value still satisfy substitute-env. The worker's
  // startup sentinel-strip turns __PS_UNSET__ into an unset env var,
  // which the registration if-check correctly treats as false.
  if (!env.OBO_SMOKE_ENABLED) {
    env.OBO_SMOKE_ENABLED = "__PS_UNSET__";
    log("info", `Composed OBO_SMOKE_ENABLED fallback to __PS_UNSET__ sentinel (smoke plugin not enabled on this stamp).`);
  }
  // Live-smoke harness (FR-026). Per-stamp downstream-app
  // identity consumed by the smoke plugin's auth backend at handler
  // time. Sentinel default keeps substitute-env happy on non-smoke
  // stamps; the worker's startup sentinel-strip turns __PS_UNSET__ into
  // unset env vars so the smoke plugin fast-fails with
  // serviceUnavailable({ reasonCode: "smoke_misconfigured" }) if a
  // smoke stamp forgot to populate them.
  for (const key of [
    "OBO_SMOKE_WORKER_APP_TENANT_ID",
    "OBO_SMOKE_WORKER_APP_CLIENT_ID",
    "OBO_SMOKE_WORKER_APP_GRAPH_SCOPE",
    "OBO_SMOKE_TEST_USER_UPN",
  ]) {
    if (!env[key]) {
      env[key] = "__PS_UNSET__";
      log("info", `Composed ${key} fallback to __PS_UNSET__ sentinel (smoke plugin downstream-app not configured on this stamp).`);
    }
  }
}
