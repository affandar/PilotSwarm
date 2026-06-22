# OBO Smoke Checklist (Release Gate)

Manual sign-off form a maintainer completes against a real Entra
tenant before publishing any `pilotswarm-sdk` release that touches the
User OBO Propagation surface. It is **not** automated
CI; it is run by a maintainer and captured in the release PR
description.

Operational detail (what the harness does, how the plugin selects
backends, what to do when it fails) lives in
[`docs/operations/live-smoke.md`](../../docs/operations/live-smoke.md).
This checklist is just the gate.

**Token hygiene**: never paste tokens into this log. Capture only
`upn`, `objectId`, and `hasAccessToken: true|false` indicators.

---

## Pre-flight

- [ ] On a release-candidate branch with OBO changes merged.
- [ ] `npm run build` clean across the workspace.
- [ ] OBO unit suites pass locally:
      `cd packages/sdk && npx vitest run test/local/*tool-outcomes*.test.js test/local/*envelope-crypto*.test.js test/local/*user-context*.test.js test/local/obo-runtime-envelope-encrypt.test.js test/local/obo-server-auth-body.test.js test/local/structured-outcomes-*.test.js test/local/obo-smoke-plugin-loadable.test.js`.

---

## AKS-deployed smoke (canonical release-gate path)

Assumes a dedicated smoke stamp with `OBO_ENABLED=true`, the worker image
built with `--variant smoke`, the smoke env overlay composed into the
stamp `.env`, and `PLUGIN_DIRS` including `/app/packages/obo-smoke-plugin`.
`OBO_SMOKE_ENABLED=true` is the smoke-driver marker; worker tool registration
is governed by `PLUGIN_DIRS` and the smoke image variant.

- [ ] Auto-provision the per-stamp OBO smoke worker AAD app + AKS
      workload-identity FIC (idempotent — re-runs are no-ops):
      `pwsh -NoProfile -ExecutionPolicy Bypass -File deploy/scripts/auth/Setup-OboSmokeWorkerApp.ps1 -ServiceTreeId <id> -EnvName <stamp>`.
      See
      [`pilotswarm-obo-smoke-app-reg` skill](../../.github/skills/pilotswarm-obo-smoke-app-reg/SKILL.md)
      for the agent-driven path.
- [ ] Paste the smoke `.env` lines the wrapper prints into
      `deploy/envs/local/<stamp>/.env`:
      `PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE`,
      `OBO_SMOKE_WORKER_APP_TENANT_ID`,
      `OBO_SMOKE_WORKER_APP_CLIENT_ID`,
      `OBO_SMOKE_WORKER_APP_GRAPH_SCOPE`, and `PLUGIN_DIRS=/app/packages/obo-smoke-plugin`. (The wrapper never edits
      `.env` itself — single-actor invariant.)
- [ ] Verify no sentinel/empty values remain on those keys:
      `grep -E '^(PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE|OBO_SMOKE_WORKER_APP_(TENANT_ID|CLIENT_ID|GRAPH_SCOPE)|PLUGIN_DIRS)=(__PS_UNSET__)?$' deploy/envs/local/<stamp>/.env`
      returns **zero** matches.
- [ ] Build/push the smoke worker image (`--variant smoke`) if it is not already deployed, then re-project the worker ConfigMap:
      `node deploy/scripts/deploy.mjs worker <stamp> --steps manifests,rollout`.
- [ ] Run the harness:
      `npx pilotswarm smoke <stamp> --profile obo`.
      The driver acquires user tokens, drives the deployed portal's
      `/api/rpc`, exercises both tools, and emits a structured JSON
      pass/fail record.
- [ ] On pass: capture the JSON pass record in the release PR
      description.
- [ ] On fail: investigate `failedStep` + `reasonCode` per
      [`docs/operations/live-smoke.md`](../../docs/operations/live-smoke.md).

---

## Local-developer smoke variant

Use when you cannot deploy a stamp. Same end-to-end path but the
worker runs locally with a confidential-client backend instead of AKS
workload-identity FIC (the plugin's auto-selection picks the
client-secret path when `WORKLOAD_IDENTITY_CLIENT_ID` is unset and
`OBO_SMOKE_WORKER_APP_CLIENT_SECRET` is set — see the README's backend
table).

- [ ] Local-developer smoke completed by **&lt;maintainer&gt;** on
      **&lt;date&gt;** on **&lt;machine description&gt;**.

---

## Sign-off

- [ ] AKS-deployed smoke completed by **&lt;maintainer&gt;** on
      **&lt;date&gt;** against stamp **&lt;stamp-name&gt;**, tenant
      **&lt;tenant-id&gt;**, worker app **&lt;client-id&gt;**.
- [ ] JSON pass record (or link to the run) included in the release
      PR description.

## After the smoke

- [ ] If you used a temporary client secret on the smoke AAD app for
      a local-developer run, delete it from the app credentials and
      from any local `.env` file. (`OBO_SMOKE_WORKER_APP_CLIENT_SECRET`
      is the only sensitive value; the AKS path uses FIC and needs
      no secret at all.)
- [ ] Confirm `.env.example` and `.model_providers.example.json` were
      not modified (placeholder-only).
