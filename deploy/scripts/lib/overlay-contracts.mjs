// Single source of truth for per-overlay env-key contracts.
//
// Each portal overlay (the value `resolveOverlayKey()` returns) maps to a
// contract with four role buckets:
//
//   userRequiredEnvKeys: must be present + non-empty BEFORE deploy.mjs runs
//                    any step. Operator-supplied (new-env scaffold or
//                    hand-edited deploy/envs/local/<env>/.env).
//   composedEnvKeys: populated by compose-env.mjs from upstream bicep
//                    outputs (POSTGRES_FQDN, BLOB_CONTAINER_ENDPOINT, …).
//                    Required at substitute time, not at the pre-deploy
//                    gate (chicken-and-egg: bicep step produces the inputs
//                    they're composed from).
//   stubKeys:        off-path keys that must exist in the env Map for
//                    substitute-env.mjs's target-based fail-closed gate
//                    to succeed. deploy.mjs auto-fills these with the
//                    `unused` sentinel.
//   bicepOutputKeys: populated by deploy-bicep.mjs via the OUTPUT_ALIAS
//                    map (or sourced from the base template.env, for the
//                    handful of static keys this group also covers).
//                    Required at substitute time but not at the pre-deploy
//                    validator.
//
// Adding a new overlay key is a one-line change in this file —
// deploy.mjs / new-env.mjs pick it up automatically via the contract
// table.

// Edge mode and TLS source value spaces. Mirrors `new-env.mjs` EDGE_MODES /
// TLS_SOURCES — kept in sync via overlay-contracts.test.mjs.
export const EDGE_MODES = ["afd", "private"];
export const TLS_SOURCES = ["letsencrypt", "akv", "akv-selfsigned"];

// JS-side authoritative defaults. Single source of truth — referenced by
// stage-manifests.mjs:resolveOverlayName() and portal/bicep/main.bicep
// (the bicep-side defaults carry a comment pointer to this file).
export const DEFAULT_EDGE_MODE = "afd";
export const DEFAULT_TLS_SOURCE = "letsencrypt";

// Collapse `akv-selfsigned` → `akv` (the two share a single overlay; the
// only delta is the AKV issuer name, owned by Portal bicep). Mirrors
// stage-manifests.mjs's resolveOverlayName().
function collapseTlsSource(tlsSource) {
  return tlsSource === "akv-selfsigned" ? "akv" : tlsSource;
}

// (edgeMode, tlsSource) → overlay directory key under
// deploy/gitops/portal/overlays/. Single source of truth.
export function resolveOverlayKey({ edgeMode, tlsSource }) {
  const em = (edgeMode || DEFAULT_EDGE_MODE).toLowerCase();
  const ts = collapseTlsSource((tlsSource || DEFAULT_TLS_SOURCE).toLowerCase());
  return `${em}-${ts}`;
}

// Shared roster: keys substituted into the portal overlay `.env` from
// bicep outputs (via deploy-bicep.mjs's OUTPUT_ALIAS) or seeded from the
// base template.env (the NAMESPACE / PILOTSWARM_USE_MANAGED_IDENTITY pair).
// Identical across all three overlays today; kept as a named constant so a
// future divergence is a single-line change per overlay.
const SHARED_BICEP_OUTPUT_KEYS = Object.freeze([
  "IMAGE",
  "NAMESPACE",
  "KV_NAME",
  "WORKLOAD_IDENTITY_CLIENT_ID",
  "AZURE_TENANT_ID",
  "PORTAL_HOSTNAME",
  "PILOTSWARM_USE_MANAGED_IDENTITY",
  "SPC_KEYS_HASH",
  "PORTAL_AUTH_PROVIDER",
  "PORTAL_AUTH_ENTRA_TENANT_ID",
  "PORTAL_AUTH_ENTRA_CLIENT_ID",
  "PORTAL_AUTH_ALLOW_UNAUTHENTICATED",
  "PORTAL_AUTH_ENTRA_ADMIN_GROUPS",
  "PORTAL_AUTH_ENTRA_USER_GROUPS",
  "PORTAL_AUTHZ_DEFAULT_ROLE",
  "PORTAL_AUTHZ_ADMIN_GROUPS",
  "PORTAL_AUTHZ_USER_GROUPS",
  "PORTAL_AUTHZ_ENTRA_ADMIN_ROLE_NAMES",
  "PORTAL_AUTHZ_ENTRA_USER_ROLE_NAMES",
]);

// Shared composed-key roster (populated by compose-env.mjs from prior
// bicep outputs). Identical across all three overlays.
const SHARED_COMPOSED_ENV_KEYS = Object.freeze([
  "AZURE_STORAGE_ACCOUNT_URL",
  "PILOTSWARM_CMS_FACTS_DATABASE_URL",
  "PILOTSWARM_DB_AAD_USER",
  "DATABASE_URL",
]);

// Per-overlay contracts.
export const OVERLAY_CONTRACTS = Object.freeze({
  "afd-akv": Object.freeze({
    userRequiredEnvKeys: Object.freeze([
      "SSL_CERT_DOMAIN_SUFFIX",
    ]),
    composedEnvKeys: SHARED_COMPOSED_ENV_KEYS,
    stubKeys: Object.freeze([
      "PRIVATE_DNS_ZONE",
      "AKS_VNET_ID",
      "ACME_EMAIL",
    ]),
    bicepOutputKeys: SHARED_BICEP_OUTPUT_KEYS,
  }),
  "afd-letsencrypt": Object.freeze({
    userRequiredEnvKeys: Object.freeze([
      "ACME_EMAIL",
    ]),
    composedEnvKeys: SHARED_COMPOSED_ENV_KEYS,
    stubKeys: Object.freeze([
      "PRIVATE_DNS_ZONE",
      "AKS_VNET_ID",
      "SSL_CERT_DOMAIN_SUFFIX",
    ]),
    bicepOutputKeys: SHARED_BICEP_OUTPUT_KEYS,
  }),
  "private-akv": Object.freeze({
    userRequiredEnvKeys: Object.freeze([
      "HOST",
      "PRIVATE_DNS_ZONE",
      "AKS_VNET_ID",
    ]),
    composedEnvKeys: SHARED_COMPOSED_ENV_KEYS,
    stubKeys: Object.freeze([
      "FRONT_DOOR_PROFILE_NAME",
      "FRONT_DOOR_PROFILE_RESOURCE_GROUP",
      "FRONT_DOOR_ENDPOINT_NAME",
      "APPLICATION_GATEWAY_NAME",
      "PRIVATE_LINK_CONFIGURATION_NAME",
      "SSL_CERT_DOMAIN_SUFFIX",
      "ACME_EMAIL",
    ]),
    bicepOutputKeys: SHARED_BICEP_OUTPUT_KEYS,
  }),
});

// Return the contract for a given (edgeMode, tlsSource). Throws if the
// resolved overlay key is unknown — that's a hard bug, not user error.
export function getContract({ edgeMode, tlsSource }) {
  const key = resolveOverlayKey({ edgeMode, tlsSource });
  const c = OVERLAY_CONTRACTS[key];
  if (!c) {
    throw new Error(
      `overlay-contracts: no contract for resolved overlay '${key}' ` +
        `(EDGE_MODE='${edgeMode}' TLS_SOURCE='${tlsSource}'). ` +
        `Add an entry to OVERLAY_CONTRACTS in deploy/scripts/lib/overlay-contracts.mjs.`,
    );
  }
  return c;
}

// Pre-deploy validator. Asserts every userRequiredEnvKey is present in
// `env` and non-empty. Returns an array of missing keys (empty = OK).
// Callers decide whether to throw or log — deploy.mjs throws via
// process.exit(1); new-env.mjs warn-and-continues at scaffold time.
export function validateRequiredEnv({ edgeMode, tlsSource, env }) {
  const contract = getContract({ edgeMode, tlsSource });
  const missing = [];
  for (const k of contract.userRequiredEnvKeys) {
    const v = env[k];
    if (v === undefined || v === null || String(v).trim() === "") {
      missing.push(k);
    }
  }
  // ACME_EMAIL gets a stricter shape check on letsencrypt — preserves
  // the prior deploy.mjs behaviour. We do it here so the contract is the
  // sole owner of "what counts as valid for this overlay".
  if (tlsSource === "letsencrypt") {
    const ace = env.ACME_EMAIL;
    if (ace && String(ace).trim() !== "" && !String(ace).includes("@")) {
      missing.push("ACME_EMAIL"); // present but malformed → treat as missing
    }
  }
  return missing;
}

// Off-path stub-fill. Mutates `env` in place, setting any stubKey that
// is currently blank to the `unused` sentinel. Driven by the contract so
// adding a new off-path key is a one-line change in this file.
export function applyStubKeys({ edgeMode, tlsSource, env }) {
  const contract = getContract({ edgeMode, tlsSource });
  const STUB = "unused";
  const stubbed = [];
  for (const k of contract.stubKeys) {
    if (!env[k] || String(env[k]).trim() === "") {
      env[k] = STUB;
      stubbed.push(k);
    }
  }
  return stubbed;
}
