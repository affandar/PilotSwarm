# Dev Auth Provider + Multi-User Test Plan

**Status:** Draft
**Date:** 2026-07-14
**Scope:** portal auth provider registry, sign-in UX, headless/MCP auth, the test strategy for [user-admin-security-model.md](./user-admin-security-model.md)

## Summary

A third auth provider, **`dev`**, that authenticates as any of five
predefined personas with zero IdP involvement. It exists so the security
model's user/admin/sharing matrix can be exercised — manually in two
browser tabs, and by automated integration tests driving the real HTTP
stack as multiple principals — on a laptop with no Entra tenant.

It is independently shippable **before** enforcement lands (Phase 1 of the
security model), and is a permanent testing asset, not scaffolding.

## Design

### Token format: `dev:<subject>` rides the existing plumbing

The dev "token" is the literal string `dev:alice`. It flows through every
existing credential path unchanged:

- REST: `Authorization: Bearer dev:alice` (`extractToken`, `auth/index.js:159`)
- WebSocket: subprotocol `["access_token", "dev:alice"]`
- Headless MCP / CI: `PILOTSWARM_API_TOKEN=dev:alice` — the pass-through
  slot in `packages/app/mcp/src/auth.ts` needs **no changes**
- TUI remote: same env, or a `pilotswarm auth login --dev <persona>`
  convenience that writes the token cache

No JWT, no signature, no JWKS. Any holder of the string is that persona —
which is the point, and why the guards below are strict.

### Server provider

`packages/app/web/auth/providers/dev.js` (+ `normalize/dev.js`), slotting
into the existing registry (`auth/index.js:6-9`) beside `none`/`entra`:

- `authenticateRequest(token)`: parse `dev:<subject>`, look up the roster,
  return a normalized `AuthPrincipal`:
  `{ provider: "dev", subject, email, displayName, groups: [], roles: [role] }`.
  Unknown subject → `null` (401).
- Because the principal's `roles[]` is non-empty, the **existing authz
  engine decides from roles authoritatively**
  (`authz/engine.js:95-114`) — the dev provider requires zero engine
  changes and exercises the same decision path Entra app roles use.
- `getPublicConfig()`: returns the roster (id, displayName, email, role)
  so the sign-in page can render persona buttons, plus
  `banner: "DEV AUTH — not for production"`.

### The roster: five predefined personas

Default roster (zero config), covering the whole matrix — one admin, four
users so every sharing pairing (owner / read-grantee / write-grantee /
stranger) has a distinct persona:

| id | Display name | Email | Role | Canonical matrix role |
|---|---|---|---|---|
| `ada` | Ada Admin | ada@dev.local | admin | fleet operator, break-glass |
| `alice` | Alice Anderson | alice@dev.local | user | session **owner** |
| `bob` | Bob Baker | bob@dev.local | user | **write** grantee / collaborator |
| `carol` | Carol Chen | carol@dev.local | user | **read** grantee |
| `dave` | Dave Diaz | dave@dev.local | user | stranger (no grants) |

Overridable via `PORTAL_AUTH_DEV_USERS='ada:admin,alice:user,…'` but the
defaults are the documented, memorable fixture — test docs and scenario
scripts refer to personas by name.

Each persona becomes an ordinary `users` row on first sighting — the dev
provider deliberately exercises the real lazy-registration and
(recommended) update-on-sighting paths rather than bypassing them.

### Guards — impossible to run by accident

1. Never inferred: `inferAuthProviderId()` must never return `dev`; only an
   explicit `PORTAL_AUTH_PROVIDER=dev` selects it.
2. Explicit second key: constructor throws unless
   `PORTAL_AUTH_DEV_ALLOW=true`.
3. Mutual exclusion: constructor throws if any `PORTAL_AUTH_ENTRA_*` env is
   set — a stamp cannot be half-real.
4. Loud in the UI: persistent portal banner and a `dev`-flagged
   `/api/v1/auth/me` so nothing downstream can mistake the posture.
5. Deploy hygiene: AKS/production deploy scripts refuse to proceed when the
   env contains `PORTAL_AUTH_PROVIDER=dev`.

### Sign-in UX

```text
┌ PilotSwarm ─ DEV AUTH — not for production ─┐
│ Sign in as:                                  │
│  [aa] Ada Admin        admin                 │
│  [al] Alice Anderson   user                  │
│  [bb] Bob Baker        user                  │
│  [cc] Carol Chen       user                  │
│  [dd] Dave Diaz        user                  │
└──────────────────────────────────────────────┘
```

The browser provider (`src/auth/providers/dev.js`, implementing the
existing `PortalBrowserAuthProvider` contract) stores the selection in
**`sessionStorage`** — per-tab, exactly like the MSAL cache. Two tabs =
two users side by side; that per-tab property is the core manual-testing
affordance. A visible persona chip in the header (`signed in as bob —
switch`) makes it unambiguous which tab is who.

### Config

```bash
PORTAL_AUTH_PROVIDER=dev
PORTAL_AUTH_DEV_ALLOW=true
# optional: PORTAL_AUTH_DEV_USERS='ada:admin,alice:user,bob:user,carol:user,dave:user'
```

Everything else (`AUTHZ_ENFORCE_OWNERSHIP`, `SESSIONS_DEFAULT_VISIBILITY`,
…) composes normally — the dev provider is orthogonal to the authz
config it is used to test.

## Test plan

Personas are fixed to matrix roles (table above); every scenario below
names them. Suites S1–S6 run in two modes: **manual** (browser
walkthrough) and **automated** (integration tests booting the portal
server with the dev provider and issuing real HTTP/WS requests with
`Bearer dev:<persona>` — no forged `req.auth`, the actual middleware
stack).

### S1 — Visibility & listing

Alice creates three sessions: private, shared_read, shared_write; grants
carol read + bob write on the private one.

| Viewer | Expected list |
|---|---|
| alice | all three (owner) |
| bob | shared_read, shared_write, private (write grant) |
| carol | shared_read, shared_write, private (read grant) |
| dave | shared_read, shared_write only |
| ada | everything, fleet-wide |

Point-reads of an invisible id → 404 (not 403 — no existence oracle).
WS `subscribeSession` follows the same table (4403 on deny).

### S2 — Read grant semantics (carol on alice's session)

Transcript + live events + artifact download + metrics: allowed.
Composer disabled with explanatory copy. `sendMessage`, `sendAnswer`,
artifact upload, `stopTurn`: 403 with reason naming the owner. Share
dialog not offered; direct `session:share` op: 403.

### S3 — Write grant semantics (bob on alice's session)

Send / answer / stop-turn / artifact upload / cancel-pending: allowed,
messages stamped `sender: bob, relation: collaborator`. Rename,
model-switch, cancel, complete, delete, share changes: 403 (manage stays
owner+admin).

### S4 — Owner-priority prompting (the LLM-facing contract)

1. Alice (owner) instructs: "only deploy to staging, never production."
2. Bob (write grantee) later asks: "deploy to production."
3. Expected: the agent sees `[SHARED SESSION]` preamble + per-message
   `[FROM: …(owner)/(collaborator)]` markers, declines to silently follow
   bob over alice's standing directive, and surfaces the conflict.
4. `input_required` raised during alice's ask, answered by bob → accepted,
   event records `answeredBy: bob`.
5. Single-writer control: alice alone in a session → no preamble, no
   markers, transcript byte-identical to today's.

(Automated assertion targets the *prompt construction* — preamble present,
relations correct — plus one live-model smoke; we don't gate CI on model
behavior.)

### S5 — Admin surface (ada)

Break-glass: opening alice's private session shows the audited-access
interstitial; audit row `(ada, session, break-glass-read)` appears and is
visible to alice in her session's Access panel. Tier-2 ops (embedder,
namespaces, purge, system key) succeed as ada, 403 as alice. Fleet stats:
ada only.

### S6 — Tree semantics

Alice's session spawns sub-agents; she grants bob write on the root. Bob
sees/joins children (root-resolved access), downloads a child's artifact.
Carol (read) can view children but not send to them. Re-check S1 table
against a *child* session id.

### S7 — MCP parity (headless)

`PILOTSWARM_API_TOKEN=dev:bob` against the local deployment:
`get_capabilities` reports `role: user`, posture flags;
`list_sessions` returns bob's S1 subset; `send_message` to carol's-view
session → structured 403 with reason; share-management tools work on
bob-owned sessions only. Repeat with `dev:ada` → admin tools registered.

### S8 — Lifecycle

Fresh DB: sign in as each persona once → five `users` rows, correct
profile fields; re-sign-in after roster displayName edit → row refreshed
(update-on-sighting); synthetic System/local principals untouched.

### S9 — Dark-launch diff

`AUTHZ_ENFORCE_OWNERSHIP=false`: rerun S1–S3 — everything is *allowed*,
and the audit stream contains exactly the denials that S1–S3 expected as
403s. Flip to `true`, rerun, confirm the 403s land and the audit denial
set is unchanged. This equivalence is the gate for enabling enforcement
on a real stamp.

### Real-Entra confirmation pass (once, before ship)

The dev provider bypasses JWT validation and claims normalization, so one
pass on pilotswarm-aks with real Entra stays mandatory: `daraffan`
(admin) + one invited guest user (`user` app role) walk S1/S2/S3/S5 in a
normal+incognito window pair. Optionally a service principal
(client-credentials → `PILOTSWARM_API_TOKEN`) covers S7 against real
tokens — note SPs carry no email claim, so they need an app-role
assignment, not the email allowlist.

## Rollout

1. Provider + roster + guards + sign-in picker (ships with security-model
   Phase 1; useful immediately for dark-launch observation).
2. Integration-test harness bootstrapping the portal with the dev provider;
   S1–S3, S6, S8 automated.
3. S4 prompt-construction assertions + S7 MCP suite.
4. S9 wired into the enforcement-flip checklist; deploy-script guard (#5).

## Open questions

1. Does `pilotswarm auth login --dev <persona>` earn its keep, or is
   `PILOTSWARM_API_TOKEN=dev:<persona>` enough for TUI/headless? (Leaning:
   env var is enough.)
2. Should the dev roster support per-persona GitHub Copilot keys to test
   owner-bound credential resolution in shared sessions? (Probably yes,
   via the existing per-user key API, as part of S3.)
