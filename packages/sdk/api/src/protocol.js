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
    { name: "listModels", access: "authed", method: "GET", path: "/models", summary: "All available models." },
    { name: "getModelsByProvider", access: "authed", method: "GET", path: "/models/by-provider", summary: "Models grouped by provider." },
    { name: "getDefaultModel", access: "authed", method: "GET", path: "/models/default", summary: "The deployment default model." },
    { name: "listCreatableAgents", access: "authed", method: "GET", path: "/agents", summary: "Agents sessions can be created for." },
    { name: "getSessionCreationPolicy", access: "authed", method: "GET", path: "/session-creation-policy", summary: "Session creation policy." },

    // ── Current user profile ────────────────────────────────────────────
    { name: "getCurrentUserProfile", access: "authed", method: "GET", path: "/me/profile", summary: "Profile of the authenticated principal." },
    { name: "setCurrentUserProfileSettings", access: "authed", method: "PATCH", path: "/me/profile/settings", params: { settings: body() }, summary: "Replace profile settings." },
    { name: "setCurrentUserGitHubCopilotKey", access: "authed", method: "PUT", path: "/me/github-copilot-key", params: { key: body() }, summary: "Set (or clear with null) the per-user GitHub Copilot key." },
    { name: "setSystemGitHubCopilotKey", access: "fleet:admin", method: "PUT", path: "/admin/system-github-copilot-key", params: { key: body() }, admin: true, summary: "Set (or clear with null) the System user's GitHub Copilot key, used by ownerless system sessions. [admin]" },
    { name: "getSystemGitHubCopilotKeyStatus", access: "fleet:admin", method: "GET", path: "/admin/system-github-copilot-key", admin: true, summary: "Whether a System GitHub Copilot key is configured and who last changed it. [admin]" },

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
    constructor(message, { code = "INTERNAL_ERROR", status = 500 } = {}) {
        super(message);
        this.name = "ApiError";
        this.code = code;
        this.status = status;
    }
}
