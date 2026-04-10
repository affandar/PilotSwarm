# Portal Auth Provider + AuthZ Integration

> **Status:** Proposal  
> **Date:** 2026-04-09  
> **Goal:** Make portal authentication provider-pluggable, add a common authorization layer, and support a phased rollout from shared visibility to per-user session isolation.

---

## Summary

PilotSwarm portal already has the beginnings of a provider-based auth layer:

- the server can resolve an auth provider dynamically
- Entra ID is implemented as an optional provider
- the browser can sign in and attach a bearer token

What it does **not** have yet:

- a true browser-side provider abstraction
- a common authorization layer shared across providers
- normalized principals and claims
- provider-neutral policy evaluation
- per-user session visibility rules

This proposal turns the current Entra-specific path into a layered model:

1. **Browser auth provider**
2. **Server auth provider**
3. **Common authz engine**
4. **Session/facts/artifact policy enforcement**

Phase 1 keeps admins and users functionally identical.

Phase 2 introduces user scoping so non-admin users can only see and act on their own sessions.

---

## Goals

- Support portal auth providers beyond Entra without rewriting the portal shell.
- Keep provider-specific authentication separate from provider-neutral authorization.
- Allow deployments to switch providers with `plugin.json` and `.env`.
- Support `none`, `entra`, and future `iam` / `gcp` providers through a consistent contract.
- Add a clean phase boundary:
  - Phase 1: authenticated `admin` and `user` roles exist, but have the same portal permissions
  - Phase 2: `user` visibility is restricted to their own sessions

## Non-Goals

- Full enterprise RBAC in Phase 1.
- Raw browser-side AWS SigV4 request signing as the first AWS implementation.
- Replacing worker trust boundaries. Workers remain trusted backend infrastructure.
- Adding fine-grained per-message or per-tool authorization in this proposal.

---

## Design Principles

1. **AuthN is provider-specific.**
   - Entra, IAM-backed identity, and GCP each validate identity differently.

2. **AuthZ is common.**
   - Once a provider produces a normalized principal, policy evaluation should not care where that user came from.

3. **Browser and server both need provider layers.**
   - The server is already mostly provider-pluggable.
   - The browser still hardcodes Entra/MSAL behavior and must be generalized.

4. **Provider-neutral policy, provider-specific normalization.**
   - Each provider maps claims to a common shape.
   - The authz engine consumes the common shape only.

5. **Phase 1 should stay operationally simple.**
   - Group-based allow/deny plus role assignment.
   - No data migration pressure beyond optional ownership columns.

---

## Current State

Today the portal auth path looks like this:

```text
Browser
  -> GET /api/portal-config
  -> MSAL sign-in if provider === entra
  -> Bearer token on REST
  -> access_token subprotocol on WebSocket

Portal Server
  -> auth.js resolves provider
  -> provider.authenticateRequest(token)
  -> Entra provider verifies JWT via jose + JWKS
  -> req.authClaims = raw JWT payload
  -> protected endpoints allow if token validates
```

Current limitations:

- browser auth client only supports `entra`
- server returns raw claims, not a normalized principal
- no common authorization decision object
- no `403` authenticated-but-forbidden path
- no group-based access gates
- no ownership model for sessions

---

## Proposed Architecture

### Layered Model

```text
                               ┌───────────────────────────────┐
                               │         Portal Browser        │
                               └───────────────┬───────────────┘
                                               │
                                /api/portal-config, sign-in
                                               │
                                               v
                           ┌──────────────────────────────────────┐
                           │ Browser Auth Provider Adapter        │
                           │ - none                               │
                           │ - entra                              │
                           │ - iam                                │
                           │ - gcp                                │
                           └────────────────┬─────────────────────┘
                                            │ token / identity assertion
                                            v
                           ┌──────────────────────────────────────┐
                           │ Portal Server                         │
                           │ requireAuth()                         │
                           └────────────────┬─────────────────────┘
                                            │
                                            v
                           ┌──────────────────────────────────────┐
                           │ Server Auth Provider                  │
                           │ validate + normalize principal        │
                           └────────────────┬─────────────────────┘
                                            │ AuthPrincipal
                                            v
                           ┌──────────────────────────────────────┐
                           │ Common AuthZ Engine                  │
                           │ evaluate policy -> allow/deny/role   │
                           └────────────────┬─────────────────────┘
                                            │ AuthContext
                                            v
                           ┌──────────────────────────────────────┐
                           │ Portal Runtime / API Policy Gates    │
                           │ listSessions / getSession / RPC      │
                           └──────────────────────────────────────┘
```

### Core Separation

```text
Provider-specific:
  - sign-in UX
  - token acquisition
  - token validation
  - claims normalization

Provider-neutral:
  - role assignment
  - group-based allow/deny
  - ownership checks
  - visibility filtering
  - 401 vs 403 behavior
```

---

## Proposed Abstractions

### 1. Normalized Principal

Every provider must return the same internal principal shape:

```ts
type AuthPrincipal = {
  provider: "none" | "entra" | "iam" | "gcp" | string;
  subject: string;
  email: string | null;
  displayName: string | null;
  groups: string[];
  roles: string[];
  tenantId?: string | null;
  rawClaims: Record<string, unknown>;
};
```

Notes:

- `groups` should contain provider-native stable identifiers, not display names, where possible.
- `roles` should contain normalized semantic roles derived from provider claims if available.
- `rawClaims` is retained for diagnostics and future provider-specific policy extensions.

### 2. Authorization Result

The authz layer should return a common decision object:

```ts
type AuthorizationDecision = {
  allowed: boolean;
  role: "admin" | "user" | "anonymous" | null;
  reason?: string;
  matchedGroups?: string[];
};
```

### 3. Auth Context

Request handlers should consume one object instead of loose claims:

```ts
type RequestAuthContext = {
  principal: AuthPrincipal | null;
  authorization: AuthorizationDecision;
};
```

### 4. Server Auth Provider Contract

```ts
interface PortalServerAuthProvider {
  id: string;
  enabled: boolean;
  displayName: string;

  getPublicConfig(req: import("express").Request): Promise<PortalPublicAuthConfig>;

  authenticateRequest(token: string | null, req?: import("express").Request): Promise<AuthPrincipal | null>;
}
```

### 5. Browser Auth Provider Contract

```ts
interface PortalBrowserAuthProvider {
  initialize(config: PortalPublicAuthConfig): Promise<void>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  getAccessToken(): Promise<string | null>;
  getAccount(): PortalBrowserAccount | null;
  handleRedirect?(): Promise<void>;
}
```

This allows `usePortalAuth()` to stop hardcoding MSAL-specific logic.

### 6. Common AuthZ Engine Contract

```ts
interface PortalAuthorizationPolicy {
  defaultRole: "user" | "admin";
  adminGroups: string[];
  userGroups: string[];
  allowUnauthenticated?: boolean;
}

function authorizePrincipal(
  principal: AuthPrincipal | null,
  policy: PortalAuthorizationPolicy,
): AuthorizationDecision;
```

---

## Folder Structure

### Server-Side Auth

```text
packages/portal/
  auth/
    index.js                      # provider registry + high-level helpers
    types.ts                      # AuthPrincipal, AuthorizationDecision, config types
    config.js                     # env parsing + policy loading
    normalize/
      entra.js                    # map Entra claims -> AuthPrincipal
      iam.js                      # map IAM/Identity Center claims -> AuthPrincipal
      gcp.js                      # map Google claims -> AuthPrincipal
    providers/
      none.js
      entra.js
      iam.js
      gcp.js
    authz/
      engine.js                   # authorizePrincipal()
      policies.js                 # phase policies and policy helpers
      ownership.js                # ownership / visibility predicates
```

### Browser-Side Auth

```text
packages/portal/src/
  auth/
    use-portal-auth.js            # hook, provider dispatcher
    types.ts
    providers/
      none.js
      entra.js                    # MSAL implementation
      iam.js                      # IAM Identity Center / OIDC / upstream proxy bridge
      gcp.js                      # Google Identity / OIDC implementation
```

### Shared Runtime Policy Surface

```text
packages/sdk/
  src/
    auth/
      types.ts                    # optional future shared AuthPrincipal/AuthContext types
```

### Why split browser and server providers?

- browser providers handle sign-in and token acquisition
- server providers handle token verification and claim normalization
- we should not force the browser and server to share implementation details
- each side can evolve independently while sharing type contracts

---

## Provider Strategy

## `none`

Purpose:

- local development
- unsecured demos
- embedded/local-only workflows

Behavior:

- browser signs in automatically
- server yields anonymous/null principal
- authz engine returns allow if `allowUnauthenticated=true`

## `entra`

Purpose:

- Microsoft-first enterprise deployments

Browser:

- MSAL
- popup on desktop, redirect on mobile

Server:

- `jose.jwtVerify`
- issuer = Microsoft tenant issuer
- audience = client id
- normalize:
  - `sub` or `oid` -> `subject`
  - `preferred_username` / `email`
  - `name`
  - `groups`
  - app roles if present

## `iam`

Purpose:

- AWS-centered deployments

Recommended meaning in this proposal:

- an AWS identity-backed provider, not raw browser SigV4 as the initial implementation

Supported implementation modes:

1. **OIDC mode**
   - AWS IAM Identity Center or Cognito issues OIDC/JWT tokens
   - browser acquires token
   - server validates token against issuer JWKS

2. **Trusted proxy / header mode**
   - an upstream auth gateway or ALB authenticates the user
   - portal receives signed/trusted identity headers
   - server provider normalizes those headers into `AuthPrincipal`

Non-goal for initial implementation:

- native browser-side SigV4 request signing for all portal requests

## `gcp`

Purpose:

- Google Workspace / Google Cloud-centered deployments

Browser:

- Google Identity Services or OIDC flow

Server:

- JWT verification against Google issuer/JWKS
- normalize Google subject, email, groups/claims where available

---

## Configuration Model

We need both:

1. **Portal-facing JSON config**
2. **Deployment-facing `.env` config**

### Design Rule

- `plugin.json` selects the provider and display behavior
- `.env` supplies sensitive or deployment-specific values

This keeps provider switching declarative while leaving secrets out of JSON.

---

## `plugin.json` Changes

### Current Direction

Portal customization already lives under `portal.*`.

We should extend that with a provider-neutral auth block.

### Proposed `plugin.json`

```json
{
  "portal": {
    "branding": {
      "title": "PilotSwarm",
      "pageTitle": "PilotSwarm Portal"
    },
    "auth": {
      "provider": "entra",
      "providers": {
        "none": {
          "enabled": true
        },
        "entra": {
          "enabled": true,
          "displayName": "Entra ID"
        },
        "iam": {
          "enabled": true,
          "displayName": "AWS IAM"
        },
        "gcp": {
          "enabled": true,
          "displayName": "Google Identity"
        }
      },
      "signInTitle": "Sign in to PilotSwarm",
      "signInMessage": "Use your organization's identity provider to access the workspace.",
      "signInLabel": "Sign In"
    }
  }
}
```

### Notes

- `portal.auth.provider` is the selected provider id.
- `portal.auth.providers` is optional metadata for installed/known providers.
- `displayName` is UI copy only.
- provider secrets, tenants, client ids, and endpoints do **not** belong in `plugin.json`.

### Minimal Variant

If we want to keep JSON smaller:

```json
{
  "portal": {
    "auth": {
      "provider": "none"
    }
  }
}
```

The server can still use `.env` to fully configure the selected provider.

---

## `.env` Changes

### Common Variables

These variables are provider-neutral and should be preferred over provider-specific role envs:

```bash
PORTAL_AUTH_PROVIDER=entra
PORTAL_AUTHZ_DEFAULT_ROLE=user
PORTAL_AUTHZ_ADMIN_GROUPS=
PORTAL_AUTHZ_USER_GROUPS=
PORTAL_AUTH_ALLOW_UNAUTHENTICATED=false
```

### `none`

```bash
PORTAL_AUTH_PROVIDER=none
PORTAL_AUTH_ALLOW_UNAUTHENTICATED=true
```

### `entra`

```bash
PORTAL_AUTH_PROVIDER=entra
PORTAL_AUTH_ENTRA_TENANT_ID=<tenant-id>
PORTAL_AUTH_ENTRA_CLIENT_ID=<client-id>

PORTAL_AUTHZ_DEFAULT_ROLE=user
PORTAL_AUTHZ_ADMIN_GROUPS=admin1@contoso.com,admin2@contoso.com
PORTAL_AUTHZ_USER_GROUPS=user1@contoso.com,user2@contoso.com
```

### `iam`

```bash
PORTAL_AUTH_PROVIDER=iam
PORTAL_AUTH_IAM_MODE=oidc
PORTAL_AUTH_IAM_ISSUER=https://your-issuer.example.com
PORTAL_AUTH_IAM_CLIENT_ID=<client-id>
PORTAL_AUTH_IAM_JWKS_URI=https://your-issuer.example.com/.well-known/jwks.json

PORTAL_AUTHZ_ADMIN_GROUPS=admin1@contoso.com,admin2@contoso.com
PORTAL_AUTHZ_USER_GROUPS=user1@contoso.com,user2@contoso.com
```

Alternative trusted-proxy mode:

```bash
PORTAL_AUTH_PROVIDER=iam
PORTAL_AUTH_IAM_MODE=headers
PORTAL_AUTH_IAM_TRUST_PROXY_HEADERS=true
PORTAL_AUTH_IAM_SUBJECT_HEADER=x-auth-subject
PORTAL_AUTH_IAM_EMAIL_HEADER=x-auth-email
PORTAL_AUTH_IAM_GROUPS_HEADER=x-auth-groups
```

### `gcp`

```bash
PORTAL_AUTH_PROVIDER=gcp
PORTAL_AUTH_GCP_ISSUER=https://accounts.google.com
PORTAL_AUTH_GCP_CLIENT_ID=<client-id>

PORTAL_AUTHZ_ADMIN_GROUPS=admin1@contoso.com,admin2@contoso.com
PORTAL_AUTHZ_USER_GROUPS=user1@contoso.com,user2@contoso.com
```

### Provider Selection Rules

1. `PORTAL_AUTH_PROVIDER` wins
2. else `plugin.json portal.auth.provider`
3. else infer from provider-specific env vars
4. else default to `none`

This preserves backward compatibility while making provider choice explicit.

---

## Authorization Model

## Phase 1: Shared Authenticated Workspace

Phase 1 introduces authorization but keeps admin/user permissions effectively the same.

### Roles

| Role | How assigned | Permissions |
|---|---|---|
| `admin` | Member of admin groups | Same as `user` in Phase 1 |
| `user` | Member of user groups or default authenticated role | Same as `admin` in Phase 1 |
| denied | Authenticated but email not in allowed admin/user list when authz gate configured | No access |

### Phase 1 Permissions

| Capability | Admin | User |
|---|---|---|
| Access portal | Yes | Yes |
| List sessions | Yes | Yes |
| Open any visible session | Yes | Yes |
| Create session | Yes | Yes |
| Rename own or any visible session | Yes | Yes |
| Send prompts | Yes | Yes |
| Download artifacts from visible sessions | Yes | Yes |
| View logs/inspector/activity | Yes | Yes |

In other words:

- Phase 1 authz is primarily an **admission control** and **role normalization** layer.
- It does not yet restrict session visibility by role.

### Phase 1 Common Policy

Pseudo-logic:

```text
if provider == none and allowUnauthenticated:
  allow anonymous as user

if no authenticated principal:
  deny (401)

if no admin/user groups configured:
  allow as defaultRole

if principal.groups intersects adminGroups:
  allow as admin

if principal.groups intersects userGroups:
  allow as user

otherwise:
  deny (403)
```

### Why Phase 1 This Way?

- fast operational win
- lets admins gate access by security group
- no breaking change to current collaboration model
- establishes normalized principals and request auth context before visibility enforcement

---

## Phase 2: User Sees Only Own Sessions

Phase 2 introduces ownership-aware visibility.

### New Requirement

Non-admin users can only:

- list their own sessions
- view their own sessions
- send prompts to their own sessions
- rename/cancel/delete their own sessions
- access artifacts for their own sessions

Admins can:

- view all sessions
- manage all sessions

### Phase 2 Permissions

| Capability | Admin | User |
|---|---|---|
| Access portal | Yes | Yes |
| List all sessions | Yes | No |
| List own sessions | Yes | Yes |
| Open own sessions | Yes | Yes |
| Open another user's session | Yes | No |
| Create session | Yes | Yes |
| Rename own session | Yes | Yes |
| Rename another user's session | Yes | No |
| Send prompts to own session | Yes | Yes |
| Send prompts to another user's session | Yes | No |
| Download own artifacts | Yes | Yes |
| Download another user's artifacts | Yes | No |

### Data Model Additions

We need durable ownership on the session record.

Recommended additions:

```text
sessions
  owner_subject      TEXT NOT NULL
  owner_provider     TEXT NOT NULL
  owner_email        TEXT NULL
  created_by_name    TEXT NULL
```

Optional later additions:

```text
  visibility         TEXT NOT NULL DEFAULT 'private'  # private | shared | system
```

### Ownership Predicate

```text
isOwner(session, principal) :=
  session.owner_subject == principal.subject
  and session.owner_provider == principal.provider
```

### Runtime Enforcement

Policy checks should happen at:

- `listSessions`
- `getSession`
- `sendMessage`
- `renameSession`
- `cancelSession`
- `completeSession`
- `deleteSession`
- artifact list/download APIs

Implementation rule:

- do not return unauthorized sessions and then filter in the browser
- enforce on the server/runtime boundary

### List Behavior

Phase 2 `listSessions`:

- `admin`: return all visible sessions
- `user`: return only owned sessions plus future shared/system sessions if explicitly allowed

---

## Proposed Module Responsibilities

## `packages/portal/auth/index.js`

Responsibilities:

- resolve provider id
- build provider instance
- export high-level helpers:
  - `getAuthProvider()`
  - `getAuthConfig(req)`
  - `authenticateRequest(req)`
  - `extractToken(req)`

## `packages/portal/auth/config.js`

Responsibilities:

- parse env vars
- merge plugin.json auth config
- compute final provider selection
- load authz policy

## `packages/portal/auth/providers/*.js`

Responsibilities:

- provider-specific verification
- provider-specific public config for browser
- call provider-specific normalization

## `packages/portal/auth/normalize/*.js`

Responsibilities:

- map raw provider claims into `AuthPrincipal`

## `packages/portal/auth/authz/engine.js`

Responsibilities:

- common group and role evaluation
- return `AuthorizationDecision`

## `packages/portal/auth/authz/ownership.js`

Responsibilities:

- helpers like:
  - `canViewSession(auth, session)`
  - `canMutateSession(auth, session)`
  - `filterSessionsForPrincipal(auth, sessions)`

## `packages/portal/src/auth/use-portal-auth.js`

Responsibilities:

- browser-side provider dispatch
- shared signed-in/signed-out state machine
- call provider adapters for sign-in/sign-out/token

## `packages/portal/src/auth/providers/*.js`

Responsibilities:

- browser SDK integration per provider
- no server policy logic

---

## Request Lifecycle

### REST

```text
request
  -> extract token
  -> server provider authenticates token
  -> normalize principal
  -> authz engine evaluates role / allow
  -> req.auth = { principal, authorization }
  -> route handler checks ownership if needed
  -> 200 / 401 / 403
```

### WebSocket

```text
connect
  -> extract token from subprotocol
  -> authenticate + normalize
  -> authorize
  -> accept or close 4401/4403
```

Recommended WebSocket close codes:

- `4401`: unauthenticated
- `4403`: authenticated but not authorized

---

## HTTP Semantics

### `401 Unauthorized`

Use when:

- missing token
- expired token
- invalid token
- unsupported auth flow for selected provider

### `403 Forbidden`

Use when:

- token is valid
- principal is authenticated
- authz policy denies access

This distinction is important for operator clarity and browser UX.

---

## Proposed Rollout Plan

## Phase 0: Refactor for Extensibility

1. Move current auth helpers into `packages/portal/auth/index.js`
2. Add provider registry on both server and browser
3. Introduce `AuthPrincipal` and `RequestAuthContext`
4. Refactor Entra implementation to normalize claims
5. Keep current behavior unchanged with `entra` and `none`

## Phase 1: Common AuthZ Admission Control

1. Add common authz engine
2. Add provider-neutral envs:
   - `PORTAL_AUTHZ_ADMIN_GROUPS`
   - `PORTAL_AUTHZ_USER_GROUPS`
3. Add Entra group-based allow/deny
4. Return `403` on denied principals
5. Surface role and auth status in `/api/bootstrap` or `/api/auth/me`
6. Keep session visibility unchanged

Deliverable:

- admins and users both work the same in the portal
- deployments can gate entry by security groups

## Phase 2: Session Ownership Enforcement

1. Add session ownership columns
2. Populate owner fields on session creation
3. Add ownership filter helpers
4. Restrict list/get/mutate/artifact access for `user`
5. Allow `admin` to see all sessions
6. Add tests for visibility and mutation gates

Deliverable:

- users only see and act on their own sessions
- admins retain fleet-wide visibility

## Phase 3: Additional Providers

1. Add `iam` browser + server provider
2. Add `gcp` browser + server provider
3. Reuse common authz engine unchanged

Deliverable:

- provider add-ons share one policy system

---

## Testing Plan

### Unit Tests

- provider env parsing
- provider selection precedence
- Entra claim normalization
- IAM normalization
- GCP normalization
- authz engine:
  - no groups configured
  - admin group match
  - user group match
  - no group match
  - anonymous allow/deny

### Integration Tests

- REST `401` vs `403`
- WebSocket `4401` vs `4403`
- `/api/portal-config` provider config emission
- Phase 1 shared visibility
- Phase 2 ownership filtering

### Browser Tests

- `none` provider signed-in bypass
- `entra` sign-in and token refresh path
- provider dispatcher error handling for unsupported configs

---

## Risks

## Browser provider complexity

Risk:

- provider-specific SDKs can bloat the browser bundle

Mitigation:

- code-split provider adapters
- load only the selected provider

## Ambiguous AWS semantics

Risk:

- `iam` can mean too many things

Mitigation:

- document `iam` as an auth provider family
- explicitly support `oidc` and `headers` modes first
- defer raw SigV4 browser auth

## Group claim overage

Risk:

- email-allowlist authz avoids group-claim overage problems but depends on a usable email claim

Mitigation:

- fail closed when group-gated authz is configured but claims are insufficient
- later add optional directory/graph lookup if needed

## Ownership migration

Risk:

- existing sessions may not have owners

Mitigation:

- treat legacy sessions as admin-visible only during migration
- or assign synthetic system ownership for pre-auth sessions

---

## Recommendation

Implement this in two practical steps:

1. **Phase 1 now**
   - browser provider abstraction
   - server principal normalization
   - common authz engine
   - Entra group-gated admission
   - provider-neutral config surface

2. **Phase 2 next**
   - session ownership columns
   - list/get/mutate filtering for non-admin users

This gets us a clean provider architecture without overcommitting to a full enterprise authorization system on day one.

---

## Proposed Examples

### Example: unsecured local dev

`plugin.json`

```json
{
  "portal": {
    "auth": {
      "provider": "none"
    }
  }
}
```

`.env`

```bash
PORTAL_AUTH_PROVIDER=none
PORTAL_AUTH_ALLOW_UNAUTHENTICATED=true
```

### Example: Entra-secured production

`plugin.json`

```json
{
  "portal": {
    "auth": {
      "provider": "entra",
      "signInTitle": "Sign in to PilotSwarm",
      "signInMessage": "Use Entra ID authentication with your Microsoft work account."
    }
  }
}
```

`.env`

```bash
PORTAL_AUTH_PROVIDER=entra
PORTAL_AUTH_ENTRA_TENANT_ID=00000000-0000-0000-0000-000000000000
PORTAL_AUTH_ENTRA_CLIENT_ID=11111111-1111-1111-1111-111111111111
PORTAL_AUTHZ_ADMIN_GROUPS=22222222-2222-2222-2222-222222222222
PORTAL_AUTHZ_USER_GROUPS=33333333-3333-3333-3333-333333333333
```

### Example: AWS identity-backed deployment

`plugin.json`

```json
{
  "portal": {
    "auth": {
      "provider": "iam",
      "signInTitle": "Sign in to PilotSwarm",
      "signInMessage": "Use your AWS-backed organization identity to access the workspace."
    }
  }
}
```

`.env`

```bash
PORTAL_AUTH_PROVIDER=iam
PORTAL_AUTH_IAM_MODE=oidc
PORTAL_AUTH_IAM_ISSUER=https://your-issuer.example.com
PORTAL_AUTH_IAM_CLIENT_ID=pilotswarm-portal
PORTAL_AUTH_IAM_JWKS_URI=https://your-issuer.example.com/.well-known/jwks.json
PORTAL_AUTHZ_ADMIN_GROUPS=platform-admins
PORTAL_AUTHZ_USER_GROUPS=platform-users
```

---

## Final Recommendation

Treat auth providers as plug-ins for identity, and treat authorization as one shared policy engine over normalized principals.

That gives PilotSwarm:

- `none` for local development
- `entra` for Microsoft-first deployments
- `iam` for AWS identity-backed deployments
- `gcp` for Google identity-backed deployments

with one authz story and a safe path from shared workspace access to per-user session isolation.
