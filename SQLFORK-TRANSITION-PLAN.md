# PilotSwarm-SQLFork → Transition Plan

> **Status:** Draft · **Owner:** @andrewkcchung · **Scope:** this fork only
> **This file is a fork-only artifact.** It must not be part of any PR to
> `affandar/PilotSwarm`. Delete it (or move it to the SQL-internal repo) once every
> capability it holds has landed upstream or moved to the SQL-internal repo.

## 1. Purpose

This clone (`C:\src\PilotSwarm`) is effectively **PilotSwarm-SQLFork** — its working
branch pushes to the private mirror, not to the public upstream. It exists so the SQL
team can collaborate on in-flight work without publishing internal IP. **A private fork
is a staging buffer, not a destination.** It must not diverge from upstream for long.

**The repos involved:**

| Role | Repo | URL |
| --- | --- | --- |
| 🌐 Public upstream (platform destination) | `affandar/PilotSwarm` | https://github.com/affandar/PilotSwarm |
| 🔒 Internal staging fork (Entra-governed, private) | `microsoft/PilotSwarm-SQLFork` | https://github.com/microsoft/PilotSwarm-SQLFork |
| 🔒 SQL-internal overlay (short-term IP home) | ADO `Database Systems/SQL-AI-Marketplace` | https://msdata.visualstudio.com/Database%20Systems/_git/SQL-AI-Marketplace |
| 🔒 SQL-internal repo (eventual IP home) | `sqlmort` *(not yet created)* | _TBD — supersedes the ADO overlay_ |

**Fork vs. overlay — two different artifacts.** The **fork** (`microsoft/PilotSwarm-SQLFork`)
is a *complete copy of the entire PilotSwarm codebase* carrying all 142 divergence commits —
platform changes and SQL-specific changes tangled together in the same files. It mirrors
upstream's full tree and is meant to be temporary. The **overlay** (the `SQL-AI-Marketplace`
branch) is *not* a copy of PilotSwarm; it holds **only the SQL-specific pieces** — the thin
slice of proprietary IP that must never go upstream — layered on top of the public platform.
Reconciliation splits the fork's tangled diff into those two homes: platform → organic PR
upstream, SQL-specific → the overlay.

The end state: **every change in this fork is either (a) landed in public PilotSwarm via
an organic PR, or (b) moved to the SQL-internal repo.** Once nothing of value lives only in
the fork, it is deleted. This is capability routing, not a commit-by-commit burndown.

## 2. Goals

1. **Contribute platform / public functionality to PilotSwarm proper** (`affandar/PilotSwarm`).
   Generic runtime primitives (SDK, orchestration, UI, job-generator framework, deploy
   scaffolding, docs) belong upstream, not in a private fork.
2. **Keep SQL-internal concepts / proprietary IP out of the public repo.**
   - **Short term:** ADO [`SQL-AI-Marketplace`](https://msdata.visualstudio.com/Database%20Systems/_git/SQL-AI-Marketplace/branchCompare?baseVersion=GBmain&targetVersion=GBdev%2Fkchung%2Fsql-agent-orchestration-platform-proposal-pilotswarm&_a=files) (existing private overlay).
   - **Eventually:** a GitHub `sqlmort` repo that supersedes the ADO overlay.
3. **Retire the fork.** Once (1) and (2) are complete, `PilotSwarm-SQLFork` has no reason
   to exist and is deleted.

## 3. Current state (as of this draft)

> **Canonical divergence point:** [`eaabdbf9`](https://github.com/affandar/PilotSwarm/commit/eaabdbf9dbf5801b77ac9eef7cd36d2e6baa41c0)
> on `affandar/PilotSwarm`. This is the merge-base between this fork and upstream
> `main` — the divergence compare is measured against it (`git diff eaabdbf9...HEAD`,
> equivalently `origin/main...HEAD` since `eaabdbf9` is the merge-base).


| Ref | Tip (code) | Ahead of `origin/main` | Visibility |
| --- | --- | :---: | --- |
| local `feature/aks-git-repo-worker` | `b22d93a3` | 142† | — |
| `origin` = `affandar/PilotSwarm` `main` | `378adf16` | — | 🌐 public upstream |
| `microsoft` = `microsoft/PilotSwarm-SQLFork` | `b22d93a3` | 142† | 🔒 internal org staging |

> † `b22d93a3` is the **code tip** = **142** divergence commits (the routable scope). The branch
> HEAD sits one commit higher — this fork-only plan-doc commit — so `microsoft` shows **143 ahead**.

```
   🌐 affandar/PilotSwarm   (upstream · main = the continuous horizontal trunk)

   …──o──o──o──●──o──o──o──o──o── … ──o──►   378adf16   ← main today (+46 commits past the fork)
               │
               eaabdbf9   ← fork point / merge-base (pinned as upstream-base)
               │
               └──o──o──o──o── … ──o──►   b22d93a3   ← feature/aks-git-repo-worker (code tip)   🔒 microsoft
                     our fork: +142 commits              (branch HEAD = +this plan-doc commit → 143)
```

- Diverged from `main` at merge-base **`eaabdbf9`**; `main` has since advanced **46 commits**.

- The code divergence (`git diff origin/main...b22d93a3`) = **237 files / +59,595 / −3,494 / 142 commits**.
  This is the scope to route — each capability lands upstream or moves internal, not a
  commit-by-commit burndown.
- **All 142** commits are internal-only on `microsoft`; upstream `affandar` carries no
  divergent refs.
- **Browse the full divergence diff:**
  [`upstream-base...feature/aks-git-repo-worker`](https://github.com/microsoft/PilotSwarm-SQLFork/compare/upstream-base...feature/aks-git-repo-worker)
  on the internal `microsoft/PilotSwarm-SQLFork` staging repo. `upstream-base` is a
  frozen ref pinned at the divergence point **`eaabdbf9`**, so the compare reads as
  **143 ahead / 0 behind** (= the 142 divergence commits **plus** this plan-doc commit) —
  purely what the fork added, no upstream-only noise.
- **Browse the SQL-specific overlay:**
  [`main...dev/kchung/…-pilotswarm`](https://msdata.visualstudio.com/Database%20Systems/_git/SQL-AI-Marketplace/branchCompare?baseVersion=GBmain&targetVersion=GBdev%2Fkchung%2Fsql-agent-orchestration-platform-proposal-pilotswarm&_a=files)
  on the ADO `SQL-AI-Marketplace` repo — the internal overlay holding the SQL-specific pieces
  (the "move it internal" destination; `sqlmort` eventually).

### Remotes

```
origin     https://github.com/affandar/PilotSwarm.git               (public upstream — rebase source)
microsoft  https://github.com/microsoft/PilotSwarm-SQLFork.git       (internal org staging — Entra-governed, private)
```

## 4. The core problem

We diverged from PilotSwarm `main` several weeks ago and, in that window, **mixed platform
concerns and SQL-specific concerns in the same commits/files.** The longer the fork lives,
the harder the eventual reconciliation. We need to (a) freeze the divergence, (b) separate
the two concerns cleanly, and (c) route each to its correct home.

## 5. IP classification (what goes upstream vs. internal)

This is the routing map: which parts of the divergence are proprietary (→ overlay /
SQL-internal repo) and which are generic platform work (→ upstream PR). Three tiers.

### 🔴 Tier 1 — Real internal coupling → **SQL-internal repo (do NOT publish)**
Only **2 files** carry a hard internal coupling (live internal endpoint + AAD app scope):
- `packages/job-generator/src/providers.ts` — `IcmEvaluator`,
  `ICM_MCP_ENDPOINT = "https://icm-mcp-prod.azure-api.net/v1/"`,
  `ICM_MCP_SCOPE = "api://icmmcpapi-prod/.default"`
- `packages/job-generator/test/providers.test.mjs` — tests asserting the above

The generic `ado_wiql` and `kusto` evaluators in the same file are **public** — carve IcM
out behind the plugin-loader seam; ship the rest upstream.

### 🟡 Tier 2 — Internal names/terminology, no secrets → **genericize in place, or move fixtures**
- **`PVS` / "Private Validation Service" / "PVS/Smart Test Selection (git)"** (~40 hits) —
  internal SQL CI-gate names, used only as demo/test fixtures. The gate *mechanism* is
  generic; only the labels are internal.
- **`DsMainDev`** (~8 hits) — internal repo name used as an example `repoAffinity` placeholder.
- **`pssqlwus2acr.azurecr.io`** (1 hit) — a real dev ACR name in a build-arg comment.

Decision per item: genericize (e.g. `PVS`→`ExampleGate`, `DsMainDev`→`<your-repo>`, drop the
real ACR name) to keep it public, **or** route the fixture to the SQL-internal repo.

### 🟢 Tier 3 — Benign, stays public (verified, no action)
- All `kusto.windows.net` → public `help.kusto.windows.net` sample cluster
- Generic `api://` (`AzureADTokenExchange`, `api://<app-id>`/fake-GUID placeholders)
- `secret`/`pat` hits → env-var reads + `"test-pat"` fixtures (no real secrets)
- `dev.azure.com` / `.visualstudio.com` → generic host-parsing + `example`/`Contoso`/`<org>`
  placeholders; `package-lock.json` hits are the public `1es-public` npm feed

**Bottom line:** of 237 files, **exactly 2** contain true proprietary IP. The fork is
overwhelmingly generic platform work that belongs upstream.

## 6. Platform contributions (upstream themes)

The functionality below is generic PilotSwarm runtime (no SQL specificity) and is the
substance of what this fork contributes back to `affandar/PilotSwarm`. Listed as themes,
not commits.

1. **AKS git-hydration worker fleet** — git-repo-worker DaemonSets + a node-local git-cache
   mirror, hostPath enlistment persistence (kills cold-start re-clone), workspace
   dehydrate/hydrate, repo-affinity routing, per-session ref pinning, and OS-split
   (Linux/Windows) fleets with truthful readiness.
2. **Job Generator framework + durable lifecycle state machine** — the generic job-generator
   (registration, hierarchy, lifecycle API resources, continuous materialization, durable
   state execution, canonical cross-source state references, E2E harness). *The IcM source
   evaluator is the one piece carved out to the SQL-internal repo.*
3. **Durable orchestration primitives** — keyed system waits, observed-condition waits,
   external-operation gates, durable response persistence, versioned orchestration snapshots,
   and bootstrap-turn folding.
4. **Delegated MCP + caller-auth** — connect to repo-defined MCP servers *as the caller*,
   per-audience token map with runtime audience discovery, fleet-default and caller-attached
   MCP servers, delegated tokens surfaced as env vars, external plugin-repo loading
   (PluginSpec), and JSONC `mcp.json` parsing.
5. **In-cluster MCP auth proxy** — delegated-only auth proxy with a pluggable upstream adapter
   (Kusto reference adapter, using the public sample cluster).
6. **Portal / observability UI** — durable job-transition timelines, worker-utilization
   visualization, live swimlane spans, queued bands, per-condition PR-gate rows, tree keyboard
   navigation, repo picker, and "load older" history hydration.
7. **Generic Azure DevOps integration** — observe ADO PR approval/completion, heterogeneous
   approval conditions on the PR gate, and an ADO provider mode for lifecycle jobs.
8. **Worker platform hardening** — `beforeRunTurn` hook, platform-owned working directory +
   config/skill discovery, repo-less session pool routing, worker-registry host/build
   provenance, owner-affinity scheduling, and owner-managed logical cleanup.
9. **Devbox worker auth** — silent caller-token refresh, canonical worker identity across
   restarts, Azure CLI baked into the Windows base for popup-free auth, and signed-in
   Copilot-user model access.
10. **Reliability & deploy** — Postgres pool self-heal, duroxide pool/acquire resiliency,
    jittered retry backoff, orchestration lease/timeout tuning, session-poison diagnostics,
    blob/DB managed-identity decoupling, WAF fixes, and governance-restricted-subscription
    deploy overrides.

## 7. Strategy A — Reconcile the existing fork (default)

Route the fork's work to its homes: contribute the generic platform work upstream as organic,
themed PRs, and move the one piece of real IP to the SQL-internal repo. When nothing of value
lives only in the fork, delete it. (Not a commit-by-commit burndown — the unit is a capability,
not a commit.)

1. **Freeze divergence.** No new feature work lands only in the fork; new platform work goes
   through upstream PRs from here on.
2. **Upstream the platform work as organic, themed PRs** (everything in §6 except Tier 1):
   - Group by theme (§6): git-hydration/worker, job-generator framework, orchestration
     versioning, UI timeline, SDK auth/lifecycle, deploy, etc. Each theme is one reviewable PR.
   - Cut each PR from current `origin/main` (46 commits ahead). Prefer **path-scoped assembly**
     — bring over the theme's final file state and commit it clean — over replaying the
     entangled per-commit history; reserve commit-by-commit replay for the few themes whose
     history is already tight. Stack dependent PRs (foundation → features → UI/deploy).
   - Scrub Tier 2 terms as each PR is prepared.
3. **Extract Tier 1 (IcM) to the SQL-internal repo.** Carve `IcmEvaluator` out of
   `providers.ts` into the overlay (`SQL-AI-Marketplace` now, `sqlmort` later) behind a
   generic evaluator-plugin seam upstream. Remove it from the fork branch.
4. **Resolve DELETE items** (anything experimental we don't want to publish or keep) — none
   identified yet; flag as found.
5. **Retire.** Once every §6 capability has landed upstream or moved internal — so the fork
   holds nothing not already in one of those homes — delete `PilotSwarm-SQLFork`.

**Pros:** reuses the actual working, tested code (least rework); the scan shows the IP surface
is tiny (2 files), so this is low-risk. **Cons:** the PRs are large and entangled with weeks of
mixed commits; rebasing onto a moved `main` (46 commits) has conflict cost.

## 8. Strategy B — Clean-room reimplementation (alternative)

Treat the fork as a **reference/spec**, not a source of commits. Pick the specific
functionality we actually want, and reimplement it directly against current `origin/main`
(and the SQL-internal repo), without carrying the divergent history.

1. Enumerate the capabilities worth keeping (git-repo worker, job-generator lifecycle,
   orchestration versioning, worker timeline, caller-auth, etc.).
2. For each, write fresh commits on a branch cut from `origin/main`, using the fork only as a
   design reference. Land as clean, themed PRs.
3. Put SQL-specific pieces straight into `SQL-AI-Marketplace`/`sqlmort` — never in the fork.
4. Delete the fork once the target capabilities exist upstream + internal.

**Pros:** no messy rebase; clean separation of concerns from the start; no risk of dragging
internal fixtures upstream by accident. **Cons:** discards working, tested code; higher
implementation effort; risk of behavioral drift from what already works.

## 9. Recommendation

Given the scan result — **only 2 files carry real IP and the rest is clean generic
platform work** — **Strategy A (reconcile) is the default.** Reserve **Strategy B** for any
capability whose commits are too entangled with SQL-specific concerns to cleanly split; those
few, reimplement clean rather than untangle.

## 10. Definition of done

- [ ] All §6 platform capabilities landed upstream as organic, themed PRs (Tier 1 excluded).
- [ ] Tier 1 (IcM) extracted to SQL-internal repo behind a generic plugin seam.
- [ ] Tier 2 genericized or routed; Tier 3 confirmed benign (done).
- [ ] The fork holds nothing of value not already landed upstream or moved to the SQL-internal repo.
- [ ] `PilotSwarm-SQLFork` deleted; this file removed.

## 11. Open decisions

1. **Tier 2 disposition** — genericize in place (stay public) vs move fixtures to the
   SQL-internal repo, per item (PVS, DsMainDev, ACR name).
2. **Strategy A vs B per workstream** — default A; list any capability to do clean-room.
3. **sqlmort timing** — use ADO `SQL-AI-Marketplace` now; cut over to `sqlmort` when ready.
