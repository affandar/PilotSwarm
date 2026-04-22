# Plugin Packaging and Distribution

## Summary

Plugins live as blobs in Postgres. A mgmt-API pair packs (`pointed-at-folder → validated → tarball → INSERT`) and unpacks (`SELECT → extract to cache`). `(name, version)` is the unique identity; sessions record what they were created against so resume is deterministic across worker restarts. The plugin format is scoped to **agents, skills, and MCP server configuration** — nothing else. No editor UX, no external registries, no filesystem sources for user plugins.

## Motivation

- **Multi-worker fleets.** As workers run on hosts the operator doesn't provision directly (appliances, remote nodes, spawn fleets), they need a way to *fetch* the plugins a session uses, not assume they're already on disk.
- **Reproducibility.** A session created against `agent-tuner@1.3.2` must not silently run against `agent-tuner@1.4.0` after a worker restart. Today nothing enforces that.
- **Diagnostics.** `cms_get_session_skill_usage` already has `plugin_name` / `plugin_version` columns ([cms-migrations.ts:620-703](../../packages/sdk/src/cms-migrations.ts#L620-L703)) that are unreliable because the loader has no authoritative source for those fields.

## Non-Goals

- **Not** a package manager, dependency resolver, sandbox, hot-reloader, marketplace, or federation protocol.
- **Not** an in-app plugin editor. The UX only exposes "upload this folder" / "remove this version" / "list what's installed".
- **Not** the carrier for UX chrome. Branding (logos, favicons, splash screens, product strings), themes, slash commands, help content, model provider lists, session policies, and keybindings are **out of scope** — they're either per-deployment config files or features covered by other mechanisms. The plugin format stays focused on agents/skills/MCP.

## Plugin Layout on Disk

What a developer points the mgmt API at. Also what a worker materializes into its cache after unpacking.

```
<plugin-root>/
  plugin.json           # REQUIRED — manifest (see below)
  agents/               # optional — *.agent.md files
  skills/<name>/        # optional — SKILL.md + optional tools.json + assets
  mcp.json              # optional — MCP server config
  assets/               # optional — arbitrary files referenced by agents/skills
```

### `plugin.json`

```json
{
  "manifestVersion": 1,
  "name": "acme-pipelines",
  "version": "1.4.0",
  "description": "...",
  "sdkCompat": ">=1.0.0 <2.0.0",
  "components": {
    "agents":     ["pipeline-runner"],
    "skills":     ["deploy", "rollback"],
    "mcpServers": ["deploy-service"]
  }
}
```

Rules:
- `manifestVersion: 1` required; loader rejects other values.
- `name` is a DNS-label (lowercase, hyphens).
- `version` is a concrete semver — no ranges.
- `sdkCompat` is a semver range against the SDK version; **sole mechanism** for plugin↔orchestration version coupling.
- `components` declares everything the plugin contributes (agents, skills, mcpServers — each an array of identifiers). The packer verifies every declaration matches disk and refuses packs with undeclared files. Drift is loud.

## Version Identity

```
<name>@<version>      e.g.   acme-pipelines@1.4.0
```

`(name, version)` is unique in `plugin_registry` — one version means exactly one blob. If a developer needs to iterate on the same version (dev loop), `uploadPlugin --replace` overwrites the row in place; this is refused whenever any session references the version. For production flows, bump the version.

## The Store: `plugin_registry`

One row per `(name, version)`. Manifest + bytes in the same row:

```sql
CREATE TABLE plugin_registry (
  name         TEXT NOT NULL,
  version      TEXT NOT NULL,
  manifest     JSONB NOT NULL,      -- plugin.json, extracted for querying
  payload      BYTEA NOT NULL,      -- the .tar.gz bytes
  size_bytes   BIGINT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL,
  published_by TEXT,
  PRIMARY KEY (name, version)       -- one row per version, period
);
```

Plugins are small text. TOAST handles compression and out-of-page storage. `bytea` supports up to ~1 GB per row, orders of magnitude more than needed. One backup covers everything; one auth model gates everything; publish is transactional with the rest of the CMS.

## Pack (upload) and Unpack (fetch)

Two mgmt-API methods, symmetric:

### Pack — `uploadPlugin(folderPath) → PluginRef`

1. Read `plugin.json` at the folder root; validate schema + `components` declaration matches disk.
2. Walk the tree, skipping a fixed ignore list (`.git/`, `node_modules/`, editor cruft; extensible via `.pluginignore`). Symlinks inside the tree are a pack-time error.
3. tar.gz the resulting file set.
4. INSERT `(name, version, manifest, payload, …)` into `plugin_registry`. Conflict on `(name, version)` is refused unless `--replace` is given and no session is bound to that version.
5. Return `{name, version}`.

### Unpack — `fetchPlugin(name, version) → localPath`

1. Check local cache at `<cacheDir>/plugins/<name>/<version>/`. If present **and** the stored `published_at` sidecar matches the current `published_at` in `plugin_registry`, done.
2. Otherwise `SELECT payload, published_at FROM plugin_registry WHERE (name, version) = ...`.
3. Extract tar.gz into a tmp directory.
4. Atomic rename tmp → `<cacheDir>/plugins/<name>/<version>/`, write `.pilotswarm-meta.json` with `{published_at}`.
5. Return the local path.

The `published_at` sidecar check is the one concession to `--replace`: if a developer overwrites an existing version (legal only when no session is bound), the cache on any worker that had the prior bytes is stale. On next fetch the sidecar mismatch triggers re-extraction. Workers restart as part of the normal "not hot-reload" model, so in practice this check runs once per worker lifetime per plugin, not per request.

The local cache is content-addressed; multiple versions coexist. Eviction is explicit — `pilotswarm plugins gc` removes versions no session has referenced in N days. Never automatic.

## Worker Startup

Workers do **not** unpack every row in `plugin_registry`. Each worker has a configured **roster** — the list of plugins it is willing to serve — and only the roster is materialized at startup.

```ts
// PilotSwarmWorkerOptions (replaces the old pluginDirs[])
pluginRoster: Array<{
  name: string;
  version?: string;        // exact pin; otherwise latest in plugin_registry wins
}>
```

Startup algorithm:

1. **Resolve** each roster entry to a concrete `(name, version)` pair. For pinned entries (`{name, version}`), use it directly. For unpinned entries (`{name}`), query `SELECT version FROM plugin_registry WHERE name = ?` and pick the highest semver.
2. **Fetch** each pair via `fetchPlugin(name, version)` — cache-first, DB on miss, with the `published_at` sidecar check guarding against stale cache entries from `--replace`.
3. **Load** the resulting directories the same way bundled SDK plugins are loaded today — into the in-memory agent/skill/MCP maps.
4. Record the resolved set on the worker; new sessions created by this worker bind to exactly this set.

Resume path — a different worker (or the same one after restart) taking over an existing session:

1. Read the session's `plugins[]`.
2. For each entry, check that the plugin *name* is in this worker's roster (names, not versions — whitelist). A session bound to a plugin name the worker doesn't run is refused and the session enters `unsatisfiable_plugins`.
3. For rostered names, `fetchPlugin` the exact bound `(name, version)` even if it differs from what the worker is running for new sessions. This is how worker migration and old-session resume work: the worker may be running `foo@2.0.0` by default but happily resumes a session bound to `foo@1.9.3`.
4. Load the session-specific plugin set into a per-session scope; it doesn't overwrite the worker's default set.

### When new versions take effect

`uploadPlugin` inserts a new row but **does not** hot-reload any running worker. Workers pick up new versions on restart — this is consistent with the "not hot-reload" non-goal. New sessions created after a worker restart resolve the unpinned roster entries against the current `plugin_registry` state and pick up whatever's newest.

For fleets, that means a rolling restart is the upgrade mechanism. This is simple and predictable; dynamic reload is a follow-up if it's ever actually needed.

### Cache lifecycle

- On startup the worker eagerly fetches its rostered versions (fast session creation afterwards).
- On resume the worker lazily fetches whatever a specific session needs (may produce a one-time fetch delay for sessions bound to non-rostered versions).
- `pilotswarm plugins gc` on the worker host keeps (a) rostered versions and (b) versions referenced by sessions the worker has resumed recently; everything else is evicted.

## Session Binding

Extend `ManagedSession` with:

```ts
plugins: Array<{ name: string; version: string }>;
```

Written once at session creation, never mutated. On resume, the worker calls `fetchPlugin(name, version)` for each entry.

Failure modes that push a session to the new `unsatisfiable_plugins` state (instead of the current silent "missing agent → default agent" fallback):

- **Row missing** — `(name, version)` isn't in `plugin_registry`. Shouldn't happen because `removePlugin` refuses when sessions reference the version, but a restore from a stale dump could produce it.
- **Name not in roster** — the worker's whitelist doesn't include this plugin name.

Content drift (a `--replace` silently swapping bytes behind a running session) is prevented at the write side: both `--replace` and `removePlugin` refuse to mutate a version that any session currently references.

## Mgmt API Surface

Lives on `PilotSwarmManagementClient` ([management-client.ts](../../packages/sdk/src/management-client.ts)). Both the pack-and-upload path and the fetch-and-unpack path are first-class mgmt-API methods — every UX surface calls these and these only, never the DB directly.

```ts
// Pack + upload (one call): read folder, validate plugin.json, tar.gz, INSERT into plugin_registry.
uploadPlugin(folderPath, opts?: { replace?: boolean }): Promise<PluginRef>

// Fetch + unpack (one call): SELECT payload, extract into local cache, return the cache path.
fetchPlugin(name, version): Promise<string>

// Registry inspection and lifecycle.
listPlugins(): Promise<PluginSummary[]>                       // name, version, size, published_at, published_by
getPlugin(name, version): Promise<PluginDetail>               // adds manifest + session-usage summary
removePlugin(name, version): Promise<void>                    // refuses if any session refs it
listSessionsUsingPlugin(name, version?): Promise<SessionRef[]>
```

Design rules:

- **`uploadPlugin` is atomic**: validate → pack → INSERT happen server-side inside a single transaction. There is no "pack tarball on the client, upload bytes separately" flow, because that would let clients bypass validation.
- **`fetchPlugin` is idempotent**: cache hit returns immediately; cache miss extracts and returns. Concurrent callers for the same `(name, version)` coalesce around a file lock on the tmp directory.
- **No per-agent / per-skill CRUD, no pin/unpin, no upgrade helper.** "Upgrade" is just `uploadPlugin(newerVersion)`. New sessions resolve unpinned roster entries to the latest; existing sessions keep their bound version.
- **Audit trail** rides the existing session-events channel with `kind: "plugin-admin"`, recording caller identity (`published_by` for uploads, equivalent for deletes).

## UX Surfaces

All three surfaces are thin shells over the mgmt API above — same validation, same audit events, same refusal rules, regardless of who's driving.

### `psctl` — the admin CLI (new)

A new `psctl` binary for operators, distinct from the existing `pilotswarm` TUI. Lives in a new `packages/psctl/`. Connects to the same DB/mgmt API workers use.

```
psctl plugin upload ./my-plugin            # calls uploadPlugin()
psctl plugin upload ./my-plugin --replace  # same, with replace semantics
psctl plugin list                          # calls listPlugins()
psctl plugin show acme-pipelines@1.4.0     # calls getPlugin()
psctl plugin fetch acme-pipelines@1.4.0    # calls fetchPlugin(), prints cache path
psctl plugin remove acme-pipelines@1.4.0   # calls removePlugin()
psctl plugin sessions acme-pipelines       # calls listSessionsUsingPlugin()
```

`psctl` stays small and scriptable — no interactive UX, every command exits non-zero on failure, machine-parseable output via `--json`. This is the tool that ends up in CI pipelines and admin scripts.

### TUI (existing `pilotswarm` binary)

Admin mode (`Ctrl-Shift-A`, as proposed earlier) replaces the session-list + chat panes with a plugin/agent admin view. The primary actions are:

- **Upload from folder**: prompts for a path, calls `uploadPlugin`. Errors (validation failure, conflict without `--replace`) render inline.
- **List / inspect**: the plugin tree on the left, `getPlugin` detail on the right.
- **Remove**: confirmation dialog shows the `listSessionsUsingPlugin` result; refused if non-empty.

No in-app editing of plugin source. The developer's editor is their editor; the TUI's job is "take the folder, put it in the DB."

### Portal

Portal gets a `/admin` route backed by the same methods through the existing `browser-transport` shim ([browser-transport.js](../../packages/portal/src/browser-transport.js)). UX parity with the TUI — upload-from-folder action (an OS file picker selecting a directory), table listing installed plugins, remove button with the same session-impact confirm. No plugin authoring surface.

## Loader Contract: Unpacked Folder → Runtime

The runtime contract between what `fetchPlugin` puts on disk and what the worker loads into memory. This is the interface SDK-bundled plugins and user plugins both conform to — once a plugin is unpacked, nothing downstream cares whether it came from the npm package or from `plugin_registry`.

### What the loader reads

| Path (relative to plugin root) | Consumed by | What it becomes at runtime |
|---|---|---|
| `plugin.json` | [worker.ts:_loadPluginDir](../../packages/sdk/src/worker.ts#L596) | Namespace tag for agents; `components` whitelist; `sdkCompat` gate. |
| `agents/*.agent.md` | [agent-loader.ts:loadAgentFiles](../../packages/sdk/src/agent-loader.ts#L207) | Each file → an `AgentConfig`. Frontmatter: `name` (defaults to filename), `description`, `system`, `tools`, `id`, `title`, `parent`, `splash`, `initialPrompt`. Body is the system prompt. |
| `skills/<skill-name>/SKILL.md` | [skills.ts:loadSkills](../../packages/sdk/src/skills.ts#L75) | Each subdirectory with `SKILL.md` becomes a skill; frontmatter is metadata, body is the prompt. |
| `skills/<skill-name>/tools.json` | same | Optional. `{ "tools": [...] }` restricts the skill to a named tool subset. |
| `skills/<skill-name>/**` (other files) | surfaced by path | Addressable via filesystem paths from agent/skill prompts; not interpreted. |
| `mcp.json` | `loadMcpConfig` | Merged into `_loadedMcpServers`. |
| `assets/**` | not loaded eagerly | Referenced via relative paths from agent/skill prompts. |

### What the loader ignores

- `plugin.json`'s `components` is a **whitelist**, not a hint. Files present on disk but not declared are refused at load time. Makes drift loud.
- `.pilotswarm-meta.json` (cache-staleness sidecar) is loader-invisible.
- Top-level files or directories not in the table above are ignored. No deep-scanning for `.agent.md` outside `agents/`, no `SKILL.md` outside `skills/<name>/`.
- Symlinks inside the plugin tree were rejected at pack time.

### Load order and merging

Three-tier merge survives unchanged ([worker.ts:_loadPlugins](../../packages/sdk/src/worker.ts#L526)): system → mgmt → app (user plugins from `plugin_registry`, in roster order). Within the app tier:

- **Agents** — merged by name; later plugin in roster order wins on collision.
- **Skills** — additive; each plugin contributes its `skills/*` subdirectories.
- **MCP servers** — merged by server name; later wins.

### Failure modes at load

- **Malformed `plugin.json`** → plugin refused; session-bound resume → `unsatisfiable_plugins`.
- **`sdkCompat` unsatisfied** → plugin refused with version mismatch message.
- **`components` doesn't match disk** → plugin refused (double-checked at load).
- **Individual agent/skill parse error** → offending file skipped with warning, rest of plugin loads.

That's the full contract.

## The One Exception: SDK-Bundled Plugins

The SDK's own `system/` and `mgmt/` plugins ([`packages/sdk/plugins/`](../../packages/sdk/plugins/)) are framework code, loaded directly from the npm package on disk. They must resolve before the worker has a DB connection. They are never in `plugin_registry`, never uploadable, never removable. Their `(name, version)` comes from the SDK's own semver, so session events still get reliable `pluginName` / `pluginVersion` tags. Upgrading them means upgrading the SDK.

## Migration Plan

Six shippable steps:

**Step 1 — Manifest schema v1.** Require `manifestVersion`, concrete `version`, `sdkCompat`, `components`. Loader refuses undeclared agents/skills/mcpServers. Bundled SDK plugins migrated first.

**Step 2 — Packer internals.** Implement the validate-and-tar.gz pipeline used by `uploadPlugin`. Exposed as an internal module; no user-facing CLI for packing standalone (distribution is never file-based).

**Step 3 — Registry table + mgmt API.** Add `plugin_registry`. Add `uploadPlugin` / `fetchPlugin` / `listPlugins` / `getPlugin` / `removePlugin` / `listSessionsUsingPlugin` to `PilotSwarmManagementClient`. Introduce `~/.pilotswarm/cache`.

**Step 4 — Worker roster + startup fetch.** Replace the old `pluginDirs[]` option with `pluginRoster`. Worker startup resolves the roster, fetches, loads. The only on-disk source for user plugins from this point on is the content-addressed cache.

**Step 5 — Session binding + resume.** `ManagedSession.plugins[]`. `unsatisfiable_plugins` state. Resume path fetches session-bound versions (whitelisted against the roster by name).

**Step 6 — Admin surfaces.** Ship `psctl` (new `packages/psctl/`), the TUI Admin mode, and the portal `/admin` route — in that order. Each is a thin shell over Step 3's mgmt API; nothing bypasses it.

## Open Questions

- **Dev loop.** `pilotswarm plugin upload --replace ./plugin` on every save is rough. A `dev` mode that watches the folder and re-uploads on change, either with `--replace` on the same version (refused if any session is bound) or with an auto-incrementing `-dev.N` suffix. TBD which is friendlier.
- **Signing.** `published_by` captures authorship at the mgmt-API auth level. Cryptographic signing (Sigstore) deferred until there's a concrete need for provenance beyond the local auth principal.
- **Admin auth scopes.** v1 inherits `listSessions`-level auth for the mgmt API. Finer scopes ("view plugins" vs. "upload plugins" vs. "remove plugins") deferred to a multi-tenant deployment asking for them.
- **Large or binary-heavy plugins.** The design assumes plugins are small and text. If a plugin bundles >50 MB of binary assets, Postgres-as-blob-store starts hurting backups and WAL. Out of scope for v1; the escape hatch would be moving just `assets/` to an external blob with a pointer — not re-architecting the registry.

## Impact on Existing Proposals

- [session-store-driven-durability.md](./session-store-driven-durability.md) assumed a stable plugin surface; this proposal enforces it.
- [starter-docker-appliance.md](./starter-docker-appliance.md) benefits from the content-addressed cache being bake-able into a read-only image layer.
- [skill-usage-stats-management-api.md](./skill-usage-stats-management-api.md) finally gets reliable `plugin_name` / `plugin_version` in its events.
- [shared-skills-pipeline.md](./shared-skills-pipeline.md) is orthogonal — runtime-authored skills live in the facts store, not in packaged plugins.
