import { NodeSdkTransport } from "pilotswarm/host";
import {
    loadAuthzConfig,
    normalizeVisibility,
    getMethodAccess,
    evaluateSessionAccess,
    relationFor,
    forbiddenError,
    notFoundError,
} from "./authz.js";

function normalizeParams(params) {
    return params && typeof params === "object" ? params : {};
}

function clampInteger(value, defaultValue, min, max) {
    if (value == null) return defaultValue;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return defaultValue;
    return Math.max(min, Math.min(Math.trunc(numeric), max));
}

function normalizeSessionPageOptions(params) {
    const limit = clampInteger(params.limit, 50, 1, 200);
    const includeDeleted = params.includeDeleted === true;
    if (params.cursor != null && typeof params.cursor !== "object") {
        throw new Error("listSessionsPage cursor must be an object when provided");
    }
    const rawCursor = params.cursor ?? null;
    let cursor = null;

    if (rawCursor) {
        const updatedAt = Number(rawCursor.updatedAt);
        const sessionId = String(rawCursor.sessionId || "").trim();
        if (!Number.isFinite(updatedAt)) {
            throw new Error("listSessionsPage cursor.updatedAt must be a finite number");
        }
        if (!sessionId) {
            throw new Error("listSessionsPage cursor.sessionId must be a non-empty string");
        }
        cursor = { updatedAt, sessionId };
    }

    return { limit, cursor, includeDeleted };
}

function normalizeTopEventEmitterOptions(params) {
    if (params.since == null) {
        throw new Error("getTopEventEmitters since is required");
    }
    const since = new Date(params.since);
    if (Number.isNaN(since.getTime())) {
        throw new Error("getTopEventEmitters since must be a valid date");
    }
    return {
        since,
        limit: clampInteger(params.limit, 20, 1, 100),
    };
}

function normalizeSessionOwner(authContext) {
    const principal = authContext?.principal;
    return normalizeOwnerPrincipal(principal);
}

function normalizeOwnerPrincipal(principal) {
    const provider = String(principal?.provider || "").trim();
    const subject = String(principal?.subject || "").trim();
    if (!provider || !subject) return null;
    return {
        provider,
        subject,
        email: String(principal?.email || "").trim() || null,
        displayName: String(principal?.displayName || "").trim() || null,
    };
}

// Placement identity: group placements are keyed off the same principal as
// owner stamping. No-auth deployments fall back to a shared anonymous user
// (lazily registered by the placement proc) so grouping keeps working there.
function placementPrincipal(authContext) {
    const principal = normalizeSessionOwner(authContext);
    if (principal) return { provider: principal.provider, subject: principal.subject };
    return { provider: "anonymous", subject: "anonymous" };
}

function requireUserPrincipal(authContext, methodName) {
    const principal = normalizeSessionOwner(authContext);
    if (!principal) {
        const err = new Error(`Portal RPC '${methodName}' requires an authenticated principal.`);
        err.code = "PORTAL_AUTH_REQUIRED";
        throw err;
    }
    return principal;
}

// Break-glass audit coverage: every non-read session op, plus the reads that
// expose content (transcript, artifacts, history). Status polling and list
// metadata are excluded to keep the audit stream signal-dense.
const BREAK_GLASS_AUDITED = {
    any: true,
    getSessionEvents: true,
    getSessionEventsBefore: true,
    downloadArtifact: true,
    readArtifactBase64: true,
    getExecutionHistory: true,
    getLatestResponse: true,
    listSessionShares: true,
};

export class PortalRuntime {
    constructor({ store, mode, useManagedIdentity, cmsFactsDatabaseUrl, aadDbUser } = {}) {
        this.transport = new NodeSdkTransport({ store, mode, useManagedIdentity, cmsFactsDatabaseUrl, aadDbUser });
        this.mode = mode;
        this.started = false;
        this.startPromise = null;
        this.authz = loadAuthzConfig();
        // Throttle repeated break-glass audit rows for the same actor+session
        // (the portal polls events continuously while a session is open).
        this._breakGlassSeen = new Map(); // key -> expiry epoch ms
    }

    // ── Authorization (security model) ──────────────────────────────────

    _recordAudit(entry) {
        if (typeof this.transport.recordAuthzAudit !== "function") return;
        this.transport.recordAuthzAudit(entry).catch(() => {});
    }

    _auditActor(authContext) {
        const principal = authContext?.principal;
        return {
            provider: principal?.provider ?? null,
            subject: principal?.subject ?? null,
            display: principal?.displayName ?? principal?.email ?? null,
        };
    }

    _shouldRecordBreakGlass(actorKey, sessionId) {
        const key = `${actorKey}${sessionId}`;
        const now = Date.now();
        const expiry = this._breakGlassSeen.get(key);
        if (expiry && expiry > now) return false;
        if (this._breakGlassSeen.size > 5000) this._breakGlassSeen.clear();
        this._breakGlassSeen.set(key, now + 15 * 60 * 1000);
        return true;
    }

    /**
     * Gate one dispatched method. Returns { snapshot } (the access snapshot
     * for session-scoped ops, so handlers can reuse it — e.g. sender
     * relation) or throws 403/404. With enforcement off, would-be denials
     * are audited and allowed through (dark launch).
     */
    async _authorizeCall(method, safeParams, authContext, { owner, isAdmin }) {
        const spec = getMethodAccess(method);
        const access = spec?.access || "authed";

        if (access === "authed" || access === "session:create" || access === "facts:read" || access === "group:list" || access === "session:list") {
            // List/read scoping happens in the case handlers (viewer-scoped
            // catalog paths); creation stamps owner+visibility there too.
            return { snapshot: null };
        }

        if (access === "fleet:read" || access === "fleet:admin") {
            if (!isAdmin) {
                const reason = access === "fleet:admin"
                    ? "This operation requires the admin role."
                    : "Fleet-wide observability requires the admin role.";
                this._recordAudit({
                    actor: this._auditActor(authContext),
                    action: method,
                    decision: this.authz.enforce ? "deny" : "would_deny",
                    reason,
                });
                if (this.authz.enforce || access === "fleet:admin") {
                    // fleet:admin has always been enforced (op.admin) —
                    // keep it hard regardless of the dark-launch flag.
                    throw forbiddenError(reason);
                }
            }
            return { snapshot: null };
        }

        if (access === "facts:write") {
            await this._authorizeFactsWrite(method, safeParams, authContext, { owner, isAdmin });
            return { snapshot: null };
        }

        if (access === "group:manage") {
            await this._authorizeGroupManage(method, safeParams, authContext, { owner, isAdmin });
            return { snapshot: null };
        }

        if (access === "authz:audit") {
            const sessionId = safeParams.sessionId ? String(safeParams.sessionId) : null;
            if (isAdmin) return { snapshot: null };
            if (!sessionId) throw forbiddenError("Fleet-wide audit requires the admin role. Pass sessionId to read audit for a session you own.");
            // Owner-only, and hard-enforced (session:share) so a missing/deleted
            // session id can't open the audit trail during dark-launch.
            return this._gateSession(method, "session:share", sessionId, authContext, { owner, isAdmin });
        }

        if (access === "session:copy") {
            const [from, to] = await Promise.all([
                this._gateSession(method, "session:read", safeParams.fromSessionId, authContext, { owner, isAdmin }),
                this._gateSession(method, "session:write", safeParams.toSessionId, authContext, { owner, isAdmin }),
            ]);
            return { snapshot: to.snapshot ?? from.snapshot };
        }

        if (access.startsWith("session:")) {
            const sessionId = safeParams[spec.sessionParam];
            return this._gateSession(method, access, sessionId, authContext, { owner, isAdmin });
        }

        return { snapshot: null };
    }

    /** Whether the deployment's transport can resolve access snapshots at all. */
    _accessSnapshotSupported() {
        return typeof this.transport.getSessionAccess === "function";
    }

    async _getAccessSnapshot(sessionId, owner) {
        if (!sessionId || !this._accessSnapshotSupported()) return null;
        return this.transport.getSessionAccess(String(sessionId), {
            provider: owner?.provider ?? "",
            subject: owner?.subject ?? "",
        });
    }

    async _gateSession(method, accessClass, sessionId, authContext, { owner, isAdmin }) {
        // session:share is a brand-new capability with no pre-model behavior
        // to preserve, so it is enforced even during the ownership dark-launch
        // — otherwise a user could pre-plant a durable grant that survives the
        // flip to enforce (adversarial review HIGH-2).
        const effectiveEnforce = this.authz.enforce || accessClass === "session:share";
        const hasSessionId = sessionId != null && String(sessionId).trim() !== "";

        // HIGH-1: a supplied-but-unresolvable id (missing OR soft-deleted —
        // cms_get_session_access returns no row for either) must not open the
        // gate. Only genuinely id-less ops get the permissive null path. Skip
        // when the transport can't resolve snapshots at all (legacy/no-auth).
        if (hasSessionId && this._accessSnapshotSupported()) {
            const snapshot = await this._getAccessSnapshot(sessionId, owner);
            if (!snapshot) {
                this._recordAudit({
                    actor: this._auditActor(authContext),
                    action: method,
                    sessionId: String(sessionId),
                    decision: effectiveEnforce ? "deny" : "would_deny",
                    reason: "session not found or deleted",
                });
                if (!effectiveEnforce) return { snapshot: null };
                throw notFoundError();
            }
            return this._decideSessionAccess(method, accessClass, snapshot, sessionId, authContext, { isAdmin, effectiveEnforce });
        }

        const snapshot = await this._getAccessSnapshot(sessionId, owner);
        return this._decideSessionAccess(method, accessClass, snapshot, sessionId, authContext, { isAdmin, effectiveEnforce });
    }

    _decideSessionAccess(method, accessClass, snapshot, sessionId, authContext, { isAdmin, effectiveEnforce }) {
        const decision = evaluateSessionAccess(accessClass, snapshot, {
            isAdmin,
            systemReadable: this.authz.systemVisibility === "read",
        });

        if (decision.allowed) {
            if (decision.breakGlass && BREAK_GLASS_AUDITED[accessClass !== "session:read" ? "any" : method]) {
                const actor = this._auditActor(authContext);
                const actorKey = `${actor.provider}/${actor.subject}`;
                if (this._shouldRecordBreakGlass(actorKey, String(sessionId))) {
                    this._recordAudit({
                        actor,
                        action: method,
                        sessionId: String(sessionId),
                        decision: "break_glass",
                        reason: "Admin access to a private session owned by another user",
                    });
                }
            }
            return { snapshot };
        }

        this._recordAudit({
            actor: this._auditActor(authContext),
            action: method,
            sessionId: sessionId ? String(sessionId) : null,
            decision: effectiveEnforce ? "deny" : "would_deny",
            reason: decision.notFound ? "not visible" : decision.reason,
        });

        if (!effectiveEnforce) return { snapshot };
        throw decision.notFound ? notFoundError() : forbiddenError(decision.reason);
    }

    /**
     * Facts write containment: non-admin callers may write/delete shared
     * facts (the deployment's collaboration memory) and facts of sessions
     * they can WRITE; anything else — in particular pattern deletes over
     * other sessions' private facts — is denied.
     */
    async _authorizeFactsWrite(method, safeParams, authContext, { owner, isAdmin }) {
        if (isAdmin) return;
        const inputs = Array.isArray(safeParams.input) ? safeParams.input : [safeParams.input];
        for (const input of inputs) {
            const sessionId = typeof input?.sessionId === "string" && input.sessionId.trim() ? input.sessionId.trim() : null;
            const scopeKey = typeof input?.scopeKey === "string" ? input.scopeKey : "";
            const sessionScopeFromKey = scopeKey.startsWith("session:") ? scopeKey.split(":")[1] || null : null;
            const targetSession = sessionId || sessionScopeFromKey;
            const isSharedScope = !targetSession && (input?.shared === true || scopeKey.startsWith("shared:") || input?.scope === "shared" || (!scopeKey && !sessionId));
            if (isSharedScope) continue;
            await this._gateSession(method, "session:write", targetSession, authContext, { owner, isAdmin });
        }
    }

    async _authorizeGroupManage(method, safeParams, authContext, { owner, isAdmin }) {
        if (isAdmin) return;
        const groupId = safeParams.groupId ? String(safeParams.groupId) : null;
        if (groupId) {
            const groups = await this.transport.listSessionGroups().catch(() => []);
            const group = (groups || []).find((g) => g.groupId === groupId);
            if (group) {
                const groupOwner = normalizeOwnerPrincipal(group.owner);
                const allowed = !groupOwner || (owner && groupOwner.provider === owner.provider && groupOwner.subject === owner.subject);
                if (!allowed) {
                    this._recordAudit({
                        actor: this._auditActor(authContext),
                        action: method,
                        target: `group:${groupId}`,
                        decision: this.authz.enforce ? "deny" : "would_deny",
                        reason: "group owned by another user",
                    });
                    if (this.authz.enforce) {
                        throw forbiddenError("Only the group owner or an admin can manage this group.");
                    }
                }
            }
        }
        // Assign/move (including ungroup, groupId=null) also mutates the
        // sessions themselves — gate each as session:manage so a user can't
        // pull another user's session out of (or into) a group
        // (adversarial review MEDIUM-2).
        const sessionIds = Array.isArray(safeParams.sessionIds) ? safeParams.sessionIds : [];
        for (const sessionId of sessionIds) {
            await this._gateSession(method, "session:manage", sessionId, authContext, { owner, isAdmin });
        }
    }

    /**
     * Placement viewer for the CMS placement procs. canRead inside the procs
     * is permissive when ownership enforcement is off (admin OR NOT enforce);
     * the target-group ownership check is always enforced regardless.
     */
    _placementViewer(authContext, isAdmin) {
        return { ...placementPrincipal(authContext), isAdmin: isAdmin || !this.authz.enforce };
    }

    /**
     * Viewer-private placement: upsert (or clear, when groupId is null) the
     * caller's own group placement for each session tree root. Requires read
     * access per session; the target group must be owned by the caller —
     * cross-user placement is structurally impossible.
     */
    async _placeSessionsInGroup(method, safeParams, authContext, { isAdmin }) {
        const groupId = safeParams.groupId == null ? null : String(safeParams.groupId).trim() || null;
        const sessionIds = Array.isArray(safeParams.sessionIds) ? safeParams.sessionIds : [];
        try {
            return await this.transport.mgmt.placeSessionsInGroup(
                this._placementViewer(authContext, isAdmin),
                sessionIds,
                groupId,
            );
        } catch (error) {
            if (/was not found or is not owned by the caller/i.test(String(error?.message || ""))) {
                this._recordAudit({
                    actor: this._auditActor(authContext),
                    action: method,
                    target: `group:${groupId}`,
                    decision: "deny",
                    reason: "group not found or not owned by the caller",
                });
                throw forbiddenError("Session group not found or not owned by you.");
            }
            throw error;
        }
    }

    /** A creator-supplied groupId is an initial placement: it must be one of the caller's groups. */
    async _assertPlacementGroupOwned(groupId, authContext, { isAdmin }) {
        const normalized = groupId == null ? null : String(groupId).trim() || null;
        if (!normalized) return;
        const groups = await this.transport.mgmt.listSessionGroups(this._placementViewer(authContext, isAdmin));
        if (!(groups || []).some((group) => group.groupId === normalized)) {
            throw forbiddenError("Session group not found or not owned by you.");
        }
    }

    /**
     * Guarantee a created session lands in the requested group under the
     * placement principal, not the session owner. CMS places in-transaction
     * only when an owner principal reaches it, so no-auth deployments (owner
     * null, placement viewer anonymous) would otherwise drop the group
     * silently. The upsert is idempotent, so the authenticated path (already
     * placed) is skipped via the viewerGroupId check; ownership was verified
     * before create, so a placement failure is unexpected and best-effort.
     */
    async _ensureCreatedPlacement(view, groupId, authContext, isAdmin) {
        const normalized = groupId == null ? null : String(groupId).trim() || null;
        if (!normalized || !view?.sessionId || view.viewerGroupId === normalized) return view;
        try {
            await this.transport.mgmt.placeSessionsInGroup(
                this._placementViewer(authContext, isAdmin),
                [view.sessionId],
                normalized,
            );
            return { ...view, viewerGroupId: normalized };
        } catch {
            return view;
        }
    }

    /**
     * Viewer descriptor for viewer-scoped listing, or null for unfiltered.
     * A non-admin without a resolvable identity in enforce mode gets a viewer
     * that matches no owner and no targeted share, so they see only
     * deployment-shared trees (shared_read/shared_write are visible to every
     * admitted user by design) — never the unfiltered fleet or another user's
     * private sessions (adversarial review LOW-1 / NEW-5).
     */
    _listViewer(owner, isAdmin) {
        if (isAdmin || !this.authz.enforce) return null;
        if (!owner) return { provider: " nomatch", subject: " nomatch", systemVisible: false };
        return {
            provider: owner.provider,
            subject: owner.subject,
            systemVisible: this.authz.systemVisibility === "read",
        };
    }

    async start() {
        if (this.started) return;
        if (!this.startPromise) {
            this.startPromise = this.transport.start()
                .then(() => {
                    this.started = true;
                })
                .finally(() => {
                    this.startPromise = null;
                });
        }
        await this.startPromise;
    }

    async stop() {
        if (!this.started && !this.startPromise) return;
        if (this.startPromise) {
            await this.startPromise.catch(() => {});
        }
        if (this.started) {
            await this.transport.stop();
            this.started = false;
        }
    }

    async resolveSessionGroupOwner(input = {}, authOwner = null) {
        // Groups belong to the authenticated creator. Ownership is never
        // inferred from selected sessions, and never null: no-auth
        // deployments use the same anonymous principal as placement so
        // every group can receive placements.
        if (authOwner) return authOwner;
        const inputOwner = normalizeOwnerPrincipal(input?.owner);
        if (inputOwner) return inputOwner;
        return { provider: "anonymous", subject: "anonymous" };
    }

    async getBootstrap() {
        await this.start();
        return {
            mode: this.mode,
            workerCount: typeof this.transport.getWorkerCount === "function"
                ? this.transport.getWorkerCount()
                : null,
            logConfig: typeof this.transport.getLogConfig === "function"
                ? this.transport.getLogConfig()
                : null,
            defaultModel: typeof this.transport.getDefaultModel === "function"
                ? this.transport.getDefaultModel()
                : null,
            modelsByProvider: typeof this.transport.getModelsByProvider === "function"
                ? this.transport.getModelsByProvider()
                : [],
            creatableAgents: typeof this.transport.listCreatableAgents === "function"
                ? await this.transport.listCreatableAgents()
                : [],
            sessionCreationPolicy: typeof this.transport.getSessionCreationPolicy === "function"
                ? this.transport.getSessionCreationPolicy()
                : null,
            // Ownership/visibility posture (security model) so clients (portal,
            // MCP, TUI) can explain why a session isn't listed or a send was
            // refused, and default the share UI correctly.
            authz: {
                ownershipEnforced: this.authz.enforce,
                defaultVisibility: this.authz.defaultVisibility,
                systemVisibility: this.authz.systemVisibility,
            },
        };
    }

    async call(method, params = {}, authContext = null) {
        await this.start();
        const safeParams = normalizeParams(params);
        const owner = normalizeSessionOwner(authContext);
        // Privileged when admin-role, or no-auth ("anonymous" = full access on a
        // trusted deployment). Non-admin facts reads are restricted to shared
        // visibility so a plain caller cannot read another session's private facts.
        const role = authContext?.authorization?.role;
        const isAdmin = role === "admin" || role === "anonymous";
        // Ownership/visibility gate — the single enforcement point for both
        // the generated /api/v1 routes and the legacy /api/rpc dispatcher.
        const gate = await this._authorizeCall(method, safeParams, authContext, { owner, isAdmin });
        const listViewer = this._listViewer(owner, isAdmin);
        switch (method) {
            case "listSessions":
                return listViewer
                    ? this.transport.mgmt.listSessionsVisible(listViewer, placementPrincipal(authContext))
                    : this.transport.mgmt.listSessions(placementPrincipal(authContext));
            case "listSessionGroups":
                // Viewer-scoped: everyone (admins included) sees only their
                // own groups — a group is a user's private organization.
                return this.transport.mgmt.listSessionGroups(this._placementViewer(authContext, isAdmin));
            case "createSessionGroup":
                return this.transport.createSessionGroup({
                    ...(safeParams.input || {}),
                    owner: await this.resolveSessionGroupOwner(safeParams.input || {}, owner),
                });
            case "updateSessionGroup":
                return this.transport.updateSessionGroup(safeParams.groupId, safeParams.patch || {});
            case "placeSessionsInGroup":
            case "assignSessionsToGroup":
            case "moveSessionsToGroup":
                return this._placeSessionsInGroup(method, safeParams, authContext, { isAdmin });
            case "getChildOutcome":
                return this.transport.getChildOutcome(safeParams.childSessionId);
            case "listChildOutcomes":
                return this.transport.listChildOutcomes(safeParams.parentSessionId);
            case "listSessionsPage":
                return this.transport.mgmt.listSessionsPage({
                    ...normalizeSessionPageOptions(safeParams),
                    ...(listViewer ? { viewer: listViewer } : {}),
                    placement: placementPrincipal(authContext),
                });
            case "getSession":
                return this.transport.mgmt.getSession(safeParams.sessionId, placementPrincipal(authContext));
            case "getOrchestrationStats":
                return this.transport.getOrchestrationStats(safeParams.sessionId);
            case "getSessionMetricSummary":
                return this.transport.getSessionMetricSummary(safeParams.sessionId);
            case "getSessionTokensByModel":
                return this.transport.getSessionTokensByModel(safeParams.sessionId);
            case "getSessionTreeStats":
                return this.transport.getSessionTreeStats(safeParams.sessionId);
            case "getFleetStats":
                return this.transport.getFleetStats({
                    includeDeleted: safeParams.includeDeleted,
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                });
            case "getUserStats":
                return this.transport.getUserStats({
                    includeDeleted: safeParams.includeDeleted,
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                });
            case "getCurrentUserProfile": {
                const profile = await this.transport.getCurrentUserProfile({
                    principal: requireUserPrincipal(authContext, "getCurrentUserProfile"),
                });
                return profile ? { ...profile, isAdmin } : profile;
            }
            case "setCurrentUserProfileSettings":
                return this.transport.setCurrentUserProfileSettings({
                    principal: requireUserPrincipal(authContext, "setCurrentUserProfileSettings"),
                    settings: safeParams.settings,
                });
            case "setCurrentUserGitHubCopilotKey":
                return this.transport.setCurrentUserGitHubCopilotKey({
                    principal: requireUserPrincipal(authContext, "setCurrentUserGitHubCopilotKey"),
                    key: typeof safeParams.key === "string" ? safeParams.key : null,
                });
            case "setSystemGitHubCopilotKey": {
                if (!isAdmin) {
                    const err = new Error("Portal RPC 'setSystemGitHubCopilotKey' requires the admin role.");
                    err.code = "PORTAL_ADMIN_REQUIRED";
                    throw err;
                }
                return this.transport.setSystemGitHubCopilotKey({
                    actor: normalizeSessionOwner(authContext),
                    key: typeof safeParams.key === "string" ? safeParams.key : null,
                });
            }
            case "getSystemGitHubCopilotKeyStatus": {
                if (!isAdmin) {
                    const err = new Error("Portal RPC 'getSystemGitHubCopilotKeyStatus' requires the admin role.");
                    err.code = "PORTAL_ADMIN_REQUIRED";
                    throw err;
                }
                return this.transport.getSystemGitHubCopilotKeyStatus();
            }
            case "getSessionSkillUsage":
                return this.transport.getSessionSkillUsage(safeParams.sessionId, {
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                });
            case "getSessionTreeSkillUsage":
                return this.transport.getSessionTreeSkillUsage(safeParams.sessionId, {
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                });
            case "getFleetSkillUsage":
                return this.transport.getFleetSkillUsage({
                    includeDeleted: safeParams.includeDeleted,
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                });
            case "getFleetRetrievalUsage":
                return this.transport.getFleetRetrievalUsage({
                    includeDeleted: safeParams.includeDeleted,
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                });
            case "getSessionRetrievalUsage":
                return this.transport.getSessionRetrievalUsage(safeParams.sessionId, {
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                });
            case "getSessionTreeRetrievalUsage":
                return this.transport.getSessionTreeRetrievalUsage(safeParams.sessionId, {
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                });
            case "getSessionGraphNodeUsage":
                return this.transport.getSessionGraphNodeUsage(safeParams.sessionId, {
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                    limit: safeParams.limit,
                    nodeKeyLike: safeParams.nodeKeyLike,
                    kind: safeParams.kind,
                });
            case "getSessionGraphEdgeSearchUsage":
                return this.transport.getSessionGraphEdgeSearchUsage(safeParams.sessionId, {
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                    limit: safeParams.limit,
                });
            case "getSessionGraphSearches":
                return this.transport.getSessionGraphSearches(safeParams.sessionId, safeParams.limit);
            case "getFleetGraphNodeUsage":
                return this.transport.getFleetGraphNodeUsage({
                    includeDeleted: safeParams.includeDeleted,
                    since: safeParams.since ? new Date(safeParams.since) : undefined,
                    limit: safeParams.limit,
                    nodeKeyLike: safeParams.nodeKeyLike,
                    kind: safeParams.kind,
                });
            case "getSessionFactsStats":
                return this.transport.getSessionFactsStats(safeParams.sessionId);
            case "getSessionTreeFactsStats":
                return this.transport.getSessionTreeFactsStats(safeParams.sessionId);
            case "getSharedFactsStats":
                return this.transport.getSharedFactsStats();
            case "getFactsTombstoneStats":
                return this.transport.getFactsTombstoneStats({ ttlSeconds: safeParams.ttlSeconds });

            // ── Facts data-plane ────────────────────────────────────────
            case "factsCapabilities":
                return this.transport.factsCapabilities();
            case "readFacts":
                return this.transport.readFacts(safeParams, { admin: isAdmin });
            case "storeFact":
                return this.transport.storeFact(safeParams.input);
            case "deleteFact":
                return this.transport.deleteFactRecord(safeParams.input);
            case "searchFacts":
                return this.transport.searchFacts(safeParams.query, safeParams.opts, { admin: isAdmin });
            case "similarFacts":
                return this.transport.similarFacts(safeParams.scopeKey, safeParams.opts, { admin: isAdmin });
            case "getEmbedderStatus":
                return this.transport.getFactsEmbedderStatus();
            case "startFactsEmbedder":
                return this.transport.startFactsEmbedder({ intervalSeconds: safeParams.intervalSeconds, batch: safeParams.batch });
            case "stopFactsEmbedder":
                return this.transport.stopFactsEmbedder(safeParams.reason);
            case "forcePurgeFacts":
                return this.transport.forcePurgeFacts(safeParams.input);

            // ── Graph data-plane ────────────────────────────────────────
            case "searchGraphNodes":
                return this.transport.searchGraphNodes(safeParams.query);
            case "searchGraphEdges":
                return this.transport.searchGraphEdges(safeParams.query);
            case "graphNeighbourhood":
                return this.transport.graphNeighbourhood(safeParams.nodeKey, safeParams.depth, { namespace: safeParams.namespace });
            case "upsertGraphNode":
                return this.transport.upsertGraphNode(safeParams.input);
            case "upsertGraphEdge":
                return this.transport.upsertGraphEdge(safeParams.input);
            case "deleteGraphNode":
                return this.transport.deleteGraphNode(safeParams.nodeKey, { namespace: safeParams.namespace });
            case "deleteGraphEdge":
                return this.transport.deleteGraphEdge(safeParams.fromKey, safeParams.toKey, safeParams.predicateKey, { namespace: safeParams.namespace });
            case "graphStats":
                return this.transport.graphStats({ namespace: safeParams.namespace });
            case "listGraphNamespaces":
                return this.transport.listGraphNamespaces({ prefix: safeParams.prefix, includeArchived: safeParams.includeArchived, includeDetails: safeParams.includeDetails });
            case "getGraphNamespace":
                return this.transport.getGraphNamespace(safeParams.namespace);
            case "upsertGraphNamespace":
                return this.transport.upsertGraphNamespace(safeParams.input);
            case "deleteGraphNamespace":
                return this.transport.deleteGraphNamespace(safeParams.namespace);
            case "pruneDeletedSummaries":
                return this.transport.pruneDeletedSummaries(new Date(safeParams.olderThan));
            case "getExecutionHistory":
                return this.transport.getExecutionHistory(safeParams.sessionId, safeParams.executionId);
            case "createSession": {
                await this._assertPlacementGroupOwned(safeParams.groupId, authContext, { isAdmin });
                const created = await this.transport.createSession({
                    model: safeParams.model,
                    reasoningEffort: safeParams.reasoningEffort,
                    contextTier: safeParams.contextTier,
                    groupId: safeParams.groupId,
                    owner,
                    visibility: normalizeVisibility(safeParams.visibility, this.authz.defaultVisibility),
                });
                return this._ensureCreatedPlacement(created, safeParams.groupId, authContext, isAdmin);
            }
            case "createSessionForAgent": {
                await this._assertPlacementGroupOwned(safeParams.groupId, authContext, { isAdmin });
                const created = await this.transport.createSessionForAgent(safeParams.agentName, {
                    model: safeParams.model,
                    reasoningEffort: safeParams.reasoningEffort,
                    contextTier: safeParams.contextTier,
                    title: safeParams.title,
                    splash: safeParams.splash,
                    splashMobile: safeParams.splashMobile,
                    initialPrompt: safeParams.initialPrompt,
                    groupId: safeParams.groupId,
                    owner,
                    visibility: normalizeVisibility(safeParams.visibility, this.authz.defaultVisibility),
                });
                return this._ensureCreatedPlacement(created, safeParams.groupId, authContext, isAdmin);
            }
            case "listCreatableAgents":
                return this.transport.listCreatableAgents();
            case "getSessionCreationPolicy":
                return this.transport.getSessionCreationPolicy();
            case "sendMessage":
                return this.transport.sendMessage(safeParams.sessionId, safeParams.prompt, {
                    ...(safeParams.options && typeof safeParams.options === "object" ? safeParams.options : {}),
                    // Server-stamped; a client-supplied options.sender is overwritten.
                    sender: this._buildSender(authContext, gate.snapshot, { isAdmin, origin: safeParams.options?.origin }),
                });
            case "sendAnswer":
                return this.transport.sendAnswer(safeParams.sessionId, safeParams.answer, {
                    sender: this._buildSender(authContext, gate.snapshot, { isAdmin }),
                });
            case "sendSessionEvent":
                return this.transport.sendSessionEvent(safeParams.sessionId, safeParams.eventName, safeParams.data);

            // ── Session sharing (security model) ────────────────────────
            case "getSessionAccess": {
                const snapshot = gate.snapshot ?? await this._getAccessSnapshot(safeParams.sessionId, owner);
                if (!snapshot) {
                    throw notFoundError();
                }
                const relation = snapshot.viewerIsOwner ? "owner" : (isAdmin ? "admin" : (snapshot.viewerShareAccess ? "collaborator" : "none"));
                const canWrite = isAdmin || snapshot.viewerIsOwner || snapshot.visibility === "shared_write" || snapshot.viewerShareAccess === "write";
                const canManage = isAdmin || snapshot.viewerIsOwner;
                // The caller's private placement of this tree (placements
                // live on the root), never another viewer's.
                const rootView = snapshot.rootSessionId
                    ? await this.transport.mgmt.getSession(snapshot.rootSessionId, placementPrincipal(authContext)).catch(() => null)
                    : null;
                return {
                    sessionId: safeParams.sessionId,
                    rootSessionId: snapshot.rootSessionId,
                    isSystem: snapshot.isSystem,
                    visibility: snapshot.visibility,
                    owner: snapshot.owner,
                    relation,
                    canWrite: snapshot.isSystem ? isAdmin : canWrite,
                    canManage: snapshot.isSystem ? isAdmin : canManage,
                    viewerGroupId: rootView?.viewerGroupId ?? null,
                    enforced: this.authz.enforce,
                };
            }
            case "setSessionVisibility": {
                const visibility = normalizeVisibility(safeParams.visibility, null);
                if (!visibility) {
                    throw Object.assign(new Error("visibility must be private | shared_read | shared_write"), { code: "INVALID_REQUEST" });
                }
                await this.transport.setSessionVisibility(safeParams.sessionId, visibility);
                this._recordAudit({
                    actor: this._auditActor(authContext),
                    action: "setSessionVisibility",
                    sessionId: String(safeParams.sessionId),
                    decision: "share_change",
                    reason: `visibility=${visibility}`,
                });
                return { sessionId: safeParams.sessionId, visibility };
            }
            case "grantSessionShare": {
                const grantee = safeParams.user && typeof safeParams.user === "object" ? safeParams.user : {};
                const access = safeParams.access === "write" ? "write" : safeParams.access === "read" ? "read" : null;
                if (!grantee.provider || !grantee.subject || !access) {
                    throw Object.assign(new Error("grantSessionShare requires user { provider, subject } and access read|write"), { code: "INVALID_REQUEST" });
                }
                await this.transport.grantSessionShare(safeParams.sessionId, grantee, access, owner);
                this._recordAudit({
                    actor: this._auditActor(authContext),
                    action: "grantSessionShare",
                    sessionId: String(safeParams.sessionId),
                    target: `${grantee.provider}/${grantee.subject}`,
                    decision: "share_change",
                    reason: `access=${access}`,
                });
                return { sessionId: safeParams.sessionId, granted: { ...grantee, access } };
            }
            case "revokeSessionShare": {
                const grantee = safeParams.user && typeof safeParams.user === "object" ? safeParams.user : {};
                if (!grantee.provider || !grantee.subject) {
                    throw Object.assign(new Error("revokeSessionShare requires user { provider, subject }"), { code: "INVALID_REQUEST" });
                }
                await this.transport.revokeSessionShare(safeParams.sessionId, grantee);
                this._recordAudit({
                    actor: this._auditActor(authContext),
                    action: "revokeSessionShare",
                    sessionId: String(safeParams.sessionId),
                    target: `${grantee.provider}/${grantee.subject}`,
                    decision: "share_change",
                    reason: "revoked",
                });
                return { sessionId: safeParams.sessionId, revoked: grantee };
            }
            case "listSessionShares":
                return this.transport.listSessionShares(safeParams.sessionId);
            case "listKnownUsers":
                return typeof this.transport.listKnownUsers === "function"
                    ? this.transport.listKnownUsers({ limit: safeParams.limit })
                    : [];
            case "listAuthzAudit":
                return this.transport.listAuthzAudit({
                    limit: safeParams.limit,
                    sessionId: safeParams.sessionId ?? null,
                });
            case "getSessionStatus":
                return this.transport.getSessionStatus(safeParams.sessionId);
            case "waitForStatusChange": {
                // Long-poll: the server holds the request open, capped well
                // below typical ingress idle timeouts. On timeout the
                // underlying wait throws; translate that into "no change"
                // by returning the current status, so the client sees a
                // clean unchanged snapshot and loops (instead of a 500).
                const sessionId = safeParams.sessionId;
                const afterVersion = Number(safeParams.afterVersion) || 0;
                const timeoutMs = clampInteger(safeParams.timeoutMs, 25_000, 1_000, 300_000);
                try {
                    return await this.transport.waitForStatusChange(sessionId, afterVersion, timeoutMs);
                } catch (error) {
                    if (/Timed out waiting/i.test(String(error?.message || ""))) {
                        return this.transport.getSessionStatus(sessionId);
                    }
                    throw error;
                }
            }
            case "getLatestResponse":
                return this.transport.getLatestResponse(safeParams.sessionId);
            case "cancelPendingMessage":
                return this.transport.cancelPendingMessage(safeParams.sessionId, safeParams.clientMessageIds);
            case "renameSession":
                return this.transport.renameSession(safeParams.sessionId, safeParams.title);
            case "cancelSession":
                return this.transport.cancelSession(safeParams.sessionId);
            case "cancelSessionGroup":
                return this.transport.cancelSessionGroup(safeParams.groupId, safeParams.reason);
            case "completeSession":
                return this.transport.completeSession(safeParams.sessionId, safeParams.reason);
            case "completeSessionGroup":
                return this.transport.completeSessionGroup(safeParams.groupId, safeParams.options || {});
            case "deleteSession":
                return this.transport.deleteSession(safeParams.sessionId);
            case "restartSystemSession":
                return this.transport.restartSystemSession(safeParams.agentIdOrSessionId, safeParams.options || {});
            case "setSessionModel":
                return this.transport.setSessionModel(safeParams.sessionId, safeParams.options || {});
            case "stopSessionTurn":
                return this.transport.stopSessionTurn(safeParams.sessionId, safeParams.options || {});
            case "deleteSessionGroup":
                return this.transport.deleteSessionGroup(safeParams.groupId);
            case "listModels":
                return this.transport.listModels();
            case "listArtifacts":
                return this.transport.listArtifacts(safeParams.sessionId);
            case "getArtifactMetadata":
                return this.transport.getArtifactMetadata(safeParams.sessionId, safeParams.filename);
            case "deleteArtifact":
                return this.transport.deleteArtifact(safeParams.sessionId, safeParams.filename);
            case "downloadArtifact":
                return this.transport.downloadArtifact(safeParams.sessionId, safeParams.filename);
            case "uploadArtifact":
                return this.transport.uploadArtifactContent(
                    safeParams.sessionId,
                    safeParams.filename,
                    safeParams.content,
                    safeParams.contentType,
                    safeParams.contentEncoding,
                );
            case "copyArtifact":
                return this.transport.copyArtifact(
                    safeParams.fromSessionId,
                    safeParams.fromFilename,
                    safeParams.toSessionId,
                    safeParams.toFilename,
                );
            case "setArtifactPinned":
                return this.transport.setArtifactPinned(safeParams.sessionId, safeParams.filename, safeParams.pinned);
            case "readArtifactBase64":
                return this.transport.readArtifactBase64(safeParams.sessionId, safeParams.filename, safeParams.maxBytes);
            case "exportExecutionHistory":
                return this.transport.exportExecutionHistory(safeParams.sessionId);
            case "getModelsByProvider":
                return this.transport.getModelsByProvider();
            case "getDefaultModel":
                return this.transport.getDefaultModel();
            case "getSessionEvents":
                return this.transport.getSessionEvents(safeParams.sessionId, safeParams.afterSeq, safeParams.limit, safeParams.eventTypes);
            case "getSessionEventsBefore":
                return this.transport.getSessionEventsBefore(safeParams.sessionId, safeParams.beforeSeq, safeParams.limit, safeParams.eventTypes);
            case "getTopEventEmitters":
                return this.transport.getTopEventEmitters(normalizeTopEventEmitterOptions(safeParams));
            case "getLogConfig":
                return this.transport.getLogConfig();
            case "getWorkerCount":
                return this.transport.getWorkerCount();
            default:
                throw new Error(`Unsupported portal RPC method: ${method}`);
        }
    }

    /**
     * Server-stamped message sender: identity from the validated auth
     * context, relation from the access snapshot. Never trusts
     * client-supplied identity fields; `origin` is client-declared display
     * metadata only.
     */
    _buildSender(authContext, snapshot, { isAdmin = false, origin } = {}) {
        const principal = normalizeSessionOwner(authContext);
        if (!principal) return undefined;
        const allowedOrigins = new Set(["portal", "tui", "mcp", "api"]);
        return {
            kind: "user",
            provider: principal.provider,
            subject: principal.subject,
            display: principal.displayName || principal.email || principal.subject,
            relation: relationFor(snapshot, { isAdmin }),
            origin: allowedOrigins.has(origin) ? origin : "api",
        };
    }

    async downloadArtifact(sessionId, filename, authContext = null) {
        await this.start();
        await this._gateBespokeRead("downloadArtifact", sessionId, authContext);
        return this.transport.downloadArtifact(sessionId, filename);
    }

    async getArtifactMetadata(sessionId, filename, authContext = null) {
        await this.start();
        await this._gateBespokeRead("getArtifactMetadata", sessionId, authContext);
        if (typeof this.transport.getArtifactMetadata !== "function") return null;
        return this.transport.getArtifactMetadata(sessionId, filename);
    }

    async downloadArtifactBinary(sessionId, filename, authContext = null) {
        await this.start();
        await this._gateBespokeRead("downloadArtifact", sessionId, authContext);
        if (typeof this.transport.downloadArtifactBinary === "function") {
            return this.transport.downloadArtifactBinary(sessionId, filename);
        }
        const content = await this.transport.downloadArtifact(sessionId, filename);
        return {
            filename,
            contentType: "text/plain",
            isBinary: false,
            sizeBytes: Buffer.byteLength(content, "utf8"),
            uploadedAt: new Date().toISOString(),
            source: "agent",
            body: Buffer.from(content, "utf8"),
        };
    }

    /** session:read gate for the bespoke (non-dispatched) artifact routes. */
    async _gateBespokeRead(action, sessionId, authContext) {
        const role = authContext?.authorization?.role;
        const isAdmin = role === "admin" || role === "anonymous";
        const owner = normalizeSessionOwner(authContext);
        await this._gateSession(action, "session:read", sessionId, authContext, { owner, isAdmin });
    }

    /**
     * WebSocket subscription gate (api/ws.js). Throws 403/404 when the
     * caller cannot read the session; audited like every other decision.
     */
    async authorizeSessionSubscribe(sessionId, authContext) {
        await this.start();
        await this._gateBespokeRead("subscribeSession", sessionId, authContext);
    }

    /** Log tail is fleet-wide observability: admin (or dark-launch). */
    async authorizeLogSubscribe(authContext) {
        const role = authContext?.authorization?.role;
        const isAdmin = role === "admin" || role === "anonymous";
        if (isAdmin) return;
        this._recordAudit({
            actor: this._auditActor(authContext),
            action: "subscribeLogs",
            decision: this.authz.enforce ? "deny" : "would_deny",
            reason: "log tail requires the admin role",
        });
        if (this.authz.enforce) {
            throw forbiddenError("The live log tail requires the admin role.");
        }
    }

    subscribeSession(sessionId, handler) {
        return this.transport.subscribeSession(sessionId, handler);
    }

    startLogTail(handler) {
        return this.transport.startLogTail(handler);
    }
}
