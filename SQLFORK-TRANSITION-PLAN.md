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

**Why fork at all?** To give SQL engineers a concrete place to build and iterate on platform
scenarios **without risking a leak of SQL-specific IP into the public OSS upstream** — e.g. the
internal IcM MCP endpoint/AAD scope (see §5). Work lands internally first; only
deliberately-scrubbed platform enhancements route back upstream.

**Why a separate repo, not a branch of the OSS repo? (TL;DR)** Git visibility is per-**repo**, not
per-branch — a branch of a public repo is public the moment you push it, so any SQL IP on it leaks
instantly. A separate internal repo is the only real privacy boundary; we still track upstream by
adding it as a git **remote** and rebasing (§11).

We diverged from PilotSwarm `main` at `eaabdbf9` (2026-08-08 — the current divergence point,
which advances each rebase). In that window the fork accumulated **two
kinds of value, tangled into the same commits/files:**
- **SQL-specific values that cannot live in an OSS repo** — real internal endpoints, AAD scopes,
  and CI-gate names (the Tier 1 IP in §5) that must stay in an internal overlay.
- **Genuine platform enhancements** — scenarios we built here (durable orchestration, the
  job-generator lifecycle, worker/git-hydration, delegated MCP, …) that are real improvements to
  the platform and belong back **upstream** (§6).

The problem is that these are mixed together, not that the fork exists. Left alone it also
*drifts* — every week upstream moves and the reconciliation cost grows (quantified in the §11
ledger).

We are **not freezing the divergence.** Instead we set up a standing protocol:
- (a) **Constantly rebase** the fork onto upstream so it never drifts — the fork stays a thin,
  current superset of `main` rather than a snapshot that rots (the §11 rebase protocol).
- (b) **Formalize the SQL-specific values into a separate overlay repo** — the same overlay
  pattern `waldemort` uses to carry its environment-specific templates on top of a shared
  platform — so proprietary/SQL config lives in one place instead of tangled through the tree.
- (c) **Route generic platform work upstream** as themed PRs, draining the fork's delta over
  time (§6).

The end state is two repos — a pure-platform core (fork → upstream) and the SQL overlay — kept
aligned by continuous rebase, not a one-time cutover.

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

### 🟡 Tier 2 — Internal names/terminology, no secrets → **genericize in place**
- **`PVS` / "Private Validation Service" / "PVS/Smart Test Selection (git)"** (~40 hits) —
  internal SQL CI-gate names, used only as demo/test fixtures. The gate *mechanism* is
  generic; only the labels are internal.
- **`DsMainDev`** (~8 hits) — internal repo name used as an example `repoAffinity` placeholder.
- **`pssqlwus2acr.azurecr.io`** (1 hit) — a real dev ACR name in a build-arg comment.

Decision: **genericize in place** to keep it public — `PVS`→`ExampleGate`,
`DsMainDev`→`<your-repo>`, drop the real ACR name. (No routing to the overlay needed; these are
labels/fixtures, not IP.)

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

## 10. Execution plan (phased)

This operationalizes §7 (Strategy A) and makes explicit the deployment-continuity model
§7 leaves implicit. The unit of work is a **capability — a logical diff of fork vs upstream** —
never a commit (nothing is cherry-picked).

### Phase 0 — Test-coverage backfill (pre-rebase hardening)
A green suite at the tip is what lets us *verify* each rebase conflict resolution instead of hoping.
Tests don't make git's merge cleaner, but they turn "did my resolution silently break behavior?"
from a gamble into a check — so before we lean on the rebase cadence (§11), close the coverage gap
on the risky diverged commits.

**Scan (as of `eaabdbf9..HEAD`, 2026-09-03):** 146 non-merge diverged commits → 53 already touch a
test, 40 are docs/config only (no test owed), **53 change source but ship no test.** Split by rebase
risk:

- **P1 — 31 commits** touch a known recurring-conflict surface (worker / orchestration / caller-auth
  / MCP / plugin / session / migrations). These repay a test on *every* crank — backfill first.
- **P2 — 22 commits** change source off the hot surfaces (portal/UI, deploy, scripts). Lower rebase
  risk; backfill after P1.

**Rule (no history rewrite — each test commit is a logical deferred amend):** for each flagged
commit, land a **new** characterization-test commit at `HEAD` that pins the behavior and **names the
source commit it covers** via a `Covers:` trailer — *do not* rewrite history to inject the test into
the original commit. It's logically an amend of that commit's missing test, deferred to `HEAD` so we
never rewrite:

```
test: characterize worker poison-forensics logging

Covers: ce429f01
```

The **same backfill commit also ticks that commit's box** in the P1/P2 burndown below (marking it
*Covered*, *Waived*, or *Superseded*), so the checklist and the `Covers:` trailers stay in lockstep
in one atomic change.

Rewriting is more work (authoring against each intermediate state) for the same rebase benefit, and
its only unique payoff (per-commit `git bisect`) isn't worth collecting on a fork we're draining.

**Each flagged commit resolves to exactly one disposition:**
- **Covered** — its behavior lives at `HEAD`; land a `Covers:`-trailered test commit (above).
- **Waived** — the change survives at `HEAD` but has no behavior to characterize (pure rename, label
  drop, diagnostic-logging, comment); record the waiver, no test.
- **Superseded** — the commit's *net effect is gone* at `HEAD` (reverted, removed, or fully rewritten
  by a later fork commit), so there is nothing live to test. A superseded commit still *replays*
  during a rebase and can conflict mechanically, but a test can't protect behavior that isn't at the
  tip — coverage genuinely doesn't apply; safety comes from the green suite at `HEAD`, which correctly
  excludes it. Detection is a triage call — "does this commit's net change survive to `HEAD`?";
  add/remove pairs are the tell.

**Tracking (forward, not by re-scan):** the flagged commits stay flagged in history *by design* — an
old commit like `ce429f01` will always show "source, no test" because its coverage lives in a later
commit; that permanent flag is not unfinished work. So the seed scan below is a **one-time inventory**,
and burndown is measured forward as *flagged − covered*:

```powershell
$covered = git log --format=%B eaabdbf9..HEAD |
  Select-String -Pattern 'Covers:\s*([0-9a-f]{7,40})' -AllMatches |
  ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value }
# remaining = flagged set (seed scan) minus $covered ; Phase 0 done when remaining + waived == flagged
```

**Going-forward invariant:** any new fork-only commit that changes source ships a test in the same
commit (enforce as a fork CI gate — see §12). **Gate:** Phase 0 is done when every flagged commit is
covered (a `Covers:` trailer), waived, or superseded.

Seed the flagged set once:

```powershell
git log --no-merges --format='%H' eaabdbf9..HEAD | ForEach-Object {
  $f = git diff-tree --no-commit-id --name-only -r $_
  if (($f -notmatch '(?i)(\.test\.|\.spec\.|/tests?/|__tests__)') -and ($f -match '(?i)\.(ts|tsx|js|mjs|cjs)$')) {
    git log -1 --format='%h %s' $_
  }
}
```

**P1 burndown (backfill first):**
- [x] `ce429f01` Add always-on diagnostics logging for session poison forensics *(Covered)*
- [x] `736fcc1a` Default worker and orchestration concurrency to a single slot *(Covered)*
- [ ] `d0fbc07f` Make worker dispatcher poll interval configurable
- [ ] `2d34bcb2` fix(caller-auth): deliver delegated tokens via per-session stdio MCP env
- [ ] `10604f23` Case-insensitively override base MCP servers with bound-agent servers
- [x] `8c6b1435` feat(sdk): make per-turn inactivity timeout configurable *(Covered)*
- [ ] `df37f9b5` feat(sdk): surface caller-delegated tokens as named env vars for non-MCP tools
- [ ] `5f5c99bc` feat(repo-worker): auth dnx-launched repo MCP servers against private NuGet feeds
- [ ] `150cb22c` fix(repo-worker): bind repo-shipped .github/agents agents in git workers
- [ ] `5427c861` feat(git-worker): support pinning a session to a non-default git ref
- [ ] `fb729e73` Expose git-workspace state accessors and add hydration demo
- [ ] `36098cd3` worker/portal: derive serviceable-repo allowlist from live worker registry
- [ ] `c305edcd` Remove caller-attached MCP server parameter from orchestration platform
- [ ] `fac08098` Add caller-attached per-session MCP servers
- [ ] `a1352bc8` Route repo-less session turns to a dedicated generic worker pool
- [ ] `2721098a` Persist git-repo-worker enlistment on hostPath to kill cold-start re-clone
- [ ] `3f3e23f8` Make git-repo-worker readiness truthful (Ready == can accept a job)
- [ ] `baa99423` Add delegated MCP access: connect to repo-defined MCP servers as the caller
- [ ] `fa096eed` feat(sdk): add PluginSpec — load external ADO/GitHub plugin repos into the GHCP SDK
- [ ] `767eecbd` feat(sdk): scope git reconcile to session hydration + log acquire->work timing
- [ ] `2fb07251` feat(sdk,portal): repo-affinity routing for git-hydration workers
- [ ] `1140ee5b` Remove unused SDK example scripts from git-repo-worker branch *(likely waive)*
- [ ] `9d665487` worker: add git-repo-worker reconcile-before-job entrypoint
- [ ] `2200b4b3` sdk: add beforeRunTurn worker hook
- [ ] `d9fb7208` feat(worker): unconditionally enable .github config discovery + skill loading
- [ ] `3dd98bbf` refactor(worker): drop sessionWorkingDirectory/enableConfigDiscovery/enableSkills options
- [ ] `9863b9ca` chore: drop CP1/CP1b/CP2 milestone labels from code + comments *(likely waive)*
- [ ] `8f3139d3` refactor: rename cp1-serve-one.mjs -> session-worker.mjs *(likely waive)*
- [ ] `0a148efd` feat(worker): platform-owned session workingDirectory + config discovery
- [ ] `62de590a` diag: log worker-startup defaults + GHCP createSession params *(likely waive)*
- [ ] `184bb8b0` poc(windows-worker): add bounded dependency-load smoke to the bundle *(likely waive)*

**P2 (22)** — enumerate via the scan above; backfill after P1.

### Phase 1 — Live fork, route-as-you-go
- Keep the fork the **active dev branch** for SQL-orchestration concepts upstream doesn't have
  yet; new work lands here first — expected, not a violation. (No hard "freeze".)
- **Classify at authoring** — every change knows its eventual home: **generic platform** →
  upstream (drained later via a theme PR); **SQL-specific** → overlay (or genericize in place).
- **Author upstream-first only when practical** (genuinely generic, no dependency on
  not-yet-upstreamed primitives); everything else is fork-first by necessity.
- Run a **constant rebase** cadence so the fork stays `origin/main + delta`, however that delta churns.
- Keep deploying from the fork for now (single deployable, as today).

### Phase 2 — Carve SQL out behind a plugin seam; the overlay becomes the deployment repo (→ 2 repos)
- Introduce the **plugin seam** in the fork (generic evaluator-plugin loader — the `PluginSpec`
  mechanism). This can land in the fork **now**, ahead of upstreaming it — no upstream dependency.
- Move the **2 Tier-1 files** (`IcmEvaluator` + its test) out of `providers.ts` into the
  **`SQL-AI-Marketplace` overlay** as a plugin.
- **Make the overlay the deployment/integration repo:** it depends on core (fork now, upstream
  later), injects the IcM plugin, and owns the compose→build→ship pipeline.
- **Split the deploy layer:** generic build recipes stay in **core** (to upstream); SQL-specific
  composition + env + infra (core-version pin, IcM injection, ACR/AKS/AFD/PG targeting,
  governance-restricted-subscription overrides) move to the **overlay**.
- Genericize **Tier 2** labels/fixtures in place (`PVS`→`ExampleGate`, `DsMainDev`→placeholder,
  drop the real ACR name).
- **Result:** deployment is now **core (fork) + overlay = 2 repos**, orchestrated *from the
  overlay*; the fork is now a **pure-platform repo** (a precondition for retiring it).

### Phase 3 — Upstream the platform, theme by theme (slow track, external pace)
- Slice the fork-vs-upstream logical diff into the ~8+ capability themes of §6.
- For each theme, in dependency order:
  - Cut a clean PR branch from **current `origin/main`** via **path-scoped assembly** (bring the
    theme's final file state, commit clean) — not a replay of entangled history.
  - Open the PR into `affandar/main` from a GitHub fork of `affandar` (a **contribution remote**,
    never a deploy input).
  - On merge, the next fork rebase **drains** that theme (its commits collapse to no-ops);
    reconcile if upstream modified or independently built it.
- Suggested order (foundation → top): **(3)** orchestration primitives → **(2)** job-generator /
  lifecycle → **(4)** delegated-MCP + seam → **(8)** worker hardening → **(1)** git-hydration fleet
  → **(9)** devbox auth → **(5)** MCP proxy → **(7)** ADO integration → **(6)** portal UI;
  **(10)** reliability / deploy fixes trickle in throughout.
- For any theme too entangled to lift — notably **(3)**, where upstream already added a parallel
  `orchestration_1_0_68/69` — use **Strategy B (clean-room on upstream's version)** instead of lifting.

### Phase 4 — Retire (gated on a behavioral shift, still 2 repos)
- This is **steady-state routing**, not a one-time burndown: new platform work flows in the top,
  merged themes drain out the bottom. "Drive to zero" is reachable only once the *inflow* of
  fork-first platform work slows.
- Delete the fork only when **(a)** the accumulated delta is drained **and (b)** new generic
  platform work has moved **upstream-first**, so nothing fresh keeps landing fork-only.
- Swap the deploy core **fork → upstream**: because the overlay owns the pipeline, this is just
  **repinning the overlay's core dependency**, not moving any build logic.
- Delete `PilotSwarm-SQLFork`; remove this plan doc.

> **Invariant throughout:** deployment is always **exactly 2 repos** — core (`fork`→`upstream`) +
> `overlay` — the overlay owns composition, and "done" means the **fork-vs-upstream logical diff
> is empty**, not "all commits replayed."

## 11. Rebase protocol

The fork tracks upstream by **rebase, not merge** — that's what keeps history linear and the
fork-vs-upstream diff a clean "what we add" delta (a merge buries it under merge commits).
Rebasing rewrites published history, so it runs on a **candidate branch first**, gets validated,
then is swapped in and force-pushed. **The live deployable branch is never rebased in place.**

**Cadence.** Rebase little and often — weekly, and after each upstream theme merges. Frequent
small rebases keep the conflict surface tiny; a long gap lets it balloon (the current +46 gap
already yields ~36 conflicting files, including the `orchestration_1_0_68/69` add/add).

**One-time setup.**
- `git config rerere.enabled true` — records each conflict resolution and auto-reapplies it on
  later rebases (so you resolve the orchestration collision *once*, not every week).

**Branch & tag naming.**  Dates in tag names are the **committer date of the referenced commit**
(`YYYY-MM-DD`), not the day you happened to tag — so each tag is self-describing.
- **Live branch (stable, never renamed):** `feature/aks-git-repo-worker` — force-pushed in place on
  every rebase; all by-name references (overlay core pin, CI, PR policy) point here.
- **Divergence marker (frozen):** tag `upstream-base` = `eaabdbf9`.
- **Candidate branch (ephemeral):** `rebase/onto-<upstreamDate>-<upstreamSha>` — deleted after swap.
- **Per-rebase tags (immutable):** `rebase/from-<forkTipDate>-<forkTipSha>` (rollback point) and
  `rebase/onto-<upstreamDate>-<upstreamSha>` (the upstream tip rebased onto). Consumers needing a
  reproducible deploy pin to the `onto-` tag rather than the moving branch.
- **Baseline (today):** `rebase/from-2026-09-03-2dc49630` (current fork tip) and
  `rebase/onto-2026-08-08-eaabdbf9` (the merge-base this state rests on) — the first row of the
  audit trail, before any upstream rebase.

**Per-rebase steps.**
1. `git fetch origin` — pull the new upstream `main`.
2. Backup the current fork tip for rollback:
   `git tag -a rebase/from-<forkTipDate>-<forkTipSha> feature/aks-git-repo-worker -m "pre-rebase fork tip"`.
3. Cut a candidate branch (or worktree) from the current fork tip:
   `git switch -c rebase/onto-<upstreamDate>-<upstreamSha> feature/aks-git-repo-worker`.
4. Replay the ~140 divergence commits onto the new upstream tip:
   `git rebase origin/main`  (equivalently `git rebase --onto origin/main upstream-base`).
5. Resolve conflicts **by class**:
   - **Theme already upstreamed** → the commit is now redundant; resolve to upstream's version, or
     `git rebase --skip` if fully absorbed (the theme *drains* out and the delta shrinks).
   - **Parallel implementation** (e.g. `orchestration_1_0_68/69`) → adopt upstream's and delete the
     fork's divergent copy — this is the Strategy-B reconcile flagged in Open decisions.
   - **Migration version collision** (both sides define the same `cms-migrations.ts` version `NNNN`
     — *seen on the day-1 crank: upstream `0045 session_canvases` vs. fork `0045 session_git_state_pinning`*)
     → keep both and **renumber the fork's** to follow upstream (the list entry, the SQL function
     name, and its definition). Numbers must stay unique and ordered, so `rerere` can't reliably
     auto-resolve this — the target number shifts each rebase.
   - **Genuine fork-only work** → keep; reapply on top.
   Continue with `git rebase --continue` until the replay completes.
6. **Validate on the candidate — before swapping anything:**
   - build + unit/integration tests green,
   - smoke: bring up worker + portal, run one lifecycle-job E2E,
   - deploy to **non-prod** (overlay pinned at the candidate) and sanity-check.
7. **Swap in** once green. If the live branch gained new commits during validation, rebase those
   few onto the candidate first, then tag the upstream base and force-push the stable branch:
   `git tag -a rebase/onto-<upstreamDate>-<upstreamSha> origin/main -m "upstream base rebased onto"`
   `git switch feature/aks-git-repo-worker && git reset --hard rebase/onto-<upstreamDate>-<upstreamSha>`
   `git push microsoft feature/aks-git-repo-worker --force-with-lease`
   `git push microsoft --tags`.
8. **Re-measure & refresh:** the new merge-base is now `origin/main`, so
   `git diff origin/main...HEAD` reports the *current* delta — update §3's metrics and the diagram.
   (`upstream-base` stays frozen at `eaabdbf9` as the original-divergence marker; advance it only if
   you'd rather the compare link track the shrinking current delta.)
9. Clean up: delete the candidate branch; keep the `from-`/`onto-` tags as the permanent audit trail.

**Rollback.** If validation fails, discard the candidate — the live branch never moved. If a bad
rebase was already pushed, `git reset --hard rebase/from-<forkTipDate>-<forkTipSha>` and force-push.

### Upstream-ahead ledger & rebase-risk

Upstream is **46 commits ahead** of the fork's merge-base (`eaabdbf9..origin/main`, tip
`378adf16`; ~43 non-merge), spanning **2026-08-11 → 2026-09-02**. The ledger is in **replay
order** and **grouped by commit date** — read each day as one daily-cadence rebase increment (the
conflict surface a single day adds). Each row is tagged by **actual file overlap** with the fork's
rewritten SDK core (scan of each commit's changed files). **"Risk" = likelihood of a rebase
conflict, not code quality.** Note: upstream ships real feature work under `release: vX` messages —
these are **not** version bumps (`df15fae4` "v0.5.38" rewrites `session-manager`/`model-providers`/
`cms-migrations`), so a release row is tagged by what it actually touches.

Legend: 🔴 **high** — touches the fork's rewritten SDK core (orchestration / cms-migrations /
session / providers / client / types); 🟡 **medium** — portal / tests / deploy overlap, mostly
mechanical; ⚪ **low** — docs / scripts only, no code overlap. Parenthetical = the hot files hit.

**2026-08-11**
- `df15fae4` 🔴 release v0.5.38 *(session-manager, model-providers, cms-migrations — the day-1 crank hit this)*

**2026-08-12**
- `ca03d6a9` 🔴 release v0.5.39 *(session-manager, session-proxy, protocol, worker)*

**2026-08-13**
- `13f03bd1` 🟡 fix(waf): sync AFD WAF template — DRS exclusions + drsRuleGroupOverrides *(overlay-bound, §10)*

**2026-08-14**
- `921762ed` 🔴 release v0.5.40 *(session-manager, managed-session, cms-migrations, protocol)*
- `96ace632` 🟡 release v0.5.41 — mobile portal fixes

**2026-08-15**
- `ebe26ff5` 🔴 release v0.5.42 — phone keyboard, share links, model switches *(session-proxy)*
- `1906ce59` ⚪ docs(proposals): token ledger — requirements, pool selection, migration
- `63412be9` ⚪ docs(proposals): token ledger — pool choice is a filter
- `7100f869` ⚪ docs(proposals): token ledger — capability guide

**2026-08-24**
- `3784dbd8` 🔴 release v0.5.43 *(orchestration 1.0.68 + `orchestration/*`, session-manager, model-providers — orchestration versioning)*
- `aca52b21` 🟡 release v0.5.44
- `495474c4` 🔴 release v0.5.46 *(session-manager, mcp-loader, cms-migrations, worker)*

**2026-08-25**
- `1906a977` 🔴 portal: readable name picker, selected tab, package download *(http-api-transport)*
- `45974fa4` 🟡 portal: a flat, searchable agent picker
- `992eb5cd` 🟡 portal: selected rows keep their text in every theme
- `21a58968` 🟡 portal: also require a text colour on any selection fill
- `6f31ae9f` 🟡 portal: fold the session detail box, lock touch panning to one axis
- `4e7d7d81` 🟡 portal: stop the WAITING block blinking in the detail box
- `78c69939` 🔴 sdk+portal: an agent's opening instruction is not something you said *(client, session-proxy)*

**2026-08-26**  ← worst cluster: providers + orchestration collide here
- `2220ba4b` 🔴 Add in-place personal provider key updates *(model-providers, cms-migrations, protocol)*
- `a9828db6` 🔴 **sdk: freeze orchestration 1.0.69, open 1.0.70** — add/add vs. fork's `_68/_69`; the defining collision (reconcile per §13)
- `d7aead1f` 🔴 providers: keep apiVersion on a key update *(cms-migrations)*
- `72be73f8` 🔴 providers: keep apiVersion on a key update *(cms-migrations)*
- `ede346e7` 🟡 portal: a failed provider change stops leaving a banner behind
- `bafb3d0c` 🟡 test: cover the Update Key fixes behaviourally
- `43e0cac8` 🟡 test: cover the Update Key fixes behaviourally
- `0da4eb9a` 🟡 portal: a stopped session keeps its reason when folded
- `685d10b6` 🟡 perf(portal): canvas snapshot waits for the selection to settle
- `022337d9` 🟡 fix the e2e suite: 12 failures, one real perf regression

**2026-08-27**
- `8c8c8973` 🔴 release v0.5.47 *(orchestration/queue, cms-migrations, protocol, session-proxy)*
- `d873cbe8` 🔴 release v0.5.48 *(cms-migrations, protocol, http-api-transport, session-proxy)*

**2026-08-28**
- `3a9bb282` 🔴 release v0.5.49 — a provider type that stores no key *(model-providers, session-manager)*
- `76c3601c` 🟡 release v0.5.50 — the WAITING line is one glance again

**2026-08-29**
- `c457cd79` 🟡 release v0.5.51 — Sol Fast, full thinking range, pane badge

**2026-08-30**
- `c7f18e3b` 🔴 release v0.5.52 — sessions stop paying for their own wake-ups *(opens orchestration 1.0.70, session-manager, types)*
- `3e2615c3` 🔴 release v0.5.53 — base-prompt trim, private skills, tokens by agent *(session-manager, cms-migrations, protocol, worker)*

**2026-08-31**
- `6b27e3a0` 🔴 release v0.5.54 — API-created agent sessions get their agent back *(session-proxy)*
- `941e72e6` 🔴 release v0.5.55 — the creation config becomes durable *(client, cms-migrations, cms)*
- `dd6abcf1` 🔴 release v0.5.56 — a resume override becomes field-level *(client)*
- `33f27482` 🟡 test: child-contract input assertion is structural

**2026-09-02**
- `6de39141` 🔴 release v0.5.57 — private facts namespace; portal render fix *(session-manager, session-status, worker, types)*
- `eabec65a` ⚪ docs: two gaps found while building on invocation.facts
- `378adf16` ⚪ scripts: install the CLI from the GitHub release tarballs

**Bottom line — risk is pervasive, not concentrated.** **21 of ~43 commits touch the fork's SDK
core** (🔴), and the two worst surfaces *recur* rather than sit in one place:
- **`cms-migrations.ts` collides in ~12 commits** — the exact migration version-number collision the
  day-1 crank hit (upstream `0045 session_canvases` vs. fork `0045 session_git_state_pinning`). Every
  one needs a renumber (§11 resolve-by-class), and `rerere` can't fully absorb it because the number
  keeps shifting. This is the dominant, repeating cost.
- **Orchestration versioning recurs across three commits** — `3784dbd8` (1.0.68), `a9828db6` (1.0.69),
  `c7f18e3b` (1.0.70) — so the fork's `orchestration_1_0_68/69` collides with upstream's independent
  68/69/70 line more than once; validates the §13 reconcile decision (adopt upstream's line).

The 08-26 cluster (providers + the 1.0.69 freeze) is the single worst day, but SDK-core touches land
on **most** days — which is exactly why the protocol's **little-and-often cadence + `rerere`** matter:
small weekly rebases keep each migration/orchestration collision to one commit's worth, instead of a
144-commit pileup.

> **First-crank finding (2026-09-03).** A dry-run rebase onto day-1 `df15fae4` (isolated worktree)
> replayed 51 fork commits cleanly, then stopped at 52/144 (`fb729e73`) on the `cms-migrations.ts`
> migration-0045 collision above — confirming both that "release" commits carry SDK-core rewrites and
> that migration renumbering is the routine conflict class.

## 12. Definition of done

- [ ] **Phase 0** — test-coverage backfill complete: every flagged diverged commit is covered
      (a backfill test commit with a `Covers:` trailer), waived, or superseded (P1 then P2); fork CI
      gate enforces "source change ⇒ test in same commit" going forward (see §10 Phase 0).
- [ ] Constant rebase cadence established and maintained — fork tracks `origin/main` (keeps the
      delta current and drainable) until retirement.
- [ ] Plugin seam in place; Tier 1 (IcM) extracted to the overlay as a plugin.
- [ ] Overlay owns the compose→build→ship pipeline; deployment = core + overlay (2 repos);
      the fork is a pure-platform repo.
- [ ] Tier 2 genericized in place (Tier 3 is benign — no action; see §5).
- [ ] All §6 platform capabilities landed upstream as organic, themed PRs (Tier 1 excluded):
  - [ ] (1) AKS git-hydration worker fleet
  - [ ] (2) Job Generator framework + durable lifecycle state machine *(IcM evaluator carved out)*
  - [ ] (3) Durable orchestration primitives *(reconcile vs. upstream `orchestration_1_0_68/69`)*
  - [ ] (4) Delegated MCP + caller-auth *(incl. the `PluginSpec` seam)*
  - [ ] (5) In-cluster MCP auth proxy
  - [ ] (6) Portal / observability UI
  - [ ] (7) Generic Azure DevOps integration
  - [ ] (8) Worker platform hardening
  - [ ] (9) Devbox worker auth
  - [ ] (10) Reliability & deploy
- [ ] New generic platform work is authored upstream-first (inflow stopped) and the
      fork's logical diff vs upstream is empty.
- [ ] Deploy core repinned fork → upstream; `PilotSwarm-SQLFork` deleted; this file removed.

## 13. Open decisions

1. **sqlmort timing** — use ADO `SQL-AI-Marketplace` now; cut over to `sqlmort` when ready.
2. **Theme 3 orchestration versioning** — upstream independently added `orchestration_1_0_68/69`,
   so this is a *reconcile two implementations* problem, not an add. Decide per subsystem: adopt
   upstream's version (clean-room, Strategy B) vs. push ours. First conflict every fork rebase
   hits, so decide early. *(The one known Strategy-B candidate; default stays A per §9.)*
3. **Deploy-layer split** — enumerate which `deploy/` files are generic (→ core, upstreamed) vs
   SQL-specific (→ overlay: core-version pin, IcM injection, ACR/AKS/AFD/PG targeting, governance
   overrides). Must be settled before the overlay can own the pipeline (§10 Phase 2).
4. **Rebase cadence** — pin the trigger/frequency (e.g., weekly + on each upstream theme merge).
