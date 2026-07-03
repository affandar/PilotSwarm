# pilotswarm-sdk/api

Isomorphic protocol client for the [PilotSwarm Web API](../../docs/api/reference.md)
(`/api/v1` + `/api/v1/ws`). Runs in browsers and Node (≥22) with zero
dependencies — `fetch` and `WebSocket` come from the environment and are
injectable for tests.

This package is the transport layer under everything that talks to a
PilotSwarm deployment remotely: the browser portal, the TUI's API mode, and
the SDK's web provider (`new PilotSwarmClient({ apiUrl })`). Most applications
should use the [SDK](../sdk/README.md) rather than this package directly.

```js
import { ApiClient } from "pilotswarm-sdk/api";

const api = new ApiClient({
  apiUrl: "https://portal.example.com",
  getAccessToken, // optional; omit for no-auth deployments
});

const session = await api.call("createSession", { model: "anthropic:claude-sonnet-4-6" });
await api.call("sendMessage", { sessionId: session.sessionId, prompt: "hello" });
const unsubscribe = api.subscribeSession(session.sessionId, (event) => console.log(event));
```

## Modules

- `src/protocol.js` — the **operations table**: every JSON operation's name,
  HTTP method, path template, and parameter placement. This is the single
  source of truth shared with the portal server (which generates its routes
  from it) and the API reference doc.
- `src/api-client.js` — `ApiClient`: request building, `{ ok, result }`
  envelope handling, 401/403 callbacks, and the `/api/v1/ws` WebSocket with
  automatic resubscribe + backoff.
- `src/http-api-transport.js` — `HttpApiTransport`: the shared-UI transport
  surface (`pilotswarm/ui-core`) over `ApiClient`. Environment conveniences
  (save-to-disk, open-in-app) are injected by the host (browser portal, TUI).

## Auth

`getAccessToken` is called before every request and WebSocket connect. HTTP
401/403 invoke `onUnauthorized`/`onForbidden`; WebSocket close codes 4401/4403
do the same and suppress reconnection. Deployment auth mode is discovered from
the public `GET /api/v1/auth/config` (`api.getAuthConfig()`).
