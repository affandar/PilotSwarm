// Seed-secrets stage for the OSS Node deploy orchestrator.
//
// Reads the already-merged env map (deploy/envs/<base>.env +
// deploy/envs/local/<env>/env, with process.env overrides) and writes the
// human-only secrets into the per-stamp Key Vault via
// `az keyvault secret set`. Idempotent: re-running just overwrites.
//
// What lives in the env map: see deploy/scripts/lib/common.mjs::loadEnv.
// new-env.mjs interactively prompts for the required secrets and writes
// them into deploy/envs/local/<env>/env (gitignored). There is no separate
// secrets.env file.
//
// Secret-name mapping is mechanical:
//   ENV_VAR_NAME (uppercase, underscores) → kv-secret-name (lowercase, hyphens)
//   e.g. GITHUB_TOKEN → github-token, ANTHROPIC_API_KEY → anthropic-api-key.
// This matches the AKV object names declared in
// deploy/gitops/worker/base/secret-provider-class.yaml.
//
// What this step does NOT seed:
//   • azure-storage-connection-string → auto-populated by Bicep
//     (deploy/services/base-infra/bicep/auto-secrets.bicep)
//   • DATABASE_URL → not a secret in the bicep-deploy path. It's a config
//     value composed at deploy time from the postgres FQDN + bootstrap
//     password (interim) and projected via the worker-env ConfigMap. Chunk
//     C will switch this to a passwordless URL backed by AAD/workload-
//     identity auth.
//   • KV_NAME, STORAGE_ACCOUNT_NAME, etc. → not secrets; they are deploy-
//     time config in the bicep outputs cache.
//
// Prereqs (enforced):
//   1. KV_NAME present in env (from BaseInfra Bicep outputs cache).
//   2. Caller has Key Vault Secrets Officer (granted by Bicep when
//      `localDeploymentPrincipalId` is set — the default for `npm run deploy`).
//
// If a required key is missing/empty in the env map the step errors out
// with a hint to re-run new-env or edit the local env file directly.

import { log, run } from "./common.mjs";

// The two human-only KV secrets that the bicep deploy flow needs. Both are
// genuinely external (not derivable from infra outputs), so they get
// prompted by new-env and stored in the gitignored local env file.
//
// Format: ENV_NAME → KV secret name. Both shapes are sourced from the same
// objectName/key fields in deploy/gitops/worker/base/secret-provider-class.yaml.
// Sentinel value written to KV when an optional seedable secret was left
// blank by the user. The runtime (packages/sdk/examples/worker.js) strips
// this from process.env at startup so the missing provider is treated as
// disabled rather than misconfigured. AKV / CSI Secret Store both require
// non-empty secret values, so we can't just write "".
export const SEED_SECRETS_UNSET_SENTINEL = "__PS_UNSET__";

export const SEEDABLE_SECRET_KEYS = [
  // GitHub Copilot SDK token. Always required by the worker.
  { env: "GITHUB_TOKEN", kv: "github-token", required: true },
  // Anthropic API key — optional, matches legacy `scripts/deploy-aks.sh`
  // semantics (`${ANTHROPIC_API_KEY:+...}`). When blank, we still write
  // an empty-string secret to KV so the SPC mount succeeds; the runtime
  // sees ANTHROPIC_API_KEY="" and the Anthropic provider simply doesn't
  // load. Stamps using Azure-hosted models via managed identity, or any
  // other non-Anthropic provider, can leave this empty.
  { env: "ANTHROPIC_API_KEY", kv: "anthropic-api-key", required: false, seedEmpty: true },
  // Portal auth/authz config — all optional. When the operator hasn't set
  // PORTAL_AUTH_PROVIDER (or has set it to `none`), the portal runs
  // unauthenticated and these fields are ignored. We still seed the
  // sentinel for every key referenced by
  // deploy/gitops/portal/base/secret-provider-class.yaml so the CSI
  // SecretProviderClass mount succeeds; the portal runtime
  // (packages/portal/server.js) strips sentinel values at startup so the
  // auth provider sees them as truly unset.
  { env: "PORTAL_AUTH_PROVIDER", kv: "portal-auth-provider", required: false, seedEmpty: true },
  { env: "PORTAL_AUTH_ENTRA_TENANT_ID", kv: "portal-auth-entra-tenant-id", required: false, seedEmpty: true },
  { env: "PORTAL_AUTH_ENTRA_CLIENT_ID", kv: "portal-auth-entra-client-id", required: false, seedEmpty: true },
  { env: "PORTAL_AUTHZ_DEFAULT_ROLE", kv: "portal-authz-default-role", required: false, seedEmpty: true },
  { env: "PORTAL_AUTHZ_ADMIN_GROUPS", kv: "portal-authz-admin-groups", required: false, seedEmpty: true },
  { env: "PORTAL_AUTHZ_USER_GROUPS", kv: "portal-authz-user-groups", required: false, seedEmpty: true },
  { env: "PORTAL_AUTH_ALLOW_UNAUTHENTICATED", kv: "portal-auth-allow-unauthenticated", required: false, seedEmpty: true },
  { env: "PORTAL_AUTH_ENTRA_ADMIN_GROUPS", kv: "portal-auth-entra-admin-groups", required: false, seedEmpty: true },
  { env: "PORTAL_AUTH_ENTRA_USER_GROUPS", kv: "portal-auth-entra-user-groups", required: false, seedEmpty: true },
];

/**
 * Seed human-provided secrets into the per-stamp Key Vault.
 *
 * @param {{ envName: string, env: Record<string,string> }} ctx
 */
export async function seedSecrets({ envName, env }) {
  const kvName = env.KV_NAME;
  if (!kvName) {
    throw new Error(
      "seed-secrets: KV_NAME is not set in the env map. " +
      "Run `npm run deploy -- base-infra <env> --steps bicep` first to populate the BaseInfra outputs cache.",
    );
  }

  let setCount = 0;
  const missingRequired = [];

  for (const { env: envKey, kv: kvKey, required, seedEmpty } of SEEDABLE_SECRET_KEYS) {
    const raw = env[envKey];
    const value = raw == null ? "" : String(raw);
    const isEmpty = value.trim() === "";
    let toWrite = value;
    if (isEmpty) {
      if (required) {
        missingRequired.push(envKey);
        continue;
      }
      if (!seedEmpty) {
        // Optional + don't seed sentinel: skip altogether.
        continue;
      }
      // Optional + seedEmpty: write the sentinel so the SPC mount
      // succeeds. The worker strips sentinel values at startup.
      toWrite = SEED_SECRETS_UNSET_SENTINEL;
      log("info", `[seed-secrets] az keyvault secret set --vault-name ${kvName} --name ${kvKey} --value ${SEED_SECRETS_UNSET_SENTINEL} (sentinel; ${envKey} not provided)`);
    } else {
      log("info", `[seed-secrets] az keyvault secret set --vault-name ${kvName} --name ${kvKey} --value <redacted>`);
    }
    run("az", [
      "keyvault",
      "secret",
      "set",
      "--vault-name",
      kvName,
      "--name",
      kvKey,
      "--value",
      toWrite,
      "--output",
      "none",
    ]);
    setCount++;
  }

  if (missingRequired.length) {
    throw new Error(
      `seed-secrets: required key(s) missing or empty for env '${envName}': ${missingRequired.join(", ")}\n` +
      `These are populated by new-env. Run \`npm run deploy:new-env -- ${envName} --force\` to be re-prompted, ` +
      `or edit deploy/envs/local/${envName}/env directly and re-run: ` +
      `npm run deploy -- base-infra ${envName} --steps seed-secrets`,
    );
  }

  log(
    "ok",
    `seed-secrets: set ${setCount} secret(s) (KV=${kvName}).`,
  );
}
