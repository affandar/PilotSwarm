# OBO Smoke Checklist (Release Gate)

This is the **manual** smoke checklist that gates `pilotswarm-sdk`
publication for any release that touches the User OBO Propagation
feature surface (Spec FR-018). It is **not** automated CI — it is
executed by a maintainer against a real Entra tenant before npm
publish, and the maintainer signs off in the release PR description.

There are two variants:

- **Live-tenant smoke** — full path through portal MSAL → encrypted
  envelope → worker decrypt → real OBO exchange → Microsoft Graph
  `/me`. Required for any release whose changelog includes OBO
  surface changes.
- **Local-developer smoke** — same path but with a confidential
  client + dev secret in place of AKS workload-identity FIC. Required
  for at least one maintainer machine before publish.

Tokens MUST NEVER be pasted into the checklist log. Capture only
`upn`, `objectId`, and `hasAccessToken: true|false` indicators.

---

## Pre-flight

- [ ] You are on a release-candidate branch with the OBO
  changes merged.
- [ ] `cd packages/sdk && npx vitest run test/local/*tool-outcomes*.test.js test/local/*envelope-crypto*.test.js test/local/*user-context*.test.js test/local/obo-runtime-envelope-encrypt.test.js test/local/obo-server-auth-body.test.js test/local/structured-outcomes-*.test.js` passes locally.
- [ ] `cd packages/sdk && npx vitest run test/local/obo-smoke-plugin-loadable.test.js` passes locally.
- [ ] `npm run build` is clean across the workspace.

## Live-tenant smoke

You will need:

- A **PilotSwarm smoke tenant** OR a contributor's M365 dev tenant
  (an entitled `@*.onmicrosoft.com` tenant where you can register
  apps and add yourself as a test user).
- Permission to register one new AAD app in that tenant.

### Step 1 — One-time AAD app registration

- [ ] Register a new AAD app in the smoke tenant. Note the
  **Application (client) ID** and **Directory (tenant) ID**.
- [ ] Under **API permissions**, add `Microsoft Graph` →
  `User.Read` (delegated). Grant admin consent.
- [ ] Under **Expose an API**, add a custom scope
  (e.g. `access_as_user`). Note the resulting
  `api://<client-id>/access_as_user` identifier-URI scope. The
  scope you'll wire into the **portal** below is
  `api://<client-id>/.default` (the `/.default` form requests every
  scope the app has consent for, which is what the portal MSAL flow
  expects).
- [ ] Generate a client secret. Note the **secret value** (you'll
  paste this into a maintainer-only env file, never into git or
  this checklist).

### Step 2 — Configure portal

In the portal stamp's `.env` (or equivalent secret store), set:

- [ ] `PORTAL_AUTH_ENTRA_TENANT_ID=<tenant-id>` (existing var)
- [ ] `PORTAL_AUTH_ENTRA_CLIENT_ID=<existing portal client id>`
- [ ] `PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE=api://<smoke-app-client-id>/.default`

> Note: the portal MSAL acquisition code adds `offline_access` itself.
> Do NOT include `offline_access` in `PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE`.

### Step 3 — Configure worker (smoke plugin)

In the worker's `.env` (or equivalent secret store, never the shared
`.env.example`), set:

- [ ] `OBO_SMOKE_WORKER_APP_TENANT_ID=<tenant-id>`
- [ ] `OBO_SMOKE_WORKER_APP_CLIENT_ID=<smoke-app-client-id>`
- [ ] `OBO_SMOKE_WORKER_APP_CLIENT_SECRET=<smoke-app-secret>`
- [ ] `OBO_SMOKE_WORKER_APP_GRAPH_SCOPE=https://graph.microsoft.com/User.Read`

Register the smoke tools on the worker:

```js
import { registerOboSmokeTools } from "../../examples/obo-smoke/index.js";
registerOboSmokeTools(worker);
```

- [ ] Restart the worker. Confirm `obo_smoke_whoami` and
  `obo_smoke_force_reauth` appear in the registered tool list.

### Step 4 — Run `obo_smoke_whoami`

- [ ] In the portal, sign out and sign back in. Confirm the consent
  prompt asks for the new downstream scope.
- [ ] Open or create a session bound to your portal user.
- [ ] Prompt the agent: "Run obo_smoke_whoami."
- [ ] Confirm the tool result has `mode: "obo_ok"`.
- [ ] Confirm `principal.email` matches your sign-in UPN.
- [ ] Confirm `graph.upn` matches your sign-in UPN.
- [ ] Confirm `graph.objectId` is a non-empty GUID.
- [ ] Inspect the CMS event row for `tool.execution_complete`:
  - [ ] `data.outcome === "success"` (not `interaction_required`).
  - [ ] `data` contains **no** access token strings.
  - [ ] `data` contains **no** envelope-cipher fields (`accessTokenCipher`,
        `wrappedDek`, `kekKid`, `iv`, `tag`).

### Step 5 — Run `obo_smoke_force_reauth` (round 1)

- [ ] In the same session, prompt the agent: "Run obo_smoke_force_reauth."
- [ ] Confirm the portal renders a re-auth affordance (banner /
      activity row labeled `[reauth required]`).
- [ ] Inspect the CMS event row for `tool.execution_complete`:
  - [ ] `data.outcome === "interaction_required"`.
  - [ ] `data.outcome_payload.reasonCode === "reauth_required"`.
  - [ ] No token strings in any payload field.

### Step 6 — Re-authenticate

- [ ] Click the re-auth affordance. Complete the interactive MSAL
      prompt. Confirm sign-in returns you to the same session.

### Step 7 — Run `obo_smoke_whoami` again

- [ ] Prompt the agent again: "Run obo_smoke_whoami."
- [ ] Confirm the tool result still has `mode: "obo_ok"` and the
      same `graph.upn` / `graph.objectId` as Step 4.
- [ ] Confirm via trace logs that the second call's downstream
      token expiry is **later** than the first call's, proving the
      portal acquired a fresh token after re-auth.

### Step 8 — Token leak scan

- [ ] Capture all worker stdout/stderr from this smoke run.
- [ ] `grep -E '"access_token"|eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}' <captured.log>` returns no matches.
- [ ] Inspect any persisted blobs / CMS rows touched by this
      session: no access-token-shaped strings present.

### Step 9 — Sign-off

- [ ] Live-tenant smoke completed by **<maintainer name>** on
      **<date>** against tenant **<tenant-id>**, app
      **<client-id>**.
- [ ] Capture the steps above (or a link to this completed checklist)
      in the release PR description.

---

## Local-developer smoke variant

Same checklist as above, but expected to run on a maintainer's local
machine without AKS:

- The worker uses the confidential-client + dev-secret path
  (`OBO_SMOKE_WORKER_APP_CLIENT_SECRET` is set). On a local machine
  `AZURE_FEDERATED_TOKEN_FILE` is unset, so the plugin's
  auto-selection picks the client-secret backend (FR-025).
- The portal runs locally (`run.sh portal` or equivalent) and is
  reached via `http://localhost:<port>`.
- Run all of Step 4 through Step 8 above.

- [ ] Local-developer smoke completed by **<maintainer name>** on
      **<date>** on **<machine description>**.

---

## AKS-deployed smoke variant

For full-fidelity verification on a deployed stamp without paying
the local-portal setup cost, use the
[`pilotswarm smoke`](../../docs/operations/live-smoke.md) harness:

- [ ] Deploy a stamp with `OBO_ENABLED=true` and
      `OBO_SMOKE_ENABLED=true`. The worker registers `obo_smoke_*`
      tools at startup; non-smoke stamps are unaffected (the toggle
      is worker-only and defaults to `false`).
- [ ] Auto-provision the per-stamp OBO smoke worker AAD app **+ AKS
      FIC** by invoking the
      [`pilotswarm-obo-smoke-app-reg`](../../.github/skills/pilotswarm-obo-smoke-app-reg/SKILL.md)
      skill, or running its wrapper directly:
      `pwsh -NoProfile -ExecutionPolicy Bypass -File deploy/scripts/auth/Setup-OboSmokeWorkerApp.ps1 -ServiceTreeId <id> -EnvName <stamp>`.
      The wrapper creates/finds the worker app, mints the OAuth2
      scope, declares Microsoft Graph `User.Read` delegated
      permission, pre-authorizes the portal app (read from
      `deploy/envs/local/<stamp>/entra-app.json`), and create-or-
      patches the AKS workload-identity FIC on the Entra application
      itself — no separate manual FIC step. Idempotent; re-runs are
      no-ops.
- [ ] Paste the four `.env` lines the wrapper prints into
      `deploy/envs/local/<stamp>/.env`:
      `PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE`,
      `OBO_SMOKE_WORKER_APP_TENANT_ID`,
      `OBO_SMOKE_WORKER_APP_CLIENT_ID`,
      `OBO_SMOKE_WORKER_APP_GRAPH_SCOPE`. The wrapper writes a
      sidecar JSON at `deploy/envs/local/<stamp>/obo-smoke-worker-app.json`
      but never edits `.env` itself (preserves the single-actor-on-
      `.env` invariant). No client secret is needed on AKS — the FIC
      backend wins automatically.
- [ ] Verify with the tightened grep gate (zero matches required):
      `grep -E '^(PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE|OBO_SMOKE_WORKER_APP_(TENANT_ID|CLIENT_ID|GRAPH_SCOPE))=(__PS_UNSET__)?$' deploy/envs/local/<stamp>/.env`.
- [ ] Re-project the worker ConfigMap:
      `node deploy/scripts/deploy.mjs worker <stamp> --steps manifests,rollout`.
- [ ] Run `npx pilotswarm smoke <stamp> --profile obo`. The driver
      acquires user tokens via device-code, drives the deployed
      portal's `/api/rpc`, exercises both tools, and emits a JSON
      pass record.
- [ ] On pass: capture the JSON in the release PR description.
- [ ] On fail: investigate `failedStep` + `reasonCode` per the
      operations doc.

---

## After the smoke

- [ ] Delete the smoke client secret from any maintainer machine
      `.env` files. (`OBO_SMOKE_WORKER_APP_CLIENT_SECRET` is the only
      sensitive value.)
- [ ] If you used a one-shot client secret on the smoke AAD app,
      delete it from the AAD app credentials. The smoke app itself
      can be left registered for future smokes.
- [ ] Confirm `.env.example` and `.model_providers.example.json` were
      not modified during the smoke (placeholder-only).
