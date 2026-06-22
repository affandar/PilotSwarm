// Portal config keys — non-credential settings that drive the portal's
// auth/authz behavior at runtime.
//
// These keys flow through the same generic env path as every other deploy
// value: prompted by new-env, written into deploy/envs/local/<env>/.env,
// merged by loadEnv into the in-memory env map, substituted into the
// portal overlay .env by substitute-env.mjs, and projected into the pod
// via the overlay-generated `portal-env` ConfigMap (envFrom configMapRef).
// They are NOT written to Key Vault — none of these are credentials
// (string enums, public Entra GUIDs, group object IDs, booleans).
//
// Empty user input is rendered as the SEED_SECRETS_UNSET_SENTINEL so the
// substitute-env fail-closed gate (which rejects empty/unresolved keys)
// is satisfied. The portal runtime (packages/portal/server.js) strips
// sentinel values from process.env at startup, so the auth provider sees
// a missing key as truly unset.
//
// Keep this list aligned with the env vars consumed by
// pilotswarm/packages/portal/auth/config.js. Adding a key here without a
// reader in auth/config.js is dead config; reverse direction silently
// breaks deploys.

export const PORTAL_CONFIG_KEYS = [
  // Auth provider selector. `none` (or unset) → unauthenticated. `entra` →
  // requires the PORTAL_AUTH_ENTRA_* keys below.
  { env: "PORTAL_AUTH_PROVIDER" },
  // Entra (AAD) tenant id — the AAD tenant that owns the app registration.
  { env: "PORTAL_AUTH_ENTRA_TENANT_ID" },
  // Entra app registration client id (the portal's appId).
  { env: "PORTAL_AUTH_ENTRA_CLIENT_ID" },
  // When `true`, allow requests without an authenticated principal. Useful
  // for overlay-mode dev clusters; production should leave this unset.
  { env: "PORTAL_AUTH_ALLOW_UNAUTHENTICATED" },
  // Entra group object ids whose members are admins (legacy provider key).
  { env: "PORTAL_AUTH_ENTRA_ADMIN_GROUPS" },
  // Entra group object ids whose members are users (legacy provider key).
  { env: "PORTAL_AUTH_ENTRA_USER_GROUPS" },
  // Default role assigned to authenticated principals not matched by
  // either admin or user group lists. Typical values: `viewer`, `none`.
  { env: "PORTAL_AUTHZ_DEFAULT_ROLE" },
  // Authz admin group ids (provider-agnostic).
  { env: "PORTAL_AUTHZ_ADMIN_GROUPS" },
  // Authz user group ids (provider-agnostic).
  { env: "PORTAL_AUTHZ_USER_GROUPS" },
  // User OBO Propagation. Downstream resource scope acquired by
  // the portal MSAL flow at sign-in / silent refresh. Typical value:
  // `api://<worker-app>/.default` (the worker-side AAD app the consumer's
  // tools exchange OBO tokens against). When unset, the portal skips
  // downstream-scope acquisition entirely and the worker receives a
  // principal-only envelope — strictly backwards-compatible with stamps
  // that don't use OBO. `offline_access` is added automatically by the
  // portal MSAL code; do NOT include it in this value.
  { env: "PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE" },
];
