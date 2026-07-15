# User / Admin Security Model — Ownership, Visibility, and Message Identity

**Status:** Draft / RFC
**Date:** 2026-07-14
**Scope:** Web API + portal authorization, session visibility & sharing, message provenance, shared-store scoping

## Summary

PilotSwarm authenticates well and authorizes almost nothing. Entra ID (or `none`)
produces a normalized principal, a deny-by-default admission engine assigns
`admin` / `user`, and every session is durably stamped with its creating
principal — but once admitted, a `user` can list, read, message, rename, and
delete **any** session in the fleet. Ownership is display metadata, not a
boundary. Exactly 7 of ~90 operations are role-gated
(`packages/sdk/api/src/protocol.js` `admin: true`).

This proposal turns the existing identity plumbing into an actual security
model, in four moves:

1. **Make ownership an enforcement boundary.** Users see and act on their own
   sessions; admins see the fleet. (The long-deferred "Phase 2" of
   [portal-auth-provider-and-authz.md](./portal-auth-provider-and-authz.md).)
2. **Add session visibility & sharing.** A session is `private` (default),
   `shared_read`, or `shared_write` — deployment-wide — plus targeted
   per-user grants. Access resolves at the **session-tree root**, so sharing a
   session shares its sub-agent tree.
3. **Carry sender identity on every message.** A structured, server-stamped
   `sender` rides the message payload and the `user.message` event, is
   surfaced to the agent in multi-writer sessions, and drives answer
   attribution and audit. It is **never** the security boundary — enforcement
   stays at the API edge.
4. **Classify every operation** in the protocol table (`access:` metadata
   replacing the binary `admin:` flag) so the generated router enforces the
   matrix declaratively, with SQL-level filtering as defense in depth.

## Relationship to prior work

| Proposal | What it established | What this proposal does with it |
|---|---|---|
| [session-owner-association-and-filtering.md](./session-owner-association-and-filtering.md) | `users` + `session_owners` tables, owner stamping, child inheritance, UI filtering — **shipped** (migrations 0008–0028) | Promotes it from classification to authorization, unchanged schema |
| [portal-auth-provider-and-authz.md](./portal-auth-provider-and-authz.md) | Provider-pluggable authn, normalized principal, authz engine, roles — **shipped** through Phase 2.5 (app roles, deny-by-default) | Implements its Phase 2 (ownership enforcement) and extends it with sharing, which it never designed |
| [entra-auth-gateway.md](./entra-auth-gateway.md) | Role sketch (owner/admin/user), facts scoping table | Adopts its user/admin split; defers the third "owner" tier (see Open Questions) |
| [multitenant-pilotswarm.md](./multitenant-pilotswarm.md) | Ownership-as-tenant-key, admin scopes, tenant-scoped facts (§3a/§3c/§3e) | This is its §3a "authz layer", designed concretely; plugin/worker scoping stays there |

## Current state (verified against code, v0.5.13)

**What exists and works:**

- AuthN: `packages/app/web/auth/` — Entra JWT via `jose`/JWKS, normalized
  `AuthPrincipal { provider, subject, email, displayName, groups, roles }`,
  admission via app roles → email allowlists → `PORTAL_AUTHZ_DEFAULT_ROLE`
  (default `none` = deny). Roles: `admin`, `user`, `anonymous`.
- Identity catalog: `users` (`cms-migrations.ts:970`), `session_owners`
  (`:983`), `session_group_owners` (`:2847`). Owner stamped at create
  (`runtime.js:361-379`), inherited down spawn trees via
  `resolveEffectiveSpawnOwner` (`cms.ts:393-421`), local TUI uses
  `LOCAL_DEFAULT_USER_PRINCIPAL`, system sessions use `SYSTEM_USER_PRINCIPAL`.
- Per-owner credential resolution (GitHub Copilot keys) already keys off
  ownership — proof the identity spine works.
- Proto-ACL precedent: sessions cannot move into a group owned by a different
  user (`management-client.ts:981-999`).

**The gaps (the actual attack/exposure surface for an admitted `user`):**

| # | Gap | Where |
|---|---|---|
| 1 | Any session readable/actionable by id — get, events, history, delete, rename, model-switch, send | `runtime.js:176-472` — no owner check on any session op |
| 2 | Fleet-wide `listSessions`; owner filter is UI-only | `runtime.js:176`, filter in `ui/core/selectors.js` |
| 3 | WebSocket: any admitted client subscribes to any session's live events + log tail | `api/ws.js:50-64` — admission at connect only |
| 4 | Artifacts: read/write/delete/copy across any session | `artifact-tools.ts`, artifact routes keyed by sessionId only |
| 5 | Messages carry no sender; agent sees only free-text `from=<sessionId>` markers | `management-client.ts:2100-2148`, `session-messages.ts:123` |
| 6 | Facts: only per-role scoping in the system (non-admin → `shared` scope reads); session facts otherwise unscoped by user | `management-client.ts:1832-1839` |
| 7 | Graph + fleet metrics + group ops: no scoping | `runtime.js:332-355`, fleet routes |
| 8 | `anonymous` (no-auth deployments) = admin | `router.js:81-84` — intentional, kept |

## Threat model

In scope — a **curious or careless admitted user** (or their compromised
token / a prompt-injected agent driving the Web API with their token):
reading colleagues' session transcripts and artifacts, steering or deleting
others' sessions, exfiltrating private facts. Multi-user deployments on a
shared stamp (the pilotswarm-aks posture) are the target environment.

Out of scope — hostile tenants running untrusted plugin code (that is
[multitenant-pilotswarm.md](./multitenant-pilotswarm.md)'s isolation problem);
a compromised worker (workers remain trusted backend infrastructure with
direct DB access); Entra itself.

## Design principles

1. **Enforce at the server boundary, filter in SQL.** The dispatch chokepoint
   (`runtime.js call()`) and generated router enforce; list procs filter.
   Never return-then-filter client-side.
2. **The LLM is not a security boundary.** Identity given to the agent is for
   attribution, routing, and personalization. An agent must never be the
   thing that *prevents* an unauthorized action.
3. **Deny-by-default for new surface, compatibility switch for old.** Existing
   single-team deployments keep working via a deployment default.
4. **One identity spine.** `(provider, subject)` from the existing `users`
   table is the only principal key. No parallel identity systems.
5. **The session tree is the unit of access.** Sub-agents are implementation
   details of their root session; sharing/visibility resolves at the root.
6. **Admins are operators, not ghosts.** Admin access to others' private
   sessions is allowed but audited — break-glass with a paper trail, not
   invisible omniscience.

## Roles

Keep the two shipped roles. Do **not** add a third tier yet (see Open
Questions for the `owner`/`auditor` discussion).

- **`user`** — a person doing their own work: creates sessions, collaborates
  on sessions shared with them, reads the shared knowledge stores.
- **`admin`** — a fleet operator: everything a user can do, plus fleet-wide
  visibility, any-session management, system sessions, Tier-2 operational
  surface (embedder, graph namespaces, purge, system keys), and (future)
  role/user management.
- **`anonymous`** — no-auth deployments only; remains equivalent to admin.
  Single-principal deployments have nothing to isolate; every feature here is
  inert there.

### Capability matrix

Capability classes (each protocol op gets exactly one — see Enforcement):

| Class | Operations (representative) | user | admin |
|---|---|---|---|
| `authed` | list models/agents, policy, bootstrap, own profile, health | ✅ | ✅ |
| `session:create` | createSession, createSessionForAgent (still subject to session-creation policy) | ✅ | ✅ |
| `session:read` | getSession, events (+WS subscribe), history, metrics, artifacts list/download, child outcomes, status waits | own + shared_read + shared_write + granted | all |
| `session:write` | sendMessage, sendAnswer, sendSessionEvent, cancelPendingMessage, stopTurn, artifact upload, copyArtifact (read on source **and** write on target) | own + shared_write + granted(write) | all |
| `session:manage` | rename, setSessionModel, cancel, complete, exportExecutionHistory, artifact delete/pin, group assign/move | own | all |
| `session:destroy` | deleteSession | own | all |
| `session:share` | set visibility, grant/revoke shares (new ops) | own | all |
| `group:*` | session-group CRUD — same read/write/manage split, keyed on `session_group_owners` | own groups | all |
| `facts:read` | readFacts, searchFacts, similarFacts | shared scope + facts of readable sessions | all |
| `facts:write` | storeFact, deleteFact | shared scope + own-session scopes | all |
| `graph:read` | node/edge search, neighbourhood, stats, list namespaces | ✅ (fleet-global, unchanged) | ✅ |
| `graph:write` | upsert/delete nodes+edges | ✅ v1 (see Open Questions) | ✅ |
| `fleet:read` | fleet stats, all-user stats, top emitters, worker count, log tail | ❌ (own-user stats only) | ✅ |
| `fleet:admin` | embedder start/stop, purge, graph namespaces, system Copilot key, restartSystemSession, pruneDeletedSummaries | ❌ | ✅ |

System sessions: **metadata-visible to users read-only by default**
(preserves the shipped "System + Me" filter UX), interaction and restart
admin-only. A deployment that wants them hidden sets
`SESSIONS_SYSTEM_VISIBILITY=admin`.

Legacy/unowned sessions (pre-ownership rows): admin-visible only. No
backfill; they age out.

## Session access model

### Ownership (exists) + visibility (new) + shares (new)

```sql
-- migration 00NN, with companion diff file per cms-migrations.ts conventions
ALTER TABLE sessions
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private',
    -- 'private' | 'shared_read' | 'shared_write'
  ADD COLUMN root_session_id TEXT;   -- stamped at create: parent's root, else self

CREATE TABLE session_shares (
  session_id  TEXT   NOT NULL,          -- always a ROOT session id
  user_id     BIGINT NOT NULL REFERENCES users(user_id),
  access      TEXT   NOT NULL,          -- 'read' | 'write'
  granted_by  BIGINT REFERENCES users(user_id),
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, user_id)
);
```

- `visibility` is deployment-wide sharing: `shared_read` = every admitted
  user may read; `shared_write` = every admitted user may read and interact.
- `session_shares` is targeted sharing to specific users, same two levels.
  Both mechanisms coexist; effective access = max(visibility grant, targeted
  grant, ownership, admin).
- Only the owner (and admins) may change visibility or grants
  (`session:share`).
- **Deployment default for new sessions:** `SESSIONS_DEFAULT_VISIBILITY`
  (`private` recommended; `shared_write` reproduces today's everyone-sees-
  everything for small trusted teams and is the migration-day setting).

### Tree semantics

Access resolves at the **root session**: `root_session_id` is stamped at
create (self for top-level; parent's root for spawns, alongside the existing
`resolveEffectiveSpawnOwner` walk in `session-proxy.ts:1316-1322`). All
access checks and list filters join through the root's owner, visibility, and
shares. Consequences:

- Sharing a session shares its whole sub-agent tree — matching how tree
  stats, child outcomes, and artifacts already roll up.
- Children cannot have divergent sharing (v1 simplification).
- No recursive CTE per check; list filtering is one join.

### Ownership predicate

```
canRead(p, s)  := isAdmin(p) || isOwner(root(s), p) || root(s).visibility in (shared_read, shared_write)
                  || share(root(s), p) in (read, write)
canWrite(p, s) := isAdmin(p) || isOwner(root(s), p) || root(s).visibility = shared_write
                  || share(root(s), p) = write
canManage(p, s):= isAdmin(p) || isOwner(root(s), p)
```

`isOwner` compares `(provider, subject)` via the existing `session_owners`
join — same predicate the portal-auth proposal specified.

### What follows session access automatically

- **Events & WebSocket:** `subscribeSession` checks `canRead` at subscribe
  time (`api/ws.js`); the REST catch-up paths check in the dispatcher. Log
  tail (`subscribeLogs`) becomes `fleet:read` (admin).
- **Artifacts:** every artifact op resolves its session and applies the
  session predicate. `copyArtifact` = `canRead(source) && canWrite(target)`.
- **Metrics/history/status:** `session:read`.

## Message identity & provenance

### The record (server-stamped, never client-supplied)

Every enqueued message and its `user.message` event gain a structured sender:

```ts
sender: {
  kind: "user" | "agent" | "system",
  provider?: string,  subject?: string,   // users: identity key
  display?: string,                        // "Affan Dar" — for rendering/prompt
  relation?: "owner" | "collaborator" | "admin", // vs the session owner, at send time
  sessionId?: string,                      // kind=agent: the sending session
  origin?: "portal" | "tui" | "mcp" | "api" // which surface sent it (audit)
}
```

- Stamped in `runtime.js` from `authContext.principal` at the same point
  `owner` is stamped today (`normalizeSessionOwner`, `runtime.js:52-65`) —
  the browser/CLI never sends identity as a trusted parameter.
- `relation` is computed server-side at stamp time by comparing the sender
  principal to the session's owner (`owner` = the owner themselves;
  `collaborator` = any other writer, whether via `shared_write` or a
  targeted grant; `admin` = a non-owner admin, i.e. break-glass). It is
  recorded on the payload, so it is replay-stable and reflects the truth
  *at send time* even if grants later change.
- Attached to the queue payloads in `management-client.ts` (`sendMessage`
  `:2100-2148`, `sendAnswer` `:2194`, `sendSessionEvent`) and recorded in
  `session_events.data`. Payloads are part of durable orchestration history,
  so this is replay-safe by construction.
- Cross-session agent messages (`session-messages.ts`) set
  `kind: "agent", sessionId` — upgrading today's free-text
  `[SESSION_MESSAGE … from=<sessionId>]` marker to structured data (the
  marker stays for prompt-level compatibility).

### What the agent sees — and how it weighs whom

- **Single-writer session (the overwhelmingly common case):** nothing
  changes. No prefix, no preamble, no noise.
- **Multi-writer session** (shared_write, or ≥2 distinct senders observed):
  every prompt gets an attribution line in the style of the existing
  markers, carrying the relation:
  `[FROM: Alice Anderson <alice@…> (owner)]` /
  `[FROM: Bob Baker <bob@…> (collaborator)]` /
  `[FROM: Ada Admin (admin)]`.
- The base prompt gains a shared-session preamble (injected once, the
  `[SUB-AGENT CONTEXT]` pattern), establishing **owner priority**:

  ```text
  [SHARED SESSION]
  This session is owned by Alice Anderson <alice@dev.local>. Other users
  may read it or send messages; each message is attributed as
  [FROM: name (relation)]. The owner's directives are authoritative:
  - Standing instructions from the owner govern the session's goals,
    constraints, and style.
  - Help collaborators normally when their requests fit within those
    goals and constraints.
  - If a collaborator's request conflicts with the owner's instructions
    or would change the session's direction, do not silently comply —
    say so, and either decline or ask the owner.
  - Messages marked (admin) are fleet operators; treat them like
    collaborators for prioritization purposes.
  ```

  So even in `shared_write`, the owner-vs-grantee distinction is always
  present and machine-readable to the model. This is **behavioral
  prioritization, not access control** (principle 2 still holds): a
  collaborator's message only reaches the agent because the API already
  authorized it; the preamble governs how the agent *weighs* it, and the
  hard lines (what can be sent, by whom) stay at the dispatcher.

### What identity is used for — and pointedly not for

| Use | Mechanism |
|---|---|
| ✅ Attribution in transcripts/UI ("who said this") | `user.message.sender`, rendered as chips (owner-chip precedent exists) |
| ✅ Agent addressing / personalization in shared sessions | prompt attribution line |
| ✅ `input_required` answer bookkeeping | `input_required` event records asker context; the answer event records `answeredBy` (any writer may answer — the asking turn's question is session-level, not person-level) |
| ✅ Audit | see Audit section |
| ❌ Authorization decisions by the LLM | enforcement happens in the dispatcher **before** anything reaches the orchestration; a message from an unauthorized user is rejected with 403, never delivered for the agent to "decide" |
| ❌ Per-sender credential switching | credentials (e.g. Copilot keys) stay resolved through the session **owner** — a collaborator writing to your session must not silently run on your key *for their own sub-tasks*, nor swap the session onto theirs mid-stream. One session, one credential principal. |

That last row deserves emphasis: the moment message-sender identity selects
credentials, a shared-write grant becomes a credential-delegation grant.
Keeping credentials owner-bound keeps "share" meaning exactly "share."

## Shared stores

- **Facts (v1):** keep the existing model — `shared` scope readable by all
  admitted users and writable by all (it is the deployment's collaboration
  memory); session-scoped facts follow the session predicate (readable/
  writable iff the session is). This replaces the current blunt
  "non-admin reads shared-only" rule in `_scopeReadForRole`
  (`management-client.ts:1832-1839`) with session-aware scoping. Per-user
  private fact scopes are deferred to multitenant §3e.
- **Graph (v1):** unchanged fleet-global read/write; namespace admin ops stay
  `fleet:admin`. Per-namespace ACLs are a multitenant concern.
- **Artifacts:** fully covered by session access above; no schema change.

## Enforcement architecture

One declarative classification, three enforcement layers:

1. **Protocol metadata** (`packages/sdk/api/src/protocol.js`): replace the
   binary `admin: true` with `access: "<class>"` from the matrix and, for
   session-scoped ops, `resource: { sessionId: "path" }` telling the router
   where the id lives. The generated route loop in `api/router.js:150-169`
   grows one middleware: resolve resource → evaluate predicate → 403 with the
   authz reason. The 7 current `admin: true` ops map to `fleet:admin`
   unchanged. MCP tool registration already keys off capabilities; it reuses
   the same classification (non-admin web-mode MCP simply loses tools it
   can't call, exactly as `ctx.admin` gating works today, `context.ts:121-130`).
2. **Dispatcher** (`packages/app/web/runtime.js call()`): defense-in-depth
   re-check at the single dispatch chokepoint (the pattern the system Copilot
   key ops already use, `runtime.js:234-250`), because some ops arrive via
   JSON-RPC rather than generated routes.
3. **Stored procedures**: `cms_list_sessions` / paged variant gain
   `(p_viewer_user_id, p_is_admin)` and filter via the root-join — the list
   never contains rows the caller can't read. Same for group listing.
   Point-reads return not-found for unreadable ids (avoid existence oracles).

Per-op cost: one indexed join on `session_owners` + `session_shares` via
`root_session_id` — negligible against LLM-turn latencies; list procs stay
keyset-paginated.

**Config surface (all provider-neutral, extending the existing envs):**

```bash
SESSIONS_DEFAULT_VISIBILITY=private        # private | shared_read | shared_write
SESSIONS_SYSTEM_VISIBILITY=read            # read | admin
AUTHZ_ENFORCE_OWNERSHIP=true               # false = today's behavior (migration switch)
```

`AUTHZ_ENFORCE_OWNERSHIP=false` keeps the classification live but the
predicate permissive — deployments can observe would-be denials in audit
before flipping to enforce (dark-launch).

## Audit

Minimal, purpose-built (not a SIEM): an `authz_audit` CMS table +
`security.audit` session events recording:

- admin access to a non-owned, non-shared session (the break-glass read)
- share grants/revocations and visibility changes (who, what, when)
- denied operations (op, principal, resource, reason) — also the
  dark-launch signal
- `fleet:admin` operations (extends the existing `changedBy` precedent on the
  system Copilot key)

Admins can read the audit surface; users can read audit rows about their own
sessions ("who accessed my session").

## What each of the motivating questions resolves to

1. **Should users see only their own sessions?** Yes — private-by-default,
   plus what is explicitly shared with them and (read-only) system sessions.
   `SESSIONS_DEFAULT_VISIBILITY=shared_write` preserves the current
   trusted-team behavior per deployment.
2. **Private / shared-read / shared-write declarations?** Yes — a
   `visibility` enum on the root session for deployment-wide sharing, plus
   `session_shares` for targeted grants. Owner-only to change. Shares apply
   to whole session trees.
3. **Should messages carry sender identity?** Yes, structurally and
   server-stamped, on every payload and event — surfaced to the agent only in
   multi-writer sessions, used for attribution/routing/audit, and explicitly
   **not** used for LLM-side authorization or credential selection.
4. **Admin vs user?** Users get full power over their own trees and
   collaboration on shared ones; admins add fleet-wide visibility+management,
   system sessions, and the Tier-2 operational surface — with break-glass
   access audited.

## Phased rollout

Each phase independently shippable; order chosen so schema and provenance
land before behavior changes.

1. **Phase 1 — Classification + plumbing (no behavior change).**
   `access`/`resource` metadata on every protocol op; `root_session_id` +
   `visibility` columns (default keeps semantics); viewer-aware list procs
   (permissive); message `sender` stamping + `user.message` event field;
   audit table logging would-be denials. `AUTHZ_ENFORCE_OWNERSHIP=false`.
2. **Phase 2 — Enforcement.** Flip the predicate live: owner-or-admin on
   read/write/manage/destroy, WS subscribe gating, artifact/event/facts
   session-scoping, fleet surface admin-only, list filtering. Ship with
   `SESSIONS_DEFAULT_VISIBILITY=shared_write` on existing stamps, `private`
   for new installs.
3. **Phase 3 — Sharing UX.** `session:share` ops (`setSessionVisibility`,
   `grantSessionShare`, `revokeSessionShare`, `listSessionShares`), portal
   share dialog + visibility chips (owner-chip UI precedent), MCP parity
   tools, multi-writer prompt attribution.
4. **Phase 4 — Hardening.** Group-level sharing, per-user fact scopes,
   user-management API (v2 lifecycle below), quota hooks (multitenant §3b).

## Resolved decisions (2026-07-14 review)

1. **Two roles only.** No third `owner` tier; audited admin break-glass
   covers it. Revisit only if a deployment demands admin-proof privacy
   (which really wants encryption, not another role).
2. **Graph writes stay open to users in v1.** Fleet-global knowledge store
   semantics; revisit with multitenant namespace ACLs.
3. **`stopTurn` = `session:write`, `cancel` = `session:manage`.** Confirmed.
4. **Any writer may answer `input_required`.** No per-question binding; the
   answer event records `answeredBy`.
5. **Migration:** existing owned sessions get the deployment default
   visibility; unowned legacy rows stay admin-only. No claim flow.
6. **No PilotSwarm-issued tokens, period.** PilotSwarm has no token
   issuance today and this proposal adds none: every bearer is IdP-issued
   (Entra), including `PILOTSWARM_API_TOKEN`, which is just a
   pass-through slot for an Entra token (typically a service-principal
   client-credentials token) used by headless MCP
   (`packages/app/mcp/src/auth.ts:77-107`). Service principals appear as
   ordinary `users` rows (subject = SP object id; note SP tokens carry no
   email, so they need an app-role assignment, not an email allowlist).
   Consequence to document loudly: **revocation is entirely IdP-side** —
   remove the app-role assignment and access ends when the current token
   expires (~1 h). PATs/scoped machine tokens are out of scope
   indefinitely.

## User lifecycle

### v1 — lazy, immortal profiles (confirmed)

A `users` row is created the first time a principal is sighted
(`cms_register_user`, first-seen-write-wins) and never updated, deactivated,
or deleted. This is correct **because the row grants nothing**:

> The `users` table is an **attribution catalog, not an access list.**
> Access is decided per-request from the live token (role claim / allowlist
> / default policy). A row's existence confers zero permissions.

Implications accepted for v1:

- **Revocation is IdP-side only.** Remove the Entra app-role assignment →
  no new tokens → no access (≤ ~1 h token tail). The user's row, sessions,
  shares, and audit trail persist — which is exactly what attribution and
  audit require.
- **Departed users leave orphans.** Their private sessions remain
  admin-visible only; shares *granted to* them are inert (they cannot
  authenticate). Admins can delete/complete their sessions today; formal
  transfer comes in v2.
- **Display-name drift.** First-seen-write-wins means renames never
  propagate. One v1 amendment recommended: flip profile fields to
  **update-on-sighting** (`email`, `display_name` refreshed at each
  authenticated request that touches the row; identity key
  `(provider, subject)` untouched). The share dialog and audit views make
  stale names a real cost now; the original first-seen rule predates any
  UI that searches users by name.
- **Duplicate identities are distinct users.** The same human via member +
  guest accounts (or a future second provider) is two rows. Document it;
  merging is v2.
- **Synthetic principals are lifecycle-exempt.** `SYSTEM_USER_PRINCIPAL`
  and `LOCAL_DEFAULT_USER_PRINCIPAL` are `users` rows too; any future
  lifecycle tooling must refuse to touch them.
- **Never hard-delete a `users` row.** `user_id` is the FK spine for
  `session_owners`, `session_shares`, `granted_by`, and audit. Erasure (if
  ever required) = anonymize the profile fields in place, keep the row.

### v2 — user-management API (sketch, so v1 doesn't paint us in)

Admin-gated surface: `listUsers`, `getUser`, `deactivateUser` (soft flag —
blocks *sharing to* them and hides them from pickers; does **not** gate
authn, which stays IdP-truth), `transferSessionOwnership(from, to)` (bulk,
for departures), `mergeUsers` (duplicate identities), `anonymizeUser`.

The dangerous v2 temptation is **local role overrides** (the
entra-auth-gateway "effective role = max(IdP, local)" idea). If that lands,
two things change qualitatively: (a) the `users` table becomes an access
surface, so writes to it must be `fleet:admin` + audited from day one, and
(b) revocation stops being purely IdP-side — every access check must
consult both. Recommendation: if overrides come, allow them **downward
only** (an admin can demote/deactivate locally; promotion to admin stays
IdP-only), which preserves "Entra is the sole path to privilege" and keeps
the bootstrap story trivial (first admin = app-role assignment, as today).

## MCP surface

MCP is a thin client over the Web API, so **enforcement arrives for free**
— in web mode every tool call carries the caller's bearer and the server
decides. What actually needs doing:

- **`get_capabilities` reports the posture.** Add `role`,
  `ownershipEnforced`, and `defaultVisibility` beside the existing `admin`
  flag so an agent can explain *why* a session isn't listed or a send was
  refused, instead of guessing.
- **Parity tools for sharing** (per the mcp-web-api-parity convention):
  `set_session_visibility`, `grant_session_share`, `revoke_session_share`,
  `list_session_shares`. Registered for all callers — owner checks are
  server-side, same as every other op.
- **Tool descriptions get scoping language.** `list_sessions` becomes
  "lists sessions you can read"; `send_message` notes it requires write
  access. The MCP server instructions blurb likewise.
- **403s must carry the authz reason** through the MCP error payload
  ("session is private to Affan Dar") — the consumer is an LLM that will
  otherwise retry blindly.
- **Sender origin.** Messages sent via MCP are stamped with the
  authenticated human's principal like any API call, plus an
  `origin: "mcp" | "portal" | "tui" | "api"` field on `sender` — useful in
  audit ("was this the person or their agent?") and free to add now.
- **Direct mode (`--store`/`DATABASE_URL`) stays unconditionally admin**
  (`context.ts:151`) — possession of the DB credential is definitionally
  privileged, and direct mode is test-only anyway.
- **Blast-radius note:** an LLM driving MCP with a user's token has exactly
  that user's reach. Private-by-default therefore *shrinks* what a
  prompt-injected agent can touch — today it can touch the entire fleet.
  This is a headline benefit of the proposal, worth stating in SECURITY.md.

## UX sketches

Portal-first (shared react web-app); TUI gets glyph parity later.

### Session list — visibility at a glance

```text
┌ Sessions ─────────────────────────── [Filter ▾] [＋ New] ─┐
│ ● (ad) Deploy pipeline fix                    🔒          │
│ ● (ad) Q3 roadmap draft                       👁 +2       │
│ ● (rh) Perf investigation        shared by rh ✎ all      │
│ ○ (sys) Sweeper Agent                         ⛭ system   │
└───────────────────────────────────────────────────────────┘
  🔒 private · 👁 shared read (+N targeted grants) · ✎ shared write
```

Sessions the caller cannot read simply never arrive (server-filtered).
Non-owned-but-readable rows carry "shared by *owner*". The existing owner
filter keeps working; for a `user` it now filters within their visible set.

### Share dialog (owner or admin only)

```text
┌ Share "Deploy pipeline fix" ──────────────────────────────┐
│ Visibility                                                 │
│  ◉ Private       only you and admins                       │
│  ○ Shared read   everyone here can view                    │
│  ○ Shared write  everyone here can view and send           │
│                                                            │
│ People (grants on top of visibility)                       │
│  [ search users…                          ]  [Add]         │
│  rh  Radhakrishna Hari      [can write ▾]   ✕              │
│  jd  Jane Doe               [can read  ▾]   ✕              │
│                                                            │
│ ⓘ Applies to this session and its 4 sub-agents.            │
│                                     [Cancel]   [Save]      │
└────────────────────────────────────────────────────────────┘
```

The people-picker searches the `users` catalog — the concrete reason to
adopt update-on-sighting profile fields (lifecycle section).

### Viewing a shared session — read vs write

```text
read grant:
│ (ad) Deploy pipeline fix — shared by Affan Dar · read-only │
│ …transcript…                                                │
│ [ composer disabled: "You have view access. Ask the owner   │
│   for write access to participate." ]                       │

write grant — transcript grows sender chips, composer is live:
│ ad Affan Dar    › ship it to staging                        │
│ rh Radhakrishna › hold on — run the perf suite first        │
│    Agent        ✓ Running perf suite (requested by rh)…     │
```

Single-writer sessions render exactly as today — chips and `[FROM:]`
prompt attribution appear only once a second writer shows up.

### Admin break-glass

```text
┌ Open (jd) "Vendor contract review"? ──────────────────────┐
│ This session is private to Jane Doe.                       │
│ Opening it records an entry in the audit log.              │
│                        [Cancel]      [Open (audited)]      │
└────────────────────────────────────────────────────────────┘
```

Admin Console gains an **Audit** tab (grants, break-glass reads, denials,
Tier-2 ops); the owner's stats inspector gains "Access" showing who has
grants and any admin reads of their session.

## Testing

The multi-user matrix is tested through the **`dev` auth provider** — five
predefined personas (`ada` admin; `alice` owner; `bob` write grantee;
`carol` read grantee; `dave` stranger) authenticating as `Bearer
dev:<persona>` through the real middleware stack, per-tab in the browser
and via `PILOTSWARM_API_TOKEN=dev:<persona>` for MCP/headless. Full
provider design, guards, and the S1–S9 scenario suites (visibility, read/
write grants, owner-priority prompting, admin break-glass, tree semantics,
MCP parity, lifecycle, dark-launch diff) live in
[dev-auth-provider-and-multiuser-test-plan.md](./dev-auth-provider-and-multiuser-test-plan.md).

One **real-Entra confirmation pass** on pilotswarm-aks remains mandatory
before ship (the dev provider bypasses JWT validation): `daraffan`
(admin) plus one invited guest user (`user` app role), walking the core
scenarios in a normal+incognito pair; optionally a service principal via
client-credentials for headless coverage (SP tokens carry no email claim —
app-role assignment, not allowlist).

Repo-tier mapping: CMS tests pin the predicates and viewer-filtered procs;
contract tests assert every protocol op carries an `access` class (lint —
new op without classification fails CI) and the 401/403/404/4403
semantics; orchestration tests assert sender/relation ride replay and the
shared-session preamble appears only in multi-writer sessions.

## Open questions

*(none — all resolved above)*
