# OBO KEK Runbook

> Operator runbook for the User OBO Propagation key (`obo-user-token-kek`).
>
> See also:
> [`docs/operations/live-smoke.md`](./live-smoke.md) — repeatable
> `pilotswarm smoke <stamp> --profile obo` harness for verifying the
> end-to-end OBO path on a deployed stamp after the KEK is in place.
>
> Per-stamp downstream worker AAD app provisioning for the live-smoke
> harness is driven by `deploy/scripts/auth/Setup-OboSmokeWorkerApp.ps1`
> (see `deploy/scripts/auth/README.md` § "OBO smoke worker app" and the
> `pilotswarm-obo-smoke-app-reg` skill). The KEK runbook below focuses
> on the **envelope-encryption key**; the smoke worker app and its FIC
> are an orthogonal concern handled by the wrapper.

## Overview

The OBO KEK is the AKV-resident RSA key the worker's `AkvEnvelopeCrypto`
backend uses to **unwrap** per-RPC user access tokens forwarded by the portal,
and the portal's MSAL-driven encrypt path uses to **wrap** them on the wire.
It exists solely to keep user access tokens off untrusted storage / network
paths between the portal and worker pods while preserving the durable-
orchestration history shape.

Single shared key per stamp. Provisioned by
`deploy/services/base-infra/bicep/keyvault.bicep` when the per-env
`OBO_ENABLED=true` flag is set. Identical name across all stamps:
`obo-user-token-kek`. Identical shape:

| Property | Value | Rationale |
|---|---|---|
| `kty` | `RSA` | AKV Standard tier compatibility |
| `keySize` | `2048` | Sufficient for token-wrapping; minimal latency |
| `keyOps` | `wrapKey`, `unwrapKey` | Least privilege — no sign / encrypt / decrypt |
| Rotation | Auto-rotate every 365 days | Captured in the bicep `rotationPolicy` |
| Prior versions | Retained | In-flight ciphertext referencing older versions remains decryptable |
| `OBO_KEK_KID` | Un-versioned key URL | Version is pinned per-envelope via the ciphertext `kekKid` field |

## Pre-provisioning checklist

1. **Confirm OBO is intended for this stamp.** OBO is opt-in; stamps that
   don't use it should not have the KEK provisioned.
2. **Choose UAMI topology**:
   - PilotSwarm reference deploy: single shared CSI UAMI federated to both
     portal and worker SAs. `oboKekUamiPrincipalIds` resolves to
     `[csiIdentity.principalId]` — one role assignment emitted.
   - Downstream forks with distinct portal/worker UAMIs: pass an N-element
     array; the keyvault module's `for principalId in oboKekUamiPrincipalIds`
     loop emits one role assignment per principal.
3. **Set `OBO_ENABLED=true`** in `deploy/envs/local/<env>/.env`.
4. **Set `PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE`** in the same file, e.g.
   `api://<worker-app>/.default`. The downstream worker AAD app is the
   consumer's responsibility per stamp.
5. **Deploy base-infra.** `npm run deploy -- --env <env> --steps bicep`
   provisions the KEK and emits `OBO_KEK_KID` into the env map.
6. **Deploy worker + portal.** `npm run deploy -- --env <env> --steps manifests,rollout`
   substitutes `OBO_KEK_KID` into the worker / portal pod env via the
   overlay-generated ConfigMaps.

## RBAC verification

After base-infra deploys, confirm the role assignments landed:

```bash
# Replace <vault-name>, <vault-rg>, <uami-principal-id> with stamp values.
az role assignment list \
  --scope "/subscriptions/<sub-id>/resourceGroups/<vault-rg>/providers/Microsoft.KeyVault/vaults/<vault-name>" \
  --assignee <uami-principal-id> \
  --query "[?roleDefinitionName=='Key Vault Crypto User']"
```

Expected output: one entry per UAMI principal id passed in
`oboKekUamiPrincipalIds`. If the array was empty or `oboEnabled=false`, no
entry is returned.

## Rotation procedure (manual, operator-initiated)

The bicep `rotationPolicy` triggers an automatic rotation event every 365
days. Operators may force-rotate sooner using the following procedure;
**do not** delete prior key versions until both retention conditions
are satisfied.

1. **Enable a new version** of the key:

   ```bash
   az keyvault key create \
     --vault-name <vault-name> \
     --name obo-user-token-kek \
     --kty RSA \
     --size 2048 \
     --ops wrapKey unwrapKey
   ```

   This appends a new version under the existing key name. `OBO_KEK_KID`
   (un-versioned URL) does not change; new ciphertext envelopes start
   referencing the new version automatically.

2. **Wait the retention + drain window** before considering the previous
   version eligible for cleanup:

   - Maximum activity-history retention (per CMS schema): typically 30
     days. Any tool-call ciphertext written earlier and not yet replayed
     references the old version.
   - Queue drain time: any in-flight `runTurn` activity carries the
     ciphertext through replay until completion. Wait for the longest-
     running session to drain.

   Practical operator default: **wait at least 60 days** before considering
   any version cleanup.

3. **Optional cleanup** (do not do this routinely; key versions are cheap
   to retain): `az keyvault key delete-version` is **not exposed** by AKV
   — older versions are retained until the key itself is purged. To
   actually purge, recreate the key with a fresh history. Do not do this
   unless you have a verified compliance reason.

## Emergency revocation

If a stamp's OBO chain is compromised (e.g. portal pod token leak under
investigation):

1. **Revoke the UAMI's role**:

   ```bash
   az role assignment delete \
     --scope "/subscriptions/<sub-id>/resourceGroups/<vault-rg>/providers/Microsoft.KeyVault/vaults/<vault-name>" \
     --assignee <uami-principal-id> \
     --role "Key Vault Crypto User"
   ```

2. **Effect on users**: all in-flight ciphertext stays undecryptable from
   the worker side. Tools that need the user token will emit
   `serviceUnavailable({ reasonCode: "akv_unwrap_failure" })` and users
   see a re-auth affordance in the portal UI. Tools that only need the
   principal envelope (admission, profile, Copilot-key RPCs) continue to
   operate.

3. **Restore** by re-running the deploy with `OBO_ENABLED=true` (the
   role assignment is idempotent via deterministic `guid()` naming).

## AKV throughput sizing

AKV Standard tier has a soft cap of **~1000 transactions per 10 seconds
per vault** (shared across **all** crypto and secret operations in the
vault, not per key). Each portal → worker RPC that carries a user token
performs:

- One `wrapKey` operation portal-side (per RPC).
- One `unwrapKey` operation worker-side (per tool call that calls
  `getUserContextForSession()` and the cached plaintext is stale).

Practical guidance:

- **Single-tenant stamps with < 100 concurrent users**: Standard tier is
  sufficient; the OBO operations are a fraction of the ambient KV traffic
  (CSI secret reads, cert-manager refreshes).
- **Multi-tenant stamps**: monitor AKV `Microsoft.KeyVault/Vaults` 429
  responses. If you see sustained throttling, escalate to Premium
  tier (~5× the throughput) or to a Managed HSM (per-pool quotas).

Recommended alert: `count >= 5 of HTTP 429 responses on
Microsoft.KeyVault/Vaults/<vault-name> in 5 minutes` → page operator.

## Sentinel semantics

The base-infra bicep `oboKekKid` output emits the substitute-env sentinel
`__PS_UNSET__` when `OBO_ENABLED=false`. The portal and worker runtimes
strip sentinel values from `process.env` at startup, so the application
sees `OBO_KEK_KID` as truly unset and `selectEnvelopeCrypto(env)` returns
`null`. In that mode, per-RPC envelopes carry only the principal claims
(no `accessTokenCipher` field) and tools see `accessToken: null` from
`getUserContextForSession()` — strictly backwards-compatible.

## Cross-references

- Public SDK API: [`docs/sdk/user-context.md`](../sdk/user-context.md)
- Configuration env reference: [`docs/configuration.md`](../configuration.md)
- Reference smoke plugin: [`examples/obo-smoke/`](../../examples/obo-smoke/)
- Release-gate manual smoke checklist:
  [`examples/obo-smoke/SMOKE_CHECKLIST.md`](../../examples/obo-smoke/SMOKE_CHECKLIST.md)
