# Plugin Packaging and Distribution

## Summary

Plugins live as blobs in Postgres. A mgmt-API pair packs (`pointed-at-folder → validated → tarball → INSERT`) and unpacks (`SELECT → extract to cache`). `(name, version)` is the unique identity; sessions record what they were created against so resume is deterministic across worker restarts. No editor UX, no external registries, no filesystem sources for user plugins.

## Motivation

- **Multi-worker fleets.** As workers run on hosts the operator doesn't provision directly (appliances, remote nodes, spawn fleets), they need a way to *fetch* the plugins a session uses, not assume they're already on disk.
- **Reproducibility.** A session created against `agent-tuner@1.3.2` must not silently run against `agent-tuner@1.4.0` after a worker restart. Today nothing enforces that.
- **Diagnostics.** `cms_get_session_skill_usage` already has `plugin_name` / `plugin_version` columns ([cms-migrations.ts:620-703](../../packages/sdk/src/cms-migrations.ts#L620-L703)) that are unreliable because the loader has no authoritative source for those fields.

## Non-Goals

- **Not** a package manager, dependency resolver, sandbox, hot-reloader, marketplace, or federation protocol.
- **Not** an in-app plugin editor. The UX only exposes "upload this folder" / "remove this version" / "list what's installed".

## Plugin Layout on Disk

What a developer points the mgmt API at. Also what a worker materializes into its cache after unpacking.

```
<plugin-root>/
  plugin.json           # REQUIRED — manifest (see below)
  agents/               # optional — *.agent.md files
  skills/               # optional — one subdir per skill with SKILL.md
  mcp.json              # optional — existing MCP server config
  assets/               # optional — arbitrary files referenced by skills/agents
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
    "agents": ["pipeline-runner"],
    "skills": ["deploy", "rollback"]
  }
}
```

Rules:
- `manifestVersion: 1` required; loader rejects other values.
- `name` is a DNS-label (lowercase, hyphens).
- `version` is a concrete semver — no ranges.
- `sdkCompat` is a semver range against the SDK version; it is the **sole mechanism** for plugin↔orchestration version coupling (no second knob on the SDK side).
- `components` is declarative — the packer verifies every declared agent/skill exists, and refuses packs where files on disk aren't declared. Drift is loud.

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

Lives on `PilotSwarmManagementClient` ([management-client.ts](../../packages/sdk/src/management-client.ts)). Short list:

```ts
uploadPlugin(folderPath, opts?): Promise<PluginRef>        // pack + INSERT
fetchPlugin(name, version): Promise<string>                 // SELECT + unpack, returns cache path
listPlugins(): Promise<PluginSummary[]>                     // SELECT name, version, size, published_at
removePlugin(name, version): Promise<void>                  // refuses if any session refs it
listSessionsUsingPlugin(name, version?): Promise<SessionRef[]>
```

That's it. No per-agent / per-skill CRUD, no pin/unpin, no upgrade helper. "Upgrade" is `uploadPlugin(newVersion)`; new sessions pick up the latest version matching the worker's configured set; existing sessions keep their bound version. Audit trail is the existing session-events channel tagged `kind: "plugin-admin"`.

## UX Surfaces

All three clients are thin shells over the mgmt API:

- **CLI**: `pilotswarm plugin upload ./my-plugin`, `pilotswarm plugin list`, `pilotswarm plugin remove name@version`.
- **TUI**: a prompt / command that takes a folder path and calls `uploadPlugin`. A list view for `listPlugins`. A remove action. No in-app file editing.
- **Portal**: same — a settings pane with an "Upload plugin folder" action, a table listing installed plugins, a remove button. No in-app editing, no plugin authoring UX.

The editor for plugin source files is whatever the developer's editor is (VS Code, vim, …). The mgmt API's job is "take the folder, put it in the DB"; it is not the author's workspace.

## The One Exception: SDK-Bundled Plugins

The SDK's own `system/` and `mgmt/` plugins ([`packages/sdk/plugins/`](../../packages/sdk/plugins/)) are framework code, loaded directly from the npm package on disk. They must resolve before the worker has a DB connection. They are never in `plugin_registry`, never uploadable, never removable. Their `(name, version)` comes from the SDK's own semver, so session events still get reliable `pluginName` / `pluginVersion` tags. Upgrading them means upgrading the SDK.

## Migration Plan

Four shippable steps:

**Step 1 — Manifest schema v1.** Require `manifestVersion`, concrete `version`, `sdkCompat`, `components`. Loader refuses undeclared agents/skills. Bundled SDK plugins migrated first.

**Step 2 — Packer.** `pilotswarm pack` validates the manifest and emits a tarball. Used by `uploadPlugin` internally; the CLI surface is mostly for debugging ("what would be packed?").

**Step 3 — Registry table + pack/unpack.** Add `plugin_registry`. Add `uploadPlugin` / `fetchPlugin` / `listPlugins` / `removePlugin` / `listSessionsUsingPlugin`. Introduce `~/.pilotswarm/cache`.

**Step 4 — Worker roster + startup fetch.** Replace the old `pluginDirs[]` option with `pluginRoster`. Worker startup resolves the roster, fetches, loads. The only on-disk source for user plugins from this point on is the content-addressed cache.

**Step 5 — Session binding + resume.** `ManagedSession.plugins[]`. `unsatisfiable_plugins` state. Resume path fetches session-bound versions (whitelisted against the roster by name). Plumb through to the CLI / TUI / portal with the minimal upload+list+remove UX.

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
