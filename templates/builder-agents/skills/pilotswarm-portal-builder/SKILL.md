---
name: pilotswarm-portal-builder
description: "Use when creating or updating a browser portal on top of PilotSwarm. Covers portal branding, plugin.json.portal, named-agent exposure, auth add-ons, and remote deployment wiring."
---

# PilotSwarm Portal Builder

Build browser portal experiences on top of the shipped PilotSwarm web portal.

## Canonical References

- Starter Docker quickstart: `https://github.com/affandar/pilotswarm/blob/main/docs/getting-started-docker-appliance.md`
- Portal guide: `https://github.com/affandar/pilotswarm/blob/main/packages/portal/README.md`
- SDK guide: `https://github.com/affandar/pilotswarm/blob/main/docs/sdk/building-apps.md`
- Plugin architecture: `https://github.com/affandar/pilotswarm/blob/main/docs/plugin-architecture-guide.md`
- AKS deployment: `https://github.com/affandar/pilotswarm/blob/main/docs/deploying-to-aks.md`
- DevOps sample: `https://github.com/affandar/pilotswarm/tree/main/examples/devops-command-center`

## Preferred Structure

```text
my-app/
├── plugin/
│   ├── plugin.json
│   ├── assets/
│   ├── agents/
│   └── skills/
├── deploy/
│   ├── Dockerfile.portal
│   └── k8s/
│       └── portal-deployment.yaml
├── scripts/
│   └── run-portal.sh
└── README.md
```

## Workflow

1. Run a guided intake before scaffolding.
2. Prefer `plugin.json.portal` for browser branding and sign-in copy.
3. Use `plugin.json.tui` as a fallback or shared source only when the user wants the portal and TUI aligned.
4. Make named-agent availability explicit by packaging the app plugin for the portal process.
5. If the portal is deployed remotely, wire `PLUGIN_DIRS` in the portal environment.
6. Treat authentication as a provider-based add-on, not a built-in Entra assumption.
7. If auth is enabled, separate browser sign-in UX, token acquisition, and server-side validation clearly.
8. Add local launch guidance and remote rollout guidance that match the actual repository layout.

## Guided Intake Questions

Before generating files, ask:

1. What should the portal be called?
2. Should the portal reuse the TUI title and splash, or have its own branding?
3. What logo asset should the portal use?
   - ask for a checked-in path such as `plugin/assets/logo.svg`
   - ask whether the browser tab icon should reuse that same asset or use a separate favicon
4. Which named agents should be creatable from the portal?
5. Which auth provider should the portal use?
   - `none`
   - `entra`
   - another provider described by the user
6. If auth is enabled, what should the sign-in title and helper copy say?
7. Will the portal run locally only, or also in AKS / remote deployment?

Do not guess these answers when they materially affect the scaffold. If the user wants a fast default, offer:

- matching TUI + portal branding
- a shared portal logo at `plugin/assets/logo.svg`
- generic sign-in copy
- `none` or `entra` for auth
- plugin-driven packaging with `PLUGIN_DIRS`

## Portal Config Guidance

- Put browser-specific branding under `plugin.json.portal`.
- Prefer nested portal config: `portal.branding`, `portal.ui`, and `portal.auth`.
- Keep page title, splash text, loading copy, and sign-in copy in plugin metadata instead of hardcoding them into app code.
- Keep the logo path in plugin metadata so the splash screen, signed-in header, and browser tab icon stay in sync.
- Use `plugin.json.tui` only when the user explicitly wants the same title/splash across TUI and portal.
- Keep agent prompts and personas in `plugin/agents/*.agent.md`, not inside portal UI files.
- Use `session-policy.json` when the user wants the portal to offer only a curated agent roster instead of generic sessions.

Example:

```json
{
  "name": "waldemort",
  "description": "Operations workspace",
  "portal": {
    "branding": {
      "title": "Waldemort",
      "pageTitle": "Waldemort Portal",
      "logoFile": "./assets/logo.svg",
      "faviconFile": "./assets/favicon.png"
    },
    "ui": {
      "loadingMessage": "Preparing your command center"
    },
    "auth": {
      "signInTitle": "Sign in to Waldemort",
      "signInMessage": "Use your organization account to open the browser workspace."
    }
  }
}
```

Logo notes:

- `branding.logoFile` is the preferred checked-in asset path
- the same logo is used on the loading splash, sign-in gate, signed-in header, and browser tab icon unless `branding.faviconFile` overrides it
- keep logo assets inside the plugin directory so the remote portal image can package them with `plugin.json`

## Auth Guidance

- Treat `none` as a valid first-class choice.
- Keep auth provider selection explicit with `PORTAL_AUTH_PROVIDER`.
- For the shipped Entra provider, document:
  - `PORTAL_AUTH_PROVIDER=entra`
  - `PORTAL_AUTH_ENTRA_TENANT_ID`
  - `PORTAL_AUTH_ENTRA_CLIENT_ID`
  - `PORTAL_AUTHZ_ADMIN_GROUPS` / `PORTAL_AUTHZ_USER_GROUPS` as comma-delimited email allowlists when admission gating is requested
  - redirect URI registration for the portal host
- Use only the canonical `PORTAL_AUTH_*` and `PORTAL_AUTHZ_*` env vars; do not document or scaffold legacy `ENTRA_*` fallbacks.
- If the user wants another provider such as AWS IAM, do not force Entra-specific language into the scaffold.
- For custom providers, separate:
  - browser-side sign-in initiation
  - token acquisition/storage
  - server-side request validation

## Local And Remote Launch Guidance

- For local usage, prefer a checked-in script such as `scripts/run-portal.sh`.
- Local launch guidance should use `pilotswarm-web --plugin ./plugin` or the equivalent app wrapper.
- For remote deployments, package the app plugin into the portal image or mount it into the portal pod.
- Set `PLUGIN_DIRS` in the portal deployment so the web process can resolve:
  - `plugin.json.portal`
  - `plugin.json.tui`
  - `plugin/agents/*`
  - `session-policy.json`
- When documenting Kubernetes secrets for portal settings, prefer `kubectl create secret generic ... --from-env-file=...` for env files that may contain shell-significant characters.

## Validation Guidance

- Do more than write files: run a local portal build when practical.
- Verify the portal can load branding from `plugin.json.portal`.
- Verify named-agent creation appears in the browser UI when the plugin and session policy are present.
- If auth is enabled, verify the portal-config/bootstrap path advertises the selected provider correctly.
- For remote deployments, verify `GET /api/health` and `GET /api/portal-config` against the live ingress host.

## Guardrails

- Do not hardcode PilotSwarm branding into app-specific portal code when plugin metadata can drive it.
- Do not assume the portal can infer named agents from remote workers alone.
- Do not assume Entra ID is mandatory.
- Do not invent app-specific auth protocols when the user really wants auth disabled.
- Keep portal UX copy, prompt layers, auth wiring, and deployment packaging as separate concerns.
