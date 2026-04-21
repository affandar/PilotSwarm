# Proposal: Auth User Association for Sessions

**Status:** Draft  
**Date:** 2026-04-20  
**Scope:** shared session catalog, management surfaces, shared TUI/web UI

## Summary

When portal auth is enabled, attach each non-system session to the authenticated user who created it, surface that owner in the UI, and add a session-owner filter.

This is intentionally a **classification and filtering feature**, not an authorization boundary:

- all authenticated users can still see all sessions
- system sessions remain visible to everyone
- owner metadata is used for display, filtering, and future extensibility
- no existing route or transport is denied based on ownership in this phase

## Requested UX

When auth is enabled:

- sessions created by authenticated users are associated with that user
- system sessions have no associated user
- session-list titles are displayed with owner initials as a prefix, for example `(ad) My new session`
- unowned non-system sessions are displayed as `(?) My old session`
- the stats inspector shows full owner name and email
- the top session toolbar removes `Rename` and `Refresh` and replaces them with `Filter`
- the filter dialog supports:
  - `All`
  - `System`
  - `Unowned`
  - `Me`
  - one or more specific users
- default filter is `System + Me`

When auth is disabled:

- no owner is attached
- no owner prefix is shown
- session filtering falls back to current behavior

## Goals

- persist durable owner association without copying profile fields onto `sessions`
- add a lazily populated users catalog for authenticated principals
- stamp owner association at session creation time
- inherit owner metadata to child sessions spawned from a user-owned parent
- keep system sessions explicitly unowned
- expose owner metadata through the existing management/session-list surfaces
- add owner-aware filtering in the shared TUI/web UI
- avoid mutating stored session titles just to show initials

## Non-Goals

- authorization or access control
- retroactive backfill of owner data for historical sessions
- background sync, cleanup, or lifecycle management for the users catalog
- changing system-session semantics
- changing rename rules beyond removing top-toolbar entry points

## Recommended Data Model

I think this is a good direction.

I would not put owner profile fields directly on `sessions` anymore. Instead, I’d split the design into:

1. a lazily populated `users` table
2. a tiny one-owner-per-session link table

That gives us:

- a stable identity record for each authenticated principal we have seen
- no duplicated display metadata across many session rows
- no need to mutate `sessions` with multiple auth-provider-specific columns
- a clean path to future authz or audit work

### `users` table

Recommended columns:

- `user_id BIGSERIAL PRIMARY KEY`
- `provider TEXT NOT NULL`
- `subject TEXT NOT NULL`
- `email TEXT NULL`
- `display_name TEXT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`

Recommended constraint:

- `UNIQUE (provider, subject)`

### `session_owners` link table

Recommended columns:

- `session_id TEXT PRIMARY KEY`
- `user_id BIGINT NOT NULL`
- `assigned_at TIMESTAMPTZ NOT NULL DEFAULT now()`

Recommended constraints:

- `session_id` references `sessions(session_id)`
- `user_id` references `users(user_id)`
- no row means "system or unowned"

This keeps ownership one-to-one without adding owner-specific columns to `sessions`.

### Lazy population rule

The `users` table is filled lazily when authenticated principals show up.

Phase-1 lifecycle rule:

- insert a user row when we first see a principal during session creation
- first-seen-write-wins for `email` and `display_name`; later sightings do not refresh profile fields
- do not run background sync
- do not delete stale users
- do not build admin tooling for this table yet

`owner_initials` should still be derived at render time, not stored.

## Why This Beats Session Owner Columns

A single `owner` display string is enough for a screenshot but not enough for a durable product surface.

Problems with copying owner details directly onto every session row:

- display name changes are not identity-stable
- email or display-name updates would be duplicated across many sessions
- it mixes identity-catalog concerns into the session row
- filtering by "me" becomes fuzzy if the display string changes
- future authz would still want a stable user catalog anyway

The `users + session_owners` approach lets us:

- reliably identify the creator
- show friendly display values
- keep sessions lean
- preserve a clean path for future authz or audit work

## Ownership Semantics

### Top-level session creation

If auth is enabled and the request has an authenticated principal:

- register a row in `users` for that principal if it does not already exist
- create a row in `session_owners` for the new session if it does not already exist
- do not overwrite an existing user row or session-owner link

If auth is disabled:

- do not create a session-owner row

### Child session creation

For non-system child sessions:

- inherit the parent session's `session_owners` link if present

For system child sessions:

- do not create a `session_owners` row even if they were spawned from a user-owned parent

### Existing sessions

Existing sessions remain unowned unless they get an owner link through new behavior.

UI should treat them as:

- `system` if `is_system = true`
- `unowned` otherwise

## UI Proposal

### Title display

Do not rewrite stored titles in CMS.

Instead, add a shared display-title formatter:

- owned user session: `(ad) My new session`
- system session: existing system-session formatting
- unowned session: `(?) My old session`

This owner-prefix formatter should be used only by the session list:

- session list

Other title surfaces should keep using the undecorated stored title:

- active session header
- inspector pane titles that include session title
- modal copy that references the current session title

The rename path should still operate on the underlying stored title, not the decorated display title.

### Owner initials

Initials generation:

1. use the resolved owner display name when available
2. fall back to the resolved owner email local-part
3. lower-case the rendered initials for compact display

Examples:

- `Affan Dar` -> `ad`
- `Radhakrishna Hari` -> `rh`
- `jane.doe@example.com` -> `jd`

### Stats inspector

Add an owner section to the session stats pane:

- `Owner    Affan Dar`
- `Email    affan@example.com`
- `Type     user`

For system sessions:

- `Owner    system`
- `Email    —`
- `Type     system`

For unowned historical sessions:

- `Owner    (?) unowned`
- `Email    —`
- `Type     unowned`

Add a third stats sub-tab so the stats pane cycles:

- `session`
- `fleet`
- `users`

The `users` sub-tab should show owner-scoped resource consumption,
including tokens by model, orchestration history size when available,
and persisted snapshot size. System and unowned sessions should be
represented as separate owner classifications so the totals reconcile
with fleet-level usage.

### Filter dialog

Replace the top-toolbar `Rename` and `Refresh` buttons with `Filter`.

Keep the per-session list-pane `Rename` and `Terminate` buttons. That preserves session rename without taking vertical space in the top toolbar.

Proposed filter options:

- `All`
- `System`
- `Unowned`
- `Me`
- distinct owner rows by display name

Recommended behavior:

- `All` overrides all other owner selections
- otherwise results are the union of selected identities plus optional `System` and `Unowned`
- default when auth is enabled: `System + Me`
- default when auth is disabled: no owner filter is applied
- specific-user options should be derived from owners present in the loaded session catalog, not the entire `users` table, so stale catalog rows do not clutter the filter UI

Recommended modal behavior:

- searchable owner list
- multi-select
- clear visual summary of active filter state

## Transport and Runtime Plumbing

The main implementation gap today is that auth identity exists at the portal edge, but it is not carried into session creation or session-list payloads.

### Current state

- authenticated principal is available in `packages/portal/server.js`
- public auth context is exposed through `/api/auth/me`
- session creation/listing flows through `packages/portal/runtime.js`, the CLI transport, and SDK management/client layers
- CMS currently has no user catalog or session-owner association

### Required plumbing changes

#### Portal server/runtime

Thread auth context from:

- `packages/portal/server.js`

through:

- `packages/portal/runtime.js`

into session-creation calls.

Session creation RPCs should receive a normalized principal payload from the server-side auth context when auth is enabled. The browser should not send user identity as a trusted RPC parameter.

#### SDK / management surfaces

Extend session creation and read models to carry principal/owner metadata through:

- `packages/sdk/src/cms.ts`
- `packages/sdk/src/client.ts`
- `packages/sdk/src/management-client.ts`
- `packages/cli/src/node-sdk-transport.js`

Recommended shape:

```ts
owner?: {
  provider: string;
  subject: string;
  email?: string | null;
  displayName?: string | null;
} | null;
```

The management read path can still flatten this back into `session.owner` for UI convenience after joining through `users` and `session_owners`.

#### Child-session inheritance

In the child-session spawn path:

- if `isSystem` is false, inherit owner from the parent session's ownership link
- if `isSystem` is true, create no ownership link

## CMS and Migration Changes

### `packages/sdk/src/cms-migrations.ts`

Add new tables:

- `users`
- `session_owners`

Recommended helper functions:

- `cms_register_user(provider, subject, email, display_name)`
- `cms_set_session_owner(session_id, provider, subject, email, display_name)`
- `cms_inherit_session_owner(session_id, parent_session_id)`

Update read procedures so session reads join through ownership:

- `cms_list_sessions()`
- `cms_get_session(...)`

All CMS table access should remain behind stored procedures. Application code should not directly query or mutate `users` or `session_owners`.

Schema changes should follow the existing migration guidance:

- add a numbered CMS migration in `cms-migrations.ts`
- if a stored procedure return shape changes, use drop-then-create because PostgreSQL cannot `CREATE OR REPLACE` a changed `RETURNS TABLE` shape
- construct the companion `packages/sdk/src/migrations/000N_diff.md` file alongside the SQL migration
- the diff file should explicitly document table changes, indexes, new procedures, changed procedure return shapes, and direct table-access guidance

### `packages/sdk/src/cms.ts`

Extend:

- `SessionRow`
- add a nested `owner` shape on reads, resolved from the join
- `rowToSessionRow`
- `createSession(...)`
- helper methods to register/link owners

I would avoid making generic `updateSession(...)` responsible for user-catalog management beyond an explicit owner-link helper.

## Shared UI Implementation Areas

Primary shared UI changes:

- `packages/ui-core/src/state.js`
- `packages/ui-core/src/reducer.js`
- `packages/ui-core/src/controller.js`
- `packages/ui-core/src/selectors.js`
- `packages/ui-react/src/web-app.js`

Recommended additions:

- owner-aware session filter state in shared UI state
- modal type for session-owner filtering
- selector helpers for:
  - session-list-only displayed title with initials or `(?)`
  - available owner filter options
  - default `System + Me` behavior

## Behavior Details

### Sorting

No owner-based sort change in phase 1.

Keep the current session ordering rules, then filter within the existing ordered list.

### Searching

Existing free-text filtering should continue to work across:

- stored title
- displayed owner initials prefix
- owner display name
- owner email

### Rename

Rename updates only the base title.

Displayed owner prefix remains derived:

- stored title: `My new session`
- displayed title: `(ad) My new session`

### Auth-disabled mode

If auth is disabled:

- do not create user or ownership rows during session creation
- do not force `System + Me`
- default the owner filter to `All`

## Phased Rollout

### Phase 1

- users catalog populated lazily on sight
- session ownership persisted via link table
- owner inheritance for non-system child sessions
- session-list owner initials and `(?)` for unowned sessions
- stats pane owner details
- stats pane `users` sub-tab with per-owner model/token/snapshot/orchestration-size aggregates
- filter modal with `All`, `System`, `Unowned`, `Me`, specific users
- default `System + Me`

### Phase 2

- optional owner backfill tooling
- optional user directory source beyond joined session owners
- optional ownership-aware authz

## Test Plan

### CMS / migration tests

Add or extend local CMS tests to verify:

1. migration creates `users` and `session_owners` idempotently
2. first authenticated create lazily inserts a user row
3. repeated sightings for the same `(provider, subject)` do not duplicate users
4. repeated sightings do not refresh `email` or `display_name`
5. `createSession()` assigns an ownership link
6. a second owner assignment for the same session does not overwrite the first link
7. child-session inheritance copies the ownership link for non-system children
8. system sessions can remain unowned
9. `listSessions()` and `getSession()` return joined owner metadata correctly
10. user stats aggregate token and snapshot totals by owner and model

Likely file:

- `packages/sdk/test/local/cms-state.test.js`

### Client / management tests

Add tests for:

1. authenticated create path lazily registers a user and links the session
2. auth-disabled create path leaves owner null
3. non-system child session inherits owner
4. system child session does not inherit owner
5. management `listSessions()` exposes resolved owner data

Likely files:

- `packages/sdk/test/local/management.test.js`
- `packages/sdk/test/local/session-proxy-events.test.js`
- a new focused ownership test if the current suites become too broad

### Shared UI selector/controller tests

Add tests for:

1. session-list display helper prefixes initials or `(?)` without mutating stored title
2. initials fallback logic from display name and email
3. default filter state is `System + Me` when auth is enabled
4. `Unowned` is a separate filter entry
5. `All` overrides specific owner selections
6. filter options are derived from owner rows present in loaded sessions, not the raw users catalog
7. search still matches owner display name and email
8. stats view cycles through `session`, `fleet`, and `users`
9. user stats render token/model, snapshot-size, and orchestration-size totals

Likely files:

- `packages/sdk/test/local/history-pane-ui.test.js`
- `packages/sdk/test/local/portal-browser-contracts.test.js`

### Portal / browser contract tests

Add browser/shared-surface contract coverage for:

1. top toolbar renders `Filter` instead of `Rename` / `Refresh`
2. session rows render owner initials and `(?)` for unowned sessions
3. stats pane includes owner fields
4. filter modal renders owner options and selection state

Likely file:

- `packages/sdk/test/local/portal-browser-contracts.test.js`

### Manual test matrix

Run the following manual scenarios in the browser portal:

1. Auth enabled, user creates a session:
   - session appears with `(me)`-style initials
   - stats pane shows full name and email
2. Auth enabled, another user creates a session:
   - current user can still see it
   - filter can isolate that user
3. Auth enabled, system sessions:
   - remain visible under default filter
   - show `system` ownership semantics
4. Auth enabled, `All` selected:
   - all sessions appear regardless of owner
5. Auth disabled:
   - no owner prefixes shown
   - no owner-based default filter
6. Rename owned session:
   - stored title changes
   - owner prefix remains derived and correct
7. Child-session spawn from user-owned session:
   - child inherits owner
8. System child/session creation:
   - owner remains null

## Resolved Decisions

- unowned non-system sessions display as `(?)` in the session list
- `Unowned` is a separate filter entry
- owner prefixes appear only in the session list display
- user rows and session-owner links are first-seen-write-wins
- CMS table access stays behind stored procedures
- schema changes require a companion numbered diff markdown file

## Recommendation

Implement phase 1 with a lazily populated `users` table plus a `session_owners` link table, inherited ownership for non-system child sessions, and shared UI filtering/defaults.

That gives the requested UX now while preserving a clean path to real ownership-aware authz later.
