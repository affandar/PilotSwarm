# Delegated MCP Upstream Auth — Implementation & Configuration

How a repo-pinned worker connects to the MCP servers a repository declares
(in its `.vscode/mcp.json`) **as the calling user**, by discovering each
server's required token audience at runtime and injecting a caller-scoped token
— with **no** hardcoded server→audience table and **no** fallback to the
platform's own identity.

## Problem

A worker runs a session on behalf of a user and must talk to the remote MCP
servers a repository declares. Those servers are protected APIs, and different
servers accept tokens for **different audiences** (one wants a first-party
service's app; another wants its own `api://<app-id>`). We cannot ship a static
map of "server → audience" (repos are arbitrary and this code is public), and we
must never present the platform's managed identity to an upstream server — doing
so would let a session borrow the platform's privileges (a confused-deputy
escalation).

## How it works

Resolution happens **pre-flight**, before the MCP server config is handed to the
agent, in `packages/sdk/src/mcp-auth-discovery.ts`.

For each remote server that does not already carry an explicit `Authorization`
header:

1. **Probe** — send an unauthenticated MCP `initialize` request to the server.
2. **Read the challenge** — on `HTTP 401`, parse the `WWW-Authenticate: Bearer`
   header (RFC 6750).
3. **Discover the audience** — follow the `resource_metadata` URL to the
   protected-resource-metadata document (RFC 9728) and read `scopes_supported` /
   `resource`. That yields the audience the server accepts.
4. **Obtain a caller token for that audience** — ask the configured
   [token provider](#token-providers) for a token whose `aud` is the discovered
   audience.
5. **Inject or fast-fail**:
   - provider returns a token → inject it as `Authorization: Bearer <token>`;
   - provider returns `null` (caller cannot obtain one) → **fast-fail** the
     session with a clear error.

Servers that require no auth are left unauthenticated. Stdio/command servers run
locally as the worker and are never touched.

```
probe → 401 WWW-Authenticate → PRM document → required audience
      → provider(audience) → token? inject : FAST-FAIL
```

### Security invariants

- The only identity that ever reaches an upstream MCP server is the **caller's**.
- The platform/worker identity is used **only** for control-plane operations
  (reading the caller credential out of the secret store, and — in OBO mode —
  authenticating the token-exchange request). It is **never** presented to a
  data-plane MCP server.
- When no caller credential matches a server's audience, the session
  **fast-fails**; it never silently downgrades to the platform identity.

## Token providers

The audience→token step is a pluggable seam (`CallerTokenProvider`). Swapping the
implementation changes *how* a per-audience token is obtained without touching
the discovery or fast-fail flow.

### Static provider (default)

`staticTokenProvider(token)` — a single pre-minted caller token, returned only
for audiences its own `aud` claim already matches (else `null`). Simple, but it
can only satisfy servers whose audience the caller already holds a token for.

### On-Behalf-Of provider (generic)

`oboTokenProvider(callerAssertion, config)` in
`packages/sdk/src/caller-token-provider.ts` — exchanges the caller's delegated
**assertion** for a token whose `aud` is the *discovered* audience, using the
OAuth 2.0 On-Behalf-Of flow (RFC 8693-style `jwt-bearer` grant). This lets **any**
server the caller is entitled to succeed, with no static table.

Exchange request (to the identity provider's token endpoint):

```
grant_type          = urn:ietf:params:oauth:grant-type:jwt-bearer
client_id           = <platform confidential-client app id>
assertion           = <caller's delegated assertion>
scope               = <discovered audience>/.default
requested_token_use = on_behalf_of
# authenticated by the platform app's federated client assertion
# (client_assertion minted by the worker's managed identity — no secret)
```

The returned access token has `aud` = the discovered audience and represents the
caller. Tokens are cached per requested scope for their lifetime. If the identity
provider **refuses** the exchange (the caller is not consented/entitled for that
audience), the provider returns `null` → the worker fast-fails. The platform
identity is never substituted.

The platform app authenticates the exchange **secretlessly**, with a federated
credential: the worker's managed identity mints a token for the token-exchange
audience (`api://AzureADTokenExchange`) that is presented as the
`client_assertion`. No client secret is used, stored, or rotated anywhere — the
platform app simply carries a federated identity credential that trusts the
worker's managed identity.

## Identity-provider configuration

Configuration splits into a **one-time platform setup** (steps 1–4, done once
for the whole platform) and a **per-audience entitlement** (step 5, repeated once
for each downstream API the platform must reach on the user's behalf). None of it
is a per-server or per-repo change — adding a new MCP server "just works" if its
API audience has already been entitled in step 5.

**One-time platform setup (steps 1–4 — run once):**

| # | Item | Purpose |
|---|------|---------|
| 1 | **Register a confidential-client app** ("delegated MCP") | The app the caller consents to; its id → `CALLER_OBO_CLIENT_ID`. |
| 2 | **Expose it as an API** (app-id-URI) | The client acquires the caller's token with **this app** as `aud`; that token is the OBO *assertion*. |
| 3 | **Expose a delegated scope** (e.g. `access_as_user`) | The scope the client requests when acquiring the caller assertion. |
| 4 | **Configure a federated identity credential** | Add a federated credential that trusts the worker's user-assigned managed identity, so the platform app authenticates the token exchange **without a stored secret**. (A client secret is only needed for local dev without federation.) |

**Per-audience entitlement (step 5 — run once per downstream API):**

| # | Item | Purpose |
|---|------|---------|
| 5 | **Grant delegated permission + admin-consent for one downstream API** | Add that API's delegated scope to the platform app and admin-consent it. Repeat for **each distinct audience** the platform will call (e.g. one for the version-control API, one for a service's `api://<app-guid>`). It is keyed on the **token audience**, not the server count — many servers sharing one audience need only one entitlement. **This consent is the guardrail** — entitled → exchange succeeds; not entitled → fast-fail. |

Notes on step 5:
- OBO is **delegated-only** — the downstream API must expose a delegated scope
  (`user_impersonation` / `access_as_user`). An API that only publishes
  application roles cannot be an OBO target.
- Admin-consent authorizes the **platform app**; the exchanged token still carries
  the **user's** identity, so the caller must independently have access to that API.
- This is pure identity-provider configuration — no code change and nothing added
  to this repo. The set of entitled audiences *is* the platform's allowlist of
  reachable backends.

The client acquiring the caller assertion (steps 2–3) must request the token with
the confidential-client app (step 1) as the audience, and hand it to the platform
to be stored for the session (never in the durable payload).

## Environment configuration

Set on the worker fleet:

| Variable | Required | Meaning |
|----------|----------|---------|
| `CALLER_AUTH_KEYVAULT_NAME` | yes (for delegated auth) | Secret store the worker reads the caller credential from. |
| `CALLER_AUTH_MODE` | no (default `static`) | `static` = single-token provider; `obo` = On-Behalf-Of exchange. |
| `CALLER_OBO_TENANT_ID` | when `obo` | Tenant that issues the exchanged token. |
| `CALLER_OBO_CLIENT_ID` | when `obo` | The confidential-client app id (step 1). |
| `CALLER_OBO_AUTHORITY_HOST` | no | Override the identity-provider login host (non-public clouds). |
| `CALLER_OBO_EXCHANGE_AUDIENCE` | no | Override the federated token-exchange audience (default `api://AzureADTokenExchange`). |

The exchange is always authenticated with the worker's managed identity via a
federated credential — there is **no** client-secret variable to set or protect.
If `CALLER_AUTH_MODE=obo` but the tenant/client id are missing, the worker logs
the gap and falls back to the static provider, so delegated auth is never
silently lost.

## Testing

- **Unit** — `packages/sdk/test/local/mcp-auth-discovery.test.mjs` covers the
  pure helpers, the provider seam (static match, provider-mints-per-audience,
  provider-returns-null → fast-fail), and the OBO provider against a mocked token
  endpoint (secret + federated credential, caching, and identity-provider refusal
  → `null` → fast-fail).
- **End-to-end** — a multi-server acceptance run should show a server whose
  audience the caller can satisfy completing a tool call, and a server whose
  audience the caller cannot satisfy fast-failing with zero tool calls (proving
  no platform-identity fallback).
