# pilotswarm-mcp-proxy

A reusable in-cluster **MCP-over-HTTP REST adapter host** that runs upstream
operations **as the caller's delegated credential only**. The host holds **no
credentials of its own**—it validates that a caller presented an interactive
(delegated) bearer, then forwards that same bearer to the upstream resource.

Ships with a **Kusto adapter** (adhoc KQL against Azure Data Explorer), but the proxy
core is upstream-agnostic: any adapter that registers MCP tools and forwards
`requireBearer()` can reuse it.

## Why this exists

PilotSwarm workers speak MCP, but many useful services expose only
OAuth-protected REST APIs. This includes both publicly documented APIs for which
no MCP server exists and proprietary APIs whose contracts must remain in a
consumer-owned repository. Embedding every service's protocol, domain tools,
and dependencies in the worker would make the runtime application-specific.
Giving agents an unrestricted HTTP tool would also discard typed tool
contracts, upstream allowlists, bounded responses, and resource-specific
policy.

The adapter host bridges that gap. A worker calls a narrow MCP tool; the adapter
maps it to the upstream REST operation and forwards the caller's request-scoped
delegated bearer. The worker remains generic, the upstream operation runs as the
human who requested it, and the adapter holds no durable credential.

Kusto is the included reference implementation, but it is only one way to use
the host.

## Compatibility boundary: why MCP instead of a worker-native tool

Many existing agent definitions, skills, fleet configurations, and acceptance
tests already depend on an MCP tool contract. Replacing that contract with a
worker-native SDK tool is not an implementation-only change: consumers may
need new tool names, argument schemas, response handling, allowlists, and
deployment configuration.

The adapter preserves that compatibility boundary:

```text
existing agents and skills
          |
          | stable MCP tools and schemas
          v
MCP compatibility adapter
          |
          | REST API or native SDK
          v
upstream service
```

For example, the Kusto contract can continue to expose `kusto_query`,
`kusto_show_tables`, and `kusto_show_schema` even if its internal implementation
changes. The current implementation forwards the caller's delegated bearer to
Kusto REST. A future implementation could use the native Kusto SDK and a
dedicated shared identity while retaining the same MCP endpoint, tool names,
arguments, and result envelope. That would avoid forcing every consuming
repository to rewrite its agents and skills merely because the authentication
or client implementation changed.

This host is therefore not an unrestricted HTTP proxy and is not required for
every integration. It is useful when an MCP-compatible consumer surface must
remain stable while the upstream API has no suitable MCP server or its
implementation must remain independently deployable. A tightly coupled,
high-throughput workload that owns both its worker and its agent definitions
may reasonably choose a worker-native tool instead.

## Choose an extension model

| Upstream capability | Recommended integration | Where implementation and configuration live |
| --- | --- | --- |
| A secure HTTP MCP server already accepts the caller's delegated bearer | Connect the worker directly. Do not add this host. | The MCP server owner supplies the implementation; the consuming repository supplies its URL and tool policy. |
| A public, reusable REST API has no compatible MCP server | Use or contribute a reusable adapter, then deploy a named instance with consumer-owned endpoint configuration. | PilotSwarm may own the adapter when its tool semantics and REST translation contain no consumer-specific IP. The consumer still owns URLs, resource names, allowlists, routing, and deployment values. |
| A proprietary REST API has no compatible MCP server | Build and deploy a consumer-owned adapter on the generic host. | The consumer owns the API contract, tool semantics, REST translation, image, and configuration; PilotSwarm owns only transport, delegated-auth propagation, and the deployment contract. |

The public-API model is how a SQL-focused deployment can reuse the Kusto adapter:
PilotSwarm owns the generic Kusto REST mapping, while the consuming repository
supplies its Kusto cluster, database, allowed hosts, service routing, and
acceptance tests. These are endpoint and resource settings—not a credential or
embedded secret.

The proprietary-API model applies when the REST contract or tool surface is
consumer-specific. For example, a consumer can package tools for an internal
incident or diagnostics REST API in its own repository and image while importing
the same adapter host. That implementation does not move into PilotSwarm merely
because it uses the platform's MCP-over-HTTP pattern.

The workspace package exports the stable
`pilotswarm-mcp-proxy/adapter-host` subpath used below. The package is still
private, so a separate repository must include it in its composition build (or
use a future published artifact) rather than assuming it is available from the
public npm registry.

In all models, credentials remain runtime inputs. Never commit bearer tokens,
client secrets, passwords, or credential-bearing connection strings to either
the platform or consumer repository.

## Architecture: Kusto reference adapter

```
 worker (MCP client)                     mcp-proxy (this)                 Kusto
 ───────────────────      HTTP/MCP      ──────────────────    v1/rest    ───────
 1. GET/POST /mcp  ───────────────────►  auth middleware
                          401 + WWW-Authenticate: Bearer
                          resource_id="https://kusto.kusto.windows.net",
                          scope=".../.default"   (INLINE — no PRM URL)
 2. acquire token for that audience
 3. POST /mcp  (Bearer <caller>) ─────►  gate: interactive?  ──► forward ──►  query
                                         bind bearer (ALS)       Bearer <caller>
```

### The inline-challenge contract (critical)

The 401 advertises the upstream audience **inline** via `resource_id` + `scope` and
emits **no** `resource_metadata`. An in-cluster plain-HTTP `Service` cannot host an
`https` PRM document, and the worker's discovery **refuses a non-`https` PRM fetch**
(SSRF guard). Advertising inline lets the worker learn the audience with zero fetch.

The challenge is emitted by `buildWwwAuthenticate()` from `pilotswarm-sdk` — the same
module the worker uses to `parseWwwAuthenticate()`, so emit and parse share one source
of truth.

### Delegated-only gate

- Missing bearer → `401` + challenge.
- App-only (managed-identity) bearer → `403 interactive_credential_required`
  (unless `ALLOW_APP_TOKENS=true`).
- Interactive/delegated bearer → forwarded.

Interactivity is classified from **unverified** claims (`idtyp`, `scp`, user
principal). The proxy never verifies signatures — the upstream resource is the
authority; this gate is a fail-closed pre-check.

## Tools (Kusto adapter)

| Tool                | KQL                                  |
| ------------------- | ------------------------------------ |
| `kusto_query`       | arbitrary query (`... | take N`)     |
| `kusto_show_tables` | `.show tables`                       |
| `kusto_show_schema` | `.show table <t> schema as json`     |

Defaults: cluster `https://help.kusto.windows.net`, database `Samples`,
`maxRows` 50. Try `kusto_query { query: "StormEvents | take 1" }`.

## Build a consumer-owned adapter for a REST API

Use the proxy host when an OAuth-protected API does not already provide a
compatible HTTP MCP server. The adapter supplies the OAuth audience, MCP tool
schemas, REST mapping, and response shaping; the host supplies MCP transport,
the authentication challenge, delegated-only enforcement, and request-scoped
bearer isolation.

This synthetic widget API has one REST operation:

```text
GET https://widgets.example.test/v1/widgets/{widgetId}
Authorization: Bearer <caller's delegated token>
```

The corresponding adapter is:

```ts
import { z } from "zod";
import { buildProxyApp, requireBearer } from "pilotswarm-mcp-proxy/adapter-host";

const app = buildProxyApp({
  auth: {
    resourceId: "api://synthetic-widgets",
    scope: "api://synthetic-widgets/.default",
    allowAppTokens: false,
  },
  serverInfo: { name: "synthetic-widget-mcp", version: "1.0.0" },
  registerTools(server) {
    server.registerTool(
      "get_widget",
      {
        description: "Read one widget as the caller",
        inputSchema: { widget_id: z.string().min(1) },
      },
      async ({ widget_id }) => {
        const response = await fetch(
          `https://widgets.example.test/v1/widgets/${encodeURIComponent(widget_id)}`,
          {
            headers: {
              Authorization: `Bearer ${requireBearer()}`,
              Accept: "application/json",
            },
          },
        );
        if (!response.ok) {
          return {
            content: [{ type: "text", text: `Widget API returned HTTP ${response.status}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(await response.json()) }],
        };
      },
    );
  },
});
```

See the compiled and tested
[`synthetic-rest-api.ts`](src/examples/synthetic-rest-api.ts) reference for
explicit HTTPS validation, bounded upstream errors, injectable HTTP transport,
and a complete app builder. Its integration test proves that the MCP call is
translated to REST and receives the same request-scoped bearer.

When adapting it:

1. Replace the synthetic audience and scope with the upstream API's OAuth resource.
2. Keep upstream hosts operator-configured or explicitly allowlisted; never accept an arbitrary tool-supplied URL.
3. Define narrow, typed tools instead of exposing a generic HTTP request tool.
4. Use `requireBearer()` for every upstream request; never fall back to a service credential.
5. Bound response size, request duration, and error content for the target API.

If the upstream already provides a secure HTTP MCP endpoint that accepts the
caller's delegated bearer, connect the worker directly instead of adding an
adapter.

## Configuration (env)

| Variable                  | Default                               |
| ------------------------- | ------------------------------------- |
| `PORT`                    | `8080`                                |
| `KUSTO_DEFAULT_CLUSTER`   | `https://help.kusto.windows.net`  |
| `KUSTO_DEFAULT_DATABASE`  | `Samples`                           |
| `KUSTO_ALLOWED_CLUSTERS`  | *(default cluster host)*              |
| `KUSTO_MAX_ROWS`          | `50`                                  |
| `KUSTO_HTTP_TIMEOUT_MS`   | `60000`                               |
| `ALLOW_APP_TOKENS`        | `false`                               |

## Endpoints

- `GET /healthz` — liveness (public)
- `GET /.well-known/oauth-protected-resource` — PRM (public; informational)
- `POST /mcp` — stateless MCP (JSON responses); requires bearer
- `GET|DELETE /mcp` — `405` (no server-initiated streams)

Every MCP response includes an `x-request-id`. The host emits one structured
stdout record when the response finishes containing only that ID, the pod
hostname, HTTP method, path, status, and duration. Health and metadata probes are
excluded. The host never logs authorization headers, MCP arguments, or upstream
response content.

## Develop

```sh
npm install                       # from repo root (registers this workspace)
npm run build   -w pilotswarm-mcp-proxy
npm run lint    -w pilotswarm-mcp-proxy    # tsc --noEmit
npm test        -w pilotswarm-mcp-proxy
npm start       -w pilotswarm-mcp-proxy    # listens on :8080
```

## Deployment

Deployed as a `Deployment` (not a DaemonSet) with a `ClusterIP` Service in the
`pilotswarm` namespace. **No workload identity is attached** — the proxy must not have
any Azure identity of its own. The platform-owned manifests live under
`deploy/gitops/mcp-proxy/`.

A reusable adapter included in this repository, such as Kusto, uses the normal
local-build and publish pipeline:

```sh
npm run deploy -- mcp-proxy <env> \
  --instance <name> \
  --env-overlay <consumer-values.env>
```

The consumer overlay sets `MCP_PROXY_RESOURCE_NAME`,
`MCP_PROXY_REPLICAS`, and non-secret adapter settings through
`MCP_PROXY_EXTRA_ENV`. A proprietary consumer image can set the complete
`MCP_PROXY_IMAGE` reference and run only
`--steps bicep,manifests,rollout`; its REST contract and adapter code never need
to enter the platform repository.
