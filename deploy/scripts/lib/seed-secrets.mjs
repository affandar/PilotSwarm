// Seed-secrets stage for the OSS Node deploy orchestrator.
//
// Reads the already-merged env map (deploy/envs/<base>.env +
// deploy/envs/local/<env>/.env, with process.env overrides) and writes the
// human-only secrets into the per-stamp Key Vault via
// `az keyvault secret set`. Idempotent: re-running just overwrites.
//
// What lives in the env map: see deploy/scripts/lib/common.mjs::loadEnv.
// new-env.mjs interactively prompts for the required secrets and writes
// them into deploy/envs/local/<env>/.env (gitignored). There is no separate
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
  // GitHub Copilot SDK token. Optional with seedEmpty: a stamp without
  // a worker-level token still deploys cleanly; users supply their own
  // PAT via the Admin panel (per-user GitHub Copilot key), and the SDK
  // throws a clear actionable error if nobody has done so before a
  // github-copilot:* session is created.
  { env: "GITHUB_TOKEN", kv: "github-token", required: false, seedEmpty: true },
  // Anthropic API key — optional, matches legacy `scripts/deploy-aks.sh`
  // semantics (`${ANTHROPIC_API_KEY:+...}`). When blank, we still write
  // an empty-string secret to KV so the SPC mount succeeds; the runtime
  // sees ANTHROPIC_API_KEY="" and the Anthropic provider simply doesn't
  // load. Stamps using Azure-hosted models via managed identity, or any
  // other non-Anthropic provider, can leave this empty.
  { env: "ANTHROPIC_API_KEY", kv: "anthropic-api-key", required: false, seedEmpty: true },
  // git-cache ADO PAT — read-only Azure DevOps Personal Access Token the
  // per-repo git-cache DaemonSet uses to mirror private ADO repos. Optional
  // with seedEmpty so base-infra `all` succeeds on stamps that run no fleets
  // (git-cache is a per-instance service, not part of `all`); the sentinel
  // keeps the git-cache SecretProviderClass mount valid. Fleet operators set
  // GIT_CACHE_ADO_PAT in the stamp .env before `deploy -- all` so the real
  // token is seeded here. The KV secret name matches the objectName in
  // deploy/gitops/git-cache/base/secret-provider-class.yaml (git-cache-ado-pat).
  { env: "GIT_CACHE_ADO_PAT", kv: "git-cache-ado-pat", required: false, seedEmpty: true },
  // Portal auth/authz config (PORTAL_AUTH_* / PORTAL_AUTHZ_*) used to live
  // here as KV secrets. They are NOT credentials — Entra tenant/client
  // GUIDs and group object ids are public; provider/default-role/allow-unauth
  // are policy strings/booleans. They moved to PORTAL_CONFIG_KEYS in
  // ./portal-config.mjs and now flow through the overlay .env →
  // `portal-env` ConfigMap path instead of KV. The portal SPC was trimmed
  // to the 3 genuine credentials accordingly.
];

/**
 * Look up the current value of a KV secret. Never throws (allowFail) so the
 * caller can decide what to do; distinguishes a positively-absent secret from
 * an ambiguous read failure so the caller can be conservative on the latter.
 *
 * @param {typeof run} runFn
 * @param {string} kvName
 * @param {string} kvKey
 * @returns {{ status: "found" | "absent" | "unknown", value: string | null }}
 *   - found:   the secret exists; `value` is its trimmed value ("" → null).
 *   - absent:  the secret positively does not exist in the vault.
 *   - unknown: the lookup failed for another reason (permissions, throttling,
 *              network). The caller MUST NOT overwrite on this result — it
 *              can't tell whether a real value is being shadowed by the error.
 */
function readCurrentKvSecret(runFn, kvName, kvKey) {
  const res = runFn(
    "az",
    [
      "keyvault",
      "secret",
      "show",
      "--vault-name",
      kvName,
      "--name",
      kvKey,
      "--query",
      "value",
      "--output",
      "tsv",
    ],
    { capture: true, allowFail: true },
  );
  if (res && res.status === 0) {
    const v = (res.stdout ?? "").trim();
    return { status: "found", value: v === "" ? null : v };
  }
  // az surfaces a missing secret as "(SecretNotFound) ... was not found in
  // this key vault". Anything else (auth, throttling, network) is ambiguous.
  const stderr = (res?.stderr ?? "").toLowerCase();
  if (stderr.includes("secretnotfound") || stderr.includes("was not found")) {
    return { status: "absent", value: null };
  }
  return { status: "unknown", value: null };
}

/**
 * Seed human-provided secrets into the per-stamp Key Vault.
 *
 * @param {{ envName: string, env: Record<string,string> }} ctx
 * @param {{ run?: typeof run }} [deps] injectable CLI runner (tests).
 */
export async function seedSecrets({ envName, env }, deps = {}) {
  const runFn = deps.run ?? run;
  const kvName = env.KV_NAME;
  if (!kvName) {
    throw new Error(
      "seed-secrets: KV_NAME is not set in the env map. " +
      "Run `npm run deploy -- base-infra <env> --steps bicep` first to populate the BaseInfra outputs cache.",
    );
  }

  let setCount = 0;
  let preservedCount = 0;
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
      // Optional + seedEmpty. Before writing the sentinel, preserve any real
      // value already in KV. A prior deploy (or an operator) may have seeded a
      // genuine secret here; overwriting it with the sentinel on a subsequent
      // deploy that happens to run with a blank env would silently break the
      // dependent service (e.g. git-cache can no longer authenticate to ADO).
      // "Blank env" therefore means "leave whatever is in KV" — clearing a
      // secret back to unset is an explicit KV operation, not a side effect of
      // an incomplete env map.
      const current = readCurrentKvSecret(runFn, kvName, kvKey);
      if (current.status === "unknown") {
        // Couldn't read the current value; be conservative and do NOT write,
        // to avoid clobbering a real secret we simply failed to read.
        log("warn", `[seed-secrets] ${kvKey}: could not read current KV value; leaving it untouched (set ${envKey} to force a write).`);
        preservedCount++;
        continue;
      }
      if (current.status === "found" && current.value != null && current.value !== SEED_SECRETS_UNSET_SENTINEL) {
        log("info", `[seed-secrets] ${kvKey}: ${envKey} not provided but KV already holds a real value — preserving it (not overwriting with sentinel).`);
        preservedCount++;
        continue;
      }
      // Positively absent, or already the sentinel/empty: seed the sentinel so
      // the SPC mount succeeds. The worker strips sentinel values at startup.
      toWrite = SEED_SECRETS_UNSET_SENTINEL;
      log("info", `[seed-secrets] az keyvault secret set --vault-name ${kvName} --name ${kvKey} --value ${SEED_SECRETS_UNSET_SENTINEL} (sentinel; ${envKey} not provided)`);
    } else {
      log("info", `[seed-secrets] az keyvault secret set --vault-name ${kvName} --name ${kvKey} --value <redacted>`);
    }
    runFn("az", [
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
      `or edit deploy/envs/local/${envName}/.env directly and re-run: ` +
      `npm run deploy -- base-infra ${envName} --steps seed-secrets`,
    );
  }

  log(
    "ok",
    `seed-secrets: set ${setCount} secret(s)` +
      (preservedCount ? `, preserved ${preservedCount} existing KV value(s)` : "") +
      ` (KV=${kvName}).`,
  );
}
