# pilotswarm-web

Web portal for PilotSwarm — browser-based durable agent orchestration UI.

Full feature parity with the TUI: session management, real-time chat, agent
splash screens (ASCII art), sequence diagrams, node maps, worker logs,
binary-safe artifact downloads, metadata-aware browser previews, and keyboard shortcuts.

The portal server also hosts the versioned [PilotSwarm Web API](../../docs/api/reference.md)
(`/api/v1` HTTP + `/api/v1/ws` WebSocket) — see [Web API](#web-api) below.

## Quick Start

```bash
# Install
npm install pilotswarm-web

# Run (starts server + serves React app)
npx pilotswarm-web --env .env.remote
npx pilotswarm-web --env .env.remote --plugin ./plugin

# Development (Vite HMR)
cd packages/app/web
npm run dev              # React app at http://localhost:5173
node server.js           # API server at http://localhost:3001
```

## Portal Customization

The web portal reads app-facing customization from `plugin.json` in your app
plugin directory. Pass the plugin path with `--plugin` or set `PLUGIN_DIRS`
so the portal process can see the same metadata the TUI and worker use.

Supported keys:

```json
{
  "tui": {
    "title": "DevOps Command Center",
    "splashFile": "./tui-splash.txt"
  },
  "portal": {
    "branding": {
      "title": "DevOps Command Center",
      "pageTitle": "DevOps Command Center Portal",
      "splashFile": "./tui-splash.txt",
      "logoFile": "./assets/logo.svg",
      "faviconFile": "./assets/favicon.png"
    },
    "ui": {
      "loadingMessage": "Preparing the DevOps workspace",
      "loadingCopy": "Connecting dashboards, session feeds, and orchestration state..."
    },
    "auth": {
      "provider": "entra",
      "signInTitle": "Sign in to DevOps Command Center",
      "signInMessage": "Use your organization's identity provider to open the shared operations workspace.",
      "signInLabel": "Sign In"
    }
  }
}
```

Notes:

- Preferred schema is nested: `portal.branding`, `portal.ui`, and `portal.auth`.
- Flat legacy keys such as `portal.title` and `portal.loadingMessage` are still accepted for backwards compatibility.
- `portal.auth.provider` selects the active auth provider when the deployment does not override it with `PORTAL_AUTH_PROVIDER`.
- `branding.logoFile` is used on the loading splash, sign-in card, and signed-in header.
- If `branding.faviconFile` is omitted, the browser tab icon reuses `branding.logoFile`.
- Keep logo assets inside the plugin directory so the portal image can package and serve them alongside `plugin.json`.

Fallback order:

- `portal.branding.*` / `portal.ui.*` / `portal.auth.*`
- flat `portal.*`
- `tui.title` / `tui.splash` / `tui.splashFile`
- built-in `PilotSwarm` defaults

Named-agent creation in the portal comes from the same plugin metadata surface.
If the portal process cannot see your plugin directory, the web UI falls back
to generic sessions even when the worker supports named agents.

Artifact behavior:

- text artifacts still preview inline in the browser workspace
- binary artifacts render as a download-only card in the browser workspace
- downloads preserve the stored content type and raw bytes

## Auth Add-Ons

Portal authentication is provider-based.

- Default: `none`
- Built-in optional provider: `entra`
- AuthZ is common across providers and currently supports Phase 1 group-based admission control

Enable Entra ID with env vars:

```bash
PORTAL_AUTH_PROVIDER=entra
PORTAL_AUTH_ENTRA_TENANT_ID=<tenant-id>
PORTAL_AUTH_ENTRA_CLIENT_ID=<client-id>
PORTAL_AUTHZ_ADMIN_GROUPS=admin1@contoso.com,admin2@contoso.com
PORTAL_AUTHZ_USER_GROUPS=user1@contoso.com,user2@contoso.com
```

Notes:

- `PORTAL_AUTHZ_ADMIN_GROUPS` and `PORTAL_AUTHZ_USER_GROUPS` are currently comma-delimited email allowlists despite the historical variable names.
- `PORTAL_AUTHZ_DEFAULT_ROLE` defaults to `none` (deny-by-default since v0.1.33). If no admin/user groups are configured and the JWT carries no role claim, a signed-in user is **denied** at the portal layer. Set `PORTAL_AUTHZ_DEFAULT_ROLE=user` to restore the legacy "any tenant user gets `user`" open posture (sandbox stamps only).
- `admin` and `user` have the same portal permissions today; the allowlists act as an admission gate and role assignment surface.

### App Roles (Recommended For IT-Managed Tenants)

When the Entra app registration defines `admin` and `user` app roles
and assigns them, the portal decides admission from the JWT `roles`
claim — the role assignment in Entra **is** the allowlist for this
posture. The portal matches the claim by case-insensitive equality
against the canonical values `admin` and `user`; there is no override
env var. With deny-by-default (the default since v0.1.33), unassigned
signed-in users are denied at the portal layer.

The email-allowlist path (`PORTAL_AUTHZ_ADMIN_GROUPS` /
`PORTAL_AUTHZ_USER_GROUPS`) is bypassed entirely when the JWT carries
a `roles[]` claim — use it only for stamps that do not use
`-CreateAppRoles`. Flipping `appRoleAssignmentRequired=true` on the
Enterprise Application adds an Entra-side gate as well; it is optional
and carries a restricted-tenant caveat (AADSTS90094 admin-consent
prompts). See
[`../../docs/portal-entra-app-roles.md`](../../docs/developer/deploy/entra-app-roles.md)
for the full operator runbook.

The portal core no longer assumes Entra specifically. New providers can plug
into the same browser/server provider interfaces, while sharing the same common
authz layer.

## Web API

The portal server also hosts the versioned PilotSwarm Web API — same process,
same port (3001):

- **HTTP `/api/v1`** — routes generated from the `pilotswarm-sdk/api`
  operations table (`packages/sdk/api/src/protocol.js`, the contract source
  of truth) and dispatched through the existing runtime dispatcher — the same
  one the legacy `/api/rpc` uses, so the two surfaces cannot drift.
- **WebSocket `/api/v1/ws`** — session event and log streaming.
- **Auth** — reuses the portal's provider-based auth; the same `PORTAL_AUTH_*`
  and `PORTAL_AUTHZ_*` env vars apply, no separate configuration.
- Errors use the `{ ok: false, error: { code, message } }` envelope.

See [`docs/api/reference.md`](../../docs/api/reference.md) for the full API
reference.

The legacy `/api/rpc` and `/portal-ws` endpoints remain mounted for a
deprecation window; new integrations must use `/api/v1`.

## Architecture

```
Browser (React + Vite)
  │
  └── BrowserPortalTransport (extends HttpApiTransport)
        │
        ├── HTTP ──────► /api/v1      ─┐
        │                              ├─ Portal Server (Express + ws)
        └── WebSocket ─► /api/v1/ws   ─┘
                             │
                             ├── PilotSwarmClient
                             ├── PilotSwarmManagementClient
                             └── PilotSwarmWorker (embedded or remote)
```

The browser UI talks `/api/v1` itself via `BrowserPortalTransport`, which
extends `HttpApiTransport` from `pilotswarm-sdk/api` — the same client
surface external integrations use.

Same public API boundary as the TUI — only `PilotSwarmClient`,
`PilotSwarmManagementClient`, and `PilotSwarmWorker` APIs. No internal
module imports.

## Package Relationship

```
pilotswarm             (the app package; this dir is its web/ tree)
  ├── pilotswarm/host  (shared node/runtime host glue, tui/src/portal.js)
  │   └── pilotswarm-sdk
  ├── pilotswarm/ui-core, pilotswarm/ui-react (internal UI layers)
  ├── express
  ├── ws
  ├── react, react-dom
  └── vite             (devDependency)
```

`pilotswarm-web` now consumes a small supported portal-facing surface from
`pilotswarm-cli` rather than importing monorepo-relative source files. That
keeps the publishable package graph explicit and lets the portal reuse the same
Node transport and plugin-config behavior as the TUI.
