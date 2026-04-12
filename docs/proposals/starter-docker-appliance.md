# Starter Docker Appliance

> **Status:** Proposal  
> **Date:** 2026-04-10  
> **Goal:** Provide an extremely simple first-run PilotSwarm experience via a single self-contained Docker container with browser access, SSH-accessible TUI, two separate headless worker processes, container-local log tailing, and optional embedded PostgreSQL.

---

## Summary

PilotSwarm already has the pieces for a great local experience:

- a browser portal
- headless workers
- filesystem-backed artifacts and session state
- a TUI that can run as a lightweight client

What it does **not** have yet is a truly minimal, productized "try it now" entry point.

This proposal introduces a new starter image: a **single Docker container** that can be run with only a GitHub token and a persistent data volume. By default, it also boots a local PostgreSQL instance inside the same container unless `DATABASE_URL` is explicitly provided.

Blob storage is also optional:

- if `AZURE_STORAGE_CONNECTION_STRING` is provided, the starter uses blob-backed dehydration and blob-backed artifacts
- otherwise it uses the local filesystem under `/data`

The starter image exposes two access paths to the same PilotSwarm runtime:

- **Browser portal** via `http://localhost:3001`
- **TUI over SSH** via `ssh -p 2222 pilotswarm@localhost`

The container runs two separate headless PilotSwarm worker processes. Both the portal and the SSH TUI connect as clients against the same runtime and database, so both surfaces share sessions, artifacts, and agent state without either UI process owning a worker pool.

---

## Goals

- Make the very first PilotSwarm experience one command.
- Require only:
  - `GITHUB_TOKEN`
  - a persistent filestore mount
  - optionally `DATABASE_URL`
- Optionally accept blob storage configuration via environment variables.
- Expose both:
  - browser-native portal on localhost
  - SSH-based TUI from the same container
- Keep the starter footprint intentionally small:
  - exactly **2 worker processes**
  - only a small GHCP model catalog
- Support container-local log tailing for both portal and TUI.
- Rotate logs so the starter image does not slowly consume disk.
- Default to embedded PostgreSQL when no external database is configured.

## Non-Goals

- Replacing the existing portal and worker production deployment path.
- Bundling Entra ID or other enterprise auth into the starter flow.
- Supporting arbitrary model providers in the starter image.
- Running a multi-container orchestration stack for first-run.
- Exposing PostgreSQL outside the container by default.
- Matching AKS/remote-mode `kubectl logs` behavior inside the starter image.

---

## User Experience

### Primary Entry Point

The starter image should be runnable as:

```bash
docker run --rm \
  -p 127.0.0.1:3001:3001 \
  -p 127.0.0.1:2222:2222 \
  -e GITHUB_TOKEN=... \
  -v pilotswarm-data:/data \
  ghcr.io/affandar/pilotswarm-starter:latest
```

For out-of-box local use, SSH should also work without mounting a public key:

- default SSH user: `pilotswarm`
- default SSH password: `pilotswarm`

If the operator wants a different password, they can set:

```bash
-e PILOTSWARM_SSH_PASSWORD=...
```

If the operator mounts `authorized_keys`, key-based SSH should also work.

### Optional External Database

If the user already has PostgreSQL:

```bash
docker run --rm \
  -p 127.0.0.1:3001:3001 \
  -p 127.0.0.1:2222:2222 \
  -e GITHUB_TOKEN=... \
  -e DATABASE_URL=postgresql://... \
  -v pilotswarm-data:/data \
  ghcr.io/affandar/pilotswarm-starter:latest
```

### Optional Blob Storage

If the user wants shared dehydration and shared artifact storage across containers:

```bash
docker run --rm \
  -p 127.0.0.1:3001:3001 \
  -p 127.0.0.1:2222:2222 \
  -e GITHUB_TOKEN=... \
  -e DATABASE_URL=postgresql://... \
  -e AZURE_STORAGE_CONNECTION_STRING="DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net" \
  -e AZURE_STORAGE_CONTAINER=pilotswarm-sessions \
  -v pilotswarm-data:/data \
  ghcr.io/affandar/pilotswarm-starter:latest
```

### What the User Gets

After startup, the user can either:

- open `http://localhost:3001` in a browser
- run `ssh -p 2222 pilotswarm@localhost`

By default, the starter appliance should allow relaxed localhost SSH login with:

- username: `pilotswarm`
- password: `pilotswarm`

Mounting `authorized_keys` remains optional for users who prefer key-based login.

Both surfaces connect to the same PilotSwarm instance:

- same sessions
- same titles
- same artifacts
- same agent behavior
- same underlying event history

---

## Design Principles

1. **One container, one obvious way in**
   - The starter image should feel like an appliance.

2. **Browser-first, terminal-also**
   - The browser portal is the primary first-run surface.
   - The TUI remains available for terminal-native users.

3. **One worker pool, zero client-owned workers**
   - The container should run a dedicated shared worker pool.
   - The portal and the SSH TUI should both behave like clients.

4. **Small and predictable**
   - Limit to 2 workers.
   - Limit to a small GHCP model catalog.

5. **Local by default**
   - Local logs, local filesystem storage, local Postgres fallback.

6. **Safe resource behavior**
   - Rotate logs.
   - Keep PostgreSQL private to the container unless explicitly externalized.
   - Reuse the existing blob-store env contract instead of inventing starter-only storage knobs.

---

## Proposed Architecture

```text
Browser
  -> localhost:3001
  -> Portal Server
  -> client/runtime gateway
  -> PostgreSQL
  -> shared artifact/session stores

SSH
  -> localhost:2222
  -> sshd
  -> client-only TUI
  -> same PostgreSQL
  -> same shared artifact/session stores

Workers
  -> worker-a
  -> worker-b
  -> same PostgreSQL
  -> same shared artifact/session stores
```

### Process Layout Inside the Container

```text
starter container
├── portal server
│   ├── client-only mode
│   └── writes logs to /data/logs/portal.log
├── worker-a
│   ├── headless PilotSwarm worker
│   └── writes logs to /data/logs/worker-a.log
├── worker-b
│   ├── headless PilotSwarm worker
│   └── writes logs to /data/logs/worker-b.log
├── sshd
│   ├── relaxed localhost password auth by default
│   ├── optional authorized_keys support
│   ├── auto-launches TUI on login
│   └── writes logs to /data/logs/sshd.log
├── optional local postgres
│   ├── starts only when DATABASE_URL is unset
│   ├── stores data in /data/postgres
│   └── writes logs to /data/logs/postgres.log
└── lightweight supervisor
    ├── keeps processes alive
    └── handles log file rotation
```

---

## Process Separation Model

The starter image should use exactly one shared worker pool, but the workers should run as their own processes.

### Portal

The portal runs as a **client-only** process:

- no embedded workers
- same `DATABASE_URL`
- same model/provider configuration
- same plugin and branding configuration

### SSH TUI

The SSH-launched TUI also runs as a **client-only** process:

- no embedded workers
- same `DATABASE_URL`
- same model/provider configuration
- same plugin and branding configuration

### Workers

The appliance runs exactly two separate worker processes under supervision, for example:

- `worker-a`
- `worker-b`

Each worker points at the same:

- `DATABASE_URL`
- blob storage configuration, if present
- plugin configuration
- model-provider configuration

This is a cleaner tiny-cluster model than having the portal own embedded workers:

- the portal can restart without being the worker host
- the TUI can connect exactly like any other client
- the process topology more closely resembles a real shared-worker deployment
- scaling out to multiple containers becomes conceptually straightforward

### Recommended TUI Behavior

The TUI launched over SSH should connect to the same runtime, but should **not** use AKS/remote-mode `kubectl logs`.

Instead it should behave like:

- local database client
- no embedded workers
- log tailing from container-local log files

This may require either:

1. a small new "local-client-only" mode, or
2. a targeted transport enhancement so `WORKERS=0` local runs are treated as valid and use file-based log tailing.

The second approach is preferred because it avoids introducing a broader new top-level mode name unless needed.

---

## Database Behavior

### Default: Embedded PostgreSQL

If `DATABASE_URL` is **not** provided:

- the container initializes PostgreSQL under `/data/postgres`
- the entrypoint synthesizes:

```bash
DATABASE_URL=postgresql://pilotswarm:pilotswarm@127.0.0.1:5432/pilotswarm
```

- the portal and TUI both use that connection string

This gives a real zero-to-first-chat path with no database prerequisite.

Important:

- containers using their own embedded local PostgreSQL instances are **not** part of the same cluster
- each such container is an isolated PilotSwarm appliance

### External PostgreSQL

If `DATABASE_URL` **is** provided:

- the starter container does **not** launch local PostgreSQL
- the portal and SSH TUI both use the supplied external database

### Why This Split

This gives us the best of both worlds:

- lowest-friction first run for new users
- no dead-end for users who already have a managed PostgreSQL instance

---

## Artifact and Session Storage Behavior

The starter image should follow the existing storage contract already used by the worker:

- `AZURE_STORAGE_CONNECTION_STRING`
- `AZURE_STORAGE_CONTAINER`

### When Blob Storage Is Configured

If `AZURE_STORAGE_CONNECTION_STRING` is present:

- use Azure Blob-backed session dehydration
- use Azure Blob-backed artifact storage
- enable cross-container handoff for dehydrated sessions
- make artifacts visible across all starter containers pointing at the same store

### When Blob Storage Is Not Configured

If `AZURE_STORAGE_CONNECTION_STRING` is absent:

- use filesystem-backed artifacts under `/data/artifacts`
- use filesystem-backed session snapshots/session-store data under `/data`
- sessions and artifacts are local to that container's mounted volume

This is the right default for a single-container starter, but it is **not** enough for a true shared multi-container cluster unless the containers also share a filesystem volume.

### Why Reuse the Existing Env Vars

The current worker already understands:

- `AZURE_STORAGE_CONNECTION_STRING`
- `AZURE_STORAGE_CONTAINER`

Reusing those names avoids a second storage configuration dialect just for the starter image.

---

## Image Updates and Data Persistence

Updating the Docker image does **not** delete persistent data by itself.

Data survives image updates as long as it lives outside the container's ephemeral writable layer, for example in:

- a named Docker volume such as `-v pilotswarm-data:/data`
- a bind mount
- an external PostgreSQL instance
- external blob storage

For the starter appliance, this means:

- embedded PostgreSQL data persists if `/data/postgres` is on a persistent volume
- filesystem artifacts persist if `/data/artifacts` is on a persistent volume
- logs persist if `/data/logs` is on a persistent volume

What does **not** persist automatically:

- data written only into the container filesystem without a mounted volume
- data from containers started with no persistent mount and then removed

So the recommended update model is:

1. stop the old container
2. start a new container from the new image
3. reuse the same mounted `/data` volume and the same external service configuration

This lets the image be replaced while the durable state remains intact.

---

## Storage Layout

The starter image should treat `/data` as its filestore root.

```text
/data
├── artifacts/
├── session-state/
├── session-store/
├── exports/
├── logs/
│   ├── portal.log
│   ├── sshd.log
│   ├── postgres.log
│   └── rotated archives
└── postgres/
```

### Notes

- `artifacts/` backs uploaded/generated files
- `session-state/` and `session-store/` back local worker state
- `exports/` holds exported histories or user-downloadable bundles
- `logs/` is the source for local log tailing
- `postgres/` exists only when using embedded PostgreSQL

If blob storage is configured, `/data` still remains useful for:

- logs
- exports
- temporary session-state scratch
- optional embedded PostgreSQL when not using an external DB

---

## Model Catalog

The starter image should not rely on broad environment fallback for model providers.

Instead, it should bake a small explicit model catalog via:

```bash
PS_MODEL_PROVIDERS_PATH=/app/config/model_providers.local-docker.json
```

### Initial Catalog

Keep the first-run list intentionally short and high-signal:

- `claude-sonnet-4.6` as default
- `gpt-5.4`
- `gpt-5-mini`
- `gpt-5.4-mini`
- `claude-opus-4.6`

All models should come from the GitHub Copilot provider path only.

At the time of writing, the live GHCP catalog exposed by `listModels()` did **not**
include a GPT nano variant for this starter path, so the starter appliance should
only advertise models that are currently available through the GitHub Copilot
provider.

---

## Authentication and Security

### Portal

The starter image should default to:

```bash
PORTAL_AUTH_PROVIDER=none
```

Rationale:

- this is a localhost-first getting-started path
- the user already controls access to the host and Docker session
- auth complexity would make the first-run flow much worse

### SSH

The SSH service should use:

- key-based auth only
- authorized keys mounted from host
- no password auth
- no root login

The Docker documentation should recommend binding SSH to `127.0.0.1` by default.

### PostgreSQL

Embedded PostgreSQL should remain container-private by default:

- listen only on container-local interfaces
- not published with `-p`

---

## Log Tailing and Rotation

The starter image should support log viewing in both portal and SSH TUI by reading **files inside the container**, not `kubectl logs`.

### Log Sources

- `portal.log`
- `sshd.log`
- `postgres.log`
- optionally a combined runtime log later

### Tailing Model

Both the portal and SSH TUI should tail from `/data/logs`.

This means the transport layer needs a local file-tail mode, likely enabled by:

```bash
PILOTSWARM_LOG_DIR=/data/logs
```

### Rotation Requirements

Logs must be rotated so they cannot grow without bound.

Recommended starter defaults:

- max file size: `10MB`
- retained rotations per file: `5`
- optional compression for older rotations

This keeps the footprint bounded without introducing a full logging stack.

### Why File Tailing Instead of Container Stdout Only

Stdout-only logs are fine for Docker basics, but they are not enough for the desired user experience:

- the portal inspector wants direct log access
- the SSH TUI wants local log browsing without Docker CLI coupling
- file-backed logs make rotation predictable

The container may still mirror logs to stdout for `docker logs`, but the in-product tailing source should be the rotated files.

---

## Configuration Contract

### Required

- `GITHUB_TOKEN`

### Optional

- `DATABASE_URL`
- `AZURE_STORAGE_CONNECTION_STRING`
- `AZURE_STORAGE_CONTAINER`
- SSH authorized key mount

### Required Persistent Mount

- `/data`

### Proposed Default Environment

```bash
PORTAL_MODE=local
PORTAL_AUTH_PROVIDER=none
WORKERS=0
SESSION_STATE_DIR=/data/session-state
SESSION_STORE_DIR=/data/session-store
ARTIFACT_DIR=/data/artifacts
PILOTSWARM_EXPORT_DIR=/data/exports
PILOTSWARM_LOG_DIR=/data/logs
PS_MODEL_PROVIDERS_PATH=/app/config/model_providers.local-docker.json
```

### Client Process Defaults

```bash
WORKERS=0
```

Both the portal and the SSH-launched TUI should inherit:

- `DATABASE_URL`
- `PILOTSWARM_LOG_DIR`
- `PS_MODEL_PROVIDERS_PATH`

### Worker Process Defaults

Each worker process should inherit:

- `DATABASE_URL`
- `AZURE_STORAGE_CONNECTION_STRING`, if present
- `AZURE_STORAGE_CONTAINER`, if present
- `PILOTSWARM_LOG_DIR`
- `PS_MODEL_PROVIDERS_PATH`

### Storage Selection Rules

At startup:

1. If `DATABASE_URL` is set:
   - use external PostgreSQL
2. Else:
   - start embedded PostgreSQL and synthesize `DATABASE_URL`
3. If `AZURE_STORAGE_CONNECTION_STRING` is set:
   - use blob-backed dehydration + artifact storage
   - respect `AZURE_STORAGE_CONTAINER` or default it to `copilot-sessions`
4. Else:
   - use local filesystem-backed dehydration/artifact storage under `/data`

---

## Multi-Container Behavior

### Can Multiple Starter Containers Form a Cluster?

Yes, **if** they share the right backing services.

For multiple starter containers to behave as one logical PilotSwarm cluster, they must share:

- the same `DATABASE_URL`
- the same session schemas
- the same blob storage configuration, or another truly shared artifact/session store

In that shape, each container contributes:

- one portal instance
- one SSH entrypoint
- two worker processes

and the workers all compete on the same durable orchestration/task hub.

### What If They Do Not Share Postgres?

If each container uses its own embedded local PostgreSQL:

- they are **not** clustered
- each container is its own isolated PilotSwarm deployment

### What If They Share Postgres But Not Blob Storage?

Then clustering is partial and operationally fragile:

- workers can still share some durable orchestration work through PostgreSQL
- but dehydrated sessions and artifacts are not truly portable across containers
- sessions may become effectively pinned to the container whose local filesystem holds the needed state

For a real multi-container cluster, shared blob storage should be considered the recommended path.

### Portal URL Behavior

If multiple all-in-one starter containers are run on the same Docker host and published directly:

- each container needs a different published host port
- for example `3001`, `3002`, `3003`

If they are fronted by a reverse proxy or load balancer:

- they can share one external hostname
- the proxy routes requests to multiple backend containers

For anything beyond a small experiment, one stable portal URL in front of multiple containers is the preferred user experience.

### Practical Recommendation

Technically, multiple starter containers can cluster. Operationally, this is more of a convenience scale-out path than the ideal long-term topology.

The better production shape remains:

- dedicated portal instances
- dedicated worker instances
- shared PostgreSQL
- shared blob storage

The starter cluster path is useful because it lets users scale from "one appliance" to "a few cooperating appliances" without changing images.

---

## Networking Contract

### Exposed Ports

- `3001` for the browser portal
- `2222` for SSH TUI access

### Recommended Host Bindings

The docs should recommend:

```bash
-p 127.0.0.1:3001:3001
-p 127.0.0.1:2222:2222
```

This makes the starter image localhost-first and reduces accidental exposure.

### Who Assigns the Host Port?

The host-side port is assigned by whoever starts the container.

In plain Docker usage, that means the operator chooses it via `-p`:

```bash
docker run -p 3001:3001 ...
```

Here:

- the left side is the host port
- the right side is the container port

If multiple starter containers are run directly on one host, the operator must choose distinct host ports for each published portal and SSH endpoint, for example:

```bash
docker run -p 3001:3001 -p 2222:2222 ...
docker run -p 3002:3001 -p 2223:2222 ...
docker run -p 3003:3001 -p 2224:2222 ...
```

If Docker Compose, a reverse proxy, or an orchestrator is used instead, that layer becomes responsible for assigning or routing the host-facing ports.

---

## Proposed Files

The implementation should likely add:

- `deploy/Dockerfile.starter`
- `deploy/bin/start-starter.sh`
- `deploy/bin/start-embedded-postgres.sh`
- `deploy/bin/pilotswarm-tui.sh`
- `deploy/bin/start-worker.sh`
- `deploy/config/model_providers.local-docker.json`
- `deploy/ssh/sshd_config`
- `deploy/supervisor/supervisord.conf`
- `docs/getting-started-docker-appliance.md`

Potential code changes:

- `packages/cli/src/node-sdk-transport.js`
  - add local file-tail log support
  - allow client-only local TUI path cleanly
- `packages/portal/server.js`
  - run cleanly in client-only mode with no embedded workers
- `packages/portal/runtime.js`
  - likely unchanged

---

## Implementation Plan

### Phase 1: Starter Image Skeleton

- Add `Dockerfile.starter`
- Add supervisor config
- Add startup scripts
- Add two worker-process entries under supervisor
- Add SSH config
- Add GHCP-only provider config

### Phase 2: Embedded PostgreSQL Fallback

- Add entrypoint logic:
  - if `DATABASE_URL` is unset, start local Postgres
  - if `DATABASE_URL` is set, skip local Postgres
- Persist DB files under `/data/postgres`

### Phase 3: Client Process Wiring

- Run portal in client-only mode
- Add key-based SSH login
- Auto-launch the TUI on login
- Ensure SSH TUI starts with `WORKERS=0`
- Ensure both client surfaces share the same runtime store and config

### Phase 4: Worker Process Wiring

- Launch exactly two headless worker processes
- Ensure both workers share the same runtime store and config
- Give each worker a distinct worker node ID / process identity

### Phase 5: File-Based Log Tailing

- Add log file destinations under `/data/logs`
- Add rotation policy
- Extend transport log tailing to read local files
- Make both portal and SSH TUI surface those logs

### Phase 6: Docs and First-Run UX

- Add `docs/getting-started-docker-appliance.md`
- Add a one-command quickstart
- Add external-DB variant docs
- Add shared-Postgres + shared-storage scale-out docs
- Add SSH key mount guidance

---

## Risks and Edge Cases

### Two-Process Runtime Confusion

Risk:

- The portal or SSH TUI accidentally starts embedded workers too.

Mitigation:

- hard-force `WORKERS=0` for both client launchers
- add tests around client-only startup behavior

### Log Growth

Risk:

- container logs fill the persistent volume

Mitigation:

- rotate aggressively
- cap file size and retained generations

### Embedded PostgreSQL Reliability Expectations

Risk:

- users may mistake the starter image for a production HA deployment

Mitigation:

- clearly label embedded Postgres as starter/dev-grade
- document external `DATABASE_URL` as the upgrade path

### SSH Surface Area

Risk:

- users bind SSH to all interfaces unintentionally

Mitigation:

- default docs bind to `127.0.0.1`
- use key auth only

---

## Why This Is the Right First Entry Point

This proposal deliberately optimizes for the first ten minutes:

- one container
- one token
- one data volume
- browser or terminal, whichever the user prefers
- no required cloud deployment
- no required separate database

It is not the final production shape. It is the most approachable shape.

That makes it the right entry point for new users who want to answer one question quickly:

**"Can I get PilotSwarm running right now and see what it feels like?"**
