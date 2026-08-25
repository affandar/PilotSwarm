# Agent package editors

> **Status:** IMPLEMENTED 2026-08-24 on branch `package-editors-mcp-allowlist`
> (pilotswarm 0.5.46, migration 0063). Waldemort follow-up not started.
>
> **Scope:** three changes shipped together.
> 1. Let a package owner give named users write access to their **shared**
>    agent package. The grant dies when the package is unshared.
> 2. Every signed-in user appears in the grant pickers (session share and
>    package editors), whether or not they ever created a session.
> 3. Agents authored through the Agent Manager can declare MCP servers.

# Change 1: package editors

## The problem

Today only the creator (or an admin) can change a shared package: publish a
new version, pin, enable, disable, delete. Everyone else is read-only. A
team that co-owns an agent has to route every update through one person.

Read access is not the problem. A shared package is already visible to
every user (`cms_list_agent_packages`, `cms-migrations.ts:9081`). So the
only new thing to grant is **write**.

## Terms

- **Package copy**: one row in `agent_packages`. Identity is
  `(scope, owner, name)`. A name can be one shared copy plus any number of
  user copies (migration 0043).
- **Owner**: the `(owner_provider, owner_subject)` pair on the row.
- **Editor**: a user the owner has granted write access to. New in this
  proposal.

## What an editor can and cannot do

| Action | Op today | Owner / admin | Editor |
|---|---|---|---|
| Publish a new version into the shared copy | `uploadAgentPackage` (scope=shared) | yes | **yes** |
| Republish own user copy into the shared copy | `republishAgentPackageVersion` | yes | **yes** |
| Pin the active version | `pinAgentPackageVersion` | yes | **yes** |
| Enable / disable | `setAgentPackageEnabled` | yes | **yes** |
| Demote to user (unshare) | `setAgentPackageScope` | yes | no |
| Delete | `deleteAgentPackage` | yes | no |
| Add / remove editors | new | yes | no |

Editors change the package's contents and rollout. Only the owner decides
whether the package exists and whether it is shared. Editors cannot grant.

Publishing into the shared copy keeps the existing owner. It does not
reassign ownership to the editor (`cms_publish_agent_package` only sets
owner on first publish, `cms-migrations.ts:8983-9020`).

## When a grant is revoked

```
Owner or admin revokes one editor      -> that row is deleted
Owner or admin demotes shared -> user  -> ALL editor rows deleted, same transaction
Package deleted                        -> editor rows deleted (FK CASCADE)
Package promoted user -> shared again  -> starts with ZERO editors
```

No soft delete, no "paused" grants. If the owner re-shares later, they grant
again.

Republish shared → user ("Copy to my user scope") creates a new user-scope
row. Editors are on the shared row, so they do not follow the copy. Nothing
to do.

## Storage

New migration `0063` in `packages/sdk/src/cms-migrations.ts`. Mirrors
`session_shares` (`cms-migrations.ts:7715-7725`):

```sql
agent_package_editors (
  package_id TEXT   NOT NULL REFERENCES agent_packages(package_id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(user_id),
  granted_by BIGINT REFERENCES users(user_id),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (package_id, user_id)
)
INDEX agent_package_editors_user_idx (user_id)
```

Why `users.user_id` and not the `(provider, subject)` pair that
`agent_packages.owner_*` uses: the session-share pattern mints the grantee
with `cms_register_user` on grant (`cms-migrations.ts:7897`). That means you
can grant to a colleague who has never signed in, and the ghost-user
reconciliation at `cms-migrations.ts:2440-2465` links them up on first
login. Package rows keep their pair columns; only the grant table uses ids.

No `access` column. There is only one grant level: editor. If a read-only
grant is ever needed it is a new column with a default, not a redesign.

## SQL functions (all in migration 0063)

```
cms_grant_agent_package_editor(p_name, p_provider, p_subject, p_email,
                               p_display_name, p_actor_provider,
                               p_actor_subject, p_is_admin)
  - resolves the SHARED copy only (sel_scope = 'shared')
  - authz: owner or admin  (cms_agent_package_authz, unchanged rule)
  - rejects scope <> 'shared'      -> AGENT_PACKAGE_NOT_SHARED
  - rejects grantee = owner        -> AGENT_PACKAGE_EDITOR_IS_OWNER
  - cms_register_user(grantee) then INSERT ... ON CONFLICT DO NOTHING

cms_revoke_agent_package_editor(p_name, p_provider, p_subject,
                                p_actor_provider, p_actor_subject, p_is_admin)
  - owner or admin; DELETE one row; idempotent

cms_list_agent_package_editors(p_name, p_viewer_provider, p_viewer_subject,
                               p_is_admin)
  - anyone who can see the package; returns provider, subject, email,
    display_name, granted_at, granted_by_display
```

Grant and revoke do **not** call `cms_agent_registry_bump()`. Workers do not
care who may edit; the epoch is for installed content only.

### The authz change

`cms_agent_package_authz` (`cms-migrations.ts:8780-8837`) is the one place
that decides "may this actor modify this copy". It gets one new argument:

```
p_allow_editor BOOLEAN DEFAULT FALSE
```

When true, the check becomes: admin, OR exact owner match, OR a row in
`agent_package_editors` for this package whose `users.(provider, subject)`
equals the actor.

Callers:

```
cms_publish_agent_package        (existing-package branch, :9014)  -> TRUE
cms_pin_agent_package_version    (:8900)                           -> TRUE
cms_set_agent_package_enabled    (:8885)                           -> TRUE
cms_set_agent_package_scope      (:8839)                           -> FALSE
cms_delete_agent_package         (:8921)                           -> FALSE
cms_grant/revoke_agent_package_editor                              -> FALSE
```

`cms_set_agent_package_scope`, demote branch (`:8854-8878`): add
`DELETE FROM agent_package_editors WHERE package_id = v_id` before the
scope update, inside the same function.

The TypeScript pre-check in `agent-package-service.ts:168-201` repeats the
owner test before it packs the tarball. It must learn the same rule, or an
editor's push is refused before it reaches SQL. Simplest: replace the inline
owner compare with a call to a new `cms_can_edit_agent_package(...)` helper
so the rule lives once.

**Migration trap.** Every function above is already applied. Editing them
in place in an earlier migration is a silent no-op. All of these are
`CREATE OR REPLACE` inside 0063.

## Read side

`cms_get_agent_package` and `cms_list_agent_packages` return two new
fields:

- `can_edit` — true for admin, owner, or editor. The portal and CLI use
  this to show the edit actions.
- `editors` — the list from `cms_list_agent_package_editors` (get only,
  not list). Visible to anyone who can see the package. This is a trusted
  system; who may edit a shared agent is not a secret.

## API, MCP, CLI

Three new rows in `OPERATIONS` (`packages/sdk/api/src/protocol.js`, next
to line 220), shaped like the session-share ops at lines 78-80:

```
grantAgentPackageEditor   POST /agent-packages/:name/editors         { user: { provider, subject, email?, displayName? } }
revokeAgentPackageEditor  POST /agent-packages/:name/editors/revoke  { user: { provider, subject } }
listAgentPackageEditors   GET  /agent-packages/:name/editors
```

`access: "authed"`; the owner-or-admin rule is enforced in SQL like every
other package op. No `scope` selector: editors only exist on the shared
copy, so `:name` is unambiguous. Grant and revoke write an `authz_audit`
row, same as `runtime.js:1011-1025` does for session shares.

MCP (`packages/app/mcp/src/tools/agent-packages.ts`):
`grant_agent_package_editor`, `revoke_agent_package_editor`,
`list_agent_package_editors`.

CLI (`packages/app/tui/src/agents-cli.js`):
`pilotswarm agents editors add|remove|list <name> [<provider>:<subject>]`.

Generated web client picks all three up from the `OPERATIONS` table.

### Name shadowing

An editor may also own a same-named **user** copy. Bare-name resolution
walks "own copy, then shared" (`cms_resolve_agent_package_id`,
`cms-migrations.ts:8712-8767`). So an editor pushing to the shared copy
must pass `scope: "shared"` explicitly, or they will publish into their own
copy. The portal always sends the selected copy's scope. The CLI `push`
command needs a `--scope shared` flag if it does not already send one.

## Portal

`AdminPackageDetailPane` (`web-app.js:11943`) today gates every action on
`detail.canManage`. Split it:

```
canEdit (admin | owner | editor):  Pin, Update, Publish-to-shared, Enable, Disable
canOwn  (admin | owner):           Promote, Demote, Delete, Editors section
```

`ownsPackage` in `selectors.js:4002-4007` becomes two selectors:
`canEditPackage` reads the new `can_edit` field; `ownsPackage` stays as
is.

New **Editors** section in the detail pane, shared copies only: list of
editors with a remove button, plus an add row (user picker fed by
`list_known_users`, same as the session-share dialog). Replace the
read-only fallback text at `web-app.js:12051` with
"Read-only: only the package creator, an editor, or an admin can modify it."

`runAdminPackageAction` (`controller.js:3625`) gains `grantEditor` and
`revokeEditor`.

## Tests

Each of these must be shown to go red when its fix is reverted (see the
token-ledger campaign: eight tests that could not fail, each hiding a bug).

1. Authz matrix, SQL level: for each of the seven ops, actor ∈ {owner,
   admin, editor, other} → expected code. Editor gets `FORBIDDEN` on
   scope, delete, grant, revoke.
2. Demote deletes all editor rows in the same transaction; a failed demote
   (`AGENT_PACKAGE_NAME_TAKEN`) leaves them intact.
3. Re-promote after demote: zero editors.
4. Grant on a user-scope copy → `AGENT_PACKAGE_NOT_SHARED`.
5. Grant to the owner → `AGENT_PACKAGE_EDITOR_IS_OWNER`.
6. Grant to a never-seen user succeeds; that user's later first login
   resolves to the same `user_id` (reuse the session-share ghost test).
7. Editor publish keeps the original owner on the row.
8. Editor with a same-named user copy: push without `scope` lands in the
   user copy; with `scope: "shared"` lands in the shared copy.
9. Grant/revoke does not bump `agent_registry_state.epoch`.
10. `agent-package-service.ts` pre-check accepts an editor (this is the one
    that will silently keep refusing if only SQL is changed).
11. Portal selector: `can_edit` true / `canOwn` false hides Promote,
    Demote, Delete, Editors and shows the five edit actions.

## Change 2: every signed-in user shows up in grant pickers

### What actually happens today

Users **are** registered at login. Since migration 0042 (shipped in
v0.5.31, 2026-08-02), every authenticated portal request runs:

```
server.js:143   noteSignInRole(auth)          (also ws.js:73 for WebSocket)
runtime.js:206  -> transport.recordUserRole(principal, role)   throttled 5 min per principal
cms.ts:2915     -> cms_set_user_role(...)
cms-migrations.ts:8593 -> cms_register_user(provider, subject, email, display_name)
```

So the `users` row exists after the first request. The picker cannot see
it because of one filter. `cms_list_users` (`cms-migrations.ts:2487`, the
function behind `listKnownUsers` / `list_known_users`) reads:

```sql
WHERE ... AND u.display_name IS NOT NULL
```

and `display_name` comes only from the Entra `name` claim
(`packages/app/web/auth/normalize/entra.js:15`). Access tokens often carry
`preferred_username` and no `name`. A user like that signs in fine, gets a
row with `email` set and `display_name` NULL, and is invisible to every
picker until something else fills the name in.

The picker itself is not a search. Both dialogs fetch the whole directory
(`listKnownUsers({ limit: 500 })`, `web-app.js:5693`, `controller.js:7609`)
and filter in the client.

One query on the live DB confirms which case an environment is in:

```sql
SELECT count(*) FILTER (WHERE display_name IS NULL AND email IS NOT NULL) AS email_only,
       count(*) FILTER (WHERE display_name IS NULL AND email IS NULL)     AS bare,
       count(*) FILTER (WHERE display_name IS NOT NULL)                   AS visible
FROM users WHERE provider NOT IN ('system', 'local');
```

### The change

1. **Widen the picker filter** (new `cms_list_users` in migration 0063):
   `AND (u.display_name IS NOT NULL OR u.email IS NOT NULL)`. A row with
   neither is still hidden — that is the "mistyped raw-id grant" placeholder
   the original filter was written to exclude (`:2503-2504`).
2. **Fall back on the name claim** in `normalizeEntraPrincipal`:
   `displayName: payload.name || payload.preferred_username || null`. Then
   the row gets a usable name on the next sign-in, because
   `cms_register_user` fills NULL columns (`COALESCE`, `:2408`).
3. **Register on MCP auth too.** The MCP server authenticates the same
   principals. Verify it calls `noteSignInRole` (or the equivalent); if not,
   add the same hook so MCP-only users are in the directory.
4. **Grants create the row, never its identity.** `cms_grant_agent_package_editor`
   inserts the grantee `users` row create-only on `(provider, subject)` —
   0033's rule, because a grant must not let one user rewrite another's
   name or email. A raw-id or email-keyed grantee therefore gets a bare row
   that the widened filter still hides until they sign in; on that first
   sign-in, 0032's email adoption carries the editor grant across to the
   real principal (`cms_register_user` re-points `agent_package_editors`
   like it does `session_shares`).

No new columns. `role_seen_at` already behaves as `last_seen_at`; if a
"last seen" column is ever wanted, rename that rather than add one.

Tests:

1. A user row with `email` and NULL `display_name` appears in
   `cms_list_users`; a row with both NULL does not.
2. Entra payload with `preferred_username` and no `name` yields a
   non-null `displayName`.
3. First authenticated request from a new principal creates the row
   (already covered by 0042's tests — re-run, do not rewrite).

## Change 3: MCP servers in published agents

### Confirmed: not blocked in the platform — but unreachable from the Agent Manager

The package format, validator, installer, and worker all support MCP
today:

```
validator   agent-package-format.ts:858-881   .mcp.json accepted; shape-checked only
            :399-409, :558-563                plugin.json mcpConfig / mcpServers staged into place
worker      worker.ts:1778-1780               package .mcp.json merged into the catalog on cold start AND epoch refresh
            worker.ts:1440-1506               per-agent mcpServers resolved under a package-qualified key
session     session-manager.ts:1637-1645      package agent's servers merged over the base set; reach the CLI on cold create/resume
examples    examples/agent-packages/pilotswarm-tour-guide   http server (deepwiki)
            examples/agent-packages/editorial-desk          in-package stdio server (mcp-servers/style-desk.js)
```

There is no `AGENT_PACKAGE_*` error and no comment anywhere that blocks
MCP. `pilotswarm agents push` and the portal Upload dialog both publish a
package with `.mcp.json` and it works.

Where it **is** effectively blocked: the Agent Manager. Its authoring
instructions (`agent-packages/agent-manager/agents/agent-manager.agent.md:149-151`)
tell it to write `plugin.json`, `agents/<name>.agent.md`, and `skills/`.
The whole package — prompt and skill — has zero mentions of MCP.
`stage_agent_package_edit` accepts any path (`agent-manager-tools.ts:565`),
so nothing technical stops it; the model simply never writes `.mcp.json`
or `mcpServers:` frontmatter. Its own template also uses `schemaVersion: 1`,
and an agent that declares `mcpServers:` under schema 1 loads with only a
log warning (`agent-loader.ts:396-398`).

### The change

1. **Teach the Agent Manager.** New subsection under "Authoring" in
   `agent-manager.agent.md`, with the three pieces an MCP-using agent
   needs:

   ```
   .mcp.json                    at the package ROOT (convention layout picks it up)
                                { "<name>": { "type": "http", "url": "..." } }
                                { "<name>": { "command": "node", "args": ["./mcp-servers/x.js"] } }
                                (cwd is relative to the package dir; leave it out)
   agents/<name>.agent.md       schemaVersion: 2
                                mcpServers: [<name>]
                                inheritDefaultMcpServers: false | true
   ```

   Not `"mcpConfig"` in `plugin.json` for a convention-layout package:
   declaring any layout field switches the package to manifest mode, where
   only declared artifacts ship. Only a package that already lists its
   agents/skills there names the catalog file that way.

   Plus the rule that in-package stdio servers must be dependency-free ESM
   (no `node_modules`). Bump the agent-manager package version.

2. **Validator: fail early instead of warning at runtime.**
   - `mcp_requires_schema_v2` (error): frontmatter has `mcpServers:` but
     `schemaVersion < 2`.
   - `unknown_mcp_server` (warning): an agent's `mcpServers:` names a
     server that is not in the package's `.mcp.json`. Warning, not error,
     because the name may be a deployment default the validator cannot see.
   - `mcp_default_forbidden` (error): a package `.mcp.json` entry with
     `"default": true`. Today that injects the server into every agent in
     the fleet that inherits defaults (`worker.ts:1441-1447`).

3. **Catalog collisions — decide now, fix later.** Package MCP server
   names merge into one flat catalog (`worker.ts:1780`,
   `Object.assign(this._loadedMcpServers, mcpConfig)`) in the order
   baked dirs → package dirs. A package server named `deepwiki` replaces
   the baked `deepwiki` for every agent, including baked ones. Agent
   names are package-qualified; server names are not. The proper fix is to
   key package servers as `<packageId>:<name>` at load and rewrite each
   agent's refs. That is a runtime change with its own tests; it is not
   part of this proposal. Until then, `reserved_mcp_server_name` (error)
   rejects a package server whose name is in the baked catalog, checked in
   `agent-package-service.ts` at publish time where the baked set is known
   (same place `listBundledAgentNames` guards agent names).

Tests:

1. Publish a package with `.mcp.json` + `mcpServers:` + `schemaVersion: 2`
   through the Agent Manager's staging tools; a fresh session on that
   agent receives the server in its config (assert on the
   `client.createSession` argument, `session-manager.ts:1775`).
2. Each new validator code fires on its bad input and not on the good
   example packages (`pilotswarm-tour-guide`, `editorial-desk`).
3. Editor (Change 1) can publish a version that adds `.mcp.json`.

### Package agents borrowing a deployment-restricted server

This is the case Waldemort's `icm-mcp-readonly` hits. It is a separate
mechanism from shipping your own server, and it is **not in pilotswarm
today**. Waldemort adds it by rewriting `worker.js` inside the image:

```
waldemort/plugin/.mcp.json                 "icm-mcp-readonly": { ..., "allowedAgents": ["ops-analyst"] }
waldemort/deploy/patches/patch-pilotswarm-mcp-agent-allowlist.mjs
                                           pinned to sdk 0.5.44; run by Dockerfile.worker:81-83
                                           patches _resolveAgentMcpServers so that:
                                             - a ref to a restricted server is dropped unless the agent is a
                                               DEPLOYMENT agent whose bare name is in allowedAgents
                                             - any PACKAGE agent is dropped, even if it names the server (line 27)
                                             - a package .mcp.json cannot redefine a restricted name (line 42)
```

So a package agent (for example `rcakit-cosmos-investigator` in
`waldemort/agent-packages/rcakit-cosmos-agent`) cannot reference
`icm-mcp-readonly` at all. That is the only "blocked" case.

### Decision (2026-08-24): upstream `allowedAgents` into pilotswarm

The gate moves into pilotswarm proper and the Waldemort patch is deleted.
The rcakit agent is then added to the allowlist **by its agent identity**.

#### What "agent identity" means here

The loader already gives every agent a qualified name:
`<namespace>:<name>` (`worker.ts:827, 839`). For a plugin dir the
namespace is the `plugin.json` name (`worker.ts:1684-1690`); for a package
that is the package name. So the rcakit agent's identity today is:

```
rcakit:rcakit-cosmosdb
```

This is the resolver's existing `ns:name` form, not a new path syntax.
`allowedAgents` entries are agent identities in exactly that form:

```json
"icm-mcp-readonly": {
  "type": "stdio", "command": "node", "args": ["/app/plugin/mcp/icm-readonly-proxy.mjs"],
  "allowedAgents": ["ops-analyst", "rcakit:rcakit-cosmosdb"],
  "tools": [ ... ]
}
```

Match rules:

| Entry form | Matches | Does not match |
|---|---|---|
| `name` | a deployment (baked or inline) agent with that name | any package agent, even with the same name |
| `ns:name` | the agent `name` in namespace `ns`; for a package, only the **shared** copy | a user-scope copy of the same package (different `packageId`); a different package that ships an agent with the same name |

Why not a bare `rcakit-cosmos-investigator`: any shared package can ship
an agent with that name (`AGENT_NAME_COLLISION` is a warning, not an
error), and it would then hold the ICM grant. The qualified form is one
token longer and closes that.

#### Pilotswarm plan (sdk, one release)

```
1. mcp-loader.ts:41-71
   add `allowedAgents?: string[]` to MCPLocalServerConfig and MCPRemoteServerConfig,
   documented like `default`: PilotSwarm-only tag, stripped before the Copilot CLI.

2. worker.ts:1778-1780  (_loadPluginDir, the catalog merge)
   replace `Object.assign(this._loadedMcpServers, mcpConfig)` with a per-entry merge:
     - dir is a package (this._packageDirOwners.get(absDir)) AND existing entry has
       allowedAgents            -> drop, warn "cannot override a deployment-restricted entry"
     - dir is a package AND the new entry carries allowedAgents
                                -> strip the field, warn "only deployment catalogs may restrict"
     - otherwise                -> assign

3. worker.ts:1440-1506  (_resolveAgentMcpServers)
   - collect allowedAgents per server into a Map<name, Set<string>>, delete the field
     (next to the existing `default` strip at :1444-1445)
   - restricted servers are REMOVED from `defaults` — a restricted server tagged
     "default": true must never flow through inheritDefaultMcpServers
   - resolveRefs(owner, refs, into, agent = null): when the server is restricted,
     keep the ref only if agent != null and agentMatches(agent, set)
   - agentMatches: bare entry -> !agent.packageId && agent.name === entry
                   ns:name    -> agent.namespace === ns && agent.name === name
                                 && (!agent.packageId || agent.packageScope === "shared")
   - base-agent refs (:1468) pass no agent -> restricted refs always dropped there

4. agent-package-format.ts:858-881  (validator)
   new error `mcp_allowed_agents_forbidden`: a package .mcp.json entry with allowedAgents.
   (Runtime strips it anyway; the validator makes the author see it.)

5. packages/sdk/test/unit/agent-mcp-servers.test.mjs
   port the three cases from waldemort/deploy/scripts/test/pilotswarm-mcp-agent-allowlist-patch.test.mjs
   and add:
     - bare entry does not match a package agent of the same name
     - ns:name does not match a user-scope copy; does match the shared copy
     - restricted + "default": true is not inherited
     - field is absent from the config handed to client.createSession
     - package .mcp.json cannot override a restricted name (cold start AND epoch refresh)
     - validator rejects allowedAgents in a package
   Each test reverted-fix-goes-red before it counts.

6. docs/building-agent-packages.md (MCP section) + CHANGELOG. Release 0.5.46.
```

#### Naming (decided 2026-08-24)

The package is renamed and gains sibling agents:

```
package   rcakit-cosmos-agent            ->  rcakit
agents    rcakit-cosmos-investigator     ->  rcakit-cosmosdb   (same content, new name)
                                             rcakit-pgflex     (new; waldemort `rcakit` tool already routes tenant pg-flex)
                                             rcakit-mysqlflex  (new; needs a mysql tenant route in the waldemort `rcakit` tool first)
identities                                   rcakit:rcakit-cosmosdb
                                             rcakit:rcakit-pgflex
                                             rcakit:rcakit-mysqlflex
```

Package names key the artifact path and are globally unique, and there is
no rename op. Renaming = publish `rcakit` as a new package, then delete
`rcakit-cosmos-agent`. Live sessions bound to the old agent name fail
resolution on their next turn; the package is at `0.1.0-dev.1`, so that
is acceptable.

Two ICM catalog entries:

```
icm-mcp-readonly   existing proxy, 27 read tools
                   allowedAgents: [ops-analyst, rcakit:rcakit-cosmosdb, rcakit:rcakit-pgflex, rcakit:rcakit-mysqlflex]

icm-mcp-rw         NEW: same proxy code with a write tool list added
                   allowedAgents: [rcakit:rcakit-cosmosdb, rcakit:rcakit-pgflex, rcakit:rcakit-mysqlflex]  (NOT ops-analyst)
```

Each rcakit agent declares exactly one server: `icm-mcp-rw`. Declaring
both would send every read tool twice per turn. The bridge identity
already has write entitlement (confirmed 2026-08-24), so there is no
readonly-first phase. The rcakit entries on `icm-mcp-readonly`'s allowlist
are kept as requested but nothing binds them today.

`rcakit-mysqlflex` ships as a **placeholder**: an agent file whose prompt
says the MySQL route is not ready, with no `mcpServers:` yet. Its allowlist
entries exist so that turning it on later is a package republish only.
`rcakit-pgflex` is a real sibling of the cosmosdb agent on the `pg-flex`
tenant route the `rcakit` worker tool already accepts.

#### Waldemort plan (after 0.5.46 is vendored)

```
1. bump pilotswarm-sdk to 0.5.46 (offline vendor — pins the GitHub Release tarballs, which
   managed devices CAN reach; the npm feed's quarantine is irrelevant here)
2. delete  deploy/patches/patch-pilotswarm-mcp-agent-allowlist.mjs
           deploy/scripts/test/pilotswarm-mcp-agent-allowlist-patch.test.mjs
           the entry at deploy/scripts/vendor-pilotswarm-offline.mjs:61
           Dockerfile.worker:81-83
3. package rename  agent-packages/rcakit-cosmos-agent -> agent-packages/rcakit
                   plugin.json name: "rcakit"
                   agents/rcakit-cosmos-investigator.agent.md -> agents/rcakit-cosmosdb.agent.md (name: rcakit-cosmosdb)
                   add agents/rcakit-pgflex.agent.md (real, tenant pg-flex)
                   add agents/rcakit-mysqlflex.agent.md (placeholder prompt, no mcpServers yet)
                   cosmosdb + pgflex: schemaVersion: 2, mcpServers: [icm-mcp-rw], inheritDefaultMcpServers: false
                   publish `rcakit` (shared); delete `rcakit-cosmos-agent`
                   grant editors on `rcakit` to the teammates who co-own it (Change 1)
4. plugin/.mcp.json  icm-mcp-readonly.allowedAgents = [ops-analyst + the three rcakit identities]
                     add icm-mcp-rw (see below)
5. icm-mcp-rw      plugin/mcp/icm-proxy.mjs: factor the tool list out of icm-readonly-proxy.mjs
                   (READ_ONLY_TOOLS stays frozen; add WRITE_TOOLS; select by argv/env), same identity
                   and timeout code. Catalog entry lists read + write tools.
                   Requires: write entitlement on the ADO_IDENTITY_CLIENT_ID bridge identity.
6. tests   test/agent-contracts.test.js:351-405   readonly keeps the no-mutations assertion;
                                                   add icm-mcp-rw expectations + allowlist arrays
           test/icm-readonly-proxy.test.mjs:344
           new: rw proxy passes write tools, readonly proxy still rejects them
7. docs    deploy/README.md:384-403, docs/building-agent-packages.md RCAKit contract
8. deploy worker via the chk recipe (Flux owns the worker; image-tag bump, not kubectl patch)
```

**Trust note.** With Change 1, editors can publish to a shared package. If
that package's agent is on a restricted server's allowlist, every editor
controls what that agent does with the server. Grant editors on such a
package with that in mind; it is the same trust the package owner already
has.

## Combined delivery plan

One pilotswarm release carries every platform piece. Waldemort follows
once that release is vendored. The four pilotswarm workstreams touch
different files and can be built in parallel; they ship together.

```
PILOTSWARM 0.5.46  (branch off main)

  A. Package editors                      Change 1
     migration 0063: agent_package_editors, grant/revoke/list procs,
       cms_agent_package_authz(p_allow_editor), demote deletes editors,
       can_edit + editors on get/list
     agent-package-service.ts pre-check learns the editor rule
     3 ops in protocol.js -> runtime.js, management-client.ts, generated web client
     MCP tools + CLI `agents editors add|remove|list`
     portal: canEdit/canOwn split, Editors section in the detail pane

  B. Everyone in the picker               Change 2
     cms_list_users: display_name OR email      (same migration 0063)
     entra.js: displayName falls back to preferred_username
     verify the MCP server runs the sign-in hook

  C. MCP servers via the Agent Manager    Change 3
     agent-manager.agent.md: MCP subsection; bump the package version
     validator: mcp_requires_schema_v2, unknown_mcp_server (warn),
       mcp_default_forbidden, mcp_allowed_agents_forbidden
     publish-time: reserved_mcp_server_name (baked catalog collisions)

  D. allowedAgents upstream               Change 3, decision section
     mcp-loader.ts types; worker.ts catalog merge + _resolveAgentMcpServers
     ns:name identity, shared copy only, restricted servers never default
     tests ported from the Waldemort patch + the six new cases

  E. docs, CHANGELOG, release, offline vendor for Waldemort

WALDEMORT  (after 0.5.46 is vendored)

  1. sdk bump; delete the worker patch, its test, vendor entry, Dockerfile lines
  2. package rename -> `rcakit`; agents rcakit-cosmosdb, rcakit-pgflex, rcakit-mysqlflex (placeholder)
  3. .mcp.json: icm-mcp-readonly allowlist += the three; add icm-mcp-rw (only the three)
  4. icm-mcp-rw proxy (read + write tool lists, shared identity code)
  5. contract tests, README, building-agent-packages.md
  6. deploy via the chk recipe
  7. grant editors on `rcakit` (uses A; pick them from the directory, which B fixed)
```

Dependencies: Waldemort 2-4 need D. Waldemort 7 needs A and B. Nothing
in Waldemort needs C, but C is what lets the Agent Manager maintain the
rcakit package's MCP config afterwards.

## Non-goals

- Read-only grants (shared is already world-readable).
- Editors on user-scope copies. Share the package if you want to share it.
- Ownership transfer. Admins can already act as owner.
- Group or team grants. One row per user.
- Any sandboxing or trust change. This is still a trusted system.
