# Choosing a Client

Every way of talking to a deployment rides the same Web API
(see [Layering](../architecture/layering.md)). Pick the layer that matches
your app's shape:

| You are building… | Use | Package / doc |
|---|---|---|
| A service or script that **drives sessions to completion** (send, wait for the answer, resume) | `PilotSwarmClient({ apiUrl })` + `PilotSwarmManagementClient({ apiUrl })` | [`pilotswarm-sdk`](../developer/building/sdk-apps.md) |
| Something that **reads/writes facts or the knowledge graph** | `createWebFactStore(api)` / `createWebGraphStore(api)` — the SDK's `FactStore`/`GraphStore` interfaces over HTTP | [Facts & Graph](../developer/building/facts-and-graph.md) |
| Your **own UI** (state-driven: session lists, live event streams) | `HttpApiTransport`, or raw `ApiClient` | [Building a Custom UX](./building-a-custom-ux.md), [`pilotswarm-sdk/api`](../../packages/sdk/api/README.md) |
| An **LLM/agent integration** (Claude Desktop, Cursor, custom MCP client) | the MCP server, `pilotswarm-mcp --api-url` | [`pilotswarm`](../../packages/app/mcp/README.md) |
| A **non-JS client** (curl, another language) | raw HTTP against `/api/v1` | [Web API Reference](./reference.md) |

## Rules of thumb

- **App-shaped work wants the SDK clients.** `sendAndWait`, resume semantics,
  turn completion, typed management calls — don't re-implement these over raw
  HTTP.
- **UI-shaped work wants the transport.** A UI tracks many sessions in its own
  store and reduces raw events; stateful session handles would fight it. The
  shipped portal and TUI both sit on `HttpApiTransport` for exactly this
  reason.
- **Never bypass the seam.** `{ store }` constructors and `--store` flags are
  internal (portal server, workers, tests). If you're holding a database URL
  in a user-facing process, you're on the wrong layer.
- **The operations table is the contract.** All of these clients are thin over
  `packages/sdk/api/src/protocol.js`; the reference doc is generated from
  it, and the portal server's routes are too.

## Workers are the exception

`PilotSwarmWorker` always connects directly to the datastore (`{ store }`).
It is the trusted backend that executes turns — it is not a client of the
deployment, it is part of it.
