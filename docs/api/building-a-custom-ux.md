# Building a Custom UX over the Web API

You can build your own UI — web app, dashboard, bot, native shell — directly
against a PilotSwarm deployment. The only thing your app needs is the
deployment URL. This guide is the recipe; the
[Web API Reference](./reference.md) is the contract, and
[Choosing a Client](./clients.md) helps you pick the right layer to build on.

Everything here uses [`pilotswarm-sdk/api`](../../packages/sdk/api/README.md) —
zero-dependency, isomorphic (browser + Node ≥ 22), and the same client the
shipped portal UI and remote TUI are built on.

## The shape of a UI

```text
  bootstrap ──► render ──► subscribe (WS) ──► reduce events into state
                                 │
                        reconnect? ──► replay events afterSeq ──► merge
```

The one rule to internalize: **WebSocket delivery is an acceleration path;
replay is the correctness mechanism.** Never treat the socket as a reliable
stream — after any reconnect, catch up with
`getSessionEvents(sessionId, afterSeq)` and merge by sequence number.

## 1. Connect and bootstrap

```js
import { ApiClient } from "pilotswarm-sdk/api";

const api = new ApiClient({
  apiUrl: "https://portal.example.com",
  getAccessToken,          // see Auth below; omit on no-auth deployments
  onUnauthorized: () => showSignIn(),
});

const health = await api.health();          // { ok, started, mode, apiVersion }
const boot = await api.getBootstrap();      // models, creatable agents, log config,
                                            // session policy, auth context — one call
```

`GET /api/v1/bootstrap` exists so a UI can render its first frame from a
single round-trip: models by provider, agents you can create sessions for,
whether log tailing is available (and if not, why), and the caller's own
principal/authorization.

## 2. Drive sessions

Every operation in the [reference](./reference.md) is one
`api.call(name, params)` — names and parameter placement come from the
operations table, so nothing here is bespoke:

```js
const session = await api.call("createSession", { model: boot.defaultModel });
await api.call("sendMessage", { sessionId: session.sessionId, prompt: "hello" });

// paging, groups, stats — same pattern
const page = await api.call("listSessionsPage", { limit: 50 });
```

## 3. Subscribe, reduce, replay

```js
let lastSeq = 0;

function apply(event) {
  if (event.seq != null && event.seq <= lastSeq) return;   // dedupe
  if (event.seq != null) lastSeq = event.seq;
  reduceIntoYourState(event);                              // your store/reducer
}

const unsubscribe = api.subscribeSession(
  session.sessionId,
  apply,
  // Fires after EVERY reconnect — this is where correctness happens:
  async () => {
    const missed = await api.call("getSessionEvents", {
      sessionId: session.sessionId, afterSeq: lastSeq, limit: 500,
    });
    for (const event of missed) apply(event);
  },
);
```

`ApiClient` owns the socket lifecycle: one `/api/v1/ws` connection multiplexes
all session subscriptions and the log tail, reconnects with backoff, and
re-announces every subscription on reconnect (then calls your `onResubscribe`).

Log streaming works the same way (`api.subscribeLogs(handler)`) but is
**live-only** — there is no history endpoint, so don't build UI that expects
log catch-up.

## 4. Auth

Discover the deployment's mode first — never hardcode it:

```js
const authConfig = await api.getAuthConfig();
// { enabled, provider: "none" | "entra", client: { clientId, authority, redirectUri } | null }
```

- **`none`** — pass no `getAccessToken`; you're done.
- **`entra`, browser SPA** — feed the discovered `clientId`/`authority` into
  MSAL's SPA flow and hand the token getter to `ApiClient`:

```js
import { PublicClientApplication } from "@azure/msal-browser";

const msal = new PublicClientApplication({
  auth: {
    clientId: authConfig.client.clientId,
    authority: authConfig.client.authority,
    redirectUri: window.location.origin,   // must be registered as a SPA redirect URI
  },
});
await msal.initialize();

async function getAccessToken() {
  const scopes = [`${authConfig.client.clientId}/.default`];
  const account = msal.getAllAccounts()[0];
  if (!account) { await msal.loginRedirect({ scopes }); return null; }
  try {
    return (await msal.acquireTokenSilent({ scopes, account })).accessToken;
  } catch {
    await msal.acquireTokenRedirect({ scopes });
    return null;
  }
}
```

  Your app's origin must be added to the deployment's app registration as a
  **SPA redirect URI** — see [Portal Entra App Roles](../developer/deploy/entra-app-roles.md).

- **`entra`, headless/service** — set a service-principal token in
  `getAccessToken` (the MCP server's `PILOTSWARM_API_TOKEN` pattern), or reuse
  the cache written by `pilotswarm auth login --api-url <url>`.

On 401/403 the client calls your `onUnauthorized`/`onForbidden` hooks; the
WebSocket closes with `4401`/`4403` and suppresses reconnection until you fix
the token. A `403` body carries the authorization engine's reason — show it.

## 5. Or start one level up: `HttpApiTransport`

If your UX is session-list-shaped (like the portal or TUI), skip the raw calls
and use `HttpApiTransport` — the flat transport surface the shipped UIs are
built on. It wraps every operation as a method (`listSessionsPage`,
`sendMessage`, `startLogTail`, `uploadArtifactContent`, …), handles the
subscribe/replay wiring, and exposes the same `getLogConfig`/bootstrap
conveniences:

```js
import { HttpApiTransport } from "pilotswarm-sdk/api";
const transport = new HttpApiTransport({ apiUrl, getAccessToken });
await transport.start();
const sessions = await transport.listSessionsPage({ limit: 50 });
```

If instead your app is **lifecycle-shaped** — drive a session, wait for the
answer — use the SDK clients, not raw HTTP: see
[Choosing a Client](./clients.md).

## Gotchas

- **Don't invent operation names** — everything routes through the operations
  table (`packages/sdk/api/src/protocol.js`); if it's not there, it's not API.
- **Errors are enveloped**: `{ ok: false, error: { code, message } }`. 4xx
  messages are actionable and safe to show; 5xx messages are generic by design.
- **Binary artifacts** download via the bespoke
  `GET …/artifacts/:filename/download` route (streams with
  `Content-Disposition`), not the JSON envelope.
- **Admin-tagged operations** (see reference) return `403` for non-admin
  callers — hide those affordances based on `bootstrap.auth`'s role.
