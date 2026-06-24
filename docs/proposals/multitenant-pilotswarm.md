# Multitenant PilotSwarm

**Status:** Draft / RFC — meant to be iterated on
**Date:** 2026-06-02
**Scope:** plugin distribution, worker fleet topology, session routing, identity

## Summary

PilotSwarm today is effectively single-tenant: plugins load globally from a worker's
`pluginDirs`, every worker is interchangeable, and ownership metadata (`owner`, `groupId`)
is recorded but never used to scope anything. This proposal sketches the path to a
multitenant deployment along three axes the team has asked for:

1. **User-supplied plugins** — let users bring their own agents/skills/MCP by pointing at a
   **git repo** or uploading a **tarball** (including from their local disk), and mark each
   upload **shared** (whole deployment) or **user-scoped** (only the uploader).
2. **Typed worker pools** — let agents target work to specific *kinds* of nodes (build boxes,
   PR-analysis boxes, GPU boxes…) whose container images carry different tools, using
   **duroxide's activity tagging** to route session work to workers that advertise a matching type.
3. **Other ideas** — the multitenancy surface area that falls out of 1 and 2 once user code and
   shared infrastructure coexist (trust boundaries, quotas, per-tenant config).

This builds directly on three existing proposals and tries not to re-litigate them:

- [plugin-packaging-and-distribution.md](./plugin-packaging-and-distribution.md) — the
  `plugin_registry` blob store, `(name, version)` identity, `uploadPlugin`/`fetchPlugin`,
  per-worker roster, session-bound plugin sets. This proposal **extends** it: new *sources*
  (git/tar), a new *scope* dimension, and tenant-aware roster resolution. Two of its stated
  non-goals ("no filesystem sources", "admin auth scopes deferred to a multi-tenant deployment")
  are exactly the deferrals this proposal picks up.
- [session-owner-association-and-filtering.md](./session-owner-association-and-filtering.md) —
  the `users` + `session_owners` tables and the normalized principal (`provider`, `subject`,
  `email`, `displayName`). That principal **is** the tenant key here. We promote ownership from a
  display/filter feature to a scoping key.
- [npm-packaging-and-embedded-plugins.md](../proposals-impl/npm-packaging-and-embedded-plugins.md) —
  the loader contract that both bundled and user plugins conform to.

## Motivation

- **Self-service.** Users want to iterate on their own agents without a deploy. "Point at my git
  repo / hand me a tarball" is the lowest-friction on-ramp and matches how people already author
  plugins (the layout in [plugin-architecture-guide.md](../plugin-architecture-guide.md)).
- **Heterogeneous work needs heterogeneous nodes.** A build agent needs a toolchain image
  (compilers, SDKs, large disk); a PR-analysis agent needs git + review tooling; a default chat
  agent needs neither. Baking everything into one fat image is wasteful and fragile. We want
  thin, purpose-built worker images and a way to send the right work to the right image.
- **The primitives already exist.** Duroxide ships activity tag routing (see below). Ownership
  plumbing is designed. The plugin blob store is designed. This proposal mostly *composes* and
  *scopes* existing pieces rather than inventing new infrastructure.

## Non-Goals

- Not a hard security sandbox for untrusted code in v1 (see §3 — we constrain *where* user code
  runs, not yet *how tightly*). True isolation is called out as the gating open question.
- Not a billing/metering system. Quotas are sketched but not built.
- Not a marketplace, dependency resolver, or hot-reloader (inherited non-goals from the packaging proposal).
- Not changing the orchestration replay model. Tag routing must respect replay invariants
  (orchestration-design §12) — tags are an attribute of the *scheduling decision*, recorded in history.

---

## Part 1 — User-Supplied Plugins (git / tarball, shared vs user-scoped)

### What we inherit

The packaging proposal already gives us: a `plugin_registry` table (manifest + bytes per
`(name, version)`), server-side `uploadPlugin(folderPath)` that validates `plugin.json` against
disk and tar.gz's it, `fetchPlugin(name, version)` with a content-addressed cache, session binding
via `ManagedSession.plugins[]`, and the loader contract. We keep all of it. We change the *front
door* (where bytes come from) and add a *scope* column (who can see them).

### 1a. New sources: git pointer and tarball

`uploadPlugin` currently takes a local folder path on the *server*. We add two sibling intake
paths that all funnel into the same validate → canonical-tar.gz → INSERT pipeline, so the stored
artifact and validation rules are identical regardless of source:

```ts
// management-client.ts — all three converge on the same packer
uploadPluginFromFolder(folderPath, opts): Promise<PluginRef>   // existing
uploadPluginFromGit(spec, opts): Promise<PluginRef>            // new
uploadPluginFromTarball(bytes | stream, opts): Promise<PluginRef> // new
```

**Git pointer.**

```ts
interface GitPluginSpec {
  url: string;          // https or git@; deployment policy decides which schemes/hosts are allowed
  ref?: string;         // branch, tag, or commit SHA; default branch HEAD if omitted
  subdir?: string;      // path to <plugin-root> inside the repo (monorepo-friendly)
  auth?: { tokenRef?: string }; // reference to a stored credential, never a raw token over the wire
}
```

Server-side: shallow `git clone --depth 1 --branch <ref>` into a scratch dir, `cd subdir`, run the
existing folder packer, then discard the clone. The **resolved commit SHA is recorded in the
manifest provenance** (`source: { kind: "git", url, sha }`) so an upload is reproducible and
auditable even though we don't keep the working tree. Pinning `ref` to a tag/branch resolves to a
SHA at upload time; we never silently track a moving branch (consistent with "no hot reload").

**Tarball from local disk.** The CLI/portal streams the user's `.tar.gz` bytes to the mgmt API.
The server extracts to a scratch dir, runs the **same** validation + canonical re-pack (we do not
trust the client's tar layout — we normalize it), then INSERTs. This is the "from their local disk
even" case: `psctl plugin upload ./my-plugin.tgz` or a browser file picker. Note this directly
overturns the packaging proposal's "distribution is never file-based" stance — accepted here
because self-service is the whole point.

Validation is **identical** across all three sources: `plugin.json` schema, `components` whitelist
matches disk, `sdkCompat` range, no symlink escapes, ignore-list applied, size ceiling. A malformed
plugin is rejected at the door with the same errors no matter how it arrived.

### 1b. New dimension: scope (shared vs user)

Today `(name, version)` is globally unique. Multitenancy needs the *same* plugin name to mean
different things for different users, and needs a user's plugin to be invisible to others. We add a
**scope** and an **owner** to the identity:

```sql
ALTER TABLE plugin_registry
  ADD COLUMN scope     TEXT   NOT NULL DEFAULT 'shared',   -- 'shared' | 'user'  (later: 'group')
  ADD COLUMN owner_id  BIGINT NULL REFERENCES users(user_id), -- NULL iff scope='shared'
  ADD COLUMN source    JSONB  NOT NULL DEFAULT '{}';       -- provenance: {kind:'git'|'tar'|'folder', ...}

-- identity is now per-scope-per-owner:
ALTER TABLE plugin_registry DROP CONSTRAINT plugin_registry_pkey;
ALTER TABLE plugin_registry
  ADD PRIMARY KEY (scope, owner_id, name, version);     -- owner_id NULL for shared rows
```

Semantics:

- **`shared`** — visible to the whole deployment, exactly today's global plugins. Uploading or
  removing a shared plugin requires the `plugins:publish-shared` admin scope (see §3c). `owner_id`
  is NULL.
- **`user`** — visible only to the uploading principal (`owner_id` → `users.user_id`, the
  `(provider, subject)` from the ownership proposal). Any authenticated user may publish into their
  own user scope; they cannot see or fetch another user's user-scoped rows.

**Name resolution / shadowing.** When a session resolves plugin `foo`, user-scoped rows for the
session's owner take precedence over a shared `foo` of the same name. This lets a user fork-and-override
a shared plugin for themselves without affecting anyone else. Resolution order: **user scope (owner) →
shared scope**. We make this explicit and loud in `getPlugin`/`listPlugins` output ("`foo@1.2.0`
(user) shadows `foo@1.1.0` (shared)").

The mgmt API gains a scope/owner-aware read model; every list/get is filtered by the caller's
principal so user-scoped rows never leak. `listPlugins()` returns `{ shared: [...], mine: [...] }`.

### 1c. The hard part: roster model vs. user-scoped plugins

The packaging proposal's worker **roster** is *static* — a worker materializes a fixed list at
startup and only resumes sessions whose plugin *names* are in that list. That model assumes a small,
operator-curated plugin set. It does **not** survive contact with thousands of user-scoped plugins:
no worker can pre-roster every user's plugins, and the name-whitelist check would reject most
user-scoped sessions.

The shift: **user-scoped plugins are never rostered; they are purely session-bound and lazily
fetched.** The worker roster keeps governing *shared* plugins (eager fetch at startup, as today).
User-scoped plugins ride entirely on `ManagedSession.plugins[]` (which already records exact
`(name, version)` — we extend each entry with `scope` and `owner_id`). On resume:

1. Shared entries: whitelist by roster name, as the packaging proposal specifies.
2. User entries: **no name-whitelist** — instead an *admission policy* check (is this worker
   allowed to run user code at all? does the session's required node-tag match this worker? §2),
   then `fetchPlugin` the exact bound version into a **per-session scope** that never pollutes the
   worker's shared maps.

This is the single biggest design change and the place most likely to need iteration. It trades the
clean static-roster story for "shared is rostered, user is session-bound." The `unsatisfiable_plugins`
state from the packaging proposal still applies (row missing, or worker refuses user code).

### 1d. Trust: user plugins run arbitrary code

A user plugin can ship an MCP server config, agent `tools`, and skills that shell out. In a
single-tenant deployment that's fine — it's the operator's own code. In a multitenant one it is
**untrusted code running next to other tenants' sessions.** v1 does not try to sandbox it tightly;
instead it *contains* it:

- User-scoped plugins are only admitted on workers whose admission policy opts in
  (`allowUserPlugins: true`). Operators can keep a pool of "trusted/shared-only" workers that never
  load user code.
- Combined with Part 2: user-plugin sessions are tagged to a dedicated, **disposable** node pool
  (e.g. `tag: "user-sandbox"`) — see §2d. This is the pragmatic isolation story for v1: not a
  syscall sandbox, but blast-radius containment via node-type segregation + ephemeral workers.

Real isolation (gVisor/Firecracker/per-tenant namespaces, MCP egress policy) is the explicit
follow-up and the main thing blocking "open it to the public internet."

---

## Part 2 — Typed Worker Pools via Duroxide Activity Tagging

### The primitive (already in duroxide 0.1.27)

Duroxide ships exactly the routing primitive we need — confirmed in
[node_modules/duroxide/lib/duroxide.d.ts](../../node_modules/duroxide/lib/duroxide.d.ts):

```ts
// On the scheduling side (inside the orchestration):
ScheduledTask.withTag(tag: string): ScheduledTask;   // chain a routing tag onto an activity task
// e.g.  ctx.scheduleActivityOnSession("runTurn", input, affinityKey).withTag("build")

// On the worker side (Runtime construction):
interface RuntimeOptions {
  workerTagFilter?:
    | "defaultOnly"        // (default) only untagged activities
    | "any"                // every activity regardless of tag
    | "none"               // orchestrator-only; runs no activities
    | { tags: string[] }   // ONLY activities tagged with one of these
    | { defaultAnd: string[] }; // untagged activities PLUS these tags
}

// Inside the activity, to read what it was routed as:
ctx.tag(): string | null;        // ActivityContext.tag()
activityTag(token): string | null;
// Limits: MAX_WORKER_TAGS, MAX_TAG_NAME_BYTES.
```

So routing is: a worker advertises which tags it serves (`workerTagFilter`); an activity scheduled
`.withTag("build")` is only dispatched to workers whose filter admits `"build"`. Untagged work goes
to default workers. This maps one-to-one onto "worker types."

### 2a. Worker advertises its type

Add `workerTags` to `PilotSwarmWorkerOptions`, threaded into the `runtimeOptions` object at
[worker.ts:370](../../packages/sdk/src/worker.ts#L370):

```ts
interface PilotSwarmWorkerOptions {
  // ...
  /** Node-type tags this worker advertises. Maps to duroxide RuntimeOptions.workerTagFilter.
   *  Omitted → "defaultOnly" (untagged work only), preserving today's behavior. */
  workerTags?: {
    serve: string[];        // e.g. ["build"]  → { tags: ["build"] }
    alsoDefault?: boolean;  // true → { defaultAnd: serve } (also picks up untagged work)
  };
}
```

A build-image worker launches with `workerTags: { serve: ["build"] }`; a general worker launches
with nothing (untagged-only) or `{ serve: ["pr-analysis"], alsoDefault: true }` to double up. The
container image, the installed toolchain, and the tag are deployed together — the tag *names* the
capabilities the image provides. (Deployment-side: this becomes a label on the worker Deployment in
[deploy/](../../deploy/) / AKS topology, with one Deployment per node type.)

### 2b. Agents declare the node type they need

An agent author states the node type in agent frontmatter (parsed by
[agent-loader.ts](../../packages/sdk/src/agent-loader.ts), `AgentConfig` gains a field):

```yaml
---
name: builder
description: Compiles and tests the repo
node: build         # ← required worker tag; default (omitted) = untagged pool
---
```

`node` resolves to the duroxide tag. Omitted means "default pool" (today's behavior — nothing
changes for existing agents).

### 2c. Stamping the tag onto session activities

A session's lifecycle activities (`runTurn`, `hydrate`, `dehydrate`, `checkpoint`, `destroy`) **all
must carry the same tag**, because they share the session's on-disk working directory — a build
session's filesystem lives on a build node, and a non-build worker must not pick up its `hydrate`.
So the node tag is a **session-level property**, resolved once at creation (from the chosen agent's
`node`) and stored on `ManagedSession`, then applied to every call in `createSessionProxy`
([session-proxy.ts:430](../../packages/sdk/src/session-proxy.ts#L430)):

```ts
// createSessionProxy gains nodeTag; every scheduleActivityOnSession chains it:
ctx.scheduleActivityOnSession("runTurn", input, affinityKey)
   .withTag(nodeTag)        // no-op when nodeTag is undefined → untagged → default pool
```

**Interaction with affinity.** `scheduleActivityOnSession(..., affinityKey)` already pins a session
to one worker. Tag filtering is an *additional* constraint: affinity selects among workers that
*also* satisfy the tag filter. The two compose cleanly because session relocation already goes
through dehydrate → session-store → hydrate; when affinity rotates (e.g.
`preserveWorkerAffinity: false` on a wait), the next pickup is still constrained to the tagged pool,
so a build session re-lands on a build node. The session never migrates *across* node types — its
required tag is immutable for its lifetime.

**Child sessions.** `spawnChildSession` must propagate the resolved tag of the *child's* agent (a
default-pool parent can spawn a build child and vice versa). The child's tag comes from the child
agent's `node`, resolved at spawn.

**Manager-level activities** (`resolveAgentConfig`, `listModels`, `spawnChildSession`,
`listSessions`, …) stay **untagged** — they're light, stateless, and any worker can serve them. Only
session-bound, filesystem-touching work is tagged. (Caveat: a deployment where *every* worker is
tagged and none serves the default pool would strand untagged manager activities — so the rule is
**at least one pool must serve default**, i.e. run with `alsoDefault` or no filter.)

### 2d. Synthesis with Part 1: user code → sandbox pool

The two parts combine for the v1 containment story: a deployment runs (a) default workers for
trusted/shared agents, (b) typed workers (`build`, `pr-analysis`) with purpose-built images, and
(c) a `user-sandbox` pool with `allowUserPlugins: true` running disposable/ephemeral workers. The
session-creation policy routes any session that binds user-scoped plugins to the `user-sandbox`
tag, so untrusted code never lands on the shared/default pool. One mechanism (tags) serves both
"capabilities" and "trust level."

---

## Part 3 — Other Ideas (the rest of the multitenancy surface)

Once user code and shared infra coexist, these fall out and are worth scoping even if deferred:

### 3a. Promote ownership from display to scoping key

The [ownership proposal](./session-owner-association-and-filtering.md) is explicitly "classification
and filtering, not an authorization boundary." Multitenancy needs the boundary. We reuse its
`users` + `session_owners` tables unchanged but add an **authz layer** above the mgmt API:
"can principal P read/mutate session S / plugin row R?" Default policy: a user sees their own
sessions + system sessions + shared plugins; an admin scope sees all. This is the ownership
proposal's deferred "Phase 2: ownership-aware authz," now a first-class requirement.

### 3b. Per-tenant quotas and metering

User-scoped plugins and sessions invite resource exhaustion. Sketch: per-owner caps on
(concurrent sessions, total plugin bytes, tokens/day), enforced at session-creation and
`uploadPlugin` time, surfaced through the existing stats/usage management API
([session-stats-management-api.md](./session-stats-management-api.md), and the ownership proposal's
per-owner token/snapshot aggregates already compute most of the inputs). Enforcement point, not new
accounting.

### 3c. Admin auth scopes

The packaging proposal explicitly deferred "finer scopes ('view plugins' vs 'upload' vs 'remove') to
a multi-tenant deployment asking for them" — this is that deployment. Minimum viable scope set:
`plugins:publish-user` (any authenticated user, own scope), `plugins:publish-shared` (admin),
`plugins:remove-shared` (admin), `sessions:read-all` (admin/support), `workers:admin`. Hangs off the
existing portal/Entra auth ([portal-auth-provider-and-authz.md](./portal-auth-provider-and-authz.md),
[entra-auth-gateway.md](./entra-auth-gateway.md)).

### 3d. Per-tenant configuration

Model-provider lists, session-creation policy, default agent, and keybindings are per-deployment
config today. Multitenancy may want per-tenant overrides (a tenant restricted to certain models, or
with a different default agent). Out of scope for v1 but the config-loading path should not hardcode
"one global config."

### 3e. Tenant-scoped facts / memory

The facts store ([facts-table.md](../facts-table.md)) and `horizon-facts` incubator
([incubator/horizon-facts/](../../incubator/horizon-facts/)) are shared knowledge surfaces. In a
multitenant world, runtime-authored facts likely need a tenant/owner partition so one user's memory
doesn't bleed into another's retrieval. Flag for the facts owners; not designed here.

---

## Data Model Changes (summary)

| Table | Change | Source |
|---|---|---|
| `plugin_registry` | + `scope`, `owner_id`, `source`; PK → `(scope, owner_id, name, version)` | §1b |
| `sessions` / `ManagedSession` | + `node_tag TEXT NULL` (resolved at creation, immutable) | §2c |
| `ManagedSession.plugins[]` | each entry + `scope`, `owner_id` | §1c |
| `users`, `session_owners` | unchanged; reused as tenant key | §3a |
| (authz) | new policy layer over mgmt API (no new table required for v1) | §3a/§3c |

All CMS table access stays behind stored procedures with companion numbered diff files, per the
ownership proposal's migration guidance and `cms-migrations.ts` conventions.

## Phased Rollout

1. **Tagging foundation (smallest, highest leverage, no multitenancy yet).** `workerTags` →
   `workerTagFilter`; `node` in agent frontmatter; `node_tag` on session; `.withTag()` in
   `createSessionProxy` + child propagation. Ship typed worker pools for the operator's *own*
   agents (build/pr-analysis). Independently useful before any user-plugin work.
2. **Plugin sources.** `uploadPluginFromGit` + `uploadPluginFromTarball` into the existing packer,
   shared scope only. Provenance in manifest. No new scoping yet — just new front doors.
3. **Plugin scoping.** `scope`/`owner_id` columns, user-scope resolution + shadowing, session-bound
   user plugins, per-session load scope. Authz layer (§3a/§3c) lands here because user scope is
   meaningless without it.
4. **Containment.** `allowUserPlugins` admission policy + `user-sandbox` tagged pool (§2d). Quotas
   (§3b). This is the gate before exposing self-service plugins to untrusted users.
5. **Hardening (follow-up).** Real isolation (gVisor/Firecracker/MCP egress policy), per-tenant
   config (§3d), tenant-scoped facts (§3e).

## Open Questions

- **Roster vs. session-bound user plugins (§1c).** Is "shared is rostered, user is session-bound"
  the right split, or should *all* plugins become session-bound and the static roster retired
  entirely? The latter is cleaner but a bigger change to the packaging proposal's model.
- **Isolation depth (§1d/§2d).** Is node-pool segregation + ephemeral workers acceptable blast-radius
  containment for the initial internal/trusted-tenant rollout, or is a real syscall sandbox a hard
  gate even for v1? This determines whether Phase 4 is "ship it" or "block on Phase 5."
- **Tag granularity.** duroxide `withTag` takes a *single* string per activity (`MAX_WORKER_TAGS`
  governs the worker filter side, not the schedule side). A session targets exactly one node type.
  Is single-tag targeting sufficient, or will agents need to express "build AND gpu" — which would
  need a composite tag string (`"build+gpu"`) by convention since the schedule side is one tag?
- **Git auth & egress.** Server-side `git clone` of user-supplied URLs is an SSRF/egress concern.
  Allowed hosts/schemes, credential storage (`tokenRef`), and network policy need a decision before
  `uploadPluginFromGit` ships.
- **Default-pool starvation.** If operators over-segregate (every worker tagged, none default),
  untagged manager activities stall. Do we enforce "≥1 default-serving pool" at deploy time, or just
  document it?
- **Shadowing surprises (§1b).** A user-scoped `foo` silently shadowing shared `foo` is powerful but
  could confuse ("why is my session running an old agent?"). Is shadow-by-default right, or should
  overriding a shared name require an explicit opt-in?

## Impact on Existing Proposals

- [plugin-packaging-and-distribution.md](./plugin-packaging-and-distribution.md) — extended, not
  replaced: new sources, scope dimension, and a revised roster model (§1c) for user scope.
- [session-owner-association-and-filtering.md](./session-owner-association-and-filtering.md) — its
  deferred "Phase 2 ownership-aware authz" becomes a v1 requirement (§3a); its tables become the
  tenant key.
- [session-stats-management-api.md](./session-stats-management-api.md) /
  [skill-usage-stats-management-api.md](./skill-usage-stats-management-api.md) — feed per-tenant
  quota enforcement (§3b).
- [portal-auth-provider-and-authz.md](./portal-auth-provider-and-authz.md) /
  [entra-auth-gateway.md](./entra-auth-gateway.md) — host the new admin scopes (§3c).
- [aks-topology.md](../aks-topology.md) / [deploying-to-aks.md](../deploying-to-aks.md) — gain
  one worker Deployment per node type, each with its `workerTags` and image.
