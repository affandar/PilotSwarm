# Agent Packages — User-Uploadable, Versioned Agent Distribution

> **Status:** Proposal — design reviewed, decisions recorded
> **Date:** 2026-07-29
> **Scope:** a registry of user-uploadable agent packages (agents, skills, MCP servers, and real tool code) pulled from GitHub/ADO/URL/local folders, normalized into the artifact store, versioned by semver, installed dynamically by workers and the portal, with a portal Admin workspace and MCP management surface.

## Summary

Users bring their own agents at runtime. A **package** is a plugin directory (the canonical folder/loader contract from [plugin-packaging-and-distribution](./plugin-packaging-and-distribution.md)) plus, for the first time, **code**: a `tools/worker-module.js` and stdio MCP server sources. Packages are registered from four source kinds — GitHub, Azure DevOps, a tarball URL, or a local folder — and every source normalizes through one pipeline: **validate → canonical tar.gz → artifact store under a reserved identity → registry row**. Identity is `name@semver`; the sha256 is a verifier, not the identity. Scopes are **shared** and **user** — visibility, not security: this is a trusted system. Workers install packages at startup (before the plugin loader runs) and converge on changes via a registry-epoch poll, no restarts. The Admin console becomes a portal-shaped workspace: settings tree → package detail → package file tree → file preview.

## Relationship to prior proposals

- [app-manifest-and-image-deploy](./app-manifest-and-image-deploy.md) stands, unchanged, as the delivery path for the **operator's app**: system binaries, apt packages, heavyweight deps, the baked plugin at `/app/plugin`. Its rationale ("config and code travel together") is right for the app layer — and structurally cannot serve this feature: users adding agents at runtime cannot trigger fleet image rollouts. Agent packages are a second layer on top: anything that is markdown, JSON, or plain JS ships as a package; anything needing a compiler or root ships in the image.
- [plugin-packaging-and-distribution](./plugin-packaging-and-distribution.md)'s folder layout and loader contract remain canonical and are what a package contains. Its distribution half (PG `bytea` registry, worker rosters, session pinning) is **not** revived — storage moves to the artifact store, and session binding stays relaxed (below).
- [dynamic-tool-loading](./dynamic-tool-loading.md) (skill-triggered lazy tool enablement) is orthogonal and composes: it gates which registered tools a session sees; this proposal changes which tools get registered.

## The package

```
my-agents/                        # any repo path, any ref — or a local folder
├── plugin.json                   # REQUIRED: name (DNS label) + version (concrete semver)
├── agents/*.agent.md             # existing format incl. tools/skills/mcpServers frontmatter
├── skills/<name>/SKILL.md        # + optional tools.json
├── .mcp.json                     # MCP catalog entries; stdio commands may point into the package
├── mcp-servers/**                # stdio MCP server sources, spawned by the Copilot CLI
└── tools/worker-module.js        # export default { createTools({workerNodeId}) => [defineTool…] }
                                  # — the existing --worker module contract, now inside a package
```

`agents/`, `skills/`, `.mcp.json` load through the existing tiers untouched. `tools/worker-module.js` is the exact contract `embedded-workers.js` dynamic-imports for `--plugin/--worker` local apps and the image-deploy proposal specified for `/app/tools/*/worker-module.js` — this proposal extends that discovery to unpacked package dirs.

Validation (applied identically to every source at registration time):

- `plugin.json` parses; `name` is a DNS label; `version` is a concrete semver.
- Every `.agent.md` and `SKILL.md` parses; `.mcp.json` schema-checks; `tools/worker-module.js` passes `node --check`.
- No symlinks; size cap 16 MB compressed (a "vendored node_modules?" warning above 2 MB).
- Rejected: `system: true` agents (background system agents remain the baked app's domain), an agent named `default`, agent names colliding with baked agents, package names already taken (names are globally unique across both scopes — they key the artifact path).

Dependencies: v1 packages must be dependency-free or vendor `node_modules` inside `tools/`. No `npm install` at install time (workers may lack egress; see Open Questions).

## Identity and versioning

**`name@semver` is the identity.** `(name, semver)` is unique in the registry; the UI leads with the semver; workers cache unpacked packages by it.

**Published versions are immutable.** Re-registering content that hashes identically to an existing `(name, semver)` is a no-op ("already up to date"). Different content under an existing semver is **rejected** — there is no `--replace`. The dev loop uses prerelease semvers (`1.4.1-dev.3`); CI bumps properly.

The tarball's sha256 is stored on the version row and used two ways: no-op elision at registration, and download verification on workers (mismatch = quarantine the version on that worker, report via worker state, never load). Provenance rides alongside: source kind, repo/ref/path, resolved commit SHA for github/ado, uploader identity for uploads.

An `active_version_id` pointer per package selects what the fleet runs. **Pin** moves it to any retained version; that is also rollback. Old versions are retained (GC deferred; see Open Questions).

## Storage: everything normalizes to the artifact store

All four source kinds converge on the same bytes in the same place:

```
artifact://agent-packages/<name>@<semver>.tar.gz
```

Mechanically: artifacts are keyed `(sessionId, filename)` (`blob-store.ts` `artifacts/${sessionId}/${filename}`), so packages live under a **reserved well-known identity** — a deterministic UUID derived from the slug `agent-packages` via the same scheme system agents use (`agent-loader.ts` `systemAgentUUID`). The artifact layer already computes and persists sha256 on every write, so the verifier comes free; both `SessionBlobStore` (Azure) and `FilesystemArtifactStore` (local) serve the scheme, and workers already construct the blob store for session snapshots — downloads reuse existing plumbing. No PG `bytea`, no new blob path.

The CMS registry holds **metadata only**:

```sql
agent_sources           id, kind(github|ado|url|upload), repo_url, ref, path, url,
                        auth_token TEXT,        -- write-only column; status procs return a boolean,
                                                -- raw read is an internal-only proc — the exact
                                                -- posture of users.github_copilot_key (migration 0010)
                        auto_sync, last_sync_at/status/error, created_by, created_at

agent_packages          id, source_id NULL, name UNIQUE, scope(shared|user), owner_user_id,
                        enabled, active_version_id, created_at

agent_package_versions  id, package_id, semver, sha256, size_bytes, artifact_filename,
                        commit_sha NULL, manifest JSONB,   -- parsed agents/skills/tools/mcp snapshot
                        created_at, created_by,
                        UNIQUE (package_id, semver)

agent_registry          singleton row: epoch BIGINT        -- bumped by every mutating proc

agent_worker_state      worker_node_id PK, epoch, installed JSONB,  -- {name: {semver, status, error}}
                        updated_at                          -- fleet truth; the heartbeat channel the
                                                            -- image-deploy proposal left as an open question
```

Migrations follow the 0029/0036 `steps` shape (next CMS version: 0038), all access via stored procs, companion `NNNN_diff.md`.

## Scopes and permissions — visibility, not security

- **shared** — every user sees and can create sessions from its agents.
- **user** — only the owner sees it in catalogs and pickers; only the owner's sessions resolve its agents.

Any authenticated user, admin or not, uploads at either scope. **Promote** (user→shared) and **demote** (shared→user, by its owner) flip the scope column and bump the epoch; because agents resolve at turn time against the current catalog, running agents are never impacted by a scope flip. Update/delete/sync/pin: **creator or admin**; admins have full CRUD on everything. Baked app agents (from the image's plugin dirs) surface **read-only** in the admin tree and catalogs with a built-in badge — they are not registry rows.

This is explicitly a **trusted system**: package code executes in the worker process with the worker's credentials, and stdio MCP servers run as child processes of the shared Copilot CLI. The shared/user split is an organizational boundary. Sandboxing, approval flows, and signing are a later, separate track — designing them now is a non-goal. (One hygiene note for implementation: `.mcp.json` `${VAR}` expansion reads worker `process.env` at load time; package-supplied configs should expand against a documented allowlist rather than the full environment.)

## Worker installation

**Startup (cold pod).** The entrypoint (`packages/sdk/examples/worker.js`) gains a pre-step *before* constructing the worker: read the enabled package set from the CMS, download any `name@semver` not in the local cache (`/home/node/.copilot/agent-packages/<name>@<semver>/` — inside the existing writable emptyDir), verify sha256, unpack, then append those dirs to `pluginDirs`. This ordering matters: `_loadPlugins()` is synchronous in the `PilotSwarmWorker` constructor (`worker.ts:235`), so pre-fetching in the entrypoint reuses the entire existing loader byte-for-byte — zero loader changes on the cold path. After construction, the entrypoint discovers `tools/worker-module.js` in each unpacked package, imports it, and calls `worker.registerTools(...)` (public, re-callable — `worker.ts:303`). Spot-node eviction is fine: the cache is rebuildable by design.

**Refresh.** A 15–30 s epoch poll (single-row SELECT), patterned on the existing 30 s `model_providers.json` mtime reloader (`worker.ts:274` — the one hot-reload precedent in the worker). Epoch changed → diff manifest vs installed → fetch/verify/unpack missing versions → rebuild the app-tier agent/skill/MCP maps and the dynamic tool registry (ESM cache-busted imports, `worker-module.js?v=<semver>`) → upsert `agent_worker_state`. Admin actions converge fleet-wide within one poll interval, no restarts.

**What applies when** (the codebase is cooperative here):

| Change | New sessions | Already-running sessions |
|---|---|---|
| Agent prompts, skills | immediately | **next turn** — prompt lookup is already a per-turn deferred read (`session-manager.ts` `_buildLastInstructionsSection`) |
| Tool handlers (same names) | immediately | next turn — `registerTools` re-runs every turn |
| New tool declarations | immediately | on rebind/rehydrate — declarations reach the CLI only at cold create/resume (`sessionConfig.tools`, `session-manager.ts:1221`) |
| `.mcp.json` catalog | immediately | on rebind — the Copilot CLI spawns MCP servers from session config |
| Package disable/delete | agents leave the catalog | live sessions fail agent resolution next turn — the UX shows live-session impact before confirming |

**Session binding stays relaxed** (the image-deploy stance): sessions resolve the active version at each turn; each turn stamps `packageName`/`packageVersion` into session events — which finally makes the existing `plugin_name`/`plugin_version` columns in the skill-usage procs truthful. Strict per-session pinning (`unsatisfiable_plugins` machinery) stays deferred.

**Catalog and resolution.** Workers load all enabled packages (they serve every user); user-scope visibility is enforced at the catalog and resolution level, not load level: `listCreatableAgents` becomes union(baked read-only, registry manifests) tagged `{scope, ownerUserId, package, semver}` and filtered per caller in the portal runtime (where auth context lives); `createSessionForAgent` and `resolveAgentConfig` check user-scope agents against the session owner. Package name doubles as the agent namespace (the loader's existing `namespace` + `ns:name` qualified lookup), so cross-package short-name collisions stay resolvable.

The portal runs the same installer library for its own catalog (fixing today's drift, where the portal re-reads its own baked plugin dirs — `node-sdk-transport.js:611-624`) and to serve the package workspace. The deployed `pilotswarm-mcp` component is a stateless proxy over `/api/v1` and inherits everything with zero changes.

## Portal UX

Mockups (portal tokens, reviewed): the Admin console becomes a **workspace with the portal's pane grammar** instead of the flat panel:

```
Settings            │ Package: incident-kit [shared]      │ Workspace · incident-kit@1.4.0
├ GitHub Keys       │ v1.4.0 · sha a1b2c3d ✓ · fleet 3/3  │ ├ plugin.json
└ Agents            │ source · artifact · synced 2h       │ ├ agents/incident-triager.agent.md ◀
  ├ Shared          │ agents: incident-triager, log-corr… │ ├ skills/postgres-ops/SKILL.md
  │ ├ incident-kit ◀│ versions: 1.4.0 ● | 1.3.2 Pin | …   │ ├ tools/  └ .mcp.json
  │ └ db-analyst-pk │ [Sync] [Demote] [Rename] [Delete]   ├────────────────────────────────
  └ User            │                                     │ Preview: rendered frontmatter + md
    └ hn-scraper    │                                     │
```

- **Settings tree** (session-list slot): GitHub Keys (existing panel relocates here); Agents ▸ Shared ▸ User listing packages with scope badges and semvers; baked agents read-only with a built-in badge; "+ Add package" at the bottom. Non-admins see Shared plus their own User packages.
- **Package detail** (chat slot): description, metadata (semver-led; sha as quiet verifier; source; artifact ref; synced; fleet adoption from `agent_worker_state`), contained agents, version history with **Pin**, actions (Sync now / Promote-or-Demote / Rename / Delete) gated creator-or-admin.
- **Package workspace** (inspector slot): the full untarred file tree, folders expanding on click; **file preview** below it (activity-viewer slot) — `.agent.md`/`SKILL.md` render frontmatter as a table plus formatted markdown, JSON/JS syntax-styled. Served by two new ops that untar from the artifact store into a portal tmp cache: `getAgentPackageTree(name, semver)` / `getAgentPackageFile(name, semver, path)`.
- **Add package dialog**: four tabs (GitHub / Azure DevOps / URL / Upload folder), ref+path fields, write-only token field, Shared/User scope radio, "Validate & register".
- **Create Session picker**: headed groups **Shared** and **My agents** plus the Generic row — the non-clickable heading rows (`rowItemIndexes`) the model picker already uses; details pane gains package, semver, scope. Baked creatable agents appear under Shared with a built-in label.
- Every new section gets its TUI lines-builder twin in `components.js` — admin surfaces render in both hosts off one selector.

## API and MCP surface

New rows in the `OPERATIONS` table (`protocol.js`) + cases in `runtime.call()`; owner checks live in the runtime dispatcher, `admin` bypass via the existing role:

```
listAgentPackages            GET    /agent-packages                      authed
getAgentPackage              GET    /agent-packages/:name                authed
getAgentPackageTree          GET    /agent-packages/:name/:semver/tree   authed
getAgentPackageFile          GET    /agent-packages/:name/:semver/file   authed (path param)
registerAgentSource          POST   /agent-packages/sources              authed
syncAgentSource              POST   /agent-packages/sources/:id/sync     authed (owner|admin)
uploadAgentPackage           POST   /agent-packages/upload               authed (base64 tar.gz)
setAgentPackageScope         PUT    /agent-packages/:name/scope          authed (owner|admin)
pinAgentPackageVersion       PUT    /agent-packages/:name/active         authed (owner|admin)
deleteAgentPackage           DELETE /agent-packages/:name                authed (owner|admin)
```

The fleet MCP server (`packages/app/mcp`) mirrors these 1:1 as management tools — `list_agent_packages`, `get_agent_package`, `get_agent_package_file`, `push_agent_package`, `sync_agent_source`, `promote_agent_package` / `demote_agent_package`, `pin_agent_package_version`, `delete_agent_package` — registered behind a config flag (`--agent-mgmt off|read|full`, default `full`) so deployments can run the surface read-only or disabled. `push_agent_package` takes base64 tar.gz bounded by the **2 MB JSON envelope** (decided); larger packages register via URL/repo sources or the CLI.

## CLI

```
pilotswarm agents validate ./my-agents          # local-only: full registration validation
pilotswarm agents push ./my-agents --shared     # validate → tar → upload → register (--user default)
pilotswarm agents list | show <name> | rm <name>
pilotswarm agents pin <name>@<semver>
```

`push` works in both modes: `--api-url` rides the upload op (base64 ≤ 2 MB; a streaming multipart op is the follow-up for larger), `--store` streams via the artifact store directly (the existing `fromFile` path).

## Non-goals

- **Security/sandboxing** — trusted system, by decision. No approval flows, no signing, no isolation in v1.
- **`npm install` at install time** — packages vendor deps or go dependency-free.
- **Strict per-session version pinning** — relaxed binding, versions stamped for audit.
- **Marketplace/federation, in-portal authoring** — the repo (or folder) is the editor.
- **A system scope** — background/system agents and heavyweight deps remain the baked app image's domain.

## Phasing (each independently shippable)

1. **Registry + normalization + CLI + startup install** — migrations 0038+, the four source kinds funneling to the reserved artifact identity, `pilotswarm agents push/validate`, entrypoint pre-fetch + `tools/worker-module.js` discovery. Packages apply on pod restart. End-to-end usable.
2. **Portal** — API ops, Admin workspace (tree/detail/workspace/preview, TUI parity), grouped create picker, catalog union with scope filtering.
3. **Hot refresh + fleet truth** — epoch poll, in-place map swap, `agent_worker_state` heartbeat, fleet adoption in the detail pane.
4. **MCP management surface** — the tool set + config flag; promote/demote/pin polish.

## Test plan

Layers map onto the existing suites: `packages/sdk/test/unit/*.test.mjs` (node:test, no infra), `packages/sdk/test/local/*.test.js` (local PG + `FakeCopilotSession` scripted-turn harness, `local-workers`/`worker-process`/`kill-harness` helpers), `packages/app/ui/core/test/*.test.mjs`, and the MCP workspace suites (`test:mcp`, `test:mcp:integration`).

### 1. Validation + packing (unit) — phase 1

- **Validation matrix**, one case per rule: bad/missing DNS name, non-semver or ranged `version`, unparseable `.agent.md`/`SKILL.md`/`.mcp.json`, `tools/worker-module.js` failing `node --check`, symlink, > 16 MB, `system: true`, agent named `default`, baked-name collision, taken package name. Each asserts the exact user-facing message — these errors are UX.
- **Canonical tarball determinism**: same folder packed twice (and with shuffled directory enumeration, differing mtimes/modes) → byte-identical tar.gz → same sha256. This property carries no-op elision; it gets its own test, not an incidental assertion.
- **Semver policy**: identical content re-registered → no-op, no new row, no epoch bump; different content under an existing semver → rejected; prerelease versions order correctly in history.
- **Manifest snapshot**: extracted agents/skills/tools/mcp entries match fixture packages (extend `test/fixtures`).
- **Reserved identity**: the `agent-packages` UUID derivation is stable (same pattern as the existing `systemAgentUUID` tests).

### 2. Registry + migrations (local, PG) — phase 1

- Migration 0038+ passes the `cms-migrations-shape` / `pg-migrator` idempotency patterns (steps run twice cleanly).
- Proc behavior: register/list/get, scope flip, pin, delete; `UNIQUE (package_id, semver)`; **every mutating proc bumps the epoch** (asserted as a sweep over all of them, so a future proc can't forget).
- Token posture: status proc returns only a boolean; the raw-read proc is absent from the public API surface (mirror the `users.github_copilot_key` tests).
- `agent_worker_state` upsert semantics.
- Authz at the runtime dispatcher: owner/non-owner/admin matrix for every mutating op; user-scope packages invisible to non-owners in every listing op.

### 3. Source fetchers (unit + local HTTP fixture server) — phase 1

- GitHub/ADO/URL fetchers against a local fixture server: ref → commit resolution, tarball/zip download, subdir extraction, auth header injection; error taxonomy (404, 401, truncated archive, not-a-tar) lands as `last_sync_error`, not a throw that kills the portal.
- Same-commit and same-hash re-sync are no-ops (assert zero artifact writes via a counting stub).

### 4. Worker install + hot-swap (local, FakeCopilotSession) — phases 1 & 3

- **Cold start**: enabled packages fetched, sha-verified, unpacked, loaded; a scripted turn on a package agent gets the package prompt, eager skill block, and can call a `worker-module.js` tool end-to-end.
- **Quarantine**: corrupted tarball (sha mismatch) and a worker-module that throws on import each quarantine that package only — worker boots, other packages load, `agent_worker_state` reports the error.
- **Cache reuse**: restart with a warm cache performs zero downloads (counting stub on the artifact store).
- **Epoch refresh**: bump → convergence within one poll; new agent creatable without restart.
- **Hot-swap semantics table, asserted row by row**: prompt/skill edits reach a *running* session on its next turn; a swapped handler dispatches next turn; a *new* tool declaration is invisible to a warm session but present on cold create/resume — extend `inline-control-tools.test.js`, which already guards exactly this two-sided contract. `contracts.test.js` `EXPECTED_LLM_VISIBLE_TOOL_NAMES` stays untouched for generic sessions (package tools ride agent frontmatter only).
- **Relaxed binding**: turn events carry `packageName`/`packageVersion`; pin/rollback changes what the *next* turn resolves; scope flip mid-session doesn't disturb the session.
- **Chaos** (`kill-harness`): worker killed mid-install → restart re-fetches cleanly (partial unpack never half-loads: tmp-dir + atomic rename).

### 5. Portal API + workspace ops — phase 2

- Per-op authz matrix through the generated router (the `api-browser-safety` pattern); upload op round-trips base64 and rejects > 2 MB envelope.
- `getAgentPackageFile` path jail: `../`, absolute paths, and symlink escapes all refused (reuse the artifact `fromFile` jail tests as the template).
- Catalog union: baked agents present read-only with the built-in tag; user-scope entries filtered by caller; `listCreatableAgents` in the picker path reflects a registry change without portal restart.

### 6. UI core selectors (ui/core test suite) — phase 2

- Picker selector emits heading rows via `rowItemIndexes` (Shared / My agents / generic) and the package/semver/scope detail fields.
- Admin tree selector: grouping, badges, action visibility (owner vs admin vs other).
- Workspace selectors: tree expand/collapse state, preview formatting dispatch by file type.
- **TUI parity**: every new admin section has its lines-builder twin asserted (the both-hosts gotcha — a section without one silently doesn't exist in the TUI).

### 7. MCP + CLI — phases 1 & 4

- MCP: tool registration honors `--agent-mgmt off|read|full`; `push_agent_package` envelope bound; each tool proxies to its op (existing MCP proxy-test pattern).
- CLI: `validate` reproduces the full validation matrix locally with identical messages; `push` in direct-store and `--api-url` modes; `list/show/pin/rm` against a temp deployment.

### 8. End-to-end smoke (`test:local:smoke`) — ship gate

One scripted loop: `push` a fixture package → appears in catalog → create session for its agent → scripted turn uses the package tool + preloaded skill → `pin` back one version → next turn carries the old prompt → `delete` with the session live → next turn surfaces the clear resolution error. Phase N ships when its groups above are green; the smoke loop gates every phase.

## Open questions

- **ADO auth** — PAT per source (symmetric with GitHub) vs. Entra service identity for ADO fetches. Default: PAT; revisit when an ADO-heavy deployment asks.
- **Version retention/GC** — keep all versions forever, or retain last N + active + pinned? Default: keep all until it hurts; artifact-store bytes are cheap.
- **`${VAR}` allowlist** — the concrete allowlist for package `.mcp.json` env expansion (hygiene, not security, in a trusted system).
- **Multipart upload op** — needed the first time a real package exceeds the 2 MB envelope via Web API push; direct-store and repo/URL sources already cover it.

## Implementation notes (v1, as shipped)

Deltas from the design above, decided during implementation and its
adversarial reviews:

- **Identity sha is over the uncompressed canonical tar**, not the gzip
  bytes — deflate output varies across zlib builds, and hashing it would
  have made byte-identical content trip the immutability check after a
  Node upgrade. Blob filenames carry a sha12 suffix
  (`<name>@<semver>.<sha12>.tar.gz`), making them content-addressed so a
  same-semver publish race can never clobber the winner's bytes.
- **Non-ASCII paths are rejected** at validation and pack (ustar names are
  byte-encoded; 7-bit masking corrupted and could collide names).
  Package modules must not use bare imports (no node_modules above the
  install cache) — validation warns; the runtime quarantines on import
  failure. `session-policy.json` is forbidden in packages.
- **Name collision guards use the runtime resolver's normalization**
  (case/punctuation-insensitive + "agent"-suffix fallback), for both the
  reserved built-in set (`listBundledAgentNames`) and intra-package
  duplicates. Package names colliding with fixed route segments
  (`sources`, `upload`, `worker-state`) are rejected.
- **Publish rejects scope changes** (`AGENT_PACKAGE_SCOPE_MISMATCH` —
  promote/demote are the only scope mutations), NULL-owner packages are
  admin-managed, owner-less publish requires admin, and the first-publish
  name race retries via unique-violation catch.
- **Hot refresh lives inside PilotSwarmWorker** (`agentPackages` option:
  cacheDir + refresh interval; the headless entrypoint enables it by
  default, `PILOTSWARM_AGENT_PACKAGES=0` opts out). One code path serves
  cold start and the epoch poll: async install to the sha-keyed cache,
  then a fully synchronous in-place swap of every plugin-derived
  structure — the structures SessionManager and the activity layer hold
  BY REFERENCE are rebuilt in place, never reassigned (two adversarial
  passes each caught a reassignment that stranded a consumer).
- **Upload is inline files** (`[{path, contentBase64}]`, 2 MB envelope)
  on both the portal op and the MCP `push_agent_package` tool — browser
  and LLM clients cannot reasonably produce tarballs; the server
  validates and canonically packs. The CLI is direct-store mode.
- **`listAgentWorkerState` is `fleet:admin` (hard-gated)**: its installed
  map enumerates every package name including user-scope ones.
- Registry error prefixes (`AGENT_PACKAGE_FORBIDDEN` …) map to HTTP
  403/404/409 with the structured validation payload in the error
  envelope.
