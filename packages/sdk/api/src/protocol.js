/**
 * The PilotSwarm Web API protocol: one table describing every JSON operation
 * under `/api/v1`, plus the WebSocket vocabulary and the error envelope.
 *
 * This table is the single source of truth for the contract. The portal
 * server generates its Express routes from it, `ApiClient` builds requests
 * from it, and `docs/api/reference.md` documents it. Operation names are
 * exactly the method names of the portal runtime dispatcher
 * (`packages/app/web/runtime.js`), which stays the single behavior point.
 *
 * Param placement (`in`):
 *   - "path"  — URL path segment (`:name` in the template)
 *   - "query" — query string; `type` drives server-side coercion
 *   - "body"  — JSON request body field
 * Param types: "string" (default) | "number" | "boolean" | "json".
 * "json" query params carry JSON-encoded values (e.g. the paging cursor).
 *
 * Access classification (`access`) — REQUIRED on every operation; the portal
 * runtime enforces it at dispatch (docs/proposals/user-admin-security-model.md):
 *   - "authed"          admission gate only (any admitted caller)
 *   - "session:list"    viewer-scoped listing (non-admins see their visible set)
 *   - "session:create"  create (still subject to session-creation policy)
 *   - "session:read"    requires read access to the session's tree root
 *   - "session:write"   requires write access (owner, shared_write, write grant)
 *   - "session:manage"  owner or admin
 *   - "session:destroy" owner or admin
 *   - "session:share"   owner or admin (visibility + share grants)
 *   - "group:list"      owner-scoped group listing for non-admins
 *   - "group:manage"    group owner or admin
 *   - "facts:read"|"facts:write"  facts data-plane (role/session-scoped)
 *   - "fleet:read"      admin-only observability
 *   - "fleet:admin"     Tier-2 operational surface (admin)
 * Ops whose session resource rides a non-standard param name declare
 * `sessionParam` (e.g. listChildOutcomes → parentSessionId).
 */

export const API_PREFIX = "/api/v1";
export const API_VERSION = 1;

/** WebSocket endpoint path (auth: Bearer header or ["access_token", <token>] subprotocol). */
export const WS_PATH = "/api/v1/ws";

/** WebSocket message vocabulary (same as the legacy /portal-ws, minus theme). */
export const WS_CLIENT_MESSAGES = ["subscribeSession", "unsubscribeSession", "subscribeLogs", "unsubscribeLogs"];
export const WS_SERVER_MESSAGES = ["ready", "subscribedSession", "sessionEvent", "subscribedLogs", "logEntry", "error"];

/** Error code used when an SDK web-mode method has no API equivalent. */
export const WEB_MODE_UNSUPPORTED = "WEB_MODE_UNSUPPORTED";

const path = (name) => ({ in: "path", name });
const query = (type = "string") => ({ in: "query", type });
const body = () => ({ in: "body" });

/**
 * @type {Array<{
 *   name: string,
 *   method: "GET"|"POST"|"PUT"|"PATCH"|"DELETE",
 *   path: string,
 *   params?: Record<string, { in: "path"|"query"|"body", name?: string, type?: string }>,
 *   summary: string,
 * }>}
 */
export const OPERATIONS = [
    // ── Sessions (client surface) ───────────────────────────────────────
    { name: "listSessions", access: "session:list", method: "GET", path: "/sessions", summary: "List session summaries." },
    { name: "createSession", access: "session:create", method: "POST", path: "/sessions", params: { model: body(), reasoningEffort: body(), contextTier: body(), groupId: body(), visibility: body() }, summary: "Create a session. Owner is the authenticated principal; visibility defaults to the deployment default." },
    { name: "createSessionForAgent", access: "session:create", method: "POST", path: "/sessions/for-agent", params: { agentName: body(), model: body(), reasoningEffort: body(), contextTier: body(), title: body(), splash: body(), splashMobile: body(), initialPrompt: body(), groupId: body(), visibility: body() }, summary: "Create a session bound to a named agent." },
    { name: "getSession", access: "session:read", method: "GET", path: "/sessions/:sessionId", params: { sessionId: path("sessionId") }, summary: "Get one session view (live orchestration status)." },
    { name: "deleteSession", access: "session:destroy", method: "DELETE", path: "/sessions/:sessionId", params: { sessionId: path("sessionId") }, summary: "Cancel and soft-delete a session." },
    { name: "sendMessage", access: "session:write", method: "POST", path: "/sessions/:sessionId/messages", params: { sessionId: path("sessionId"), prompt: body(), options: body() }, summary: "Send a prompt (options: { enqueueOnly?, clientMessageIds?, attachments?: [{filename}] } — attachments reference image artifacts already uploaded to the session)." },
    { name: "sendAnswer", access: "session:write", method: "POST", path: "/sessions/:sessionId/answers", params: { sessionId: path("sessionId"), answer: body() }, summary: "Answer a pending input-required question." },
    { name: "sendSessionEvent", access: "session:write", method: "POST", path: "/sessions/:sessionId/events", params: { sessionId: path("sessionId"), eventName: body(), data: body() }, summary: "Send a custom event into the session." },
    { name: "cancelPendingMessage", access: "session:write", method: "POST", path: "/sessions/:sessionId/cancel-pending", params: { sessionId: path("sessionId"), clientMessageIds: body() }, summary: "Cancel queued messages by client message ids." },

    // ── Session sharing (security model) ────────────────────────────────
    { name: "getSessionAccess", access: "session:read", method: "GET", path: "/sessions/:sessionId/access", params: { sessionId: path("sessionId") }, summary: "The caller's effective access to this session's tree: { visibility, relation, canWrite, canManage, owner }." },
    { name: "setSessionVisibility", access: "session:share", method: "PUT", path: "/sessions/:sessionId/visibility", params: { sessionId: path("sessionId"), visibility: body() }, summary: "Set the tree's sharing level (private | shared_read | shared_write). Owner or admin." },
    { name: "grantSessionShare", access: "session:share", method: "POST", path: "/sessions/:sessionId/shares", params: { sessionId: path("sessionId"), user: body(), access: body() }, summary: "Grant (or update) a targeted share ({ user: { provider, subject, email?, displayName? }, access: read|write }). Owner or admin." },
    { name: "revokeSessionShare", access: "session:share", method: "POST", path: "/sessions/:sessionId/shares/revoke", params: { sessionId: path("sessionId"), user: body() }, summary: "Revoke a targeted share ({ user: { provider, subject } }). Owner or admin." },
    { name: "listSessionShares", access: "session:share", method: "GET", path: "/sessions/:sessionId/shares", params: { sessionId: path("sessionId") }, summary: "List targeted shares on this session's tree. Owner or admin." },
    { name: "listAuthzAudit", access: "authz:audit", method: "GET", path: "/management/authz-audit", params: { limit: query("number"), sessionId: query("string") }, summary: "Authz audit records, newest first. Admin fleet-wide; owners for their own sessions (sessionId required)." },

    // ── Session artifacts (JSON surface; binary download is a bespoke route) ──
    { name: "listArtifacts", access: "session:read", method: "GET", path: "/sessions/:sessionId/artifacts", params: { sessionId: path("sessionId") }, summary: "List artifacts for a session." },
    { name: "getArtifactMetadata", access: "session:read", method: "GET", path: "/sessions/:sessionId/artifacts/:filename/meta", params: { sessionId: path("sessionId"), filename: path("filename") }, summary: "Artifact metadata." },
    { name: "downloadArtifact", access: "session:read", method: "GET", path: "/sessions/:sessionId/artifacts/:filename/text", params: { sessionId: path("sessionId"), filename: path("filename") }, summary: "Artifact content as text (JSON envelope). Binary: GET …/download." },
    { name: "uploadArtifact", access: "session:write", method: "PUT", path: "/sessions/:sessionId/artifacts/:filename", params: { sessionId: path("sessionId"), filename: path("filename"), content: body(), contentType: body(), contentEncoding: body() }, summary: "Upload artifact content (base64 for binary; 2 MB JSON limit)." },
    { name: "deleteArtifact", access: "session:manage", method: "DELETE", path: "/sessions/:sessionId/artifacts/:filename", params: { sessionId: path("sessionId"), filename: path("filename") }, summary: "Delete an artifact." },
    // These three were dispatchable (runtime.js) and access-classified
    // (authz.js RPC_ONLY_ACCESS) but reachable only through the legacy
    // /api/rpc path — every ApiClient.call() of them threw "Unknown API
    // operation" client-side, which silently broke the MCP artifact
    // read-base64/copy/pin actions in web mode. Table rows give them
    // generated routes with the same authz (session:copy gates
    // fromSessionId for read + toSessionId for write by param name).
    { name: "readArtifactBase64", access: "session:read", method: "GET", path: "/sessions/:sessionId/artifacts/:filename/base64", params: { sessionId: path("sessionId"), filename: path("filename"), maxBytes: query("number") }, summary: "Artifact content as base64 (JSON envelope; maxBytes caps the read, truncated flag set when hit)." },
    { name: "copyArtifact", access: "session:copy", method: "POST", path: "/artifacts/copy", params: { fromSessionId: body(), fromFilename: body(), toSessionId: body(), toFilename: body() }, summary: "Copy an artifact across sessions (read access on the source, write on the target)." },
    { name: "setArtifactPinned", access: "session:manage", method: "PUT", path: "/sessions/:sessionId/artifacts/:filename/pinned", params: { sessionId: path("sessionId"), filename: path("filename"), pinned: body() }, summary: "Pin/unpin an artifact (pinned artifacts survive retention sweeps)." },

    // ── Management: sessions ────────────────────────────────────────────
    { name: "listSessionsPage", access: "session:list", method: "GET", path: "/management/sessions", params: { limit: query("number"), cursor: query("json"), includeDeleted: query("boolean") }, summary: "Keyset-paginated session listing." },
    { name: "renameSession", access: "session:manage", method: "PATCH", path: "/management/sessions/:sessionId", params: { sessionId: path("sessionId"), title: body() }, summary: "Rename a session." },
    { name: "cancelSession", access: "session:manage", method: "POST", path: "/management/sessions/:sessionId/cancel", params: { sessionId: path("sessionId") }, summary: "Cancel a session." },
    { name: "completeSession", access: "session:manage", method: "POST", path: "/management/sessions/:sessionId/complete", params: { sessionId: path("sessionId"), reason: body() }, summary: "Mark a session completed." },
    { name: "stopSessionTurn", access: "session:write", method: "POST", path: "/management/sessions/:sessionId/stop-turn", params: { sessionId: path("sessionId"), options: body() }, summary: "Abort the in-flight turn." },
    { name: "setSessionModel", access: "session:manage", method: "POST", path: "/management/sessions/:sessionId/model", params: { sessionId: path("sessionId"), options: body() }, summary: "Switch the session model ({ model, reasoningEffort?, contextTier? })." },
    { name: "restartSystemSession", access: "fleet:admin", method: "POST", path: "/management/sessions/:agentIdOrSessionId/restart-system", params: { agentIdOrSessionId: path("agentIdOrSessionId"), options: body() }, summary: "Restart a system session (complete | terminate | hard_delete)." },
    { name: "exportExecutionHistory", access: "session:manage", method: "POST", path: "/management/sessions/:sessionId/export-execution-history", params: { sessionId: path("sessionId") }, summary: "Export execution history to an artifact; returns artifact meta." },
    { name: "getSessionStatus", access: "session:read", method: "GET", path: "/management/sessions/:sessionId/status", params: { sessionId: path("sessionId") }, summary: "Live custom status + orchestration status." },
    { name: "waitForStatusChange", access: "session:read", method: "GET", path: "/management/sessions/:sessionId/status/wait", params: { sessionId: path("sessionId"), afterVersion: query("number"), timeoutMs: query("number") }, summary: "Long-poll for a status version change (server-capped timeout)." },
    { name: "getLatestResponse", access: "session:read", method: "GET", path: "/management/sessions/:sessionId/latest-response", params: { sessionId: path("sessionId") }, summary: "Latest turn response payload, if any." },
    { name: "getOrchestrationStats", access: "session:read", method: "GET", path: "/management/sessions/:sessionId/orchestration-stats", params: { sessionId: path("sessionId") }, summary: "Orchestration runtime stats." },
    { name: "getExecutionHistory", access: "session:read", method: "GET", path: "/management/sessions/:sessionId/execution-history", params: { sessionId: path("sessionId"), executionId: query("number") }, summary: "Raw execution history events." },
    { name: "getSessionEvents", access: "session:read", method: "GET", path: "/management/sessions/:sessionId/events", params: { sessionId: path("sessionId"), afterSeq: query("number"), limit: query("number"), eventTypes: query("json") }, summary: "Session events after a sequence number (reconnect catch-up). Optional eventTypes (JSON string array) narrows to those event types server-side." },
    { name: "getSessionEventsBefore", access: "session:read", method: "GET", path: "/management/sessions/:sessionId/events-before", params: { sessionId: path("sessionId"), beforeSeq: query("number"), limit: query("number"), eventTypes: query("json") }, summary: "Older session events for history paging. Optional eventTypes (JSON string array) narrows to those event types server-side (chat transcript paging)." },
    { name: "getCanvasLive", access: "session:read", method: "GET", path: "/management/sessions/:sessionId/canvas-live", params: { sessionId: path("sessionId") }, summary: "The canvas data plane's last-value rows: current doc pointer + latest merged tick per slot. Snapshot source for live canvas subscriptions; empty when the deployment predates the plane." },
    // The canvas KV store (interactive-canvas-apps Part C). canvas:read and
    // canvas:write are their OWN access classes: both gate on session read
    // (a canvas reader may hold no session write), and whether a read-only
    // viewer may WRITE is decided per request by the canvas policy inside
    // the chokepoint, never by the session class.
    { name: "readCanvasKv", access: "canvas:read", method: "GET", path: "/management/sessions/:sessionId/canvas-kv", params: { sessionId: path("sessionId"), slot: query("number"), prefix: query("string"), limit: query("number"), after: query("string"), key: query("string") }, summary: "Read the canvas KV store: entries under a prefix (cursor-paged, ≤200) or one key, plus `me` (relation, canWrite) and the canvas policy. The page's canvas-kv-ready payload." },
    { name: "writeCanvasKv", access: "canvas:write", method: "POST", path: "/management/sessions/:sessionId/canvas-kv", params: { sessionId: path("sessionId"), slot: body(), ops: body() }, summary: "Write the canvas KV store: ops [{op: put|delete, key, value?, ifMatch?}] (≤50). Each op is answered individually; who may write is the canvas policy × the app's kv.write switch; req/* rows from collaborators are capped to status suggested." },
    { name: "setCanvasKvAccess", access: "session:share", method: "PUT", path: "/management/sessions/:sessionId/canvas-kv/access", params: { sessionId: path("sessionId"), slot: body(), access: body() }, summary: "Set who may write this canvas's KV: owner (default) | readers (anyone the session is read-shared with) | link. Owner or admin." },
    { name: "getCanvasShareLink", access: "session:share", method: "GET", path: "/management/sessions/:sessionId/canvas-share-link", params: { sessionId: path("sessionId"), slot: query("number") }, summary: "Whether a public view link exists for this canvas (never the token itself), with created-at/by." },
    { name: "resetCanvasShareLink", access: "session:share", method: "POST", path: "/management/sessions/:sessionId/canvas-share-link/reset", params: { sessionId: path("sessionId"), slot: body() }, summary: "Mint-or-rotate the ONE public view token for this canvas. Returns the raw token exactly once; the previous link stops working immediately." },
    { name: "removeCanvasShareLink", access: "session:share", method: "POST", path: "/management/sessions/:sessionId/canvas-share-link/remove", params: { sessionId: path("sessionId"), slot: body() }, summary: "Delete the public view link; the canvas returns to unlinked." },
    { name: "getSessionMetricSummary", access: "session:read", method: "GET", path: "/management/sessions/:sessionId/metric-summary", params: { sessionId: path("sessionId") }, summary: "Per-session metric summary." },
    { name: "getSessionFootprint", access: "session:read", method: "GET", path: "/management/sessions/:sessionId/footprint", params: { sessionId: path("sessionId") }, summary: "Session footprint: context/compaction health, event-log and snapshot sizes, and an assessment (ok/elevated/degraded) with a recommendation. Control-plane only; TTL-cached." },
    { name: "regenerateSession", access: "session:manage", method: "POST", path: "/management/sessions/:sessionId/regenerate", params: { sessionId: path("sessionId"), options: body() }, summary: "Regenerate the session's transcript in place (epoch rebirth): archive, distill, and recreate the Copilot session at a turn boundary. Enqueue-then-observe; outcomes arrive as session.regenerate_* events." },
    { name: "getSessionTokensByModel", access: "session:read", method: "GET", path: "/management/sessions/:sessionId/tokens-by-model", params: { sessionId: path("sessionId") }, summary: "Token totals grouped by model." },
    { name: "getSessionTreeStats", access: "session:read", method: "GET", path: "/management/sessions/:sessionId/tree-stats", params: { sessionId: path("sessionId") }, summary: "Stats rolled up across the spawn tree." },
    { name: "getSessionSkillUsage", access: "session:read", method: "GET", path: "/management/sessions/:sessionId/skill-usage", params: { sessionId: path("sessionId"), since: query("string") }, summary: "Skill usage for one session." },
    { name: "getSessionTreeSkillUsage", access: "session:read", method: "GET", path: "/management/sessions/:sessionId/tree-skill-usage", params: { sessionId: path("sessionId"), since: query("string") }, summary: "Skill usage across the spawn tree." },
    { name: "getSessionFactsStats", access: "session:read", method: "GET", path: "/management/sessions/:sessionId/facts-stats", params: { sessionId: path("sessionId") }, summary: "Facts stats for one session." },
    { name: "getSessionTreeFactsStats", access: "session:read", method: "GET", path: "/management/sessions/:sessionId/tree-facts-stats", params: { sessionId: path("sessionId") }, summary: "Facts stats across the spawn tree." },
    // Retrieval / graph observability (tuner-grade diagnostics; read-only)
    { name: "getSessionRetrievalUsage", access: "session:read", method: "GET", path: "/management/sessions/:sessionId/retrieval-usage", params: { sessionId: path("sessionId"), since: query("string") }, summary: "Retrieval (facts/graph search) usage for one session." },
    { name: "getSessionTreeRetrievalUsage", access: "session:read", method: "GET", path: "/management/sessions/:sessionId/tree-retrieval-usage", params: { sessionId: path("sessionId"), since: query("string") }, summary: "Retrieval usage across the spawn tree." },
    { name: "getSessionGraphNodeUsage", access: "session:read", method: "GET", path: "/management/sessions/:sessionId/graph-node-usage", params: { sessionId: path("sessionId"), since: query("string"), limit: query("number"), nodeKeyLike: query("string"), kind: query("string") }, summary: "Graph node usage for one session." },
    { name: "getSessionGraphEdgeSearchUsage", access: "session:read", method: "GET", path: "/management/sessions/:sessionId/graph-edge-search-usage", params: { sessionId: path("sessionId"), since: query("string"), limit: query("number") }, summary: "Graph edge-search usage for one session." },
    { name: "getSessionGraphSearches", access: "session:read", method: "GET", path: "/management/sessions/:sessionId/graph-searches", params: { sessionId: path("sessionId"), limit: query("number") }, summary: "Recent graph search events for one session." },
    { name: "listChildOutcomes", access: "session:read", sessionParam: "parentSessionId", method: "GET", path: "/management/sessions/:parentSessionId/child-outcomes", params: { parentSessionId: path("parentSessionId") }, summary: "Child outcomes recorded under a parent session." },
    { name: "getChildOutcome", access: "session:read", sessionParam: "childSessionId", method: "GET", path: "/management/child-outcomes/:childSessionId", params: { childSessionId: path("childSessionId") }, summary: "One child outcome." },

    // ── Management: session groups ──────────────────────────────────────
    { name: "listSessionGroups", access: "group:list", method: "GET", path: "/management/session-groups", summary: "List session groups." },
    { name: "createSessionGroup", access: "authed", method: "POST", path: "/management/session-groups", params: { input: body() }, summary: "Create a session group." },
    { name: "updateSessionGroup", access: "group:manage", method: "PATCH", path: "/management/session-groups/:groupId", params: { groupId: path("groupId"), patch: body() }, summary: "Update group title/description." },
    { name: "deleteSessionGroup", access: "group:manage", method: "DELETE", path: "/management/session-groups/:groupId", params: { groupId: path("groupId") }, summary: "Delete a session group. Clears the owner's placements; sessions are untouched." },
    { name: "placeSessionsInGroup", access: "authed", method: "POST", path: "/management/session-groups/place", params: { groupId: body(), sessionIds: body() }, summary: "Place session trees into one of the caller's groups (groupId null = ungroup). Requires read access to each session; changes no shared session data." },
    { name: "assignSessionsToGroup", access: "authed", method: "POST", path: "/management/session-groups/:groupId/assign", params: { groupId: path("groupId"), sessionIds: body() }, summary: "Deprecated alias of placeSessionsInGroup." },
    { name: "cancelSessionGroup", access: "group:manage", method: "POST", path: "/management/session-groups/:groupId/cancel", params: { groupId: path("groupId"), reason: body() }, summary: "Deprecated: Cancel all sessions in a group." },
    { name: "completeSessionGroup", access: "group:manage", method: "POST", path: "/management/session-groups/:groupId/complete", params: { groupId: path("groupId"), options: body() }, summary: "Deprecated: Complete all sessions in a group." },
    { name: "moveSessionsToGroup", access: "authed", method: "POST", path: "/management/session-groups/move", params: { groupId: body(), sessionIds: body() }, summary: "Deprecated alias of placeSessionsInGroup." },

    // ── Management: fleet / users / facts / events ──────────────────────
    { name: "getFleetStats", access: "fleet:read", method: "GET", path: "/management/fleet/stats", params: { since: query("string"), includeDeleted: query("boolean") }, summary: "Fleet-wide stats." },
    { name: "getFleetSkillUsage", access: "fleet:read", method: "GET", path: "/management/fleet/skill-usage", params: { since: query("string"), includeDeleted: query("boolean") }, summary: "Fleet-wide skill usage." },
    { name: "getFleetRetrievalUsage", access: "fleet:read", method: "GET", path: "/management/fleet/retrieval-usage", params: { since: query("string"), includeDeleted: query("boolean") }, summary: "Fleet-wide retrieval usage." },
    { name: "getFleetGraphNodeUsage", access: "fleet:read", method: "GET", path: "/management/fleet/graph-node-usage", params: { since: query("string"), includeDeleted: query("boolean"), limit: query("number"), nodeKeyLike: query("string"), kind: query("string") }, summary: "Fleet-wide graph node usage." },
    { name: "getUserStats", access: "fleet:read", method: "GET", path: "/management/users/stats", params: { since: query("string"), includeDeleted: query("boolean") }, summary: "Per-user stats." },
    { name: "listKnownUsers", access: "authed", method: "GET", path: "/management/users", params: { limit: query("number") }, summary: "Member directory (provider/subject/email/displayName) for share autocomplete; excludes synthetic principals." },
    { name: "getSharedFactsStats", access: "fleet:read", method: "GET", path: "/management/facts/shared-stats", summary: "Shared facts stats." },
    { name: "getFactsTombstoneStats", access: "fleet:read", method: "GET", path: "/management/facts/tombstone-stats", params: { ttlSeconds: query("number") }, summary: "Soft-deleted facts awaiting reconciliation." },
    { name: "getTopEventEmitters", access: "fleet:read", method: "GET", path: "/management/events/top-emitters", params: { since: query("string"), limit: query("number") }, summary: "Noisiest event emitters since a date." },
    { name: "pruneDeletedSummaries", access: "fleet:admin", method: "POST", path: "/management/summaries/prune-deleted", params: { olderThan: body() }, summary: "Prune summaries of deleted sessions." },

    // ── Facts data-plane (Tier 1: any admitted caller) ──────────────────
    { name: "factsCapabilities", access: "authed", method: "GET", path: "/facts/capabilities", summary: "Store capabilities: { search, embedder, graph } — the remote isEnhancedFactStore/isGraphStore." },
    { name: "readFacts", access: "facts:read", method: "GET", path: "/facts", params: { keyPattern: query("string"), scopeKeys: query("json"), tags: query("json"), sessionId: query("string"), agentId: query("string"), limit: query("number"), scope: query("string") }, summary: "Read facts (ReadFactsQuery params)." },
    { name: "storeFact", access: "facts:write", method: "POST", path: "/facts", params: { input: body() }, summary: "Store a fact or facts (StoreFactInput | StoreFactInput[])." },
    { name: "deleteFact", access: "facts:write", method: "POST", path: "/facts/delete", params: { input: body() }, summary: "Delete a fact / pattern (DeleteFactInput). POST because DELETE bodies are unreliable." },
    { name: "searchFacts", access: "facts:read", method: "POST", path: "/facts/search", params: { query: body(), opts: body() }, summary: "Retrieval over facts (lexical | semantic | hybrid). [enhanced]" },
    { name: "similarFacts", access: "facts:read", method: "POST", path: "/facts/similar", params: { scopeKey: body(), opts: body() }, summary: "Semantic nearest-neighbours of a known fact. [enhanced]" },

    // ── Facts operational (Tier 2: admin) ───────────────────────────────
    { name: "getEmbedderStatus", access: "authed", method: "GET", path: "/facts/embedder", summary: "Durable embedder status. [enhanced]" },
    { name: "startFactsEmbedder", access: "fleet:admin", method: "POST", path: "/facts/embedder/start", params: { intervalSeconds: body(), batch: body() }, admin: true, summary: "Start the durable embedder loop. [enhanced, admin]" },
    { name: "stopFactsEmbedder", access: "fleet:admin", method: "POST", path: "/facts/embedder/stop", params: { reason: body() }, admin: true, summary: "Stop the durable embedder loop. [enhanced, admin]" },
    { name: "forcePurgeFacts", access: "fleet:admin", method: "POST", path: "/facts/purge", params: { input: body() }, admin: true, summary: "Force-purge soft-deleted facts (ForcePurgeFactsInput). [admin]" },

    // ── Graph data-plane (Tier 1: any admitted caller) ──────────────────
    { name: "searchGraphNodes", access: "authed", method: "POST", path: "/graph/nodes/search", params: { query: body() }, summary: "Search graph nodes (GraphNodeQuery)." },
    { name: "searchGraphEdges", access: "authed", method: "POST", path: "/graph/edges/search", params: { query: body() }, summary: "Search graph edges (GraphEdgeQuery)." },
    { name: "graphNeighbourhood", access: "authed", method: "POST", path: "/graph/neighbourhood", params: { nodeKey: body(), depth: body(), namespace: body() }, summary: "Expand a subgraph around a node." },
    { name: "upsertGraphNode", access: "authed", method: "POST", path: "/graph/nodes", params: { input: body() }, summary: "Upsert a graph node (GraphNodeInput)." },
    { name: "upsertGraphEdge", access: "authed", method: "POST", path: "/graph/edges", params: { input: body() }, summary: "Upsert a graph edge (GraphEdgeInput)." },
    { name: "deleteGraphNode", access: "authed", method: "POST", path: "/graph/nodes/delete", params: { nodeKey: body(), namespace: body() }, summary: "Delete a graph node." },
    { name: "deleteGraphEdge", access: "authed", method: "POST", path: "/graph/edges/delete", params: { fromKey: body(), toKey: body(), predicateKey: body(), namespace: body() }, summary: "Delete a graph edge." },
    { name: "graphStats", access: "authed", method: "GET", path: "/graph/stats", params: { namespace: query("string") }, summary: "Graph node/edge counts." },
    { name: "listGraphNamespaces", access: "authed", method: "GET", path: "/graph/namespaces", params: { prefix: query("string"), includeArchived: query("boolean"), includeDetails: query("boolean") }, summary: "List graph namespaces (corpora)." },
    { name: "getGraphNamespace", access: "authed", method: "GET", path: "/graph/namespaces/:namespace", params: { namespace: path("namespace") }, summary: "One graph namespace descriptor." },

    // ── Graph operational (Tier 2: admin) ───────────────────────────────
    { name: "upsertGraphNamespace", access: "fleet:admin", method: "POST", path: "/graph/namespaces", params: { input: body() }, admin: true, summary: "Register/update a graph namespace. [admin]" },
    { name: "deleteGraphNamespace", access: "fleet:admin", method: "DELETE", path: "/graph/namespaces/:namespace", params: { namespace: path("namespace") }, admin: true, summary: "Delete a graph namespace and its data. [admin]" },

    // ── Models / agents / policy ────────────────────────────────────────
    { name: "listModels", access: "authed", method: "GET", path: "/models", summary: "Viewer-usable runtime provider instances (`catalogKind=runtime_provider`). Direct PilotSwarmManagementClient.listModels() is the provider-type template catalog (`catalogKind=provider_type`); use listRuntimeModels(viewer) for direct parity." },
    { name: "getModelsByProvider", access: "authed", method: "GET", path: "/models/by-provider", summary: "Model templates grouped by provider type (catalogKind=provider_type); use listModels for viewer-usable runtime provider instances." },
    { name: "getDefaultModel", access: "authed", method: "GET", path: "/models/default", summary: "The deployment default model." },
    { name: "listCreatableAgents", access: "authed", method: "GET", path: "/agents", summary: "Agents sessions can be created for." },
    { name: "getSessionCreationPolicy", access: "authed", method: "GET", path: "/session-creation-policy", summary: "Session creation policy." },

    // ── Agent packages (docs/proposals/agent-packages.md) ───────────────
    // Fixed segments (sources / upload / worker-state) are registered BEFORE
    // the :name routes — Express matches in table order.
    { name: "listAgentPackages", access: "authed", method: "GET", path: "/agent-packages", summary: "Agent packages visible to the caller: shared + own user-scope (admins see all)." },
    { name: "uploadAgentPackage", access: "authed", method: "POST", path: "/agent-packages/upload", params: { files: body(), scope: body() }, summary: "Publish a package from inline files ([{path, contentBase64}], ≤ 2 MB total); validates, canonically packs, and registers as the caller." },
    { name: "listAgentWorkerState", access: "fleet:admin", method: "GET", path: "/agent-packages/worker-state", admin: true, summary: "Per-worker installed package state (fleet adoption). Hard admin gate: the installed map enumerates every package name, including user-scope ones. [admin]" },
    { name: "listWorkers", access: "fleet:admin", method: "GET", path: "/workers", admin: true, summary: "Worker registry (0040): every registered worker with pool, lifecycle phase, liveness, write-once info, health snapshot, and per-domain state. Hard admin gate. [admin]" },
    // A NAME is not a package: scope shadowing means one name can be a shared
    // package AND one-or-more user-scope copies at once. Every :name op below
    // takes an optional `scope` selector ("shared" | "user") so the caller
    // can say WHICH copy it means; without it, resolution walks "own copy,
    // then shared" — which silently targeted the wrong row whenever a caller
    // owned a same-named copy. `ownerProvider`/`ownerSubject` additionally
    // let an ADMIN select another user's copy; for non-admins the user scope
    // always means "mine".
    { name: "getAgentPackage", access: "authed", method: "GET", path: "/agent-packages/:name", params: { name: path("name"), scope: query("string"), ownerProvider: query("string"), ownerSubject: query("string") }, summary: "One package with its full version history. `scope` picks which same-named copy." },
    { name: "getAgentPackageTree", access: "authed", method: "GET", path: "/agent-packages/:name/tree", params: { name: path("name"), semver: query("string"), scope: query("string"), ownerProvider: query("string"), ownerSubject: query("string") }, summary: "File tree of the package tarball (workspace viewer). Defaults to the active version." },
    { name: "getAgentPackageFile", access: "authed", method: "GET", path: "/agent-packages/:name/file", params: { name: path("name"), semver: query("string"), filePath: query("string"), scope: query("string"), ownerProvider: query("string"), ownerSubject: query("string") }, summary: "One file from the package tarball (preview; text size-capped, binary flagged)." },
    { name: "setAgentPackageScope", access: "authed", method: "PUT", path: "/agent-packages/:name/scope", params: { name: path("name"), scope: body(), ownerProvider: body(), ownerSubject: body() }, summary: "Promote (shared) or demote (user). The source copy is implied by the direction: promote moves the caller's (or named owner's) user copy, demote moves the shared one. Creator or admin; running agents unaffected." },
    { name: "setAgentPackageEnabled", access: "authed", method: "PUT", path: "/agent-packages/:name/enabled", params: { name: path("name"), enabled: body(), scope: body(), ownerProvider: body(), ownerSubject: body() }, summary: "Enable/disable a package fleet-wide. Creator or admin. `scope` picks which same-named copy." },
    { name: "pinAgentPackageVersion", access: "authed", method: "PUT", path: "/agent-packages/:name/active", params: { name: path("name"), semver: body(), scope: body(), ownerProvider: body(), ownerSubject: body() }, summary: "Pin the active version (rollback). Creator or admin; fleet converges on the next epoch poll. `scope` picks which same-named copy." },
    { name: "deleteAgentPackage", access: "authed", method: "DELETE", path: "/agent-packages/:name", params: { name: path("name"), scope: query("string"), ownerProvider: query("string"), ownerSubject: query("string") }, summary: "Delete a package: every version and its artifacts. Creator or admin. Live sessions using its agents fail resolution on their next turn. `scope` picks which same-named copy." },
    // Editors: write grants on a SHARED package. No copy selector — editors
    // exist only on the shared copy, so :name is unambiguous. Grant/revoke are
    // owner-or-admin (enforced in SQL, like every other package mutation).
    { name: "grantAgentPackageEditor", access: "authed", method: "POST", path: "/agent-packages/:name/editors", params: { name: path("name"), user: body() }, summary: "Grant a user write access to a SHARED package ({ user: { provider, subject } }): publish, republish into it, pin, enable/disable — not scope, delete, or the editor list. Owner or admin. Revoked when the package is demoted to user scope." },
    { name: "revokeAgentPackageEditor", access: "authed", method: "POST", path: "/agent-packages/:name/editors/revoke", params: { name: path("name"), user: body() }, summary: "Revoke a user's editor grant on a shared package ({ user: { provider, subject } }). Owner or admin; idempotent." },
    { name: "listAgentPackageEditors", access: "authed", method: "GET", path: "/agent-packages/:name/editors", params: { name: path("name") }, summary: "Editors of the shared copy of a package. Visible to anyone who can see the package." },
    { name: "republishAgentPackageVersion", access: "authed", method: "POST", path: "/agent-packages/:name/republish", params: { name: path("name"), semver: body(), targetScope: body(), ownerProvider: body(), ownerSubject: body() }, summary: "Publish an existing version's exact bytes into the same-named package in another scope (user↔shared). THE update path for an already-published shared package — promote can only move a row to an unused name. Creator or admin." },

    // ── Current user profile ────────────────────────────────────────────
    { name: "getCurrentUserProfile", access: "authed", method: "GET", path: "/me/profile", summary: "Profile of the authenticated principal." },
    { name: "setCurrentUserProfileSettings", access: "authed", method: "PATCH", path: "/me/profile/settings", params: { settings: body() }, summary: "Replace profile settings." },
    { name: "setCurrentUserGitHubCopilotKey", access: "authed", method: "PUT", path: "/me/github-copilot-key", params: { key: body() }, summary: "Set (or clear with null) the per-user GitHub Copilot key." },
    { name: "setSystemGitHubCopilotKey", access: "fleet:admin", method: "PUT", path: "/admin/system-github-copilot-key", params: { key: body() }, admin: true, summary: "Set (or clear with null) the System user's GitHub Copilot key, used by ownerless system sessions. [admin]" },
    { name: "getSystemGitHubCopilotKeyStatus", access: "fleet:admin", method: "GET", path: "/admin/system-github-copilot-key", admin: true, summary: "Whether a System GitHub Copilot key is configured and who last changed it. [admin]" },

    // ── Provider budgets (docs/proposals/providers-and-budgets.md) ──────
    // A session runs provider:model and that provider is charged. Every
    // operation carries the caller down to the cms_provider_* procedures,
    // which decide what the caller may do; the admin rows are marked
    // fleet:admin so the door matches the answer the database would give.
    { name: "listProviders", access: "authed", method: "GET", path: "/providers", summary: "Providers the caller can use: every shared one plus their own. Admins also see other people's, marked usableByMe:false." },
    { name: "getProviderStatus", access: "authed", method: "GET", path: "/providers/status", params: { names: query("string") }, summary: "Limits, usage against them, reset times, and the caller's own ceiling where an allowance applies. `names` is a comma-separated list; omit it for all of them." },
    // One read, one table. A meter runs whether or not anybody capped the
    // period, so an uncapped day still reports what was spent on it — which
    // is the fact `getProviderStatus` cannot carry, because it lists limits.
    { name: "getProviderUsageGrid", access: "authed", method: "GET", path: "/providers/usage-grid", summary: "Every provider in the caller's namespace, each followed by its model-scoped limits, with used and quota figures for day, week and month — the caller's own and everyone's. A period with no limit reports its usage against an unlimited quota." },
    { name: "createProvider", access: "fleet:admin", method: "POST", path: "/management/providers", params: { name: body(), type: body(), credentials: body(), baseUrl: body() }, summary: "Create a shared provider — one anyone may spend from. [admin]" },
    { name: "updateSharedProviderCredential", access: "fleet:admin", method: "PUT", path: "/management/providers/:name/credential", params: { name: path("name"), credentials: body() }, summary: "Replace the credential on a shared provider without changing its name, defaults, routing, or usage history. [admin]" },
    { name: "deleteProvider", access: "fleet:admin", method: "DELETE", path: "/management/providers/:name", params: { name: path("name") }, summary: "Remove a shared provider. Returns how many sessions are now waiting on the name. [admin]" },
    { name: "createMyProvider", access: "authed", method: "POST", path: "/me/providers", params: { name: body(), type: body(), credentials: body(), baseUrl: body() }, summary: "Create a provider of your own, on your own credentials. Nobody else sees it." },
    { name: "updateMyProviderCredential", access: "authed", method: "PUT", path: "/me/providers/:name/credential", params: { name: path("name"), credentials: body() }, summary: "Replace the credential on one of your own personal providers without changing its name, defaults, or usage history." },
    { name: "deleteMyProvider", access: "authed", method: "DELETE", path: "/me/providers/:name", params: { name: path("name") }, summary: "Remove one of your own providers. Returns how many sessions are now waiting on the name." },
    { name: "clearProviderRoutingDependencies", access: "authed", method: "POST", path: "/providers/:name/clear-routing", params: { name: path("name") }, summary: "Explicitly clear defaults and system-agent overrides that reference a provider. Shared providers require admin." },
    { name: "setProviderLimit", access: "authed", method: "PUT", path: "/providers/:name/limit", params: { name: path("name"), period: body(), model: body(), tokens: body() }, summary: "Save one limit (day | week | month, all models or one). The same combination replaces what was there. Admin on a shared provider, owner on a personal one." },
    { name: "removeProviderLimit", access: "authed", method: "DELETE", path: "/providers/:name/limit", params: { name: path("name"), period: query("string"), model: query("string") }, summary: "Drop one limit. Returns whether there was one." },
    { name: "setProviderAllowance", access: "fleet:admin", method: "PUT", path: "/management/providers/:name/allowance", params: { name: path("name"), pct: body() }, summary: "The share of each limit one person may use, 1..100. 100 means no per-person ceiling. Shared providers only. [admin]" },
    { name: "setProviderHold", access: "fleet:admin", method: "PUT", path: "/management/providers/:name/hold", params: { name: path("name"), untilUtc: body(), release: body() }, summary: "Pause new turns against a provider. Neither untilUtc nor release = a hold with no end. [admin]" },
    { name: "getDefaults", access: "authed", method: "GET", path: "/defaults", summary: "Compatibility view of configured cluster, user and system model tuples." },
    { name: "getModelDefaults", access: "authed", method: "GET", path: "/model-defaults", summary: "Configured and effective user, cluster and system defaults plus per-system-agent overrides." },
    { name: "setModelDefault", access: "authed", method: "PUT", path: "/model-defaults", params: { scope: body(), provider: body(), model: body(), reasoningEffort: body(), contextTier: body() }, summary: "Set or clear the user or cluster ordinary-session default. Cluster scope requires admin." },
    { name: "setProviderSystemUse", access: "fleet:admin", method: "PUT", path: "/management/providers/:name/system-use", params: { name: path("name"), enabled: body() }, summary: "Allow or refuse system-session use of the calling admin's personal provider. [admin]" },
    { name: "getLegacyProviderMigrationStatus", access: "fleet:admin", method: "GET", path: "/management/providers/legacy-key-migration", summary: "Aggregate legacy GHCP migration status; never returns credentials. [admin]" },
    { name: "adoptLegacySystemGitHubCopilotKey", access: "fleet:admin", method: "POST", path: "/management/providers/adopt-system-github-key", params: { name: body() }, summary: "Adopt the legacy synthetic System GHCP key into the calling admin's private, system-enabled provider. [admin]" },
    { name: "setSystemModelDefault", access: "fleet:admin", method: "PUT", path: "/management/system-model-default", params: { provider: body(), model: body(), reasoningEffort: body(), contextTier: body(), restartExisting: body() }, summary: "Set or clear the system-session default and optionally restart inheriting sessions. [admin]" },
    { name: "setSystemSessionModel", access: "fleet:admin", method: "PUT", path: "/management/system-sessions/:agentId/model", params: { agentId: path("agentId"), provider: body(), model: body(), reasoningEffort: body(), contextTier: body() }, summary: "Set one persistent system-agent model override. [admin]" },
    { name: "clearSystemSessionModel", access: "fleet:admin", method: "DELETE", path: "/management/system-sessions/:agentId/model", params: { agentId: path("agentId") }, summary: "Clear one persistent system-agent model override. [admin]" },
    { name: "setClusterDefault", access: "fleet:admin", method: "PUT", path: "/management/defaults", params: { provider: body(), model: body(), reasoning: body(), context: body() }, summary: "Deprecated alias for setModelDefault(scope=cluster). [admin]" },
    { name: "setMyDefault", access: "authed", method: "PUT", path: "/me/default", params: { provider: body(), model: body(), reasoning: body(), context: body() }, summary: "The caller's prefill for new sessions. A null provider clears it." },
    { name: "getProviderUsage", access: "authed", method: "GET", path: "/providers/usage", params: { days: query("number"), mine: query("boolean"), ownerUserId: query("number"), provider: query("string"), model: query("string"), sessionId: query("string"), chargeClass: query("string"), dimension: query("string"), limit: query("number") }, summary: "Where the tokens went: { totals, daily[], breakdown[] } over one filter set. dimension: session | user | provider | model | agent. Non-admins see only their own rows. `mine` narrows to the caller's own spend, resolved server-side — it carries no id, so it cannot name anybody else." },
    { name: "listPausedSessions", access: "authed", method: "GET", path: "/providers/paused", summary: "Sessions waiting on a limit, allowance, hold, or a provider name that no longer resolves. Admins fleet-wide, everyone else their own." },

    // ── System ──────────────────────────────────────────────────────────
    { name: "getLogConfig", access: "authed", method: "GET", path: "/system/log-config", summary: "Log tail availability." },
    { name: "getWorkerCount", access: "authed", method: "GET", path: "/system/workers", summary: "Live worker count." },
];

const OPERATIONS_BY_NAME = new Map(OPERATIONS.map((op) => [op.name, op]));

export function getOperation(name) {
    return OPERATIONS_BY_NAME.get(name) || null;
}

/**
 * Build the HTTP request for an operation from an rpc-shaped params object
 * (the exact shapes the legacy /api/rpc dispatcher accepts).
 *
 * @returns {{ method: string, path: string, query: URLSearchParams, body: object|null }}
 */
export function buildOperationRequest(name, params = {}) {
    const op = getOperation(name);
    if (!op) throw new Error(`Unknown API operation: ${name}`);
    const safeParams = params && typeof params === "object" ? params : {};

    let resolvedPath = op.path;
    const queryParams = new URLSearchParams();
    let bodyPayload = null;

    for (const [key, spec] of Object.entries(op.params || {})) {
        const value = safeParams[key];
        if (spec.in === "path") {
            const raw = value == null ? "" : String(value);
            if (!raw) throw new Error(`API operation ${name} requires param '${key}'`);
            resolvedPath = resolvedPath.replace(`:${spec.name || key}`, encodeURIComponent(raw));
        } else if (spec.in === "query") {
            if (value === undefined || value === null) continue;
            queryParams.set(key, spec.type === "json" ? JSON.stringify(value) : String(value));
        } else {
            if (value === undefined) continue;
            if (!bodyPayload) bodyPayload = {};
            bodyPayload[key] = value;
        }
    }

    if (resolvedPath.includes("/:")) {
        throw new Error(`API operation ${name} is missing required path params (${op.path})`);
    }
    return { method: op.method, path: `${API_PREFIX}${resolvedPath}`, query: queryParams, body: bodyPayload };
}

/** Coerce a query-string value per the declared param type (server side). */
export function coerceQueryValue(value, type) {
    if (value === undefined || value === null) return undefined;
    if (type === "number") {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : undefined;
    }
    if (type === "boolean") return value === "true" || value === true;
    if (type === "json") {
        try {
            return JSON.parse(String(value));
        } catch {
            throw Object.assign(new Error("Malformed JSON query parameter"), { code: "INVALID_REQUEST" });
        }
    }
    return String(value);
}

/** Path for the raw (streaming) artifact download route. */
export function artifactDownloadPath(sessionId, filename) {
    return `${API_PREFIX}/sessions/${encodeURIComponent(String(sessionId || ""))}/artifacts/${encodeURIComponent(String(filename || ""))}/download`;
}

export class ApiError extends Error {
    constructor(message, { code = "INTERNAL_ERROR", status = 500, candidates = undefined } = {}) {
        super(message);
        this.name = "ApiError";
        this.code = code;
        this.status = status;
        if (Array.isArray(candidates)) this.candidates = candidates;
    }
}
