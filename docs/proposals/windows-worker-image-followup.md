# Follow-up: Efficient Windows worker **image** build (deferred)

**Status:** Deferred / parked (2026-08-11)
**Author:** kchung
**Referenced from:** [`deploy/Dockerfile.worker`](../../deploy/Dockerfile.worker) (pwsh-install comment)

## TL;DR

The git-hydration fleet (git-cache + git-repo-worker DaemonSets) needs a worker
image that can run PowerShell (the SQL agent skills shell out to `pwsh`). We
**parked the native Windows container image** and shipped a **shared Linux image
with PowerShell Core installed** instead (`Dockerfile.worker` now installs pwsh
7.4.6 from the distro-agnostic release tarball). PowerShell Core runs natively on
Linux, so this satisfies the "must run PowerShell" requirement **today** without
the Windows-container tax below.

This note records **why we want a Windows worker at all** and **why a native
Windows worker image build is non-trivial**, so whoever picks it up later doesn't
re-derive it. It is intentionally a rationale-and-challenges note — **no Windows
image build recipe, Dockerfile, or CI is committed on this branch**.

## Why we want a Windows worker (the motivation)

pwsh-on-Linux covers the "must run PowerShell" need for the AKS fleet today, but
there are Windows-specific reasons a native Windows worker stays on the roadmap:

1. **ADO Windows VMs with a VHD-baked enlistment.** The SQL-AI-Marketplace ADO
   worker path targets a 1ES managed Windows pool where the target enlistment is
   pre-hydrated into the agent VHD. A worker running there as a **host process**
   gets same-filesystem access to that enlistment — no container boundary, no
   bind-mount over the VHD.
2. **Possible future Windows AKS node pool.** A Windows Server node pool would
   require an OCI **Windows image** — the expensive piece described below.
3. **Windows-only runtime needs.** A skill that requires Windows PowerShell 5.1
   or a Windows-only native tool that pwsh-on-Linux can't cover would force a
   real Windows worker.

## Why we deferred the native Windows image

Empirical findings from the 2026-08-11 bring-up attempt (Basic ACR
`pskchtestacr`, `az acr build --platform windows`):

1. **No official Node-on-Windows base image.** There is no
   `mcr.microsoft.com/.../node:24-windowsservercore` equivalent. You must start
   from `windows/servercore:ltsc2022` (multi-GB) and install Node yourself
   (zip/msi + PATH). `nanoserver` is too small — the `duroxide-windows-x64`
   prebuild links the **MSVC runtime**, which is present in servercore but absent
   from nanoserver. (Community Node-on-servercore images exist but are unofficial
   and lag Node 24.)
2. **servercore base is huge and slow to pull.** The ltsc2022 servercore base is
   several GB; the first build on a fresh ACR agent spends most of its wall-clock
   just pulling the base layer before any of our steps run.
3. **The build context was pathological.** The first working attempt shipped a
   pre-staged `node_modules` in the build context — a **646 MB / ~40,107-file**
   tar. Packing + uploading that context dominated the build. The fix (moving to
   in-container `npm ci` so the context drops to a few MB) works but then pays the
   `npm ci` + native-addon resolution cost **inside** a slow Windows layer.
4. **`Expand-Archive` / file-churn on Windows layers is slow.** Unpacking Node +
   the dependency tree inside servercore layers is markedly slower than the
   equivalent `apt`/`tar` steps on the Linux base — Windows filesystem-layer
   commit overhead per file is high, and deep `node_modules` needs long-path
   support enabled.
5. **Node 24 toolchain caveat (build-from-source only).** Node 24 dropped MSVC
   support and needs ClangCL to build from source — **not** a blocker for us
   (we use prebuilt binaries + the `duroxide-windows-x64` prebuild), but a trap
   for anyone tempted to compile.

Net: a correct Windows image is *achievable* (proven — a servercore build did run
on Basic ACR in the same session), but each iteration is **10–20 min** vs. the
Linux image's ~3.5 min, which made it the wrong thing to block the fleet bring-up
on.

## What "efficient" would require (the actual follow-up work)

- **A cached, pre-built Windows base layer** (`servercore + Node 24 + MinGit +
  MSVC runtime`) pushed to ACR once, so day-to-day worker builds are
  `FROM <our-windows-base>` + `COPY dist/` + a thin `npm ci` — not a
  base-pull-plus-Node-install every time — i.e. a two-image split: a cached base
  image built on its own cadence, plus a thin worker image (`COPY dist/` + a thin
  `npm ci`) on top.
- **Small build context** (in-container `npm ci`, `.dockerignore` excludes
  `node_modules`/`.git`) — already done in the parked Dockerfiles.
- **A build cadence** that rebuilds the base only when Node/servercore/duroxide
  moves, not per worker change.
- Decide **image vs. zip-bundle** per host: for **Windows AKS** we need the OCI
  image; for **ADO Windows VMs** a zip host-process bundle is preferred (no
  container boundary over the VHD enlistment). Both share the same expensive
  `npm ci` + `tsc` core and diverge only at the final packaging step.

## Prototype artifacts (validated, then removed — recorded here for reference)

During the attempt the following were authored and validated, then **removed
from the branch** to keep it Windows-implementation-free (this branch ships the
Linux+pwsh path only). They are described here so the follow-up can re-create
them; none is needed on the Linux path.

- **Windows base Dockerfile** (`Dockerfile.worker-base.windows`) — the cached
  base: `FROM mcr.microsoft.com/windows/servercore:ltsc2022`, install Node 24
  (zip) + MinGit, meant to be built once and pushed to ACR so worker builds are
  `FROM <our-windows-base>`.
- **Windows worker Dockerfile** (`Dockerfile.worker.windows`) —
  `FROM <windows-base>` + in-container `npm ci --omit=dev` + `COPY dist/` (mirror
  of the Linux `Dockerfile.worker` COPY manifest). Small build context because
  `node_modules` is built in-image, not shipped in the context.
- **Windows git-cache + git-repo-worker DaemonSets**
  (`deploy/gitops/git-cache-windows/`, `deploy/gitops/git-repo-worker-windows/`)
  — the Windows analogs of the Linux `deploy/gitops/git-cache/` +
  `deploy/gitops/git-repo-worker/` manifests: `nodeSelector kubernetes.io/os:
  windows`, `C:\`-style hostPaths, and a nanoserver (not busybox) init step
  because a Windows pod can't run a Linux init container.
- **Cross-platform git-cache daemon** (`git-cache-daemon.js`) — a Node port of
  the shell `fetch-loop.sh` (the Linux git-cache runs the shell script from a
  ConfigMap; on Windows that shell script can't run, so the fetch loop must be
  Node).
- **Windows build workflow** (`.github/workflows/build-windows-worker.yml`) —
  the `windows-latest` job that produces the zip bundle and/or the image from a
  single shared build (one `npm ci` + `tsc`, two packaging tails).

To resume: re-introduce a cached Windows base image (built on its own cadence),
then the thin worker Dockerfile on top; wire the Windows DaemonSets to a Windows
node pool; and enable the build workflow.

## Decision

**Ship the Linux+pwsh image now; revisit the native Windows image only if a
Windows-specific runtime need appears** (e.g. a skill that requires Windows
PowerShell 5.1 / a Windows-only native tool that pwsh-on-Linux can't cover).
File this as a tracked work item so the parked artifacts above don't rot.
