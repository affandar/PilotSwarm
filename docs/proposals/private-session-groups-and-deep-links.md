# Private Per-User Session Groups and Reliable Deep Links

**Status:** Draft / RFC
**Date:** 2026-07-16
**Scope:** session-group persistence, sharing boundaries, viewer-scoped catalog
responses, portal/TUI organization, and deep-session navigation

## Summary

PilotSwarm currently stores a session's visual group in
`sessions.group_id`. That makes group placement global: every viewer receives
the same `groupId`, and moving a session changes the shared session row.

This conflicts with the multi-user sharing model. Groups are private user
organization, not shared session metadata:

- sharing grants access to a session tree, never to the owner's groups;
- a shared session initially appears at the recipient's root;
- each viewer may place that session into one of their own groups;
- one viewer's placement must never affect or be visible to another viewer.

This proposal moves group membership into a per-user placement table and makes
all group reads and mutations viewer-scoped. It also fixes deep links such as
`?session=<id>` so an explicit readable target wins over collapsed groups,
saved filters, and delayed profile hydration. A link does not itself grant
access; it navigates to a session the caller can already read.

## Relationship to existing security work

This proposal extends
[user-admin-security-model.md](./user-admin-security-model.md), which defines
session ownership, tree-root sharing, and the `canRead` / `canWrite` /
`canManage` predicates.

The important separation is:

| Concern | Authority | Shared across users? |
|---|---|---|
| Session ownership | `session_owners` | Yes |
| Session-tree access | root visibility + `session_shares` | Yes |
| Session hierarchy | `parent_session_id` / `root_session_id` | Yes |
| Group ownership | `session_group_owners` | No |
| Session placement in a group | new viewer placement table | No |
| Collapsed groups, selection, filters | viewer profile/local UI state | No |

Groups grant no session access. Session access grants no access to the owner's
groups.

## Current state and failure modes

The current implementation has one global placement:

- `sessions.group_id` stores the group on the session row.
- `cms_assign_session_group()` updates that column.
- The assignment procedure requires the session owner to match the group
  owner.
- Child creation inherits the parent's `group_id`.
- `buildSessionTree()` places a top-level session under the synthetic
  `group:<groupId>` row from the session response.
- The move picker filters candidate groups by the selected sessions' owner.
- `listSessionGroups` loads the catalog and the web runtime filters foreign
  groups after retrieval.

That behavior produces two distinct problems.

### Shared-session organization is impossible

A recipient cannot place a shared session in their own group because:

1. the group and session have different owners;
2. the move operation is classed `group:manage`, and its per-session gate
   additionally requires `session:manage` on every moved session, which
   recipients do not have;
3. even if allowed, the operation would overwrite the owner's placement.

Returning the source `groupId` to the recipient is also a privacy leak. Even if
the group row is filtered out, its identifier reveals private organization and
creates an inconsistent tree where the session references an unavailable
container.

### Explicit deep links can silently lose selection

The portal parses `?session=<id>` and calls `loadSession()`, but selection is
later reconciled against the flattened visible tree.

Groups start collapsed. `applyVisibleSessionSelection()` currently checks
whether the active session is visible before expanding its group ancestors.
With the default owner filter active, the linked session is treated as hidden
and selection falls back to the first visible session. Delayed profile
hydration can then overwrite the explicit target again with a persisted
`activeSessionId`.

The result is a valid link that silently opens the default page. Errors are
also swallowed by the portal's current `.catch(() => {})`, making an
inaccessible target indistinguishable from a navigation race.

## Design principles

1. **Groups are private presentation state.** A group belongs to exactly one
   user and is visible only to that user.
2. **Placement is viewer-specific.** The same session tree may be placed
   differently by every viewer who can read it.
3. **Access and organization are independent.** Moving a shared session
   requires read access, not ownership or write access, and confers no new
   authority.
4. **The session tree remains global.** `parent_session_id` and
   `root_session_id` continue to define real orchestration relationships.
5. **Only roots are placed.** Descendants render below their real parent and
   cannot be independently moved into visual groups.
6. **Foreign organization never crosses the API boundary.** Viewer-scoped
   responses contain only the caller's effective placement.
7. **Explicit navigation wins.** A readable deep-link target takes precedence
   over persisted selection and transient visibility state.
8. **No silent fallback.** Failure to open an explicit target is surfaced to
   the user without revealing whether an inaccessible session exists.

## Data model

Use the existing `users`, `sessions`, `session_groups`, and
`session_group_owners` tables. Add a placement table keyed by user and session
tree root:

```sql
CREATE TABLE user_session_group_placements (
    user_id         BIGINT NOT NULL
                    REFERENCES users(user_id) ON DELETE CASCADE,
    root_session_id TEXT NOT NULL
                    REFERENCES sessions(session_id) ON DELETE CASCADE,
    group_id        TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, root_session_id),
    FOREIGN KEY (group_id, user_id)
        REFERENCES session_group_owners(group_id, user_id)
        ON DELETE CASCADE
);
```

Add a unique constraint on `(group_id, user_id)` to
`session_group_owners` so the composite foreign key is valid. The existing
`group_id` primary key still guarantees one owner per group.

Add a supporting index on `user_session_group_placements (group_id, user_id)`
for group aggregates and owner-side cascades. PostgreSQL does not index the
referencing side of a foreign key, and the primary key on
`(user_id, root_session_id)` does not cover group-keyed reads.

**Removed behavior:** the composite foreign key forbids placement rows for
ownerless groups. This deliberately removes the migration-0020 behavior where
an empty ownerless group adopted the first mover's owner. New groups always
create their `session_group_owners` row atomically; legacy ownerless groups
are handled by migration only (see below).

Use `users.user_id`, not a second `(provider, subject)` identity copy. API
procedures resolve the authenticated principal through the existing users
catalog.

### Placement invariants

- `(user_id, root_session_id)` is unique: a viewer sees a tree in at most one
  group.
- `group_id` belongs to the same `user_id`; cross-user placement is
  structurally impossible.
- `root_session_id` must identify a live top-level tree root. Mutation
  procedures accept any readable session ID but normalize it through
  `cms_resolve_root_session()` before writing.
- No placement row means "No Group" for that viewer.
- System sessions are not placeable in v1, preserving their fleet-defined
  location and behavior.
- Soft deletion hides the session through existing catalog predicates. Hard
  session deletion cascades the placement.
- Deleting a group cascades only that user's placement rows. It never modifies
  or deletes sessions.

Direct table writes should remain an internal CMS concern. Stored procedures
must validate root normalization and access before mutation.

### Revocation retention

Retain a recipient's placement when access is revoked, but make it invisible
because all placement reads join through the viewer's current `canRead`
predicate.

This treats organization as the recipient's private preference and restores
it if the session is re-shared. It does not leak session existence: group
counts and listings exclude inaccessible placements, and point reads continue
to use the same not-found response as an unknown session.

Hard deletion removes the row. A future privacy policy may add time-based
cleanup for inaccessible placements, but cleanup is not required for
correctness.

## CMS and API contract

### Viewer-scoped session catalogs

Viewer-scoped list and point-read procedures accept the authenticated
principal and left-join only that user's placement:

```text
effectiveViewerGroup(root, viewer) :=
    placement(viewer.user_id, root.session_id).group_id or null
```

Expose this value as `viewerGroupId` in external session DTOs. Do not expose
the legacy source `sessions.group_id`.

Internal unscoped/admin catalog calls have no implicit placement. An admin
looking at another user's session catalog still sees the admin's own
organization unless an explicit audit endpoint names another principal.
Ordinary admin privilege must not make private user layout visible by
accident.

During compatibility rollout, the UI transport adapter may map
`viewerGroupId` to its existing local `groupId` field. The persisted and public
semantics are nevertheless viewer-specific.

### Viewer-scoped group catalogs

Replace the load-all-then-filter pattern with a principal-scoped CMS query.
For a non-anonymous authenticated viewer it returns only groups owned by that
viewer.

Group aggregates count only:

1. placements owned by the viewer; and
2. session roots the viewer can currently read.

Foreign group names, identifiers, counts, latest activity, and sibling
sessions never enter the response.

Ownerless groups are legacy data, not a multi-user feature. New group creation
must atomically create its `session_group_owners` row. Migration handles
existing ownerless groups as described below.

### Placement mutation

Introduce a semantically explicit operation:

```text
placeSessionsInGroup(sessionIds, groupId | null)
```

Server behavior:

1. resolve the caller to `user_id`;
2. verify the target group belongs to that user, when non-null;
3. resolve every session ID to its tree root;
4. reject system sessions;
5. require `canRead(caller, root)` for every distinct root;
6. upsert each caller-owned placement, or delete it for `groupId = null`;
7. perform the batch atomically.

Read access is sufficient because placement changes no shared session data.
Read-only collaborators can organize their workspace without acquiring
session write or management rights.

Keep `moveSessionsToGroup` as a deprecated compatibility alias for one release
if needed, but change its server implementation to the caller-owned placement
operation. It must stop updating `sessions.group_id`.

### Group lifecycle operations

Group CRUD remains owner-only:

- create, rename, and delete require ownership of the group;
- deleting a non-empty group is safe once membership is presentation-only, so
  it may ungroup its placements through `ON DELETE CASCADE`;
- assigning and moving sessions changes only caller placement.

`cancelSessionGroup` and `completeSessionGroup` are deprecated rather than
respecified. They exist only at the transport layer today — no portal or TUI
surface calls them — and once a group is a heterogeneous-access container of
owned and shared sessions, atomic bulk authority would fail routinely. If
bulk actions return, they operate on the caller's currently visible
placements with per-target authorization and per-target results, and a group
still grants no authority.

### Session creation

`groupId` on `createSession` and `createSessionForAgent` becomes initial
viewer placement, not session metadata.

The server validates that the group belongs to the authenticated creator
before creating anything. CMS persistence writes the new session owner and
the owner's root placement in one transaction; orchestration startup follows
that commit. A child session ignores visual group input and follows its real
parent in the tree.

Stop passing group placement through orchestration or child-spawn options.

## Portal and TUI behavior

### Shared sessions

- A newly readable shared session appears at the viewer's root when the viewer
  has no placement.
- The move picker lists the current viewer's groups, not groups matching the
  session owner.
- Mixed-owner selections are allowed if every selected root is readable.
- Creating a group always stamps the authenticated viewer as owner; the UI
  must not infer group ownership from selected sessions.
- Moving or ungrouping a session refreshes only the viewer's effective
  catalog.
- The owner's original group is never rendered, named, or hinted.

The owner and recipient can therefore see:

```text
Owner                              Recipient
Release Investigation              Customer Follow-up
  Shared Session                     Shared Session
```

Both rows refer to the same session tree; the group containers are unrelated.

### Filters

The default authenticated catalog must include:

- sessions owned by me;
- sessions shared with me;
- visible system sessions.

The owner filter must provide first-class `Mine`, `Shared with me`, and
`System` buckets. Today a shared session maps only to a dynamically generated
per-owner bucket that is off by default, so without this change a newly
shared session is invisible until the recipient discovers the sharer's
bucket — which breaks the recipient-at-root promise. This filter change is a
hard rollout dependency, not a polish item (see Rollout).

### Share and copy-link UX

A URL is a locator, not a bearer grant.

- **Copy link** copies `?session=<root-or-selected-id>` and does not change
  access.
- **Share** first creates or updates visibility/targeted grants, then offers
  the link.
- Copying a link to a private session should warn that only current viewers
  with access can open it.

This keeps authorization explicit while making successful sharing produce a
usable navigation target.

## Deep-link navigation

### Initial selection precedence

Initial portal selection uses this strict priority:

1. explicit `?session=<id>`;
2. current in-memory selection;
3. persisted profile `activeSessionId`;
4. normal default selection.

Parse the deep-link target before controller startup and pass it as initial
navigation intent. Keep that intent latched until it resolves or fails so
asynchronous profile hydration cannot replace it.

Profile polling may continue after startup, but `profileSettings/apply` must
not overwrite a pending or successfully resolved explicit navigation target.

### Resolution flow

For an explicit target:

1. request the session through the viewer-scoped point-read API;
2. receive its real parent/root fields and the viewer's placement only;
3. merge it into the catalog;
4. expand its real parent chain and viewer group ancestor;
5. rebuild the flattened tree;
6. reconcile visibility and select the target;
7. load transcript/detail state.

Expansion must happen before `resolveVisibleActiveSessionId()`. The current
order incorrectly declares children of collapsed groups invisible and falls
back to another session.

If saved filters exclude the target, add a transient selector exception for
that session ID and show unobtrusive copy such as "Showing linked session
outside your current filters." Do not mutate or persist the user's filter.
The exception ends when the user navigates away or changes filters.

### Error behavior

Unknown and inaccessible IDs return the same server response to avoid an
existence oracle. The portal presents:

> This session was not found or has not been shared with you.

Do not silently select the default session. Remove the empty catch around
`loadSession()` and route the failure into explicit navigation state. Network
and server errors should retain their actual retryable error category rather
than being rendered as an access denial.

## Migration and compatibility

Ship the data change as a normal additive CMS migration with its companion
migration diff document.

1. Add `user_session_group_placements` and required indexes/constraints.
2. Backfill owner placement for each live root session with a current
   `sessions.group_id`:
   - resolve the root;
   - resolve the root owner;
   - verify the group has that same owner;
   - insert `(owner_user_id, root_session_id, group_id)`.
3. Deduplicate legacy child assignments by root. If a tree contains
   conflicting group IDs, prefer the root's assignment and report the anomaly
   in migration diagnostics.
4. Assign or quarantine ownerless legacy groups. Do not expose them to normal
   users. Existing groups containing owned sessions may adopt that single
   owner only when all live members agree; ambiguous groups remain admin-only
   until repaired.
5. Cut reads and writes over to placements in one step: switch viewer-scoped
   list/get/group procedures and mutation APIs to placements, and stop
   writing, updating, and inheriting `sessions.group_id`, in the same
   migration and release.

   There is deliberately no per-row legacy-read fallback. A missing placement
   row means "No Group"; falling back to the legacy column would resurrect a
   group the viewer explicitly removed, because ungrouping deletes the row
   and absence cannot distinguish "never placed" from "explicitly
   ungrouped". The backfill and the read cutover land atomically using the
   0029 steps-migration shape, and the single-web-writer topology makes the
   rolling window effectively zero.
6. After the cutover release, remove creation `p_group_id` from CMS session
   procedures and drop `sessions.group_id` in a later migration.

Migration preserves the owner's existing visual organization while shared
viewers correctly see those sessions at their own root.

## Security and privacy requirements

- No viewer-scoped payload of any shape may contain a foreign group ID or
  group-derived aggregate — session list rows, detail DTOs, access
  responses, and WebSocket/event payloads included. After cutover, no
  payload anywhere carries `sessions.group_id`.
- Placement procedures derive the actor from authenticated request context;
  clients cannot submit `user_id`, provider, or subject as trusted placement
  identity.
- A placement row never participates in `canRead`, `canWrite`, or
  `canManage`.
- Group bulk actions re-authorize sessions at execution time.
- Revoked/inaccessible placements do not contribute to counts, latest
  activity, search results, or pagination.
- Admin access to sessions does not implicitly expose another user's groups.
- Deep-link denial uses the same not-found shape as an unknown session.

## Test plan

Use the `dev` auth personas from
[dev-auth-provider-and-multiuser-test-plan.md](./dev-auth-provider-and-multiuser-test-plan.md)
to exercise the real HTTP stack.

### Data and authorization

- Alice places her root in group A; Bob, with read access, places the same root
  in group B. Each catalog returns only its viewer placement.
- Bob moves and ungroups the root without changing Alice's placement,
  `sessions.updated_at`, ownership, visibility, or grants.
- Carol has read-only access and can place the session but cannot send,
  rename, cancel, or otherwise mutate it.
- Dave cannot place an unreadable session by guessed ID.
- A child ID normalizes to its root; duplicate root/child selections produce
  one placement.
- Cross-user group IDs are rejected even when the caller can read the session.
- Deleting Bob's group removes only Bob's placement.

### Privacy

- Bob never receives Alice's group ID, title, description, member count,
  latest activity, or sibling sessions.
- Group pagination/counts exclude retained placements whose sessions are no
  longer readable.
- Admin session access still returns the admin's placement, not Alice's.
- Unknown and inaccessible deep-link targets have indistinguishable API
  responses.

### Sharing lifecycle

- A newly shared session appears at Bob's root.
- Revoking Bob removes it from his catalog and group aggregates while
  retaining an invisible placement.
- Re-sharing restores Bob's prior placement.
- Hard deletion cascades all placements.
- Deployment-wide visibility changes follow the same behavior as targeted
  shares.

### UI organization

- The move picker shows the signed-in viewer's groups for owned, shared-read,
  and shared-write sessions.
- Mixed-owner selections can be placed together when all are readable.
- A recipient never sees a synthetic source-group row.
- Creating a session while a group is active creates only the creator's
  placement.
- Child sessions remain under their parent and cannot be independently moved.

### Deep links

- Owned and shared targets open from root and from viewer groups.
- A target inside a collapsed group expands and remains selected.
- A child target expands both its real parent chain and viewer group.
- A saved owner/query filter temporarily reveals the explicit target without
  changing persisted settings.
- Delayed profile hydration cannot replace the explicit target.
- Paginated catalogs fetch a readable target not present in the first page.
- An inaccessible target displays the explicit safe error and does not fall
  back to another session.
- Retryable network failures are distinguishable from not-found/access
  failures.

### Migration and backfill

- Conflicting legacy child assignments in one tree resolve to the root's
  group and the anomaly appears in migration diagnostics.
- Backfill skips and reports rows whose group owner does not match the root
  owner.
- Single-owner legacy groups adopt that owner; ambiguous and ownerless
  groups are quarantined admin-only.
- Re-running the migration is idempotent.

### Enforcement matrix

- The authorization suite runs under both `AUTHZ_ENFORCE_OWNERSHIP=true` and
  `false`; permissive-mode placement behavior (placement allowed wherever
  read is allowed, still viewer-private) is pinned by explicit tests.

### Payload shape

- Schema-shaped assertions, not only behavioral ones: recipient-facing list
  rows, detail DTOs, access responses, and event payloads contain no
  foreign `groupId` / `group_id` key at all.

### Concurrency

- Two clients placing/ungrouping the same root concurrently resolve via
  upsert without error or cross-viewer bleed.
- Deleting a group concurrently with a placement insert surfaces a clean
  conflict error, not an internal failure.

### UI regression

- A TUI smoke test drives the shared-controller move picker.
- The profile-hydration first-apply path (initial hydration, before any
  local write) cannot displace a pending deep-link target.

## Rollout

1. Add placement schema and backfill, and cut placement reads and writes
   over in the same release (no dual-read window).
2. Add viewer-scoped catalog/group procedures and the placement mutation
   API.
3. Ship the default-filter change: the authenticated default catalog
   includes owned, shared-with-me, and visible system sessions, with a
   first-class `Shared with me` bucket. Hard dependency for the sharing UX.
4. Switch portal/TUI adapters and move/create-group flows.
5. Land deep-link precedence, ancestor expansion, transient filter reveal,
   and explicit errors.
6. Monitor migration diagnostics; in a later release remove creation
   `p_group_id` and drop `sessions.group_id`.

The rollout gate is a two-user test where the same shared session is visibly
organized into different groups in two browser tabs and a copied deep link
opens the intended session in both, without either user observing the other's
group.

## Decisions

- Groups are private per-user containers.
- Placement is keyed by `users.user_id` and session-tree root.
- Read access is sufficient to organize a session.
- Recipient placements survive revocation invisibly and reappear on
  re-sharing.
- Admins do not see foreign group organization through ordinary session
  APIs.
- Deep links do not grant access and never silently fall back.
- Placement cutover is atomic; there is no per-row legacy `group_id`
  fallback.
- Group bulk cancel/complete are deprecated rather than respecified;
  ownerless-group adopt-on-move (migration 0020) is removed.
