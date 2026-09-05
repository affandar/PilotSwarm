/**
 * Session Catalog (CMS) — provider-based session metadata store.
 *
 * The client writes to CMS before making duroxide calls (write-first).
 * CMS is the source of truth for session lifecycle.
 * Duroxide state is eventually consistent with CMS.
 *
 * @module
 */

import { randomUUID } from "crypto";
import { runCmsMigrations } from "./cms-migrator.js";
import { ProviderStore } from "./provider-store.js";
import type { SessionOwnerInfo, SessionSummaryState } from "./types.js";

// ─── Types ───────────────────────────────────────────────────────

/** A persisted session event (non-ephemeral). */
export interface SessionEvent {
    seq: number;
    sessionId: string;
    eventType: string;
    data: unknown;
    createdAt: Date;
    workerNodeId?: string;
}

/** One row from cms_get_top_event_emitters. */
export interface TopEventEmitterRow {
    workerNodeId: string;
    eventType: string;
    eventCount: number;
    sessionCount: number;
    firstSeenAt: Date | null;
    lastSeenAt: Date | null;
}

export interface InsertTurnMetricInput {
    sessionId: string;
    agentId: string | null;
    model: string | null;
    reasoningEffort: string | null;
    turnIndex: number;
    startedAt: Date;
    endedAt: Date;
    durationMs: number;
    tokensInput: number;
    tokensOutput: number;
    tokensCacheRead: number;
    tokensCacheWrite: number;
    toolCalls: number;
    toolErrors: number;
    resultType: string | null;
    errorMessage: string | null;
    workerNodeId: string | null;
}

export interface CompleteTurnWritebackInput extends InsertTurnMetricInput {
    toolNames?: string[];
    state: string;
    lastActiveAt: Date;
    lastError: string | null;
    waitReason: string | null;
    currentIteration: number;
}

export interface TurnMetricRow {
    id: number;
    sessionId: string;
    agentId: string | null;
    model: string | null;
    reasoningEffort: string | null;
    turnIndex: number;
    startedAt: Date;
    endedAt: Date;
    durationMs: number;
    tokensInput: number;
    tokensOutput: number;
    tokensCacheRead: number;
    tokensCacheWrite: number;
    toolCalls: number;
    toolErrors: number;
    resultType: string | null;
    errorMessage: string | null;
    workerNodeId: string | null;
    createdAt: Date;
}

export interface TokensByModelRow {
    /** Combined model:effort label (or provider/model when no effort). */
    model: string;
    turnCount: number;
    totalTokensInput: number;
    totalTokensOutput: number;
    totalTokensCacheRead: number;
    totalTokensCacheWrite: number;
}

export interface HourlyTokenBucketRow {
    hourBucket: Date;
    turnCount: number;
    totalTokensInput: number;
    totalTokensOutput: number;
    totalTokensCacheRead: number;
    totalTokensCacheWrite: number;
}

/** A row in the sessions table. */
export interface SessionRow {
    sessionId: string;
    orchestrationId: string | null;
    title: string | null;
    titleLocked: boolean;
    state: string;
    /** Session regeneration: which SDK-transcript incarnation is live. 0 = original. */
    transcriptEpoch: number;
    /** Epoch-ms of the last completed flip; null before any regeneration. */
    lastRegeneratedAt: number | null;
    model: string | null;
    reasoningEffort: string | null;
    contextTier: string | null;
    modelResolutionSource: string | null;
    createdAt: Date;
    updatedAt: Date;
    lastActiveAt: Date | null;
    deletedAt: Date | null;
    currentIteration: number;
    lastError: string | null;
    /** Live wait reason (e.g. "waiting for build"). Synced from runTurn activity. */
    waitReason: string | null;
    /**
     * In-flight turn index while a turn is running, else null. Written by the
     * runTurn activity's pre-turn writeback; cleared by the post-turn
     * writeback and by any state transition away from "running". Used by
     * stopSessionTurn() to address the turn-scoped stop queue.
     */
    activeTurnIndex: number | null;
    /** If this session is a sub-agent, the parent session's ID. */
    parentSessionId: string | null;
    /** Whether this is a system session (e.g. Sweeper Agent). */
    isSystem: boolean;
    /**
     * Service sessions (tree-scoped system sessions): machinery that serves
     * ONE session tree, e.g. "regen-distiller". Read-only to users, distinct
     * icon, parented under the served tree's root. null = ordinary session.
     */
    serviceKind: string | null;
    /** The session this service session serves (regen: the regenerating session). */
    serviceOf: string | null;
    /** Agent definition ID (e.g. "sweeper"). Links session to its agent config. */
    agentId: string | null;
    /** Splash banner (terminal markup) from the agent definition. */
    splash: string | null;
    /** Narrow-viewport splash variant, used when the main splash art is wider than the pane. */
    splashMobile: string | null;
    /**
     * The placement viewer's private group for this ROOT session, when the
     * read supplied a placement viewer. NULL on child rows and whenever no
     * placement viewer was passed. Surfaced to DTOs as `viewerGroupId`.
     */
    groupId: string | null;
    /** Short live summary for discovery/session lists. */
    shortSummary: string | null;
    /** Structured live summary state, application domain payload included. */
    summaryState: SessionSummaryState | null;
    /** Last time summaryState/shortSummary was updated. */
    summaryUpdatedAt: Date | null;
    /** Authenticated user associated with this session, if any. */
    owner: SessionOwnerInfo | null;
    /**
     * Sharing level of this row. Meaningful on ROOT sessions only — access
     * for a child always resolves through its root's visibility/shares.
     */
    visibility: SessionVisibility;
    /** Denormalized session-tree root (self for top-level sessions). */
    rootSessionId: string | null;
}

/** Sharing level of a session tree, set on the root row. */
export type SessionVisibility = "private" | "shared_read" | "shared_write";

/** A targeted per-user grant on a session tree. */
export interface SessionShareInfo {
    provider: string;
    subject: string;
    email: string | null;
    displayName: string | null;
    access: "read" | "write";
    grantedAt: Date;
    grantedByDisplay: string | null;
}

/**
 * One round-trip access snapshot for the enforcement predicate: the root's
 * system flag, visibility, owner, and the viewer's targeted share. Facts
 * only — combining them with the caller's role is the caller's concern.
 */
export interface SessionAccessSnapshot {
    rootSessionId: string;
    isSystem: boolean;
    visibility: SessionVisibility;
    owner: SessionOwnerInfo | null;
    viewerIsOwner: boolean;
    viewerShareAccess: "read" | "write" | null;
}

/** A directory entry for share autocomplete. */
export interface KnownUserInfo {
    provider: string;
    subject: string;
    email: string | null;
    displayName: string | null;
}

/** One authz audit record (denial, break-glass read, share change). */
export interface AuthzAuditEntry {
    auditId: number;
    occurredAt: Date;
    actorProvider: string | null;
    actorSubject: string | null;
    actorDisplay: string | null;
    action: string;
    sessionId: string | null;
    target: string | null;
    decision: string;
    reason: string | null;
    details: Record<string, unknown>;
}

/** Fields that can be updated on a session row. */
export interface SessionRowUpdates {
    orchestrationId?: string | null;
    title?: string | null;
    titleLocked?: boolean;
    state?: string;
    model?: string | null;
    reasoningEffort?: string | null;
    contextTier?: string | null;
    modelResolutionSource?: string | null;
    lastActiveAt?: Date;
    currentIteration?: number;
    lastError?: string | null;
    waitReason?: string | null;
    isSystem?: boolean;
    agentId?: string | null;
    splash?: string | null;
    splashMobile?: string | null;
}

/** Identity used to scope group placements (a user's private organization). */
export interface PlacementViewer {
    provider: string;
    subject: string;
    /** Treat every live session as readable (the runtime passes admin OR NOT enforce). */
    isAdmin?: boolean;
}

/** Per-root outcome of a placement request. */
export interface SessionPlacementResult {
    rootSessionId: string;
    placed: boolean;
    /** 'not_found' (unknown or unreadable — same shape) or 'system'. Null on success. */
    reason: string | null;
}

export interface SessionGroupRow {
    groupId: string;
    title: string;
    description: string | null;
    owner: SessionOwnerInfo | null;
    metadata: Record<string, unknown>;
    memberCount: number;
    runningCount: number;
    waitingCount: number;
    completedCount: number;
    failedCount: number;
    cancelledCount: number;
    latestActivityAt: Date | null;
    latestSummaryUpdatedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface ChildOutcomeRow {
    childSessionId: string;
    parentSessionId: string;
    contractJson: Record<string, unknown> | null;
    resultJson: Record<string, unknown> | null;
    verdict: string | null;
    summary: string | null;
    completedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

// ─── Session Metric Summary Types ────────────────────────────────

/** Per-session metric summary — one row per session, updated in place. */
export interface SessionMetricSummary {
    sessionId: string;
    agentId: string | null;
    model: string | null;
    reasoningEffort: string | null;
    parentSessionId: string | null;
    /** Compressed (stored) snapshot size in bytes. */
    snapshotSizeBytes: number;
    /** Uncompressed snapshot size in bytes; ratio = raw / snapshot. */
    rawSizeBytes: number;
    dehydrationCount: number;
    hydrationCount: number;
    lossyHandoffCount: number;
    lastDehydratedAt: number | null;
    lastHydratedAt: number | null;
    lastCheckpointAt: number | null;
    tokensInput: number;
    tokensOutput: number;
    tokensCacheRead: number;
    tokensCacheWrite: number;
    /** Cached-prompt hit ratio (0..1), null when tokensInput is 0. Derived. */
    cacheHitRatio: number | null;
    /** Session regeneration: completed flips (rollbacks included). */
    regenCount: number;
    /** Stats of the last completed regeneration (kind, stage timings, sizes). */
    lastRegenStats: Record<string, unknown> | null;
    deletedAt: number | null;
    createdAt: number;
    updatedAt: number;
}

/** Fields for atomic upsert — increments are additive, absolutes are set. */
export interface SessionMetricSummaryUpsert {
    snapshotSizeBytes?: number;
    rawSizeBytes?: number;
    dehydrationCountIncrement?: number;
    hydrationCountIncrement?: number;
    lossyHandoffCountIncrement?: number;
    lastDehydratedAt?: boolean;
    lastHydratedAt?: boolean;
    lastCheckpointAt?: boolean;
    tokensInputIncrement?: number;
    tokensOutputIncrement?: number;
    tokensCacheReadIncrement?: number;
    tokensCacheWriteIncrement?: number;
}

/** Per-session event-log aggregate (footprint events axis). */
export interface SessionEventStats {
    eventCount: number;
    dataBytes: number;
    maxSeq: number;
}

/** Per-session compaction counters derived from persisted SDK events. */
export interface SessionCompactionStats {
    starts: number;
    completes: number;
    failed: number;
    tokensRemoved: number;
    /** Epoch-ms of the newest start/complete — feeds the stuck-compaction timeout. */
    lastStartAtMs: number | null;
    lastCompleteAtMs: number | null;
}

/** Fleet-wide aggregate stats. */
export interface FleetStats {
    windowStart: number | null;
    earliestSessionCreatedAt: number | null;
    byAgent: Array<{
        agentId: string | null;
        model: string | null;
        sessionCount: number;
        turnCount: number;
        totalSnapshotSizeBytes: number;
        totalDehydrationCount: number;
        totalHydrationCount: number;
        totalLossyHandoffCount: number;
        totalTokensInput: number;
        totalTokensOutput: number;
        totalTokensCacheRead: number;
        totalTokensCacheWrite: number;
        /** Derived: cache_read / input. Null when input is 0. */
        cacheHitRatio: number | null;
    }>;
    totals: {
        sessionCount: number;
        totalSnapshotSizeBytes: number;
        totalRawSizeBytes: number;
        totalTokensInput: number;
        totalTokensOutput: number;
        totalTokensCacheRead: number;
        totalTokensCacheWrite: number;
        cacheHitRatio: number | null;
    };
}

export type UserStatsOwnerKind = "user" | "system" | "unowned";

export interface UserStatsModelBucket {
    model: string | null;
    sessionIds: string[];
    sessionCount: number;
    turnCount: number;
    totalSnapshotSizeBytes: number;
    totalOrchestrationHistorySizeBytes: number;
    totalDehydrationCount: number;
    totalHydrationCount: number;
    totalLossyHandoffCount: number;
    totalTokensInput: number;
    totalTokensOutput: number;
    totalTokensCacheRead: number;
    totalTokensCacheWrite: number;
    cacheHitRatio: number | null;
}

export interface UserStatsBucket {
    ownerKind: UserStatsOwnerKind;
    owner: SessionOwnerInfo | null;
    sessionIds: string[];
    sessionCount: number;
    totalSnapshotSizeBytes: number;
    totalOrchestrationHistorySizeBytes: number;
    totalTokensInput: number;
    totalTokensOutput: number;
    totalTokensCacheRead: number;
    totalTokensCacheWrite: number;
    cacheHitRatio: number | null;
    byModel: UserStatsModelBucket[];
}

export interface UserStats {
    windowStart: number | null;
    earliestSessionCreatedAt: number | null;
    users: UserStatsBucket[];
    totals: {
        sessionCount: number;
        totalSnapshotSizeBytes: number;
        totalOrchestrationHistorySizeBytes: number;
        totalTokensInput: number;
        totalTokensOutput: number;
        totalTokensCacheRead: number;
        totalTokensCacheWrite: number;
        cacheHitRatio: number | null;
    };
}

/**
 * Public user profile shape exposed through the management surface and
 * consumed by the Admin Console UI.
 *
 * `profileSettings` is an opaque application-owned JSON document (the
 * Admin Console + future client-state migrations decide its schema).
 *
 * `githubCopilotKeySet` is a presence flag; the raw key text is only
 * available through the worker-side resolver in `SessionCatalog`
 * to prevent accidental leakage through this management-facing type.
 */
export interface UserProfile {
    userId: number;
    provider: string;
    subject: string;
    email: string | null;
    displayName: string | null;
    profileSettings: Record<string, unknown>;
    githubCopilotKeySet: boolean;
    createdAt: Date | null;
    updatedAt: Date | null;
}

export interface UserPrincipal {
    provider: string;
    subject: string;
    email?: string | null;
    displayName?: string | null;
}

/**
 * The authorization role last OBSERVED for a principal, and when it was last
 * confirmed.
 *
 * `role` is a point-in-time observation, not a fact: the authority is the
 * identity provider, and this is the most recent thing it told the portal.
 * `seenAt` is therefore load-bearing — a reader that grants privilege on this
 * value must decide how stale an observation it will still believe.
 *
 * `null` role means "no privilege", and covers three distinct situations that
 * callers must not try to distinguish: never seen, seen with no role, and
 * seen with a role outside the known vocabulary.
 */
export type UserRoleValue = "admin" | "user" | "anonymous";

export interface UserRoleInfo {
    role: UserRoleValue | null;
    seenAt: Date | null;
}

/** Narrow unknown role text to the stored vocabulary. Anything else is no privilege. */
export function normalizeUserRole(value: unknown): UserRoleValue | null {
    const text = typeof value === "string" ? value.trim().toLowerCase() : "";
    return text === "admin" || text === "user" || text === "anonymous" ? text : null;
}

/**
 * The first-class "system" user. Platform-managed sessions carry
 * `owner: null` in the catalog; for credential resolution they act as this
 * principal, so an admin-stored GitHub Copilot key on the system user (Admin
 * Console → "Store as System key") is picked up by ownerless system sessions
 * through the exact same per-user key path as everyone else. The user row is
 * created lazily on first key set (`cms_set_user_github_copilot_key`
 * upserts via `cms_register_user`).
 */
export const SYSTEM_USER_PRINCIPAL: UserPrincipal = {
    provider: "system",
    subject: "system",
    email: null,
    displayName: "System",
};

/**
 * Resolve the owner a spawned sub-agent should inherit, by walking up the
 * session lineage from `startSessionId` (normally the spawning parent):
 *
 * - The nearest ancestor with an owner wins — a user-owned parent's children
 *   stay attributed to that user.
 * - A SYSTEM ancestor (ownerless by design) maps to the concrete SYSTEM user
 *   principal. The child is then a normal, deletable session whose owner is
 *   the System user — so it resolves the admin-stored System GitHub Copilot
 *   key through the ordinary per-owner credential path, WITHOUT being marked
 *   `is_system` itself (which would make it undeletable/unmanageable).
 * - An unresolvable lineage (missing rows, no owner, no system ancestor,
 *   depth exhausted) yields null: the child is created ownerless, exactly as
 *   before.
 *
 * Pure lineage logic — callers supply the row lookup so worker activities and
 * unit tests share one implementation.
 */
export async function resolveEffectiveSpawnOwner(
    getSession: (sessionId: string) => Promise<{
        owner?: SessionOwnerInfo | null;
        isSystem?: boolean;
        parentSessionId?: string | null;
    } | null | undefined>,
    startSessionId: string | null | undefined,
    maxDepth = 8,
): Promise<UserPrincipal | null> {
    let cursor: string | null | undefined = startSessionId;
    for (let depth = 0; depth < maxDepth && cursor; depth++) {
        let row: Awaited<ReturnType<typeof getSession>>;
        try {
            row = await getSession(cursor);
        } catch {
            return null;
        }
        if (!row) return null;
        const owner = row.owner;
        if (owner?.provider && owner?.subject) {
            return {
                provider: owner.provider,
                subject: owner.subject,
                email: owner.email ?? null,
                displayName: owner.displayName ?? null,
            };
        }
        if (row.isSystem) return { ...SYSTEM_USER_PRINCIPAL };
        cursor = row.parentSessionId ?? null;
    }
    return null;
}

/** Aggregate of a session and all its descendants. */
export interface SessionTreeStats {
    rootSessionId: string;
    self: SessionMetricSummary;
    tree: {
        sessionCount: number;
        totalTokensInput: number;
        totalTokensOutput: number;
        totalTokensCacheRead: number;
        totalTokensCacheWrite: number;
        /** Derived: cache_read / input across the tree. Null when input is 0. */
        cacheHitRatio: number | null;
        totalDehydrationCount: number;
        totalHydrationCount: number;
        totalLossyHandoffCount: number;
        totalSnapshotSizeBytes: number;
        totalRawSizeBytes: number;
    };
    /** Per-model breakdown across the tree, sorted by total input tokens. */
    byModel: Array<{
        model: string;
        sessionCount: number;
        turnCount: number;
        totalTokensInput: number;
        totalTokensOutput: number;
        totalTokensCacheRead: number;
        totalTokensCacheWrite: number;
        totalSnapshotSizeBytes: number;
        /** Derived per model. Null when input is 0. */
        cacheHitRatio: number | null;
    }>;
}

/**
 * Compute prompt-cache hit ratio with the inclusive token convention.
 * Returns a value in [0, 1] or null when tokensInput is 0 / negative / missing.
 * Defined once so per-session, tree, and fleet surfaces report identical values.
 */
export function computeCacheHitRatio(
    tokensInput: number | null | undefined,
    tokensCacheRead: number | null | undefined,
): number | null {
    const input = Number(tokensInput);
    const read = Number(tokensCacheRead);
    if (!Number.isFinite(input) || input <= 0) return null;
    if (!Number.isFinite(read) || read <= 0) return 0;
    const ratio = read / input;
    return Math.max(0, Math.min(1, ratio));
}

/** Discriminator: 'static' = SDK skill.invoked, 'learned' = read_facts on skills/. */
export type SkillKind = "static" | "learned";

/** One row of skill-usage aggregation for a single session. */
export interface SkillUsageRow {
    kind: SkillKind;
    /** Static: skill name. Learned: requested key or keyPattern (e.g. "skills/foo/%"). */
    name: string;
    pluginName: string | null;     // static skills only
    pluginVersion: string | null;  // static skills only
    invocations: number;
    firstUsedAt: Date;
    lastUsedAt: Date;
}

/** Skill usage rolled up across the spawn tree rooted at a session. */
export interface SessionTreeSkillUsage {
    rootSessionId: string;
    perSession: Array<{
        sessionId: string;
        agentId: string | null;
        skills: SkillUsageRow[];
    }>;
    rolledUp: SkillUsageRow[];
    totalInvocations: number;
}

/** One row of skill-usage aggregation across the fleet, by agent. */
export interface FleetSkillUsageRow extends SkillUsageRow {
    agentId: string | null;
    sessionCount: number;
}

/** Fleet-wide skill usage. */
export interface FleetSkillUsage {
    windowStart: number | null;
    rows: FleetSkillUsageRow[];
}

export type RetrievalSurface = "facts" | "skills" | "graph";
export type RetrievalOperation =
    | "facts_search"
    | "facts_similar"
    | "search_skills"
    | "graph_search_nodes"
    | "graph_search_edges"
    | "graph_neighbourhood";

export interface RetrievalUsageRow {
    surface: RetrievalSurface;
    operation: RetrievalOperation;
    namespace: string | null;
    calls: number;
    totalResults: number;
    avgResults: number;
    totalDurationMs: number | null;
    avgDurationMs: number | null;
    firstUsedAt: Date;
    lastUsedAt: Date;
}

export interface SessionTreeRetrievalUsage {
    rootSessionId: string;
    perSession: Array<{
        sessionId: string;
        agentId: string | null;
        rows: RetrievalUsageRow[];
    }>;
    rolledUp: RetrievalUsageRow[];
    totalCalls: number;
}

export interface FleetRetrievalUsageRow extends RetrievalUsageRow {
    agentId: string | null;
    sessionCount: number;
}

export interface FleetRetrievalUsage {
    windowStart: number | null;
    rows: FleetRetrievalUsageRow[];
}

export type GraphNodeUsageKind = "searched" | "loaded";

export interface GraphNodeUsageRow {
    nodeKey: string;
    namespace: string | null;
    operation: RetrievalOperation;
    kind: GraphNodeUsageKind;
    count: number;
    firstSeenAt: Date;
    lastSeenAt: Date;
}

export interface FleetGraphNodeUsageRow extends GraphNodeUsageRow {
    agentId: string | null;
    sessionCount: number;
}

export interface FleetGraphNodeUsage {
    windowStart: number | null;
    rows: FleetGraphNodeUsageRow[];
}

export interface GraphEdgeSearchUsageRow {
    predicateKey: string | null;
    fromKey: string | null;
    toKey: string | null;
    namespace: string | null;
    calls: number;
    totalResults: number;
    firstSearchedAt: Date;
    lastSearchedAt: Date;
}

// ─── Provider Interface ──────────────────────────────────────────

/**
 * SessionCatalog — abstraction over the CMS backing store.
 *
 * Initial implementation: PostgreSQL.
 * Future: CosmosDB, etc.
 */
// ─── Agent packages (migration 0038) ─────────────────────────────

export type AgentPackageScope = "shared" | "user";

/**
 * WHICH copy of a package name an operation means.
 *
 * Package identity is `(scope, owner, name)` (migration 0043), so a bare name
 * is ambiguous the moment a user takes a personal copy of a shared package.
 *
 * `null` / omitted is not "any" — it is **resolve**: the actor's own copy if
 * they have one, otherwise the shared copy. That is the same rule agent
 * binding uses, so "show me X", "edit X" and "run X" always mean the same
 * package.
 *
 * A selector says which copy is MEANT. It never says which copy may be SEEN —
 * visibility is re-applied against the resolved row, so naming someone else's
 * owner triple cannot be used to read their private package.
 */
export interface AgentPackageSelector {
    scope?: AgentPackageScope | null;
    owner?: AgentPrincipal | null;
}

/** Flatten a selector into the three positional proc arguments. */
function selectorArgs(selector?: AgentPackageSelector | null): [string | null, string | null, string | null] {
    return [
        selector?.scope ?? null,
        selector?.owner?.provider ?? null,
        selector?.owner?.subject ?? null,
    ];
}

/** Principal pair — the same identity primitive session procs use. */
export interface AgentPrincipal {
    provider: string;
    subject: string;
    /** Populated on READ via the users join (migration 0041); optional on write. */
    email?: string | null;
    /** Populated on READ via the users join (migration 0041); optional on write. */
    displayName?: string | null;
}

export interface AgentSourceRow {
    sourceId: string;
    kind: "github" | "ado" | "url" | "upload";
    scope: AgentPackageScope;
    repoUrl: string | null;
    ref: string | null;
    path: string | null;
    url: string | null;
    authTokenSet: boolean;
    autoSync: boolean;
    lastSyncAt: Date | null;
    lastSyncStatus: string | null;
    lastSyncError: string | null;
    lastCommitSha: string | null;
    owner: AgentPrincipal | null;
    createdBy: string | null;
    createdAt: Date;
}

export interface AgentPackageVersionRow {
    versionId: string;
    semver: string;
    sha256: string;
    sizeBytes: number;
    artifactFilename: string;
    commitSha: string | null;
    manifest: Record<string, unknown>;
    createdAt: Date;
    createdBy: string | null;
}

export interface AgentPackageSummary {
    packageId: string;
    sourceId: string | null;
    name: string;
    scope: AgentPackageScope;
    owner: AgentPrincipal | null;
    enabled: boolean;
    createdBy: string | null;
    createdAt: Date;
    /**
     * This SHARED package is currently overridden for the viewer by their own
     * enabled copy of the same name. The distinction between "you have two
     * packages" and "you have one package with a fallback" is worth showing.
     */
    shadowed: boolean;
    /**
     * The viewer may change this package's contents and rollout: admin,
     * owner, or a granted editor. Scope changes, delete and the editor list
     * stay with the owner/admin — see `owner` for that.
     */
    canEdit: boolean;
    /** Active version join; null only for a package with no versions (shouldn't happen). */
    active: AgentPackageVersionRow | null;
}

export interface AgentPackageEditorInfo {
    provider: string;
    subject: string;
    email: string | null;
    displayName: string | null;
    grantedAt: Date;
    grantedByDisplay: string | null;
}

export interface AgentPackageDetail extends Omit<AgentPackageSummary, "active"> {
    activeVersionId: string | null;
    /** Full version history, newest first. */
    versions: AgentPackageVersionRow[];
    /** Granted editors. Always empty for a user-scope copy. */
    editors: AgentPackageEditorInfo[];
}

export interface AgentPackageInstallEntry {
    /**
     * Stable per-row identity. With per-user namespaces two packages can share
     * a `name`, so the installer keys its cache directories off this rather
     * than off the name — otherwise Alice's `triager` and Bob's `triager`
     * would fight over the same directory.
     */
    packageId: string;
    name: string;
    scope: AgentPackageScope;
    owner: AgentPrincipal | null;
    semver: string;
    sha256: string;
    sizeBytes: number;
    artifactFilename: string;
    manifest: Record<string, unknown>;
}

export interface AgentWorkerStateRow {
    workerNodeId: string;
    epoch: number;
    installed: Record<string, unknown>;
    updatedAt: Date;
}

export interface PublishAgentPackageInput {
    name: string;
    scope: AgentPackageScope;
    owner: AgentPrincipal | null;
    sourceId: string | null;
    semver: string;
    sha256: string;
    sizeBytes: number;
    artifactFilename: string;
    commitSha: string | null;
    manifest: Record<string, unknown>;
    createdBy: string | null;
    isAdmin: boolean;
}

export interface PublishAgentPackageResult {
    status: "published" | "noop";
    packageId: string;
    versionId: string;
}

// ─── Worker registry (migration 0040) ────────────────────────────

export type WorkerPhase = "starting" | "ready" | "draining";

export interface WorkerRow {
    workerNodeId: string;
    pool: string;
    phase: WorkerPhase;
    owner: AgentPrincipal | null;
    registeredAt: Date;
    updatedAt: Date;
    info: Record<string, unknown>;
    health: Record<string, unknown>;
    state: Record<string, unknown>;
}

export interface WorkerHeartbeatInput {
    workerNodeId: string;
    pool?: string | null;
    phase?: WorkerPhase;
    owner?: AgentPrincipal | null;
    info?: Record<string, unknown>;
    health?: Record<string, unknown>;
    state?: Record<string, unknown>;
}

/** Effective (merged) directive returned to a worker by the heartbeat. */
export interface EffectiveDirective {
    domain: string;
    /** SUM of contributing rows' epochs — changes on any contributing bump. */
    epoch: number;
    actuation: "worker" | "external";
    desired: Record<string, unknown>;
}

export interface FleetDirectiveRow {
    domain: string;
    pool: string;
    workerNodeId: string;
    epoch: number;
    actuation: "worker" | "external";
    desired: Record<string, unknown>;
    updatedAt: Date;
    updatedBy: string | null;
}

export interface SessionCatalog {
    /**
     * Provider budgets (migrations 0049-0051). Optional, like every other
     * late feature here, so a duck-typed test double need not implement it.
     * See provider-store.ts.
     */
    readonly providers?: ProviderStore;

    /** Per-slot canvas cache (migration 0045); optional so test doubles need not implement it. */
    upsertSessionCanvas?(sessionId: string, slot: number, name: string | null, latestRev: number, sizeBytes: number | null): Promise<void>;
    getSessionCanvases?(sessionId: string): Promise<Array<{ slot: number; name: string; latestRev: number; sizeBytes: number | null; updatedAt: string }>>;
    listSessionCanvasesFor?(sessionIds: string[]): Promise<Map<string, Array<{ slot: number; name: string; latestRev: number; sizeBytes: number | null }>>>;

    /**
     * The canvas data plane (migration 0047): one UNLOGGED last-value row per
     * (session, slot), written on every tick and draw, NOTIFY on write. All
     * optional — absent on catalogs that predate the plane, and the bridge
     * degrades to the durable-event path when the probe says so.
     */
    canvasLiveAvailable?(): Promise<boolean>;
    /** Atomic next-rev mint on the 0045 cache row; seedRev floors legacy sessions. Multi-writer safe. */
    mintCanvasRev?(sessionId: string, slot: number, seedRev: number): Promise<number>;
    /**
     * A data tick. Exactly one of input.data (replace wholesale) or
     * input.patch (RFC 7386 merge into the LOCKED current row — concurrent
     * patches compose). Refused, nothing written, when the resulting payload
     * would exceed maxBytes. Returns the DB's seq and the MERGED payload —
     * the dual-write legacy event carries that merged state so old readers
     * stay whole.
     */
    upsertCanvasLiveTick?(sessionId: string, slot: number, input: { data?: Record<string, unknown>; patch?: Record<string, unknown> }, updatedBy: string, maxBytes?: number): Promise<{ seq: number; sizeBytes: number; payload: Record<string, unknown> } | { refused: true; currentSizeBytes: number | null }>;
    /** A document pointer after a draw. RESETS payload to {} — the new page starts from its own initial state. */
    upsertCanvasLiveDoc?(sessionId: string, slot: number, doc: { rev: number; sha: string }, updatedBy: string): Promise<{ seq: number } | null>;
    getCanvasLive?(sessionId: string): Promise<Array<{ slot: number; seq: number; docRev: number; docSha: string; payload: Record<string, unknown>; updatedBy: string; updatedAt: string }>>;

    /** Generic ephemeral last-value plane (migration 0073). */
    liveAvailable?(): Promise<boolean>;
    publishLive?(
        sessionId: string,
        topic: string,
        input: { patch: Record<string, unknown> } | { snapshot: Record<string, unknown> } | { signal: true },
        updatedBy: string,
        maxBytes?: number,
    ): Promise<{ seq: number; sizeBytes: number; payload: Record<string, unknown> } | { signal: true } | { refused: true; currentSizeBytes: number | null } | null>;
    getLive?(sessionId: string, topics?: string[]): Promise<Array<{ topic: string; seq: number; payload: Record<string, unknown>; updatedBy: string; updatedAt: string }>>;

    /**
     * Canvas share links (migration 0048): one live view token per
     * (session, slot), stored as a HASH. The raw token never touches the
     * database. All optional; absent on older catalogs.
     */
    getCanvasShareLinkInfo?(sessionId: string, slot: number): Promise<{ exists: boolean; createdAt?: string; createdBy?: string }>;
    /** Create-or-rotate: the previous token (if any) stops validating the moment this row lands. */
    setCanvasShareLink?(sessionId: string, slot: number, tokenHash: string, createdBy: string): Promise<void>;
    removeCanvasShareLink?(sessionId: string, slot: number): Promise<boolean>;
    /** The token door: hash lookup → which canvas this token views, or null. */
    resolveCanvasShareToken?(tokenHash: string): Promise<{ sessionId: string; slot: number } | null>;

    /**
     * The canvas KV store (migration 0064): per-key shared state for canvas
     * apps, plus the per-canvas write policy. All optional; absent on older
     * catalogs, and the doors answer "unavailable" when so. The rules live in
     * canvas-kv.ts — these are the raw rows.
     */
    getCanvasKvSettings?(sessionId: string, slot: number): Promise<{ kvAccess: "owner" | "readers" | "link"; kvManifest: unknown; latestRev: number } | null>;
    setCanvasKvAccess?(sessionId: string, slot: number, access: "owner" | "readers" | "link"): Promise<void>;
    setCanvasKvManifest?(sessionId: string, slot: number, manifest: unknown | null): Promise<void>;
    canvasKvGet?(sessionId: string, slot: number, key: string): Promise<{ key: string; value: any; rev: number; updatedAt: string } | null>;
    canvasKvList?(sessionId: string, slot: number, prefix: string | null, limit: number, afterKey: string | null): Promise<Array<{ key: string; value: any; rev: number; updatedAt: string }>>;
    canvasKvWrite?(sessionId: string, slot: number, key: string, value: unknown | null, ifMatch: number | null, limits: { maxKeys: number; maxBytes: number; maxValueBytes: number }): Promise<{ status: string; rev: number; sizeBytes: number | null }>;
    canvasKvStats?(sessionId: string, slot: number): Promise<{ keys: number; bytes: number }>;

    /** Create schema and tables if they don't exist. */
    initialize(): Promise<void>;

    // ── Worker registry (migration 0040) ─────────────────────

    /**
     * The one round-trip: upsert this worker's row (info/owner insert-only;
     * pool/phase/health/state every beat), prune hour-silent rows, and
     * return the effective directive set (fleet/pool/worker shallow-merge,
     * epoch = SUM of contributing rows).
     */
    workerHeartbeat(input: WorkerHeartbeatInput): Promise<EffectiveDirective[]>;
    listWorkers(): Promise<WorkerRow[]>;
    /**
     * Upsert-and-bump a directive row. pool/workerNodeId default '*';
     * worker-scoped rows must use pool '*' (canonical form); desired null
     * keeps the existing payload (doorbell bump). Returns the row's epoch.
     */
    fleetDirectiveBump(domain: string, opts?: {
        pool?: string | null;
        workerNodeId?: string | null;
        desired?: Record<string, unknown> | null;
        actuation?: "worker" | "external";
        updatedBy?: string | null;
    }): Promise<number>;
    getFleetDirectives(): Promise<FleetDirectiveRow[]>;

    // ── Agent packages (migration 0038) ──────────────────────

    /** Current registry epoch — workers poll this single-row read. */
    agentRegistryEpoch(): Promise<number>;
    registerAgentSource(source: {
        sourceId: string;
        kind: "github" | "ado" | "url" | "upload";
        scope: AgentPackageScope;
        repoUrl?: string | null;
        ref?: string | null;
        path?: string | null;
        url?: string | null;
        authToken?: string | null;
        autoSync?: boolean;
        owner: AgentPrincipal | null;
        createdBy?: string | null;
    }): Promise<void>;
    listAgentSources(viewer: AgentPrincipal | null, isAdmin: boolean): Promise<AgentSourceRow[]>;
    getAgentSource(sourceId: string): Promise<AgentSourceRow | null>;
    /** Internal-only raw token read for sync fetchers. Never expose via management APIs. */
    getAgentSourceToken(sourceId: string): Promise<string | null>;
    updateAgentSourceSync(sourceId: string, status: string, error: string | null, commitSha: string | null): Promise<void>;
    deleteAgentSource(sourceId: string, actor: AgentPrincipal | null, isAdmin: boolean): Promise<void>;

    /** Atomic publish — see cms_publish_agent_package. Throws AGENT_PACKAGE_* errors. */
    publishAgentPackage(input: PublishAgentPackageInput): Promise<PublishAgentPackageResult>;
    listAgentPackages(viewer: AgentPrincipal | null, isAdmin: boolean): Promise<AgentPackageSummary[]>;
    /**
     * One package. `selector` picks WHICH copy of the name (own / shared /
     * a named owner's); omitted means resolve own-then-shared, the same rule
     * agent binding follows. See {@link AgentPackageSelector}.
     */
    getAgentPackage(name: string, viewer: AgentPrincipal | null, isAdmin: boolean, selector?: AgentPackageSelector | null): Promise<AgentPackageDetail | null>;
    /** Worker-facing install manifest: every enabled package's active version. */
    getAgentPackagesInstallManifest(): Promise<AgentPackageInstallEntry[]>;
    /**
     * Which copy of a package name this viewer gets, as a package id.
     * `requireEnabled` defaults to true: a disabled personal copy falls
     * through to shared, which is the recovery path.
     */
    resolveAgentPackageId(
        name: string,
        viewer: AgentPrincipal | null,
        selector?: AgentPackageSelector | null,
        opts?: { requireEnabled?: boolean },
    ): Promise<string | null>;
    setAgentPackageScope(name: string, scope: AgentPackageScope, actor: AgentPrincipal | null, isAdmin: boolean, selector?: AgentPackageSelector | null): Promise<void>;
    setAgentPackageEnabled(name: string, enabled: boolean, actor: AgentPrincipal | null, isAdmin: boolean, selector?: AgentPackageSelector | null): Promise<void>;
    pinAgentPackageVersion(name: string, semver: string, actor: AgentPrincipal | null, isAdmin: boolean, selector?: AgentPackageSelector | null): Promise<void>;
    /** Returns artifact filenames of deleted versions for post-commit artifact cleanup. */
    deleteAgentPackage(name: string, actor: AgentPrincipal | null, isAdmin: boolean, selector?: AgentPackageSelector | null): Promise<string[]>;
    /**
     * Editors: write access on a SHARED package for named users (publish,
     * republish into it, pin, enable/disable — never scope, delete, or the
     * editor list). Grant/revoke are owner-or-admin. Demoting the package to
     * user scope deletes every grant.
     */
    isAgentPackageEditor(packageId: string, principal: AgentPrincipal | null): Promise<boolean>;
    grantAgentPackageEditor(name: string, grantee: AgentPrincipal, actor: AgentPrincipal | null, isAdmin: boolean): Promise<void>;
    revokeAgentPackageEditor(name: string, grantee: AgentPrincipal, actor: AgentPrincipal | null, isAdmin: boolean): Promise<void>;
    /** Editors of the shared copy of `name`. Visible to anyone who can see the package. */
    listAgentPackageEditors(name: string): Promise<AgentPackageEditorInfo[]>;
    /** How many published versions reference this content-addressed blob (>0 ⇒ never delete it). */
    countAgentPackageArtifactRefs(artifactFilename: string): Promise<number>;

    upsertAgentWorkerState(workerNodeId: string, epoch: number, installed: Record<string, unknown>): Promise<void>;
    listAgentWorkerState(): Promise<AgentWorkerStateRow[]>;

    // ── Writes (called from client, before duroxide calls) ───

    /** Insert a new session. No-op if session already exists. */
    createSession(sessionId: string, opts?: {
        model?: string;
        reasoningEffort?: string;
        contextTier?: string | null;
        modelResolutionSource?: string;
        parentSessionId?: string;
        isSystem?: boolean;
        agentId?: string;
        splash?: string;
        splashMobile?: string;
        groupId?: string | null;
        owner?: SessionOwnerInfo | null;
        /** Sharing level for a new ROOT session; children resolve through their root. */
        visibility?: SessionVisibility | null;
        /** Service sessions (tree-scoped machinery, migration 0037). */
        serviceKind?: string | null;
        serviceOf?: string | null;
        /** Durable creation config (migration 0072); see getSessionCreationConfig. */
        creationConfig?: Record<string, unknown> | null;
    }): Promise<void>;

    /**
     * The session's durable creation config (migration 0072), or null.
     * Optional: stores that predate it simply leave the start path on the
     * in-memory map plus the worker-side bound-agent backfill.
     */
    getSessionCreationConfig?(sessionId: string): Promise<Record<string, unknown> | null>;

    /** Stamp a session as a service session post-create (migration 0037). */
    markSessionService(sessionId: string, serviceKind: string, serviceOf: string | null): Promise<void>;

    /** Update one or more fields on an existing session. */
    updateSession(sessionId: string, updates: SessionRowUpdates): Promise<void>;
    /** Publish the in-flight turn index (stop-turn targeting). */
    setActiveTurnIndex(sessionId: string, turnIndex: number): Promise<void>;

    /** Soft-delete a session (set deleted_at). */
    softDeleteSession(sessionId: string): Promise<void>;

    /** Privileged archive/reset for deterministic system-session restart. */
    archiveSystemSessionForRestart(sessionId: string, state: "completed" | "cancelled" | "failed", lastError?: string | null): Promise<void>;

    // ── Reads (called from client) ───────────────────────────

    /** List all non-deleted sessions, newest first. */
    listSessions(placement?: { provider: string; subject: string } | null): Promise<SessionRow[]>;

    /** List one bounded page of sessions, newest first. */
    listSessionsPage(opts?: {
        limit?: number;
        cursorUpdatedAt?: Date | null;
        cursorSessionId?: string | null;
        includeDeleted?: boolean;
        /** When set, restrict rows to what this principal can read (viewer-scoped listing). */
        viewer?: { provider: string; subject: string; systemVisible?: boolean } | null;
        /** When set, root rows carry this principal's private group placement as groupId. */
        placement?: { provider: string; subject: string } | null;
    }): Promise<SessionRow[]>;

    /** List sessions visible to a principal (non-paged viewer-scoped listing). */
    listSessionsVisible(
        viewer: { provider: string; subject: string; systemVisible?: boolean },
        placement?: { provider: string; subject: string } | null,
    ): Promise<SessionRow[]>;

    /** Member directory (for share autocomplete); excludes synthetic principals. */
    listKnownUsers(opts?: { limit?: number }): Promise<KnownUserInfo[]>;

    /** Get a single session by ID (null if not found or deleted). */
    getSession(sessionId: string, placement?: { provider: string; subject: string } | null): Promise<SessionRow | null>;

    // ── Visibility / sharing / audit (security model) ─────────

    /** Set the sharing level on the ROOT of the given session's tree. */
    setSessionVisibility(sessionId: string, visibility: SessionVisibility): Promise<void>;

    /** Grant (or update) a targeted share on the session's tree root. */
    grantSessionShare(sessionId: string, grantee: SessionOwnerInfo, access: "read" | "write", grantedBy?: SessionOwnerInfo | null): Promise<void>;

    /** Revoke a targeted share on the session's tree root. */
    revokeSessionShare(sessionId: string, grantee: { provider: string; subject: string }): Promise<void>;

    /** List targeted shares on the session's tree root. */
    listSessionShares(sessionId: string): Promise<SessionShareInfo[]>;

    /** Access snapshot for the enforcement predicate (null = missing/deleted session). */
    getSessionAccess(sessionId: string, viewer: { provider: string; subject: string }): Promise<SessionAccessSnapshot | null>;
    filterVisibleSessionIds(sessionIds: string[], viewer: { provider: string; subject: string }, systemVisible: boolean): Promise<string[]>;

    /** Append one authz audit record. */
    recordAuthzAudit(entry: {
        actor?: { provider?: string | null; subject?: string | null; display?: string | null } | null;
        action: string;
        sessionId?: string | null;
        target?: string | null;
        decision: string;
        reason?: string | null;
        details?: Record<string, unknown> | null;
    }): Promise<void>;

    /** Read authz audit records, newest first (optionally scoped to one session). */
    listAuthzAudit(opts?: { limit?: number; sessionId?: string | null }): Promise<AuthzAuditEntry[]>;

    /** Get all descendant session IDs (children, grandchildren, etc.) of a given session. */
    getDescendantSessionIds(sessionId: string): Promise<string[]>;

    /** Get the most recently active session ID. */
    getLastSessionId(): Promise<string | null>;

    /** Persist a structured live session summary. */
    updateSessionSummary(sessionId: string, summaryState: SessionSummaryState, shortSummary?: string | null): Promise<void>;

    /** Create a visual session group. */
    createSessionGroup(input: { groupId: string; title: string; description?: string | null; owner?: SessionOwnerInfo | null; metadata?: Record<string, unknown> }): Promise<void>;

    /** Update title/description/owner/metadata for a session group. */
    updateSessionGroup(groupId: string, patch: { title?: string; description?: string | null; owner?: SessionOwnerInfo | null; metadataPatch?: Record<string, unknown> }): Promise<void>;

    /**
     * List session groups with aggregate member status. With a viewer, only
     * that viewer's OWN groups with placement-scoped counts; without one,
     * the unscoped legacy listing (audit path, counts frozen at 0034).
     */
    listSessionGroups(viewer?: PlacementViewer | null): Promise<SessionGroupRow[]>;

    /** List non-deleted sessions whose root the placement viewer placed in the group. */
    listGroupSessions(groupId: string, placement?: { provider: string; subject: string } | null): Promise<SessionRow[]>;

    /** Delete a session group (placements cascade; sessions untouched). Returns false when missing. */
    deleteSessionGroup(groupId: string): Promise<boolean>;

    /**
     * Upsert (or delete, when groupId is null) the viewer's private placement
     * for each distinct resolved live root. The target group must be owned by
     * the viewer (throws otherwise). Never touches shared session data.
     */
    placeSessionsInGroup(viewer: PlacementViewer, sessionIds: string[], groupId: string | null): Promise<SessionPlacementResult[]>;

    /** Upsert current child contract/result outcome state. */
    upsertChildOutcome(input: {
        childSessionId: string;
        parentSessionId: string;
        contractJson?: Record<string, unknown> | null;
        resultJson?: Record<string, unknown> | null;
        verdict?: string | null;
        summary?: string | null;
        completedAt?: Date | null;
    }): Promise<void>;

    /** Get a child outcome record by child session id. */
    getChildOutcome(childSessionId: string): Promise<ChildOutcomeRow | null>;

    /** List child outcome records for a parent session. */
    listChildOutcomes(parentSessionId: string): Promise<ChildOutcomeRow[]>;

    // ── Events (written from worker, read from client) ───────

    /** Record a batch of events for a session. */
    recordEvents(sessionId: string, events: { eventType: string; data: unknown }[], workerNodeId?: string): Promise<void>;

    /**
     * Get a provider-capped page of events for a session, ordered ascending by seq.
     * Without afterSeq this returns the latest page; with afterSeq it returns the next forward page.
     * Use getSessionEventsBefore() paging to drain complete history.
     */
    getSessionEvents(sessionId: string, afterSeq?: number, limit?: number, eventTypes?: string[]): Promise<SessionEvent[]>;

    /**
     * Get a provider-capped older page before a sequence number, ordered ascending by seq.
     * Call repeatedly with the oldest returned seq to drain complete history.
     */
    getSessionEventsBefore(sessionId: string, beforeSeq: number, limit?: number, eventTypes?: string[]): Promise<SessionEvent[]>;

    /** Get the highest-volume event emitters since a point in time. */
    getTopEventEmitters(since: Date, limit?: number): Promise<TopEventEmitterRow[]>;

    /** Insert one per-turn metrics row. */
    insertTurnMetric(input: InsertTurnMetricInput): Promise<void>;

    /** Complete one turn's CMS writeback atomically. */
    completeTurnWriteback(input: CompleteTurnWritebackInput): Promise<void>;

    /** Get bounded per-session turn metrics, newest-first. */
    getSessionTurnMetrics(sessionId: string, opts?: { since?: Date; limit?: number }): Promise<TurnMetricRow[]>;

    /** Get per-session token totals grouped by model:effort, with per-bucket turn count. */
    getSessionTokensByModel(sessionId: string): Promise<TokensByModelRow[]>;

    /** Aggregate hourly token buckets from session turn metrics. */
    getHourlyTokenBuckets(since: Date, opts?: { agentId?: string; model?: string }): Promise<HourlyTokenBucketRow[]>;

    /** Delete turn metrics older than a cutoff and return deleted row count. */
    pruneTurnMetrics(olderThan: Date): Promise<number>;

    // ── Session Metric Summaries ──────────────────────────────

    /** Get the metric summary for a single session. */
    getSessionMetricSummary(sessionId: string): Promise<SessionMetricSummary | null>;

    /** Per-session event count/bytes/max-seq aggregate (footprint). Always session-scoped. */
    getSessionEventStats(sessionId: string, afterSeq?: number): Promise<SessionEventStats>;

    /** Per-session compaction counters from persisted SDK events (footprint). */
    getSessionCompactionStats(sessionId: string, afterSeq?: number): Promise<SessionCompactionStats>;

    /**
     * Session regeneration boundary transaction: session.epoch_committed
     * event + sessions.transcript_epoch + regen_count, atomically and
     * idempotently (attempt-keyed). Returns the boundary event's seq.
     */
    recordEpochCommitted(sessionId: string, payload: Record<string, unknown>): Promise<number>;

    /** Proven rebirth: session.regenerated event + last_regen_stats (attempt-idempotent). */
    recordRegenerated(sessionId: string, payload: Record<string, unknown>): Promise<number>;

    /** Get a session's own stats plus rolled-up totals of all descendants. */
    getSessionTreeStats(sessionId: string): Promise<SessionTreeStats | null>;

    /** Get fleet-wide aggregate stats, optionally filtered. */
    getFleetStats(opts?: { includeDeleted?: boolean; since?: Date }): Promise<FleetStats>;

    /** Get user/session-owner aggregate stats, optionally filtered. */
    getUserStats(opts?: { includeDeleted?: boolean; since?: Date }): Promise<UserStats>;

    // ── User Profiles (settings + per-user GitHub Copilot key) ──

    /**
     * Read the public user profile (settings + key-set flag). Returns
     * `null` when the principal has not been registered yet.
     *
     * Never returns the raw key text; callers wanting the key must use
     * `getUserGitHubCopilotKey` so leakage stays auditable.
     */
    getUserProfile(principal: UserPrincipal): Promise<UserProfile | null>;

    /**
     * Internal: fetch the raw GitHub Copilot key for a user. Used by the
     * worker's per-user token resolver. Returns `null` when no override
     * is set or the user is unknown.
     */
    getUserGitHubCopilotKey(principal: UserPrincipal): Promise<string | null>;

    /**
     * Replace the user's `profile_settings` JSON document. Creates the
     * user row lazily if needed so settings can be saved before the
     * principal owns any sessions.
     */
    setUserProfileSettings(principal: UserPrincipal, settings: Record<string, unknown>): Promise<UserProfile>;

    /**
     * Set or clear the per-user GitHub Copilot key. Pass `null` to
     * remove the override (which reverts the user to the worker's
     * env-supplied default).
     */
    setUserGitHubCopilotKey(principal: UserPrincipal, key: string | null): Promise<UserProfile>;

    /**
     * Read the last-observed authorization role for a principal.
     *
     * Returns `{ role: null }` for an unknown principal, which callers must
     * treat exactly like a stored `null` — no privilege.
     */
    getUserRole(principal: UserPrincipal): Promise<UserRoleInfo>;

    /**
     * Record the authorization role observed for a principal, replacing any
     * previous value and refreshing `seenAt`.
     *
     * Called by the portal on authenticated requests. It is NOT reachable
     * through the Web API: a caller able to write its own role would hold a
     * privilege-escalation primitive.
     */
    setUserRole(principal: UserPrincipal, role: string | null): Promise<UserRoleValue | null>;

    /** Get skill usage (skill.invoked event aggregation) for a single session. */
    getSessionSkillUsage(sessionId: string, opts?: { since?: Date }): Promise<SkillUsageRow[]>;

    /** Get skill usage rolled across the spawn tree rooted at the given session. */
    getSessionTreeSkillUsage(sessionId: string, opts?: { since?: Date }): Promise<SessionTreeSkillUsage>;

    /** Get fleet-wide skill usage broken down by agent. Tuner / management surface. */
    getFleetSkillUsage(opts?: { since?: Date; includeDeleted?: boolean }): Promise<FleetSkillUsage>;

    /** Get per-session retrieval usage counts from durable retrieval events. */
    getSessionRetrievalUsage(sessionId: string, opts?: { since?: Date }): Promise<RetrievalUsageRow[]>;

    /** Get retrieval usage rolled up across the spawn tree rooted at the given session. */
    getSessionTreeRetrievalUsage(sessionId: string, opts?: { since?: Date }): Promise<SessionTreeRetrievalUsage>;

    /** Get fleet-wide retrieval usage broken down by agent. */
    getFleetRetrievalUsage(opts?: { since?: Date; includeDeleted?: boolean }): Promise<FleetRetrievalUsage>;

    /** Get exact graph node-key search/load usage for one session. */
    getSessionGraphNodeUsage(sessionId: string, opts?: { since?: Date; limit?: number; nodeKeyLike?: string; kind?: GraphNodeUsageKind }): Promise<GraphNodeUsageRow[]>;

    /** Get exact graph node-key search/load usage across the fleet. */
    getFleetGraphNodeUsage(opts?: { since?: Date; includeDeleted?: boolean; limit?: number; nodeKeyLike?: string; kind?: GraphNodeUsageKind }): Promise<FleetGraphNodeUsage>;

    /** Get requested graph edge-search shapes for one session. */
    getSessionGraphEdgeSearchUsage(sessionId: string, opts?: { since?: Date; limit?: number }): Promise<GraphEdgeSearchUsageRow[]>;

    /** Upsert a session metric summary with atomic increments. */
    upsertSessionMetricSummary(sessionId: string, updates: SessionMetricSummaryUpsert): Promise<void>;

    /** Hard-delete summary rows for sessions deleted before the cutoff. Returns count removed. */
    pruneDeletedSummaries(olderThan: Date): Promise<number>;

    /** Cleanup / close connections. */
    close(): Promise<void>;
}

// ─── PostgreSQL Implementation ───────────────────────────────────

const DEFAULT_SCHEMA = "copilot_sessions";

/**
 * Build qualified function/table names for a given schema.
 * Allows multiple deployments to coexist on the same database.
 */
function sqlForSchema(schema: string) {
    const s = `"${schema}"`;
    return {
        schema,
        fn: {
            liveAvailable:             `${s}.cms_live_available`,
            publishLive:               `${s}.cms_publish_live`,
            getLive:                   `${s}.cms_get_live`,
            createSession:              `${s}.cms_create_session`,
            setSessionOwner:            `${s}.cms_set_session_owner`,
            inheritSessionOwner:        `${s}.cms_inherit_session_owner`,
            setSessionVisibility:       `${s}.cms_set_session_visibility`,
            grantSessionShare:          `${s}.cms_grant_session_share`,
            revokeSessionShare:         `${s}.cms_revoke_session_share`,
            listSessionShares:          `${s}.cms_list_session_shares`,
            getSessionAccess:           `${s}.cms_get_session_access`,
            filterVisibleSessionIds:    `${s}.cms_filter_visible_session_ids`,
            recordAuthzAudit:           `${s}.cms_record_authz_audit`,
            listAuthzAudit:             `${s}.cms_list_authz_audit`,
            listSessionsVisible:        `${s}.cms_list_sessions_visible`,
            listUsers:                  `${s}.cms_list_users`,
            updateSession:              `${s}.cms_update_session`,
            softDeleteSession:          `${s}.cms_soft_delete_session`,
            archiveSystemSessionForRestart: `${s}.cms_archive_system_session_for_restart`,
            listSessions:               `${s}.cms_list_sessions`,
            listSessionsPage:           `${s}.cms_list_sessions_page`,
            getSession:                 `${s}.cms_get_session`,
            getDescendantSessionIds:    `${s}.cms_get_descendant_session_ids`,
            getLastSessionId:           `${s}.cms_get_last_session_id`,
            updateSessionSummary:       `${s}.cms_update_session_summary`,
            assignSessionGroup:         `${s}.cms_assign_session_group`,
            placeSessionsInGroup:       `${s}.cms_place_sessions_in_group`,
            createSessionGroup:         `${s}.cms_create_session_group`,
            updateSessionGroup:         `${s}.cms_update_session_group`,
            listSessionGroups:          `${s}.cms_list_session_groups`,
            listGroupSessions:          `${s}.cms_list_group_sessions`,
            deleteSessionGroup:         `${s}.cms_delete_session_group`,
            upsertChildOutcome:         `${s}.cms_upsert_child_outcome`,
            getChildOutcome:            `${s}.cms_get_child_outcome`,
            listChildOutcomes:          `${s}.cms_list_child_outcomes`,
            recordEvents:               `${s}.cms_record_events`,
            getSessionEvents:           `${s}.cms_get_session_events`,
            getSessionEventsBefore:     `${s}.cms_get_session_events_before`,
            getTopEventEmitters:        `${s}.cms_get_top_event_emitters`,
            insertTurnMetric:           `${s}.cms_insert_turn_metric`,
            completeTurnWriteback:      `${s}.cms_complete_turn_writeback`,
            setActiveTurnIndex:         `${s}.cms_set_active_turn_index`,
            getSessionTurnMetrics:      `${s}.cms_get_session_turn_metrics`,
            getSessionTokensByModel:    `${s}.cms_get_session_tokens_by_model`,
            getHourlyTokenBuckets:      `${s}.cms_get_hourly_token_buckets`,
            pruneTurnMetrics:           `${s}.cms_prune_turn_metrics`,
            getSessionMetricSummary:    `${s}.cms_get_session_metric_summary`,
            getSessionEventStats:       `${s}.cms_get_session_event_stats`,
            getSessionCompactionStats:  `${s}.cms_get_session_compaction_stats`,
            recordEpochCommitted:       `${s}.cms_record_epoch_committed`,
            recordRegenerated:          `${s}.cms_record_regenerated`,
            getSessionTreeStats:        `${s}.cms_get_session_tree_stats`,
            getSessionTreeStatsByModel: `${s}.cms_get_session_tree_stats_by_model`,
            getFleetStatsByAgent:       `${s}.cms_get_fleet_stats_by_agent`,
            getFleetStatsTotals:        `${s}.cms_get_fleet_stats_totals`,
            getUserStatsByModel:        `${s}.cms_get_user_stats_by_model`,
            getUserProfile:             `${s}.cms_get_user_profile`,
            getUserGitHubCopilotKey:    `${s}.cms_get_user_github_copilot_key`,
            setUserProfileSettings:     `${s}.cms_set_user_profile_settings`,
            setUserGitHubCopilotKey:    `${s}.cms_set_user_github_copilot_key`,
            getUserRole:                `${s}.cms_get_user_role`,
            setUserRole:                `${s}.cms_set_user_role`,
            upsertSessionMetricSummary: `${s}.cms_upsert_session_metric_summary`,
            pruneDeletedSummaries:      `${s}.cms_prune_deleted_summaries`,
            getSessionSkillUsage:       `${s}.cms_get_session_skill_usage`,
            getSessionTreeSkillUsage:   `${s}.cms_get_session_tree_skill_usage`,
            getFleetSkillUsage:         `${s}.cms_get_fleet_skill_usage`,
            getSessionRetrievalUsage:   `${s}.cms_get_session_retrieval_usage`,
            getSessionTreeRetrievalUsage: `${s}.cms_get_session_tree_retrieval_usage`,
            getFleetRetrievalUsage:     `${s}.cms_get_fleet_retrieval_usage`,
            getSessionGraphNodeUsage:   `${s}.cms_get_session_graph_node_usage`,
            getFleetGraphNodeUsage:     `${s}.cms_get_fleet_graph_node_usage`,
            getSessionGraphEdgeSearchUsage: `${s}.cms_get_session_graph_edge_search_usage`,
            agentRegistryEpoch:         `${s}.cms_agent_registry_epoch`,
            registerAgentSource:        `${s}.cms_register_agent_source`,
            listAgentSources:           `${s}.cms_list_agent_sources`,
            getAgentSource:             `${s}.cms_get_agent_source`,
            getAgentSourceToken:        `${s}.cms_get_agent_source_token`,
            updateAgentSourceSync:      `${s}.cms_update_agent_source_sync`,
            deleteAgentSource:          `${s}.cms_delete_agent_source`,
            publishAgentPackage:        `${s}.cms_publish_agent_package`,
            listAgentPackages:          `${s}.cms_list_agent_packages`,
            getAgentPackage:            `${s}.cms_get_agent_package`,
            resolveAgentPackageId:      `${s}.cms_resolve_agent_package_id`,
            getAgentPackagesInstallManifest: `${s}.cms_get_agent_packages_install_manifest`,
            setAgentPackageScope:       `${s}.cms_set_agent_package_scope`,
            setAgentPackageEnabled:     `${s}.cms_set_agent_package_enabled`,
            pinAgentPackageVersion:     `${s}.cms_pin_agent_package_version`,
            deleteAgentPackage:         `${s}.cms_delete_agent_package`,
            isAgentPackageEditor:       `${s}.cms_agent_package_is_editor`,
            grantAgentPackageEditor:    `${s}.cms_grant_agent_package_editor`,
            revokeAgentPackageEditor:   `${s}.cms_revoke_agent_package_editor`,
            listAgentPackageEditors:    `${s}.cms_list_agent_package_editors`,
            upsertAgentWorkerState:     `${s}.cms_upsert_agent_worker_state`,
            listAgentWorkerState:       `${s}.cms_list_agent_worker_state`,
            workerHeartbeat:            `${s}.cms_worker_heartbeat`,
            listWorkers:                `${s}.cms_list_workers`,
            fleetDirectiveBump:         `${s}.cms_fleet_directive_bump`,
            getFleetDirectives:         `${s}.cms_get_fleet_directives`,
        },
    };
}

/**
 * PgSessionCatalog — PostgreSQL implementation of SessionCatalog.
 *
 * Uses the `pg` package (node-postgres) directly.
 * Must be created via the async `PgSessionCatalog.create()` factory.
 */
export class PgSessionCatalog implements SessionCatalog {
    private pool: any;
    private initialized = false;
    private sql: ReturnType<typeof sqlForSchema>;
    private _providers: ProviderStore;

    private constructor(pool: any, schema: string) {
        this.pool = pool;
        this.sql = sqlForSchema(schema);
        this._providers = new ProviderStore(pool, schema);
    }

    /**
     * Provider budgets — see provider-store.ts. Kept behind one accessor
     * rather than spread across this class: the whole feature talks to the
     * `cms_provider_*` procs and nothing else, so it reads better as its own
     * surface than as thirty more methods here.
     */
    get providers(): ProviderStore {
        return this._providers;
    }

    static readonly DEFAULT_POOL_MAX = 3;

    /** Factory: create and connect a PgSessionCatalog. */
    static async create(
        connectionString: string,
        schema?: string,
        opts: { useManagedIdentity?: boolean; aadUser?: string } = {},
    ): Promise<PgSessionCatalog> {
        const { default: pg } = await import("pg");
        const { buildPgPoolConfig } = await import("./pg-pool-factory.js");

        const configuredPoolMax = Number.parseInt(process.env.PILOTSWARM_CMS_PG_POOL_MAX ?? "", 10);
        const poolMax = Number.isFinite(configuredPoolMax) && configuredPoolMax > 0
            ? configuredPoolMax
            : PgSessionCatalog.DEFAULT_POOL_MAX;

        const poolConfig = buildPgPoolConfig({
            connectionString,
            useManagedIdentity: opts.useManagedIdentity,
            aadUser: opts.aadUser,
            max: poolMax,
        });

        const pool = new pg.Pool(poolConfig);

        // Handle idle client errors (e.g. EADDRNOTAVAIL when the network
        // drops). Without this, pg Pool emits an unhandled 'error' event
        // which crashes the Node.js process.
        pool.on('error', (err: Error) => {
            console.error('[cms] pool idle client error (non-fatal):', err.message);
        });

        return new PgSessionCatalog(pool, schema ?? DEFAULT_SCHEMA);
    }


    async initialize(): Promise<void> {
        if (this.initialized) return;
        await runCmsMigrations(this.pool, this.sql.schema);
        this.initialized = true;
    }

    // ── Writes ───────────────────────────────────────────────

    async createSession(sessionId: string, opts?: {
        model?: string;
        reasoningEffort?: string;
        contextTier?: string | null;
        modelResolutionSource?: string;
        parentSessionId?: string;
        isSystem?: boolean;
        agentId?: string;
        splash?: string;
        splashMobile?: string;
        groupId?: string | null;
        owner?: SessionOwnerInfo | null;
        visibility?: SessionVisibility | null;
        /** Service sessions (tree-scoped machinery, e.g. the regen distiller). */
        serviceKind?: string | null;
        serviceOf?: string | null;
        /**
         * The session's full serializable creation config (migration 0072).
         * Durable so the orchestration start — which can run on a DIFFERENT
         * process than the create — rebuilds the exact config instead of an
         * empty one. Read back only via getSessionCreationConfig, never
         * through the shared getSession row (viewers must not see it).
         */
        creationConfig?: Record<string, unknown> | null;
    }): Promise<void> {
        const explicitGroupId = typeof opts?.groupId === "string" && opts.groupId.trim()
            ? opts.groupId.trim()
            : null;
        // A 42883 mid-transaction aborts it, so probe the newer overloads'
        // existence up front (once) instead of catch-and-retry inside BEGIN.
        const useVisibilityCreate = await this.supportsVisibilityCreate();
        const useCreationConfig = Boolean(opts?.creationConfig) && await this.supportsCreationConfig();
        const useSplashMobileCreate = !useVisibilityCreate && Boolean(opts?.splashMobile) && await this.supportsSplashMobileCreate();
        const providerModel = opts?.model ?? null;
        const validateProviderModel = Boolean(providerModel && opts?.modelResolutionSource)
            && await this.supportsProviderSessionModelValidation();
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            if (validateProviderModel) {
                await client.query(
                    `SELECT "${this.sql.schema}".cms_provider_assert_session_model($1,$2,$3,$4)`,
                    [providerModel, opts?.owner?.provider ?? null, opts?.owner?.subject ?? null, opts?.isSystem ?? false],
                );
            }
            const baseArgs = [sessionId, opts?.model ?? null, opts?.reasoningEffort ?? null, opts?.parentSessionId ?? null, opts?.isSystem ?? false, opts?.agentId ?? null, opts?.splash ?? null, null];
            if (useVisibilityCreate) {
                await client.query(
                    `SELECT ${this.sql.fn.createSession}($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                    [...baseArgs, opts?.splashMobile ?? null, opts?.visibility ?? null],
                );
            } else if (useSplashMobileCreate) {
                await client.query(
                    `SELECT ${this.sql.fn.createSession}($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                    [...baseArgs, opts?.splashMobile ?? null],
                );
            } else {
                await client.query(
                    `SELECT ${this.sql.fn.createSession}($1, $2, $3, $4, $5, $6, $7, $8)`,
                    baseArgs,
                );
            }

            // Creation config rides the same transaction as a raw UPDATE, like
            // the service columns below — the create proc's signature stays
            // untouched, and a pre-0072 database simply skips the write (the
            // in-memory map still covers the same-process path there).
            if (useCreationConfig) {
                await client.query(
                    `UPDATE "${this.sql.schema}".sessions SET creation_config = $2::jsonb WHERE session_id = $1`,
                    [sessionId, JSON.stringify(opts!.creationConfig)],
                );
            }

            // Service columns ride the same transaction as a raw UPDATE — the
            // create proc's signature stays untouched (see migration 0037).
            if (opts?.serviceKind) {
                await client.query(
                    `UPDATE "${this.sql.schema}".sessions SET service_kind = $2, service_of = $3 WHERE session_id = $1`,
                    [sessionId, opts.serviceKind, opts.serviceOf ?? null],
                );
            }

            if (Object.prototype.hasOwnProperty.call(opts ?? {}, "contextTier") || opts?.modelResolutionSource) {
                await client.query(
                    `UPDATE "${this.sql.schema}".sessions
                        SET context_tier = $2, model_resolution_source = $3
                      WHERE session_id = $1`,
                    [sessionId, opts?.contextTier ?? null, opts?.modelResolutionSource ?? null],
                );
            }

            if (!opts?.isSystem) {
                if (opts?.owner?.provider && opts?.owner?.subject) {
                    await client.query(
                        `SELECT ${this.sql.fn.setSessionOwner}($1, $2, $3, $4, $5)`,
                        [
                            sessionId,
                            opts.owner.provider,
                            opts.owner.subject,
                            opts.owner.email ?? null,
                            opts.owner.displayName ?? null,
                        ],
                    );
                } else if (opts?.parentSessionId) {
                    await client.query(
                        `SELECT ${this.sql.fn.inheritSessionOwner}($1, $2)`,
                        [sessionId, opts.parentSessionId],
                    );
                }

                // Initial placement for the CREATOR: private per-user state, so
                // it needs a principal — without an owner there is no creator to
                // place for, and the runtime places post-create instead.
                if (explicitGroupId && opts?.owner?.provider && opts?.owner?.subject) {
                    await client.query(
                        `SELECT * FROM ${this.sql.fn.placeSessionsInGroup}($1, $2, $3, $4, $5)`,
                        [opts.owner.provider, opts.owner.subject, false, [sessionId], explicitGroupId],
                    );
                }
            }

            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    /**
     * Stamp a session as a service session (tree-scoped machinery, migration
     * 0037) after creation — for callers that go through client.createSession
     * and cannot thread opts into the create transaction.
     */
    async markSessionService(sessionId: string, serviceKind: string, serviceOf: string | null): Promise<void> {
        await this.pool.query(
            `UPDATE "${this.sql.schema}".sessions SET service_kind = $2, service_of = $3 WHERE session_id = $1`,
            [sessionId, serviceKind, serviceOf],
        );
    }

    private _splashMobileCreateSupported: boolean | null = null;

    /** Whether the DB has migration 0026's 9-arg cms_create_session overload. Cached per catalog instance. */
    private async supportsSplashMobileCreate(): Promise<boolean> {
        if (this._splashMobileCreateSupported !== null) return this._splashMobileCreateSupported;
        const { rows } = await this.pool.query(
            `SELECT to_regprocedure($1) IS NOT NULL AS supported`,
            [`${this.sql.fn.createSession}(text,text,text,text,boolean,text,text,text,text)`],
        );
        this._splashMobileCreateSupported = Boolean(rows[0]?.supported);
        return this._splashMobileCreateSupported;
    }

    private _visibilityCreateSupported: boolean | null = null;
    private _providerSessionModelValidationSupported: boolean | null = null;

    private async supportsProviderSessionModelValidation(): Promise<boolean> {
        if (this._providerSessionModelValidationSupported !== null) {
            return this._providerSessionModelValidationSupported;
        }
        const { rows } = await this.pool.query(
            `SELECT to_regprocedure($1) IS NOT NULL AS supported`,
            [`"${this.sql.schema}".cms_provider_assert_session_model(text,text,text,boolean)`],
        );
        this._providerSessionModelValidationSupported = Boolean(rows[0]?.supported);
        return this._providerSessionModelValidationSupported;
    }

    /** Whether the DB has migration 0029's 10-arg cms_create_session overload. Cached per catalog instance. */
    private _creationConfigColumnSupported: boolean | null = null;

    /** Whether the DB has migration 0072's creation_config column. Cached per catalog instance. */
    private async supportsCreationConfig(): Promise<boolean> {
        if (this._creationConfigColumnSupported !== null) return this._creationConfigColumnSupported;
        const { rows } = await this.pool.query(
            `SELECT EXISTS (
                SELECT 1 FROM information_schema.columns
                 WHERE table_schema = $1 AND table_name = 'sessions' AND column_name = 'creation_config'
             ) AS supported`,
            [this.sql.schema],
        );
        this._creationConfigColumnSupported = Boolean(rows[0]?.supported);
        return this._creationConfigColumnSupported;
    }

    private async supportsVisibilityCreate(): Promise<boolean> {
        if (this._visibilityCreateSupported !== null) return this._visibilityCreateSupported;
        const { rows } = await this.pool.query(
            `SELECT to_regprocedure($1) IS NOT NULL AS supported`,
            [`${this.sql.fn.createSession}(text,text,text,text,boolean,text,text,text,text,text)`],
        );
        this._visibilityCreateSupported = Boolean(rows[0]?.supported);
        return this._visibilityCreateSupported;
    }

    async updateSession(sessionId: string, updates: SessionRowUpdates): Promise<void> {
        const jsonUpdates: Record<string, unknown> = {};
        if (updates.orchestrationId !== undefined) jsonUpdates.orchestrationId = updates.orchestrationId;
        if (updates.title !== undefined) jsonUpdates.title = updates.title;
        if (updates.titleLocked !== undefined) jsonUpdates.titleLocked = updates.titleLocked;
        if (updates.state !== undefined) jsonUpdates.state = updates.state;
        if (updates.model !== undefined) jsonUpdates.model = updates.model;
        if (updates.reasoningEffort !== undefined) jsonUpdates.reasoningEffort = updates.reasoningEffort;
        if (updates.contextTier !== undefined) jsonUpdates.contextTier = updates.contextTier;
        if (updates.modelResolutionSource !== undefined) jsonUpdates.modelResolutionSource = updates.modelResolutionSource;
        if (updates.lastActiveAt !== undefined) jsonUpdates.lastActiveAt = updates.lastActiveAt ? updates.lastActiveAt.toISOString() : null;
        if (updates.currentIteration !== undefined) jsonUpdates.currentIteration = updates.currentIteration;
        if (updates.lastError !== undefined) jsonUpdates.lastError = updates.lastError;
        if (updates.waitReason !== undefined) jsonUpdates.waitReason = updates.waitReason;
        if (updates.isSystem !== undefined) jsonUpdates.isSystem = updates.isSystem;
        if (updates.agentId !== undefined) jsonUpdates.agentId = updates.agentId;
        if (updates.splash !== undefined) jsonUpdates.splash = updates.splash;
        if (updates.splashMobile !== undefined) jsonUpdates.splashMobile = updates.splashMobile;

        if (Object.keys(jsonUpdates).length === 0) return;

        await this.pool.query(
            `SELECT ${this.sql.fn.updateSession}($1, $2)`,
            [sessionId, JSON.stringify(jsonUpdates)],
        );
    }

    async setActiveTurnIndex(sessionId: string, turnIndex: number): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.setActiveTurnIndex}($1, $2)`,
            [sessionId, turnIndex],
        );
    }

    async softDeleteSession(sessionId: string): Promise<void> {
        try {
            await this.pool.query(
                `SELECT ${this.sql.fn.softDeleteSession}($1)`,
                [sessionId],
            );
        } catch (err: any) {
            if (err?.message?.includes("Cannot delete system session")) {
                throw new Error("Cannot delete system session");
            }
            throw err;
        }
    }

    async archiveSystemSessionForRestart(
        sessionId: string,
        state: "completed" | "cancelled" | "failed",
        lastError?: string | null,
    ): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.archiveSystemSessionForRestart}($1, $2, $3)`,
            [sessionId, state, lastError ?? null],
        );
    }

    // ── Reads ────────────────────────────────────────────────

    async listSessions(placement?: { provider: string; subject: string } | null): Promise<SessionRow[]> {
        // Service columns join the raw table (same reasoning as getSession —
        // never widen a shared proc's RETURNS TABLE).
        const { rows } = await this.pool.query(
            `SELECT g.*, s.service_kind, s.service_of, s.context_tier, s.model_resolution_source
               FROM ${this.sql.fn.listSessions}($1, $2) g
               JOIN "${this.sql.schema}".sessions s ON s.session_id = g.session_id`,
            [placement?.provider ?? null, placement?.subject ?? null],
        );
        return rows.map(rowToSessionRow);
    }

    async listSessionsPage(opts?: {
        limit?: number;
        cursorUpdatedAt?: Date | null;
        cursorSessionId?: string | null;
        includeDeleted?: boolean;
        viewer?: { provider: string; subject: string; systemVisible?: boolean } | null;
        placement?: { provider: string; subject: string } | null;
    }): Promise<SessionRow[]> {
        const { rows } = await this.pool.query(
            `SELECT g.*, s.service_kind, s.service_of, s.context_tier, s.model_resolution_source
               FROM ${this.sql.fn.listSessionsPage}($1, $2, $3, $4, $5, $6, $7, $8, $9) g
               JOIN "${this.sql.schema}".sessions s ON s.session_id = g.session_id`,
            [
                opts?.limit ?? null,
                opts?.cursorUpdatedAt ?? null,
                opts?.cursorSessionId ?? null,
                opts?.includeDeleted ?? false,
                opts?.viewer?.provider ?? null,
                opts?.viewer?.subject ?? null,
                opts?.viewer?.systemVisible ?? true,
                opts?.placement?.provider ?? null,
                opts?.placement?.subject ?? null,
            ],
        );
        return rows.map(rowToSessionRow);
    }

    async listSessionsVisible(
        viewer: { provider: string; subject: string; systemVisible?: boolean },
        placement?: { provider: string; subject: string } | null,
    ): Promise<SessionRow[]> {
        const { rows } = await this.pool.query(
            `SELECT g.*, s.service_kind, s.service_of, s.context_tier, s.model_resolution_source
               FROM ${this.sql.fn.listSessionsVisible}($1, $2, $3, $4, $5) g
               JOIN "${this.sql.schema}".sessions s ON s.session_id = g.session_id`,
            [viewer.provider, viewer.subject, viewer.systemVisible ?? true, placement?.provider ?? null, placement?.subject ?? null],
        );
        return rows.map(rowToSessionRow);
    }

    async listKnownUsers(opts?: { limit?: number }): Promise<KnownUserInfo[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.listUsers}($1)`,
            [opts?.limit ?? null],
        );
        return rows.map((row: any) => ({
            provider: row.provider,
            subject: row.subject,
            email: row.email ?? null,
            displayName: row.display_name ?? null,
        }));
    }

    async getSession(sessionId: string, placement?: { provider: string; subject: string } | null): Promise<SessionRow | null> {
        // Join the two regeneration columns from the raw sessions table in the
        // same round-trip rather than widening the shared cms_get_session
        // proc's RETURNS TABLE — a proc-shape change breaks re-application of
        // the earlier migration that CREATE-OR-REPLACEs it with the old shape.
        const { rows } = await this.pool.query(
                `SELECT g.*, s.transcript_epoch, s.last_regenerated_at, s.service_kind, s.service_of,
                    s.context_tier, s.model_resolution_source
               FROM ${this.sql.fn.getSession}($1, $2, $3) g
               JOIN "${this.sql.schema}".sessions s ON s.session_id = g.session_id`,
            [sessionId, placement?.provider ?? null, placement?.subject ?? null],
        );
        return rows.length > 0 ? rowToSessionRow(rows[0]) : null;
    }

    /**
     * The session's durable creation config (migration 0072), or null.
     *
     * Deliberately its own narrow query: the shared getSession row is handed
     * to any viewer with read access by the web getSession op, and a stored
     * systemMessage is the owner's business. Called only on the
     * orchestration-start path when the in-memory config map misses, so it
     * adds nothing to the per-turn hot path. Fails soft on a pre-0072
     * database (probe short-circuits before querying the column).
     */
    async getSessionCreationConfig(sessionId: string): Promise<Record<string, unknown> | null> {
        if (!await this.supportsCreationConfig()) return null;
        const { rows } = await this.pool.query(
            `SELECT creation_config FROM "${this.sql.schema}".sessions WHERE session_id = $1`,
            [sessionId],
        );
        const value = rows[0]?.creation_config;
        return value && typeof value === "object" ? value : null;
    }

    async setSessionVisibility(sessionId: string, visibility: SessionVisibility): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.setSessionVisibility}($1, $2)`,
            [sessionId, visibility],
        );
    }

    async grantSessionShare(
        sessionId: string,
        grantee: SessionOwnerInfo,
        access: "read" | "write",
        grantedBy?: SessionOwnerInfo | null,
    ): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.grantSessionShare}($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                sessionId,
                grantee.provider,
                grantee.subject,
                grantee.email ?? null,
                grantee.displayName ?? null,
                access,
                grantedBy?.provider ?? null,
                grantedBy?.subject ?? null,
            ],
        );
    }

    async revokeSessionShare(sessionId: string, grantee: { provider: string; subject: string }): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.revokeSessionShare}($1, $2, $3)`,
            [sessionId, grantee.provider, grantee.subject],
        );
    }

    async listSessionShares(sessionId: string): Promise<SessionShareInfo[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.listSessionShares}($1)`,
            [sessionId],
        );
        return rows.map((row: any) => ({
            provider: row.provider,
            subject: row.subject,
            email: row.email ?? null,
            displayName: row.display_name ?? null,
            access: row.access,
            grantedAt: new Date(row.granted_at),
            grantedByDisplay: row.granted_by_display ?? null,
        }));
    }

    async filterVisibleSessionIds(sessionIds: string[], viewer: { provider: string; subject: string }, systemVisible: boolean): Promise<string[]> {
        if (!sessionIds.length) return [];
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.filterVisibleSessionIds}($1, $2, $3, $4)`,
            [sessionIds, viewer.provider, viewer.subject, systemVisible],
        );
        return rows.map((row: { session_id: string }) => row.session_id);
    }

    async getSessionAccess(
        sessionId: string,
        viewer: { provider: string; subject: string },
    ): Promise<SessionAccessSnapshot | null> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionAccess}($1, $2, $3)`,
            [sessionId, viewer.provider ?? "", viewer.subject ?? ""],
        );
        if (rows.length === 0) return null;
        const row = rows[0];
        const owner = row.owner_provider && row.owner_subject
            ? {
                provider: row.owner_provider,
                subject: row.owner_subject,
                email: row.owner_email ?? null,
                displayName: row.owner_display_name ?? null,
            }
            : null;
        return {
            rootSessionId: row.root_session_id,
            isSystem: row.is_system ?? false,
            visibility: row.visibility ?? "private",
            owner,
            viewerIsOwner: row.viewer_is_owner ?? false,
            viewerShareAccess: row.viewer_share_access ?? null,
        };
    }

    async recordAuthzAudit(entry: {
        actor?: { provider?: string | null; subject?: string | null; display?: string | null } | null;
        action: string;
        sessionId?: string | null;
        target?: string | null;
        decision: string;
        reason?: string | null;
        details?: Record<string, unknown> | null;
    }): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.recordAuthzAudit}($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
                entry.actor?.provider ?? null,
                entry.actor?.subject ?? null,
                entry.actor?.display ?? null,
                entry.action,
                entry.sessionId ?? null,
                entry.target ?? null,
                entry.decision,
                entry.reason ?? null,
                JSON.stringify(entry.details ?? {}),
            ],
        );
    }

    async listAuthzAudit(opts?: { limit?: number; sessionId?: string | null }): Promise<AuthzAuditEntry[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.listAuthzAudit}($1, $2)`,
            [opts?.limit ?? null, opts?.sessionId ?? null],
        );
        return rows.map((row: any) => ({
            auditId: Number(row.audit_id),
            occurredAt: new Date(row.occurred_at),
            actorProvider: row.actor_provider ?? null,
            actorSubject: row.actor_subject ?? null,
            actorDisplay: row.actor_display ?? null,
            action: row.action,
            sessionId: row.session_id ?? null,
            target: row.target ?? null,
            decision: row.decision,
            reason: row.reason ?? null,
            details: row.details ?? {},
        }));
    }

    async getDescendantSessionIds(sessionId: string): Promise<string[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getDescendantSessionIds}($1)`,
            [sessionId],
        );
        return rows.map((r: any) => r.session_id);
    }

    async getLastSessionId(): Promise<string | null> {
        const { rows } = await this.pool.query(
            `SELECT ${this.sql.fn.getLastSessionId}() AS session_id`,
        );
        return rows.length > 0 ? rows[0].session_id : null;
    }

    async updateSessionSummary(sessionId: string, summaryState: SessionSummaryState, shortSummary?: string | null): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.updateSessionSummary}($1, $2, $3)`,
            [sessionId, JSON.stringify(summaryState), shortSummary ?? null],
        );
    }

    async createSessionGroup(input: { groupId: string; title: string; description?: string | null; owner?: SessionOwnerInfo | null; metadata?: Record<string, unknown> }): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.createSessionGroup}($1, $2, $3, $4, $5)`,
            [
                input.groupId,
                input.title,
                input.description ?? null,
                input.owner ? JSON.stringify(input.owner) : null,
                JSON.stringify(input.metadata ?? {}),
            ],
        );
    }

    async updateSessionGroup(groupId: string, patch: { title?: string; description?: string | null; owner?: SessionOwnerInfo | null; metadataPatch?: Record<string, unknown> }): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.updateSessionGroup}($1, $2)`,
            [groupId, JSON.stringify(patch)],
        );
    }

    async listSessionGroups(viewer?: PlacementViewer | null): Promise<SessionGroupRow[]> {
        if (viewer) {
            const { rows } = await this.pool.query(
                `SELECT * FROM ${this.sql.fn.listSessionGroups}($1, $2, $3)`,
                [viewer.provider, viewer.subject, viewer.isAdmin ?? false],
            );
            return rows.map(rowToSessionGroupRow);
        }
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.listSessionGroups}()`,
        );
        return rows.map(rowToSessionGroupRow);
    }

    async listGroupSessions(groupId: string, placement?: { provider: string; subject: string } | null): Promise<SessionRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.listGroupSessions}($1, $2, $3)`,
            [groupId, placement?.provider ?? null, placement?.subject ?? null],
        );
        return rows.map(rowToSessionRow);
    }

    async deleteSessionGroup(groupId: string): Promise<boolean> {
        const { rows } = await this.pool.query(
            `SELECT ${this.sql.fn.deleteSessionGroup}($1) AS deleted`,
            [groupId],
        );
        return rows[0]?.deleted === true;
    }

    async placeSessionsInGroup(
        viewer: PlacementViewer,
        sessionIds: string[],
        groupId: string | null,
    ): Promise<SessionPlacementResult[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.placeSessionsInGroup}($1, $2, $3, $4, $5)`,
            [viewer.provider, viewer.subject, viewer.isAdmin ?? false, sessionIds, groupId],
        );
        return rows.map((row: any) => ({
            rootSessionId: row.root_session_id,
            placed: row.placed === true,
            reason: row.reason ?? null,
        }));
    }

    async upsertChildOutcome(input: {
        childSessionId: string;
        parentSessionId: string;
        contractJson?: Record<string, unknown> | null;
        resultJson?: Record<string, unknown> | null;
        verdict?: string | null;
        summary?: string | null;
        completedAt?: Date | null;
    }): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.upsertChildOutcome}($1, $2, $3, $4, $5, $6, $7)`,
            [
                input.childSessionId,
                input.parentSessionId,
                input.contractJson ? JSON.stringify(input.contractJson) : null,
                input.resultJson ? JSON.stringify(input.resultJson) : null,
                input.verdict ?? null,
                input.summary ?? null,
                input.completedAt ?? null,
            ],
        );
    }

    async getChildOutcome(childSessionId: string): Promise<ChildOutcomeRow | null> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getChildOutcome}($1)`,
            [childSessionId],
        );
        return rows.length > 0 ? rowToChildOutcomeRow(rows[0]) : null;
    }

    async listChildOutcomes(parentSessionId: string): Promise<ChildOutcomeRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.listChildOutcomes}($1)`,
            [parentSessionId],
        );
        return rows.map(rowToChildOutcomeRow);
    }

    // ── Events ───────────────────────────────────────────────

    async recordEvents(sessionId: string, events: { eventType: string; data: unknown }[], workerNodeId?: string): Promise<void> {
        if (events.length === 0) return;

        await this.pool.query(
            `SELECT ${this.sql.fn.recordEvents}($1, $2, $3)`,
            [sessionId, JSON.stringify(events), workerNodeId ?? null],
        );
    }

    /**
     * Per-slot canvas cache — see migration 0045. The event log stays the
     * durable source; this is what makes per-slot revs O(1) and lets the
     * sessions list say "has canvases" without replaying events. A missed
     * write self-heals on the next draw (the bridge falls back to an event
     * scan when the row is absent), so callers treat failures as non-fatal.
     */
    async upsertSessionCanvas(sessionId: string, slot: number, name: string | null, latestRev: number, sizeBytes: number | null): Promise<void> {
        await this.pool.query(
            `INSERT INTO "${this.sql.schema}".session_canvases (session_id, slot, name, latest_rev, size_bytes, updated_at)
             VALUES ($1, $2, COALESCE($3, ''), $4, $5, now())
             ON CONFLICT (session_id, slot) DO UPDATE SET
                 latest_rev = GREATEST("${this.sql.schema}".session_canvases.latest_rev, EXCLUDED.latest_rev),
                 name = CASE WHEN $3 IS NULL THEN "${this.sql.schema}".session_canvases.name ELSE EXCLUDED.name END,
                 size_bytes = EXCLUDED.size_bytes,
                 updated_at = now()`,
            [sessionId, slot, name, latestRev, sizeBytes],
        );
    }

    /**
     * Drawn canvases for MANY sessions in one query — the sessions-list
     * attachment. Only rows with a real rev; empty ids short-circuit.
     */
    async listSessionCanvasesFor(sessionIds: string[]): Promise<Map<string, Array<{ slot: number; name: string; latestRev: number; sizeBytes: number | null }>>> {
        const ids = (sessionIds || []).map((x) => String(x || "").trim()).filter(Boolean);
        const out = new Map<string, Array<{ slot: number; name: string; latestRev: number; sizeBytes: number | null }>>();
        if (ids.length === 0) return out;
        const { rows } = await this.pool.query(
            `SELECT session_id, slot, name, latest_rev, size_bytes
             FROM "${this.sql.schema}".session_canvases
             WHERE session_id = ANY($1) AND latest_rev > 0
             ORDER BY session_id, slot`,
            [ids],
        );
        for (const r of rows) {
            const list = out.get(r.session_id) || [];
            list.push({
                slot: Number(r.slot),
                name: String(r.name || ""),
                latestRev: Number(r.latest_rev) || 0,
                sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
            });
            out.set(r.session_id, list);
        }
        return out;
    }

    /** All drawn canvases for one session, ordered by slot. */
    async getSessionCanvases(sessionId: string): Promise<Array<{ slot: number; name: string; latestRev: number; sizeBytes: number | null; updatedAt: string }>> {
        const { rows } = await this.pool.query(
            `SELECT slot, name, latest_rev, size_bytes, updated_at
             FROM "${this.sql.schema}".session_canvases
             WHERE session_id = $1
             ORDER BY slot`,
            [sessionId],
        );
        return rows.map((r: any) => ({
            slot: Number(r.slot),
            name: String(r.name || ""),
            latestRev: Number(r.latest_rev) || 0,
            sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
            updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
        }));
    }

    /**
     * Atomically mint the next canvas revision for (session, slot) — the
     * multi-writer-safe replacement for read-latest-then-plus-one, which
     * only the single-writer promise chain kept safe. seedRev is the
     * caller's best knowledge from the event scan: it floors the counter so
     * a session whose 0045 row was never written (legacy, missed upsert)
     * cannot mint rev 1 over a live rev-12 canvas.
     */
    async mintCanvasRev(sessionId: string, slot: number, seedRev: number): Promise<number> {
        const s = `"${this.sql.schema}"`;
        const seed = Math.max(0, Math.floor(Number(seedRev) || 0));
        const { rows } = await this.pool.query(
            `INSERT INTO ${s}.session_canvases (session_id, slot, name, latest_rev, size_bytes, updated_at)
             VALUES ($1, $2, '', $3 + 1, NULL, now())
             ON CONFLICT (session_id, slot) DO UPDATE SET
                 latest_rev = GREATEST(${s}.session_canvases.latest_rev, $3::int) + 1,
                 updated_at = now()
             RETURNING latest_rev`,
            [sessionId, slot, seed],
        );
        return Number(rows[0].latest_rev);
    }

    // ── The canvas data plane (migration 0047) ─────────────────────────
    private canvasLiveProbe: boolean | null = null;

    async canvasLiveAvailable(): Promise<boolean> {
        if (this.canvasLiveProbe !== null) return this.canvasLiveProbe;
        try {
            const { rows } = await this.pool.query(
                `SELECT to_regclass($1) AS t`,
                [`"${this.sql.schema}".canvas_live`],
            );
            // Cache only a DEFINITIVE answer. A transient query error must
            // not disable the plane for the process lifetime — return false
            // for THIS call and let the next one re-probe.
            this.canvasLiveProbe = Boolean(rows?.[0]?.t);
            return this.canvasLiveProbe;
        } catch {
            return false;
        }
    }

    async upsertCanvasLiveTick(
        sessionId: string,
        slot: number,
        input: { data?: Record<string, unknown>; patch?: Record<string, unknown> },
        updatedBy: string,
        maxBytes = 32_768,
    ): Promise<{ seq: number; sizeBytes: number; payload: Record<string, unknown> } | { refused: true; currentSizeBytes: number | null }> {
        const s = `"${this.sql.schema}"`;
        const isPatch = input.patch !== undefined;
        const body = JSON.stringify(isPatch ? input.patch : input.data);
        // One statement: candidate size gates BOTH paths, the merge runs
        // against the LOCKED row inside DO UPDATE (concurrent patches
        // serialize on the row lock and compose), and the NOTIFY fires only
        // when a row was actually written. The channel is global; the payload
        // carries the schema so multi-schema deployments (and test suites)
        // never cross-talk.
        const { rows } = await this.pool.query(
            `WITH up AS (
                INSERT INTO ${s}.canvas_live (session_id, slot, seq, doc_rev, doc_sha, payload, updated_by, updated_at)
                SELECT $1, $2, 1, 0, '',
                       CASE WHEN $4::boolean THEN ${s}.jsonb_merge_patch('{}'::jsonb, $3::jsonb) ELSE $3::jsonb END,
                       $5, now()
                WHERE octet_length((CASE WHEN $4::boolean THEN ${s}.jsonb_merge_patch('{}'::jsonb, $3::jsonb) ELSE $3::jsonb END)::text) <= $6
                ON CONFLICT (session_id, slot) DO UPDATE SET
                    seq = ${s}.canvas_live.seq + 1,
                    payload = CASE WHEN $4::boolean THEN ${s}.jsonb_merge_patch(${s}.canvas_live.payload, $3::jsonb) ELSE $3::jsonb END,
                    updated_by = $5,
                    updated_at = now()
                WHERE octet_length((CASE WHEN $4::boolean THEN ${s}.jsonb_merge_patch(${s}.canvas_live.payload, $3::jsonb) ELSE $3::jsonb END)::text) <= $6
                RETURNING seq, payload
            )
            SELECT up.seq, up.payload, octet_length(up.payload::text) AS size_bytes,
                   pg_notify('pilotswarm_canvas_live',
                       -- The patch rides the ping when the FINAL message fits
                       -- (pg_notify hard-errors at 8000 bytes, and that error
                       -- would roll back the row write in this statement).
                       -- Gate on the built envelope itself — jsonb re-renders
                       -- with extra whitespace and the envelope adds ~150
                       -- bytes, so measuring the raw patch text under-counts.
                       -- Too big (or a PUT): pointer only — the relay's
                       -- subscribers snapshot from the row instead.
                       (SELECT CASE WHEN m.with_patch IS NOT NULL AND octet_length(m.with_patch) <= 7900
                               THEN m.with_patch ELSE m.pointer END
                        FROM (SELECT
                            CASE WHEN $4::boolean THEN json_build_object(
                                'schema', $7::text, 'sessionId', $1::text, 'slot', $2::int, 'seq', up.seq,
                                'kind', 'data', 'patch', $3::jsonb)::text END AS with_patch,
                            json_build_object(
                                'schema', $7::text, 'sessionId', $1::text, 'slot', $2::int, 'seq', up.seq,
                                'kind', 'data')::text AS pointer) m))
            FROM up`,
            [sessionId, slot, body, isPatch, updatedBy, maxBytes, this.sql.schema],
        );
        if (rows.length > 0) {
            return {
                seq: Number(rows[0].seq),
                sizeBytes: Number(rows[0].size_bytes),
                payload: rows[0].payload ?? {},
            };
        }
        // Refused by the size gate. Report the CURRENT row's size so the
        // error can say what the merged result was up against (null when the
        // very first write was itself oversized — no row exists yet).
        const { rows: current } = await this.pool.query(
            `SELECT octet_length(payload::text) AS size_bytes FROM ${s}.canvas_live WHERE session_id = $1 AND slot = $2`,
            [sessionId, slot],
        );
        return { refused: true, currentSizeBytes: current.length > 0 ? Number(current[0].size_bytes) : null };
    }

    async upsertCanvasLiveDoc(sessionId: string, slot: number, doc: { rev: number; sha: string }, updatedBy: string): Promise<{ seq: number } | null> {
        const s = `"${this.sql.schema}"`;
        const { rows } = await this.pool.query(
            `WITH up AS (
                INSERT INTO ${s}.canvas_live (session_id, slot, seq, doc_rev, doc_sha, payload, updated_by, updated_at)
                VALUES ($1, $2, 1, $3, $4, '{}'::jsonb, $5, now())
                ON CONFLICT (session_id, slot) DO UPDATE SET
                    seq = ${s}.canvas_live.seq + 1,
                    doc_rev = EXCLUDED.doc_rev,
                    doc_sha = EXCLUDED.doc_sha,
                    payload = '{}'::jsonb,
                    updated_by = EXCLUDED.updated_by,
                    updated_at = now()
                RETURNING seq
            )
            SELECT up.seq, pg_notify('pilotswarm_canvas_live', json_build_object(
                       'schema', $6::text, 'sessionId', $1::text, 'slot', $2::int, 'seq', up.seq, 'kind', 'doc')::text)
            FROM up`,
            [sessionId, slot, doc.rev, doc.sha, updatedBy, this.sql.schema],
        );
        return rows.length > 0 ? { seq: Number(rows[0].seq) } : null;
    }

    async getCanvasLive(sessionId: string): Promise<Array<{ slot: number; seq: number; docRev: number; docSha: string; payload: Record<string, unknown>; updatedBy: string; updatedAt: string }>> {
        const { rows } = await this.pool.query(
            `SELECT slot, seq, doc_rev, doc_sha, payload, updated_by, updated_at
             FROM "${this.sql.schema}".canvas_live
             WHERE session_id = $1
             ORDER BY slot`,
            [sessionId],
        );
        return rows.map((r: any) => ({
            slot: Number(r.slot),
            seq: Number(r.seq),
            docRev: Number(r.doc_rev) || 0,
            docSha: String(r.doc_sha || ""),
            payload: r.payload ?? {},
            updatedBy: String(r.updated_by || ""),
            updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
        }));
    }

    // ── Generic live plane (migration 0073) ────────────────────────────
    private liveProbe: { available: boolean; checkedAt: number } | null = null;

    async liveAvailable(): Promise<boolean> {
        if (this.liveProbe && Date.now() - this.liveProbe.checkedAt < 5_000) return this.liveProbe.available;
        try {
            const { rows } = await this.pool.query(
                `SELECT ${this.sql.fn.liveAvailable}() AS t`,
            );
            const available = Boolean(rows?.[0]?.t);
            this.liveProbe = { available, checkedAt: Date.now() };
            return available;
        } catch {
            // A transient database error is not a permanent feature probe.
            return false;
        }
    }

    async publishLive(
        sessionId: string,
        topic: string,
        input: { patch: Record<string, unknown> } | { snapshot: Record<string, unknown> } | { signal: true },
        updatedBy: string,
        maxBytes = 262_144,
    ): Promise<{ seq: number; sizeBytes: number; payload: Record<string, unknown> } | { signal: true } | { refused: true; currentSizeBytes: number | null } | null> {
        const normalizedTopic = String(topic || "").trim();
        if (!/^[a-z][a-z0-9_.:-]{0,63}$/.test(normalizedTopic)) {
            throw new Error(`Invalid live topic: ${topic}`);
        }
        if (!input || typeof input !== "object") throw new Error("publishLive requires an input object");
        const modes = Number("patch" in input) + Number("snapshot" in input) + Number("signal" in input);
        if (modes !== 1) throw new Error("publishLive requires exactly one of patch, snapshot, or signal");
        if ("signal" in input && input.signal !== true) throw new Error("publishLive signal must be true");
        if (!(await this.liveAvailable())) return null;

        const kind = "signal" in input ? "signal" : "patch" in input ? "patch" : "snapshot";
        const data = "patch" in input ? input.patch : "snapshot" in input ? input.snapshot : {};
        if (!data || typeof data !== "object" || Array.isArray(data)) {
            throw new Error("publishLive patch/snapshot data must be an object");
        }
        const safeMaxBytes = Math.max(1, Math.min(262_144, Math.floor(Number(maxBytes) || 262_144)));
        try {
            const { rows } = await this.pool.query({
                text: `SELECT ${this.sql.fn.publishLive}($1, $2, $3::jsonb, $4, $5, $6) AS result`,
                values: [sessionId, normalizedTopic, JSON.stringify(data), kind, updatedBy || "", safeMaxBytes],
                query_timeout: 5_000,
            });
            return rows[0]?.result ?? null;
        } catch (error) {
            if (!["42P01", "42883"].includes((error as any)?.code)) throw error;
            this.liveProbe = { available: false, checkedAt: Date.now() };
            return null;
        }
    }
    async getLive(sessionId: string, topics?: string[]): Promise<Array<{ topic: string; seq: number; payload: Record<string, unknown>; updatedBy: string; updatedAt: string }>> {
        if (topics !== undefined && !Array.isArray(topics)) throw new Error("Live topics must be an array");
        const normalizedTopics = topics?.map((topic) => String(topic || "").trim()) ?? null;
        if (normalizedTopics?.some((topic) => !/^[a-z][a-z0-9_.:-]{0,63}$/.test(topic))) {
            throw new Error("Invalid live topic");
        }
        if (!(await this.liveAvailable())) return [];
        let rows: any[];
        try {
            ({ rows } = await this.pool.query(
                `SELECT * FROM ${this.sql.fn.getLive}($1, $2::text[])`,
                [sessionId, normalizedTopics],
            ));
        } catch (error) {
            if ((error as any)?.code !== "42P01") throw error;
            this.liveProbe = { available: false, checkedAt: Date.now() };
            return [];
        }
        return rows.map((row: any) => ({
            topic: String(row.topic),
            seq: Number(row.seq),
            payload: row.payload ?? {},
            updatedBy: String(row.updated_by || ""),
            updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
        }));
    }

    // ── The canvas KV store (migration 0064) ───────────────────────────
    async getCanvasKvSettings(sessionId: string, slot: number): Promise<{ kvAccess: "owner" | "readers" | "link"; kvManifest: unknown; latestRev: number } | null> {
        const { rows } = await this.pool.query(
            `SELECT * FROM "${this.sql.schema}".cms_get_canvas_kv_settings($1, $2)`,
            [sessionId, slot],
        );
        if (rows.length === 0) return null;
        const access = rows[0].kv_access;
        return {
            kvAccess: access === "readers" ? "readers" : access === "link" ? "link" : "owner",
            kvManifest: rows[0].kv_manifest ?? null,
            latestRev: Number(rows[0].latest_rev) || 0,
        };
    }

    async setCanvasKvAccess(sessionId: string, slot: number, access: "owner" | "readers" | "link"): Promise<void> {
        await this.pool.query(
            `SELECT "${this.sql.schema}".cms_set_canvas_kv_access($1, $2, $3)`,
            [sessionId, slot, access],
        );
    }

    async setCanvasKvManifest(sessionId: string, slot: number, manifest: unknown | null): Promise<void> {
        await this.pool.query(
            `SELECT "${this.sql.schema}".cms_set_canvas_kv_manifest($1, $2, $3)`,
            [sessionId, slot, manifest == null ? null : JSON.stringify(manifest)],
        );
    }

    async canvasKvGet(sessionId: string, slot: number, key: string): Promise<{ key: string; value: any; rev: number; updatedAt: string } | null> {
        const { rows } = await this.pool.query(
            `SELECT * FROM "${this.sql.schema}".cms_canvas_kv_get($1, $2, $3)`,
            [sessionId, slot, key],
        );
        return rows.length > 0 ? rowToCanvasKv(rows[0]) : null;
    }

    async canvasKvList(sessionId: string, slot: number, prefix: string | null, limit: number, afterKey: string | null): Promise<Array<{ key: string; value: any; rev: number; updatedAt: string }>> {
        const { rows } = await this.pool.query(
            `SELECT * FROM "${this.sql.schema}".cms_canvas_kv_list($1, $2, $3, $4, $5)`,
            [sessionId, slot, prefix, limit, afterKey],
        );
        return rows.map(rowToCanvasKv);
    }

    async canvasKvWrite(
        sessionId: string,
        slot: number,
        key: string,
        value: unknown | null,
        ifMatch: number | null,
        limits: { maxKeys: number; maxBytes: number; maxValueBytes: number },
    ): Promise<{ status: string; rev: number; sizeBytes: number | null }> {
        const { rows } = await this.pool.query(
            `SELECT * FROM "${this.sql.schema}".cms_canvas_kv_write($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [sessionId, slot, key, value == null ? null : JSON.stringify(value), ifMatch, limits.maxKeys, limits.maxBytes, limits.maxValueBytes, this.sql.schema],
        );
        const row = rows[0] ?? {};
        return { status: String(row.status ?? "error"), rev: Number(row.rev) || 0, sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes) };
    }

    async canvasKvStats(sessionId: string, slot: number): Promise<{ keys: number; bytes: number }> {
        const { rows } = await this.pool.query(
            `SELECT * FROM "${this.sql.schema}".cms_canvas_kv_stats($1, $2)`,
            [sessionId, slot],
        );
        return { keys: Number(rows[0]?.keys) || 0, bytes: Number(rows[0]?.bytes) || 0 };
    }

    // ── Canvas share links (migration 0048) ────────────────────────────
    async getCanvasShareLinkInfo(sessionId: string, slot: number): Promise<{ exists: boolean; createdAt?: string; createdBy?: string }> {
        const { rows } = await this.pool.query(
            `SELECT created_at, created_by FROM "${this.sql.schema}".canvas_share_links WHERE session_id = $1 AND slot = $2`,
            [sessionId, slot],
        );
        if (rows.length === 0) return { exists: false };
        return {
            exists: true,
            createdAt: rows[0].created_at instanceof Date ? rows[0].created_at.toISOString() : String(rows[0].created_at),
            createdBy: String(rows[0].created_by || ""),
        };
    }

    async setCanvasShareLink(sessionId: string, slot: number, tokenHash: string, createdBy: string): Promise<void> {
        await this.pool.query(
            `INSERT INTO "${this.sql.schema}".canvas_share_links (session_id, slot, token_hash, created_at, created_by)
             VALUES ($1, $2, $3, now(), $4)
             ON CONFLICT (session_id, slot) DO UPDATE SET
                 token_hash = EXCLUDED.token_hash,
                 created_at = now(),
                 created_by = EXCLUDED.created_by`,
            [sessionId, slot, tokenHash, createdBy],
        );
    }

    async removeCanvasShareLink(sessionId: string, slot: number): Promise<boolean> {
        const { rowCount } = await this.pool.query(
            `DELETE FROM "${this.sql.schema}".canvas_share_links WHERE session_id = $1 AND slot = $2`,
            [sessionId, slot],
        );
        return (rowCount ?? 0) > 0;
    }

    async resolveCanvasShareToken(tokenHash: string): Promise<{ sessionId: string; slot: number } | null> {
        const hash = String(tokenHash || "").trim();
        if (!hash) return null;
        const { rows } = await this.pool.query(
            `SELECT session_id, slot FROM "${this.sql.schema}".canvas_share_links WHERE token_hash = $1`,
            [hash],
        );
        return rows.length > 0 ? { sessionId: String(rows[0].session_id), slot: Number(rows[0].slot) } : null;
    }

    async getSessionEvents(sessionId: string, afterSeq?: number, limit?: number, eventTypes?: string[]): Promise<SessionEvent[]> {
        const effectiveLimit = limit ?? 1000;
        const types = normalizeEventTypes(eventTypes);
        if (types) {
            try {
                const { rows } = await this.pool.query(
                    `SELECT * FROM ${this.sql.fn.getSessionEvents}($1, $2, $3, $4)`,
                    [sessionId, afterSeq ?? null, effectiveLimit, types],
                );
                return rows.map(rowToSessionEvent);
            } catch (err) {
                if (!isUndefinedFunctionError(err)) throw err;
                // DB predates migration 0025 — fall through to the unfiltered proc.
            }
        }
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionEvents}($1, $2, $3)`,
            [sessionId, afterSeq ?? null, effectiveLimit],
        );
        return rows.map(rowToSessionEvent);
    }

    async getSessionEventsBefore(sessionId: string, beforeSeq: number, limit?: number, eventTypes?: string[]): Promise<SessionEvent[]> {
        const effectiveLimit = limit ?? 1000;
        const types = normalizeEventTypes(eventTypes);
        if (types) {
            try {
                const { rows } = await this.pool.query(
                    `SELECT * FROM ${this.sql.fn.getSessionEventsBefore}($1, $2, $3, $4)`,
                    [sessionId, beforeSeq, effectiveLimit, types],
                );
                return rows.map(rowToSessionEvent);
            } catch (err) {
                if (!isUndefinedFunctionError(err)) throw err;
                // DB predates migration 0025 — fall through to the unfiltered proc.
            }
        }
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionEventsBefore}($1, $2, $3)`,
            [sessionId, beforeSeq, effectiveLimit],
        );
        return rows.map(rowToSessionEvent);
    }

    async getTopEventEmitters(since: Date, limit?: number): Promise<TopEventEmitterRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getTopEventEmitters}($1, $2)`,
            [since, limit ?? null],
        );
        return rows.map(rowToTopEventEmitterRow);
    }

    async insertTurnMetric(input: InsertTurnMetricInput): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.insertTurnMetric}($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
            [
                input.sessionId,
                input.agentId,
                input.model,
                input.reasoningEffort,
                input.turnIndex,
                input.startedAt,
                input.endedAt,
                input.durationMs,
                input.tokensInput,
                input.tokensOutput,
                input.tokensCacheRead,
                input.tokensCacheWrite,
                input.toolCalls,
                input.toolErrors,
                input.resultType,
                input.errorMessage,
                input.workerNodeId,
            ],
        );
    }

    async completeTurnWriteback(input: CompleteTurnWritebackInput): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.completeTurnWriteback}($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
            [
                input.sessionId,
                input.agentId,
                input.model,
                input.reasoningEffort,
                input.turnIndex,
                input.startedAt,
                input.endedAt,
                input.durationMs,
                input.tokensInput,
                input.tokensOutput,
                input.tokensCacheRead,
                input.tokensCacheWrite,
                input.toolCalls,
                input.toolErrors,
                input.toolNames ?? [],
                input.resultType,
                input.errorMessage,
                input.workerNodeId,
                input.state,
                input.lastActiveAt,
                input.lastError,
                input.waitReason,
                input.currentIteration,
            ],
        );
    }

    async getSessionTurnMetrics(sessionId: string, opts?: { since?: Date; limit?: number }): Promise<TurnMetricRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionTurnMetrics}($1, $2, $3)`,
            [sessionId, opts?.since ?? null, opts?.limit ?? null],
        );
        return rows.map(rowToTurnMetricRow);
    }

    async getSessionTokensByModel(sessionId: string): Promise<TokensByModelRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionTokensByModel}($1)`,
            [sessionId],
        );
        return rows.map((r: any): TokensByModelRow => ({
            model: r.model ?? "(unknown)",
            turnCount: Number(r.turn_count) || 0,
            totalTokensInput: Number(r.total_tokens_input) || 0,
            totalTokensOutput: Number(r.total_tokens_output) || 0,
            totalTokensCacheRead: Number(r.total_tokens_cache_read) || 0,
            totalTokensCacheWrite: Number(r.total_tokens_cache_write) || 0,
        }));
    }

    async getHourlyTokenBuckets(since: Date, opts?: { agentId?: string; model?: string }): Promise<HourlyTokenBucketRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getHourlyTokenBuckets}($1, $2, $3)`,
            [since, opts?.agentId ?? null, opts?.model ?? null],
        );
        return rows.map(rowToHourlyTokenBucketRow);
    }

    async pruneTurnMetrics(olderThan: Date): Promise<number> {
        const { rows } = await this.pool.query(
            `SELECT ${this.sql.fn.pruneTurnMetrics}($1) AS deleted_count`,
            [olderThan],
        );
        return Number(rows[0]?.deleted_count) || 0;
    }

    // ── Session Metric Summaries ─────────────────────────────

    async getSessionMetricSummary(sessionId: string): Promise<SessionMetricSummary | null> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionMetricSummary}($1)`,
            [sessionId],
        );
        return rows.length > 0 ? rowToSessionMetricSummary(rows[0]) : null;
    }

    async getSessionEventStats(sessionId: string, afterSeq?: number): Promise<SessionEventStats> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionEventStats}($1, $2)`,
            [sessionId, afterSeq ?? null],
        );
        const row = rows[0] ?? {};
        return {
            eventCount: Number(row.event_count ?? 0),
            dataBytes: Number(row.data_bytes ?? 0),
            maxSeq: Number(row.max_seq ?? 0),
        };
    }

    async getSessionCompactionStats(sessionId: string, afterSeq?: number): Promise<SessionCompactionStats> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionCompactionStats}($1, $2)`,
            [sessionId, afterSeq ?? null],
        );
        const row = rows[0] ?? {};
        const toMs = (v: unknown): number | null => {
            if (v instanceof Date) return v.getTime();
            if (typeof v === "string") { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
            return null;
        };
        return {
            starts: Number(row.starts ?? 0),
            completes: Number(row.completes ?? 0),
            failed: Number(row.failed ?? 0),
            tokensRemoved: Number(row.tokens_removed ?? 0),
            lastStartAtMs: toMs(row.last_start_at),
            lastCompleteAtMs: toMs(row.last_complete_at),
        };
    }

    async recordEpochCommitted(sessionId: string, payload: Record<string, unknown>): Promise<number> {
        const { rows } = await this.pool.query(
            `SELECT ${this.sql.fn.recordEpochCommitted}($1, $2) AS seq`,
            [sessionId, JSON.stringify(payload)],
        );
        return Number(rows[0]?.seq ?? 0);
    }

    async recordRegenerated(sessionId: string, payload: Record<string, unknown>): Promise<number> {
        const { rows } = await this.pool.query(
            `SELECT ${this.sql.fn.recordRegenerated}($1, $2) AS seq`,
            [sessionId, JSON.stringify(payload)],
        );
        return Number(rows[0]?.seq ?? 0);
    }

    async getSessionTreeStats(sessionId: string): Promise<SessionTreeStats | null> {
        const self = await this.getSessionMetricSummary(sessionId);
        if (!self) return null;

        const [{ rows }, { rows: modelRows }] = await Promise.all([
            this.pool.query(
                `SELECT * FROM ${this.sql.fn.getSessionTreeStats}($1)`,
                [sessionId],
            ),
            this.pool.query(
                `SELECT * FROM ${this.sql.fn.getSessionTreeStatsByModel}($1)`,
                [sessionId],
            ),
        ]);

        const r = rows[0];
        const treeTokensInput = Number(r.total_tokens_input) || 0;
        const treeTokensCacheRead = Number(r.total_tokens_cache_read) || 0;
        const byModel = modelRows.map((mr: any) => {
            const input = Number(mr.total_tokens_input) || 0;
            const cacheRead = Number(mr.total_tokens_cache_read) || 0;
            return {
                model: String(mr.model || "(unknown)"),
                sessionCount: Number(mr.session_count) || 0,
                turnCount: Number(mr.turn_count) || 0,
                totalTokensInput: input,
                totalTokensOutput: Number(mr.total_tokens_output) || 0,
                totalTokensCacheRead: cacheRead,
                totalTokensCacheWrite: Number(mr.total_tokens_cache_write) || 0,
                totalSnapshotSizeBytes: Number(mr.total_snapshot_size_bytes) || 0,
                cacheHitRatio: computeCacheHitRatio(input, cacheRead),
            };
        });
        return {
            rootSessionId: sessionId,
            self,
            tree: {
                sessionCount: Number(r.session_count) || 0,
                totalTokensInput: treeTokensInput,
                totalTokensOutput: Number(r.total_tokens_output) || 0,
                totalTokensCacheRead: treeTokensCacheRead,
                totalTokensCacheWrite: Number(r.total_tokens_cache_write) || 0,
                cacheHitRatio: computeCacheHitRatio(treeTokensInput, treeTokensCacheRead),
                totalDehydrationCount: Number(r.total_dehydration_count) || 0,
                totalHydrationCount: Number(r.total_hydration_count) || 0,
                totalLossyHandoffCount: Number(r.total_lossy_handoff_count) || 0,
                totalSnapshotSizeBytes: Number(r.total_snapshot_size_bytes) || 0,
                totalRawSizeBytes: Number(r.total_raw_size_bytes) || 0,
            },
            byModel,
        };
    }

    async getFleetStats(opts?: { includeDeleted?: boolean; since?: Date }): Promise<FleetStats> {
        const includeDeleted = opts?.includeDeleted ?? false;
        const since = opts?.since ?? null;

        // Per-group breakdown
        const { rows: groups } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getFleetStatsByAgent}($1, $2)`,
            [includeDeleted, since],
        );

        // Totals + earliest date
        const { rows: totalsRows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getFleetStatsTotals}($1, $2)`,
            [includeDeleted, since],
        );

        const t = totalsRows[0];
        const totalsTokensInput = Number(t.total_tokens_input) || 0;
        const totalsTokensCacheRead = Number(t.total_tokens_cache_read) || 0;
        return {
            windowStart: opts?.since ? opts.since.getTime() : null,
            earliestSessionCreatedAt: t.earliest_session_created_at
                ? new Date(t.earliest_session_created_at).getTime()
                : null,
            byAgent: groups.map((g: any) => {
                const tokensInput = Number(g.total_tokens_input) || 0;
                const tokensCacheRead = Number(g.total_tokens_cache_read) || 0;
                return {
                    agentId: g.agent_id ?? null,
                    model: g.model ?? null,
                    sessionCount: Number(g.session_count) || 0,
                    turnCount: Number(g.turn_count) || 0,
                    totalSnapshotSizeBytes: Number(g.total_snapshot_size_bytes) || 0,
                    totalDehydrationCount: Number(g.total_dehydration_count) || 0,
                    totalHydrationCount: Number(g.total_hydration_count) || 0,
                    totalLossyHandoffCount: Number(g.total_lossy_handoff_count) || 0,
                    totalTokensInput: tokensInput,
                    totalTokensOutput: Number(g.total_tokens_output) || 0,
                    totalTokensCacheRead: tokensCacheRead,
                    totalTokensCacheWrite: Number(g.total_tokens_cache_write) || 0,
                    cacheHitRatio: computeCacheHitRatio(tokensInput, tokensCacheRead),
                };
            }),
            totals: {
                sessionCount: Number(t.session_count) || 0,
                totalSnapshotSizeBytes: Number(t.total_snapshot_size_bytes) || 0,
                totalRawSizeBytes: Number(t.total_raw_size_bytes) || 0,
                totalTokensInput: totalsTokensInput,
                totalTokensOutput: Number(t.total_tokens_output) || 0,
                totalTokensCacheRead: totalsTokensCacheRead,
                totalTokensCacheWrite: Number(t.total_tokens_cache_write) || 0,
                cacheHitRatio: computeCacheHitRatio(totalsTokensInput, totalsTokensCacheRead),
            },
        };
    }

    async getUserStats(opts?: { includeDeleted?: boolean; since?: Date }): Promise<UserStats> {
        const includeDeleted = opts?.includeDeleted ?? false;
        const since = opts?.since ?? null;
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getUserStatsByModel}($1, $2)`,
            [includeDeleted, since],
        );

        const byOwner = new Map<string, UserStatsBucket>();
        let earliestSessionCreatedAt: number | null = null;
        const totals = {
            sessionCount: 0,
            totalSnapshotSizeBytes: 0,
            totalOrchestrationHistorySizeBytes: 0,
            totalTokensInput: 0,
            totalTokensOutput: 0,
            totalTokensCacheRead: 0,
            totalTokensCacheWrite: 0,
            cacheHitRatio: null as number | null,
        };

        for (const row of rows) {
            const ownerKind = normalizeOwnerKind(row.owner_kind);
            const owner = ownerKind === "user" && row.owner_provider && row.owner_subject
                ? {
                    provider: row.owner_provider,
                    subject: row.owner_subject,
                    email: row.owner_email ?? null,
                    displayName: row.owner_display_name ?? null,
                }
                : null;
            const ownerKey = userStatsOwnerKey(ownerKind, owner);
            const sessionIds = Array.isArray(row.session_ids)
                ? row.session_ids.map((id: unknown) => String(id || "")).filter(Boolean)
                : [];
            const tokensInput = Number(row.total_tokens_input) || 0;
            const tokensCacheRead = Number(row.total_tokens_cache_read) || 0;
            const modelBucket: UserStatsModelBucket = {
                model: row.model ?? null,
                sessionIds,
                sessionCount: Number(row.session_count) || 0,
                turnCount: Number(row.turn_count) || 0,
                totalSnapshotSizeBytes: Number(row.total_snapshot_size_bytes) || 0,
                totalOrchestrationHistorySizeBytes: 0,
                totalDehydrationCount: Number(row.total_dehydration_count) || 0,
                totalHydrationCount: Number(row.total_hydration_count) || 0,
                totalLossyHandoffCount: Number(row.total_lossy_handoff_count) || 0,
                totalTokensInput: tokensInput,
                totalTokensOutput: Number(row.total_tokens_output) || 0,
                totalTokensCacheRead: tokensCacheRead,
                totalTokensCacheWrite: Number(row.total_tokens_cache_write) || 0,
                cacheHitRatio: computeCacheHitRatio(tokensInput, tokensCacheRead),
            };

            let bucket = byOwner.get(ownerKey);
            if (!bucket) {
                bucket = {
                    ownerKind,
                    owner,
                    sessionIds: [],
                    sessionCount: 0,
                    totalSnapshotSizeBytes: 0,
                    totalOrchestrationHistorySizeBytes: 0,
                    totalTokensInput: 0,
                    totalTokensOutput: 0,
                    totalTokensCacheRead: 0,
                    totalTokensCacheWrite: 0,
                    cacheHitRatio: null,
                    byModel: [],
                };
                byOwner.set(ownerKey, bucket);
            }

            bucket.byModel.push(modelBucket);
            bucket.sessionIds.push(...sessionIds);
            bucket.sessionCount += modelBucket.sessionCount;
            bucket.totalSnapshotSizeBytes += modelBucket.totalSnapshotSizeBytes;
            bucket.totalTokensInput += modelBucket.totalTokensInput;
            bucket.totalTokensOutput += modelBucket.totalTokensOutput;
            bucket.totalTokensCacheRead += modelBucket.totalTokensCacheRead;
            bucket.totalTokensCacheWrite += modelBucket.totalTokensCacheWrite;

            totals.sessionCount += modelBucket.sessionCount;
            totals.totalSnapshotSizeBytes += modelBucket.totalSnapshotSizeBytes;
            totals.totalTokensInput += modelBucket.totalTokensInput;
            totals.totalTokensOutput += modelBucket.totalTokensOutput;
            totals.totalTokensCacheRead += modelBucket.totalTokensCacheRead;
            totals.totalTokensCacheWrite += modelBucket.totalTokensCacheWrite;

            if (row.earliest_session_created_at) {
                const ts = new Date(row.earliest_session_created_at).getTime();
                if (Number.isFinite(ts) && (earliestSessionCreatedAt == null || ts < earliestSessionCreatedAt)) {
                    earliestSessionCreatedAt = ts;
                }
            }
        }

        const users = Array.from(byOwner.values()).map((bucket) => ({
            ...bucket,
            sessionIds: [...new Set(bucket.sessionIds)],
            cacheHitRatio: computeCacheHitRatio(bucket.totalTokensInput, bucket.totalTokensCacheRead),
            byModel: bucket.byModel.sort((a, b) =>
                (b.totalTokensInput - a.totalTokensInput)
                || String(a.model || "").localeCompare(String(b.model || "")),
            ),
        })).sort((a, b) =>
            (b.totalTokensInput - a.totalTokensInput)
            || (b.totalSnapshotSizeBytes - a.totalSnapshotSizeBytes)
            || userStatsOwnerLabel(a).localeCompare(userStatsOwnerLabel(b)),
        );

        return {
            windowStart: opts?.since ? opts.since.getTime() : null,
            earliestSessionCreatedAt,
            users,
            totals: {
                ...totals,
                cacheHitRatio: computeCacheHitRatio(totals.totalTokensInput, totals.totalTokensCacheRead),
            },
        };
    }

    async upsertSessionMetricSummary(sessionId: string, updates: SessionMetricSummaryUpsert): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.upsertSessionMetricSummary}($1, $2)`,
            [sessionId, JSON.stringify(updates)],
        );
    }

    async getUserProfile(principal: UserPrincipal): Promise<UserProfile | null> {
        const provider = principal?.provider?.trim();
        const subject = principal?.subject?.trim();
        if (!provider || !subject) return null;
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getUserProfile}($1, $2)`,
            [provider, subject],
        );
        if (rows.length === 0) return null;
        return rowToUserProfile(rows[0]);
    }

    async getUserGitHubCopilotKey(principal: UserPrincipal): Promise<string | null> {
        const provider = principal?.provider?.trim();
        const subject = principal?.subject?.trim();
        if (!provider || !subject) return null;
        const { rows } = await this.pool.query(
            `SELECT ${this.sql.fn.getUserGitHubCopilotKey}($1, $2) AS key`,
            [provider, subject],
        );
        const raw = rows[0]?.key;
        if (raw == null) return null;
        const text = String(raw);
        return text.length === 0 ? null : text;
    }

    async setUserProfileSettings(principal: UserPrincipal, settings: Record<string, unknown>): Promise<UserProfile> {
        const provider = principal?.provider?.trim();
        const subject = principal?.subject?.trim();
        if (!provider || !subject) {
            throw new Error("setUserProfileSettings: provider and subject are required");
        }
        const safeSettings = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
        await this.pool.query(
            `SELECT ${this.sql.fn.setUserProfileSettings}($1, $2, $3, $4, $5::jsonb)`,
            [
                provider,
                subject,
                principal.email ?? null,
                principal.displayName ?? null,
                JSON.stringify(safeSettings),
            ],
        );
        const profile = await this.getUserProfile(principal);
        if (!profile) {
            throw new Error("setUserProfileSettings: failed to read back the user profile after write");
        }
        return profile;
    }

    async setUserGitHubCopilotKey(principal: UserPrincipal, key: string | null): Promise<UserProfile> {
        const provider = principal?.provider?.trim();
        const subject = principal?.subject?.trim();
        if (!provider || !subject) {
            throw new Error("setUserGitHubCopilotKey: provider and subject are required");
        }
        const normalized = typeof key === "string" && key.trim().length > 0 ? key.trim() : null;
        await this.pool.query(
            `SELECT ${this.sql.fn.setUserGitHubCopilotKey}($1, $2, $3, $4, $5)`,
            [
                provider,
                subject,
                principal.email ?? null,
                principal.displayName ?? null,
                normalized,
            ],
        );
        const profile = await this.getUserProfile(principal);
        if (!profile) {
            throw new Error("setUserGitHubCopilotKey: failed to read back the user profile after write");
        }
        return profile;
    }

    async getUserRole(principal: UserPrincipal): Promise<UserRoleInfo> {
        const provider = principal?.provider?.trim();
        const subject = principal?.subject?.trim();
        if (!provider || !subject) return { role: null, seenAt: null };
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getUserRole}($1, $2)`,
            [provider, subject],
        );
        // No row and a NULL role are the same answer. Collapsing them here
        // keeps every caller from having to remember that they are.
        if (rows.length === 0) return { role: null, seenAt: null };
        const seenAtRaw = rows[0]?.role_seen_at;
        return {
            role: normalizeUserRole(rows[0]?.role),
            seenAt: seenAtRaw ? new Date(seenAtRaw) : null,
        };
    }

    async setUserRole(principal: UserPrincipal, role: string | null): Promise<UserRoleValue | null> {
        const provider = principal?.provider?.trim();
        const subject = principal?.subject?.trim();
        if (!provider || !subject) {
            throw new Error("setUserRole: provider and subject are required");
        }
        // Normalize on the way in as well as in SQL. The proc is authoritative
        // (it is what protects the column from any other caller), but doing it
        // here too means the value returned to the portal is the value stored,
        // without a read-back.
        const normalized = normalizeUserRole(role);
        const { rows } = await this.pool.query(
            `SELECT ${this.sql.fn.setUserRole}($1, $2, $3, $4, $5) AS role`,
            [
                provider,
                subject,
                principal.email ?? null,
                principal.displayName ?? null,
                normalized,
            ],
        );
        return normalizeUserRole(rows[0]?.role);
    }

    async pruneDeletedSummaries(olderThan: Date): Promise<number> {
        const { rows } = await this.pool.query(
            `SELECT ${this.sql.fn.pruneDeletedSummaries}($1) AS deleted_count`,
            [olderThan],
        );
        return Number(rows[0]?.deleted_count) || 0;
    }

    async getSessionSkillUsage(sessionId: string, opts?: { since?: Date }): Promise<SkillUsageRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionSkillUsage}($1, $2)`,
            [sessionId, opts?.since ?? null],
        );
        return rows.map(rowToSkillUsageRow);
    }

    async getSessionTreeSkillUsage(sessionId: string, opts?: { since?: Date }): Promise<SessionTreeSkillUsage> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionTreeSkillUsage}($1, $2)`,
            [sessionId, opts?.since ?? null],
        );

        const perSessionMap = new Map<string, { agentId: string | null; skills: SkillUsageRow[] }>();
        const rolledUpMap = new Map<string, SkillUsageRow>();
        let totalInvocations = 0;

        for (const r of rows) {
            const sid = String(r.session_id);
            const item = rowToSkillUsageRow(r);
            const bucket = perSessionMap.get(sid)
                ?? ({ agentId: (r.agent_id ?? null) as string | null, skills: [] as SkillUsageRow[] });
            bucket.skills.push(item);
            perSessionMap.set(sid, bucket);

            const key = `${item.kind}\u0001${item.name}\u0001${item.pluginName ?? ""}\u0001${item.pluginVersion ?? ""}`;
            const existing = rolledUpMap.get(key);
            if (existing) {
                existing.invocations += item.invocations;
                if (item.firstUsedAt < existing.firstUsedAt) existing.firstUsedAt = item.firstUsedAt;
                if (item.lastUsedAt > existing.lastUsedAt) existing.lastUsedAt = item.lastUsedAt;
            } else {
                rolledUpMap.set(key, { ...item });
            }
            totalInvocations += item.invocations;
        }

        const rolledUp = Array.from(rolledUpMap.values()).sort((a, b) =>
            b.invocations - a.invocations || b.lastUsedAt.getTime() - a.lastUsedAt.getTime(),
        );

        const perSession = Array.from(perSessionMap.entries()).map(([sid, bucket]) => ({
            sessionId: sid,
            agentId: bucket.agentId,
            skills: bucket.skills,
        }));

        return {
            rootSessionId: sessionId,
            perSession,
            rolledUp,
            totalInvocations,
        };
    }

    async getFleetSkillUsage(opts?: { since?: Date; includeDeleted?: boolean }): Promise<FleetSkillUsage> {
        const since = opts?.since ?? null;
        const includeDeleted = opts?.includeDeleted ?? false;
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getFleetSkillUsage}($1, $2)`,
            [since, includeDeleted],
        );
        return {
            windowStart: opts?.since ? opts.since.getTime() : null,
            rows: rows.map((r: any): FleetSkillUsageRow => ({
                ...rowToSkillUsageRow(r),
                agentId: r.agent_id ?? null,
                sessionCount: Number(r.session_count) || 0,
            })),
        };
    }

    async getSessionRetrievalUsage(sessionId: string, opts?: { since?: Date }): Promise<RetrievalUsageRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionRetrievalUsage}($1, $2)`,
            [sessionId, opts?.since ?? null],
        );
        return rows.map(rowToRetrievalUsageRow);
    }

    async getSessionTreeRetrievalUsage(sessionId: string, opts?: { since?: Date }): Promise<SessionTreeRetrievalUsage> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionTreeRetrievalUsage}($1, $2)`,
            [sessionId, opts?.since ?? null],
        );

        const perSessionMap = new Map<string, { agentId: string | null; rows: RetrievalUsageRow[] }>();
        const rolledUpMap = new Map<string, RetrievalUsageRow>();
        let totalCalls = 0;

        for (const r of rows) {
            const sid = String(r.session_id);
            const item = rowToRetrievalUsageRow(r);
            const bucket = perSessionMap.get(sid)
                ?? ({ agentId: (r.agent_id ?? null) as string | null, rows: [] as RetrievalUsageRow[] });
            bucket.rows.push(item);
            perSessionMap.set(sid, bucket);

            const key = `${item.surface}\u0001${item.operation}\u0001${item.namespace ?? ""}`;
            const existing = rolledUpMap.get(key);
            if (existing) {
                const nextCalls = existing.calls + item.calls;
                existing.totalResults += item.totalResults;
                existing.totalDurationMs = sumNullable(existing.totalDurationMs, item.totalDurationMs);
                existing.calls = nextCalls;
                existing.avgResults = nextCalls > 0 ? existing.totalResults / nextCalls : 0;
                existing.avgDurationMs = existing.totalDurationMs != null && nextCalls > 0 ? existing.totalDurationMs / nextCalls : null;
                if (item.firstUsedAt < existing.firstUsedAt) existing.firstUsedAt = item.firstUsedAt;
                if (item.lastUsedAt > existing.lastUsedAt) existing.lastUsedAt = item.lastUsedAt;
            } else {
                rolledUpMap.set(key, { ...item });
            }
            totalCalls += item.calls;
        }

        const rolledUp = Array.from(rolledUpMap.values()).sort((a, b) =>
            b.calls - a.calls || b.lastUsedAt.getTime() - a.lastUsedAt.getTime(),
        );
        const perSession = Array.from(perSessionMap.entries()).map(([sid, bucket]) => ({
            sessionId: sid,
            agentId: bucket.agentId,
            rows: bucket.rows,
        }));

        return { rootSessionId: sessionId, perSession, rolledUp, totalCalls };
    }

    async getFleetRetrievalUsage(opts?: { since?: Date; includeDeleted?: boolean }): Promise<FleetRetrievalUsage> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getFleetRetrievalUsage}($1, $2)`,
            [opts?.since ?? null, opts?.includeDeleted ?? false],
        );
        return {
            windowStart: opts?.since ? opts.since.getTime() : null,
            rows: rows.map((r: any): FleetRetrievalUsageRow => ({
                ...rowToRetrievalUsageRow(r),
                agentId: r.agent_id ?? null,
                sessionCount: Number(r.session_count) || 0,
            })),
        };
    }

    async getSessionGraphNodeUsage(sessionId: string, opts?: { since?: Date; limit?: number; nodeKeyLike?: string; kind?: GraphNodeUsageKind }): Promise<GraphNodeUsageRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionGraphNodeUsage}($1, $2, $3, $4, $5)`,
            [sessionId, opts?.since ?? null, opts?.limit ?? null, opts?.nodeKeyLike ?? null, opts?.kind ?? null],
        );
        return rows.map(rowToGraphNodeUsageRow);
    }

    async getFleetGraphNodeUsage(opts?: { since?: Date; includeDeleted?: boolean; limit?: number; nodeKeyLike?: string; kind?: GraphNodeUsageKind }): Promise<FleetGraphNodeUsage> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getFleetGraphNodeUsage}($1, $2, $3, $4, $5)`,
            [opts?.since ?? null, opts?.includeDeleted ?? false, opts?.limit ?? null, opts?.nodeKeyLike ?? null, opts?.kind ?? null],
        );
        return {
            windowStart: opts?.since ? opts.since.getTime() : null,
            rows: rows.map((r: any): FleetGraphNodeUsageRow => ({
                ...rowToGraphNodeUsageRow(r),
                agentId: r.agent_id ?? null,
                sessionCount: Number(r.session_count) || 0,
            })),
        };
    }

    async getSessionGraphEdgeSearchUsage(sessionId: string, opts?: { since?: Date; limit?: number }): Promise<GraphEdgeSearchUsageRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionGraphEdgeSearchUsage}($1, $2, $3)`,
            [sessionId, opts?.since ?? null, opts?.limit ?? null],
        );
        return rows.map(rowToGraphEdgeSearchUsageRow);
    }

    // ── Agent packages (migration 0038) ──────────────────────

    async workerHeartbeat(input: WorkerHeartbeatInput): Promise<EffectiveDirective[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.workerHeartbeat}($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                input.workerNodeId,
                input.pool ?? null,
                input.phase ?? "ready",
                input.owner?.provider ?? null,
                input.owner?.subject ?? null,
                JSON.stringify(input.info ?? {}),
                JSON.stringify(input.health ?? {}),
                JSON.stringify(input.state ?? {}),
            ],
        );
        return rows.map((row: any) => ({
            domain: row.domain,
            epoch: Number(row.epoch) || 0,
            actuation: row.actuation === "external" ? "external" as const : "worker" as const,
            desired: row.desired ?? {},
        }));
    }

    async listWorkers(): Promise<WorkerRow[]> {
        const { rows } = await this.pool.query(`SELECT * FROM ${this.sql.fn.listWorkers}()`);
        return rows.map((row: any) => ({
            workerNodeId: row.worker_node_id,
            pool: row.pool,
            phase: (["starting", "ready", "draining"].includes(row.phase) ? row.phase : "ready") as WorkerPhase,
            owner: rowToAgentPrincipal(row),
            registeredAt: new Date(row.registered_at),
            updatedAt: new Date(row.updated_at),
            info: row.info ?? {},
            health: row.health ?? {},
            state: row.state ?? {},
        }));
    }

    async fleetDirectiveBump(domain: string, opts: {
        pool?: string | null;
        workerNodeId?: string | null;
        desired?: Record<string, unknown> | null;
        actuation?: "worker" | "external";
        updatedBy?: string | null;
    } = {}): Promise<number> {
        const { rows } = await this.pool.query(
            `SELECT ${this.sql.fn.fleetDirectiveBump}($1, $2, $3, $4, $5, $6) AS epoch`,
            [
                domain,
                opts.pool ?? null,
                opts.workerNodeId ?? null,
                opts.desired == null ? null : JSON.stringify(opts.desired),
                opts.actuation ?? null,
                opts.updatedBy ?? null,
            ],
        );
        return Number(rows[0]?.epoch) || 0;
    }

    async getFleetDirectives(): Promise<FleetDirectiveRow[]> {
        const { rows } = await this.pool.query(`SELECT * FROM ${this.sql.fn.getFleetDirectives}()`);
        return rows.map((row: any) => ({
            domain: row.domain,
            pool: row.pool,
            workerNodeId: row.worker_node_id,
            epoch: Number(row.epoch) || 0,
            actuation: row.actuation === "external" ? "external" as const : "worker" as const,
            desired: row.desired ?? {},
            updatedAt: new Date(row.updated_at),
            updatedBy: row.updated_by ?? null,
        }));
    }

    async agentRegistryEpoch(): Promise<number> {
        const { rows } = await this.pool.query(`SELECT ${this.sql.fn.agentRegistryEpoch}() AS epoch`);
        return Number(rows[0]?.epoch ?? 0);
    }

    async registerAgentSource(source: {
        sourceId: string;
        kind: "github" | "ado" | "url" | "upload";
        scope: AgentPackageScope;
        repoUrl?: string | null;
        ref?: string | null;
        path?: string | null;
        url?: string | null;
        authToken?: string | null;
        autoSync?: boolean;
        owner: AgentPrincipal | null;
        createdBy?: string | null;
    }): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.registerAgentSource}($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
                source.sourceId, source.kind, source.scope, source.repoUrl ?? null, source.ref ?? null,
                source.path ?? null, source.url ?? null, source.authToken ?? null,
                source.autoSync ?? false, source.owner?.provider ?? null,
                source.owner?.subject ?? null, source.createdBy ?? null,
            ],
        );
    }

    async listAgentSources(viewer: AgentPrincipal | null, isAdmin: boolean): Promise<AgentSourceRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.listAgentSources}($1, $2, $3)`,
            [viewer?.provider ?? null, viewer?.subject ?? null, isAdmin],
        );
        return rows.map(rowToAgentSourceRow);
    }

    async getAgentSource(sourceId: string): Promise<AgentSourceRow | null> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getAgentSource}($1)`,
            [sourceId],
        );
        return rows.length > 0 ? rowToAgentSourceRow(rows[0]) : null;
    }

    async getAgentSourceToken(sourceId: string): Promise<string | null> {
        const { rows } = await this.pool.query(
            `SELECT ${this.sql.fn.getAgentSourceToken}($1) AS token`,
            [sourceId],
        );
        return rows[0]?.token ?? null;
    }

    async updateAgentSourceSync(sourceId: string, status: string, error: string | null, commitSha: string | null): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.updateAgentSourceSync}($1, $2, $3, $4)`,
            [sourceId, status, error, commitSha],
        );
    }

    async deleteAgentSource(sourceId: string, actor: AgentPrincipal | null, isAdmin: boolean): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.deleteAgentSource}($1, $2, $3, $4)`,
            [sourceId, actor?.provider ?? null, actor?.subject ?? null, isAdmin],
        );
    }

    async publishAgentPackage(input: PublishAgentPackageInput): Promise<PublishAgentPackageResult> {
        const packageId = randomUUID();
        const versionId = randomUUID();
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.publishAgentPackage}($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
            [
                packageId, versionId, input.name, input.scope,
                input.owner?.provider ?? null, input.owner?.subject ?? null,
                input.sourceId, input.semver, input.sha256, input.sizeBytes,
                input.artifactFilename, input.commitSha,
                JSON.stringify(input.manifest ?? {}), input.createdBy, input.isAdmin,
            ],
        );
        const row = rows[0] ?? {};
        return {
            status: row.status === "noop" ? "noop" : "published",
            packageId: String(row.package_id ?? packageId),
            versionId: String(row.version_id ?? versionId),
        };
    }

    async listAgentPackages(viewer: AgentPrincipal | null, isAdmin: boolean): Promise<AgentPackageSummary[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.listAgentPackages}($1, $2, $3)`,
            [viewer?.provider ?? null, viewer?.subject ?? null, isAdmin],
        );
        return rows.map(rowToAgentPackageSummary);
    }

    async getAgentPackage(name: string, viewer: AgentPrincipal | null, isAdmin: boolean, selector?: AgentPackageSelector | null): Promise<AgentPackageDetail | null> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getAgentPackage}($1, $2, $3, $4, $5, $6, $7)`,
            [name, viewer?.provider ?? null, viewer?.subject ?? null, isAdmin, ...selectorArgs(selector)],
        );
        if (rows.length === 0) return null;
        const first = rows[0];
        const versions = rows
            .filter((r: any) => r.version_id != null)
            .map(rowToAgentPackageVersion);
        const scope: AgentPackageScope = first.scope === "user" ? "user" : "shared";
        // Editors exist only on the shared copy; the list function pins it.
        const editors = scope === "shared" ? await this.listAgentPackageEditors(name) : [];
        return {
            packageId: first.package_id,
            sourceId: first.source_id ?? null,
            name: first.name,
            scope,
            owner: rowToAgentPrincipal(first),
            enabled: Boolean(first.enabled),
            createdBy: first.created_by ?? null,
            createdAt: new Date(first.created_at),
            // The single-package read is already selector-resolved, so it IS
            // the copy the viewer gets — nothing is shadowing it from here.
            shadowed: false,
            canEdit: Boolean(first.can_edit),
            activeVersionId: first.active_version_id ?? null,
            versions,
            editors,
        };
    }

    /**
     * Which package a name means for this viewer, as a package id.
     *
     * Exposed because the WORKER needs the same answer the API gives: agent
     * binding, package reads and package writes must never disagree about
     * which copy of a name they are talking about.
     */
    async resolveAgentPackageId(
        name: string,
        viewer: AgentPrincipal | null,
        selector?: AgentPackageSelector | null,
        opts?: { requireEnabled?: boolean },
    ): Promise<string | null> {
        const { rows } = await this.pool.query(
            `SELECT ${this.sql.fn.resolveAgentPackageId}($1, $2, $3, $4, $5, $6, $7) AS package_id`,
            [
                name,
                viewer?.provider ?? null,
                viewer?.subject ?? null,
                ...selectorArgs(selector),
                opts?.requireEnabled !== false,
            ],
        );
        const id = rows[0]?.package_id;
        return id == null ? null : String(id);
    }

    async getAgentPackagesInstallManifest(): Promise<AgentPackageInstallEntry[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getAgentPackagesInstallManifest}()`,
        );
        return rows.map((row: any) => ({
            packageId: row.package_id,
            name: row.name,
            scope: row.scope === "user" ? "user" as const : "shared" as const,
            owner: rowToAgentPrincipal(row),
            semver: row.semver,
            sha256: row.sha256,
            sizeBytes: Number(row.size_bytes) || 0,
            artifactFilename: row.artifact_filename,
            manifest: row.manifest ?? {},
        }));
    }

    async setAgentPackageScope(name: string, scope: AgentPackageScope, actor: AgentPrincipal | null, isAdmin: boolean, selector?: AgentPackageSelector | null): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.setAgentPackageScope}($1, $2, $3, $4, $5, $6, $7, $8)`,
            [name, scope, actor?.provider ?? null, actor?.subject ?? null, isAdmin, ...selectorArgs(selector)],
        );
    }

    async setAgentPackageEnabled(name: string, enabled: boolean, actor: AgentPrincipal | null, isAdmin: boolean, selector?: AgentPackageSelector | null): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.setAgentPackageEnabled}($1, $2, $3, $4, $5, $6, $7, $8)`,
            [name, enabled, actor?.provider ?? null, actor?.subject ?? null, isAdmin, ...selectorArgs(selector)],
        );
    }

    async pinAgentPackageVersion(name: string, semver: string, actor: AgentPrincipal | null, isAdmin: boolean, selector?: AgentPackageSelector | null): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.pinAgentPackageVersion}($1, $2, $3, $4, $5, $6, $7, $8)`,
            [name, semver, actor?.provider ?? null, actor?.subject ?? null, isAdmin, ...selectorArgs(selector)],
        );
    }

    async deleteAgentPackage(name: string, actor: AgentPrincipal | null, isAdmin: boolean, selector?: AgentPackageSelector | null): Promise<string[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.deleteAgentPackage}($1, $2, $3, $4, $5, $6, $7)`,
            [name, actor?.provider ?? null, actor?.subject ?? null, isAdmin, ...selectorArgs(selector)],
        );
        return rows.map((r: any) => String(r.artifact_filename)).filter(Boolean);
    }

    async isAgentPackageEditor(packageId: string, principal: AgentPrincipal | null): Promise<boolean> {
        if (!principal?.provider || !principal?.subject) return false;
        const { rows } = await this.pool.query(
            `SELECT ${this.sql.fn.isAgentPackageEditor}($1, $2, $3) AS is_editor`,
            [packageId, principal.provider, principal.subject],
        );
        return Boolean(rows[0]?.is_editor);
    }

    async grantAgentPackageEditor(name: string, grantee: AgentPrincipal, actor: AgentPrincipal | null, isAdmin: boolean): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.grantAgentPackageEditor}($1, $2, $3, $4, $5, $6)`,
            [name, grantee.provider, grantee.subject, actor?.provider ?? null, actor?.subject ?? null, isAdmin],
        );
    }

    async revokeAgentPackageEditor(name: string, grantee: AgentPrincipal, actor: AgentPrincipal | null, isAdmin: boolean): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.revokeAgentPackageEditor}($1, $2, $3, $4, $5, $6)`,
            [name, grantee.provider, grantee.subject, actor?.provider ?? null, actor?.subject ?? null, isAdmin],
        );
    }

    async listAgentPackageEditors(name: string): Promise<AgentPackageEditorInfo[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.listAgentPackageEditors}($1)`,
            [name],
        );
        return rows.map(rowToAgentPackageEditor);
    }

    /**
     * How many published version rows reference this artifact blob filename.
     * Blob files are content-addressed (name@semver.sha), so identical bytes
     * published under the same name+semver in two scopes share ONE file. A
     * cleanup path must never delete a blob this reports > 0 for.
     */
    async countAgentPackageArtifactRefs(artifactFilename: string): Promise<number> {
        const { rows } = await this.pool.query(
            `SELECT count(*)::int AS n FROM "${this.sql.schema}".agent_package_versions WHERE artifact_filename = $1`,
            [artifactFilename],
        );
        return Number(rows?.[0]?.n ?? 0);
    }

    async upsertAgentWorkerState(workerNodeId: string, epoch: number, installed: Record<string, unknown>): Promise<void> {
        await this.pool.query(
            `SELECT ${this.sql.fn.upsertAgentWorkerState}($1, $2, $3)`,
            [workerNodeId, epoch, JSON.stringify(installed ?? {})],
        );
    }

    async listAgentWorkerState(): Promise<AgentWorkerStateRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.listAgentWorkerState}()`,
        );
        return rows.map((row: any) => ({
            workerNodeId: row.worker_node_id,
            epoch: Number(row.epoch) || 0,
            installed: row.installed ?? {},
            updatedAt: new Date(row.updated_at),
        }));
    }

    async close(): Promise<void> {
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
        }
    }
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Map a PG row (snake_case) to SessionRow (camelCase). */
function rowToSessionRow(row: any): SessionRow {
    const owner = row.owner_provider && row.owner_subject
        ? {
            provider: row.owner_provider,
            subject: row.owner_subject,
            email: row.owner_email ?? null,
            displayName: row.owner_display_name ?? null,
        }
        : null;
    return {
        sessionId: row.session_id,
        orchestrationId: row.orchestration_id ?? null,
        title: row.title ?? null,
        titleLocked: row.title_locked ?? false,
        state: row.state,
        transcriptEpoch: Number(row.transcript_epoch ?? 0),
        lastRegeneratedAt: row.last_regenerated_at
            ? new Date(row.last_regenerated_at).getTime()
            : null,
        model: row.model ?? null,
        reasoningEffort: row.reasoning_effort ?? null,
        contextTier: row.context_tier ?? null,
        modelResolutionSource: row.model_resolution_source ?? null,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
        lastActiveAt: row.last_active_at ? new Date(row.last_active_at) : null,
        deletedAt: row.deleted_at ? new Date(row.deleted_at) : null,
        currentIteration: row.current_iteration ?? 0,
        lastError: row.last_error ?? null,
        waitReason: row.wait_reason ?? null,
        activeTurnIndex: row.active_turn_index ?? null,
        parentSessionId: row.parent_session_id ?? null,
        isSystem: row.is_system ?? false,
        serviceKind: row.service_kind ?? null,
        serviceOf: row.service_of ?? null,
        agentId: row.agent_id ?? null,
        splash: row.splash ?? null,
        splashMobile: row.splash_mobile ?? null,
        groupId: row.group_id ?? null,
        shortSummary: row.short_summary ?? null,
        summaryState: row.summary_state ?? null,
        summaryUpdatedAt: row.summary_updated_at ? new Date(row.summary_updated_at) : null,
        owner,
        visibility: row.visibility ?? "private",
        rootSessionId: row.root_session_id ?? row.session_id ?? null,
    };
}

function rowToSessionGroupRow(row: any): SessionGroupRow {
    const owner = row.owner_provider && row.owner_subject
        ? {
            provider: row.owner_provider,
            subject: row.owner_subject,
            email: row.owner_email ?? null,
            displayName: row.owner_display_name ?? null,
        }
        : row.owner ?? null;
    return {
        groupId: row.group_id,
        title: row.title,
        description: row.description ?? null,
        owner,
        metadata: row.metadata ?? {},
        memberCount: Number(row.member_count) || 0,
        runningCount: Number(row.running_count) || 0,
        waitingCount: Number(row.waiting_count) || 0,
        completedCount: Number(row.completed_count) || 0,
        failedCount: Number(row.failed_count) || 0,
        cancelledCount: Number(row.cancelled_count) || 0,
        latestActivityAt: row.latest_activity_at ? new Date(row.latest_activity_at) : null,
        latestSummaryUpdatedAt: row.latest_summary_updated_at ? new Date(row.latest_summary_updated_at) : null,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
    };
}

function rowToChildOutcomeRow(row: any): ChildOutcomeRow {
    return {
        childSessionId: row.child_session_id,
        parentSessionId: row.parent_session_id,
        contractJson: row.contract_json ?? null,
        resultJson: row.result_json ?? null,
        verdict: row.verdict ?? null,
        summary: row.summary ?? null,
        completedAt: row.completed_at ? new Date(row.completed_at) : null,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
    };
}

/** Map a PG row to SessionEvent. */
/** Non-empty array of non-empty type strings, or null (no filter). */
function normalizeEventTypes(eventTypes: string[] | undefined): string[] | null {
    if (!Array.isArray(eventTypes)) return null;
    const types = eventTypes.filter((t) => typeof t === "string" && t.length > 0);
    return types.length > 0 ? types : null;
}

/** Postgres 42883: called a proc overload the DB doesn't have (pre-0025). */
function isUndefinedFunctionError(err: unknown): boolean {
    return (err as { code?: string } | null)?.code === "42883";
}

function rowToSessionEvent(row: any): SessionEvent {
    return {
        seq: Number(row.seq),
        sessionId: row.session_id,
        eventType: row.event_type,
        data: row.data,
        createdAt: new Date(row.created_at),
        workerNodeId: row.worker_node_id ?? undefined,
    };
}

/** Map a PG row to TopEventEmitterRow. */
function rowToTopEventEmitterRow(row: any): TopEventEmitterRow {
    return {
        workerNodeId: String(row.worker_node_id),
        eventType: String(row.event_type),
        eventCount: Number(row.event_count) || 0,
        sessionCount: Number(row.session_count) || 0,
        firstSeenAt: row.first_seen_at ? new Date(row.first_seen_at) : null,
        lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at) : null,
    };
}

function rowToTurnMetricRow(row: any): TurnMetricRow {
    return {
        id: Number(row.id),
        sessionId: row.session_id,
        agentId: row.agent_id ?? null,
        model: row.model ?? null,
        reasoningEffort: row.reasoning_effort ?? null,
        turnIndex: Number(row.turn_index) || 0,
        startedAt: new Date(row.started_at),
        endedAt: new Date(row.ended_at),
        durationMs: Number(row.duration_ms) || 0,
        tokensInput: Number(row.tokens_input) || 0,
        tokensOutput: Number(row.tokens_output) || 0,
        tokensCacheRead: Number(row.tokens_cache_read) || 0,
        tokensCacheWrite: Number(row.tokens_cache_write) || 0,
        toolCalls: Number(row.tool_calls) || 0,
        toolErrors: Number(row.tool_errors) || 0,
        resultType: row.result_type ?? null,
        errorMessage: row.error_message ?? null,
        workerNodeId: row.worker_node_id ?? null,
        createdAt: new Date(row.created_at),
    };
}

function rowToHourlyTokenBucketRow(row: any): HourlyTokenBucketRow {
    return {
        hourBucket: new Date(row.hour_bucket),
        turnCount: Number(row.turn_count) || 0,
        totalTokensInput: Number(row.total_tokens_input) || 0,
        totalTokensOutput: Number(row.total_tokens_output) || 0,
        totalTokensCacheRead: Number(row.total_tokens_cache_read) || 0,
        totalTokensCacheWrite: Number(row.total_tokens_cache_write) || 0,
    };
}

function normalizeOwnerKind(value: unknown): UserStatsOwnerKind {
    return value === "system" || value === "unowned" ? value : "user";
}

function userStatsOwnerKey(ownerKind: UserStatsOwnerKind, owner: SessionOwnerInfo | null): string {
    if (ownerKind !== "user") return ownerKind;
    return `${owner?.provider || ""}\u0001${owner?.subject || ""}`;
}

function userStatsOwnerLabel(bucket: { ownerKind: UserStatsOwnerKind; owner: SessionOwnerInfo | null }): string {
    if (bucket.ownerKind === "system") return "system";
    if (bucket.ownerKind === "unowned") return "unowned";
    return String(bucket.owner?.displayName || bucket.owner?.email || bucket.owner?.subject || "user");
}

/** Map a PG row to SessionMetricSummary. */
function rowToSessionMetricSummary(row: any): SessionMetricSummary {
    const tokensInput = Number(row.tokens_input) || 0;
    const tokensCacheRead = Number(row.tokens_cache_read) || 0;
    return {
        sessionId: row.session_id,
        agentId: row.agent_id ?? null,
        model: row.model ?? null,
        reasoningEffort: row.reasoning_effort ?? null,
        parentSessionId: row.parent_session_id ?? null,
        snapshotSizeBytes: Number(row.snapshot_size_bytes) || 0,
        rawSizeBytes: Number(row.raw_size_bytes) || 0,
        dehydrationCount: Number(row.dehydration_count) || 0,
        hydrationCount: Number(row.hydration_count) || 0,
        lossyHandoffCount: Number(row.lossy_handoff_count) || 0,
        lastDehydratedAt: row.last_dehydrated_at ? new Date(row.last_dehydrated_at).getTime() : null,
        lastHydratedAt: row.last_hydrated_at ? new Date(row.last_hydrated_at).getTime() : null,
        lastCheckpointAt: row.last_checkpoint_at ? new Date(row.last_checkpoint_at).getTime() : null,
        tokensInput,
        tokensOutput: Number(row.tokens_output) || 0,
        tokensCacheRead,
        tokensCacheWrite: Number(row.tokens_cache_write) || 0,
        cacheHitRatio: computeCacheHitRatio(tokensInput, tokensCacheRead),
        regenCount: Number(row.regen_count ?? 0),
        lastRegenStats: row.last_regen_stats ?? null,
        deletedAt: row.deleted_at ? new Date(row.deleted_at).getTime() : null,
        createdAt: new Date(row.created_at).getTime(),
        updatedAt: new Date(row.updated_at).getTime(),
    };
}

/** Map a PG row to SkillUsageRow. Used for per-session, tree, and fleet rows. */
function rowToSkillUsageRow(row: any): SkillUsageRow {
    const kind: SkillKind = row.kind === "learned" ? "learned" : "static";
    return {
        kind,
        name: String(row.name ?? ""),
        pluginName: row.plugin_name ?? null,
        pluginVersion: row.plugin_version ?? null,
        invocations: Number(row.invocations) || 0,
        firstUsedAt: new Date(row.first_used_at ?? row.last_used_at),
        lastUsedAt: new Date(row.last_used_at),
    };
}

function normalizeRetrievalSurface(raw: any): RetrievalSurface {
    return raw === "skills" || raw === "graph" ? raw : "facts";
}

function normalizeRetrievalOperation(raw: any): RetrievalOperation {
    switch (raw) {
        case "facts_similar": return "facts_similar";
        case "search_skills": return "search_skills";
        case "graph_search_nodes": return "graph_search_nodes";
        case "graph_search_edges": return "graph_search_edges";
        case "graph_neighbourhood": return "graph_neighbourhood";
        default: return "facts_search";
    }
}

function rowToRetrievalUsageRow(row: any): RetrievalUsageRow {
    return {
        surface: normalizeRetrievalSurface(row.surface),
        operation: normalizeRetrievalOperation(row.operation),
        namespace: row.namespace ?? null,
        calls: Number(row.calls) || 0,
        totalResults: Number(row.total_results) || 0,
        avgResults: Number(row.avg_results) || 0,
        totalDurationMs: row.total_duration_ms == null ? null : Number(row.total_duration_ms),
        avgDurationMs: row.avg_duration_ms == null ? null : Number(row.avg_duration_ms),
        firstUsedAt: new Date(row.first_used_at ?? row.last_used_at),
        lastUsedAt: new Date(row.last_used_at ?? row.first_used_at),
    };
}

function rowToGraphNodeUsageRow(row: any): GraphNodeUsageRow {
    return {
        nodeKey: String(row.node_key ?? ""),
        namespace: row.namespace ?? null,
        operation: normalizeRetrievalOperation(row.operation),
        kind: row.kind === "loaded" ? "loaded" : "searched",
        count: Number(row.count) || 0,
        firstSeenAt: new Date(row.first_seen_at ?? row.last_seen_at),
        lastSeenAt: new Date(row.last_seen_at ?? row.first_seen_at),
    };
}

function rowToGraphEdgeSearchUsageRow(row: any): GraphEdgeSearchUsageRow {
    return {
        predicateKey: row.predicate_key ?? null,
        fromKey: row.from_key ?? null,
        toKey: row.to_key ?? null,
        namespace: row.namespace ?? null,
        calls: Number(row.calls) || 0,
        totalResults: Number(row.total_results) || 0,
        firstSearchedAt: new Date(row.first_searched_at ?? row.last_searched_at),
        lastSearchedAt: new Date(row.last_searched_at ?? row.first_searched_at),
    };
}

function sumNullable(a: number | null, b: number | null): number | null {
    if (a == null && b == null) return null;
    return (a ?? 0) + (b ?? 0);
}

function rowToUserProfile(row: any): UserProfile {
    let parsedSettings: Record<string, unknown> = {};
    const rawSettings = row?.profile_settings;
    if (rawSettings && typeof rawSettings === "object" && !Array.isArray(rawSettings)) {
        parsedSettings = rawSettings as Record<string, unknown>;
    } else if (typeof rawSettings === "string" && rawSettings.length > 0) {
        try {
            const parsed = JSON.parse(rawSettings);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                parsedSettings = parsed as Record<string, unknown>;
            }
        } catch {
            parsedSettings = {};
        }
    }
    return {
        userId: Number(row.user_id) || 0,
        provider: String(row.provider ?? ""),
        subject: String(row.subject ?? ""),
        email: row.email ?? null,
        displayName: row.display_name ?? null,
        profileSettings: parsedSettings,
        githubCopilotKeySet: Boolean(row.github_copilot_key_set),
        createdAt: row.created_at ? new Date(row.created_at) : null,
        updatedAt: row.updated_at ? new Date(row.updated_at) : null,
    };
}

// ─── Agent-package row mappers (migration 0038) ──────────────────

function rowToAgentPrincipal(row: any): AgentPrincipal | null {
    // email/display_name come from the users JOIN added in migration 0041 —
    // the same join the session view has always used. Without them the UI had
    // only an opaque directory id and fell back to the created_by alias, so
    // one person read as "AD" on their sessions and "DA" on their packages.
    return row.owner_provider && row.owner_subject
        ? {
            provider: row.owner_provider,
            subject: row.owner_subject,
            email: row.owner_email ?? null,
            displayName: row.owner_display_name ?? null,
        }
        : null;
}

function rowToAgentSourceRow(row: any): AgentSourceRow {
    return {
        sourceId: row.source_id,
        kind: row.kind,
        scope: row.scope === "shared" ? "shared" : "user",
        repoUrl: row.repo_url ?? null,
        ref: row.ref ?? null,
        path: row.path ?? null,
        url: row.url ?? null,
        authTokenSet: Boolean(row.auth_token_set),
        autoSync: Boolean(row.auto_sync),
        lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at) : null,
        lastSyncStatus: row.last_sync_status ?? null,
        lastSyncError: row.last_sync_error ?? null,
        lastCommitSha: row.last_commit_sha ?? null,
        owner: rowToAgentPrincipal(row),
        createdBy: row.created_by ?? null,
        createdAt: new Date(row.created_at),
    };
}

function rowToAgentPackageVersion(row: any): AgentPackageVersionRow {
    return {
        versionId: row.version_id,
        semver: row.semver,
        sha256: row.sha256,
        sizeBytes: Number(row.size_bytes) || 0,
        artifactFilename: row.artifact_filename,
        commitSha: row.commit_sha ?? null,
        manifest: row.manifest ?? {},
        createdAt: new Date(row.version_created_at ?? row.created_at),
        createdBy: row.version_created_by ?? row.created_by ?? null,
    };
}

function rowToCanvasKv(row: any): { key: string; value: any; rev: number; updatedAt: string } {
    return {
        key: String(row.key),
        value: row.value ?? null,
        rev: Number(row.rev) || 0,
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at ?? ""),
    };
}

function rowToAgentPackageEditor(row: any): AgentPackageEditorInfo {
    return {
        provider: row.provider,
        subject: row.subject,
        email: row.email ?? null,
        displayName: row.display_name ?? null,
        grantedAt: new Date(row.granted_at),
        grantedByDisplay: row.granted_by_display ?? null,
    };
}

function rowToAgentPackageSummary(row: any): AgentPackageSummary {
    return {
        packageId: row.package_id,
        sourceId: row.source_id ?? null,
        name: row.name,
        scope: row.scope === "user" ? "user" : "shared",
        owner: rowToAgentPrincipal(row),
        enabled: Boolean(row.enabled),
        createdBy: row.created_by ?? null,
        createdAt: new Date(row.created_at),
        shadowed: Boolean(row.shadowed),
        canEdit: Boolean(row.can_edit),
        active: row.semver
            ? {
                versionId: row.active_version_id,
                semver: row.semver,
                sha256: row.sha256,
                sizeBytes: Number(row.size_bytes) || 0,
                artifactFilename: row.artifact_filename,
                commitSha: row.commit_sha ?? null,
                manifest: row.manifest ?? {},
                createdAt: new Date(row.version_created_at ?? row.created_at),
                createdBy: row.version_created_by ?? null,
            }
            : null,
    };
}

/** @deprecated Use `SessionCatalog` instead. */
export type SessionCatalogProvider = SessionCatalog;

/** @deprecated Use `PgSessionCatalog` instead. */
export const PgSessionCatalogProvider = PgSessionCatalog;
