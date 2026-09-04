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
- **`proxy`** — the identity-aware front door authenticates the user and adds
  a signed assertion or trusted identity headers to each HTTP and WebSocket
  request. Browser clients send no bearer token directly; discovery returns
  `client: null`. Direct origin access must be blocked when unsigned header
  mode is enabled.

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
| `GET /api/v1/agent-packages/:name/download` | authed | Full SHA-verified package tarball; optional `semver`, `scope`, and admin owner selector query params |

## Streaming: `WS /api/v1/ws`

```text
client -> server: subscribeSession { sessionId } | unsubscribeSession { sessionId }
                  | subscribeLive { sessionId, topics[] } | unsubscribeLive { sessionId }
                  | subscribeLogs {} | unsubscribeLogs {}
server -> client: ready | subscribedSession { sessionId } | sessionEvent { sessionId, event }
                  | subscribedLive { sessionId, topics[] }
                  | live { sessionId, topic, seq, kind, data?, updatedAt? }
                  | subscribedLogs | logEntry { entry } | error { scope, sessionId?, error }
```

WebSocket delivery is an acceleration path; correctness comes from replay —
after a reconnect, catch up with
`GET /api/v1/management/sessions/:sessionId/events?afterSeq=…`. The log tail
is live-only (no history, no catch-up). Generic live topics are ephemeral
last-value state: reconnecting clients receive a retained snapshot from
`getLive` before subsequent notifications. They do not enter session history.

`kind` is `snapshot`, `patch`, `signal`, or `unavailable` (release cached
state and its sequence). Clients ignore stale snapshots, refetch on patch
gaps, and replay durable events independently. Topic subscriptions are limited
to 16 per session; live publishing is server-only. The optional `turn` topic
carries `phase`, `streamId`, message/reasoning IDs and cumulative text, plus
`truncated: true` when a preview reaches its limit. An idle applies only to
its stream. See [live-plane architecture](../architecture/live-plane.md).

## Operations

Operations tagged **[admin]** require the `admin` role. Session operations are
also authorized by access class: read/write may be delegated by visibility or
targeted grants; manage/destroy/share remain owner/admin only. Inaccessible
sessions return not-found to avoid an existence oracle.

### Sessions

| Operation | Route | Parameters | Summary |
|---|---|---|---|
| listSessions | `GET /api/v1/sessions` | — | List session summaries. |
| createSession | `POST /api/v1/sessions` | model (body), reasoningEffort (body), contextTier (body), groupId (body), visibility (body) | Create a session. Owner is the authenticated principal; visibility defaults to the deployment default. `groupId` is an initial placement into one of **your** groups — `403` if the group is missing or not yours. |
| createSessionForAgent | `POST /api/v1/sessions/for-agent` | agentName (body), model (body), reasoningEffort (body), contextTier (body), title (body), splash (body), initialPrompt (body), groupId (body), visibility (body) | Create a session bound to a named agent. Same `groupId` placement rule as createSession. |
| getSession | `GET /api/v1/sessions/:sessionId` | sessionId (path) | Get one session view (live orchestration status). |
| deleteSession | `DELETE /api/v1/sessions/:sessionId` | sessionId (path) | Cancel and soft-delete a session. |
| sendMessage | `POST /api/v1/sessions/:sessionId/messages` | sessionId (path), prompt (body), options (body) | Send a prompt (options: { enqueueOnly?, clientMessageIds? }). |
| sendAnswer | `POST /api/v1/sessions/:sessionId/answers` | sessionId (path), answer (body) | Answer a pending input-required question. |
| sendSessionEvent | `POST /api/v1/sessions/:sessionId/events` | sessionId (path), eventName (body), data (body) | Send a custom event into the session. |
| cancelPendingMessage | `POST /api/v1/sessions/:sessionId/cancel-pending` | sessionId (path), clientMessageIds (body) | Cancel queued messages by client message ids. |

Session DTOs (`listSessions`, `getSession`, paged management listings) carry
**`viewerGroupId`** — the *caller's own* private group placement for the
session's tree root (`null`/absent on child rows and when the caller has not
placed the tree). The former `groupId` field is **gone** from session DTOs:
group membership is per-viewer state, not a property of the session. See
[Management: session groups](#management-session-groups).

### Session sharing

| Operation | Route | Access | Summary |
|---|---|---|---|
| getSessionAccess | `GET /api/v1/sessions/:sessionId/access` | readable session | Effective visibility, relation, owner, write/manage flags, and `viewerGroupId` (the caller's own placement of the tree root — never another viewer's). |
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
| readArtifactBase64 | `GET /api/v1/sessions/:sessionId/artifacts/:filename/base64` | sessionId (path), filename (path), maxBytes (query) | Size-guarded base64 read for binary artifacts (JSON-safe; default 256 KB, max 1 MB). |
| copyArtifact | `POST /api/v1/artifacts/copy` | fromSessionId, fromFilename, toSessionId, toFilename (body) | Server-side artifact copy between sessions (read access on the source, write on the target); result metadata carries `sha256` and copy provenance. |
| setArtifactPinned | `PUT /api/v1/sessions/:sessionId/artifacts/:filename/pinned` | sessionId (path), filename (path), pinned (body) | Pin/unpin an artifact; pinned artifacts survive bulk session cleanup. |

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
| getLive | `GET /api/v1/management/sessions/:sessionId/live` | sessionId (path), topics (query: json) | Current retained values from the ephemeral live plane, optionally filtered by topic. |
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

Session groups are **private per-user organization**. A group belongs to the
caller who created it; placing a session in a group records a
(viewer, tree-root) *placement* that only changes how the catalog looks **to
that viewer**. Placement requires only **read** access to the session — owners,
collaborators, and recipients of shared sessions all organize the same session
into their *own* groups independently, and none of it changes shared session
data or reveals anyone else's grouping.

| Operation | Route | Parameters | Summary |
|---|---|---|---|
| listSessionGroups | `GET /api/v1/management/session-groups` | — | List **your** session groups. Viewer-scoped for every caller — **admins included**: other users' groups are never returned, and member counts/activity reflect only your own placements. |
| createSessionGroup | `POST /api/v1/management/session-groups` | input (body) | Create a session group owned by the caller. |
| updateSessionGroup | `PATCH /api/v1/management/session-groups/:groupId` | groupId (path), patch (body) | Update group title/description. |
| deleteSessionGroup | `DELETE /api/v1/management/session-groups/:groupId` | groupId (path) | Delete a session group. Its placements are cleared; the sessions themselves are untouched (a non-empty group deletes cleanly). |
| placeSessionsInGroup | `POST /api/v1/management/session-groups/place` | groupId (body), sessionIds (body) | Place session trees into one of the caller's groups (`groupId` null = ungroup). Requires read access to each session; changes no shared session data. |
| assignSessionsToGroup | `POST /api/v1/management/session-groups/:groupId/assign` | groupId (path), sessionIds (body) | **Deprecated** alias of placeSessionsInGroup. |
| moveSessionsToGroup | `POST /api/v1/management/session-groups/move` | groupId (body), sessionIds (body) | **Deprecated** alias of placeSessionsInGroup (groupId null = ungroup). |
| cancelSessionGroup | `POST /api/v1/management/session-groups/:groupId/cancel` | groupId (path), reason (body) | **Deprecated.** Cancel all sessions in a group. |
| completeSessionGroup | `POST /api/v1/management/session-groups/:groupId/complete` | groupId (path), options (body) | **Deprecated.** Complete all sessions in a group. |

**placeSessionsInGroup** request/response:

```jsonc
// POST /api/v1/management/session-groups/place
{ "groupId": "grp-123", "sessionIds": ["sess-a", "sess-b"] }   // groupId: null → ungroup

// result: one row per distinct resolved tree root
[
  { "rootSessionId": "sess-a", "placed": true,  "reason": null },
  { "rootSessionId": "sess-b", "placed": false, "reason": "not_found" }
]
```

- Session ids resolve to their **tree root** before placing (children are never
  placed; duplicates collapse to one row).
- Per-row `reason` on `placed: false`: **`not_found`** — the id is unknown *or*
  the caller cannot read it (identical shape by design; no existence oracle) —
  or **`system`** — system trees cannot be placed.
- The target group must be **owned by the caller**: a missing *or* foreign
  `groupId` fails the whole call with **`403`**
  (`"Session group not found or not owned by you."`) — deliberately not
  distinguishing the two. Cross-user placement is structurally impossible.
- The deprecated aliases (`assignSessionsToGroup`, `moveSessionsToGroup`)
  execute the same viewer-private placement and return the same per-row result
  array.

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
| listModels | `GET /api/v1/models` | — | Viewer-usable runtime provider instances (`catalogKind=runtime_provider`). Direct management callers use `listRuntimeModels(viewer)` for the same semantics; synchronous `listModels()` is the type template catalog. |
| getModelsByProvider | `GET /api/v1/models/by-provider` | — | Model templates grouped by provider type (`catalogKind=provider_type`). Use `listModels` for viewer-usable runtime provider instances. |
| getDefaultModel | `GET /api/v1/models/default` | — | The deployment default model. |
| listCreatableAgents | `GET /api/v1/agents` | — | Agents sessions can be created for. |
| getSessionCreationPolicy | `GET /api/v1/session-creation-policy` | — | Session creation policy. |

### Runtime model providers and defaults

| Operation | Route | Parameters | Summary |
|---|---|---|---|
| listProviders | `GET /api/v1/providers` | — | Shared providers, the caller's personal providers, and admin-visible metadata. Credentials are never returned. |
| getProviderUsageSummary | `GET /api/v1/providers/usage-summary` | days? (14/30/90), providers? (comma-separated names) | The cluster summary from the usage ledger: today / week / month token totals with the input, output and cache split, a per-UTC-day series, and the per-model pivot across providers, reasoning efforts and context tiers. Admins see the cluster, system sessions included; everyone else sees their own turns. |
| createMyProvider | `POST /api/v1/me/providers` | name, type, credentials, baseUrl? (body) | Add a private BYOK provider for the authenticated user. |
| updateMyProviderCredential | `PUT /api/v1/me/providers/:name/credential` | name (path), credentials (body) | Replace the credential on the caller's personal provider while preserving its name, defaults, routing references, and usage history. |
| createProvider **[admin]** | `POST /api/v1/management/providers` | name, type, credentials, baseUrl? (body) | Add a shared cluster provider. |
| updateSharedProviderCredential **[admin]** | `PUT /api/v1/management/providers/:name/credential` | name (path), credentials (body) | Replace the credential on a shared provider while preserving its name, defaults, routing references, and usage history. A personal name reads as not found; a provider seeded from the deployment's model-providers file (its key is an environment-variable pointer) is refused. |
| clearProviderRoutingDependencies | `POST /api/v1/providers/:name/clear-routing` | name (path) | Explicitly clear ordinary/system defaults and agent overrides before deleting a provider. Shared providers require admin. |
| setProviderSystemUse **[admin]** | `PUT /api/v1/management/providers/:name/system-use` | name (path), enabled (body) | Permit system sessions to use the calling admin's personal provider without exposing it to other users. |
| getModelDefaults | `GET /api/v1/model-defaults` | — | Configured/effective user and cluster defaults; admins also receive system routing and per-agent overrides. |
| setModelDefault | `PUT /api/v1/model-defaults` | scope, provider, model, reasoningEffort?, contextTier? (body) | Set/clear a user or cluster ordinary-session default. Cluster scope requires admin. Existing sessions do not change. |
| setSystemModelDefault **[admin]** | `PUT /api/v1/management/system-model-default` | provider, model, reasoningEffort?, contextTier?, restartExisting? (body) | Set/clear the system default; optionally restart inheriting sessions with complete, terminate, or hard_delete. |
| setSystemSessionModel **[admin]** | `PUT /api/v1/management/system-sessions/:agentId/model` | agentId (path), provider, model, reasoningEffort?, contextTier? (body) | Set one persistent system-agent model override. |
| clearSystemSessionModel **[admin]** | `DELETE /api/v1/management/system-sessions/:agentId/model` | agentId (path) | Clear one override and return the agent to the system default. |
| getLegacyProviderMigrationStatus **[admin]** | `GET /api/v1/management/providers/legacy-key-migration` | — | Aggregate legacy GHCP migration status; never returns keys or hashes. |
| adoptLegacySystemGitHubCopilotKey **[admin]** | `POST /api/v1/management/providers/adopt-system-github-key` | name (body) | Copy the legacy synthetic System key server-side into the calling admin's private, system-enabled provider. |
| getProviderStatus | `GET /api/v1/providers/status` | names? (query) | Limits, current-window usage, reset times, and the caller's allowance ceiling. |
| getProviderUsageGrid | `GET /api/v1/providers/usage-grid` | — | Every visible provider/model row with fixed day, week, and month meter windows. |
| getProviderUsage | `GET /api/v1/providers/usage` | days?, provider?, model?, mine?, ownerUserId?, sessionId?, chargeClass?, dimension?, limit? (query) | Historical totals, daily series, and a bounded breakdown. Non-admin reads are owner-scoped except aggregate totals for a named shared provider. |
| setProviderLimit | `PUT /api/v1/providers/:name/limit` | name (path), period, model?, tokens (body) | Save/replace one day, week, or month limit for a provider or one qualified model. Shared requires admin; personal requires owner. |
| removeProviderLimit | `DELETE /api/v1/providers/:name/limit` | name (path), period, model? (query) | Remove one provider/model limit. |
| setProviderAllowance **[admin]** | `PUT /api/v1/management/providers/:name/allowance` | name (path), pct (body) | Set the per-user share of shared-provider limits. |
| setProviderHold **[admin]** | `PUT /api/v1/management/providers/:name/hold` | name (path), untilUtc?, release? (body) | Hold or release new turns against a provider. |
| listPausedSessions | `GET /api/v1/providers/paused` | — | Sessions waiting on a provider, limit, allowance, or hold; fleet-wide for admins, own sessions otherwise. |

Trusted session creation resolves `explicit → user default → cluster default →
first usable provider/model`, validates capabilities, and writes the exact
qualified model before orchestration starts. System sessions resolve
`per-agent override → system default → first system-eligible provider/model`.
System-default restart rollouts are serialized per agent with durable claims;
completed agents are idempotently skipped and failed agents can be retried.
Provider accounting is exactly-once per `(session, turn)`. Historical usage
survives session and provider deletion; current rules/meters are removed with a
deleted provider. The budget table always shows fixed day/week/month windows,
while the selected daily chart offers 14-, 30-, and 90-day history ranges.

### Current user

| Operation | Route | Parameters | Summary |
|---|---|---|---|
| getCurrentUserProfile | `GET /api/v1/me/profile` | — | Profile of the authenticated principal. |
| setCurrentUserProfileSettings | `PATCH /api/v1/me/profile/settings` | settings (body) | Replace profile settings. |
| setCurrentUserGitHubCopilotKey **[legacy]** | `PUT /api/v1/me/github-copilot-key` | key (body) | Legacy rollback API. New users add a private GitHub Copilot runtime provider in Admin Console. |

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
