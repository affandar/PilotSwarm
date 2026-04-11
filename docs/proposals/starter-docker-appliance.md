# Starter Docker Appliance

> **Status:** Proposal  
> **Date:** 2026-04-10  
> **Goal:** Provide an extremely simple first-run PilotSwarm experience via a single self-contained Docker container with browser access, SSH-accessible TUI, two embedded workers, container-local log tailing, and optional embedded PostgreSQL.

---

## Summary

PilotSwarm already has the pieces for a great local experience:

- a browser portal
- embedded workers
- filesystem-backed artifacts and session state
- a TUI that can run as a lightweight client

What it does **not** have yet is a truly minimal, productized "try it now" entry point.

This proposal introduces a new starter image: a **single Docker container** that can be run with only a GitHub token and a persistent data volume. By default, it also boots a local PostgreSQL instance inside the same container unless `DATABASE_URL` is explicitly provided.

The starter image exposes two access paths to the same PilotSwarm runtime:

- **Browser portal** via `http://localhost:3001`
- **TUI over SSH** via `ssh -p 2222 pilotswarm@localhost`

The portal owns the embedded workers. The SSH TUI connects as a **client-only** terminal against the same runtime and database, so both surfaces share sessions, artifacts, and agent state without starting competing worker pools.

---

## Goals

- Make the very first PilotSwarm experience one command.
- Require only:
  - `GITHUB_TOKEN`
  - a persistent filestore mount
  - optionally `DATABASE_URL`
- Expose both:
  - browser-native portal on localhost
  - SSH-based TUI from the same container
- Keep the starter footprint intentionally small:
  - exactly **2 embedded workers**
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
  -v $HOME/.ssh/id_ed25519.pub:/run/pilotswarm/authorized_keys:ro \
  ghcr.io/affandar/pilotswarm-starter:latest
```

### Optional External Database

If the user already has PostgreSQL:

```bash
docker run --rm \
  -p 127.0.0.1:3001:3001 \
  -p 127.0.0.1:2222:2222 \
  -e GITHUB_TOKEN=... \
  -e DATABASE_URL=postgresql://... \
  -v pilotswarm-data:/data \
  -v $HOME/.ssh/id_ed25519.pub:/run/pilotswarm/authorized_keys:ro \
  ghcr.io/affandar/pilotswarm-starter:latest
```

### What the User Gets

After startup, the user can either:

- open `http://localhost:3001` in a browser
- run `ssh -p 2222 pilotswarm@localhost`

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

3. **One worker pool**
   - The container must not accidentally start separate embedded workers for the portal and the SSH TUI.

4. **Small and predictable**
   - Limit to 2 workers.
   - Limit to a small GHCP model catalog.

5. **Local by default**
   - Local logs, local filesystem storage, local Postgres fallback.

6. **Safe resource behavior**
   - Rotate logs.
   - Keep PostgreSQL private to the container unless explicitly externalized.

---

## Proposed Architecture

```text
Browser
  -> localhost:3001
  -> Portal Server
  -> Embedded PilotSwarm runtime
  -> PostgreSQL

SSH
  -> localhost:2222
  -> sshd
  -> client-only TUI
  -> same PostgreSQL
  -> same portal-owned runtime state
```

### Process Layout Inside the Container

```text
starter container
├── portal server
│   ├── local mode
│   ├── WORKERS=2
│   ├── filesystem artifacts/session scratch under /data
│   └── writes logs to /data/logs/portal.log
├── sshd
│   ├── key-based auth only
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

## Worker Ownership Model

The starter image should use exactly one worker pool.

### Portal

The portal runs in:

- `PORTAL_MODE=local`
- `WORKERS=2`

This makes the portal process the owner of the embedded workers.

### SSH TUI

The SSH-launched TUI must run as **client-only**:

- `WORKERS=0`
- same `DATABASE_URL`
- same model/provider configuration
- same plugin and branding configuration

This avoids a dangerous split-brain condition where browser sessions and TUI sessions each start their own embedded workers.

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

### External PostgreSQL

If `DATABASE_URL` **is** provided:

- the starter container does **not** launch local PostgreSQL
- the portal and SSH TUI both use the supplied external database

### Why This Split

This gives us the best of both worlds:

- lowest-friction first run for new users
- no dead-end for users who already have a managed PostgreSQL instance

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

---

## Model Catalog

The starter image should not rely on broad environment fallback for model providers.

Instead, it should bake a small explicit model catalog via:

```bash
PS_MODEL_PROVIDERS_PATH=/app/config/model_providers.ghcp.json
```

### Initial Catalog

Keep the first-run list intentionally short and high-signal:

- `claude-sonnet-4.6` as default
- `gpt-5.1`
- `claude-opus-4.6`

All models should come from the GitHub Copilot provider path only.

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
- SSH authorized key mount

### Required Persistent Mount

- `/data`

### Proposed Default Environment

```bash
PORTAL_MODE=local
PORTAL_AUTH_PROVIDER=none
WORKERS=2
SESSION_STATE_DIR=/data/session-state
SESSION_STORE_DIR=/data/session-store
ARTIFACT_DIR=/data/artifacts
PILOTSWARM_EXPORT_DIR=/data/exports
PILOTSWARM_LOG_DIR=/data/logs
PS_MODEL_PROVIDERS_PATH=/app/config/model_providers.ghcp.json
```

### SSH TUI Launcher Overrides

```bash
WORKERS=0
```

The SSH-launched TUI must also inherit:

- `DATABASE_URL`
- `PILOTSWARM_LOG_DIR`
- `PS_MODEL_PROVIDERS_PATH`

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

---

## Proposed Files

The implementation should likely add:

- `deploy/Dockerfile.starter`
- `deploy/bin/start-starter.sh`
- `deploy/bin/start-embedded-postgres.sh`
- `deploy/bin/pilotswarm-tui.sh`
- `deploy/config/model_providers.ghcp.json`
- `deploy/ssh/sshd_config`
- `deploy/supervisor/supervisord.conf`
- `docs/getting-started-docker.md`

Potential code changes:

- `packages/cli/src/node-sdk-transport.js`
  - add local file-tail log support
  - allow client-only local TUI path cleanly
- `packages/portal/server.js`
  - no conceptual change required beyond starter env
- `packages/portal/runtime.js`
  - likely unchanged

---

## Implementation Plan

### Phase 1: Starter Image Skeleton

- Add `Dockerfile.starter`
- Add supervisor config
- Add startup scripts
- Add SSH config
- Add GHCP-only provider config

### Phase 2: Embedded PostgreSQL Fallback

- Add entrypoint logic:
  - if `DATABASE_URL` is unset, start local Postgres
  - if `DATABASE_URL` is set, skip local Postgres
- Persist DB files under `/data/postgres`

### Phase 3: SSH TUI Path

- Add key-based SSH login
- Auto-launch the TUI on login
- Ensure SSH TUI starts with `WORKERS=0`
- Ensure it shares the same runtime store and config

### Phase 4: File-Based Log Tailing

- Add log file destinations under `/data/logs`
- Add rotation policy
- Extend transport log tailing to read local files
- Make both portal and SSH TUI surface those logs

### Phase 5: Docs and First-Run UX

- Add `docs/getting-started-docker.md`
- Add a one-command quickstart
- Add external-DB variant docs
- Add SSH key mount guidance

---

## Risks and Edge Cases

### Two-Process Runtime Confusion

Risk:

- The SSH TUI accidentally starts embedded workers too.

Mitigation:

- hard-force `WORKERS=0` for the SSH launcher
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
