import type { ApiClient } from "pilotswarm-sdk/api";
import {
    PilotSwarmWebOptions,
    createApiClientFromOptions,
    webModeUnsupported,
} from "./api-connection.js";
import { createManagementOps, type ManagementOps } from "./generated-op-methods.js";

const WAIT_SLICE_MS = 25_000;

function toIso(value: unknown): unknown {
    return value instanceof Date ? value.toISOString() : value;
}

/**
 * PilotSwarmManagementClient in web mode: the management surface over the
 * Web API. Constructed via `new PilotSwarmManagementClient({ apiUrl, … })`.
 *
 * Two layers, both honest about what they are:
 *
 *   - `client.ops` — the canonical surface: one method per protocol-table
 *     operation, wire-shaped params, generated. Complete by construction;
 *     the coverage contract test keeps it that way.
 *   - the methods on the class — hand-written ergonomic sugar over the same
 *     wire (positional args, Date coercion, polling loops). Allowed to be
 *     partial; `ops` is not.
 *
 * Methods without an API equivalent (low-level command plumbing, session
 * dumps) throw `WEB_MODE_UNSUPPORTED` errors — they remain direct-mode-only
 * until a remote consumer needs them.
 *
 * User-profile methods operate on the **authenticated** principal; the
 * explicit `principal` argument accepted by the direct client is ignored
 * because the server derives identity from the request's auth context.
 */
export class WebPilotSwarmManagementClient {
    /** @internal */
    readonly _api: ApiClient;
    /** The canonical Web API surface: one wire-shaped method per operation. */
    readonly ops: ManagementOps;
    private started = false;

    constructor(options: PilotSwarmWebOptions) {
        this._api = createApiClientFromOptions(options);
        this.ops = createManagementOps((name, params) => this._api.call(name, params));
    }

    async start(): Promise<void> {
        if (this.started) return;
        await this._api.start();
        await this._api.health();
        this.started = true;
    }

    async stop(): Promise<void> {
        this.started = false;
        await this._api.stop();
    }

    // ── Session listing ─────────────────────────────────────────────────

    async listSessions(): Promise<any[]> {
        return this._api.call("listSessions");
    }

    async listSessionsPage(opts: { limit?: number; cursor?: { updatedAt: number; sessionId: string } | null; includeDeleted?: boolean } = {}): Promise<any> {
        return this._api.call("listSessionsPage", {
            limit: opts.limit,
            cursor: opts.cursor ?? undefined,
            includeDeleted: opts.includeDeleted,
        });
    }

    async getSession(sessionId: string): Promise<any> {
        return this._api.call("getSession", { sessionId });
    }

    // ── Session actions ─────────────────────────────────────────────────

    async renameSession(sessionId: string, title: string): Promise<void> {
        await this._api.call("renameSession", { sessionId, title });
    }

    async cancelSession(sessionId: string): Promise<void> {
        await this._api.call("cancelSession", { sessionId });
    }

    async completeSession(sessionId: string, reason?: string): Promise<void> {
        await this._api.call("completeSession", { sessionId, reason });
    }

    async deleteSession(sessionId: string): Promise<void> {
        await this._api.call("deleteSession", { sessionId });
    }

    async stopSessionTurn(sessionId: string, opts: { reason?: string; timeoutMs?: number } = {}): Promise<any> {
        return this._api.call("stopSessionTurn", { sessionId, options: opts });
    }

    async setSessionModel(sessionId: string, model: string, opts: { reasoningEffort?: string | null; contextTier?: string | null; source?: string } = {}): Promise<void> {
        await this._api.call("setSessionModel", { sessionId, options: { model, ...opts } });
    }

    async restartSystemSession(agentIdOrSessionId: string, options: object): Promise<any> {
        return this._api.call("restartSystemSession", { agentIdOrSessionId, options });
    }

    // ── Session groups ──────────────────────────────────────────────────

    async createSessionGroup(input: Record<string, unknown>): Promise<any> {
        return this._api.call("createSessionGroup", { input });
    }

    async listSessionGroups(): Promise<any[]> {
        return this._api.call("listSessionGroups");
    }

    async updateSessionGroup(groupId: string, patch: Record<string, unknown>): Promise<any> {
        return this._api.call("updateSessionGroup", { groupId, patch });
    }

    /**
     * Deprecated alias of placeSessionsInGroup; returns the per-root result
     * array. NOTE the direct client's twin returns `void` — the return type
     * here is `Promise<any>` rather than `Promise<any[]>` so the surface proof
     * accepts both, which means the proof is not asserting anything about
     * these two. Long-standing behaviour, both deprecated; use
     * placeSessionsInGroup, which returns the array in both modes.
     */
    async assignSessionsToGroup(groupId: string, sessionIds: string[]): Promise<any> {
        return this._api.call("assignSessionsToGroup", { groupId, sessionIds });
    }

    /** Deprecated alias of placeSessionsInGroup; see assignSessionsToGroup on the void-vs-array divergence. */
    async moveSessionsToGroup(groupId: string | null, sessionIds: string[]): Promise<any> {
        return this._api.call("moveSessionsToGroup", { groupId, sessionIds });
    }

    /**
     * Viewer-private placement over the Web API: the server derives the
     * placing viewer from the request's auth context. groupId null = ungroup.
     * Returns one { rootSessionId, placed, reason } entry per session root.
     *
     * Accepts BOTH calling conventions — the web/transport shape
     * `(sessionIds, groupId)` and the direct client's viewer-first shape
     * `(viewer, sessionIds, groupId)`. Before this adapter, a caller holding
     * the direct type on a web instance sent the viewer object as the
     * sessionIds array: a silently corrupt wire call. The viewer is dropped
     * either way — the server derives it from auth.
     */
    placeSessionsInGroup(sessionIds: string[], groupId: string | null): Promise<any[]>;
    placeSessionsInGroup(viewer: { provider: string; subject: string }, sessionIds: string[], groupId: string | null): Promise<any[]>;
    async placeSessionsInGroup(
        first: string[] | { provider: string; subject: string },
        second?: string[] | string | null,
        third?: string | null,
    ): Promise<any[]> {
        const directForm = !Array.isArray(first);
        const sessionIds = directForm ? (second as string[]) : first;
        const groupId = (directForm ? third : (second as string | null)) ?? null;
        return this._api.call("placeSessionsInGroup", { groupId, sessionIds });
    }

    async deleteSessionGroup(groupId: string): Promise<void> {
        await this._api.call("deleteSessionGroup", { groupId });
    }

    async cancelSessionGroup(groupId: string, reason?: string): Promise<void> {
        await this._api.call("cancelSessionGroup", { groupId, reason });
    }

    async completeSessionGroup(groupId: string, options: Record<string, unknown> = {}): Promise<void> {
        await this._api.call("completeSessionGroup", { groupId, options });
    }

    listGroupSessions(): never {
        throw webModeUnsupported("listGroupSessions", "filter listSessions/listSessionsPage by viewerGroupId instead");
    }

    // ── Child contracts ─────────────────────────────────────────────────

    async getChildOutcome(childSessionId: string): Promise<any> {
        return this._api.call("getChildOutcome", { childSessionId });
    }

    async listChildOutcomes(parentSessionId: string): Promise<any[]> {
        return this._api.call("listChildOutcomes", { parentSessionId });
    }

    // ── Events & history ────────────────────────────────────────────────

    async getSessionEvents(sessionId: string, afterSeq?: number, limit?: number, eventTypes?: string[]): Promise<any[]> {
        return this._api.call("getSessionEvents", { sessionId, afterSeq, limit, eventTypes });
    }

    async getSessionEventsBefore(sessionId: string, beforeSeq: number, limit?: number, eventTypes?: string[]): Promise<any[]> {
        return this._api.call("getSessionEventsBefore", { sessionId, beforeSeq, limit, eventTypes });
    }

    async getCanvasLive(sessionId: string): Promise<Array<{ slot: number; seq: number; docRev: number; docSha: string; payload: Record<string, unknown>; updatedBy: string; updatedAt: string }>> {
        return this._api.call("getCanvasLive", { sessionId });
    }

    async getCanvasShareLink(sessionId: string, slot: number): Promise<{ exists: boolean; createdAt?: string; createdBy?: string }> {
        return this._api.call("getCanvasShareLink", { sessionId, slot });
    }

    async resetCanvasShareLink(sessionId: string, slot: number, _createdBy?: string): Promise<{ token: string }> {
        // createdBy is resolved SERVER-side from the authenticated principal;
        // the parameter exists only for surface parity with the PG client.
        return this._api.call("resetCanvasShareLink", { sessionId, slot: { slot } });
    }

    async removeCanvasShareLink(sessionId: string, slot: number): Promise<{ removed: boolean }> {
        return this._api.call("removeCanvasShareLink", { sessionId, slot: { slot } });
    }

    /** Server-internal token door — deliberately NEVER a wire operation. */
    resolveCanvasShareTokenHash(): never {
        throw webModeUnsupported("resolveCanvasShareTokenHash", "the share-token resolve is a server-internal door; tokens are validated only where the doors live");
    }

    async getTopEventEmitters(opts: { since: Date; limit?: number }): Promise<any[]> {
        return this._api.call("getTopEventEmitters", { since: toIso(opts.since), limit: opts.limit });
    }

    async getExecutionHistory(sessionId: string, executionId?: number): Promise<any> {
        return this._api.call("getExecutionHistory", { sessionId, executionId });
    }

    // ── Status & responses ──────────────────────────────────────────────

    async getSessionStatus(sessionId: string): Promise<any> {
        return this._api.call("getSessionStatus", { sessionId });
    }

    async waitForStatusChange(
        sessionId: string,
        afterVersion: number,
        _pollIntervalMs?: number,
        timeoutMs?: number,
        opts?: { signal?: AbortSignal },
    ): Promise<any> {
        const deadline = Date.now() + (timeoutMs ?? 30_000);
        let latest: any = null;
        while (Date.now() < deadline) {
            if (opts?.signal?.aborted) throw new Error(`Status wait aborted (${sessionId})`);
            const sliceMs = Math.max(1_000, Math.min(deadline - Date.now(), WAIT_SLICE_MS));
            latest = await this._api.call("waitForStatusChange", { sessionId, afterVersion, timeoutMs: sliceMs });
            if ((Number(latest?.customStatusVersion) || 0) > afterVersion) return latest;
        }
        return latest ?? this.getSessionStatus(sessionId);
    }

    async getLatestResponse(sessionId: string): Promise<any> {
        return this._api.call("getLatestResponse", { sessionId });
    }

    // ── Messaging ───────────────────────────────────────────────────────

    async sendMessage(sessionId: string, prompt: string, options: { clientMessageIds?: string[]; attachments?: Array<{ filename: string }> } = {}): Promise<void> {
        await this._api.call("sendMessage", { sessionId, prompt, options });
    }

    async sendAnswer(sessionId: string, answer: string): Promise<void> {
        await this._api.call("sendAnswer", { sessionId, answer });
    }

    async cancelPendingMessage(sessionId: string, clientMessageIds: string[]): Promise<void> {
        await this._api.call("cancelPendingMessage", { sessionId, clientMessageIds });
    }

    // ── Metrics & stats ─────────────────────────────────────────────────

    async getOrchestrationStats(sessionId: string): Promise<any> {
        return this._api.call("getOrchestrationStats", { sessionId });
    }

    async getSessionMetricSummary(sessionId: string): Promise<any> {
        return this._api.call("getSessionMetricSummary", { sessionId });
    }

    async getSessionFootprint(sessionId: string, _opts?: { bypassCache?: boolean }): Promise<any> {
        // bypassCache is a direct-mode/test affordance; the web path always
        // reads through the server-side TTL cache.
        return this._api.call("getSessionFootprint", { sessionId });
    }

    async regenerateSession(sessionId: string, options: { handoff?: string; instructions?: string; distillMode?: "llm" | "deterministic"; distillerModel?: string; model?: string; force?: boolean } = {}): Promise<any> {
        return this._api.call("regenerateSession", { sessionId, options });
    }

    async getSessionTokensByModel(sessionId: string): Promise<any[]> {
        return this._api.call("getSessionTokensByModel", { sessionId });
    }

    async getSessionTreeStats(sessionId: string): Promise<any> {
        return this._api.call("getSessionTreeStats", { sessionId });
    }

    async getFleetStats(opts: { includeDeleted?: boolean; since?: Date } = {}): Promise<any> {
        return this._api.call("getFleetStats", { includeDeleted: opts.includeDeleted, since: toIso(opts.since) });
    }

    async getUserStats(opts: { includeDeleted?: boolean; since?: Date } = {}): Promise<any> {
        return this._api.call("getUserStats", { includeDeleted: opts.includeDeleted, since: toIso(opts.since) });
    }

    // ── Skills usage ────────────────────────────────────────────────────

    async getSessionSkillUsage(sessionId: string, opts: { since?: Date } = {}): Promise<any[]> {
        return this._api.call("getSessionSkillUsage", { sessionId, since: toIso(opts.since) });
    }

    async getSessionTreeSkillUsage(sessionId: string, opts: { since?: Date } = {}): Promise<any> {
        return this._api.call("getSessionTreeSkillUsage", { sessionId, since: toIso(opts.since) });
    }

    async getFleetSkillUsage(opts: { since?: Date; includeDeleted?: boolean } = {}): Promise<any> {
        return this._api.call("getFleetSkillUsage", { since: toIso(opts.since), includeDeleted: opts.includeDeleted });
    }

    async getFleetRetrievalUsage(opts: { since?: Date; includeDeleted?: boolean } = {}): Promise<any> {
        return this._api.call("getFleetRetrievalUsage", { since: toIso(opts.since), includeDeleted: opts.includeDeleted });
    }

    // ── Facts ───────────────────────────────────────────────────────────

    async getSessionFactsStats(sessionId: string): Promise<any> {
        return this._api.call("getSessionFactsStats", { sessionId });
    }

    async getSessionTreeFactsStats(sessionId: string): Promise<any> {
        return this._api.call("getSessionTreeFactsStats", { sessionId });
    }

    async getSharedFactsStats(): Promise<any> {
        return this._api.call("getSharedFactsStats");
    }

    async getFactsTombstoneStats(opts: { ttlSeconds?: number } = {}): Promise<any> {
        return this._api.call("getFactsTombstoneStats", { ttlSeconds: opts.ttlSeconds });
    }

    async pruneDeletedSummaries(olderThan: Date): Promise<any> {
        return this._api.call("pruneDeletedSummaries", { olderThan: toIso(olderThan) });
    }

    // ── User profile (authenticated principal) ──────────────────────────

    async getUserProfile(_principal?: unknown): Promise<any> {
        return this._api.call("getCurrentUserProfile");
    }

    async setUserProfileSettings(_principal: unknown, settings: Record<string, unknown>): Promise<any> {
        return this._api.call("setCurrentUserProfileSettings", { settings });
    }

    async setUserGitHubCopilotKey(_principal: unknown, key: string | null): Promise<any> {
        return this._api.call("setCurrentUserGitHubCopilotKey", { key });
    }

    async setSystemGitHubCopilotKey(_actor: unknown, key: string | null): Promise<any> {
        return this._api.call("setSystemGitHubCopilotKey", { key });
    }

    async getSystemGitHubCopilotKeyStatus(): Promise<any> {
        return this._api.call("getSystemGitHubCopilotKeyStatus");
    }

    // ── Models (async in web mode — always `await`) ─────────────────────

    async listModels(): Promise<any[]> {
        return this._api.call("listModels");
    }

    async getModelsByProvider(): Promise<any[]> {
        return this._api.call("getModelsByProvider");
    }

    async getDefaultModel(): Promise<string | undefined> {
        return this._api.call("getDefaultModel");
    }

    // ── Direct-mode-only surfaces ───────────────────────────────────────

    sendCommand(): never {
        throw webModeUnsupported("sendCommand", "low-level command plumbing is direct-mode only");
    }

    getCommandResponse(): never {
        throw webModeUnsupported("getCommandResponse", "low-level command plumbing is direct-mode only");
    }

    dumpSession(): never {
        throw webModeUnsupported("dumpSession");
    }

    // Retrieval / graph observability — tuner-grade diagnostics, added to the
    // operations table for remote consumers (the MCP server's debug surface).
    async getSessionGraphSearches(sessionId: string, limit?: number): Promise<any[]> {
        return this._api.call("getSessionGraphSearches", { sessionId, limit });
    }

    async getSessionRetrievalUsage(sessionId: string, opts: { since?: Date } = {}): Promise<any[]> {
        return this._api.call("getSessionRetrievalUsage", { sessionId, since: toIso(opts.since) });
    }

    async getSessionTreeRetrievalUsage(sessionId: string, opts: { since?: Date } = {}): Promise<any> {
        return this._api.call("getSessionTreeRetrievalUsage", { sessionId, since: toIso(opts.since) });
    }

    async getSessionGraphNodeUsage(sessionId: string, opts: { since?: Date; limit?: number; nodeKeyLike?: string; kind?: string } = {}): Promise<any[]> {
        return this._api.call("getSessionGraphNodeUsage", {
            sessionId,
            since: toIso(opts.since),
            limit: opts.limit,
            nodeKeyLike: opts.nodeKeyLike,
            kind: opts.kind,
        });
    }

    async getFleetGraphNodeUsage(opts: { since?: Date; includeDeleted?: boolean; limit?: number; nodeKeyLike?: string; kind?: string } = {}): Promise<any> {
        return this._api.call("getFleetGraphNodeUsage", {
            since: toIso(opts.since),
            includeDeleted: opts.includeDeleted,
            limit: opts.limit,
            nodeKeyLike: opts.nodeKeyLike,
            kind: opts.kind,
        });
    }

    async getSessionGraphEdgeSearchUsage(sessionId: string, opts: { since?: Date; limit?: number } = {}): Promise<any[]> {
        return this._api.call("getSessionGraphEdgeSearchUsage", { sessionId, since: toIso(opts.since), limit: opts.limit });
    }

    // ── Direct-parity shims ─────────────────────────────────────────────
    //
    // The direct client's positional signatures, implemented over `ops`.
    // These exist so `new PilotSwarmManagementClient({ apiUrl })` — which
    // returns this class under the direct client's type — is a TRUE claim
    // for the whole shared surface (the compile-time proof at the bottom of
    // this file enforces it). Param shapes mirror the web fact/graph stores,
    // which have exercised these exact wire mappings in production.
    //
    // Server-derived arguments (viewer, grantedBy, admin flags) are ignored:
    // the deployment derives identity and role from the request's auth
    // context, same as every other web-mode method.

    // — facts —

    async readFacts(query: Record<string, unknown>, _opts?: { admin?: boolean }): Promise<any> {
        return this.ops.readFacts({ ...query });
    }

    async storeFact(input: unknown): Promise<any> {
        return this.ops.storeFact({ input });
    }

    async deleteFact(input: unknown): Promise<any> {
        return this.ops.deleteFact({ input });
    }

    async searchFacts(query: string, opts?: unknown, _roleOpts?: { admin?: boolean }): Promise<any> {
        return this.ops.searchFacts({ query, opts });
    }

    async similarFacts(scopeKey: string, opts?: unknown, _roleOpts?: { admin?: boolean }): Promise<any> {
        return this.ops.similarFacts({ scopeKey, opts });
    }

    async forcePurgeFacts(input: unknown): Promise<any> {
        return this.ops.forcePurgeFacts({ input });
    }

    factsCapabilities(): never {
        // The direct signature is synchronous; capabilities live server-side
        // in web mode. Loud beats silent: an async lookalike would hand the
        // caller a Promise where they expect { search, embedder, graph }.
        throw webModeUnsupported("factsCapabilities", "use ops.factsCapabilities() (async over HTTP)");
    }

    // — embedder —

    async getEmbedderStatus(): Promise<any> {
        return this.ops.getEmbedderStatus();
    }

    async startEmbedder(opts?: { intervalSeconds?: number; batch?: number }): Promise<any> {
        return this.ops.startFactsEmbedder({ intervalSeconds: opts?.intervalSeconds, batch: opts?.batch });
    }

    async stopEmbedder(reason?: string): Promise<any> {
        return this.ops.stopFactsEmbedder({ reason });
    }

    // — graph —

    async searchGraphNodes(q: unknown): Promise<any> {
        return this.ops.searchGraphNodes({ query: q });
    }

    async searchGraphEdges(q: unknown): Promise<any> {
        return this.ops.searchGraphEdges({ query: q });
    }

    async graphNeighbourhood(nodeKey: string, depth: number, opts?: { namespace?: string }): Promise<any> {
        return this.ops.graphNeighbourhood({ nodeKey, depth, namespace: opts?.namespace });
    }

    async upsertGraphNode(n: unknown): Promise<any> {
        return this.ops.upsertGraphNode({ input: n });
    }

    async upsertGraphEdge(e: unknown): Promise<any> {
        return this.ops.upsertGraphEdge({ input: e });
    }

    async deleteGraphNode(nodeKey: string, opts?: { namespace?: string }): Promise<any> {
        return this.ops.deleteGraphNode({ nodeKey, namespace: opts?.namespace });
    }

    async deleteGraphEdge(fromKey: string, toKey: string, predicateKey: string, opts?: { namespace?: string }): Promise<any> {
        return this.ops.deleteGraphEdge({ fromKey, toKey, predicateKey, namespace: opts?.namespace });
    }

    async graphStats(opts?: { namespace?: string }): Promise<any> {
        return this.ops.graphStats({ namespace: opts?.namespace });
    }

    async listGraphNamespaces(q?: { prefix?: string; includeArchived?: boolean; includeDetails?: boolean }): Promise<any> {
        return this.ops.listGraphNamespaces({
            prefix: q?.prefix,
            includeArchived: q?.includeArchived,
            includeDetails: q?.includeDetails,
        });
    }

    async getGraphNamespace(namespace: string): Promise<any> {
        return this.ops.getGraphNamespace({ namespace });
    }

    async upsertGraphNamespace(input: unknown): Promise<any> {
        return this.ops.upsertGraphNamespace({ input });
    }

    async deleteGraphNamespace(namespace: string): Promise<any> {
        return this.ops.deleteGraphNamespace({ namespace });
    }

    // — session sharing / authz —

    /**
     * RETURN SHAPE DIVERGES from the direct client — the one shim that does.
     *
     * The route returns the portal's enriched view (`{sessionId, rootSessionId,
     * isSystem, visibility, owner, relation, canWrite, canManage,
     * viewerGroupId, enforced}`); the direct client returns the raw
     * `SessionAccessSnapshot` (`{rootSessionId, isSystem, visibility, owner,
     * viewerIsOwner, viewerShareAccess}`). They agree on the first four and
     * disagree on the decision fields — `relation`/`canWrite`/`canManage`
     * versus `viewerIsOwner`/`viewerShareAccess`.
     *
     * Deliberately NOT mapped: deriving `viewerShareAccess` from `canWrite`
     * would invent a distinction the route does not carry. Read the web fields
     * when you hold a web client, and do not rely on this one shim for
     * cross-mode parity. The compile-time proof cannot catch this — every web
     * method returns `Promise<any>`.
     */
    async getSessionAccess(sessionId: string, _viewer?: unknown): Promise<any> {
        return this.ops.getSessionAccess({ sessionId });
    }

    async setSessionVisibility(sessionId: string, visibility: string): Promise<void> {
        await this.ops.setSessionVisibility({ sessionId, visibility });
    }

    async grantSessionShare(
        sessionId: string,
        grantee: { provider: string; subject: string; email?: string | null; displayName?: string | null },
        access: "read" | "write",
        _grantedBy?: unknown,
    ): Promise<void> {
        await this.ops.grantSessionShare({ sessionId, user: grantee, access });
    }

    async revokeSessionShare(sessionId: string, grantee: { provider: string; subject: string }): Promise<void> {
        await this.ops.revokeSessionShare({ sessionId, user: grantee });
    }

    async listSessionShares(sessionId: string): Promise<any> {
        return this.ops.listSessionShares({ sessionId });
    }

    async listKnownUsers(opts?: { limit?: number }): Promise<any> {
        return this.ops.listKnownUsers({ limit: opts?.limit });
    }

    async listAuthzAudit(opts?: { limit?: number; sessionId?: string | null }): Promise<any> {
        return this.ops.listAuthzAudit({ limit: opts?.limit, sessionId: opts?.sessionId ?? undefined });
    }

    // ── Direct-only plumbing: explicit, typed refusals ──────────────────
    //
    // No route exists (or can exist) for these; a caller reaching them in
    // web mode gets a WEB_MODE_UNSUPPORTED error naming the alternative,
    // never a silent no-op or a bare TypeError.

    listSessionsVisible(): never {
        throw webModeUnsupported("listSessionsVisible", "listSessions is already viewer-scoped by the server in web mode");
    }

    recordAuthzAudit(): never {
        throw webModeUnsupported("recordAuthzAudit", "the portal records authz audit server-side");
    }

    recordUserRole(): never {
        throw webModeUnsupported("recordUserRole", "the portal records the sign-in role server-side; a remote writer would be privilege escalation");
    }

    getUserRole(): never {
        throw webModeUnsupported("getUserRole", "the caller's own role is on /api/auth/me; other users' roles are not exposed");
    }

    normalizeModel(): never {
        throw webModeUnsupported("normalizeModel", "model normalization happens server-side");
    }

    getModelCredentialStatus(): never {
        throw webModeUnsupported("getModelCredentialStatus", "credential checks happen server-side");
    }
}

/**
 * Compile-time proof that the constructor masquerade is true.
 *
 * `new PilotSwarmManagementClient({ apiUrl })` returns THIS class under the
 * direct client's type. That is only honest if this class satisfies the
 * direct client's entire public surface — every method either works over
 * HTTP (hand-written or shim) or refuses loudly with WEB_MODE_UNSUPPORTED
 * (`(): never` satisfies any signature, and a thrown typed error beats a
 * silent signature mismatch).
 *
 * WHAT THIS CATCHES: a direct method with no web counterpart at all, and a
 * web method whose parameters are of unrelated types (verified: retyping a
 * grantee object as `string` fails this line).
 *
 * WHAT IT DOES NOT CATCH, and why the runtime tests still matter:
 *   - **Parameter narrowing.** Class members are compared BIVARIANTLY by
 *     TypeScript regardless of `strict`, so a shim narrowing a param (say
 *     `access: "read" | "write"` down to `"read"`) still satisfies this.
 *     Verified empirically against the real types; mapped-type rewrites do
 *     not restore contravariance because homomorphic mapped types preserve
 *     method-ness. `web-client-shims.test.mjs` is what actually pins each
 *     shim's argument handling.
 *   - **Return shapes.** Web methods return `Promise<any>`, which is
 *     bidirectionally compatible with anything, so response payloads are
 *     unchecked here (see the two documented mismatches below).
 *
 * If a method is added to the direct client without a web counterpart, this
 * line stops compiling and names it.
 */
/**
 * Signature divergences excluded from the proof.
 *
 * These three are one family: model-catalog reads that direct mode answers
 * synchronously from its loaded provider registry and web mode necessarily
 * answers async over HTTP. The async web forms shipped in released versions,
 * so they stay. A direct-typed caller in web mode receives a Promise where it
 * expects a value — await it, or use the `ops.*` form.
 *
 * Not listed here, but also divergent: `factsCapabilities`, `normalizeModel`
 * and `getModelCredentialStatus` are sync on the direct client and have no
 * web equivalent at all. They satisfy the proof only because `(): never`
 * structurally satisfies any signature — i.e. by refusing loudly, which is
 * the intended contract, not by matching.
 */
type KnownDivergences = "getDefaultModel" | "getModelsByProvider" | "listModels";

type PublicSurface<T> = Pick<T, Exclude<keyof T, KnownDivergences>>;
type AssertExtends<A extends B, B> = A;
export type _WebSatisfiesManagementSurface = AssertExtends<
    PublicSurface<WebPilotSwarmManagementClient>,
    PublicSurface<import("../management-client.js").PilotSwarmManagementClient>
>;

/**
 * The management surface both modes genuinely share. Hold THIS type when a
 * variable may carry either mode — every method on it works (or refuses with
 * a typed WEB_MODE_UNSUPPORTED error) on both classes, no casts.
 *
 * The KnownDivergences appear with union returns (`X | Promise<X>`): sync in
 * direct mode, async over HTTP — `await` the result and both modes are
 * correct. Everything else carries the direct client's exact signature.
 *
 * The assertions below make both halves of the claim compile-checked.
 */
type DirectClient = import("../management-client.js").PilotSwarmManagementClient;
type SyncOrAsync<M extends (...args: never[]) => unknown> =
    (...args: Parameters<M>) => ReturnType<M> | Promise<Awaited<ReturnType<M>>>;
export type SharedManagementSurface =
    PublicSurface<DirectClient>
    & {
        /** Sync in direct mode, async over HTTP — always `await` the result. */
        listModels: SyncOrAsync<DirectClient["listModels"]>;
        /** Sync in direct mode, async over HTTP — always `await` the result. */
        getModelsByProvider: SyncOrAsync<DirectClient["getModelsByProvider"]>;
        /** Sync in direct mode, async over HTTP — always `await` the result. */
        getDefaultModel: SyncOrAsync<DirectClient["getDefaultModel"]>;
    };

type FullPublic<T> = Pick<T, keyof T>;
export type _DirectSatisfiesShared = AssertExtends<FullPublic<DirectClient>, SharedManagementSurface>;
export type _WebSatisfiesShared = AssertExtends<FullPublic<WebPilotSwarmManagementClient>, SharedManagementSurface>;

