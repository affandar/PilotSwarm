# PilotSwarm Layering — One Way In

**The rule:** every user-facing surface talks to a deployment through the Web
API. Exactly three things touch the datastore directly: the Web API's own
implementation (the portal server), the workers (trusted backend), and tests.
Direct-mode constructors (`{ store }`) still exist for those three consumers —
they are internal, not a supported integration surface.

## The whole system

```text
                        USER-FACING SURFACES  (Web API mode only)
   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐
   │  TUI          │  │  Portal UI   │  │  MCP server  │  │  Your SDK app    │
   │  `pilotswarm  │  │  (browser)   │  │  `pilotswarm │  │  PilotSwarmClient│
   │   remote`     │  │              │  │   -mcp`      │  │  ({ apiUrl })    │
   └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘
          │                 │                 │                    │
          │   HttpApiTransport / ApiClient — one wire client,     │
          │   generated from the operations table                 │
          └────────────┬────┴────────┬────────┴────────────────────┘
                       ▼             ▼
            ╔═══════════════════════════════════════╗
            ║            THE WEB API SEAM           ║
            ║   HTTP  /api/v1   ·   WS  /api/v1/ws  ║
            ║   auth: none | entra   ·   { ok, … }  ║
            ╚═══════════════════╦═══════════════════╝
                                ▼
            ┌───────────────────────────────────────┐
            │             portal server             │   the Web API
            │   routes generated from the ops table │   implementation —
            │   → PortalRuntime.call(name, params,  │   direct mode's only
            │     auth) → NodeSdkTransport          │   production home
            └───────────────────┬───────────────────┘
                                │  direct provider (internal)
                                ▼
            ┌───────────────────────────────────────┐
            │  SDK runtime + stores                 │◀──── workers
            │  management client · CMS catalog ·    │      (PilotSwarmWorker:
            │  duroxide orchestration ·             │      turns, tools,
            │  FactStore / GraphStore               │      plugins — always
            └───────────────────┬───────────────────┘      direct; they ARE
                                ▼                           the backend)
                  PostgreSQL  (+ optional Horizon / AGE
                   via pilotswarm-horizon-store, dynamic)
```

Everything above the seam holds **one credential: the deployment URL** (plus a
bearer token on Entra deployments). Everything below it holds database
credentials and lives inside the deployment boundary.

## The seam itself

The contract's single source of truth is the **operations table**
(`packages/sdk/api/src/protocol.js`). Two things are generated from it at
runtime and cannot drift: the portal server's routes (`portal/api/router.js`)
and the wire client's request building (`ApiClient`). The third — the API
reference (`docs/api/reference.md`) — is maintained in lockstep with the table
(operation-by-operation) and must be updated in the same change as any table
edit.

Operation names in the table are exactly the `PortalRuntime.call` dispatch
names — a new operation is one table row plus one runtime case.

## Per-surface stacks

All four surfaces converge on the same wire client; they differ only in what
sits above it.

```text
   TUI (remote)              Portal UI (browser)        MCP server (web mode)
   ────────────              ───────────────────        ─────────────────────
   Ink render                React (web-app.js)         MCP tools (stdio/http)
       │                         │                          │
   ui-react / ui-core        ui-react / ui-core         context: Client(apiUrl)
   controller + state        controller + state           Mgmt(apiUrl)
       │                         │                          WebFactStore
   http-transport-host       browser-transport.js          WebGraphStore
       │                         │                          │
   HttpApiTransport          HttpApiTransport           ApiClient
       │                         │                          │
       └────────────────────────┴──────────────────────────┘
                                ▼
                     HTTP /api/v1 · WS /api/v1/ws


   SDK app (what you write)
   ────────────────────────
   new PilotSwarmClient({ apiUrl [, getAccessToken] })      sessions, turns
   new PilotSwarmManagementClient({ apiUrl [, …] })         fleet, stats, facts/graph
   createWebFactStore(api) / createWebGraphStore(api)       FactStore/GraphStore
                                                            over the API — same
                                                            interfaces the
                                                            runtime programs
                                                            against
```

The facts/graph surface is the pattern in miniature: `WebFactStore` and
`WebGraphStore` **implement the same `FactStore`/`GraphStore` interfaces** as
the direct Postgres stores, so any consumer typed against the interface (MCP
facts tools, SDK apps) runs unchanged on either side of the seam — but only the
portal server actually constructs the direct ones. See
[Facts & Graph](../developer/building/facts-and-graph.md).

## Who may use the direct provider

| Consumer | Why it's allowed | Everything else |
|---|---|---|
| **Portal server** (`PortalRuntime` → `NodeSdkTransport` → management client → stores) | It *is* the Web API implementation | — |
| **Workers** (`PilotSwarmWorker({ store })`) | Trusted backend: execute turns, run tools, load plugins. Never user-facing | — |
| **Tests** (`sdk/test/local/*`, portal/router suites) | Verify both sides of the seam; the webapi E2E suite deliberately drives *only* the web side | — |
| | | **Nothing else.** `new PilotSwarmClient({ store })`, `--store` on the MCP bin, and TUI local mode are internal/dev conveniences, not supported integrations |

## Auth at the seam

```text
   no-auth deployment            entra deployment
   ──────────────────            ────────────────
   every caller admitted         Browser   → MSAL redirect (SPA)
   as role "anonymous"           TUI/MCP   → interactive auth-code + PKCE
   (= privileged: no-auth                    loopback (`pilotswarm auth login`,
   means full access)                        auto-triggered by `remote --api-url`)
                                 Headless  → PILOTSWARM_API_TOKEN (SP / CI)
                                     │
                                     ▼
                          bearer JWT → portal authz
                          (roles claim → email allowlists → default role)
                                     ▼
                          role: admin | user   (binary admission;
                          admin gates Tier-2 ops, scopes facts reads)
```

Admission is enforced **only at the seam** — below it, the runtime trusts the
role the router resolved. That is why nothing user-facing may run below the
seam.

## Mode summary

| Surface | Supported mode | Internal/dev mode | Direct-only leftovers |
|---|---|---|---|
| TUI | `pilotswarm remote --api-url <url>` (auto-login) | `pilotswarm` local (boots in-process stack for development) | — |
| Portal UI | browser → same-origin `/api/v1` | — | — |
| MCP server | `pilotswarm-mcp --api-url <url>` | `--store $DATABASE_URL` (co-located/trusted, tests) | `dump_session`, `send_command` (raw command plumbing) |
| SDK client/mgmt | `{ apiUrl }` | `{ store }` (tests) | raw command channels, session dumps, some usage stats |
| SDK worker | n/a — always direct `{ store }` (it is the backend) | — | — |

## What this buys

- **One integration surface to version and document** — the ops table, `/api/v1`.
- **No credential sprawl** — user-facing processes never hold database URLs.
- **Authorization in one place** — role checks live at the router/runtime seam,
  not scattered through stores.
- **Swap-ability** — anything speaking the interface (`FactStore`, ui-core
  transport) runs over either side, so tests can drive the real stores while
  production drives the API.

> Package boundaries may consolidate (see
> [package-consolidation](../proposals/package-consolidation.md)) — the layering
> above is unchanged by that; only which `package.json` a layer lives in moves.
