---
name: pilotswarm-new-env-deploy
description: "Use when bringing up a fresh, isolated PilotSwarm environment (`mysandbox`, `chkrawps10`, etc.) via the npm Bicep/GitOps orchestrator at `deploy/scripts/deploy.mjs`. Covers `new-env` scaffolding, EDGE_MODE × TLS_SOURCE selection, the `all` aggregate, per-service redeploys with `--steps`, force-redeploy semantics, verification, and teardown. Strictly separate from the legacy bash path operated by `scripts/deploy-aks.sh`."
---

# PilotSwarm New-Environment Deploy

Use this skill when the user wants a **brand-new, isolated** PilotSwarm
environment (e.g. `mysandbox`, `chkrawps10`) into a fresh resource group
— not when they are operating an already-deployed PilotSwarm cluster.

For the **legacy** path (`scripts/deploy-aks.sh`,
`scripts/deploy-portal.sh`, `deploy/k8s/**`), use the existing
`pilotswarm-aks-deploy` skill instead. Do not mix paths. The two
orchestrators operate on disjoint resource groups, identities, and
manifests.

## Canonical References

Always treat these as source of truth — `deploy/scripts/README.md` is
updated in lockstep with the code, this skill is a procedural overlay:

- `deploy/scripts/README.md` — full orchestrator reference (services, steps, EDGE_MODE × TLS_SOURCE, troubleshooting).
- `deploy/envs/template.env` — every operator-settable env key with inline documentation.
- `deploy/scripts/new-env.mjs` — scaffolder; declarative `INPUTS` array is the canonical CLI flag/prompt source.
- `deploy/scripts/deploy.mjs` — orchestrator; canonical step matrix, `--force` / `--force-module`, `UNSUPPORTED_COMBOS`.
- `deploy/services/*/deploy.json` + `deploy/services/deploy-manifest.json` — service catalog + module wiring.

## Topology Produced

| Tier | Resource | Notes |
|---|---|---|
| Global | AFD Premium profile, AFD WAF policy, Global RG | Only when `EDGE_MODE=afd` |
| T2 | Control AKS, ACR, Postgres Flex, Storage, Key Vault, UAMIs, Flux | Always |
| T2 edge (afd) | AppGw v2 + WAF + Private Link Service + AGIC | `EDGE_MODE=afd` |
| T2 edge (private) | AKS web-app-routing (NGINX) on ILB + Private DNS Zone | `EDGE_MODE=private` |
| T3 | Ephemeral worker AKS + workload-SA UAMI + Flux + `worker-t3-manifests` blob container | Always |
| Cross-cluster | T2 csi UAMI gets `AKS Cluster User Role` on T3 | For T2 worker → T3 kubeconfig minting |

## Pre-flight Checklist

Run through every item before running `new-env`:

- **Tooling**: Node ≥ 20, `az`, `docker`, `oras`, `kubectl`, `flux`. The orchestrator validates lazily per `--steps`, but `all` needs all of them.
- **Azure sign-in**: `az login --tenant <tenant-id>` then `az account set --subscription <sub-id>`. Mismatch is rejected by the tenant/subscription pin guard before any mutation.
- **Protected-name collision**: the chosen env name `X` derives `psX` as the resource-name prefix. The reserved names `dev` and `prod` (enterprise ServiceGroup labels) are NOT valid OSS env names. The scaffolder fails-closed if a derived name would collide with a protected literal; pick a different `X`.

## Step 0 — Decide auth posture FIRST

Before opening the defaults table, settle the portal-auth question. The
answer determines whether `PORTAL_AUTH_ENTRA_CLIENT_ID` is "user
provides it" or "we produce it via a pre-step" — and the user must
know that before they see the table.

Ask, in order:

1. **"Do you want browser sign-in (Entra) on this stamp, or an open
   sandbox?"**
   - `none` → `PORTAL_AUTH_PROVIDER=none`, no app-registration step.
     Skip the rest of Step 0.
   - `entra` → continue.
2. **"Do you already have a `PORTAL_AUTH_ENTRA_CLIENT_ID` (an existing
   Entra app registration), or shall I provision one for this stamp?"**
   - **Default recommendation: provision a new dedicated app for this
     stamp.** One app per stamp keeps redirect URI lists clean, lets
     each environment be retired (and its app deleted) independently,
     and avoids the "shared app blast radius" where revoking one
     stamp's access touches every other stamp on the same client id.
     Only reuse a shared existing app when the user explicitly asks
     for it (e.g. they want a single SSO consent prompt across all
     dev stamps, or tenant policy makes app creation expensive).
   - "Provision one" (recommended) → invoke the
     `pilotswarm-portal-app-reg` skill **before** Step 1. That skill
     produces the `clientId` and writes it to
     `deploy/envs/local/<stamp>/entra-app.json`. The skill requires
     `-ServiceTreeId` — ask the user for theirs before invoking; do
     not invent a placeholder.
   - "I have one / I want to share" → take the client id directly, or
     invoke the skill in append mode (`-ExistingAppId <appId> -EnvName <stamp>`).
3. **"Should sign-in be locked down to assigned users only, or open to
   any tenant member?"** (only when `entra` and provisioning new)
   - **Production stamp** → recommend `-CreateAppRoles -AssignmentRequired`.
     With assignment-required, only users explicitly assigned to a role
     (`admin` or `user`) can sign in. Closes the gap where a tenant user
     with no role assignment still gets `PORTAL_AUTHZ_DEFAULT_ROLE`.
   - **Sandbox / dev stamp** → defaults are fine. Any tenant user signs
     in; `defaultRole` decides their effective access.

Order matters operationally:

- **Best path (preferred):** run app-reg BEFORE `new-env`. The script
  can create the app shell with an empty redirect URI list, you scaffold
  the stamp with the resulting client id already in place, then after
  the bicep step you re-run the wrapper with `-ExistingAppId` to add
  the now-known AFD endpoint.
- **Acceptable path:** scaffold with `PORTAL_AUTH_PROVIDER=none`, deploy
  to get the AFD endpoint, then run the wrapper with `-EnvName` for
  auto-discovery, then flip provider to `entra` in
  `deploy/envs/local/<stamp>/.env` and re-run `deploy.mjs portal <stamp> --steps manifests,rollout`.

Pick one explicitly with the user; do not silently improvise.

## Step 1 — Discover environment defaults

Before opening the dialogue, run a quick discovery so the user sees
**real values**, not placeholders:

```bash
az account show --query "{sub:id, subName:name, user:user.name, tenant:tenantId}" -o json
gh auth status      # confirms a token is available for GITHUB_TOKEN
```

Cache the result for the rest of the conversation. Surface:
- `sub` + `subName` → default `--subscription`
- `tenant` → default `PORTAL_AUTH_ENTRA_TENANT_ID` (whatever `az account show` returns)
- `user` (UPN) → **suggested** `ACME_EMAIL`, but **always** ask the
  user to confirm or override before using it. The UPN may not be the
  right address for cert-renewal notices (shared mailbox preferred for
  prod). Do **not** auto-suggest the UPN for `PORTAL_AUTHZ_ADMIN_GROUPS`
  — that field is posture-dependent (only populate when posture is
  Open; leave empty when -CreateAppRoles is set).
- `gh` status → if logged in, offer to run `gh auth token` to populate
  `GITHUB_TOKEN`; if not, default it to empty (sentinel)

## Step 2 — Present the full input surface upfront

Always show the **entire** input surface in a single table — not just
name/location/edge-mode. The user must be able to confirm or override
every value before the script runs, so a non-interactive run is just as
safe as an interactive walk.

Group the table into four blocks: **Core**, **Edge/TLS**, **Per-stamp
secrets**, **Portal auth**. Mark each value `(default)`,
`(discovered)`, or `(required)`:

```
Core
  name                          <required>          # /^[a-z][a-z0-9]{0,11}$/, not dev|prod
  subscription                  <discovered: ${sub} — ${subName}>
  location                      westus3 (default)
  region-short                  <derived from deploy-manifest.json>
  foundry-enabled               y (default)

Edge / TLS
  edge-mode                     afd (default)         # afd | private
  tls-source                    letsencrypt (default) # letsencrypt | akv | akv-selfsigned
  acme-email                    <suggested: ${user}; CONFIRM OR OVERRIDE> # only when tls-source=letsencrypt
  host                          portal (default)      # only when edge-mode=private
  private-dns-zone              <required>            # only when edge-mode=private

Per-stamp secrets (Key Vault)
  GITHUB_TOKEN                  <offer `gh auth token`>  # optional; sentinel if empty
  AZURE_MODEL_ROUTER_KEY        <skip / sentinel>       # optional
  AZURE_FW_GLM5_KEY             <skip / sentinel>       # optional
  AZURE_KIMI_K25_KEY            <skip / sentinel>       # optional
  AZURE_OAI_KEY                 <skip / sentinel>       # optional
  AZURE_OSS_DB_KEY              <skip / sentinel>       # optional

Portal auth (ConfigMap) — fields depend on auth posture
  PORTAL_AUTH_PROVIDER          entra (default)
  PORTAL_AUTH_ENTRA_TENANT_ID   <discovered: ${tenant}>
  PORTAL_AUTH_ENTRA_CLIENT_ID   <required if provider=entra>   # app-reg client id
                                                               # see pilotswarm-portal-app-reg skill if you don't have one
  PORTAL_AUTH_ALLOW_UNAUTHENTICATED  false (default)
  PORTAL_AUTHZ_DEFAULT_ROLE          user (default)

  # If posture = Open (no app roles):
  PORTAL_AUTHZ_ADMIN_GROUPS          <suggested: ${user}; CONFIRM OR OVERRIDE>   # email allowlist
  PORTAL_AUTHZ_USER_GROUPS           <empty> (default)                            # email allowlist

  # If posture = Roles, no lockdown OR Roles + lockdown (-CreateAppRoles set):
  PORTAL_AUTHZ_ENTRA_ADMIN_ROLE_NAME <empty> (default → suffix-strip)         # optional: app-role `value` that maps to engine `admin`
  PORTAL_AUTHZ_ENTRA_USER_ROLE_NAME  <empty> (default → suffix-strip)         # optional: same, for `user`
  PORTAL_AUTHZ_ADMIN_GROUPS          <leave empty>                                # roles are authoritative
  PORTAL_AUTHZ_USER_GROUPS           <leave empty>                                # roles are authoritative
  PORTAL_AUTH_ENTRA_ADMIN_GROUPS     <empty> (default)                            # only if mixing in Entra group object ids
  PORTAL_AUTH_ENTRA_USER_GROUPS      <empty> (default)

  # App-role assignments (Roles posture only — not stored in .env, applied via Set-PortalAuthAssignments.ps1)
  ADMIN_ASSIGNMENTS                  <suggested: ${user}; CONFIRM OR OVERRIDE>   # UPNs / object ids / group display names, comma-separated
  USER_ASSIGNMENTS                   <empty>                                       # UPNs / object ids / group display names, comma-separated
```

**Why allowlist vs role fields are mutually exclusive in practice:**
the portal authz engine treats the role claim as authoritative when
present in the token (see `packages/portal/auth/authz/engine.js` and
`docs/portal-entra-app-roles.md`). With `-CreateAppRoles` set, every
admitted user has a role claim, so `PORTAL_AUTHZ_*_GROUPS` email
allowlists are dead config. Leaving them populated is harmless but
misleading — anyone reading the env later will wonder which one is
actually in effect. Set them only when posture is **Open** (no app
roles); leave them empty when posture is **Roles, no lockdown** or
**Roles + lockdown**.

**About `ADMIN_ASSIGNMENTS` / `USER_ASSIGNMENTS`:** these are *not*
stored in `.env`. They are the principal list to feed into
`Set-PortalAuthAssignments.ps1` after the app reg exists. The deployer
agent collects them at table-confirmation time and invokes the
[`pilotswarm-portal-auth-assignments`](../pilotswarm-portal-auth-assignments/SKILL.md)
skill right after the app-reg pre-step. Default the admin list to the
deploying user (UPN from `az account show`); the user can edit either
list — add a colleague, swap to a security group, etc. Without at
least one admin assignment, a `-AssignmentRequired` app is unreachable.

State the mode explicitly to the user once the table is on screen.
Two safe modes exist; pick deliberately:

- **Agent-driven default: non-interactive + post-scaffold edit.** When
  *you* (the agent) are driving, prefer this even for hands-on
  sessions. The user has already confirmed every value in the table
  above, so the prompts add nothing — and the readline-echo trap (see
  Step 3a) makes pacing errors invisible until you grep the rendered
  `.env`. Scaffold with the flag-backed values, then use `edit` to
  populate the remaining keys.
- **User-driven interactive walk.** Only when the user explicitly
  asks to type values themselves (e.g. they want to paste secrets
  directly without sharing them with the agent). The agent's role
  there is to launch the process and stay out of stdin.

## Step 3 — Invoke

Always invoke via `node` directly when passing any flag — npm strips
`--location` (its own config flag) and `--prefix`:

```bash
node deploy/scripts/new-env.mjs <name>            # interactive
node deploy/scripts/new-env.mjs <name> \          # non-interactive
  --subscription <id> --location <loc> \
  --edge-mode <mode> --tls-source <src> [--acme-email <addr>]
```

The bare `npm run deploy:new-env` (no flags) form is fine for an
interactive walk. As soon as you need to pass any flag, drop to `node`
directly.

For `tls-source=letsencrypt`, `--acme-email` is mandatory in
non-interactive mode — without it the rendered `.env` has an empty
`ACME_EMAIL` and `deploy.mjs` will refuse the env at the overlay-contract
gate. Pre-fill from the discovered UPN unless the user overrides.

Validate the EDGE_MODE × TLS_SOURCE combination against the supported matrix before running anything (see Step 4 below). The combos `afd+akv-selfsigned` and `private+letsencrypt` are rejected by `deploy.mjs` itself — call them out before the user hits a `UNSUPPORTED_COMBOS` error.

Only proceed after explicit confirmation. The resource prefix written by the scaffolder is `ps<name>` (e.g. `psmysandbox-wus3-rg`, `psmysandboxglobal`).

If your first invocation form fails (e.g. you tried the `npm run deploy:new-env -- … --location …` form and npm stripped the flag), **re-confirm the mode with the user** before retrying with a different form. Do not silently switch from interactive to non-interactive — the prompt surface differs materially.

### Step 3a — Driving the prompts safely (agent-execution rules)

The interactive walk uses Node's `readline`, which **echoes typed input
on the same line as the current prompt**. When you drive it via
`write_powershell`, the transcript looks like
`PROMPT> <your-text-here>` even though `<your-text-here>` is the answer
to the *next* prompt that printed below. This makes input-pacing errors
catastrophically easy to misread — you cannot reliably tell from the
transcript alone which input was consumed by which prompt.

Two rules to avoid the trap:

1. **Prefer the hybrid path over a live interactive walk.** When the
   defaults table is fully confirmed up front, scaffold
   non-interactively (`name + --subscription + --location` + the
   edge/tls/acme flags) and then use `edit` to set the remaining
   `.env` keys (`GITHUB_TOKEN`, `AZURE_*_KEY`, `PORTAL_AUTH_*`,
   `PORTAL_AUTHZ_*`) directly. This skips the entire prompt sequence,
   removes the readline-echo ambiguity, and is materially safer than
   an LLM driving a stdin stream.

2. **If you must drive interactively**, send **one answer per
   `write_powershell` call**, then `read_powershell` and confirm the
   *next* prompt has actually printed before sending the next answer.
   Never batch multiple `{enter}`-separated values in one call —
   readline coalesces them, but you lose the ability to verify which
   answer was consumed by which prompt. When in doubt, stop and grep
   the rendered `.env` before continuing.

### Step 3b — Verify the rendered .env before deploy

Regardless of mode, after `new-env` completes always grep the rendered
file and read the values back to the user:

```bash
grep -E '^(SUBSCRIPTION_ID|LOCATION|EDGE_MODE|TLS_SOURCE|ACME_EMAIL|PORTAL_AUTH_PROVIDER|PORTAL_AUTH_ENTRA_TENANT_ID|PORTAL_AUTH_ENTRA_CLIENT_ID|PORTAL_AUTHZ_ENTRA_ADMIN_ROLE_NAME|PORTAL_AUTHZ_ENTRA_USER_ROLE_NAME|PORTAL_AUTHZ_DEFAULT_ROLE|PORTAL_AUTHZ_ADMIN_GROUPS|PORTAL_AUTHZ_USER_GROUPS)=' deploy/envs/local/<stamp>/.env
```

If any value looks wrong (especially `PORTAL_AUTHZ_DEFAULT_ROLE` not in
`{user, admin}`, or `ACME_EMAIL` empty when `TLS_SOURCE=letsencrypt`,
or `__PS_UNSET__` sentinels you didn't intend to leave), fix it with
`edit` before invoking `deploy.mjs`. This check is mandatory after any
interactive run because of the readline-echo trap; it's cheap insurance
after non-interactive runs too.

## Step 4 — Edge mode × TLS source selection

| `EDGE_MODE` | `TLS_SOURCE` | Supported? | When |
|---|---|---|---|
| `afd` | `letsencrypt` | ✅ default | OSS-friendly public endpoint, ACME HTTP-01. |
| `afd` | `akv` | ✅ | Enterprise-internal OneCertV2-PublicCA cert via AKV. |
| `afd` | `akv-selfsigned` | ❌ | AppGw can't consume an AKV `Self` chain end-to-end. |
| `private` | `akv` | ✅ | Enterprise-internal OneCertV2-PrivateCA via AKV. |
| `private` | `akv-selfsigned` | ✅ | OSS-friendly private demo; AKV `Self`-issued cert. |
| `private` | `letsencrypt` | ❌ | ACME HTTP-01 cannot reach a private/ILB endpoint. |

The orchestrator validates the combo against `UNSUPPORTED_COMBOS` in
`deploy.mjs` before any Bicep runs.

## Step 5 — Deploy

End-to-end bring-up:

```bash
npm run deploy -- all <name>
```

The `all` aggregate runs the canonical sequence filtered by EDGE_MODE ×
TLS_SOURCE:

```
global-infra → base-infra → pls-anchor → cert-manager → cert-manager-issuers → worker-t3 → worker → portal
```

- `global-infra` and `pls-anchor` skip when `EDGE_MODE != afd`.
- `cert-manager` and `cert-manager-issuers` skip when `TLS_SOURCE != letsencrypt`.

Bicep outputs (ACR login server, storage account name, KV name, etc.)
cascade forward across services via the alias map; you don't hand-thread
anything between services.

### Per-service redeploys

| Use case | Command |
|---|---|
| Push portal code change | `npm run deploy -- portal <name> --steps build,push,manifests,rollout` |
| Worker env-only change | `npm run deploy -- worker <name> --steps manifests,rollout` |
| Re-apply BaseInfra Bicep only | `npm run deploy -- base-infra <name> --steps bicep` |
| Just T3 cluster | `npm run deploy -- worker-t3 <name>` |
| Force AppGw cert refresh after AKV cert rotation | `npm run deploy -- portal <name> --force-module portal --steps bicep` |
| Validate without deploying | `npm run deploy -- <svc> <name> --steps noop` |

`--steps` accepts any subset in any order; it re-sorts to canonical
pipeline order (`build → bicep → seed-secrets → push → manifests →
rollout`). Outside `all` mode, single-service runs also redeploy that
service's Bicep dependencies — the deploy-marker (template+params hash)
short-circuits unchanged modules so this is cheap.

### Force semantics

- `--force`: bypass deploy-markers for **every** Bicep module in scope. Use sparingly.
- `--force-module <name>`: bypass the deploy-marker for one module only (repeatable). The preferred lever — minimum-blast-radius. Empty values are rejected at parse time.

## Step 6 — Verify

After a successful `all`:

```bash
# Bicep outputs cached per env — sanity-check the names.
jq -r 'to_entries | .[] | "\(.key)=\(.value.value)"' \
  deploy/.tmp/<name>/bicep-outputs.cache.json | sort

# T2 control cluster — workers and portal should be Running.
kubectl --context ps<name>-aks get pods -n pilotswarm

# T3 worker cluster — repo-cache StatefulSet should be Ready.
kubectl --context ps<name>-aks-t3 get statefulset,pvc,pod,svc -n pilotswarm-jobs

# Portal health (substitute the AFD endpoint or private FQDN).
curl -s https://<portal-fqdn>/api/health
# → {"ok":true,...}
```

(Adjust namespace names if your deploy manifests use different defaults
— check `deploy/services/portal/deploy.json` and
`deploy/services/worker/deploy.json` for the rendered namespace.)

If Flux returns 403 on the first `rollout`, the cross-cluster RBAC grant
on T3 (or Flux's Storage Blob Data Reader on T2) hasn't propagated. Retry
`--steps rollout` after ~30s. If persistent, see the Flux troubleshooting
section in `deploy/scripts/README.md`.

## Step 7 — Teardown

`deploy.mjs` is deploy-only. Tear down via Azure CLI:

```bash
az group delete --name ps<name>-<region>-rg --yes --no-wait
az group delete --name ps<name>global --yes --no-wait   # afd mode only
```

The protected-resource guardrail does **not** block operator-driven
deletion of envs you created; it only blocks `deploy.mjs` from
*targeting* live resources.

If the Entra app reg was created by `pilotswarm-portal-app-reg`,
delete it too:

```bash
az ad app delete --id $(jq -r .clientId deploy/envs/local/<name>/entra-app.json)
```

## Guardrails

- **Never run `deploy.mjs` against a live cluster.** It is a separate path. If the user wants to push to live, use `scripts/deploy-aks.sh --skip-reset` / `scripts/deploy-portal.sh` and the `pilotswarm-aks-deploy` skill.
- **Protected-names check is non-negotiable.** If the scaffolder rejects a name, do not work around it. The check fires on both raw inputs and derived names.
- **Tenant/subscription pin is non-negotiable.** `az account show` must match the env file's `AZURE_TENANT_ID` and `SUBSCRIPTION_ID` before any mutation.
- **Bicep deploy-markers are cached at `deploy/.tmp/<name>/`** — wiping `.tmp/<name>/` forces full redeploys on the next run (occasionally useful for re-running a broken intermediate step, but slow).
- **Don't propagate changes into downstream consumers.** PilotSwarm changes operate on PilotSwarm only — don't roll them into downstream app repos that vendor or consume the SDK unless the user explicitly asks.

## Common Pitfalls

- **`--force-module=`** with empty value: rejected at parse time (good — it would otherwise silently push an empty string and force nothing).
- **AppGw SSL-cert not refreshing after AKV rotation**: deploy-marker skipped the portal module. Use `npm run deploy -- portal <env> --force-module portal --steps bicep`.
- **AFD Private Endpoint approval times out**: `approve-private-endpoint.bicep` polls for up to 10 minutes. If it still times out, check `az network private-endpoint-connection list` on the PLS for stuck Pending entries.
- **DNS prop delays on AFD**: AFD endpoint propagation can take 5–15 minutes after `global-infra`. Don't assume the curl works immediately after `all` returns; retry over ~15 minutes. During that window, `curl https://<afd-host>/api/health` will return HTTP 404 with an `x-azure-ref` header — this is normal, not a failure.
- **Portal sign-in loop after deploy**: redirect URI on the Entra app reg doesn't match the deployed AFD endpoint. Run `az ad app show --id <clientId> --query "spa.redirectUris"` and compare. If the app was created before the AFD endpoint was known, re-run `pilotswarm-portal-app-reg` in `-ExistingAppId` append mode.

## Boundary with sibling skills

| Question | Skill |
|---|---|
| "Set up a new sandbox env" | **this skill** (`deploy.mjs`) |
| "Roll out a fix to the existing legacy cluster" | `pilotswarm-aks-deploy` (`deploy-aks.sh`) |
| "Reset / wipe DB on the existing cluster" | `pilotswarm-aks-reset` |
| "Force AppGw cert refresh in my sandbox" | **this skill** (`--force-module portal`) |
| "Provision Entra app reg for a portal stamp" | `pilotswarm-portal-app-reg` |
| "Add a new module to the deploy" | both — the orchestrator (`deploy.mjs` services-manifest) is shaped by this skill; legacy k8s manifests live in `pilotswarm-aks-deploy` territory |
