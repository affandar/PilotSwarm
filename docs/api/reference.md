# PilotSwarm Web API Reference

The Web API is the supported way to talk to a PilotSwarm deployment: a
versioned HTTP + WebSocket surface hosted by the portal server at `/api/v1`
and `/api/v1/ws`. Clients need exactly one thing — the deployment URL — and
never hold database or storage credentials.

Most callers should use a higher-level client rather than raw HTTP:

- **SDK (Node):** `new PilotSwarmClient({ apiUrl })` / `new PilotSwarmManagementClient({ apiUrl })`
- **Browser / isomorphic:** [`pilotswarm-sdk/api`](../../packages/sdk/api/README.md)
- **TUI:** `npx pilotswarm remote --api-url <url>`

To read and write the **Facts** and **Graph** surfaces (below) from an SDK app as
`FactStore` / `GraphStore` instances rather than raw HTTP, see the
[Facts & Graph SDK guide](../developer/building/facts-and-graph.md).

The contract's source of truth is the operations table in
[`packages/sdk/api/src/protocol.js`](../../packages/sdk/api/src/protocol.js) —
the portal server generates its routes from it, so this document cannot be
more current than that file. The operation tables below are generated from it.

## Conventions

- **Envelope:** every JSON operation responds `{ "ok": true, "result": … }` or
  `{ "ok": false, "error": { "code", "message" } }`.
- **Statuses:** `400` invalid request · `401` missing/invalid token ·
  `403` authenticated but not admitted (the `message` carries the authz
  reason) · `404` not found · `500` unexpected · plus operation-specific
  errors surfaced with their own codes.
- **Query types:** `boolean` params take `true`/`false`; `json` params take
  URL-encoded JSON (e.g. the paging `cursor`); dates are ISO 8601 strings.
- **Body:** JSON, limit 2 MB (binary artifact uploads ride base64 within it).

## Auth

Auth mode is discovered from the public `GET /api/v1/auth/config`
(`{ enabled, provider, client: { clientId, authority, redirectUri } | null }`).

- **`none`** — no token; every caller shares the synthetic
  `none/unknown` principal.
- **`entra`** — send `Authorization: Bearer <token>` with a v2 access token
  for scope `<clientId>/.default`. Browsers use MSAL; the TUI uses the
  interactive browser flow / auth code + PKCE (`pilotswarm auth login`; `--device-code` for headless hosts). WebSocket upgrades accept the
  bearer header or the subprotocol list `["access_token", <token>]` and
  close `4401`/`4403` on failure.

Admission follows the portal's authorization engine (app roles →
email allowlists → `PORTAL_AUTHZ_DEFAULT_ROLE`); a `403` body carries the
engine's reason.

## Bespoke routes

| Route | Auth | Description |
|---|---|---|
| `GET /api/v1/health` | public | `{ ok, started, mode, apiVersion }` — readiness probe target |
| `GET /api/v1/auth/config` | public | Auth provider discovery (see above) |
| `GET /api/v1/auth/me` | authed | `{ principal, authorization }` for the caller |
| `GET /api/v1/bootstrap` | authed | Mode, worker count, log config, models, creatable agents, session policy, auth context |
| `GET /api/v1/sessions/:sessionId/artifacts/:filename/download` | authed | Binary artifact stream (`Content-Disposition: attachment`) |

## Streaming: `WS /api/v1/ws`

```text
client -> server: subscribeSession { sessionId } | unsubscribeSession { sessionId }
                  | subscribeLogs {} | unsubscribeLogs {}
server -> client: ready | subscribedSession { sessionId } | sessionEvent { sessionId, event }
                  | subscribedLogs | logEntry { entry } | error { scope, sessionId?, error }
```

WebSocket delivery is an acceleration path; correctness comes from replay —
after a reconnect, catch up with
`GET /api/v1/management/sessions/:sessionId/events?afterSeq=…`. The log tail
is live-only (no history, no catch-up).

## Operations

Operations tagged **[admin]** require the `admin` role. Session operations are
also authorized by access class: read/write may be delegated by visibility or
targeted grants; manage/destroy/share remain owner/admin only. Inaccessible
sessions return not-found to avoid an existence oracle.

### Sessions

| Operation | Route | Parameters | Summary |
|---|---|---|---|
| listSessions | `GET /api/v1/sessions` | — | List session summaries. |
| createSession | `POST /api/v1/sessions` | model (body), reasoningEffort (body), contextTier (body), groupId (body), visibility (body) | Create a session. Owner is the authenticated principal; visibility defaults to the deployment default. |
| createSessionForAgent | `POST /api/v1/sessions/for-agent` | agentName (body), model (body), reasoningEffort (body), contextTier (body), title (body), splash (body), initialPrompt (body), groupId (body), visibility (body) | Create a session bound to a named agent. |
| getSession | `GET /api/v1/sessions/:sessionId` | sessionId (path) | Get one session view (live orchestration status). |
| deleteSession | `DELETE /api/v1/sessions/:sessionId` | sessionId (path) | Cancel and soft-delete a session. |
| sendMessage | `POST /api/v1/sessions/:sessionId/messages` | sessionId (path), prompt (body), options (body) | Send a prompt (options: { enqueueOnly?, clientMessageIds? }). |
| sendAnswer | `POST /api/v1/sessions/:sessionId/answers` | sessionId (path), answer (body) | Answer a pending input-required question. |
| sendSessionEvent | `POST /api/v1/sessions/:sessionId/events` | sessionId (path), eventName (body), data (body) | Send a custom event into the session. |
| cancelPendingMessage | `POST /api/v1/sessions/:sessionId/cancel-pending` | sessionId (path), clientMessageIds (body) | Cancel queued messages by client message ids. |

### Session sharing

| Operation | Route | Access | Summary |
|---|---|---|---|
| getSessionAccess | `GET /api/v1/sessions/:sessionId/access` | readable session | Effective visibility, relation, owner, and write/manage flags. |
| setSessionVisibility | `PUT /api/v1/sessions/:sessionId/visibility` | owner/admin | Set `private`, `shared_read`, or `shared_write` on the whole session tree. |
| grantSessionShare | `POST /api/v1/sessions/:sessionId/shares` | owner/admin | Grant one principal targeted `read` or `write` access. |
| revokeSessionShare | `POST /api/v1/sessions/:sessionId/shares/revoke` | owner/admin | Revoke one targeted grant. |
| listSessionShares | `GET /api/v1/sessions/:sessionId/shares` | owner/admin | List targeted grants and grantee metadata. |
| listAuthzAudit | `GET /api/v1/management/authz-audit` | owner/admin | Owners read audit entries for one owned session; admins can read fleet-wide. |

### Artifacts

| Operation | Route | Parameters | Summary |
|---|---|---|---|
| listArtifacts | `GET /api/v1/sessions/:sessionId/artifacts` | sessionId (path) | List artifacts for a session. |
| getArtifactMetadata | `GET /api/v1/sessions/:sessionId/artifacts/:filename/meta` | sessionId (path), filename (path) | Artifact metadata. |
| downloadArtifact | `GET /api/v1/sessions/:sessionId/artifacts/:filename/text` | sessionId (path), filename (path) | Artifact content as text (JSON envelope). Binary: GET …/download. |
| uploadArtifact | `PUT /api/v1/sessions/:sessionId/artifacts/:filename` | sessionId (path), filename (path), content (body), contentType (body), contentEncoding (body) | Upload artifact content (base64 for binary; 2 MB JSON limit). |
| deleteArtifact | `DELETE /api/v1/sessions/:sessionId/artifacts/:filename` | sessionId (path), filename (path) | Delete an artifact. |
| copyArtifact | JSON-RPC `copyArtifact` | fromSessionId, fromFilename, toSessionId, toFilename? | Server-side artifact copy between sessions; result metadata carries `sha256` and copy provenance. |
| setArtifactPinned | JSON-RPC `setArtifactPinned` | sessionId, filename, pinned | Pin/unpin an artifact; pinned artifacts survive bulk session cleanup. |
| readArtifactBase64 | JSON-RPC `readArtifactBase64` | sessionId, filename, maxBytes? | Size-guarded base64 read for binary artifacts (JSON-safe; default 256 KB, max 1 MB). |

### Management: sessions

| Operation | Route | Parameters | Summary |
|---|---|---|---|
| listSessionsPage | `GET /api/v1/management/sessions` | limit (query: number), cursor (query: json), includeDeleted (query: boolean) | Keyset-paginated session listing. |
| renameSession | `PATCH /api/v1/management/sessions/:sessionId` | sessionId (path), title (body) | Rename a session. |
| cancelSession | `POST /api/v1/management/sessions/:sessionId/cancel` | sessionId (path) | Cancel a session. |
| completeSession | `POST /api/v1/management/sessions/:sessionId/complete` | sessionId (path), reason (body) | Mark a session completed. |
| stopSessionTurn | `POST /api/v1/management/sessions/:sessionId/stop-turn` | sessionId (path), options (body) | Abort the in-flight turn. |
| setSessionModel | `POST /api/v1/management/sessions/:sessionId/model` | sessionId (path), options (body) | Switch the session model ({ model, reasoningEffort? }). |
| restartSystemSession | `POST /api/v1/management/sessions/:agentIdOrSessionId/restart-system` | agentIdOrSessionId (path), options (body) | Restart a system session (complete \| terminate \| hard_delete). |
| exportExecutionHistory | `POST /api/v1/management/sessions/:sessionId/export-execution-history` | sessionId (path) | Export execution history to an artifact; returns artifact meta. |
| getSessionStatus | `GET /api/v1/management/sessions/:sessionId/status` | sessionId (path) | Live custom status + orchestration status. |
| waitForStatusChange | `GET /api/v1/management/sessions/:sessionId/status/wait` | sessionId (path), afterVersion (query: number), timeoutMs (query: number) | Long-poll for a status version change (server-capped timeout). |
| getLatestResponse | `GET /api/v1/management/sessions/:sessionId/latest-response` | sessionId (path) | Latest turn response payload, if any. |
| getOrchestrationStats | `GET /api/v1/management/sessions/:sessionId/orchestration-stats` | sessionId (path) | Orchestration runtime stats. |
| getExecutionHistory | `GET /api/v1/management/sessions/:sessionId/execution-history` | sessionId (path), executionId (query: number) | Raw execution history events. |
| getSessionEvents | `GET /api/v1/management/sessions/:sessionId/events` | sessionId (path), afterSeq (query: number), limit (query: number), eventTypes (query: json) | Session events after a sequence number (reconnect catch-up). Optional eventTypes (JSON string array) narrows to those event types server-side. |
| getSessionEventsBefore | `GET /api/v1/management/sessions/:sessionId/events-before` | sessionId (path), beforeSeq (query: number), limit (query: number), eventTypes (query: json) | Older session events for history paging. Optional eventTypes (JSON string array) narrows to those event types server-side (chat transcript paging). |
| getSessionMetricSummary | `GET /api/v1/management/sessions/:sessionId/metric-summary` | sessionId (path) | Per-session metric summary. |
| getSessionTokensByModel | `GET /api/v1/management/sessions/:sessionId/tokens-by-model` | sessionId (path) | Token totals grouped by model. |
| getSessionTreeStats | `GET /api/v1/management/sessions/:sessionId/tree-stats` | sessionId (path) | Stats rolled up across the spawn tree. |
| getSessionSkillUsage | `GET /api/v1/management/sessions/:sessionId/skill-usage` | sessionId (path), since (query) | Skill usage for one session. |
| getSessionTreeSkillUsage | `GET /api/v1/management/sessions/:sessionId/tree-skill-usage` | sessionId (path), since (query) | Skill usage across the spawn tree. |
| getSessionFactsStats | `GET /api/v1/management/sessions/:sessionId/facts-stats` | sessionId (path) | Facts stats for one session. |
| getSessionTreeFactsStats | `GET /api/v1/management/sessions/:sessionId/tree-facts-stats` | sessionId (path) | Facts stats across the spawn tree. |
| getSessionRetrievalUsage | `GET /api/v1/management/sessions/:sessionId/retrieval-usage` | sessionId (path), since (query) | Retrieval (facts/graph search) usage for one session. |
| getSessionTreeRetrievalUsage | `GET /api/v1/management/sessions/:sessionId/tree-retrieval-usage` | sessionId (path), since (query) | Retrieval usage across the spawn tree. |
| getSessionGraphNodeUsage | `GET /api/v1/management/sessions/:sessionId/graph-node-usage` | sessionId (path), since (query), limit (query: number), nodeKeyLike (query), kind (query) | Graph node usage for one session. |
| getSessionGraphEdgeSearchUsage | `GET /api/v1/management/sessions/:sessionId/graph-edge-search-usage` | sessionId (path), since (query), limit (query: number) | Graph edge-search usage for one session. |
| getSessionGraphSearches | `GET /api/v1/management/sessions/:sessionId/graph-searches` | sessionId (path), limit (query: number) | Recent graph search events for one session. |
| listChildOutcomes | `GET /api/v1/management/sessions/:parentSessionId/child-outcomes` | parentSessionId (path) | Child outcomes recorded under a parent session. |
| getChildOutcome | `GET /api/v1/management/child-outcomes/:childSessionId` | childSessionId (path) | One child outcome. |

### Management: session groups

| Operation | Route | Parameters | Summary |
|---|---|---|---|
| listSessionGroups | `GET /api/v1/management/session-groups` | — | List session groups. |
| createSessionGroup | `POST /api/v1/management/session-groups` | input (body) | Create a session group. |
| updateSessionGroup | `PATCH /api/v1/management/session-groups/:groupId` | groupId (path), patch (body) | Update group title/description. |
| deleteSessionGroup | `DELETE /api/v1/management/session-groups/:groupId` | groupId (path) | Delete an empty session group. |
| assignSessionsToGroup | `POST /api/v1/management/session-groups/:groupId/assign` | groupId (path), sessionIds (body) | Assign sessions to a group. |
| cancelSessionGroup | `POST /api/v1/management/session-groups/:groupId/cancel` | groupId (path), reason (body) | Cancel all sessions in a group. |
| completeSessionGroup | `POST /api/v1/management/session-groups/:groupId/complete` | groupId (path), options (body) | Complete all sessions in a group. |
| moveSessionsToGroup | `POST /api/v1/management/session-groups/move` | groupId (body), sessionIds (body) | Move sessions between groups (groupId null = ungroup). |

### Management: fleet, users, facts, events

| Operation | Route | Parameters | Summary |
|---|---|---|---|
| getFleetStats | `GET /api/v1/management/fleet/stats` | since (query), includeDeleted (query: boolean) | Fleet-wide stats. |
| getFleetSkillUsage | `GET /api/v1/management/fleet/skill-usage` | since (query), includeDeleted (query: boolean) | Fleet-wide skill usage. |
| getFleetRetrievalUsage | `GET /api/v1/management/fleet/retrieval-usage` | since (query), includeDeleted (query: boolean) | Fleet-wide retrieval usage. |
| getFleetGraphNodeUsage | `GET /api/v1/management/fleet/graph-node-usage` | since (query), includeDeleted (query: boolean), limit (query: number), nodeKeyLike (query), kind (query) | Fleet-wide graph node usage. |
| getUserStats | `GET /api/v1/management/users/stats` | since (query), includeDeleted (query: boolean) | Per-user stats. |
| getSharedFactsStats | `GET /api/v1/management/facts/shared-stats` | — | Shared facts stats. |
| getFactsTombstoneStats | `GET /api/v1/management/facts/tombstone-stats` | ttlSeconds (query: number) | Soft-deleted facts awaiting reconciliation. |
| getTopEventEmitters | `GET /api/v1/management/events/top-emitters` | since (query), limit (query: number) | Noisiest event emitters since a date. |
| pruneDeletedSummaries | `POST /api/v1/management/summaries/prune-deleted` | olderThan (body) | Prune summaries of deleted sessions. |

### Facts

| Operation | Route | Parameters | Summary |
|---|---|---|---|
| factsCapabilities | `GET /api/v1/facts/capabilities` | — | Store capabilities: { search, embedder, graph } — the remote isEnhancedFactStore/isGraphStore. |
| readFacts | `GET /api/v1/facts` | keyPattern (query), scopeKeys (query: json), tags (query: json), sessionId (query), agentId (query), limit (query: number), scope (query) | Read facts (ReadFactsQuery params). |
| storeFact | `POST /api/v1/facts` | input (body) | Store a fact or facts (StoreFactInput \| StoreFactInput[]). |
| deleteFact | `POST /api/v1/facts/delete` | input (body) | Delete a fact / pattern (DeleteFactInput). POST because DELETE bodies are unreliable. |
| searchFacts | `POST /api/v1/facts/search` | query (body), opts (body) | Retrieval over facts (lexical \| semantic \| hybrid). [enhanced] |
| similarFacts | `POST /api/v1/facts/similar` | scopeKey (body), opts (body) | Semantic nearest-neighbours of a known fact. [enhanced] |
| getEmbedderStatus | `GET /api/v1/facts/embedder` | — | Durable embedder status. [enhanced] |
| startFactsEmbedder **[admin]** | `POST /api/v1/facts/embedder/start` | intervalSeconds (body), batch (body) | Start the durable embedder loop. [enhanced, admin] |
| stopFactsEmbedder **[admin]** | `POST /api/v1/facts/embedder/stop` | reason (body) | Stop the durable embedder loop. [enhanced, admin] |
| forcePurgeFacts **[admin]** | `POST /api/v1/facts/purge` | input (body) | Force-purge soft-deleted facts (ForcePurgeFactsInput). [admin] |

### Graph

| Operation | Route | Parameters | Summary |
|---|---|---|---|
| searchGraphNodes | `POST /api/v1/graph/nodes/search` | query (body) | Search graph nodes (GraphNodeQuery). |
| searchGraphEdges | `POST /api/v1/graph/edges/search` | query (body) | Search graph edges (GraphEdgeQuery). |
| graphNeighbourhood | `POST /api/v1/graph/neighbourhood` | nodeKey (body), depth (body), namespace (body) | Expand a subgraph around a node. |
| upsertGraphNode | `POST /api/v1/graph/nodes` | input (body) | Upsert a graph node (GraphNodeInput). |
| upsertGraphEdge | `POST /api/v1/graph/edges` | input (body) | Upsert a graph edge (GraphEdgeInput). |
| deleteGraphNode | `POST /api/v1/graph/nodes/delete` | nodeKey (body), namespace (body) | Delete a graph node. |
| deleteGraphEdge | `POST /api/v1/graph/edges/delete` | fromKey (body), toKey (body), predicateKey (body), namespace (body) | Delete a graph edge. |
| graphStats | `GET /api/v1/graph/stats` | namespace (query) | Graph node/edge counts. |
| listGraphNamespaces | `GET /api/v1/graph/namespaces` | prefix (query), includeArchived (query: boolean), includeDetails (query: boolean) | List graph namespaces (corpora). |
| getGraphNamespace | `GET /api/v1/graph/namespaces/:namespace` | namespace (path) | One graph namespace descriptor. |
| upsertGraphNamespace **[admin]** | `POST /api/v1/graph/namespaces` | input (body) | Register/update a graph namespace. [admin] |
| deleteGraphNamespace **[admin]** | `DELETE /api/v1/graph/namespaces/:namespace` | namespace (path) | Delete a graph namespace and its data. [admin] |

### Models, agents, policy

| Operation | Route | Parameters | Summary |
|---|---|---|---|
| listModels | `GET /api/v1/models` | — | All available models. |
| getModelsByProvider | `GET /api/v1/models/by-provider` | — | Models grouped by provider. |
| getDefaultModel | `GET /api/v1/models/default` | — | The deployment default model. |
| listCreatableAgents | `GET /api/v1/agents` | — | Agents sessions can be created for. |
| getSessionCreationPolicy | `GET /api/v1/session-creation-policy` | — | Session creation policy. |

### Current user

| Operation | Route | Parameters | Summary |
|---|---|---|---|
| getCurrentUserProfile | `GET /api/v1/me/profile` | — | Profile of the authenticated principal. |
| setCurrentUserProfileSettings | `PATCH /api/v1/me/profile/settings` | settings (body) | Replace profile settings. |
| setCurrentUserGitHubCopilotKey | `PUT /api/v1/me/github-copilot-key` | key (body) | Set (or clear with null) the per-user GitHub Copilot key. |

### System

| Operation | Route | Parameters | Summary |
|---|---|---|---|
| getLogConfig | `GET /api/v1/system/log-config` | — | Log tail availability. |
| getWorkerCount | `GET /api/v1/system/workers` | — | Live worker count. |

## Long polling

`GET …/status/wait?afterVersion=…&timeoutMs=…` holds the request open until
the session's status version advances or the timeout elapses (server-capped
at 25 s default / 300 s max — loop client-side for longer waits).

## Curl example (no-auth deployment)

```bash
BASE=https://portal.example.com/api/v1
SID=$(curl -s -X POST $BASE/sessions -H 'content-type: application/json' -d '{}' | jq -r .result.sessionId)
curl -s -X POST $BASE/sessions/$SID/messages -H 'content-type: application/json' \
  -d '{"prompt": "What is the capital of France?"}'
# poll status / read events
curl -s "$BASE/management/sessions/$SID/events?limit=50" | jq '.result[].eventType'
```
