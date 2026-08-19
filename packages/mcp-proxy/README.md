# pilotswarm-mcp-proxy

A generic in-cluster **HTTP MCP auth proxy** that runs upstream operations **as the
caller's delegated credential only**. The proxy holds **no credentials of its own** —
it validates that a caller presented an interactive (delegated) bearer, then forwards
that same bearer verbatim to the upstream resource.

Ships with a **Kusto adapter** (adhoc KQL against Azure Data Explorer), but the proxy
core is upstream-agnostic: any adapter that registers MCP tools and forwards
`currentBearer()` can reuse it.

## Why this exists

Autonomous workers (PilotSwarm sessions) need to run adhoc Kusto queries **as the
human who requested the work**, never as the worker's own managed identity. This proxy
is the narrow, auditable choke point that enforces that: it is a pure bearer-forwarder.

## Architecture

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
any Azure identity of its own. See `deploy/` for kustomize manifests.
