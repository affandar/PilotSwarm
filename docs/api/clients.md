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

## Inline message limits

Prompts and answers are limited to **12 KiB (12,288 bytes)** for the serialized
UTF-8 JSON envelope, including message IDs, sender metadata, attachment
references, and JSON escaping. This is not a model token/context-window limit.
The SDK exports `MAX_MESSAGE_BYTES` and `MessageTooLargeError`; Web API callers
receive HTTP `413` with `error.code: "MESSAGE_TOO_LARGE"` and an actionable
message. Rejection happens before enqueueing or changing the session state.

Upload large JSON, reports, or source documents as artifacts and send a short
reference. The runtime never truncates a rejected prompt or splits it into
independently executed requests. A rejected inline message leaves the session
available for a corrected request.

Orchestration 1.0.79 also validates serialized FIFO items after runtime context
is added. Messages from older clients or already in the durable queue that
exceed the 14 KiB FIFO item budget produce `session.message_rejected`, with
`code`, `message`, `actualBytes`, `maxBytes`, and `clientMessageIds`. This event
is a rejection receipt, not a successful turn or a failed session. It is
available through session-event reads and subscriptions. Existing terminal
sessions are not revived by this protection.

## Workers are the exception

`PilotSwarmWorker` always connects directly to the datastore (`{ store }`).
It is the trusted backend that executes turns — it is not a client of the
deployment, it is part of it.
