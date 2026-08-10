# Proposal: Windows Worker Packaging (one build → zip bundle + container image)

**Status:** Draft (sketch)
**Date:** 2026-08-10
**Author:** kchung (filed cross-repo; companion to the SQL-AI-Marketplace design note `PILOTSWARM_ADO_WORKER_DESIGN.md`)

## Problem

The PilotSwarm worker ships today as a **Linux** container image only. Its dependency graph is
resolved **once at Docker image-build time** and frozen into a layer — pods never run `npm install`
dynamically:

- [`deploy/Dockerfile.worker`](../../deploy/Dockerfile.worker) is `FROM node:24-trixie-slim` (Debian 13,
  glibc 2.41 — required because the `duroxide-linux-x64-gnu` prebuild links `GLIBC_2.39`). It runs
  `npm ci --omit=dev --force` to bake `node_modules` (including the native duroxide addon), then
  `COPY`s `dist/`, `worker.js`, `plugins/`, and the horizon-store `dist/` + `migrations/`.
- [`deploy/k8s/worker-deployment.yaml`](../../deploy/k8s/worker-deployment.yaml) pulls that image
  (`imagePullPolicy: Always`) and starts `ENTRYPOINT ["node", "packages/sdk/examples/worker.js"]`.
  The only initContainer is a `busybox:1.36` `mkdir`/`chown` of the `.copilot` home — **no npm, no
  build at pod start**.

The GitHub Release assets are **not** a runnable worker: [`​.github/workflows/publish-npm.yml`](../../.github/workflows/publish-npm.yml)
runs on `ubuntu-latest` and attaches three `npm pack` tarballs (`pilotswarm-sdk-<v>.tgz`, etc.).
Those are portable JS only — **no `node_modules`, no native `.node` addon** — because `npm pack`
never bundles dependencies.

We now want to run the worker on **Windows** hosts:

1. **ADO pipelines / Windows VMs** — a 1ES AutoManagedVhd Windows pool where the target enlistment
   is baked into the agent VHD (see the marketplace design note). The worker runs as a **host process**
   with same-filesystem access to that enlistment.
2. **(Possible future) Windows AKS** — a Windows Server node pool that needs an **OCI image**.

There is no Windows build of the worker today, and no packaging path that serves either host.

## Key facts that make this cheap

- **The only runtime native addon is duroxide**, and it publishes a **`duroxide-windows-x64@0.1.27`
  prebuild** (verified in `package-lock.json`). Every other dependency
  (`@azure/identity`, `@azure/storage-blob`, `@github/copilot*`, `@opentelemetry/api`, `pg`,
  `file-type`) is pure JS / portable WASM. **No Rust toolchain or native compilation is required on
  Windows** — `npm ci` on a Windows agent resolves the prebuilt `.node` via npm's os/cpu gating.
- The linux GLIBC constraint that forces `trixie-slim` **does not apply on Windows**; the Windows
  concern is instead the **MSVC runtime** the prebuild links against (present in
  `windows/servercore`, absent from bare `nanoserver`).
- The **expensive, platform-sensitive step is `npm ci` + `tsc`** — the same step whether the final
  artifact is a zip or an image. Everything after it is packaging.

## Goals

1. Produce a **runnable Windows worker** whose dependencies (incl. `duroxide-windows-x64`) are
   pre-resolved — **no dynamic `npm install`** on the target host, matching the AKS/Docker model.
2. Emit **two shapes from one build**: a **zip bundle** (ADO host process) and a **Windows container
   image** (Windows AKS), sharing the entire expensive core and diverging only at the final
   packaging line.
3. Keep the **worker code identical** across Linux image / Windows image / Windows zip — one
   entrypoint, env-driven configuration.
4. Do not disturb the existing Linux release flow; the Windows work is **purely additive**.

## Non-goals

- Running a **Linux** container on a Windows ADO agent (ruled out — a 1ES hosted Windows VMSS agent
  can't reliably host a Linux container).
- Bind-mounting the VHD enlistment into a container on ADO (see "Container vs. host process" below —
  for ADO the host-process zip is preferred precisely to avoid this).
- Changing the duroxide runtime, the affinity/lease protocol, or the frozen `planHoldRelease` policy.

## Design: one build, two tails

The build runs on `windows-latest` (GitHub) or a Windows ADO agent. The **prepared worker tree** —
Windows-native `node_modules` + `dist/` + `worker.js` + plugins + horizon-store — is the single
output. It is then packaged two ways.

```yaml
runs-on: windows-latest
steps:
  # ---- SHARED CORE: the one expensive, platform-sensitive step ----
  - uses: actions/setup-node@v4
    with: { node-version: "24" }
  - run: |
      npm ci --omit=dev          # resolves duroxide-windows-x64 (prebuilt .node)
      npm run build              # tsc -> dist/
  - name: Stage the runnable tree   # mirrors Dockerfile.worker's COPY manifest
    shell: pwsh
    run: |
      New-Item -Type Directory stage | Out-Null
      Copy-Item -Recurse -Destination stage `
        node_modules,
        packages\sdk\dist,
        packages\sdk\plugins,
        packages\sdk\examples\worker.js,
        packages\sdk\api,
        packages\horizon-store\dist,
        packages\horizon-store\migrations

  # ---- TAIL 1: zip bundle (ADO host process) ----
  - run: Compress-Archive stage\* pilotswarm-worker-win-x64.zip
  # attach to GitHub Release / publish as ADO pipeline artifact

  # ---- TAIL 2: container image (Windows AKS) ----
  - run: docker build -f deploy/Dockerfile.worker.windows -t $REG/copilot-runtime-worker:win .
```

The Windows Dockerfile is trivial because it **reuses the already-staged tree** — there is no second
`npm ci`:

```dockerfile
# deploy/Dockerfile.worker.windows
FROM mcr.microsoft.com/windows/servercore:ltsc2022
# + install Node 24 (zip/msi); servercore carries the MSVC runtime duroxide-windows-x64 needs
WORKDIR C:\app
COPY stage/ .                      # the exact tree the zip contains
ENTRYPOINT ["node", "packages\\sdk\\examples\\worker.js"]
```

### What is shared vs. divergent

| Step | Shared? |
|---|---|
| `npm ci --omit=dev` (native addon resolution) | ✅ once |
| `npm run build` (tsc) | ✅ once |
| stage the file manifest | ✅ once |
| **the worker entrypoint / code** | ✅ identical |
| final packaging | ❌ `Compress-Archive` vs. `docker build` (one line each) |

## How each host consumes the output

| Host | Artifact | Launch |
|---|---|---|
| **Linux AKS** (today) | linux image (`Dockerfile.worker`) | pod pulls image → `node worker.js` |
| **ADO Windows VM** | **zip bundle** | download artifact → `Expand-Archive` → `node worker.js` (host process, native access to VHD enlistment) |
| **Windows AKS** (future) | **Windows image** (`Dockerfile.worker.windows`) | pod pulls image → `node worker.js` |

## Container vs. host process on ADO — why the zip wins there

The worker's value on ADO is **same-filesystem access to the VHD-hydrated target enlistment**. A
container turns that into a **bind-mount across the container boundary**, plus base-OS version
matching (ltsc2022 host↔container) and a container runtime on the agent — all to run a `node` process
the agent can already run directly. The ADO job itself is the isolation boundary (ephemeral agent,
one session-tree per run), so the container adds no boundary we lack.

**Therefore:** ship the **zip** for ADO; build the **container only if/when Windows AKS is real.**
Because both share the `npm ci` core, deferring the image costs nothing — it's one extra
packaging line on the same job later.

## Prerequisites / code changes for "identical worker code"

1. **Path portability in `worker.js`.** [`packages/sdk/examples/worker.js`](../../packages/sdk/examples/worker.js)
   hardcodes POSIX fallbacks (`/app/packages/cli/plugins`, `/app/plugin` — lines ~61–65) and documents
   `PLUGIN_DIRS` default `/app/plugin`. Make these env-driven / `path.join`-based so the same code runs
   whether staged at `C:\app\...` (container) or an arbitrary extract dir (zip). One fix serves all
   three package shapes.
2. **`worker.js` is not in the published SDK tarball.** The SDK `files` allowlist excludes `examples/`,
   so `pilotswarm-sdk-<v>.tgz` does not contain the entrypoint. The stage step copies it explicitly;
   alternatively, promote a worker entrypoint into `dist/` (+ a `bin`) so it ships in the package.
3. **Signal handling on Windows containers.** `worker.js` drives `gracefulShutdown()` from `SIGTERM`
   / `SIGINT` (lines ~165–166). On **Windows containers**, k8s termination does not deliver a real
   `SIGTERM` the way Linux does. Validate graceful drain-on-terminate, or rely on the duroxide lease
   reclaim (30s) as the safety net. **Not a concern for the ADO host process** (drain is driven by the
   long-wait-release policy, not pod termination).

## Windows AKS specifics (only if we pursue Tail 2)

- Add a **Windows Server 2022 node pool**; the worker Deployment needs
  `nodeSelector: kubernetes.io/os: windows` + the Windows taint toleration.
- **Replace the `busybox` initContainer** in [`deploy/k8s/worker-deployment.yaml`](../../deploy/k8s/worker-deployment.yaml)
  — a Windows pod can't run a Linux init container, and there is no `chown` on Windows. Use a
  nanoserver `mkdir`, or handle the `.copilot` dir via the volume/securityContext.
- Rewrite POSIX env paths (`PLUGIN_DIRS=/app/...`, mountPath `/home/node/.copilot`) to `C:\...`.
- Base image: `windows/servercore:ltsc2022` (MSVC runtime present) rather than bare `nanoserver`.
- Enable Windows long paths for deep `node_modules`.

## Recommendation

1. Add a **`windows-latest` build job** (in `publish-npm.yml` or a sibling workflow) that produces the
   **zip bundle** and attaches it to the Release / publishes it as an ADO artifact. This unblocks the
   ADO Windows-VM worker.
2. Land the **`worker.js` path-portability fix** (prerequisite #1) so the same binary runs from any
   extract location.
3. Keep the **Windows container tail** (`Dockerfile.worker.windows` + `docker build` line) as a
   ready-to-enable addition, activated only when Windows AKS is on the roadmap.

## Related

- SQL-AI-Marketplace: `SqlOrchestrationPlatform/docs/PILOTSWARM_ADO_WORKER_DESIGN.md` — the ADO
  session-tree affinity / VHD-cached placement design this packaging feeds.
- [`deploy/Dockerfile.worker`](../../deploy/Dockerfile.worker) — the Linux analog whose `npm ci` +
  `COPY` manifest this proposal mirrors on Windows.
- [`​.github/workflows/publish-npm.yml`](../../.github/workflows/publish-npm.yml) — the additive
  release flow to extend with the Windows build job.
