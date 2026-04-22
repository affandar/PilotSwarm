# pilotswarm-web

Web portal for PilotSwarm — browser-based durable agent orchestration UI.

Full feature parity with the TUI: session management, real-time chat, agent
splash screens (ASCII art), sequence diagrams, node maps, worker logs,
binary-safe artifact downloads, metadata-aware browser previews, and keyboard shortcuts.

## Quick Start

```bash
# Install
npm install pilotswarm-web

# Run (starts server + serves React app)
npx pilotswarm-web --env .env.remote
npx pilotswarm-web --env .env.remote --plugin ./plugin

# Development (Vite HMR)
cd packages/portal
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
- If no admin/user groups are configured, any successfully authenticated user is allowed in as the default `user` role.
- Phase 1 keeps `admin` and `user` permissions the same inside the portal; the email allowlists act as an admission gate and role assignment surface.

The portal core no longer assumes Entra specifically. New providers can plug
into the same browser/server provider interfaces, while sharing the same common
authz layer.

## Architecture

```
Browser (React + Vite)
  │
  ├── WebSocket ──► Portal Server (Express + ws)
  │                    │
  │                    ├── PilotSwarmClient
  │                    ├── PilotSwarmManagementClient
  │                    └── PilotSwarmWorker (embedded or remote)
  │
  └── REST (session list, models, artifacts)
```

Same public API boundary as the TUI — only `PilotSwarmClient`,
`PilotSwarmManagementClient`, and `PilotSwarmWorker` APIs. No internal
module imports.

## Package Relationship

```
pilotswarm-web         (this package)
  ├── pilotswarm-cli   (shared node/runtime host glue)
  │   ├── pilotswarm-sdk
  │   ├── pilotswarm-ui-core
  │   └── pilotswarm-ui-react
  ├── express
  ├── ws
  ├── react, react-dom
  └── vite             (devDependency)
```

`pilotswarm-web` now consumes a small supported portal-facing surface from
`pilotswarm-cli` rather than importing monorepo-relative source files. That
keeps the publishable package graph explicit and lets the portal reuse the same
Node transport and plugin-config behavior as the TUI.
