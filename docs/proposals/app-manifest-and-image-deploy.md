# Proposal: App Manifest and Image Deploy

> **Status:** Proposal
> **Date:** 2026-07-01
> **Goal:** Make a layered PilotSwarm app deployable and manageable from the portal Admin console: one Docker image carrying everything, one PilotSwarm app manifest describing it, a Deploy button that rolls the worker fleet through a pluggable deploy provider (AKS first, via `pilotswarm-azure`), and out-of-box tooling that assembles both.
> **Supersedes:** `app-package-hot-load.md` (earlier draft of this proposal — hot-loaded config packages, registry blobs, capability handshake). This design deliberately replaces hot-load with image rollout.

---

## Summary

One artifact, one truth. A PilotSwarm app is:

- a **Docker image** built on the official PilotSwarm worker base image, carrying *everything* — agents, skills, MCP config, session policy, custom JS tools, system binaries;
- a **PilotSwarm app manifest** (`pilotswarm.app.json`) that names the app, carries its branding (title, icon), lists its agents, and pins the image by reference + digest.

The **Admin console** (no separate Plugins button) gains an **App** section where the admin selects a manifest and hits **Deploy**. Deployment is a **rolling image rollout** of the worker fleet, driven by a pluggable **deploy provider** — implemented first for AKS in a `pilotswarm-azure` npm package. Clusters without a provider get a manual mode: the portal records the desired manifest and shows exactly what to roll by hand; workers acknowledge when they arrive either way.

Why this shape instead of hot-loading config at runtime (the earlier draft):

- **No split brain.** Config and code always travel together in the image, so there is no drift between a hot-loaded package and the image's capabilities, no capability handshake, no mixed fleets of half-swapped registries.
- **Apply rides the most battle-tested path in the system.** A rolling worker restart is exactly what PilotSwarm durability is built for — sessions dehydrate, workers restart, sessions resume. No new hot-swap machinery, no new failure modes. Rollback is "deploy the previous manifest."
- **The inner loop was never the cluster's job.** `pilotswarm local --plugin ./plugin --worker ./worker-module.js` already gives instant prompt iteration on a dev box. The portal flow is for *shipping*, where minutes and a restart are deploy-grade behavior, not friction.

What an operator's life looks like: edit an agent prompt → `psctl app push` → open Admin → Deploy. No hand-rolled Dockerfile, no `kubectl`, no bespoke deploy scripts.

## The App Manifest

`pilotswarm.app.json` — the unit the Admin console manages:

```json
{
  "manifestVersion": 1,
  "name": "acme-dbops",
  "title": "Acme — DB Ops",
  "icon": "data:image/png;base64,...",
  "image": {
    "ref": "acmecr.azurecr.io/acme-dbops-worker:1.7.0",
    "digest": "sha256:9f2c..."
  },
  "agents": [
    { "name": "db-engineer", "title": "DB Engineer", "description": "..." },
    { "name": "incident-watcher", "title": "Incident Watcher", "description": "..." }
  ],
  "sdk": "0.4.0",
  "builtAt": "2026-07-01T21:14:00Z"
}
```

Rules:

- **Generated, never hand-written.** `psctl app build` derives the agent list from the plugin folder's `*.agent.md` frontmatter and stamps the image digest after the build. The manifest is a *verified claim* about a specific image, not documentation that can rot.
- The same manifest is **baked into the image** at a well-known path (`/etc/pilotswarm-app.json`). Workers read it at startup and self-report — that closes the trust gap between what the portal displays and what the fleet actually runs (see Fleet Truth below).
- `icon` + `title` resolve the branding question the plugin-format left open: app identity is first-class manifest data, displayed in the portal header and Admin console.
- `name` is a DNS label; `image.digest` is required for deploys (tag-only manifests are refused — rollouts pin digests so "what is running" is never ambiguous).

## The Worker Image Contract

Unchanged in spirit from the base-image idea, now the *only* delivery vehicle:

**Official base image** `pilotswarm/worker:<sdk-version>`, published by the same release workflow as the npm packages. It contains the SDK and a **generic worker entrypoint** (`pilotswarm worker`, headless CLI command) that:

- builds `PilotSwarmWorkerOptions` entirely from the documented env contract (`DATABASE_URL`, `GITHUB_TOKEN`, managed-identity flags, blob config, `workerNodeId` from `POD_NAME`/hostname — the same env vars downstream apps' hand-rolled worker entrypoints parse today);
- loads app config from the conventional baked path (`pluginDirs: ["/app/plugin"]` — the existing five-tier loader, byte-for-byte unchanged);
- auto-discovers custom tool modules from `/app/tools/*/worker-module.js` (the existing `createTools()`/`tools` module contract) and registers them;
- reads `/etc/pilotswarm-app.json` and reports it on the heartbeat channel.

**An app image is a five-line Dockerfile**, standard Docker, buildable and runnable anywhere:

```dockerfile
FROM pilotswarm/worker:0.4.0
RUN apt-get install -y postgresql-client            # system binaries the agents shell out to
COPY plugin/ /app/plugin/                            # agents, skills, .mcp.json, session-policy.json
COPY tools/  /app/tools/acme-dbops/                  # worker-module.js + package.json
RUN cd /app/tools/acme-dbops && npm ci --omit=dev
```

(`psctl app build` writes this and the `/etc/pilotswarm-app.json` layer; teams with their own image pipelines just follow the contract.)

## Out-of-Box Tooling

`psctl app` — three commands:

```
psctl app init                    # scaffold: plugin/ skeleton, tools/ skeleton, app config
psctl app build                   # assemble Dockerfile from the base image, docker build,
                                  #   generate pilotswarm.app.json from plugin/ frontmatter,
                                  #   stamp the built image digest into it
psctl app push                    # docker push to the app's registry +
                                  #   upload the manifest to the cluster (CMS) as a deploy candidate
psctl app push --deploy           # same, then trigger the provider rollout (CI one-liner)
```

`build` runs plain `docker build` with the operator's local Docker; `push` uses their existing registry login. PilotSwarm never proxies image bytes — images flow developer → registry → cluster pull, exactly as they do today.

## Admin Console: the App Section

Inside the existing Admin console (same `UI_COMMANDS`/selector pattern, admin-gated — it must be, since this surface can roll the fleet):

1. **Current app.** Manifest identity (icon, title, name), image ref + digest, deployed-at/by, and the **read-only agent list** from the manifest. Below it, **fleet truth**: "5 of 6 workers on `sha256:9f2c…`" with per-worker status, and a drift flag if any worker's self-reported manifest disagrees with the deployed one.
2. **Deploy a new manifest.** Upload `pilotswarm.app.json` or paste a URL to one (raw GitHub URL works — this is where the repo-pointer idea lands now, fetching a ~2 KB manifest instead of ingesting tarballs). The staged manifest renders the same read-only view with a "staged — not deployed" banner.
3. **Deploy.** Confirm modal states the blast radius: image change, agent diff vs. current (added/removed/kept by name), live session count. Confirm → provider rollout with progress from fleet acks → history entry. **History + Rollback**: every deployed manifest is retained; rollback is deploying a previous one.

Storage: manifests and deploy history live in CMS (`app_manifests`, `app_deploy_history`, and an active pointer). Tiny JSON rows — no blob storage, no `plugin_registry`.

## Deploy Providers

The part that must not tie PilotSwarm to AKS. Core defines a minimal interface — nothing cloud-shaped in it:

```ts
interface DeployProvider {
  current(): Promise<{ imageRef: string; digest?: string; workers: WorkerImageStatus[] }>;
  rollout(manifest: AppManifest): Promise<RolloutHandle>;   // begin rolling the fleet to manifest.image
  status(handle: RolloutHandle): Promise<RolloutStatus>;     // progressing / complete / failed(reason)
  rollback(toManifest: AppManifest): Promise<RolloutHandle>; // deploy a previous manifest
}
```

- **`pilotswarm-azure`** (separate npm package) implements it for AKS: Azure Identity auth (workload identity / `DefaultAzureCredential`), patches the worker Deployment's image to the manifest's digest-pinned ref, and reports rollout status from the Kubernetes API. Configured on the portal server (`deployProvider: "pilotswarm-azure"` + provider config); the portal loads it dynamically. All Azure/K8s SDK dependencies live in this package — core and the portal keep zero cloud dependencies.
- **Manual mode (no provider)** is a first-class path, not an error state: Deploy records the manifest as *desired state*, the App section shows the exact image ref to roll by hand (compose, bare docker, any orchestrator), and fleet acks track arrival identically. The provider is an accelerator, not a requirement.
- Future providers (compose-over-SSH, ACA, ECS) implement the same four methods; none are in scope now.

Provider credentials and rollout authority are the sharpest security edge here: Deploy is admin-gated in the portal, provider config lives server-side only, and every deploy/rollback writes an audit event (`app.deployed`, `app.rollback`, actor identity) to the plugin-admin events channel.

## Fleet Truth

Workers are the source of truth about what's actually running:

- At startup the generic entrypoint reads `/etc/pilotswarm-app.json` and includes `{ appName, digest, agents[] }` in its heartbeat/registration.
- The portal aggregates: rollout progress ("K of N workers on the target digest"), stragglers by name, and **drift detection** — a worker reporting a different manifest than the deployed one is flagged, not silently averaged away.
- Session semantics during rollout are the existing restart semantics: running turns on a draining worker follow the normal dehydrate / lossy-handoff path and resume on upgraded workers. Sessions whose agent was removed by the new app fail agent resolution on their next turn — the deploy confirm modal warns with the agent diff and live session counts. (Nothing new is built here; that is the point.)

## What This Kills (vs. the superseded draft)

- `plugin_registry` blob storage, tarball ingestion, GitHub tarball fetching, server-side pack/validate.
- Runtime hot-swap of agent registries (`AgentRegistry` holder, pointer polling, atomic tier swaps).
- The capability handshake (`requires` blocks, capability stamps, per-worker satisfaction checks) — config and code can no longer disagree.
- The separate Plugins button — this is Admin's job.

What it keeps: the plugin **folder format and loader contract** from [plugin-packaging-and-distribution](./plugin-packaging-and-distribution.md) (that's what `/app/plugin` is), the base-image + generic-entrypoint deliverable, and the worker ack channel (now carrying manifest identity instead of package versions).

## Out of Scope (step one)

- **Multiple apps per cluster** — one app, one manifest, one fleet. Multi-app is a later slot model.
- **In-portal authoring/editing** of agents or manifests — the repo is the editor; the manifest is generated.
- **Image byte proxying or a PilotSwarm image registry** — bring your own registry.
- **Per-session version pinning** — sessions resolve against whatever the fleet runs, same relaxation as before.
- **Non-AKS providers** — interface yes, implementations no.

## Migration: existing layered apps

- A `plugin/` folder that follows the loader contract already matches the baked-config layout; existing `worker-module.js` tool modules already match the tool-module contract.
- Delete the app's hand-rolled worker entrypoint (typically hundreds of lines of env parsing) in favor of the generic entrypoint; shrink the bespoke worker Dockerfile to the five-line contract Dockerfile.
- Bespoke deploy scripts are replaced by `psctl app push --deploy` once `pilotswarm-azure` is configured; until then, `psctl app push` + manual-mode rollout.

## Open Questions

- **Provider credential model:** portal-server workload identity (recommended) vs. per-admin credentials entered at deploy time — does step one need the latter at all?
- **Manifest-by-URL trust:** deploys pin digests, so a tampered manifest can at worst point at a different *named* image the registry already serves — is digest pinning + registry ACLs sufficient, or do manifests want a signature story before this leaves Azure-internal use?
- **Compose/manual-mode acks without heartbeats:** is the existing worker heartbeat channel rich enough to carry the manifest payload, or does this add a small registration table?
- **Base image cadence:** one `pilotswarm/worker` tag per npm release, published by the same workflow — and does the starter appliance re-base onto it in the same release?
- **Agent-diff warnings:** should the deploy confirm block (not just warn) when removed agents have running sessions, with a "terminate and deploy" option?
