# `envFrom: secretRef` makes pods miss CSI Secret Store rotations

## Summary

The worker and portal Deployments project Key Vault–backed secrets via the
Secrets Store CSI driver's `secretObjects` synthesis, then consume them with
`envFrom: secretRef`:

- `deploy/gitops/worker/base/secret-provider-class.yaml` →
  `copilot-worker-secrets` Secret with `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`,
  `AZURE_OAI_KEY` keys.
- `deploy/gitops/worker/base/deployment.yaml` →
  `envFrom: - secretRef: name: copilot-worker-secrets`.
- `deploy/gitops/portal/base/secret-provider-class.yaml` → analogous pattern
  for `PORTAL_AUTH_*` / `PORTAL_AUTHZ_*`.

This combination has two failure modes:

### Mode 1 — value rotation without redeploy

When a value changes in Key Vault (e.g. `GITHUB_TOKEN` rotation, or a
`PORTAL_AUTHZ_ADMIN_GROUPS` allowlist edit applied via `seed-secrets` only),
the CSI driver eventually propagates the new value into the synthesized
K8s Secret on its rotation interval (default ~2 min on AKS). However,
`envFrom: secretRef` is evaluated **only at container start**: Kubernetes does
not re-inject env vars into a running process when the Secret changes. Pods
keep serving with stale credentials/policy until something else triggers a
rolling update.

### Mode 2 — SPC key set growing during a deploy that also rolls pods

When the SPC's `secretObjects[].data` set **grows** (e.g. first time a stamp
turns on Foundry → adds `AZURE_OAI_KEY`; first deploy that wires portal authz
→ adds the `PORTAL_AUTH_*` family), and the same deploy also bumps the
container image tag:

1. Bicep + `seed-secrets` populate Key Vault correctly (these run before
   manifest staging, per `deploy/scripts/lib/stages.mjs::PIPELINE`).
2. Flux applies the new SPC + Deployment in one reconcile.
3. The new pod is scheduled. The kubelet calls the CSI driver to mount the
   volume.
4. The CSI driver synchronously writes the secret files under
   `/mnt/secrets-store/`, then **asynchronously** updates the K8s Secret
   `copilot-worker-secrets` (or `pilotswarm-portal-secrets`) per its
   `secretObjects` block.
5. The container starts. `envFrom: secretRef` reads the K8s Secret
   **at container start time**.

Step 5 races step 4b. The new pod can win and start with the *previous*
Secret content (which lacks the newly-added keys). Subsequent deploys on the
same stamp do not hit this — the key set is now stable, only image tags
change, and the K8s Secret is already correct from the first rollout's
eventual sync. This means the bug is silent in steady state and surfaces
only on first-of-its-kind deploys.

## Observed instances

Both observed on stamp `chkrawps2` (westus3) on 2026-05-04 during the Phase 1
Foundry rollout:

- **Worker**: After the deploy that introduced `AZURE_OAI_KEY` to the SPC,
  pods came up with `AZURE_OAI_KEY=` (empty). The K8s Secret content was
  correct (84-char Foundry key written by `foundry.bicep` listKeys), so the
  `envFrom` snapshot at pod start had simply missed it. A
  `kubectl rollout restart deploy/copilot-runtime-worker` resolved it: new
  pods read the now-stable Secret correctly and the Foundry providers
  loaded.
- **Portal**: Same deploy added `daraffan@microsoft.com` to
  `PORTAL_AUTHZ_ADMIN_GROUPS`. The K8s Secret showed both admins; the
  running pod's env showed only `chkraw@microsoft.com`. A
  `kubectl rollout restart deploy/pilotswarm-portal` picked up the new
  admin allowlist.

## Why "wait for CSI to finish" is not a clean fix

The CSI driver's K8s Secret synthesis is **driven by pod-volume mounts**, not
by SPC application. Applying an SPC alone is a no-op — it is just a CR. The
driver acts when:

1. A pod referencing the SPC mounts the volume (writes files **and**
   reconciles the synthesized K8s Secret), or
2. The driver's periodic rotation reconciler runs against an already-mounted
   pod (default ~2 min on AKS).

So a "wait for CSI" gate has chicken-and-egg semantics: the only way to make
the driver create the new K8s Secret is to start a pod, but the pod is
exactly what we want to delay until the Secret is ready. Workarounds are
possible (warmer pod / Job, two-phase apply, an `initContainer` that polls
the synthesized Secret), but each of them addresses Mode 2 only and leaves
Mode 1 (value-only rotations) fully exposed.

## Proposed fix: `SecretStore` abstraction with file-projected secrets

Stop reading secrets from `process.env`. Read them from files written by the
CSI driver under `/mnt/secrets-store/`. The CSI driver auto-rotates these
files within seconds of a Key Vault change, so a watcher-based
`SecretStore` makes both failure modes go away — no pod restart needed for
value rotation, and no race for first-time key additions because the file
write is synchronous with mount-return.

### Sketch

A new module `packages/sdk/src/secret-store.ts`:

```ts
interface SecretStore {
  get(name: string): string | undefined;
  watch(name: string, cb: (value: string | undefined) => void): () => void;
  list(): string[];
}
```

Two implementations selected at startup:

- `EnvSecretStore` — wraps `process.env`. `watch()` is a no-op. Default for
  local dev, tests, and the legacy `scripts/deploy-aks.sh` path.
- `FileSecretStore` — reads from a directory (one file per secret, file name
  = secret name, file contents = value). Uses `fs.watch()` with a short
  debounce to fire watcher callbacks on rotation. Strips the
  `__PS_UNSET__` sentinel transparently.

Selection: if `PS_SECRET_DIR` is set, use `FileSecretStore` rooted at that
directory; otherwise `EnvSecretStore`. Same image works in all three deploy
paths — only the bicep-deploy manifest sets `PS_SECRET_DIR=/mnt/secrets-store`.

### Worker integration

- `packages/sdk/examples/worker.js` — replace `process.env.GITHUB_TOKEN` with
  `secretStore.get("GITHUB_TOKEN")` and pass the store into
  `PilotSwarmWorker`.
- `packages/sdk/src/model-providers.ts` — change `resolveEnvValue("env:FOO")`
  to call `secretStore.get("FOO")`. The provider registry already resolves
  secrets at every `resolve()` call, so dynamic reload comes "for free" for
  every model invocation.
- Drop the startup sentinel-strip loop in `worker.js` (handled inside the
  store).

### Portal integration

- `packages/portal/auth/config.js` — `buildAuthConfig` becomes a function of
  the `SecretStore`. Subscribe to the relevant keys; when any fires,
  re-derive the auth config and atomically swap the active policy. The
  authz engine takes `policy` per call, so the swap is safe.
- `packages/portal/auth/providers/entra.js` — read tenant/client at handler
  time, not at provider-construction time. Provider-type changes
  (e.g. `entra` → `oidc`) realistically still require a restart; only
  parameter changes within the active provider need to be live.

### Manifest changes

- Worker / portal Deployments: drop `envFrom: secretRef`. Keep the existing
  CSI volume mount at `/mnt/secrets-store/` (already present on the worker;
  add for the portal). Keep the `configMapRef` for non-secret config.
- Worker SPC: keep the file projection in `parameters.objects`. The
  `secretObjects` block can stay (useful for monitoring / fallback) but is
  no longer the source of truth.
- worker-env / portal-env ConfigMap: add `PS_SECRET_DIR=/mnt/secrets-store`.

### What dynamic reload buys us

| Change                                         | envFrom (today)                | FileSecretStore                          |
|------------------------------------------------|--------------------------------|------------------------------------------|
| Rotate `GITHUB_TOKEN` in KV                    | Stale until next rolling update | Picked up on next model `resolve()` call |
| Rotate `AZURE_OAI_KEY` in KV                   | Same                           | Same                                     |
| Add admin to `PORTAL_AUTHZ_ADMIN_GROUPS`       | Stale until restart            | Picked up after debounce (~100ms)        |
| First-time Foundry add (Mode 2)                | Race; needs hash workaround    | No race — file written by mount          |

### Out of scope for the eventual fix

- ConfigMap-backed configuration (e.g. `model_providers.json`). That's not
  a Secret and lives outside this work item — it has its own pod-template
  staleness story.
- Provider-type swaps (`entra` ↔ `oidc`). Worth a restart.
- Replacing the CSI driver's rotation interval — orthogonal.

## Interim mitigation already in place / proposed

Until the `SecretStore` work lands, the `deploy.mjs` rollout step can add a
SHA-256 hash annotation on the worker / portal Deployment's pod template,
keyed on the SPC's `secretObjects[].data[].key` list. Any change to the
projected key set forces a fresh rollout, which closes Mode 2. It does not
fix Mode 1, but Mode 1 is rare in this repo today (every secret change in
practice goes through a full deploy).

## References

- [secrets-store-csi-driver / sync-as-kubernetes-secret](https://secrets-store-csi-driver.sigs.k8s.io/topics/sync-as-kubernetes-secret.html)
- [secrets-store-csi-driver issue #298 — async Secret synthesis race](https://github.com/kubernetes-sigs/secrets-store-csi-driver/issues/298)
- `deploy/gitops/worker/base/deployment.yaml` (envFrom binding)
- `deploy/gitops/worker/base/secret-provider-class.yaml`
- `deploy/gitops/portal/base/secret-provider-class.yaml`
- `packages/sdk/examples/worker.js` (current `process.env` reads)
- `packages/sdk/src/model-providers.ts` (`resolveEnvValue` — late-bound,
  ready for swap)
- `packages/portal/auth/config.js` (current startup-time read)
