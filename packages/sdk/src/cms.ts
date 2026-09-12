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
import { assertExternalOperationValidationGatesSatisfied } from "./job-validation-gates.js";
import { FeatureStore } from "./feature-store.js";
import type { SessionOwnerInfo, SessionSummaryState, GitWorkspaceState } from "./types.js";

// ─── Types ───────────────────────────────────────────────────────

/** Immutable execution-routing fields persisted before a session can start. */
export interface SessionRoutingContract {
    repo?: string;
    gitRef?: string;
    ownerAffinityRequired?: boolean;
}

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

/**
 * Durable git working-tree pointer for a session, used by the pod-side
 * hydration path (see docs/architecture/aks-git-hydration.md §8.5).
 *
 * This is a persistence-layer alias of the platform's canonical
 * {@link GitWorkspaceState} (declared in `types.ts`) so the hook contract and
 * the CMS accessors share a single shape.
 *
 * - `baseSha` is pinned once at turn 0 and never moves unless the session
 *   explicitly advances it; all reconciles target it (never live mirror HEAD).
 * - `headSha` / `branch` describe the session's own committed work.
 * - `epoch` is a monotonic counter bumped on every dehydrate so hydrate can
 *   ignore a stale delta-blob set (the row is the commit point).
 *
 * An unpinned session reads back `{ baseSha: null, headSha: null,
 * branch: null, epoch: 0 }`.
 */
export type SessionGitState = GitWorkspaceState;

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

export type WorkerTimelineEntryKind =
    | "session_event"
    | "state_transition"
    | "job_materialization"
    | "worker_capacity_wait"
    | "external_operation";

export interface WorkerTimelineEntry {
    timelineId: string;
    at: Date;
    kind: WorkerTimelineEntryKind;
    eventType: string;
    workerNodeId: string;
    generatorId: string | null;
    generatorName: string | null;
    jobId: string | null;
    jobKey: string | null;
    stateRunId: string | null;
    stateName: string | null;
    stateRevision: number | null;
    sessionId: string;
    summary: string | null;
    details: Record<string, unknown>;
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

/** Opaque source-provider identifier resolved by the JobGenerator runtime registry. */
export type JobGeneratorSourceType = string;
export type JobGeneratorOperationalState = "enabled" | "paused" | "disabled";
export type JobLifecycleState = "pending_session" | "active" | "blocked" | "completed" | "cancelled";
export type JobSessionStatus = "reserved" | "unacked" | "active" | "failed" | "replaced" | "completed";
export type JobStateRunStatus =
    | "reserved"
    | "unacked"
    | "active"
    | "waiting"
    | "input_required"
    | "completed"
    | "failed";
export type JobWaitKind = "response" | "observed_condition" | "timer";
export type JobWaitStatus = "pending" | "satisfied" | "failed" | "timed_out" | "cancelled";
export type JobWaitDetectionMode = "direct_submission" | "poll" | "event" | "hybrid" | "timer";
export type JobWaitCheckDisposition = "pending" | "satisfied" | "failed" | "timed_out";
export type JobExternalOperationStatus = "pending" | "succeeded" | "failed";
export type JobExternalOperationSignalStatus = "blocked" | "pending" | "delivering" | "delivered";

export interface JobGeneratorRow {
    generatorId: string;
    name: string;
    owner: SessionOwnerInfo;
    cadenceSeconds: number;
    operationalState: JobGeneratorOperationalState;
    activeDefinitionId: string | null;
    nextRunAt: Date;
    watermark: unknown;
    totalCycles: number;
    successfulCycles: number;
    failedCycles: number;
    materializedJobs: number;
    lastCycleAt: Date | null;
    lastError: string | null;
    leaseOwner: string | null;
    leaseExpiresAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface JobGeneratorDefinitionRow {
    definitionId: string;
    generatorId: string;
    version: number;
    sourceType: JobGeneratorSourceType;
    sourceConfig: Record<string, unknown>;
    lifecycleDefinition: Record<string, unknown>;
    affinities: Record<string, unknown>;
    validationGates: unknown[];
    guardrails: Record<string, unknown>;
    createdBy: string | null;
    createdAt: Date;
}

export interface JobGeneratorCycleRow {
    cycleId: string;
    generatorId: string;
    definitionId: string;
    status: "running" | "succeeded" | "failed";
    claimedBy: string;
    watermarkBefore: unknown;
    watermarkAfter: unknown;
    discoveredCount: number;
    createdCount: number;
    error: string | null;
    startedAt: Date;
    completedAt: Date | null;
}

export interface JobCleanupPlan {
    aggregateType: "generator" | "job";
    aggregateId: string;
    generatorId: string;
    jobId: string | null;
    alreadyDeleted: boolean;
    sessionIds: string[];
}

export interface JobCleanupResult {
    aggregateType: "generator" | "job";
    aggregateId: string;
    alreadyDeleted: boolean;
    deletedSessionCount: number;
}

export interface JobRow {
    jobId: string;
    generatorId: string;
    definitionId: string;
    jobKey: string;
    sourcePayload: Record<string, unknown>;
    lifecycleState: JobLifecycleState;
    currentState: string;
    stateRevision: number;
    currentStateEnteredAt: Date;
    firstSeenCycleId: string;
    lastSeenCycleId: string;
    firstDiscoveredAt: Date;
    lastDiscoveredAt: Date;
    sessionAttempts: number;
    sessionError: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface JobSessionRow {
    associationId: string;
    jobId: string;
    sessionId: string;
    stateRunId: string | null;
    ordinal: number;
    isCurrent: boolean;
    status: JobSessionStatus;
    error: string | null;
    reservedAt: Date;
    attachedAt: Date | null;
    endedAt: Date | null;
}

export interface JobStateOutcome {
    outcome: string;
    toState: string;
}

export interface JobStateRunRow {
    stateRunId: string;
    jobId: string;
    definitionId: string;
    stateName: string;
    stateRevision: number;
    stateOwner: "user" | "platform" | null;
    status: JobStateRunStatus;
    sessionId: string | null;
    predecessorJournalEntryId: string | null;
    sourceId: string | null;
    sourcePath: string | null;
    sourceCommit: string | null;
    markdownSha256: string | null;
    allowedOutcomes: JobStateOutcome[];
    terminal: boolean | null;
    attempt: number;
    leaseOwner: string | null;
    leaseExpiresAt: Date | null;
    startedAt: Date | null;
    completedAt: Date | null;
    error: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface JobJournalEntryRow {
    journalEntryId: string;
    jobId: string;
    sequence: number;
    entryKind: "state_transition";
    definitionId: string;
    fromState: string;
    toState: string;
    fromRevision: number;
    toRevision: number;
    stateRunId: string;
    sessionId: string;
    outcome: string | null;
    summary: string;
    idempotencyKey: string;
    transitionedAt: Date;
}

export interface JobSourceSessionContext {
    journalEntry: JobJournalEntryRow;
    events: SessionEvent[];
    hasMore: boolean;
}

export interface JobWaitResponder {
    kind: "user" | "agent" | "system";
    provider?: string;
    subject?: string;
    display?: string;
    relation?: "owner" | "collaborator" | "admin";
    sessionId?: string;
    origin?: "portal" | "tui" | "mcp" | "api";
}

export interface JobWaitRow {
    waitId: string;
    jobId: string;
    stateRunId: string;
    definitionId: string;
    sessionId: string;
    externalOperationId: string | null;
    waitKey: string;
    kind: JobWaitKind;
    status: JobWaitStatus;
    detectionMode: JobWaitDetectionMode;
    expectedStateRevision: number;
    prompt: Record<string, unknown>;
    responseSchema: Record<string, unknown>;
    responderPolicy: Record<string, unknown>;
    provider: string | null;
    target: Record<string, unknown> | null;
    predicate: Record<string, unknown> | null;
    providerCursor: unknown;
    latestObservation: unknown;
    conditionOverrides: string[];
    signalKey: string | null;
    checkAttempts: number;
    consecutiveCheckFailures: number;
    lastCheckedAt: Date | null;
    checkLeaseOwner: string | null;
    checkLeaseExpiresAt: Date | null;
    lastCheckError: string | null;
    waitStartedAt: Date | null;
    waitCompletedAt: Date | null;
    responseId: string | null;
    response: Record<string, unknown> | null;
    responseDeliveryStatus: "none" | "pending" | "enqueued";
    responseEnqueuedAt: Date | null;
    satisfactionEvidence: Record<string, unknown> | null;
    satisfiedBy: JobWaitResponder | null;
    deadlineAt: Date | null;
    nextCheckAt: Date | null;
    satisfiedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface JobExternalOperationRow {
    operationId: string;
    jobId: string;
    stateRunId: string;
    definitionId: string;
    createdSessionId: string;
    sessionId: string;
    provider: string;
    kind: string;
    operationKey: string;
    idempotencyKey: string;
    correlationId: string;
    signalKey: string;
    request: Record<string, unknown>;
    status: JobExternalOperationStatus;
    result: unknown;
    evidence: unknown;
    error: string | null;
    nextPollAt: Date;
    pollLeaseOwner: string | null;
    pollLeaseExpiresAt: Date | null;
    completedAt: Date | null;
    waitStartedAt: Date | null;
    waitCompletedAt: Date | null;
    signalStatus: JobExternalOperationSignalStatus;
    signalAttempts: number;
    nextSignalAt: Date | null;
    signalLeaseOwner: string | null;
    signalLeaseExpiresAt: Date | null;
    signalDeliveredAt: Date | null;
    lastSignalError: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface StartJobExternalOperationInput {
    sessionId: string;
    provider: string;
    kind: string;
    operationKey?: string;
    request?: Record<string, unknown>;
    nextPollAt?: Date;
    deadlineAt?: Date | null;
    detectionMode?: Extract<JobWaitDetectionMode, "poll" | "event" | "hybrid">;
}

export interface JobWaitObserverSelector {
    provider: string;
    kind?: string;
}

export interface StartJobResponseWaitInput {
    sessionId: string;
    waitKey: string;
    question: string;
    choices?: string[];
    allowFreeform?: boolean;
    responderPolicy?: Record<string, unknown>;
    deadlineAt?: Date | null;
}

export interface AcceptJobResponseInput {
    sessionId: string;
    answer: string;
    respondedBy?: JobWaitResponder | null;
}

export interface StartJobTimerWaitInput {
    sessionId: string;
    waitKey: string;
    reason: string;
    dueAt: Date;
}

export interface CompleteJobWaitCheckInput {
    waitId: string;
    workerId: string;
    disposition: JobWaitCheckDisposition;
    observation?: unknown;
    providerCursor?: unknown;
    evidence?: unknown;
    result?: unknown;
    error?: string | null;
    nextCheckAt?: Date | null;
}

export interface CompleteJobExternalOperationInput {
    operationId: string;
    workerId: string;
    status: Exclude<JobExternalOperationStatus, "pending">;
    result?: unknown;
    evidence?: unknown;
    error?: string | null;
}

export interface PrepareJobStateRunInput {
    sessionId: string;
    expectedState: string;
    expectedRevision: number;
    stateOwner: "user" | "platform";
    sourceId: string;
    sourcePath: string;
    sourceCommit: string;
    markdownSha256: string;
    allowedOutcomes: JobStateOutcome[];
    terminal: boolean;
}

const JOB_STATE_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
}

function jobWaitEvidence(value: unknown): Record<string, unknown> | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return { value };
}

function jobLifecycleConfig(definition: Record<string, unknown>): Record<string, unknown> {
    const nested = definition.lifecycle;
    return nested && typeof nested === "object" && !Array.isArray(nested)
        && Object.keys(nested).length > 0
        ? nested as Record<string, unknown>
        : definition;
}

function validateJobLifecycleDefinition(definition: Record<string, unknown>): void {
    const lifecycle = jobLifecycleConfig(definition);
    if (lifecycle.initialState === undefined) return;
    if (typeof lifecycle.initialState !== "string" || !JOB_STATE_NAME_RE.test(lifecycle.initialState)) {
        throw new Error(
            "JobGenerator lifecycle initialState must start with a letter and contain only letters, digits, hyphens, or underscores",
        );
    }
}

function validateJobValidationGates(gates: unknown[]): void {
    for (const value of gates) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const gate = value as Record<string, unknown>;
        if (gate.type !== "external_operation") continue;
        if (typeof gate.beforeState !== "string" || !JOB_STATE_NAME_RE.test(gate.beforeState)) {
            throw new Error("External operation validation gate beforeState is invalid");
        }
        if (typeof gate.kind !== "string" || !/^[a-z][a-z0-9_.-]*$/.test(gate.kind)) {
            throw new Error("External operation validation gate kind must be a lowercase identifier");
        }
        if (gate.provider !== undefined
            && (typeof gate.provider !== "string"
                || !/^[a-z][a-z0-9_.-]*$/.test(gate.provider))) {
            throw new Error("External operation validation gate provider must be a lowercase identifier");
        }
        if (gate.requireEvidence !== undefined && typeof gate.requireEvidence !== "boolean") {
            throw new Error("External operation validation gate requireEvidence must be boolean");
        }
    }
}

export interface CompleteJobStateInput {
    sessionId: string;
    outcome?: string | null;
    summary: string;
    idempotencyKey?: string;
}

export interface JobDiscovery {
    key: string;
    payload: Record<string, unknown>;
}

export interface ReconciledJob extends JobRow {
    created: boolean;
    needsSession: boolean;
}

export interface CreateJobGeneratorInput {
    generatorId?: string;
    definitionId?: string;
    name: string;
    owner: SessionOwnerInfo;
    cadenceSeconds: number;
    operationalState?: JobGeneratorOperationalState;
    nextRunAt?: Date;
    definition: {
        sourceType: JobGeneratorSourceType;
        sourceConfig: Record<string, unknown>;
        lifecycleDefinition?: Record<string, unknown>;
        affinities?: Record<string, unknown>;
        validationGates?: unknown[];
        guardrails?: Record<string, unknown>;
        createdBy?: string | null;
    };
}

export interface SessionCatalog {
    /**
     * Provider budgets (migrations 0049-0051). Optional, like every other
     * late feature here, so a duck-typed test double need not implement it.
     * See provider-store.ts.
     */
    readonly providers?: ProviderStore;
    readonly features?: FeatureStore;

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
    getWorkerTimeline(
        workerNodeId: string,
        options?: { since?: Date; limit?: number },
    ): Promise<WorkerTimelineEntry[]>;
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

    // ── Job generators (migration 0047) ─────────────────────

    registerJobGenerator(input: {
        generatorId?: string;
        name: string;
        owner: SessionOwnerInfo;
        cadenceSeconds: number;
        operationalState?: JobGeneratorOperationalState;
        nextRunAt?: Date;
    }): Promise<JobGeneratorRow>;
    createJobGenerator(input: CreateJobGeneratorInput): Promise<{
        generator: JobGeneratorRow;
        definition: JobGeneratorDefinitionRow;
    }>;
    listJobGenerators(owner?: Pick<SessionOwnerInfo, "provider" | "subject"> | null): Promise<JobGeneratorRow[]>;
    getJobGenerator(generatorId: string, includeDeleted?: boolean): Promise<JobGeneratorRow | null>;
    publishJobGeneratorDefinition(input: {
        definitionId?: string;
        generatorId: string;
        sourceType: JobGeneratorSourceType;
        sourceConfig: Record<string, unknown>;
        lifecycleDefinition?: Record<string, unknown>;
        affinities?: Record<string, unknown>;
        validationGates?: unknown[];
        guardrails?: Record<string, unknown>;
        createdBy?: string | null;
    }): Promise<JobGeneratorDefinitionRow>;
    getJobGeneratorDefinition(definitionId: string): Promise<JobGeneratorDefinitionRow>;
    listJobGeneratorDefinitions(generatorId: string): Promise<JobGeneratorDefinitionRow[]>;
    listJobGeneratorJobs(generatorId: string): Promise<JobRow[]>;
    listJobGeneratorCycles(generatorId: string, limit?: number): Promise<JobGeneratorCycleRow[]>;
    getJob(jobId: string, includeDeleted?: boolean): Promise<JobRow | null>;
    beginJobGeneratorCleanup(input: {
        generatorId: string;
        actor: SessionOwnerInfo;
        isAdmin?: boolean;
    }): Promise<JobCleanupPlan>;
    beginJobCleanup(input: {
        jobId: string;
        actor: SessionOwnerInfo;
        isAdmin?: boolean;
    }): Promise<JobCleanupPlan>;
    recordJobCleanupSessions(
        aggregateType: "generator" | "job",
        aggregateId: string,
        sessionIds: string[],
    ): Promise<string[]>;
    completeJobCleanup(
        aggregateType: "generator" | "job",
        aggregateId: string,
        outcome: { status: "completed" | "failed"; error?: string | null; deletedSessionCount?: number },
    ): Promise<void>;
    beginSessionTreeDeletion(sessionId: string): Promise<void>;
    /** True only while the session remains visible and outside a deletion fence. */
    isSessionActive(sessionId: string): Promise<boolean>;
    getDescendantSessionIdsIncludingDeleted(sessionId: string): Promise<string[]>;
    claimDueJobGenerators(workerId: string, limit?: number, leaseSeconds?: number): Promise<JobGeneratorRow[]>;
    beginJobGeneratorCycle(generatorId: string, workerId: string): Promise<{
        cycle: JobGeneratorCycleRow;
        definition: JobGeneratorDefinitionRow;
    }>;
    completeJobGeneratorCycle(input: {
        cycleId: string;
        workerId: string;
        status: "succeeded" | "failed";
        watermark?: unknown;
        discoveredCount?: number;
        createdCount?: number;
        error?: string | null;
    }): Promise<void>;
    reconcileJobGeneratorDiscoveries(cycleId: string, discoveries: JobDiscovery[]): Promise<ReconciledJob[]>;
    listJobsNeedingSession(generatorId: string, limit?: number): Promise<JobRow[]>;
    reserveJobSession(jobId: string, cycleId: string, workerId: string, sessionId?: string): Promise<JobSessionRow>;
    replaceJobSession(jobId: string, sessionId?: string): Promise<JobSessionRow>;
    attachJobSession(jobId: string, sessionId: string, cycleId: string, workerId: string): Promise<void>;
    prepareJobStateRun(input: PrepareJobStateRunInput): Promise<JobStateRunRow>;
    acknowledgeJobSession(sessionId: string, workerId?: string): Promise<void>;
    setJobSessionExecutionStatus(
        sessionId: string,
        status: "active" | "waiting" | "input_required",
    ): Promise<void>;
    failJobSession(jobId: string, sessionId: string, cycleId: string, workerId: string, error: string): Promise<void>;
    listJobStateRuns(jobId: string): Promise<JobStateRunRow[]>;
    listJobSessions(jobId: string): Promise<JobSessionRow[]>;
    listJobJournal(jobId: string): Promise<JobJournalEntryRow[]>;
    listJobWaits(jobId: string): Promise<JobWaitRow[]>;
    startJobResponseWait(input: StartJobResponseWaitInput): Promise<JobWaitRow | null>;
    acceptJobResponse(input: AcceptJobResponseInput): Promise<JobWaitRow | null>;
    markJobResponseEnqueued(waitId: string, responseId: string): Promise<void>;
    reopenJobResponseWait(waitId: string, responseId: string): Promise<void>;
    startJobTimerWait(input: StartJobTimerWaitInput): Promise<JobWaitRow | null>;
    completeJobTimerWait(sessionId: string): Promise<JobWaitRow | null>;
    cancelJobTimerWait(sessionId: string): Promise<JobWaitRow | null>;
    claimDueJobWaits(
        workerId: string,
        limit?: number,
        leaseSeconds?: number,
        observers?: readonly (string | JobWaitObserverSelector)[],
    ): Promise<JobWaitRow[]>;
    completeJobWaitCheck(input: CompleteJobWaitCheckInput): Promise<JobWaitRow>;
    setJobWaitConditionOverride(
        jobId: string,
        waitId: string,
        conditionKey: string,
        overridden: boolean,
    ): Promise<JobWaitRow>;
    accelerateJobWaitCheck(waitId: string, expectedStateRevision: number, checkAt?: Date): Promise<boolean>;
    accelerateJobWaitChecksByTarget(
        provider: string,
        kind: string,
        resourceKey: string,
        checkAt?: Date,
    ): Promise<number>;
    recordJobWaitBoundary(
        sessionId: string,
        signalKey: string,
        phase: "started" | "completed",
    ): Promise<boolean>;
    readJobSourceSession(
        currentSessionId: string,
        sourceSessionId: string,
        beforeSeq?: number,
        limit?: number,
    ): Promise<JobSourceSessionContext | null>;
    completeJobState(input: CompleteJobStateInput): Promise<JobJournalEntryRow>;
    startJobExternalOperation(input: StartJobExternalOperationInput): Promise<JobExternalOperationRow>;
    getJobExternalOperation(sessionId: string, operationId: string): Promise<JobExternalOperationRow | null>;
    recordJobExternalOperationWait(
        sessionId: string,
        signalKey: string,
        phase: "started" | "completed",
    ): Promise<boolean>;
    claimDueJobExternalOperations(
        provider: string,
        workerId: string,
        limit?: number,
        leaseSeconds?: number,
    ): Promise<JobExternalOperationRow[]>;
    completeJobExternalOperation(input: CompleteJobExternalOperationInput): Promise<JobExternalOperationRow>;
    claimJobExternalOperationSignals(
        workerId: string,
        limit?: number,
        leaseSeconds?: number,
    ): Promise<JobExternalOperationRow[]>;
    markJobExternalOperationSignalDelivered(operationId: string, workerId: string): Promise<void>;
    markJobExternalOperationSignalFailed(
        operationId: string,
        workerId: string,
        error: string,
        retryAt: Date,
    ): Promise<void>;

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
        /** Immutable execution-routing contract for config-less pending-session recovery. */
        routing?: SessionRoutingContract | null;
    }): Promise<void>;

    /**
     * The session's durable creation config (migration 0072), or null.
     * Optional: stores that predate it simply leave the start path on the
     * in-memory map plus the worker-side bound-agent backfill.
     */
    getSessionCreationConfig?(sessionId: string): Promise<Record<string, unknown> | null>;

    /** Read the immutable execution-routing contract stored with the session. */
    getSessionRouting?(sessionId: string): Promise<SessionRoutingContract | null>;

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
     * Saved multi-dashboard MoA settings are retained when a legacy client
     * omits them or submits an older schema; clear them with a v3 layout.
     */
    setUserProfileSettings(principal: UserPrincipal, settings: Record<string, unknown>): Promise<UserProfile>;

    /**
     * Set or clear the per-user GitHub Copilot key. Pass `null` to
     * remove the override (which reverts the user to the worker's
     * env-supplied default).
     */
    setUserGitHubCopilotKey(principal: UserPrincipal, key: string | null): Promise<UserProfile>;

    /**
     * Read the durable git working-tree pointer for a session (see
     * docs/architecture/aks-git-hydration.md §8.5). Returns
     * `{ baseSha: null, headSha: null, branch: null, epoch: 0 }` for an
     * unknown or never-pinned session.
     */
    getSessionGitState(sessionId: string): Promise<SessionGitState>;

    /**
     * Persist the durable git working-tree pointer for a session. Called by
     * the worker's hydration hooks: once at turn 0 to pin `baseSha`, and on
     * every dehydrate to record `headSha`/`branch` and bump `epoch`. The base
     * only moves via an explicit-advance transaction.
     */
    setSessionGitState(sessionId: string, state: SessionGitState): Promise<SessionGitState>;

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
            getSessionGitState:         `${s}.cms_get_session_git_state`,
            setSessionGitState:         `${s}.cms_set_session_git_state`,
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
    readonly features: FeatureStore;

    private constructor(pool: any, schema: string) {
        this.pool = pool;
        this.sql = sqlForSchema(schema);
        this._providers = new ProviderStore(pool, schema);
        this.features = new FeatureStore(pool, schema);
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

        // Bound actual connection establishment/queueing as well as feature
        // query deadlines. Abandoning pool.connect() alone leaves a pending
        // physical connection that can prevent pool.end() during shutdown.
        poolConfig.connectionTimeoutMillis = 10_000;
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

    // ── Job generators ───────────────────────────────────────

    async registerJobGenerator(input: {
        generatorId?: string;
        name: string;
        owner: SessionOwnerInfo;
        cadenceSeconds: number;
        operationalState?: JobGeneratorOperationalState;
        nextRunAt?: Date;
    }): Promise<JobGeneratorRow> {
        const generatorId = input.generatorId ?? randomUUID();
        const name = input.name.trim();
        if (!name) throw new Error("JobGenerator name is required");
        if (!input.owner.provider?.trim() || !input.owner.subject?.trim()) {
            throw new Error("JobGenerator owner provider and subject are required");
        }
        if (!Number.isInteger(input.cadenceSeconds) || input.cadenceSeconds <= 0) {
            throw new Error("JobGenerator cadenceSeconds must be a positive integer");
        }
        const { rows } = await this.pool.query(
            `INSERT INTO "${this.sql.schema}".job_generators (
                 generator_id, name, owner_provider, owner_subject, owner_email,
                 owner_display_name, cadence_seconds, operational_state, next_run_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (generator_id) DO UPDATE SET
                 name = EXCLUDED.name,
                 owner_provider = EXCLUDED.owner_provider,
                 owner_subject = EXCLUDED.owner_subject,
                 owner_email = EXCLUDED.owner_email,
                 owner_display_name = EXCLUDED.owner_display_name,
                 cadence_seconds = EXCLUDED.cadence_seconds,
                 operational_state = EXCLUDED.operational_state,
                 next_run_at = EXCLUDED.next_run_at,
                 updated_at = now()
             RETURNING *`,
            [
                generatorId,
                name,
                input.owner.provider.trim(),
                input.owner.subject.trim(),
                input.owner.email ?? null,
                input.owner.displayName ?? null,
                input.cadenceSeconds,
                input.operationalState ?? "enabled",
                input.nextRunAt ?? new Date(),
            ],
        );
        return rowToJobGenerator(rows[0]);
    }

    async createJobGenerator(input: CreateJobGeneratorInput): Promise<{
        generator: JobGeneratorRow;
        definition: JobGeneratorDefinitionRow;
    }> {
        const generatorId = input.generatorId ?? randomUUID();
        const definitionId = input.definitionId ?? randomUUID();
        const name = input.name.trim();
        if (!name) throw new Error("JobGenerator name is required");
        if (!input.owner.provider?.trim() || !input.owner.subject?.trim()) {
            throw new Error("JobGenerator owner provider and subject are required");
        }
        if (!Number.isInteger(input.cadenceSeconds) || input.cadenceSeconds <= 0) {
            throw new Error("JobGenerator cadenceSeconds must be a positive integer");
        }
        validateJobLifecycleDefinition(input.definition.lifecycleDefinition ?? {});
        validateJobValidationGates(input.definition.validationGates ?? []);
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const generatorResult = await client.query(
                `INSERT INTO "${this.sql.schema}".job_generators (
                     generator_id, name, owner_provider, owner_subject, owner_email,
                     owner_display_name, cadence_seconds, operational_state,
                     active_definition_id, next_run_at
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                 RETURNING *`,
                [
                    generatorId,
                    name,
                    input.owner.provider.trim(),
                    input.owner.subject.trim(),
                    input.owner.email ?? null,
                    input.owner.displayName ?? null,
                    input.cadenceSeconds,
                    input.operationalState ?? "enabled",
                    definitionId,
                    input.nextRunAt ?? new Date(),
                ],
            );
            const definitionResult = await client.query(
                `INSERT INTO "${this.sql.schema}".job_generator_definitions (
                     definition_id, generator_id, version, source_type, source_config,
                     lifecycle_definition, affinities, validation_gates, guardrails, created_by
                 ) VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9)
                 RETURNING *`,
                [
                    definitionId,
                    generatorId,
                    input.definition.sourceType,
                    JSON.stringify(input.definition.sourceConfig ?? {}),
                    JSON.stringify(input.definition.lifecycleDefinition ?? {}),
                    JSON.stringify(input.definition.affinities ?? {}),
                    JSON.stringify(input.definition.validationGates ?? []),
                    JSON.stringify(input.definition.guardrails ?? {}),
                    input.definition.createdBy ?? null,
                ],
            );
            await client.query("COMMIT");
            return {
                generator: rowToJobGenerator(generatorResult.rows[0]),
                definition: rowToJobGeneratorDefinition(definitionResult.rows[0]),
            };
        } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    async listJobGenerators(
        owner?: Pick<SessionOwnerInfo, "provider" | "subject"> | null,
    ): Promise<JobGeneratorRow[]> {
        const { rows } = owner
            ? await this.pool.query(
                `SELECT * FROM "${this.sql.schema}".job_generators
                 WHERE owner_provider = $1 AND owner_subject = $2
                 ORDER BY created_at, generator_id`,
                [owner.provider, owner.subject],
            )
            : await this.pool.query(
                `SELECT * FROM "${this.sql.schema}".job_generators ORDER BY created_at, generator_id`,
            );
        return rows.map(rowToJobGenerator);
    }

    async getJobGenerator(generatorId: string, includeDeleted = false): Promise<JobGeneratorRow | null> {
        const { rows } = await this.pool.query(
            `SELECT * FROM "${this.sql.schema}".job_generators
             WHERE generator_id = $1 AND ($2 OR deleted_at IS NULL)`,
            [generatorId, includeDeleted],
        );
        return rows[0] ? rowToJobGenerator(rows[0]) : null;
    }

    async publishJobGeneratorDefinition(input: {
        definitionId?: string;
        generatorId: string;
        sourceType: JobGeneratorSourceType;
        sourceConfig: Record<string, unknown>;
        lifecycleDefinition?: Record<string, unknown>;
        affinities?: Record<string, unknown>;
        validationGates?: unknown[];
        guardrails?: Record<string, unknown>;
        createdBy?: string | null;
    }): Promise<JobGeneratorDefinitionRow> {
        validateJobLifecycleDefinition(input.lifecycleDefinition ?? {});
        validateJobValidationGates(input.validationGates ?? []);
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const generator = await client.query(
                `SELECT generator_id FROM "${this.sql.schema}".job_generators
                 WHERE generator_id = $1 FOR UPDATE`,
                [input.generatorId],
            );
            if (generator.rowCount !== 1) throw new Error(`JobGenerator not found: ${input.generatorId}`);
            const versionResult = await client.query(
                `SELECT COALESCE(MAX(version), 0) + 1 AS version
                 FROM "${this.sql.schema}".job_generator_definitions WHERE generator_id = $1`,
                [input.generatorId],
            );
            const definitionId = input.definitionId ?? randomUUID();
            const version = Number(versionResult.rows[0].version);
            const { rows } = await client.query(
                `INSERT INTO "${this.sql.schema}".job_generator_definitions (
                     definition_id, generator_id, version, source_type, source_config,
                     lifecycle_definition, affinities, validation_gates, guardrails, created_by
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                 RETURNING *`,
                [
                    definitionId,
                    input.generatorId,
                    version,
                    input.sourceType,
                    JSON.stringify(input.sourceConfig ?? {}),
                    JSON.stringify(input.lifecycleDefinition ?? {}),
                    JSON.stringify(input.affinities ?? {}),
                    JSON.stringify(input.validationGates ?? []),
                    JSON.stringify(input.guardrails ?? {}),
                    input.createdBy ?? null,
                ],
            );
            await client.query(
                `UPDATE "${this.sql.schema}".job_generators
                 SET active_definition_id = $2, next_run_at = LEAST(next_run_at, now()), updated_at = now()
                 WHERE generator_id = $1`,
                [input.generatorId, definitionId],
            );
            await client.query("COMMIT");
            return rowToJobGeneratorDefinition(rows[0]);
        } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    async getJobGeneratorDefinition(definitionId: string): Promise<JobGeneratorDefinitionRow> {
        const { rows } = await this.pool.query(
            `SELECT * FROM "${this.sql.schema}".job_generator_definitions
             WHERE definition_id = $1`,
            [definitionId],
        );
        if (!rows[0]) throw new Error(`JobGenerator definition not found: ${definitionId}`);
        return rowToJobGeneratorDefinition(rows[0]);
    }

    async listJobGeneratorDefinitions(generatorId: string): Promise<JobGeneratorDefinitionRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM "${this.sql.schema}".job_generator_definitions
             WHERE generator_id = $1
             ORDER BY version DESC`,
            [generatorId],
        );
        return rows.map(rowToJobGeneratorDefinition);
    }

    async listJobGeneratorJobs(generatorId: string): Promise<JobRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM "${this.sql.schema}".jobs
             WHERE generator_id = $1
             ORDER BY first_discovered_at DESC, job_id`,
            [generatorId],
        );
        return rows.map(rowToJob);
    }

    async listJobGeneratorCycles(generatorId: string, limit = 50): Promise<JobGeneratorCycleRow[]> {
        const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 200));
        const { rows } = await this.pool.query(
            `SELECT * FROM "${this.sql.schema}".job_generator_cycles
             WHERE generator_id = $1
             ORDER BY started_at DESC, cycle_id
             LIMIT $2`,
            [generatorId, boundedLimit],
        );
        return rows.map(rowToJobGeneratorCycle);
    }

    async getJob(jobId: string, includeDeleted = false): Promise<JobRow | null> {
        const { rows } = await this.pool.query(
            `SELECT * FROM "${this.sql.schema}".jobs
             WHERE job_id = $1 AND ($2 OR deleted_at IS NULL)`,
            [jobId, includeDeleted],
        );
        return rows[0] ? rowToJob(rows[0]) : null;
    }

    async beginJobGeneratorCleanup(input: {
        generatorId: string;
        actor: SessionOwnerInfo;
        isAdmin?: boolean;
    }): Promise<JobCleanupPlan> {
        return this.beginJobCleanupScope("generator", input.generatorId, input.actor, input.isAdmin ?? false);
    }

    async beginJobCleanup(input: {
        jobId: string;
        actor: SessionOwnerInfo;
        isAdmin?: boolean;
    }): Promise<JobCleanupPlan> {
        return this.beginJobCleanupScope("job", input.jobId, input.actor, input.isAdmin ?? false);
    }

    private async beginJobCleanupScope(
        aggregateType: "generator" | "job",
        aggregateId: string,
        actor: SessionOwnerInfo,
        isAdmin: boolean,
    ): Promise<JobCleanupPlan> {
        const actorProvider = actor.provider?.trim();
        const actorSubject = actor.subject?.trim();
        if (!actorProvider || !actorSubject) {
            throw new Error("Job cleanup actor provider and subject are required");
        }
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const targetResult = aggregateType === "generator"
                ? await client.query(
                    `SELECT g.*, NULL::text AS job_id, g.deleted_at AS aggregate_deleted_at
                     FROM "${this.sql.schema}".job_generators g
                     WHERE g.generator_id = $1
                     FOR UPDATE`,
                    [aggregateId],
                )
                : await client.query(
                    `SELECT g.*, j.job_id, j.deleted_at AS aggregate_deleted_at
                     FROM "${this.sql.schema}".jobs j
                     JOIN "${this.sql.schema}".job_generators g
                       ON g.generator_id = j.generator_id
                     WHERE j.job_id = $1
                     FOR UPDATE OF g, j`,
                    [aggregateId],
                );
            const target = targetResult.rows[0];
            const ownerMatches = target
                && target.owner_provider === actorProvider
                && target.owner_subject === actorSubject;
            if (!target || (!isAdmin && !ownerMatches)) {
                throw Object.assign(new Error("JobGenerator not found."), {
                    code: "NOT_FOUND",
                    status: 404,
                });
            }
            const generatorId = target.generator_id as string;
            const jobId = aggregateType === "job" ? target.job_id as string : null;
            const alreadyDeleted = Boolean(target.aggregate_deleted_at);

            const tombstoneResult = await client.query(
                `INSERT INTO "${this.sql.schema}".job_cleanup_tombstones AS tombstone (
                     aggregate_type, aggregate_id, generator_id, job_id,
                     owner_provider, owner_subject, actor_provider, actor_subject,
                     actor_display_name
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                 ON CONFLICT (aggregate_type, aggregate_id) DO UPDATE
                    SET cleanup_status = CASE
                            WHEN tombstone.cleanup_status = 'completed'
                                THEN 'completed'
                            ELSE 'pending'
                        END,
                        cleanup_error = CASE
                            WHEN tombstone.cleanup_status = 'completed'
                                THEN tombstone.cleanup_error
                            ELSE NULL
                        END,
                        updated_at = now()
                 RETURNING session_ids`,
                [
                    aggregateType,
                    aggregateId,
                    generatorId,
                    jobId,
                    target.owner_provider,
                    target.owner_subject,
                    actorProvider,
                    actorSubject,
                    actor.displayName ?? null,
                ],
            );

            if (aggregateType === "generator") {
                await client.query(
                    `UPDATE "${this.sql.schema}".job_generators
                     SET operational_state = 'disabled', active_definition_id = NULL,
                         lease_owner = NULL, lease_expires_at = NULL,
                         deleted_at = COALESCE(deleted_at, now()), updated_at = now()
                     WHERE generator_id = $1`,
                    [generatorId],
                );
                await client.query(
                    `UPDATE "${this.sql.schema}".job_generator_cycles
                     SET status = 'failed', error = COALESCE(error, 'JobGenerator deleted'),
                         completed_at = COALESCE(completed_at, now())
                     WHERE generator_id = $1 AND status = 'running'`,
                    [generatorId],
                );
            }

            const jobIdsResult = aggregateType === "generator"
                ? await client.query(
                    `SELECT job_id
                     FROM "${this.sql.schema}".jobs
                     WHERE generator_id = $1
                     ORDER BY job_id
                     FOR UPDATE`,
                    [generatorId],
                )
                : { rows: [{ job_id: jobId }] };
            const jobIds = jobIdsResult.rows.map((row: any) => row.job_id as string);
            const sessionsResult = jobIds.length > 0
                ? await client.query(
                    `SELECT DISTINCT session_id
                     FROM "${this.sql.schema}".job_sessions
                     WHERE job_id = ANY($1::text[])
                     ORDER BY session_id`,
                    [jobIds],
                )
                : { rows: [] };
            const persistedSessionIds = Array.isArray(tombstoneResult.rows[0]?.session_ids)
                ? tombstoneResult.rows[0].session_ids
                    .filter((sessionId: unknown): sessionId is string => typeof sessionId === "string")
                : [];
            const sessionIds = [...new Set([
                ...persistedSessionIds,
                ...sessionsResult.rows.map((row: any) => row.session_id as string),
            ])].sort();
            await client.query(
                `UPDATE "${this.sql.schema}".job_cleanup_tombstones
                 SET session_ids = $3, updated_at = now()
                 WHERE aggregate_type = $1 AND aggregate_id = $2`,
                [aggregateType, aggregateId, JSON.stringify(sessionIds)],
            );

            if (jobIds.length > 0) {
                await client.query(
                    `UPDATE "${this.sql.schema}".jobs
                     SET lifecycle_state = 'cancelled',
                         deleted_at = COALESCE(deleted_at, now()),
                         session_error = COALESCE(session_error, 'Job deleted'),
                         updated_at = now()
                     WHERE job_id = ANY($1::text[])`,
                    [jobIds],
                );
                await client.query(
                    `UPDATE "${this.sql.schema}".job_state_runs
                     SET status = 'failed', error = COALESCE(error, 'Job deleted'),
                         lease_owner = NULL, lease_expires_at = NULL,
                         completed_at = COALESCE(completed_at, now()), updated_at = now()
                     WHERE job_id = ANY($1::text[])
                       AND status IN ('reserved', 'unacked', 'active', 'waiting', 'input_required')`,
                    [jobIds],
                );
                await client.query(
                    `UPDATE "${this.sql.schema}".job_external_operations
                     SET status = CASE WHEN status = 'pending' THEN 'failed' ELSE status END,
                         error = CASE WHEN status = 'pending' THEN COALESCE(error, 'Job deleted') ELSE error END,
                         poll_lease_owner = NULL, poll_lease_expires_at = NULL,
                         signal_status = CASE
                             WHEN signal_status IN ('pending', 'delivering') THEN 'blocked'
                             ELSE signal_status
                         END,
                         signal_lease_owner = NULL, signal_lease_expires_at = NULL,
                         completed_at = CASE
                             WHEN status = 'pending' THEN COALESCE(completed_at, now())
                             ELSE completed_at
                         END,
                         wait_completed_at = COALESCE(wait_completed_at, now()),
                         updated_at = now()
                     WHERE job_id = ANY($1::text[])`,
                    [jobIds],
                );
                await client.query(
                    `UPDATE "${this.sql.schema}".job_sessions
                     SET is_current = FALSE,
                         status = CASE
                             WHEN status IN ('completed', 'replaced') THEN status
                             ELSE 'failed'
                         END,
                         error = CASE
                             WHEN status IN ('completed', 'replaced') THEN error
                             ELSE COALESCE(error, 'Job deleted')
                         END,
                         ended_at = COALESCE(ended_at, now())
                     WHERE job_id = ANY($1::text[])`,
                    [jobIds],
                );
            }

            await client.query("COMMIT");
            return {
                aggregateType,
                aggregateId,
                generatorId,
                jobId,
                alreadyDeleted,
                sessionIds,
            };
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async recordJobCleanupSessions(
        aggregateType: "generator" | "job",
        aggregateId: string,
        sessionIds: string[],
    ): Promise<string[]> {
        const normalizedSessionIds = [...new Set(
            sessionIds
                .map((sessionId) => sessionId.trim())
                .filter(Boolean),
        )];
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const tombstoneResult = await client.query(
                `SELECT session_ids
                 FROM "${this.sql.schema}".job_cleanup_tombstones
                 WHERE aggregate_type = $1 AND aggregate_id = $2
                 FOR UPDATE`,
                [aggregateType, aggregateId],
            );
            if (!tombstoneResult.rows[0]) {
                throw new Error(`Job cleanup tombstone not found: ${aggregateType}:${aggregateId}`);
            }
            const persistedSessionIds = Array.isArray(tombstoneResult.rows[0].session_ids)
                ? tombstoneResult.rows[0].session_ids
                    .filter((sessionId: unknown): sessionId is string => typeof sessionId === "string")
                : [];
            const mergedSessionIds = [...new Set([
                ...persistedSessionIds,
                ...normalizedSessionIds,
            ])].sort();
            await client.query(
                `UPDATE "${this.sql.schema}".job_cleanup_tombstones
                 SET session_ids = $3, updated_at = now()
                 WHERE aggregate_type = $1 AND aggregate_id = $2`,
                [aggregateType, aggregateId, JSON.stringify(mergedSessionIds)],
            );
            await client.query("COMMIT");
            return mergedSessionIds;
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async completeJobCleanup(
        aggregateType: "generator" | "job",
        aggregateId: string,
        outcome: { status: "completed" | "failed"; error?: string | null; deletedSessionCount?: number },
    ): Promise<void> {
        await this.pool.query(
            `UPDATE "${this.sql.schema}".job_cleanup_tombstones
             SET cleanup_status = CASE
                     WHEN cleanup_status = 'completed' THEN 'completed'
                     ELSE $3
                 END,
                 cleanup_error = CASE
                     WHEN cleanup_status = 'completed' THEN cleanup_error
                     ELSE $4
                 END,
                 final_outcome = CASE
                     WHEN cleanup_status = 'completed' THEN final_outcome
                     ELSE $5
                 END,
                 updated_at = now()
             WHERE aggregate_type = $1 AND aggregate_id = $2`,
            [
                aggregateType,
                aggregateId,
                outcome.status,
                outcome.error ?? null,
                JSON.stringify({ deletedSessionCount: outcome.deletedSessionCount ?? 0 }),
            ],
        );
    }

    async beginSessionTreeDeletion(sessionId: string): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const target = await client.query(
                `SELECT session_id
                 FROM "${this.sql.schema}".sessions
                 WHERE session_id = $1
                 FOR UPDATE`,
                [sessionId],
            );
            if (!target.rows[0]) {
                await client.query("COMMIT");
                return;
            }
            await client.query(
                `WITH RECURSIVE tree AS (
                     SELECT session_id
                     FROM "${this.sql.schema}".sessions
                     WHERE session_id = $1
                     UNION ALL
                     SELECT child.session_id
                     FROM "${this.sql.schema}".sessions child
                     JOIN tree parent ON child.parent_session_id = parent.session_id
                 )
                 UPDATE "${this.sql.schema}".sessions session
                 SET deletion_requested_at = COALESCE(deletion_requested_at, now()),
                     updated_at = now()
                 FROM tree
                 WHERE session.session_id = tree.session_id`,
                [sessionId],
            );
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async isSessionActive(sessionId: string): Promise<boolean> {
        const { rows } = await this.pool.query(
            `SELECT EXISTS (
                 SELECT 1
                 FROM "${this.sql.schema}".sessions
                 WHERE session_id = $1
                   AND deleted_at IS NULL
                   AND deletion_requested_at IS NULL
             ) AS active`,
            [sessionId],
        );
        return Boolean(rows[0]?.active);
    }

    async getDescendantSessionIdsIncludingDeleted(sessionId: string): Promise<string[]> {
        const { rows } = await this.pool.query(
            `WITH RECURSIVE descendants AS (
                 SELECT session_id
                 FROM "${this.sql.schema}".sessions
                 WHERE parent_session_id = $1
                 UNION ALL
                 SELECT child.session_id
                 FROM "${this.sql.schema}".sessions child
                 JOIN descendants parent
                   ON child.parent_session_id = parent.session_id
             )
             SELECT session_id FROM descendants`,
            [sessionId],
        );
        return rows.map((row: any) => row.session_id as string);
    }

    async claimDueJobGenerators(workerId: string, limit = 10, leaseSeconds = 300): Promise<JobGeneratorRow[]> {
        const normalizedWorkerId = workerId.trim();
        if (!normalizedWorkerId) throw new Error("workerId is required");
        const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
        const boundedLease = Math.max(30, Math.min(Math.trunc(leaseSeconds), 3600));
        const { rows } = await this.pool.query(
            `WITH due AS (
                 SELECT generator_id
                 FROM "${this.sql.schema}".job_generators
                 WHERE operational_state = 'enabled'
                   AND active_definition_id IS NOT NULL
                   AND next_run_at <= now()
                   AND (lease_expires_at IS NULL OR lease_expires_at <= now())
                 ORDER BY next_run_at, generator_id
                 FOR UPDATE SKIP LOCKED
                 LIMIT $2
             )
             UPDATE "${this.sql.schema}".job_generators g
             SET lease_owner = $1,
                 lease_expires_at = now() + make_interval(secs => $3),
                 updated_at = now()
             FROM due
             WHERE g.generator_id = due.generator_id
             RETURNING g.*`,
            [normalizedWorkerId, boundedLimit, boundedLease],
        );
        return rows.map(rowToJobGenerator);
    }

    async beginJobGeneratorCycle(generatorId: string, workerId: string): Promise<{
        cycle: JobGeneratorCycleRow;
        definition: JobGeneratorDefinitionRow;
    }> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const generatorResult = await client.query(
                `SELECT * FROM "${this.sql.schema}".job_generators
                 WHERE generator_id = $1 FOR UPDATE`,
                [generatorId],
            );
            const generator = generatorResult.rows[0];
            if (!generator) throw new Error(`JobGenerator not found: ${generatorId}`);
            if (generator.lease_owner !== workerId || !generator.lease_expires_at || generator.lease_expires_at <= new Date()) {
                throw new Error(`JobGenerator lease is not held by ${workerId}`);
            }
            if (!generator.active_definition_id) throw new Error("JobGenerator has no active definition");

            const abandoned = await client.query(
                `UPDATE "${this.sql.schema}".job_generator_cycles
                 SET status = 'failed', error = COALESCE(error, 'controller lease expired'),
                     completed_at = COALESCE(completed_at, now())
                 WHERE generator_id = $1 AND status = 'running'`,
                [generatorId],
            );
            if ((abandoned.rowCount ?? 0) > 0) {
                await client.query(
                    `UPDATE "${this.sql.schema}".job_generators
                     SET failed_cycles = failed_cycles + $2, total_cycles = total_cycles + $2
                     WHERE generator_id = $1`,
                    [generatorId, abandoned.rowCount],
                );
            }

            const definitionResult = await client.query(
                `SELECT * FROM "${this.sql.schema}".job_generator_definitions
                 WHERE definition_id = $1`,
                [generator.active_definition_id],
            );
            const cycleId = randomUUID();
            const cycleResult = await client.query(
                `INSERT INTO "${this.sql.schema}".job_generator_cycles (
                     cycle_id, generator_id, definition_id, claimed_by, watermark_before
                 ) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
                [cycleId, generatorId, generator.active_definition_id, workerId, generator.watermark],
            );
            await client.query("COMMIT");
            return {
                cycle: rowToJobGeneratorCycle(cycleResult.rows[0]),
                definition: rowToJobGeneratorDefinition(definitionResult.rows[0]),
            };
        } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    async completeJobGeneratorCycle(input: {
        cycleId: string;
        workerId: string;
        status: "succeeded" | "failed";
        watermark?: unknown;
        discoveredCount?: number;
        createdCount?: number;
        error?: string | null;
    }): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const cycleResult = await client.query(
                `SELECT * FROM "${this.sql.schema}".job_generator_cycles
                 WHERE cycle_id = $1 FOR UPDATE`,
                [input.cycleId],
            );
            const cycle = cycleResult.rows[0];
            if (!cycle) throw new Error(`JobGenerator cycle not found: ${input.cycleId}`);
            if (cycle.status !== "running") {
                await client.query("ROLLBACK");
                return;
            }
            if (cycle.claimed_by !== input.workerId) throw new Error("JobGenerator cycle is owned by another worker");
            const discoveredCount = Math.max(0, Math.trunc(input.discoveredCount ?? 0));
            const createdCount = Math.max(0, Math.trunc(input.createdCount ?? 0));
            const watermark = input.watermark === undefined ? cycle.watermark_before : input.watermark;
            const serializedWatermark = JSON.stringify(watermark ?? null);
            await client.query(
                `UPDATE "${this.sql.schema}".job_generator_cycles
                 SET status = $2, watermark_after = $3, discovered_count = $4,
                     created_count = $5, error = $6, completed_at = now()
                 WHERE cycle_id = $1`,
                [
                    input.cycleId,
                    input.status,
                    serializedWatermark,
                    discoveredCount,
                    createdCount,
                    input.error ?? null,
                ],
            );
            await client.query(
                `UPDATE "${this.sql.schema}".job_generators
                 SET watermark = CASE WHEN $2 = 'succeeded' THEN $3 ELSE watermark END,
                     total_cycles = total_cycles + 1,
                     successful_cycles = successful_cycles + CASE WHEN $2 = 'succeeded' THEN 1 ELSE 0 END,
                     failed_cycles = failed_cycles + CASE WHEN $2 = 'failed' THEN 1 ELSE 0 END,
                     materialized_jobs = materialized_jobs + $4,
                     last_cycle_at = now(),
                     last_error = CASE WHEN $2 = 'failed' THEN $5 ELSE NULL END,
                     next_run_at = now() + make_interval(secs => cadence_seconds),
                     lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
                 WHERE generator_id = $1 AND lease_owner = $6`,
                [
                    cycle.generator_id,
                    input.status,
                    serializedWatermark,
                    createdCount,
                    input.error ?? null,
                    input.workerId,
                ],
            );
            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    async reconcileJobGeneratorDiscoveries(cycleId: string, discoveries: JobDiscovery[]): Promise<ReconciledJob[]> {
        const unique = new Map<string, Record<string, unknown>>();
        for (const discovery of discoveries) {
            const key = String(discovery.key ?? "").trim();
            if (!key) throw new Error("Job discovery key is required");
            unique.set(key, discovery.payload ?? {});
        }
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const cycleResult = await client.query(
                `SELECT * FROM "${this.sql.schema}".job_generator_cycles
                 WHERE cycle_id = $1 AND status = 'running' FOR UPDATE`,
                [cycleId],
            );
            const cycle = cycleResult.rows[0];
            if (!cycle) throw new Error(`Running JobGenerator cycle not found: ${cycleId}`);
            const definitionResult = await client.query(
                `SELECT lifecycle_definition
                 FROM "${this.sql.schema}".job_generator_definitions
                 WHERE definition_id = $1`,
                [cycle.definition_id],
            );
            const lifecycleDefinition = definitionResult.rows[0]?.lifecycle_definition ?? {};
            const lifecycle = jobLifecycleConfig(lifecycleDefinition);
            const configuredInitialState = typeof lifecycle.initialState === "string"
                ? lifecycle.initialState.trim()
                : "";
            const initialState = configuredInitialState || "Initial";
            const reconciled: ReconciledJob[] = [];
            for (const [jobKey, payload] of unique) {
                const { rows } = await client.query(
                    `WITH upserted AS (
                         INSERT INTO "${this.sql.schema}".jobs (
                             job_id, generator_id, definition_id, job_key, source_payload,
                             current_state, first_seen_cycle_id, last_seen_cycle_id
                         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
                         ON CONFLICT (generator_id, job_key) DO UPDATE SET
                             source_payload = EXCLUDED.source_payload,
                             last_seen_cycle_id = EXCLUDED.last_seen_cycle_id,
                             last_discovered_at = now(),
                             updated_at = now()
                         RETURNING *, (xmax = 0) AS was_created
                     )
                     SELECT upserted.*,
                            upserted.lifecycle_state NOT IN ('completed', 'cancelled')
                            AND NOT EXISTS (
                                SELECT 1 FROM "${this.sql.schema}".job_sessions js
                                WHERE js.job_id = upserted.job_id AND js.is_current
                            ) AS needs_session
                     FROM upserted`,
                    [
                        randomUUID(),
                        cycle.generator_id,
                        cycle.definition_id,
                        jobKey,
                        JSON.stringify(payload),
                        initialState,
                        cycleId,
                    ],
                );
                reconciled.push({
                    ...rowToJob(rows[0]),
                    created: Boolean(rows[0].was_created),
                    needsSession: Boolean(rows[0].needs_session),
                });
            }
            await client.query("COMMIT");
            return reconciled;
        } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    async listJobsNeedingSession(generatorId: string, limit = 100): Promise<JobRow[]> {
        const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 1000));
        const { rows } = await this.pool.query(
            `SELECT j.*
             FROM "${this.sql.schema}".jobs j
             WHERE j.generator_id = $1
               AND j.lifecycle_state IN ('pending_session', 'blocked')
               AND NOT EXISTS (
                   SELECT 1
                   FROM "${this.sql.schema}".job_sessions js
                   WHERE js.job_id = j.job_id
                     AND js.is_current
                     AND js.status IN ('unacked', 'active')
               )
             ORDER BY j.first_discovered_at, j.job_id
             LIMIT $2`,
            [generatorId, boundedLimit],
        );
        return rows.map(rowToJob);
    }

    async reserveJobSession(
        jobId: string,
        cycleId: string,
        workerId: string,
        sessionId = randomUUID(),
    ): Promise<JobSessionRow> {
        return this.createJobSessionAssociation(jobId, sessionId, false, { cycleId, workerId });
    }

    async replaceJobSession(jobId: string, sessionId = randomUUID()): Promise<JobSessionRow> {
        return this.createJobSessionAssociation(jobId, sessionId, true);
    }

    private async createJobSessionAssociation(
        jobId: string,
        sessionId: string,
        replace: boolean,
        fence?: { cycleId: string; workerId: string },
    ): Promise<JobSessionRow> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const job = fence
                ? await client.query(
                    `SELECT j.*
                     FROM "${this.sql.schema}".jobs j
                     JOIN "${this.sql.schema}".job_generator_cycles c
                       ON c.cycle_id = $2
                      AND c.generator_id = j.generator_id
                      AND c.status = 'running'
                      AND c.claimed_by = $3
                     JOIN "${this.sql.schema}".job_generators g
                       ON g.generator_id = j.generator_id
                      AND g.lease_owner = $3
                      AND g.lease_expires_at > now()
                     WHERE j.job_id = $1
                     FOR UPDATE OF j`,
                    [jobId, fence.cycleId, fence.workerId],
                )
                : await client.query(
                    `SELECT * FROM "${this.sql.schema}".jobs WHERE job_id = $1 FOR UPDATE`,
                    [jobId],
                );
            if (job.rowCount !== 1) throw new Error(`Job not found: ${jobId}`);
            if (job.rows[0].lifecycle_state === "completed" || job.rows[0].lifecycle_state === "cancelled") {
                throw new Error(`Job is terminal: ${jobId}`);
            }
            let stateRunResult = await client.query(
                `SELECT * FROM "${this.sql.schema}".job_state_runs
                 WHERE job_id = $1 AND state_revision = $2
                 FOR UPDATE`,
                [jobId, job.rows[0].state_revision],
            );
            if (!stateRunResult.rows[0]) {
                stateRunResult = await client.query(
                    `INSERT INTO "${this.sql.schema}".job_state_runs (
                         state_run_id, job_id, definition_id, state_name, state_revision
                     ) VALUES ($1,$2,$3,$4,$5)
                     RETURNING *`,
                    [
                        randomUUID(),
                        jobId,
                        job.rows[0].definition_id,
                        job.rows[0].current_state,
                        job.rows[0].state_revision,
                    ],
                );
            }
            const stateRun = stateRunResult.rows[0];
            const current = await client.query(
                `SELECT * FROM "${this.sql.schema}".job_sessions
                 WHERE job_id = $1 AND is_current FOR UPDATE`,
                [jobId],
            );
            if (current.rows[0] && !replace) {
                await client.query("COMMIT");
                return rowToJobSession(current.rows[0]);
            }
            if (current.rows[0]) {
                await client.query(
                    `UPDATE "${this.sql.schema}".job_sessions
                     SET is_current = FALSE, status = 'replaced', ended_at = now()
                     WHERE association_id = $1`,
                    [current.rows[0].association_id],
                );
                await client.query(
                    `UPDATE "${this.sql.schema}".job_waits
                     SET status = 'cancelled',
                         next_check_at = NULL,
                         check_lease_owner = NULL,
                         check_lease_expires_at = NULL,
                         updated_at = now()
                     WHERE state_run_id = $1
                       AND status = 'pending'`,
                    [stateRun.state_run_id],
                );
            }
            const ordinalResult = await client.query(
                `SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal
                 FROM "${this.sql.schema}".job_sessions WHERE job_id = $1`,
                [jobId],
            );
            const { rows } = await client.query(
                `INSERT INTO "${this.sql.schema}".job_sessions (
                     association_id, job_id, session_id, state_run_id, ordinal, is_current, status
                 ) VALUES ($1,$2,$3,$4,$5,TRUE,'reserved') RETURNING *`,
                [randomUUID(), jobId, sessionId, stateRun.state_run_id, Number(ordinalResult.rows[0].ordinal)],
            );
            await client.query(
                // Re-activating a state (a new session taking over a run that a
                // prior session already owned) mints a fresh attempt: clear the
                // durable Markdown snapshot so the controller re-resolves the
                // source branch ref to its latest commit instead of reusing the
                // commit pinned by the prior session. A same-session resume never
                // passes through here (the reconcile loop reuses its association),
                // so an in-flight run keeps its pin for intra-run consistency.
                `UPDATE "${this.sql.schema}".job_state_runs
                 SET attempt = CASE WHEN session_id IS NULL THEN attempt ELSE attempt + 1 END,
                     session_id = $2, status = 'reserved', lease_owner = NULL,
                     lease_expires_at = NULL, error = NULL, updated_at = now(),
                     state_owner      = CASE WHEN session_id IS NULL THEN state_owner      ELSE NULL END,
                     source_id        = CASE WHEN session_id IS NULL THEN source_id        ELSE NULL END,
                     source_path      = CASE WHEN session_id IS NULL THEN source_path      ELSE NULL END,
                     source_commit    = CASE WHEN session_id IS NULL THEN source_commit    ELSE NULL END,
                     markdown_sha256  = CASE WHEN session_id IS NULL THEN markdown_sha256  ELSE NULL END,
                     allowed_outcomes = CASE WHEN session_id IS NULL THEN allowed_outcomes ELSE '[]'::jsonb END,
                     terminal         = CASE WHEN session_id IS NULL THEN terminal         ELSE NULL END
                 WHERE state_run_id = $1`,
                [stateRun.state_run_id, sessionId],
            );
            await client.query(
                `UPDATE "${this.sql.schema}".jobs
                 SET lifecycle_state = 'pending_session', session_attempts = session_attempts + 1,
                     session_error = NULL, updated_at = now()
                 WHERE job_id = $1`,
                [jobId],
            );
            await client.query("COMMIT");
            return rowToJobSession(rows[0]);
        } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    async prepareJobStateRun(input: PrepareJobStateRunInput): Promise<JobStateRunRow> {
        const sourceId = input.sourceId.trim();
        const sourcePath = input.sourcePath.trim();
        const markdownSha256 = input.markdownSha256.trim();
        const sourceCommit = input.sourceCommit?.trim();
        if (!sourceId || !sourcePath || !sourceCommit || !/^[0-9a-f]{64}$/i.test(markdownSha256)) {
            throw new Error("Prepared Job state requires sourceId, sourcePath, sourceCommit, and a SHA-256 digest");
        }
        if (!JOB_STATE_NAME_RE.test(input.expectedState)
            || !Number.isInteger(input.expectedRevision)
            || input.expectedRevision <= 0) {
            throw new Error("Prepared Job state requires a valid expected state and revision");
        }
        if (!Array.isArray(input.allowedOutcomes)) {
            throw new Error("Prepared Job state allowedOutcomes must be an array");
        }
        const seen = new Set<string>();
        const allowedOutcomes = input.allowedOutcomes.map((entry) => {
            const outcome = String(entry?.outcome ?? "").trim();
            const toState = String(entry?.toState ?? "").trim();
            if (!outcome || !toState) throw new Error("Each Job state outcome requires outcome and toState");
            if (seen.has(outcome)) throw new Error(`Duplicate Job state outcome: ${outcome}`);
            seen.add(outcome);
            return { outcome, toState };
        });
        if (input.terminal !== (allowedOutcomes.length === 0)) {
            throw new Error("Terminal Job states must have no allowed outcomes");
        }
        const { rows } = await this.pool.query(
            `UPDATE "${this.sql.schema}".job_state_runs sr
             SET state_owner = $2, source_id = $3, source_path = $4,
                 source_commit = $5, markdown_sha256 = $6,
                 allowed_outcomes = $7, terminal = $8, status = 'reserved',
                 error = NULL, updated_at = now()
             FROM "${this.sql.schema}".job_sessions js
             WHERE js.session_id = $1
               AND js.is_current
               AND js.state_run_id = sr.state_run_id
               AND sr.state_name = $9
               AND sr.state_revision = $10
               AND sr.status IN ('reserved', 'unacked', 'failed')
               AND (
                    (
                        sr.state_owner IS NULL
                        AND sr.source_id IS NULL
                        AND sr.source_path IS NULL
                        AND sr.source_commit IS NULL
                        AND sr.markdown_sha256 IS NULL
                        AND sr.terminal IS NULL
                    )
                    OR (
                        sr.state_owner = $2
                        AND sr.source_id = $3
                        AND sr.source_path = $4
                        AND sr.source_commit = $5
                        AND sr.markdown_sha256 = $6
                        AND sr.allowed_outcomes = $7::jsonb
                        AND sr.terminal = $8
                    )
               )
             RETURNING sr.*`,
            [
                input.sessionId,
                input.stateOwner,
                sourceId,
                sourcePath,
                sourceCommit,
                markdownSha256.toLowerCase(),
                JSON.stringify(allowedOutcomes),
                input.terminal,
                input.expectedState,
                input.expectedRevision,
            ],
        );
        if (!rows[0]) {
            throw new Error(
                `Current Job state run not found or durable Markdown snapshot differs for session ${input.sessionId}`,
            );
        }
        return rowToJobStateRun(rows[0]);
    }

    async attachJobSession(jobId: string, sessionId: string, cycleId: string, workerId: string): Promise<void> {
        const result = await this.pool.query(
            `WITH attached AS (
                 UPDATE "${this.sql.schema}".job_sessions js
                 SET status = CASE WHEN status = 'active' THEN 'active' ELSE 'unacked' END,
                     error = NULL, attached_at = COALESCE(attached_at, now())
                 WHERE js.job_id = $1 AND js.session_id = $2 AND js.is_current
                   AND EXISTS (
                       SELECT 1
                       FROM "${this.sql.schema}".jobs j
                       JOIN "${this.sql.schema}".job_generator_cycles c
                         ON c.cycle_id = $3
                        AND c.generator_id = j.generator_id
                        AND c.status = 'running'
                        AND c.claimed_by = $4
                       JOIN "${this.sql.schema}".job_generators g
                         ON g.generator_id = j.generator_id
                        AND g.lease_owner = $4
                        AND g.lease_expires_at > now()
                       WHERE j.job_id = js.job_id
                   )
                 RETURNING js.job_id, js.state_run_id
             ), attached_run AS (
                 UPDATE "${this.sql.schema}".job_state_runs sr
                 SET status = CASE WHEN status = 'active' THEN 'active' ELSE 'unacked' END,
                     error = NULL, updated_at = now()
                 FROM attached
                 WHERE sr.state_run_id = attached.state_run_id
                   AND sr.status IN ('reserved', 'unacked', 'active', 'failed')
                 RETURNING sr.job_id, sr.status
             )
             UPDATE "${this.sql.schema}".jobs j
             SET lifecycle_state = CASE
                     WHEN attached_run.status = 'active' THEN 'active'
                     ELSE 'pending_session'
                 END,
                 session_error = NULL, updated_at = now()
             FROM attached_run WHERE j.job_id = attached_run.job_id`,
            [jobId, sessionId, cycleId, workerId],
        );
        if ((result.rowCount ?? 0) !== 1) throw new Error("Current Job session association not found");
    }

    async acknowledgeJobSession(sessionId: string, workerId?: string): Promise<void> {
        await this.pool.query(
            `WITH acknowledged AS (
                 UPDATE "${this.sql.schema}".job_sessions
                 SET status = 'active'
                 WHERE session_id = $1 AND is_current AND status IN ('reserved', 'unacked', 'active')
                 RETURNING job_id, state_run_id
             ), activated_run AS (
                 UPDATE "${this.sql.schema}".job_state_runs sr
                 SET status = 'active',
                     lease_owner = COALESCE(NULLIF(BTRIM($2), ''), lease_owner),
                     lease_expires_at = now() + interval '1 hour',
                     started_at = COALESCE(started_at, now()),
                     updated_at = now()
                 FROM acknowledged
                 WHERE sr.state_run_id = acknowledged.state_run_id
                   AND sr.status IN ('reserved', 'unacked', 'active', 'waiting', 'input_required')
                 RETURNING sr.job_id
             )
             UPDATE "${this.sql.schema}".jobs j
             SET lifecycle_state = 'active', session_error = NULL, updated_at = now()
             FROM activated_run
             WHERE j.job_id = activated_run.job_id`,
            [sessionId, workerId ?? null],
        );
    }

    async setJobSessionExecutionStatus(
        sessionId: string,
        status: "active" | "waiting" | "input_required",
    ): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const stateRun = await client.query(
                `UPDATE "${this.sql.schema}".job_state_runs sr
                 SET status = $2,
                     lease_owner = CASE WHEN $2 = 'active' THEN lease_owner ELSE NULL END,
                     lease_expires_at = CASE WHEN $2 = 'active' THEN lease_expires_at ELSE NULL END,
                     updated_at = now()
                 FROM "${this.sql.schema}".job_sessions js
                 WHERE js.session_id = $1
                   AND js.is_current
                   AND js.state_run_id = sr.state_run_id
                   AND sr.status IN ('active', 'waiting', 'input_required')
                 RETURNING sr.job_id`,
                [sessionId, status],
            );
            if (stateRun.rows[0]) {
                await client.query(
                    `UPDATE "${this.sql.schema}".jobs
                     SET lifecycle_state = $2,
                         updated_at = now()
                     WHERE job_id = $1`,
                    [
                        stateRun.rows[0].job_id,
                        status === "active" ? "active" : "blocked",
                    ],
                );
                if (status !== "active") {
                    // Authoritative external-operation wait "started" stamp. This
                    // transition is the durable "session has parked" signal: it
                    // runs post-turn, strictly after the producer's
                    // startJobExternalOperation has committed the wait row, and it
                    // flips the state run to 'waiting'/'input_required' in this very
                    // transaction. The signal.system_wait_started event that also
                    // stamps this boundary runs on a decoupled activity and can lose
                    // a visibility race against wait-row creation; when it does, the
                    // signal-claim path (which requires wait_started_at IS NOT NULL)
                    // would never deliver the resume signal and the Job would strand.
                    // Stamping here — atomically with the state-run parking — closes
                    // that race for good without risking premature delivery, since
                    // wait_started_at only becomes non-null at the same instant the
                    // state run becomes claim-eligible.
                    const stampedWaits = await client.query(
                        `UPDATE "${this.sql.schema}".job_waits wait
                         SET wait_started_at = COALESCE(wait.wait_started_at, now()),
                             updated_at = now()
                         FROM "${this.sql.schema}".job_sessions session
                         WHERE wait.state_run_id = session.state_run_id
                           AND session.session_id = $1
                           AND session.is_current
                           AND wait.external_operation_id IS NOT NULL
                           AND wait.wait_started_at IS NULL
                         RETURNING wait.external_operation_id`,
                        [sessionId],
                    );
                    const stampedOpIds = stampedWaits.rows
                        .map((row: { external_operation_id: string | null }) => row.external_operation_id)
                        .filter((id: string | null): id is string => Boolean(id));
                    if (stampedOpIds.length > 0) {
                        await client.query(
                            `UPDATE "${this.sql.schema}".job_external_operations
                             SET wait_started_at = COALESCE(wait_started_at, now()),
                                 updated_at = now()
                             WHERE operation_id = ANY($1::text[])`,
                            [stampedOpIds],
                        );
                    }
                }
            }
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async failJobSession(
        jobId: string,
        sessionId: string,
        cycleId: string,
        workerId: string,
        error: string,
    ): Promise<void> {
        const result = await this.pool.query(
            `WITH failed AS (
                 UPDATE "${this.sql.schema}".job_sessions js
                 SET status = 'failed', error = $5
                 WHERE js.job_id = $1 AND js.session_id = $2 AND js.is_current
                   AND EXISTS (
                       SELECT 1
                       FROM "${this.sql.schema}".jobs j
                       JOIN "${this.sql.schema}".job_generator_cycles c
                         ON c.cycle_id = $3
                        AND c.generator_id = j.generator_id
                        AND c.status = 'running'
                        AND c.claimed_by = $4
                       JOIN "${this.sql.schema}".job_generators g
                         ON g.generator_id = j.generator_id
                        AND g.lease_owner = $4
                        AND g.lease_expires_at > now()
                       WHERE j.job_id = js.job_id
                   )
                 RETURNING js.job_id, js.state_run_id
             ), failed_run AS (
                 UPDATE "${this.sql.schema}".job_state_runs sr
                 SET status = 'failed', error = $5, lease_owner = NULL,
                     lease_expires_at = NULL, updated_at = now()
                 FROM failed
                 WHERE sr.state_run_id = failed.state_run_id
                   AND sr.status <> 'completed'
                 RETURNING sr.job_id, sr.state_run_id
             ), cancelled_wait AS (
                 UPDATE "${this.sql.schema}".job_waits wait
                 SET status = 'cancelled',
                     next_check_at = NULL,
                     check_lease_owner = NULL,
                     check_lease_expires_at = NULL,
                     updated_at = now()
                 FROM failed_run
                 WHERE wait.state_run_id = failed_run.state_run_id
                   AND wait.status = 'pending'
                 RETURNING wait.wait_id
             )
             UPDATE "${this.sql.schema}".jobs j
             SET lifecycle_state = 'blocked', session_error = $5, updated_at = now()
             FROM failed_run WHERE j.job_id = failed_run.job_id`,
            [jobId, sessionId, cycleId, workerId, error],
        );
        if ((result.rowCount ?? 0) !== 1) throw new Error("Current Job session association not found");
    }

    async listJobSessions(jobId: string): Promise<JobSessionRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM "${this.sql.schema}".job_sessions
             WHERE job_id = $1 ORDER BY ordinal`,
            [jobId],
        );
        return rows.map(rowToJobSession);
    }

    async listJobStateRuns(jobId: string): Promise<JobStateRunRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM "${this.sql.schema}".job_state_runs
             WHERE job_id = $1 ORDER BY state_revision`,
            [jobId],
        );
        return rows.map(rowToJobStateRun);
    }

    async listJobJournal(jobId: string): Promise<JobJournalEntryRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM "${this.sql.schema}".job_journal_entries
             WHERE job_id = $1 ORDER BY sequence`,
            [jobId],
        );
        return rows.map(rowToJobJournalEntry);
    }

    async listJobWaits(jobId: string): Promise<JobWaitRow[]> {
        const { rows } = await this.pool.query(
            `SELECT * FROM "${this.sql.schema}".job_waits
             WHERE job_id = $1
             ORDER BY expected_state_revision, created_at, wait_id`,
            [jobId],
        );
        return rows.map(rowToJobWait);
    }

    async setJobWaitConditionOverride(
        jobId: string,
        waitId: string,
        conditionKey: string,
        overridden: boolean,
    ): Promise<JobWaitRow> {
        const job = jobId.trim();
        const id = waitId.trim();
        const key = conditionKey.trim();
        if (!job || !id || !key) {
            throw new Error("Setting a Job wait condition override requires jobId, waitId, and conditionKey");
        }
        const { rows } = await this.pool.query(
            `UPDATE "${this.sql.schema}".job_waits
             SET condition_overrides = CASE
                     WHEN $3::boolean THEN (
                         SELECT COALESCE(jsonb_agg(DISTINCT elem), '[]'::jsonb)
                         FROM jsonb_array_elements_text(
                             COALESCE(condition_overrides, '[]'::jsonb) || to_jsonb($2::text)
                         ) AS elem
                     )
                     ELSE (
                         SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
                         FROM jsonb_array_elements_text(COALESCE(condition_overrides, '[]'::jsonb)) AS elem
                         WHERE elem <> $2::text
                     )
                 END,
                 next_check_at = now(),
                 updated_at = now()
             WHERE wait_id = $1
               AND job_id = $4
               AND kind = 'observed_condition'
             RETURNING *`,
            [id, key, overridden, job],
        );
        const row = rows[0];
        if (!row) {
            throw new Error(`Observed-condition Job wait not found: ${id}`);
        }
        return rowToJobWait(row);
    }

    async startJobResponseWait(input: StartJobResponseWaitInput): Promise<JobWaitRow | null> {
        const sessionId = input.sessionId.trim();
        const waitKey = input.waitKey.trim();
        const question = input.question.trim();
        if (!sessionId || !question) {
            throw new Error("Response wait requires a sessionId and question");
        }
        if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(waitKey)) {
            throw new Error("Response wait key contains unsupported characters");
        }
        const choices = (input.choices ?? []).map((choice) => choice.trim());
        if (choices.some((choice) => !choice) || new Set(choices).size !== choices.length) {
            throw new Error("Response wait choices must be unique non-empty strings");
        }
        const allowFreeform = input.allowFreeform !== false;
        if (!allowFreeform && choices.length === 0) {
            throw new Error("A response wait that disallows freeform input requires choices");
        }
        const prompt = { question, choices, allowFreeform };
        const responseSchema = { type: "string", choices, allowFreeform };
        const responderPolicy = input.responderPolicy ?? { kind: "session_writer" };
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const contextResult = await client.query(
                `SELECT js.is_current, sr.state_run_id, sr.job_id, sr.definition_id,
                        sr.state_revision, sr.status AS state_run_status,
                        j.state_revision AS job_state_revision
                 FROM "${this.sql.schema}".job_sessions js
                 JOIN "${this.sql.schema}".job_state_runs sr
                   ON sr.state_run_id = js.state_run_id
                 JOIN "${this.sql.schema}".jobs j
                   ON j.job_id = sr.job_id
                 WHERE js.session_id = $1
                 FOR UPDATE OF js, sr, j`,
                [sessionId],
            );
            const context = contextResult.rows[0];
            if (!context) {
                await client.query("COMMIT");
                return null;
            }
            if (!context.is_current
                || Number(context.state_revision) !== Number(context.job_state_revision)
                || !["active", "input_required"].includes(context.state_run_status)) {
                throw new Error("Response waits require the active current Job state run");
            }
            const existingResult = await client.query(
                `SELECT * FROM "${this.sql.schema}".job_waits
                 WHERE state_run_id = $1 AND wait_key = $2
                 FOR UPDATE`,
                [context.state_run_id, waitKey],
            );
            if (existingResult.rows[0]) {
                const existing = rowToJobWait(existingResult.rows[0]);
                const sameContract = existing.kind === "response"
                    && existing.sessionId === sessionId
                    && existing.expectedStateRevision === Number(context.state_revision)
                    && canonicalJson(existing.prompt) === canonicalJson(prompt)
                    && canonicalJson(existing.responseSchema) === canonicalJson(responseSchema)
                    && canonicalJson(existing.responderPolicy) === canonicalJson(responderPolicy);
                if (!sameContract) {
                    throw new Error("Response wait key is already bound to a different contract");
                }
                await client.query("COMMIT");
                return existing;
            }
            await client.query(
                `UPDATE "${this.sql.schema}".job_waits
                 SET status = 'cancelled',
                     updated_at = now()
                 WHERE state_run_id = $1
                   AND kind = 'response'
                   AND status = 'pending'
                 RETURNING wait_id`,
                [context.state_run_id],
            );
            const { rows } = await client.query(
                `INSERT INTO "${this.sql.schema}".job_waits (
                     wait_id, job_id, state_run_id, definition_id, session_id,
                     wait_key, kind, status, detection_mode, expected_state_revision,
                     prompt, response_schema, responder_policy, deadline_at
                 ) VALUES ($1,$2,$3,$4,$5,$6,'response','pending','direct_submission',$7,$8,$9,$10,$11)
                 RETURNING *`,
                [
                    randomUUID(),
                    context.job_id,
                    context.state_run_id,
                    context.definition_id,
                    sessionId,
                    waitKey,
                    Number(context.state_revision),
                    JSON.stringify(prompt),
                    JSON.stringify(responseSchema),
                    JSON.stringify(responderPolicy),
                    input.deadlineAt ?? null,
                ],
            );
            await client.query("COMMIT");
            return rowToJobWait(rows[0]);
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async acceptJobResponse(input: AcceptJobResponseInput): Promise<JobWaitRow | null> {
        const sessionId = input.sessionId.trim();
        const answer = input.answer.trim();
        if (!sessionId) throw new Error("Job response requires a sessionId");
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const contextResult = await client.query(
                `SELECT js.is_current, sr.state_run_id, sr.state_revision,
                        sr.status AS state_run_status,
                        j.state_revision AS job_state_revision
                 FROM "${this.sql.schema}".job_sessions js
                 JOIN "${this.sql.schema}".job_state_runs sr
                   ON sr.state_run_id = js.state_run_id
                 JOIN "${this.sql.schema}".jobs j
                   ON j.job_id = sr.job_id
                 WHERE js.session_id = $1
                 FOR UPDATE OF js, sr, j`,
                [sessionId],
            );
            const context = contextResult.rows[0];
            if (!context) {
                await client.query("COMMIT");
                return null;
            }
            if (!context.is_current
                || Number(context.state_revision) !== Number(context.job_state_revision)
                || !["active", "input_required"].includes(context.state_run_status)) {
                throw new Error("Job response does not target the active current state revision");
            }
            const waitResult = await client.query(
                `SELECT * FROM "${this.sql.schema}".job_waits
                 WHERE state_run_id = $1
                   AND kind = 'response'
                   AND status = 'pending'
                 LIMIT 1
                 FOR UPDATE`,
                [context.state_run_id],
            );
            const wait = waitResult.rows[0] ? rowToJobWait(waitResult.rows[0]) : null;
            if (!wait) {
                const latestResult = await client.query(
                    `SELECT * FROM "${this.sql.schema}".job_waits
                     WHERE state_run_id = $1
                       AND kind = 'response'
                     ORDER BY created_at DESC, wait_id DESC
                     LIMIT 1
                     FOR UPDATE`,
                    [context.state_run_id],
                );
                const latest = latestResult.rows[0] ? rowToJobWait(latestResult.rows[0]) : null;
                if (latest?.status === "satisfied") {
                    throw new Error("Job response wait is already satisfied");
                }
                if (context.state_run_status === "input_required") {
                    await client.query("COMMIT");
                    return null;
                }
                throw new Error("The current Job state run has no response wait");
            }
            if (!answer) throw new Error("Job response requires a non-empty answer");
            if (wait.expectedStateRevision !== Number(context.state_revision)) {
                throw new Error("Job response wait targets a stale state revision");
            }
            const choices = Array.isArray(wait.responseSchema.choices)
                ? wait.responseSchema.choices.filter((choice): choice is string => typeof choice === "string")
                : [];
            const allowFreeform = wait.responseSchema.allowFreeform !== false;
            if (!allowFreeform && !choices.includes(answer)) {
                throw new Error(`Job response must be one of: ${choices.join(", ")}`);
            }
            const responseId = randomUUID();
            const { rows } = await client.query(
                `UPDATE "${this.sql.schema}".job_waits
                 SET status = 'satisfied',
                     response_id = $2,
                     response = $3,
                     response_delivery_status = 'pending',
                     response_enqueued_at = NULL,
                     satisfaction_evidence = $4,
                     satisfied_by = $5,
                     satisfied_at = now(),
                     updated_at = now()
                 WHERE wait_id = $1
                   AND status = 'pending'
                   AND expected_state_revision = $6
                 RETURNING *`,
                [
                    wait.waitId,
                    responseId,
                    JSON.stringify({ answer }),
                    JSON.stringify({ source: "direct_submission", sessionId }),
                    input.respondedBy ? JSON.stringify(input.respondedBy) : null,
                    Number(context.state_revision),
                ],
            );
            if (!rows[0]) throw new Error("Job response wait was satisfied concurrently");
            await client.query("COMMIT");
            return rowToJobWait(rows[0]);
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async markJobResponseEnqueued(waitId: string, responseId: string): Promise<void> {
        const result = await this.pool.query(
            `UPDATE "${this.sql.schema}".job_waits
             SET response_delivery_status = 'enqueued',
                 response_enqueued_at = COALESCE(response_enqueued_at, now()),
                 updated_at = now()
             WHERE wait_id = $1
               AND response_id = $2
               AND status = 'satisfied'
               AND response_delivery_status IN ('pending', 'enqueued')`,
            [waitId.trim(), responseId.trim()],
        );
        if ((result.rowCount ?? 0) !== 1) {
            throw new Error("Job response wait enqueue acknowledgement is stale");
        }
    }

    async reopenJobResponseWait(waitId: string, responseId: string): Promise<void> {
        const normalizedWaitId = waitId.trim();
        const normalizedResponseId = responseId.trim();
        if (!normalizedWaitId || !normalizedResponseId) {
            throw new Error("Reopening a Job response wait requires waitId and responseId");
        }
        const result = await this.pool.query(
            `UPDATE "${this.sql.schema}".job_waits wait
             SET status = 'pending',
                 response_id = NULL,
                 response = NULL,
                 response_delivery_status = 'none',
                 response_enqueued_at = NULL,
                 satisfaction_evidence = NULL,
                 satisfied_by = NULL,
                 satisfied_at = NULL,
                 updated_at = now()
             FROM "${this.sql.schema}".job_state_runs state_run,
                  "${this.sql.schema}".jobs job
             WHERE wait.wait_id = $1
               AND wait.response_id = $2
               AND wait.status = 'satisfied'
               AND wait.response_delivery_status = 'pending'
               AND state_run.state_run_id = wait.state_run_id
               AND job.job_id = wait.job_id
               AND state_run.state_revision = job.state_revision
               AND state_run.status IN ('active', 'input_required')`,
            [normalizedWaitId, normalizedResponseId],
        );
        if ((result.rowCount ?? 0) !== 1) {
            throw new Error("Job response wait cannot be reopened");
        }
    }

    async startJobTimerWait(input: StartJobTimerWaitInput): Promise<JobWaitRow | null> {
        const sessionId = input.sessionId.trim();
        const waitKey = input.waitKey.trim();
        const reason = input.reason.trim();
        const dueAt = input.dueAt;
        if (!sessionId || !reason || !Number.isFinite(dueAt.getTime())) {
            throw new Error("Timer wait requires a sessionId, reason, and valid dueAt");
        }
        if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(waitKey)) {
            throw new Error("Timer wait key contains unsupported characters");
        }
        const prompt = { reason, dueAt: dueAt.toISOString() };
        const predicate = { dueAt: dueAt.toISOString() };
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const contextResult = await client.query(
                `SELECT js.is_current, sr.state_run_id, sr.job_id, sr.definition_id,
                        sr.state_revision, sr.status AS state_run_status,
                        j.state_revision AS job_state_revision
                 FROM "${this.sql.schema}".job_sessions js
                 JOIN "${this.sql.schema}".job_state_runs sr
                   ON sr.state_run_id = js.state_run_id
                 JOIN "${this.sql.schema}".jobs j
                   ON j.job_id = sr.job_id
                 WHERE js.session_id = $1
                 FOR UPDATE OF js, sr, j`,
                [sessionId],
            );
            const context = contextResult.rows[0];
            if (!context) {
                await client.query("COMMIT");
                return null;
            }
            if (!context.is_current
                || Number(context.state_revision) !== Number(context.job_state_revision)
                || !["active", "waiting", "input_required"].includes(context.state_run_status)) {
                throw new Error("Timer waits require the current Job state run");
            }
            const existingResult = await client.query(
                `SELECT * FROM "${this.sql.schema}".job_waits
                 WHERE state_run_id = $1 AND wait_key = $2
                 FOR UPDATE`,
                [context.state_run_id, waitKey],
            );
            if (existingResult.rows[0]) {
                const existing = rowToJobWait(existingResult.rows[0]);
                if (existing.kind !== "timer"
                    || existing.sessionId !== sessionId
                    || existing.expectedStateRevision !== Number(context.state_revision)
                    || canonicalJson(existing.prompt) !== canonicalJson(prompt)
                    || canonicalJson(existing.predicate) !== canonicalJson(predicate)) {
                    throw new Error("Timer wait key is already bound to a different contract");
                }
                await client.query("COMMIT");
                return existing;
            }
            await client.query(
                `UPDATE "${this.sql.schema}".job_waits
                 SET status = 'cancelled', updated_at = now()
                 WHERE state_run_id = $1
                   AND kind = 'timer'
                   AND status = 'pending'`,
                [context.state_run_id],
            );
            const { rows } = await client.query(
                `INSERT INTO "${this.sql.schema}".job_waits (
                     wait_id, job_id, state_run_id, definition_id, session_id,
                     wait_key, kind, status, detection_mode, expected_state_revision,
                     prompt, response_schema, responder_policy, predicate, next_check_at,
                     wait_started_at
                 ) VALUES (
                     $1,$2,$3,$4,$5,$6,'timer','pending','timer',$7,
                     $8,'{}'::jsonb,'{}'::jsonb,$9,$10,now()
                 )
                 RETURNING *`,
                [
                    randomUUID(),
                    context.job_id,
                    context.state_run_id,
                    context.definition_id,
                    sessionId,
                    waitKey,
                    Number(context.state_revision),
                    JSON.stringify(prompt),
                    JSON.stringify(predicate),
                    dueAt,
                ],
            );
            await client.query("COMMIT");
            return rowToJobWait(rows[0]);
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async completeJobTimerWait(sessionId: string): Promise<JobWaitRow | null> {
        const normalizedSessionId = sessionId.trim();
        if (!normalizedSessionId) throw new Error("Completing a timer wait requires sessionId");
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const contextResult = await client.query(
                `SELECT wait.*
                 FROM "${this.sql.schema}".job_waits wait
                 JOIN "${this.sql.schema}".job_state_runs state_run
                   ON state_run.state_run_id = wait.state_run_id
                 JOIN "${this.sql.schema}".jobs job
                   ON job.job_id = wait.job_id
                  AND job.state_revision = wait.expected_state_revision
                 JOIN "${this.sql.schema}".job_sessions session
                   ON session.state_run_id = wait.state_run_id
                  AND session.session_id = $1
                  AND session.is_current
                 WHERE wait.session_id = $1
                   AND wait.kind = 'timer'
                   AND wait.status = 'pending'
                   AND state_run.status IN ('active', 'waiting', 'input_required')
                 ORDER BY wait.created_at DESC, wait.wait_id DESC
                 LIMIT 1
                 FOR UPDATE OF wait, state_run, job, session`,
                [normalizedSessionId],
            );
            if (!contextResult.rows[0]) {
                await client.query("COMMIT");
                return null;
            }
            const firedAt = new Date();
            const evidence = {
                source: "durable_timer",
                sessionId: normalizedSessionId,
                firedAt: firedAt.toISOString(),
            };
            const { rows } = await client.query(
                `UPDATE "${this.sql.schema}".job_waits
                 SET status = 'satisfied',
                     latest_observation = $2,
                     satisfaction_evidence = $2,
                     next_check_at = NULL,
                     wait_completed_at = now(),
                     satisfied_at = now(),
                     updated_at = now()
                 WHERE wait_id = $1
                   AND status = 'pending'
                 RETURNING *`,
                [contextResult.rows[0].wait_id, JSON.stringify(evidence)],
            );
            await client.query("COMMIT");
            return rowToJobWait(rows[0]);
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async cancelJobTimerWait(sessionId: string): Promise<JobWaitRow | null> {
        const normalizedSessionId = sessionId.trim();
        if (!normalizedSessionId) throw new Error("Cancelling a timer wait requires sessionId");
        const { rows } = await this.pool.query(
            `WITH current_wait AS (
                 SELECT wait.wait_id
                 FROM "${this.sql.schema}".job_waits wait
                 JOIN "${this.sql.schema}".job_state_runs state_run
                   ON state_run.state_run_id = wait.state_run_id
                 JOIN "${this.sql.schema}".jobs job
                   ON job.job_id = wait.job_id
                  AND job.state_revision = wait.expected_state_revision
                 JOIN "${this.sql.schema}".job_sessions session
                   ON session.state_run_id = wait.state_run_id
                  AND session.session_id = $1
                  AND session.is_current
                 WHERE wait.session_id = $1
                   AND wait.kind = 'timer'
                   AND wait.status = 'pending'
                   AND state_run.status IN ('active', 'waiting', 'input_required')
                 ORDER BY wait.created_at DESC, wait.wait_id DESC
                 LIMIT 1
                 FOR UPDATE OF wait, state_run, job, session
             )
             UPDATE "${this.sql.schema}".job_waits wait
             SET status = 'cancelled',
                 next_check_at = NULL,
                 wait_completed_at = COALESCE(wait_completed_at, now()),
                 updated_at = now()
             FROM current_wait
             WHERE wait.wait_id = current_wait.wait_id
             RETURNING wait.*`,
            [normalizedSessionId],
        );
        return rows[0] ? rowToJobWait(rows[0]) : null;
    }

    async claimDueJobWaits(
        workerId: string,
        limit = 25,
        leaseSeconds = 30,
        observers?: readonly (string | JobWaitObserverSelector)[],
    ): Promise<JobWaitRow[]> {
        const normalizedWorkerId = workerId.trim();
        if (!normalizedWorkerId) throw new Error("Job wait claim requires workerId");
        if (!Number.isInteger(limit) || limit <= 0) throw new Error("Job wait claim limit must be positive");
        if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0) {
            throw new Error("Job wait leaseSeconds must be positive");
        }
        const identifierPattern = /^[a-z][a-z0-9_.-]*$/;
        const normalizedObservers = observers === undefined
            ? null
            : [...new Map(observers.map((observer) => {
                const selector = typeof observer === "string"
                    ? { provider: observer }
                    : observer;
                const provider = selector.provider.trim().toLowerCase();
                const kind = selector.kind?.trim().toLowerCase() || undefined;
                if (!identifierPattern.test(provider)) {
                    throw new Error("Job wait observer provider must be a lowercase identifier");
                }
                if (kind !== undefined && !identifierPattern.test(kind)) {
                    throw new Error("Job wait observer kind must be a lowercase identifier");
                }
                return [`${provider}\0${kind ?? "*"}`, { provider, ...(kind ? { kind } : {}) }];
            })).values()];
        const { rows } = await this.pool.query(
            `WITH due AS (
                 SELECT wait.wait_id
                 FROM "${this.sql.schema}".job_waits wait
                 JOIN "${this.sql.schema}".job_state_runs state_run
                   ON state_run.state_run_id = wait.state_run_id
                 JOIN "${this.sql.schema}".jobs job
                   ON job.job_id = wait.job_id
                  AND job.state_revision = wait.expected_state_revision
                  AND job.current_state = state_run.state_name
                  AND job.lifecycle_state NOT IN ('completed', 'cancelled')
                 JOIN "${this.sql.schema}".job_sessions session
                   ON session.state_run_id = wait.state_run_id
                  AND session.session_id = wait.session_id
                  AND session.is_current
                 WHERE wait.kind = 'observed_condition'
                   AND wait.status = 'pending'
                   AND wait.signal_key IS NOT NULL
                   AND (
                       $4::jsonb IS NULL
                       OR EXISTS (
                           SELECT 1
                           FROM jsonb_array_elements($4::jsonb) observer
                           WHERE wait.provider = observer->>'provider'
                             AND (
                                 NOT (observer ? 'kind')
                                 OR wait.predicate->>'kind' = observer->>'kind'
                             )
                       )
                       OR (wait.deadline_at IS NOT NULL AND wait.deadline_at <= now())
                   )
                   AND (
                       wait.next_check_at IS NOT NULL
                       OR wait.check_lease_expires_at IS NOT NULL
                   )
                   AND LEAST(
                       COALESCE(wait.next_check_at, wait.check_lease_expires_at),
                       COALESCE(
                           wait.deadline_at,
                           wait.next_check_at,
                           wait.check_lease_expires_at
                       )
                   ) <= now()
                   AND (
                       wait.check_lease_expires_at IS NULL
                       OR wait.check_lease_expires_at <= now()
                   )
                   AND state_run.status IN ('active', 'waiting', 'input_required')
                 ORDER BY LEAST(
                     COALESCE(wait.next_check_at, wait.check_lease_expires_at),
                     COALESCE(
                         wait.deadline_at,
                         wait.next_check_at,
                         wait.check_lease_expires_at
                     )
                 ), wait.created_at
                 FOR UPDATE OF wait SKIP LOCKED
                 LIMIT $2
             )
             UPDATE "${this.sql.schema}".job_waits wait
             SET check_lease_owner = $1,
                 check_lease_expires_at = now() + make_interval(secs => $3),
                 next_check_at = NULL,
                 check_attempts = check_attempts + 1,
                 updated_at = now()
             FROM due
             WHERE wait.wait_id = due.wait_id
             RETURNING wait.*`,
            [
                normalizedWorkerId,
                limit,
                leaseSeconds,
                normalizedObservers === null ? null : JSON.stringify(normalizedObservers),
            ],
        );
        return rows.map(rowToJobWait);
    }

    async completeJobWaitCheck(input: CompleteJobWaitCheckInput): Promise<JobWaitRow> {
        const waitId = input.waitId.trim();
        const workerId = input.workerId.trim();
        if (!waitId || !workerId) throw new Error("Completing a Job wait check requires waitId and workerId");
        if (!["pending", "satisfied", "failed", "timed_out"].includes(input.disposition)) {
            throw new Error("Job wait check disposition is invalid");
        }
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const contextResult = await client.query(
                `SELECT wait.*,
                        state_run.status AS state_run_status,
                        state_run.state_revision AS state_run_revision,
                        state_run.state_name,
                        job.state_revision AS job_state_revision,
                        job.current_state AS job_current_state,
                        job.lifecycle_state,
                        session.is_current,
                        wait.check_lease_expires_at > now() AS check_lease_is_valid,
                        wait.deadline_at IS NOT NULL
                            AND wait.deadline_at <= now() AS deadline_expired
                 FROM "${this.sql.schema}".job_waits wait
                 JOIN "${this.sql.schema}".job_state_runs state_run
                   ON state_run.state_run_id = wait.state_run_id
                 JOIN "${this.sql.schema}".jobs job
                   ON job.job_id = wait.job_id
                 JOIN "${this.sql.schema}".job_sessions session
                   ON session.state_run_id = wait.state_run_id
                  AND session.session_id = wait.session_id
                 WHERE wait.wait_id = $1
                 FOR UPDATE OF wait, state_run, job, session`,
                [waitId],
            );
            const context = contextResult.rows[0];
            if (!context) throw new Error(`Job wait not found: ${waitId}`);
            if (context.kind !== "observed_condition"
                || context.status !== "pending"
                || context.check_lease_owner !== workerId
                || !context.check_lease_expires_at
                || !context.check_lease_is_valid) {
                throw new Error("Job wait check lease is stale");
            }
            if (!context.is_current
                || Number(context.expected_state_revision) !== Number(context.job_state_revision)
                || Number(context.state_run_revision) !== Number(context.job_state_revision)
                || context.state_name !== context.job_current_state
                || ["completed", "failed"].includes(context.state_run_status)
                || ["completed", "cancelled"].includes(context.lifecycle_state)) {
                throw new Error("Job wait targets a stale state revision");
            }

            const disposition: JobWaitCheckDisposition = context.deadline_expired
                && input.disposition === "pending"
                ? "timed_out"
                : input.disposition;
            if (disposition === "pending" && !input.nextCheckAt) {
                throw new Error("A pending Job wait observation requires nextCheckAt");
            }
            const requestedNextCheckAt = disposition === "pending"
                && context.deadline_at
                && input.nextCheckAt! > new Date(context.deadline_at)
                ? new Date(context.deadline_at)
                : input.nextCheckAt!;
            const acceleratedNextCheckAt = context.next_check_at
                ? new Date(context.next_check_at)
                : null;
            const nextCheckAt = disposition === "pending"
                ? (
                    acceleratedNextCheckAt
                    && acceleratedNextCheckAt < requestedNextCheckAt
                        ? acceleratedNextCheckAt
                        : requestedNextCheckAt
                )
                : null;
            const observation = input.observation === undefined
                ? context.latest_observation
                : input.observation;
            const providerCursor = input.providerCursor === undefined
                ? context.provider_cursor
                : input.providerCursor;
            const evidence = input.evidence === undefined
                ? context.satisfaction_evidence
                : jobWaitEvidence(input.evidence);
            const result = input.result === undefined ? observation : input.result;
            const error = disposition === "pending" || disposition === "failed" || disposition === "timed_out"
                ? input.error ?? (disposition === "timed_out" ? "Job wait deadline elapsed" : null)
                : null;
            const { rows } = await client.query(
                `UPDATE "${this.sql.schema}".job_waits
                 SET status = $3,
                     provider_cursor = $4,
                     latest_observation = $5,
                     satisfaction_evidence = CASE
                         WHEN $3 = 'satisfied' THEN $6::jsonb
                         ELSE NULL
                     END,
                     last_checked_at = now(),
                     consecutive_check_failures = CASE
                         WHEN $3 = 'pending' AND $7::text IS NOT NULL
                             THEN consecutive_check_failures + 1
                         ELSE 0
                     END,
                     check_lease_owner = NULL,
                     check_lease_expires_at = NULL,
                     last_check_error = $7::text,
                     next_check_at = $8,
                     satisfied_at = CASE WHEN $3 = 'satisfied' THEN now() ELSE NULL END,
                     updated_at = now()
                 WHERE wait_id = $1
                   AND check_lease_owner = $2
                   AND check_lease_expires_at > now()
                   AND status = 'pending'
                 RETURNING *`,
                [
                    waitId,
                    workerId,
                    disposition,
                    providerCursor === undefined ? null : JSON.stringify(providerCursor),
                    observation === undefined ? null : JSON.stringify(observation),
                    evidence === null || evidence === undefined ? null : JSON.stringify(evidence),
                    error,
                    nextCheckAt,
                ],
            );
            if (!rows[0]) throw new Error("Job wait check lease is stale");

            if (context.external_operation_id) {
                if (disposition === "pending") {
                    await client.query(
                        `UPDATE "${this.sql.schema}".job_external_operations
                         SET result = $2,
                             error = $3,
                             next_poll_at = $4,
                             poll_lease_owner = NULL,
                             poll_lease_expires_at = NULL,
                             updated_at = now()
                         WHERE operation_id = $1
                           AND status = 'pending'`,
                        [
                            context.external_operation_id,
                            observation === undefined ? null : JSON.stringify(observation),
                            error,
                            nextCheckAt,
                        ],
                    );
                } else {
                    await client.query(
                        `UPDATE "${this.sql.schema}".job_external_operations
                         SET status = $2,
                             result = $3,
                             evidence = $4,
                             error = $5,
                             completed_at = now(),
                             poll_lease_owner = NULL,
                             poll_lease_expires_at = NULL,
                             signal_status = 'pending',
                             next_signal_at = now(),
                             updated_at = now()
                         WHERE operation_id = $1
                           AND status = 'pending'`,
                        [
                            context.external_operation_id,
                            disposition === "satisfied" ? "succeeded" : "failed",
                            result === undefined ? null : JSON.stringify(result),
                            evidence === null || evidence === undefined ? null : JSON.stringify(evidence),
                            error,
                        ],
                    );
                }
            }
            await client.query("COMMIT");
            return rowToJobWait(rows[0]);
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async accelerateJobWaitCheck(
        waitId: string,
        expectedStateRevision: number,
        checkAt = new Date(),
    ): Promise<boolean> {
        if (!Number.isFinite(checkAt.getTime())) throw new Error("Job wait acceleration requires valid checkAt");
        const result = await this.pool.query(
            `UPDATE "${this.sql.schema}".job_waits wait
             SET next_check_at = LEAST(COALESCE(wait.next_check_at, $3), $3),
                 updated_at = now()
             FROM "${this.sql.schema}".job_state_runs state_run,
                  "${this.sql.schema}".jobs job
             WHERE wait.wait_id = $1
               AND wait.expected_state_revision = $2
               AND wait.kind = 'observed_condition'
               AND wait.status = 'pending'
               AND wait.detection_mode IN ('event', 'hybrid')
               AND state_run.state_run_id = wait.state_run_id
               AND state_run.status IN ('active', 'waiting', 'input_required')
               AND job.job_id = wait.job_id
               AND job.state_revision = wait.expected_state_revision
               AND job.current_state = state_run.state_name
               AND job.lifecycle_state NOT IN ('completed', 'cancelled')`,
            [waitId.trim(), expectedStateRevision, checkAt],
        );
        return (result.rowCount ?? 0) === 1;
    }

    async accelerateJobWaitChecksByTarget(
        provider: string,
        kind: string,
        resourceKey: string,
        checkAt = new Date(),
    ): Promise<number> {
        const normalizedProvider = provider.trim().toLowerCase();
        const normalizedKind = kind.trim().toLowerCase();
        const normalizedResourceKey = resourceKey.trim();
        const identifierPattern = /^[a-z][a-z0-9_.-]*$/;
        if (!identifierPattern.test(normalizedProvider) || !identifierPattern.test(normalizedKind)) {
            throw new Error("Job wait acceleration requires valid provider and kind identifiers");
        }
        if (!normalizedResourceKey || normalizedResourceKey.length > 2048) {
            throw new Error("Job wait acceleration requires a valid resourceKey");
        }
        if (!Number.isFinite(checkAt.getTime())) {
            throw new Error("Job wait acceleration requires valid checkAt");
        }
        const result = await this.pool.query(
            `UPDATE "${this.sql.schema}".job_waits wait
             SET next_check_at = LEAST(COALESCE(wait.next_check_at, $4), $4),
                 updated_at = now()
             FROM "${this.sql.schema}".job_state_runs state_run,
                  "${this.sql.schema}".jobs job
             WHERE wait.provider = $1
               AND wait.predicate->>'kind' = $2
               AND wait.target->>'resourceKey' = $3
               AND wait.kind = 'observed_condition'
               AND wait.status = 'pending'
               AND wait.detection_mode IN ('event', 'hybrid')
               AND state_run.state_run_id = wait.state_run_id
               AND state_run.status IN ('active', 'waiting', 'input_required')
               AND job.job_id = wait.job_id
               AND job.state_revision = wait.expected_state_revision
               AND job.current_state = state_run.state_name
               AND job.lifecycle_state NOT IN ('completed', 'cancelled')`,
            [normalizedProvider, normalizedKind, normalizedResourceKey, checkAt],
        );
        return result.rowCount ?? 0;
    }

    async recordJobWaitBoundary(
        sessionId: string,
        signalKey: string,
        phase: "started" | "completed",
    ): Promise<boolean> {
        const normalizedSessionId = sessionId.trim();
        const normalizedSignalKey = signalKey.trim();
        if (!normalizedSessionId || !normalizedSignalKey) {
            throw new Error("Recording a Job wait boundary requires sessionId and signalKey");
        }
        // Best-effort identity stamp driven by the session.system_wait_* event.
        // This runs on the recordSessionEvent activity, which is decoupled from —
        // and can lose a visibility race against — the wait-row creation done by
        // the producer's startJobExternalOperation. A no-match here is therefore
        // EXPECTED and must NOT throw: recordJobExternalOperationWait is wrapped in
        // cmsRetryCritical (swallow:false, no retry on non-transient errors), so a
        // thrown no-match immediately fails the whole recordSessionEvent activity
        // and drops the event batch — and, because the boundary event never fires
        // again, permanently strands the Job (the signal-claim path requires
        // wait_started_at IS NOT NULL, so the resume signal is never delivered).
        //
        // The AUTHORITATIVE started stamp is written in setJobSessionExecutionStatus
        // when the session durably parks: that path always runs after the wait-
        // creating tool has committed and flips the state run to 'waiting' in the
        // same transaction, so it closes the race regardless of this event's
        // ordering. This call remains only as a fast-path best-effort stamp.
        return this.recordJobWaitBoundaryOnce(normalizedSessionId, normalizedSignalKey, phase);
    }

    /**
     * Single-attempt wait-boundary write. Returns true when a matching wait row
     * was stamped, false on no-match.
     *
     * The `started` phase matches the wait by stable identity — the current
     * session plus signal key — and deliberately does NOT gate on
     * job.state_revision / current_state. Those job-progress predicates can
     * transiently differ while the job row advances, and gating the started
     * stamp on them previously produced a silent no-match that stranded the Job.
     * The stamp is idempotent (COALESCE), so recording "this session parked on
     * this wait" is safe regardless of where the job row is mid-transition.
     *
     * The `completed` phase keeps the full job-progress predicates and the
     * wait_started_at prerequisite because it delivers the resume signal and must
     * not fire for a stale state revision or an unstarted wait.
     */
    private async recordJobWaitBoundaryOnce(
        normalizedSessionId: string,
        normalizedSignalKey: string,
        phase: "started" | "completed",
    ): Promise<boolean> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            let rows: Array<{ external_operation_id: string | null }>;
            if (phase === "started") {
                ({ rows } = await client.query(
                    `UPDATE "${this.sql.schema}".job_waits wait
                     SET wait_started_at = COALESCE(wait.wait_started_at, now()),
                         session_id = $1,
                         updated_at = now()
                     FROM "${this.sql.schema}".job_sessions session
                     WHERE wait.state_run_id = session.state_run_id
                       AND session.session_id = $1
                       AND session.is_current
                       AND wait.signal_key = $2
                     RETURNING wait.external_operation_id`,
                    [normalizedSessionId, normalizedSignalKey],
                ));
            } else {
                ({ rows } = await client.query(
                    `UPDATE "${this.sql.schema}".job_waits wait
                     SET wait_completed_at = COALESCE(wait.wait_completed_at, now()),
                         session_id = $1,
                         updated_at = now()
                     FROM "${this.sql.schema}".job_state_runs state_run,
                          "${this.sql.schema}".jobs job,
                          "${this.sql.schema}".job_sessions session
                     WHERE wait.state_run_id = state_run.state_run_id
                       AND wait.job_id = job.job_id
                       AND wait.state_run_id = session.state_run_id
                       AND session.session_id = $1
                       AND session.is_current
                       AND wait.signal_key = $2
                       AND wait.expected_state_revision = job.state_revision
                       AND job.current_state = state_run.state_name
                       AND wait.wait_started_at IS NOT NULL
                     RETURNING wait.external_operation_id`,
                    [normalizedSessionId, normalizedSignalKey],
                ));
            }
            if (!rows[0]) {
                await client.query("COMMIT");
                return false;
            }
            const timestampColumn = phase === "started" ? "wait_started_at" : "wait_completed_at";
            const signalDeliverySet = phase === "completed"
                ? `,
                         signal_status = CASE
                             WHEN signal_status IN ('pending', 'delivering') THEN 'delivered'
                             ELSE signal_status
                         END,
                         signal_delivered_at = CASE
                             WHEN signal_status IN ('pending', 'delivering')
                                 THEN COALESCE(signal_delivered_at, now())
                             ELSE signal_delivered_at
                         END,
                         signal_lease_owner = NULL,
                         signal_lease_expires_at = NULL,
                         last_signal_error = NULL`
                : "";
            if (rows[0].external_operation_id) {
                await client.query(
                    `UPDATE "${this.sql.schema}".job_external_operations
                     SET ${timestampColumn} = COALESCE(${timestampColumn}, now()),
                         session_id = $1
                         ${signalDeliverySet},
                         updated_at = now()
                     WHERE operation_id = $2`,
                    [normalizedSessionId, rows[0].external_operation_id],
                );
            }
            await client.query("COMMIT");
            return true;
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async readJobSourceSession(
        currentSessionId: string,
        sourceSessionId: string,
        beforeSeq?: number,
        limit = 20,
    ): Promise<JobSourceSessionContext | null> {
        const current = currentSessionId.trim();
        const source = sourceSessionId.trim();
        if (!current || !source) throw new Error("Current and source Job session IDs are required");
        if (beforeSeq !== undefined && (!Number.isInteger(beforeSeq) || beforeSeq <= 0)) {
            throw new Error("Job source session beforeSeq must be a positive integer");
        }
        const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 50));
        const { rows } = await this.pool.query(
            `SELECT journal.*
             FROM "${this.sql.schema}".job_sessions current_session
             JOIN "${this.sql.schema}".job_journal_entries journal
               ON journal.job_id = current_session.job_id
              AND journal.session_id = $2
             WHERE current_session.session_id = $1
               AND current_session.is_current
             ORDER BY journal.sequence DESC
             LIMIT 1`,
            [current, source],
        );
        if (!rows[0]) return null;

        const page = beforeSeq === undefined
            ? await this.getSessionEvents(source, undefined, boundedLimit + 1)
            : await this.getSessionEventsBefore(source, beforeSeq, boundedLimit + 1);
        const hasMore = page.length > boundedLimit;
        return {
            journalEntry: rowToJobJournalEntry(rows[0]),
            events: hasMore ? page.slice(1) : page,
            hasMore,
        };
    }

    async startJobExternalOperation(
        input: StartJobExternalOperationInput,
    ): Promise<JobExternalOperationRow> {
        const provider = input.provider.trim().toLowerCase();
        const kind = input.kind.trim().toLowerCase();
        const operationKey = input.operationKey?.trim() || "default";
        const detectionMode = input.detectionMode ?? "poll";
        const identifierPattern = /^[a-z][a-z0-9_.-]*$/;
        if (!identifierPattern.test(provider)) {
            throw new Error("External operation provider must be a lowercase identifier");
        }
        if (!identifierPattern.test(kind)) {
            throw new Error("External operation kind must be a lowercase identifier");
        }
        if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(operationKey)) {
            throw new Error("External operation key contains unsupported characters");
        }
        if (!["poll", "event", "hybrid"].includes(detectionMode)) {
            throw new Error("External operation detectionMode must be poll, event, or hybrid");
        }
        if (input.deadlineAt && !Number.isFinite(input.deadlineAt.getTime())) {
            throw new Error("External operation deadlineAt must be valid");
        }
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const contextResult = await client.query(
                `SELECT sr.state_run_id, sr.job_id, sr.definition_id, sr.state_revision, sr.status,
                        js.is_current
                 FROM "${this.sql.schema}".job_sessions js
                 JOIN "${this.sql.schema}".job_state_runs sr
                   ON sr.state_run_id = js.state_run_id
                 WHERE js.session_id = $1
                 FOR UPDATE OF js, sr`,
                [input.sessionId],
            );
            const context = contextResult.rows[0];
            if (!context) throw new Error(`Job state run not found for session ${input.sessionId}`);
            if (!context.is_current || context.status !== "active") {
                throw new Error("External operations require the active current Job state run");
            }
            const ensureObservedConditionWait = async (
                operation: any,
                rebindSession = false,
            ): Promise<void> => {
                const waitStatus = operation.status === "succeeded"
                    ? "satisfied"
                    : operation.status === "failed"
                        ? "failed"
                        : "pending";
                await client.query(
                    `INSERT INTO "${this.sql.schema}".job_waits (
                         wait_id, job_id, state_run_id, definition_id, session_id,
                         external_operation_id, wait_key, kind, status, detection_mode,
                         expected_state_revision, prompt, response_schema, responder_policy,
                         provider, target, predicate, latest_observation,
                         satisfaction_evidence, signal_key, deadline_at, next_check_at, satisfied_at
                     ) VALUES (
                         $1,$2,$3,$4,$5,$6,$7,'observed_condition',$8,$9,
                         $10,$11,'{}'::jsonb,'{}'::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20
                     )
                     ON CONFLICT (state_run_id, wait_key) DO UPDATE
                     SET session_id = EXCLUDED.session_id,
                         external_operation_id = EXCLUDED.external_operation_id,
                         status = EXCLUDED.status,
                         detection_mode = EXCLUDED.detection_mode,
                         provider = EXCLUDED.provider,
                         target = EXCLUDED.target,
                         predicate = EXCLUDED.predicate,
                         latest_observation = EXCLUDED.latest_observation,
                         satisfaction_evidence = EXCLUDED.satisfaction_evidence,
                         signal_key = EXCLUDED.signal_key,
                         deadline_at = EXCLUDED.deadline_at,
                         next_check_at = EXCLUDED.next_check_at,
                         check_lease_owner = NULL,
                         check_lease_expires_at = NULL,
                         last_check_error = NULL,
                         wait_started_at = NULL,
                         wait_completed_at = NULL,
                         satisfied_at = EXCLUDED.satisfied_at,
                         updated_at = now()
                     WHERE $21::boolean`,
                    [
                        randomUUID(),
                        context.job_id,
                        context.state_run_id,
                        context.definition_id,
                        operation.session_id,
                        operation.operation_id,
                        `observed:${provider}:${kind}:${operationKey}`,
                        waitStatus,
                        detectionMode,
                        Number(context.state_revision),
                        JSON.stringify({ provider, kind, operationKey }),
                        provider,
                        JSON.stringify(operation.request ?? {}),
                        JSON.stringify({ kind }),
                        operation.result === null || operation.result === undefined
                            ? null
                            : JSON.stringify(operation.result),
                        operation.evidence === null || operation.evidence === undefined
                            ? null
                            : JSON.stringify(jobWaitEvidence(operation.evidence)),
                        operation.signal_key,
                        input.deadlineAt ?? null,
                        waitStatus === "pending"
                            ? (
                                input.deadlineAt && input.deadlineAt < operation.next_poll_at
                                    ? input.deadlineAt
                                    : operation.next_poll_at
                            )
                            : null,
                        waitStatus === "pending" ? null : operation.completed_at,
                        rebindSession,
                    ],
                );
            };
            const idempotencyKey = [
                "job-state-run",
                context.state_run_id,
                "operation",
                provider,
                kind,
                operationKey,
            ].join(":");
            const existing = await client.query(
                `SELECT * FROM "${this.sql.schema}".job_external_operations
                 WHERE idempotency_key = $1`,
                [idempotencyKey],
            );
            if (existing.rows[0]) {
                const existingOperation = existing.rows[0];
                if (existingOperation.session_id !== input.sessionId
                    && existingOperation.wait_completed_at === null) {
                    const rebound = await client.query(
                        `UPDATE "${this.sql.schema}".job_external_operations
                         SET session_id = $2,
                             wait_started_at = NULL,
                             signal_status = CASE
                                 WHEN status = 'pending' THEN 'blocked'
                                 ELSE 'pending'
                             END,
                             signal_attempts = 0,
                             next_signal_at = CASE
                                 WHEN status = 'pending' THEN NULL
                                 ELSE now()
                             END,
                             signal_lease_owner = NULL,
                             signal_lease_expires_at = NULL,
                             signal_delivered_at = NULL,
                             last_signal_error = NULL,
                             updated_at = now()
                         WHERE operation_id = $1
                         RETURNING *`,
                        [existingOperation.operation_id, input.sessionId],
                    );
                    await ensureObservedConditionWait(rebound.rows[0], true);
                    await client.query("COMMIT");
                    return rowToJobExternalOperation(rebound.rows[0]);
                }
                await ensureObservedConditionWait(existingOperation);
                await client.query("COMMIT");
                return rowToJobExternalOperation(existingOperation);
            }
            const operationId = randomUUID();
            const result = await client.query(
                `INSERT INTO "${this.sql.schema}".job_external_operations (
                     operation_id, job_id, state_run_id, definition_id,
                     created_session_id, session_id, provider, kind, operation_key,
                     idempotency_key, correlation_id, signal_key, request, next_poll_at
                 ) VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                 RETURNING *`,
                [
                    operationId,
                    context.job_id,
                    context.state_run_id,
                    context.definition_id,
                    input.sessionId,
                    provider,
                    kind,
                    operationKey,
                    idempotencyKey,
                    `${provider}:${operationId}`,
                    `job-operation:${operationId}`,
                    JSON.stringify(input.request ?? {}),
                    input.nextPollAt ?? new Date(),
                ],
            );
            await ensureObservedConditionWait(result.rows[0]);
            await client.query("COMMIT");
            return rowToJobExternalOperation(result.rows[0]);
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    async getJobExternalOperation(
        sessionId: string,
        operationId: string,
    ): Promise<JobExternalOperationRow | null> {
        const { rows } = await this.pool.query(
            `SELECT operation.*
             FROM "${this.sql.schema}".job_external_operations operation
             JOIN "${this.sql.schema}".job_state_runs state_run
               ON state_run.state_run_id = operation.state_run_id
             WHERE operation.operation_id = $1
               AND state_run.session_id = $2`,
            [operationId, sessionId],
        );
        return rows[0] ? rowToJobExternalOperation(rows[0]) : null;
    }

    async recordJobExternalOperationWait(
        sessionId: string,
        signalKey: string,
        phase: "started" | "completed",
    ): Promise<boolean> {
        return this.recordJobWaitBoundary(sessionId, signalKey, phase);
    }

    async claimDueJobExternalOperations(
        provider: string,
        workerId: string,
        limit = 25,
        leaseSeconds = 30,
    ): Promise<JobExternalOperationRow[]> {
        const { rows } = await this.pool.query(
            `WITH due AS (
                 SELECT operation.operation_id
                 FROM "${this.sql.schema}".job_external_operations operation
                 JOIN "${this.sql.schema}".job_waits wait
                   ON wait.external_operation_id = operation.operation_id
                  AND wait.status = 'pending'
                 JOIN "${this.sql.schema}".job_state_runs state_run
                   ON state_run.state_run_id = operation.state_run_id
                  AND state_run.status IN ('active', 'waiting', 'input_required')
                 JOIN "${this.sql.schema}".jobs job
                   ON job.job_id = operation.job_id
                  AND job.state_revision = wait.expected_state_revision
                  AND job.current_state = state_run.state_name
                  AND job.lifecycle_state NOT IN ('completed', 'cancelled')
                 JOIN "${this.sql.schema}".job_sessions session
                   ON session.state_run_id = operation.state_run_id
                  AND session.session_id = operation.session_id
                  AND session.is_current
                 WHERE operation.provider = $1
                   AND operation.status = 'pending'
                   AND operation.next_poll_at <= now()
                   AND (
                       operation.poll_lease_expires_at IS NULL
                       OR operation.poll_lease_expires_at <= now()
                   )
                 ORDER BY operation.next_poll_at, operation.created_at
                 FOR UPDATE OF operation SKIP LOCKED
                 LIMIT $3
             )
             UPDATE "${this.sql.schema}".job_external_operations operation
             SET poll_lease_owner = $2,
                 poll_lease_expires_at = now() + make_interval(secs => $4),
                 updated_at = now()
             FROM due
             WHERE operation.operation_id = due.operation_id
             RETURNING operation.*`,
            [provider.trim().toLowerCase(), workerId, limit, leaseSeconds],
        );
        return rows.map(rowToJobExternalOperation);
    }

    async completeJobExternalOperation(
        input: CompleteJobExternalOperationInput,
    ): Promise<JobExternalOperationRow> {
        const { rows } = await this.pool.query(
            `WITH completed_operation AS (
                 UPDATE "${this.sql.schema}".job_external_operations operation
                 SET status = $3,
                     result = $4,
                     evidence = $5,
                     error = $6,
                     completed_at = now(),
                     poll_lease_owner = NULL,
                     poll_lease_expires_at = NULL,
                     signal_status = 'pending',
                     next_signal_at = now(),
                     updated_at = now()
                 FROM "${this.sql.schema}".job_waits wait,
                      "${this.sql.schema}".job_state_runs state_run,
                      "${this.sql.schema}".jobs job,
                      "${this.sql.schema}".job_sessions session
                 WHERE operation.operation_id = $1
                   AND operation.poll_lease_owner = $2
                   AND operation.poll_lease_expires_at > now()
                   AND operation.status = 'pending'
                   AND wait.external_operation_id = operation.operation_id
                   AND wait.status = 'pending'
                   AND state_run.state_run_id = operation.state_run_id
                   AND state_run.status IN ('active', 'waiting', 'input_required')
                   AND job.job_id = operation.job_id
                   AND job.state_revision = wait.expected_state_revision
                   AND job.current_state = state_run.state_name
                   AND job.lifecycle_state NOT IN ('completed', 'cancelled')
                   AND session.state_run_id = operation.state_run_id
                   AND session.session_id = operation.session_id
                   AND session.is_current
                 RETURNING operation.*
             ), completed_wait AS (
                 UPDATE "${this.sql.schema}".job_waits wait
                 SET status = CASE WHEN operation.status = 'succeeded' THEN 'satisfied' ELSE 'failed' END,
                     latest_observation = operation.result,
                     satisfaction_evidence = CASE
                         WHEN operation.evidence IS NULL THEN NULL
                         WHEN jsonb_typeof(operation.evidence) = 'object' THEN operation.evidence
                         ELSE jsonb_build_object('value', operation.evidence)
                     END,
                     next_check_at = NULL,
                     satisfied_at = operation.completed_at,
                     updated_at = now()
                 FROM completed_operation operation,
                      "${this.sql.schema}".job_state_runs state_run,
                      "${this.sql.schema}".jobs job
                 WHERE wait.external_operation_id = operation.operation_id
                   AND wait.status = 'pending'
                   AND state_run.state_run_id = wait.state_run_id
                   AND state_run.status IN ('active', 'waiting', 'input_required')
                   AND job.job_id = wait.job_id
                   AND job.state_revision = wait.expected_state_revision
                   AND job.current_state = state_run.state_name
                   AND job.lifecycle_state NOT IN ('completed', 'cancelled')
                 RETURNING wait.wait_id
             )
             SELECT * FROM completed_operation`,
            [
                input.operationId,
                input.workerId,
                input.status,
                input.result === undefined ? null : JSON.stringify(input.result),
                input.evidence === undefined ? null : JSON.stringify(input.evidence),
                input.error ?? null,
            ],
        );
        if (!rows[0]) throw new Error("External operation completion lease is stale");
        return rowToJobExternalOperation(rows[0]);
    }

    async claimJobExternalOperationSignals(
        workerId: string,
        limit = 25,
        leaseSeconds = 30,
    ): Promise<JobExternalOperationRow[]> {
        const { rows } = await this.pool.query(
            `WITH due AS (
                 SELECT operation.operation_id
                 FROM "${this.sql.schema}".job_external_operations operation
                 JOIN "${this.sql.schema}".job_waits wait
                   ON wait.external_operation_id = operation.operation_id
                  AND wait.status IN ('satisfied', 'failed', 'timed_out')
                  AND wait.wait_started_at IS NOT NULL
                  AND wait.wait_completed_at IS NULL
                 JOIN "${this.sql.schema}".job_state_runs state_run
                   ON state_run.state_run_id = operation.state_run_id
                  AND state_run.status IN ('waiting', 'input_required', 'active')
                 JOIN "${this.sql.schema}".jobs job
                   ON job.job_id = operation.job_id
                  AND job.state_revision = wait.expected_state_revision
                  AND job.current_state = state_run.state_name
                  AND job.lifecycle_state NOT IN ('completed', 'cancelled')
                 JOIN "${this.sql.schema}".job_sessions session
                   ON session.state_run_id = operation.state_run_id
                  AND session.session_id = operation.session_id
                  AND session.is_current
                 WHERE operation.status IN ('succeeded', 'failed')
                   AND operation.signal_status IN ('pending', 'delivering')
                   AND operation.next_signal_at <= now()
                   AND (
                       (
                           operation.signal_status = 'pending'
                       )
                       OR (
                           operation.signal_status = 'delivering'
                           AND (
                               operation.signal_lease_expires_at IS NULL
                               OR operation.signal_lease_expires_at <= now()
                           )
                       )
                   )
                 ORDER BY operation.next_signal_at, operation.completed_at
                 FOR UPDATE OF operation SKIP LOCKED
                 LIMIT $2
             )
             UPDATE "${this.sql.schema}".job_external_operations operation
             SET signal_status = 'delivering',
                 signal_attempts = signal_attempts + 1,
                 signal_lease_owner = $1,
                 signal_lease_expires_at = now() + make_interval(secs => $3),
                 updated_at = now()
             FROM due
             WHERE operation.operation_id = due.operation_id
             RETURNING operation.*`,
            [workerId, limit, leaseSeconds],
        );
        return rows.map(rowToJobExternalOperation);
    }

    async markJobExternalOperationSignalDelivered(
        operationId: string,
        workerId: string,
    ): Promise<void> {
        const result = await this.pool.query(
            `UPDATE "${this.sql.schema}".job_external_operations
             SET signal_status = 'delivered',
                 signal_delivered_at = COALESCE(signal_delivered_at, now()),
                 signal_lease_owner = NULL,
                 signal_lease_expires_at = NULL,
                 last_signal_error = NULL,
                 updated_at = now()
             WHERE operation_id = $1
               AND (
                   (signal_status = 'delivering' AND signal_lease_owner = $2)
                   OR signal_status = 'delivered'
               )`,
            [operationId, workerId],
        );
        if ((result.rowCount ?? 0) !== 1) throw new Error("External operation signal lease is stale");
    }

    async markJobExternalOperationSignalFailed(
        operationId: string,
        workerId: string,
        error: string,
        retryAt: Date,
    ): Promise<void> {
        const result = await this.pool.query(
            `UPDATE "${this.sql.schema}".job_external_operations
             SET signal_status = 'pending',
                 next_signal_at = $3,
                 signal_lease_owner = NULL,
                 signal_lease_expires_at = NULL,
                 last_signal_error = $4,
                 updated_at = now()
             WHERE operation_id = $1
               AND signal_status = 'delivering'
               AND signal_lease_owner = $2`,
            [operationId, workerId, retryAt, error],
        );
        if ((result.rowCount ?? 0) !== 1) throw new Error("External operation signal lease is stale");
    }

    async completeJobState(input: CompleteJobStateInput): Promise<JobJournalEntryRow> {
        const summary = input.summary.trim();
        if (!summary) throw new Error("Job state transition summary is required");
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const contextResult = await client.query(
                `SELECT sr.*, js.association_id, js.is_current,
                        j.current_state AS job_current_state,
                        j.state_revision AS job_state_revision,
                        j.lifecycle_state
                 FROM "${this.sql.schema}".job_sessions js
                 JOIN "${this.sql.schema}".job_state_runs sr
                   ON sr.state_run_id = js.state_run_id
                 JOIN "${this.sql.schema}".jobs j
                   ON j.job_id = sr.job_id
                 WHERE js.session_id = $1
                 FOR UPDATE OF js, sr, j`,
                [input.sessionId],
            );
            const context = contextResult.rows[0];
            if (!context) throw new Error(`Job state run not found for session ${input.sessionId}`);
            const idempotencyKey = input.idempotencyKey?.trim() || `job-state-run:${context.state_run_id}`;
            const existing = await client.query(
                `SELECT * FROM "${this.sql.schema}".job_journal_entries
                 WHERE idempotency_key = $1`,
                [idempotencyKey],
            );
            if (existing.rows[0]) {
                if (existing.rows[0].state_run_id !== context.state_run_id
                    || existing.rows[0].session_id !== input.sessionId) {
                    throw new Error("Job state idempotency key is already used by another transition");
                }
                await client.query("COMMIT");
                return rowToJobJournalEntry(existing.rows[0]);
            }
            if (!context.is_current || context.status !== "active") {
                throw new Error("Job state run is not the active current run");
            }
            if (context.job_current_state !== context.state_name
                || Number(context.job_state_revision) !== Number(context.state_revision)) {
                throw new Error("Job state run revision is stale");
            }
            if (typeof context.terminal !== "boolean") {
                throw new Error("Job state run has not been prepared with lifecycle instructions");
            }

            const allowedOutcomes = Array.isArray(context.allowed_outcomes)
                ? context.allowed_outcomes as JobStateOutcome[]
                : [];
            const requestedOutcome = input.outcome?.trim() || null;
            let toState = context.state_name;
            let toRevision = Number(context.state_revision);
            if (context.terminal) {
                if (requestedOutcome) throw new Error("Terminal Job state completion must not specify an outcome");
            } else {
                if (!requestedOutcome) throw new Error("Job state outcome is required");
                const allowed = allowedOutcomes.find((entry) => entry.outcome === requestedOutcome);
                if (!allowed) throw new Error(`Job state outcome is not allowed: ${requestedOutcome}`);
                toState = allowed.toState;
                toRevision += 1;
            }

            if (!context.terminal) {
                const definitionResult = await client.query(
                    `SELECT validation_gates
                     FROM "${this.sql.schema}".job_generator_definitions
                     WHERE definition_id = $1`,
                    [context.definition_id],
                );
                const validationGates = Array.isArray(definitionResult.rows[0]?.validation_gates)
                    ? definitionResult.rows[0].validation_gates as unknown[]
                    : [];
                const operationResult = await client.query(
                    `SELECT operation.*
                     FROM "${this.sql.schema}".job_external_operations operation
                     WHERE operation.state_run_id = $1
                     ORDER BY operation.created_at DESC`,
                    [context.state_run_id],
                );
                assertExternalOperationValidationGatesSatisfied(
                    validationGates,
                    toState,
                    operationResult.rows.map((row: any) => ({
                        status: row.status,
                        waitCompleted: row.wait_completed_at !== null,
                        provider: row.provider,
                        kind: row.kind,
                        evidence: row.evidence ?? null,
                    })),
                );
            }

            const jobUpdate = context.terminal
                ? await client.query(
                    `UPDATE "${this.sql.schema}".jobs
                     SET lifecycle_state = 'completed', session_error = NULL, updated_at = now()
                     WHERE job_id = $1 AND current_state = $2 AND state_revision = $3`,
                    [context.job_id, context.state_name, context.state_revision],
                )
                : await client.query(
                    `UPDATE "${this.sql.schema}".jobs
                     SET current_state = $2, state_revision = $3,
                         current_state_entered_at = now(), lifecycle_state = 'pending_session',
                         session_error = NULL, updated_at = now()
                     WHERE job_id = $1 AND current_state = $4 AND state_revision = $5`,
                    [context.job_id, toState, toRevision, context.state_name, context.state_revision],
                );
            if ((jobUpdate.rowCount ?? 0) !== 1) throw new Error("Job state transition is stale");

            const sequenceResult = await client.query(
                `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
                 FROM "${this.sql.schema}".job_journal_entries
                 WHERE job_id = $1`,
                [context.job_id],
            );
            const journalEntryId = randomUUID();
            const journalResult = await client.query(
                `INSERT INTO "${this.sql.schema}".job_journal_entries (
                     journal_entry_id, job_id, sequence, definition_id,
                     from_state, to_state, from_revision, to_revision,
                     state_run_id, session_id, outcome, summary, idempotency_key
                 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                 RETURNING *`,
                [
                    journalEntryId,
                    context.job_id,
                    Number(sequenceResult.rows[0].sequence),
                    context.definition_id,
                    context.state_name,
                    toState,
                    context.state_revision,
                    toRevision,
                    context.state_run_id,
                    input.sessionId,
                    requestedOutcome,
                    summary,
                    idempotencyKey,
                ],
            );
            await client.query(
                `UPDATE "${this.sql.schema}".job_state_runs
                 SET status = 'completed', completed_at = now(), lease_owner = NULL,
                     lease_expires_at = NULL, updated_at = now()
                 WHERE state_run_id = $1`,
                [context.state_run_id],
            );
            await client.query(
                `UPDATE "${this.sql.schema}".job_waits
                 SET status = 'cancelled',
                     next_check_at = NULL,
                     check_lease_owner = NULL,
                     check_lease_expires_at = NULL,
                     updated_at = now()
                 WHERE state_run_id = $1
                   AND status = 'pending'`,
                [context.state_run_id],
            );
            await client.query(
                `UPDATE "${this.sql.schema}".job_sessions
                 SET is_current = FALSE,
                     status = CASE WHEN $2 THEN 'completed' ELSE 'replaced' END,
                     ended_at = now()
                 WHERE association_id = $1`,
                [context.association_id, context.terminal],
            );
            if (!context.terminal) {
                await client.query(
                    `INSERT INTO "${this.sql.schema}".job_state_runs (
                         state_run_id, job_id, definition_id, state_name,
                         state_revision, status, predecessor_journal_entry_id
                     ) VALUES ($1,$2,$3,$4,$5,'reserved',$6)`,
                    [
                        randomUUID(),
                        context.job_id,
                        context.definition_id,
                        toState,
                        toRevision,
                        journalEntryId,
                    ],
                );
            }
            await client.query("COMMIT");
            return rowToJobJournalEntry(journalResult.rows[0]);
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            client.release();
        }
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
        routing?: SessionRoutingContract | null;
    }): Promise<void> {
        const explicitGroupId = typeof opts?.groupId === "string" && opts.groupId.trim()
            ? opts.groupId.trim()
            : null;
        // A 42883 mid-transaction aborts it, so probe the newer overloads'
        // existence up front (once) instead of catch-and-retry inside BEGIN.
        const useVisibilityCreate = await this.supportsVisibilityCreate();
        const useCreationConfig = Boolean(opts?.creationConfig) && await this.supportsCreationConfig();
        const useRoutingConfig = Boolean(opts?.routing) && await this.supportsRoutingConfig();
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

            // Immutable execution-routing contract (owner affinity + repo/gitRef).
            // Write-once via COALESCE so retries and restarts can never re-home a
            // session; a divergent re-write surfaces as SESSION_ROUTING_CONFLICT.
            if (useRoutingConfig) {
                const routing = {
                    ...(opts!.routing!.repo ? { repo: opts!.routing!.repo } : {}),
                    ...(opts!.routing!.gitRef ? { gitRef: opts!.routing!.gitRef } : {}),
                    ...(opts!.routing!.ownerAffinityRequired ? { ownerAffinityRequired: true } : {}),
                };
                const { rows } = await client.query(
                    `WITH persisted AS (
                         UPDATE "${this.sql.schema}".sessions
                            SET routing_config = COALESCE(routing_config, $2::jsonb)
                          WHERE session_id = $1
                      RETURNING routing_config
                     )
                     SELECT routing_config = $2::jsonb AS matches FROM persisted`,
                    [sessionId, JSON.stringify(routing)],
                );
                if (!rows[0]?.matches) {
                    throw new Error(`SESSION_ROUTING_CONFLICT: immutable routing differs for session ${sessionId}`);
                }
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

    private _routingConfigColumnSupported: boolean | null = null;

    /** Whether the DB has the routing_config column. Cached per catalog instance. */
    private async supportsRoutingConfig(): Promise<boolean> {
        if (this._routingConfigColumnSupported !== null) return this._routingConfigColumnSupported;
        const { rows } = await this.pool.query(
            `SELECT EXISTS (
                SELECT 1 FROM information_schema.columns
                 WHERE table_schema = $1 AND table_name = 'sessions' AND column_name = 'routing_config'
             ) AS supported`,
            [this.sql.schema],
        );
        this._routingConfigColumnSupported = Boolean(rows[0]?.supported);
        return this._routingConfigColumnSupported;
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

    async getSessionRouting(sessionId: string): Promise<SessionRoutingContract | null> {
        if (!await this.supportsRoutingConfig()) return null;
        const { rows } = await this.pool.query(
            `SELECT routing_config FROM "${this.sql.schema}".sessions WHERE session_id = $1`,
            [sessionId],
        );
        const routing = rows[0]?.routing_config;
        if (!routing || typeof routing !== "object" || Array.isArray(routing)) return null;
        return {
            ...(typeof routing.repo === "string" && routing.repo ? { repo: routing.repo } : {}),
            ...(typeof routing.gitRef === "string" && routing.gitRef ? { gitRef: routing.gitRef } : {}),
            ...(routing.ownerAffinityRequired === true ? { ownerAffinityRequired: true } : {}),
        };
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

    async getSessionGitState(sessionId: string): Promise<SessionGitState> {
        const id = typeof sessionId === "string" ? sessionId.trim() : "";
        const empty: SessionGitState = { baseSha: null, headSha: null, branch: null, epoch: 0 };
        if (!id) return empty;
        const { rows } = await this.pool.query(
            `SELECT * FROM ${this.sql.fn.getSessionGitState}($1)`,
            [id],
        );
        const row = rows[0];
        if (!row) return empty;
        const norm = (v: unknown): string | null => {
            if (v == null) return null;
            const t = String(v).trim();
            return t.length === 0 ? null : t;
        };
        return {
            baseSha: norm(row.git_base_sha),
            headSha: norm(row.git_head_sha),
            branch: norm(row.git_branch),
            epoch: Number(row.git_state_epoch ?? 0) || 0,
        };
    }

    async setSessionGitState(sessionId: string, state: SessionGitState): Promise<SessionGitState> {
        const id = typeof sessionId === "string" ? sessionId.trim() : "";
        if (!id) {
            throw new Error("setSessionGitState: sessionId is required");
        }
        const norm = (v: string | null | undefined): string | null => {
            if (typeof v !== "string") return null;
            const t = v.trim();
            return t.length === 0 ? null : t;
        };
        const epoch = Number.isFinite(state?.epoch) ? Math.trunc(state.epoch as number) : 0;
        const { rows } = await this.pool.query(
            `SELECT ${this.sql.fn.setSessionGitState}($1, $2, $3, $4, $5) AS ok`,
            [id, norm(state?.baseSha), norm(state?.headSha), norm(state?.branch), epoch],
        );
        if (rows[0]?.ok !== true) {
            throw new Error(`setSessionGitState: session not found: ${id}`);
        }
        return this.getSessionGitState(id);
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

    async getWorkerTimeline(
        workerNodeId: string,
        options: { since?: Date; limit?: number } = {},
    ): Promise<WorkerTimelineEntry[]> {
        const normalizedWorkerNodeId = workerNodeId.trim();
        if (!normalizedWorkerNodeId) throw new Error("workerNodeId is required");
        if (options.since && !Number.isFinite(options.since.getTime())) {
            throw new Error("Worker timeline since must be a valid date");
        }
        const limit = Math.min(1_000, Math.max(1, Math.trunc(options.limit ?? 200)));
        const eventTypes = [
            "session.turn_started",
            "session.turn_execution_completed",
            "session.turn_completed",
            "session.turn_stopped",
            "session.worker_capacity_acquired",
            "session.hydrated",
            "session.dehydrated",
            "session.affinity_released",
            "session.input_required_started",
            "session.wait_started",
            "session.wait_completed",
            "session.system_wait_requested",
            "session.system_wait_started",
            "session.system_wait_completed",
            "session.system_signal_ignored",
            "session.command_received",
            "session.command_completed",
            "session.error",
            "session.lossy_handoff",
            "session.snapshot_regressed",
            "session.snapshot_store_empty",
            "session.snapshot_unpublished",
        ];
        const { rows } = await this.pool.query(
            `WITH timeline AS (
                 SELECT
                     'event:' || event.seq::text AS timeline_id,
                     CASE
                         WHEN event.event_type = 'session.turn_execution_completed'
                              AND NULLIF(event.data->>'executionCompletedAt', '') IS NOT NULL
                             THEN (event.data->>'executionCompletedAt')::timestamptz
                         WHEN event.event_type = 'session.worker_capacity_acquired'
                              AND NULLIF(event.data->>'acquiredAt', '') IS NOT NULL
                             THEN (event.data->>'acquiredAt')::timestamptz
                         ELSE event.created_at
                     END AS at,
                     'session_event'::text AS kind,
                     event.event_type,
                     event.session_id,
                     event.worker_node_id,
                     job.generator_id,
                     generator.name AS generator_name,
                     job.job_id,
                     job.job_key,
                     state_run.state_run_id,
                     state_run.state_name,
                     state_run.state_revision,
                     NULL::text AS summary,
                     COALESCE(event.data, '{}'::jsonb) AS details
                 FROM "${this.sql.schema}".session_events event
                 LEFT JOIN "${this.sql.schema}".job_sessions job_session
                   ON job_session.session_id = event.session_id
                 LEFT JOIN "${this.sql.schema}".job_state_runs state_run
                   ON state_run.state_run_id = job_session.state_run_id
                 LEFT JOIN "${this.sql.schema}".jobs job
                   ON job.job_id = job_session.job_id
                 LEFT JOIN "${this.sql.schema}".job_generators generator
                   ON generator.generator_id = job.generator_id
                 WHERE event.worker_node_id = $1
                   AND ($2::timestamptz IS NULL OR event.created_at >= $2)
                   AND event.event_type = ANY($3::text[])

                 UNION ALL

                 SELECT
                     'transition:' || journal.journal_entry_id,
                     journal.transitioned_at,
                     'state_transition'::text,
                     CASE
                         WHEN state_run.terminal IS TRUE THEN 'job.state_completed'::text
                         ELSE 'job.state_transition'::text
                     END,
                     journal.session_id,
                     attribution.worker_node_id,
                     job.generator_id,
                     generator.name,
                     job.job_id,
                     job.job_key,
                     journal.state_run_id,
                     journal.from_state,
                     journal.from_revision,
                     journal.summary,
                     jsonb_build_object(
                         'fromState', journal.from_state,
                         'toState', journal.to_state,
                         'fromRevision', journal.from_revision,
                         'toRevision', journal.to_revision,
                         'outcome', journal.outcome,
                         'terminal', COALESCE(state_run.terminal, FALSE)
                     )
                 FROM "${this.sql.schema}".job_journal_entries journal
                     JOIN LATERAL (
                         SELECT event.worker_node_id
                         FROM "${this.sql.schema}".session_events event
                         WHERE event.session_id = journal.session_id
                           AND event.worker_node_id IS NOT NULL
                           AND event.created_at <= journal.transitioned_at
                         ORDER BY event.created_at DESC, event.seq DESC
                         LIMIT 1
                     ) attribution ON attribution.worker_node_id = $1
                     JOIN "${this.sql.schema}".jobs job
                   ON job.job_id = journal.job_id
                 JOIN "${this.sql.schema}".job_state_runs state_run
                   ON state_run.state_run_id = journal.state_run_id
                 JOIN "${this.sql.schema}".job_generators generator
                   ON generator.generator_id = job.generator_id
                 WHERE $2::timestamptz IS NULL OR journal.transitioned_at >= $2

                 UNION ALL

                 SELECT
                     'materialized:' || job.job_id,
                     job.created_at,
                     'job_materialization'::text,
                     'job.materialized'::text,
                     attribution.session_id,
                     $1::text,
                     job.generator_id,
                     generator.name,
                     job.job_id,
                     job.job_key,
                     NULL::text,
                     NULL::text,
                     NULL::bigint,
                     NULL::text,
                     jsonb_build_object(
                         'materializedAt', job.created_at,
                         'firstDiscoveredAt', job.first_discovered_at
                     )
                 FROM "${this.sql.schema}".jobs job
                 JOIN "${this.sql.schema}".job_generators generator
                   ON generator.generator_id = job.generator_id
                 JOIN LATERAL (
                     SELECT job_session.session_id
                     FROM "${this.sql.schema}".job_sessions job_session
                     JOIN "${this.sql.schema}".session_events event
                       ON event.session_id = job_session.session_id
                      AND event.worker_node_id = $1
                      AND event.event_type IN (
                          'session.worker_capacity_acquired',
                          'session.turn_started',
                          'session.turn_execution_completed',
                          'session.turn_completed'
                      )
                     WHERE job_session.job_id = job.job_id
                     ORDER BY job_session.ordinal ASC, event.created_at ASC, event.seq ASC
                     LIMIT 1
                 ) attribution ON TRUE
                 WHERE $2::timestamptz IS NULL OR job.created_at >= $2

                 UNION ALL

                 SELECT
                     'capacity-wait:' || job_session.association_id,
                     COALESCE(acquisition.acquired_at, state_run.started_at),
                     'worker_capacity_wait'::text,
                     'job.worker_capacity_wait'::text,
                     job_session.session_id,
                     COALESCE(acquisition.worker_node_id, attribution.worker_node_id),
                     job.generator_id,
                     generator.name,
                     job.job_id,
                     job.job_key,
                     state_run.state_run_id,
                     state_run.state_name,
                     state_run.state_revision,
                     NULL::text,
                     jsonb_build_object(
                         'runnableAt', job_session.attached_at,
                         'workerAcquiredAt', COALESCE(acquisition.acquired_at, state_run.started_at),
                         'waitDurationMs',
                             FLOOR(EXTRACT(EPOCH FROM (
                                 COALESCE(acquisition.acquired_at, state_run.started_at)
                                 - job_session.attached_at
                             )) * 1000),
                         'waitSource', 'initial_dispatch'
                     )
                 FROM "${this.sql.schema}".job_sessions job_session
                 LEFT JOIN LATERAL (
                     SELECT
                         event.worker_node_id,
                         CASE
                             WHEN NULLIF(event.data->>'acquiredAt', '') IS NOT NULL
                                 THEN (event.data->>'acquiredAt')::timestamptz
                             ELSE event.created_at
                         END AS acquired_at
                     FROM "${this.sql.schema}".session_events event
                     WHERE event.session_id = job_session.session_id
                       AND event.worker_node_id IS NOT NULL
                       AND event.event_type = 'session.worker_capacity_acquired'
                     ORDER BY
                         CASE
                             WHEN NULLIF(event.data->>'acquiredAt', '') IS NOT NULL
                                 THEN (event.data->>'acquiredAt')::timestamptz
                             ELSE event.created_at
                         END ASC,
                         event.seq ASC
                     LIMIT 1
                 ) acquisition ON TRUE
                 JOIN LATERAL (
                     SELECT event.worker_node_id
                     FROM "${this.sql.schema}".session_events event
                     WHERE event.session_id = job_session.session_id
                       AND event.worker_node_id IS NOT NULL
                     ORDER BY event.created_at ASC, event.seq ASC
                     LIMIT 1
                 ) attribution ON TRUE
                 JOIN "${this.sql.schema}".job_state_runs state_run
                   ON state_run.state_run_id = job_session.state_run_id
                  AND state_run.session_id = job_session.session_id
                 JOIN "${this.sql.schema}".jobs job
                   ON job.job_id = job_session.job_id
                 JOIN "${this.sql.schema}".job_generators generator
                   ON generator.generator_id = job.generator_id
                 WHERE job_session.attached_at IS NOT NULL
                   AND COALESCE(acquisition.worker_node_id, attribution.worker_node_id) = $1
                   AND COALESCE(acquisition.acquired_at, state_run.started_at) > job_session.attached_at
                   AND (
                       $2::timestamptz IS NULL
                       OR COALESCE(acquisition.acquired_at, state_run.started_at) >= $2
                   )

                 UNION ALL

                 SELECT
                     'capacity-wait:input:' || input_event.seq::text,
                     acquisition.acquired_at,
                     'worker_capacity_wait'::text,
                     'job.worker_capacity_wait'::text,
                     input_event.session_id,
                     acquisition.worker_node_id,
                     job.generator_id,
                     generator.name,
                     job.job_id,
                     job.job_key,
                     state_run.state_run_id,
                     state_run.state_name,
                     state_run.state_revision,
                     NULL::text,
                     jsonb_build_object(
                         'runnableAt', input_event.created_at,
                         'workerAcquiredAt', acquisition.acquired_at,
                         'waitDurationMs',
                             FLOOR(EXTRACT(EPOCH FROM (
                                 acquisition.acquired_at - input_event.created_at
                             )) * 1000),
                         'waitSource', 'human_input'
                     )
                 FROM "${this.sql.schema}".session_events input_event
                 JOIN LATERAL (
                     SELECT
                         event.worker_node_id,
                         CASE
                             WHEN NULLIF(event.data->>'acquiredAt', '') IS NOT NULL
                                 THEN (event.data->>'acquiredAt')::timestamptz
                             ELSE event.created_at
                         END AS acquired_at
                     FROM "${this.sql.schema}".session_events event
                     WHERE event.session_id = input_event.session_id
                       AND event.event_type = 'session.worker_capacity_acquired'
                       AND event.worker_node_id IS NOT NULL
                       AND CASE
                               WHEN NULLIF(event.data->>'acquiredAt', '') IS NOT NULL
                                   THEN (event.data->>'acquiredAt')::timestamptz
                               ELSE event.created_at
                           END > input_event.created_at
                     ORDER BY
                         CASE
                             WHEN NULLIF(event.data->>'acquiredAt', '') IS NOT NULL
                                 THEN (event.data->>'acquiredAt')::timestamptz
                             ELSE event.created_at
                         END ASC,
                         event.seq ASC
                     LIMIT 1
                 ) acquisition ON acquisition.worker_node_id = $1
                 JOIN "${this.sql.schema}".job_sessions job_session
                   ON job_session.session_id = input_event.session_id
                 JOIN "${this.sql.schema}".job_state_runs state_run
                   ON state_run.state_run_id = job_session.state_run_id
                 JOIN "${this.sql.schema}".jobs job
                   ON job.job_id = job_session.job_id
                 JOIN "${this.sql.schema}".job_generators generator
                   ON generator.generator_id = job.generator_id
                 WHERE input_event.event_type = 'session.input_received'
                   AND acquisition.acquired_at > input_event.created_at
                   AND ($2::timestamptz IS NULL OR acquisition.acquired_at >= $2)

                 UNION ALL

                 SELECT
                     'operation:' || operation.operation_id || ':started',
                     operation.created_at,
                     'external_operation'::text,
                     'job.external_operation_started'::text,
                     operation.created_session_id,
                     attribution.worker_node_id,
                     job.generator_id,
                     generator.name,
                     job.job_id,
                     job.job_key,
                     operation.state_run_id,
                     state_run.state_name,
                     state_run.state_revision,
                     NULL::text,
                     jsonb_build_object(
                         'operationId', operation.operation_id,
                         'provider', operation.provider,
                         'operationKind', operation.kind,
                         'correlationId', operation.correlation_id
                     )
                 FROM "${this.sql.schema}".job_external_operations operation
                     JOIN LATERAL (
                         SELECT event.worker_node_id
                         FROM "${this.sql.schema}".session_events event
                         WHERE event.session_id = operation.created_session_id
                           AND event.worker_node_id IS NOT NULL
                           AND event.created_at <= operation.created_at
                         ORDER BY event.created_at DESC, event.seq DESC
                         LIMIT 1
                     ) attribution ON attribution.worker_node_id = $1
                     JOIN "${this.sql.schema}".job_state_runs state_run
                   ON state_run.state_run_id = operation.state_run_id
                 JOIN "${this.sql.schema}".jobs job
                   ON job.job_id = operation.job_id
                 JOIN "${this.sql.schema}".job_generators generator
                   ON generator.generator_id = job.generator_id
                 WHERE $2::timestamptz IS NULL OR operation.created_at >= $2

                 UNION ALL

                 SELECT
                     'operation:' || operation.operation_id || ':completed',
                     operation.completed_at,
                     'external_operation'::text,
                     'job.external_operation_completed'::text,
                     operation.created_session_id,
                     attribution.worker_node_id,
                     job.generator_id,
                     generator.name,
                     job.job_id,
                     job.job_key,
                     operation.state_run_id,
                     state_run.state_name,
                     state_run.state_revision,
                     operation.error,
                     jsonb_build_object(
                         'operationId', operation.operation_id,
                         'provider', operation.provider,
                         'operationKind', operation.kind,
                         'correlationId', operation.correlation_id,
                         'status', operation.status,
                         'result', operation.result,
                         'evidence', operation.evidence
                     )
                 FROM "${this.sql.schema}".job_external_operations operation
                     JOIN LATERAL (
                         SELECT event.worker_node_id
                         FROM "${this.sql.schema}".session_events event
                         WHERE event.session_id = operation.created_session_id
                           AND event.worker_node_id IS NOT NULL
                           AND event.created_at <= operation.created_at
                         ORDER BY event.created_at DESC, event.seq DESC
                         LIMIT 1
                     ) attribution ON attribution.worker_node_id = $1
                     JOIN "${this.sql.schema}".job_state_runs state_run
                   ON state_run.state_run_id = operation.state_run_id
                 JOIN "${this.sql.schema}".jobs job
                   ON job.job_id = operation.job_id
                 JOIN "${this.sql.schema}".job_generators generator
                   ON generator.generator_id = job.generator_id
                 WHERE operation.completed_at IS NOT NULL
                   AND ($2::timestamptz IS NULL OR operation.completed_at >= $2)

                 UNION ALL

                 SELECT
                     'operation:' || operation.operation_id || ':signaled',
                     operation.signal_delivered_at,
                     'external_operation'::text,
                     'job.external_operation_signal_delivered'::text,
                     operation.created_session_id,
                     attribution.worker_node_id,
                     job.generator_id,
                     generator.name,
                     job.job_id,
                     job.job_key,
                     operation.state_run_id,
                     state_run.state_name,
                     state_run.state_revision,
                     NULL::text,
                     jsonb_build_object(
                         'operationId', operation.operation_id,
                         'provider', operation.provider,
                         'operationKind', operation.kind,
                         'correlationId', operation.correlation_id,
                         'signalAttempts', operation.signal_attempts
                     )
                 FROM "${this.sql.schema}".job_external_operations operation
                     JOIN LATERAL (
                         SELECT event.worker_node_id
                         FROM "${this.sql.schema}".session_events event
                         WHERE event.session_id = operation.created_session_id
                           AND event.worker_node_id IS NOT NULL
                           AND event.created_at <= operation.created_at
                         ORDER BY event.created_at DESC, event.seq DESC
                         LIMIT 1
                     ) attribution ON attribution.worker_node_id = $1
                     JOIN "${this.sql.schema}".job_state_runs state_run
                   ON state_run.state_run_id = operation.state_run_id
                 JOIN "${this.sql.schema}".jobs job
                   ON job.job_id = operation.job_id
                 JOIN "${this.sql.schema}".job_generators generator
                   ON generator.generator_id = job.generator_id
                 WHERE operation.signal_delivered_at IS NOT NULL
                   AND ($2::timestamptz IS NULL OR operation.signal_delivered_at >= $2)

                 UNION ALL

                 -- Currently-queued (unacked) runs: runnable but not yet claimed by any
                 -- worker, so they have no session and none of the retrospective
                 -- capacity-wait branches above fire. A runnable+unacked run is queued
                 -- globally regardless of which worker eventually claims it, so surface it
                 -- as an open-ended (ends "now") wait in the lane of the worker that already
                 -- served a prior state of the same job.
                 SELECT
                     'capacity-wait:pending:' || state_run.state_run_id,
                     now(),
                     'worker_capacity_wait'::text,
                     'job.worker_capacity_wait'::text,
                     state_run.session_id,
                     $1::text,
                     job.generator_id,
                     generator.name,
                     job.job_id,
                     job.job_key,
                     state_run.state_run_id,
                     state_run.state_name,
                     state_run.state_revision,
                     NULL::text,
                     jsonb_build_object(
                         'runnableAt', state_run.created_at,
                         'workerAcquiredAt', NULL,
                         'waitDurationMs',
                             FLOOR(EXTRACT(EPOCH FROM (now() - state_run.created_at)) * 1000),
                         'waitSource', 'runnable_pending',
                         'pending', true
                     )
                 FROM "${this.sql.schema}".job_state_runs state_run
                 JOIN "${this.sql.schema}".jobs job
                   ON job.job_id = state_run.job_id
                 JOIN "${this.sql.schema}".job_generators generator
                   ON generator.generator_id = job.generator_id
                 WHERE state_run.status = 'unacked'
                   AND state_run.terminal IS NOT TRUE
                   AND state_run.started_at IS NULL
                   AND EXISTS (
                       SELECT 1
                       FROM "${this.sql.schema}".job_sessions prior_session
                       JOIN "${this.sql.schema}".session_events prior_event
                         ON prior_event.session_id = prior_session.session_id
                        AND prior_event.worker_node_id = $1
                       WHERE prior_session.job_id = state_run.job_id
                   )
                   AND ($2::timestamptz IS NULL OR state_run.created_at >= $2)
             )
             SELECT timeline.*
             FROM timeline
             LEFT JOIN "${this.sql.schema}".jobs filter_job
               ON filter_job.job_id = timeline.job_id
             LEFT JOIN "${this.sql.schema}".job_generators filter_generator
               ON filter_generator.generator_id = timeline.generator_id
             WHERE (timeline.job_id IS NULL OR filter_job.deleted_at IS NULL)
               AND (timeline.generator_id IS NULL OR filter_generator.deleted_at IS NULL)
             ORDER BY at DESC, timeline_id DESC
             LIMIT $4`,
            [normalizedWorkerNodeId, options.since ?? null, eventTypes, limit],
        );
        return rows.reverse().map((row: any) => ({
            timelineId: row.timeline_id,
            at: new Date(row.at),
            kind: row.kind,
            eventType: row.event_type,
            workerNodeId: row.worker_node_id,
            generatorId: row.generator_id ?? null,
            generatorName: row.generator_name ?? null,
            jobId: row.job_id ?? null,
            jobKey: row.job_key ?? null,
            stateRunId: row.state_run_id ?? null,
            stateName: row.state_name ?? null,
            stateRevision: row.state_revision === null || row.state_revision === undefined
                ? null
                : Number(row.state_revision),
            sessionId: row.session_id,
            summary: row.summary ?? null,
            details: row.details ?? {},
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

function rowToJobGenerator(row: any): JobGeneratorRow {
    return {
        generatorId: row.generator_id,
        name: row.name,
        owner: {
            provider: row.owner_provider,
            subject: row.owner_subject,
            email: row.owner_email ?? null,
            displayName: row.owner_display_name ?? null,
        },
        cadenceSeconds: Number(row.cadence_seconds),
        operationalState: row.operational_state,
        activeDefinitionId: row.active_definition_id ?? null,
        nextRunAt: row.next_run_at,
        watermark: row.watermark ?? null,
        totalCycles: Number(row.total_cycles),
        successfulCycles: Number(row.successful_cycles),
        failedCycles: Number(row.failed_cycles),
        materializedJobs: Number(row.materialized_jobs),
        lastCycleAt: row.last_cycle_at ?? null,
        lastError: row.last_error ?? null,
        leaseOwner: row.lease_owner ?? null,
        leaseExpiresAt: row.lease_expires_at ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function rowToJobGeneratorDefinition(row: any): JobGeneratorDefinitionRow {
    return {
        definitionId: row.definition_id,
        generatorId: row.generator_id,
        version: Number(row.version),
        sourceType: row.source_type,
        sourceConfig: row.source_config ?? {},
        lifecycleDefinition: row.lifecycle_definition ?? {},
        affinities: row.affinities ?? {},
        validationGates: Array.isArray(row.validation_gates) ? row.validation_gates : [],
        guardrails: row.guardrails ?? {},
        createdBy: row.created_by ?? null,
        createdAt: row.created_at,
    };
}

function rowToJobGeneratorCycle(row: any): JobGeneratorCycleRow {
    return {
        cycleId: row.cycle_id,
        generatorId: row.generator_id,
        definitionId: row.definition_id,
        status: row.status,
        claimedBy: row.claimed_by,
        watermarkBefore: row.watermark_before ?? null,
        watermarkAfter: row.watermark_after ?? null,
        discoveredCount: Number(row.discovered_count),
        createdCount: Number(row.created_count),
        error: row.error ?? null,
        startedAt: row.started_at,
        completedAt: row.completed_at ?? null,
    };
}

function rowToJob(row: any): JobRow {
    return {
        jobId: row.job_id,
        generatorId: row.generator_id,
        definitionId: row.definition_id,
        jobKey: row.job_key,
        sourcePayload: row.source_payload ?? {},
        lifecycleState: row.lifecycle_state,
        currentState: row.current_state,
        stateRevision: Number(row.state_revision),
        currentStateEnteredAt: row.current_state_entered_at,
        firstSeenCycleId: row.first_seen_cycle_id,
        lastSeenCycleId: row.last_seen_cycle_id,
        firstDiscoveredAt: row.first_discovered_at,
        lastDiscoveredAt: row.last_discovered_at,
        sessionAttempts: Number(row.session_attempts),
        sessionError: row.session_error ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function rowToJobSession(row: any): JobSessionRow {
    return {
        associationId: row.association_id,
        jobId: row.job_id,
        sessionId: row.session_id,
        stateRunId: row.state_run_id ?? null,
        ordinal: Number(row.ordinal),
        isCurrent: Boolean(row.is_current),
        status: row.status,
        error: row.error ?? null,
        reservedAt: row.reserved_at,
        attachedAt: row.attached_at ?? null,
        endedAt: row.ended_at ?? null,
    };
}

function rowToJobStateRun(row: any): JobStateRunRow {
    return {
        stateRunId: row.state_run_id,
        jobId: row.job_id,
        definitionId: row.definition_id,
        stateName: row.state_name,
        stateRevision: Number(row.state_revision),
        status: row.status,
        sessionId: row.session_id ?? null,
        stateOwner: row.state_owner ?? null,
        sourceId: row.source_id ?? null,
        sourcePath: row.source_path ?? null,
        sourceCommit: row.source_commit ?? null,
        markdownSha256: row.markdown_sha256 ?? null,
        allowedOutcomes: Array.isArray(row.allowed_outcomes) ? row.allowed_outcomes : [],
        terminal: typeof row.terminal === "boolean" ? row.terminal : null,
        attempt: Number(row.attempt),
        predecessorJournalEntryId: row.predecessor_journal_entry_id ?? null,
        leaseOwner: row.lease_owner ?? null,
        leaseExpiresAt: row.lease_expires_at ?? null,
        error: row.error ?? null,
        startedAt: row.started_at ?? null,
        completedAt: row.completed_at ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function rowToJobJournalEntry(row: any): JobJournalEntryRow {
    return {
        journalEntryId: row.journal_entry_id,
        jobId: row.job_id,
        sequence: Number(row.sequence),
        entryKind: row.entry_kind,
        definitionId: row.definition_id,
        fromState: row.from_state,
        toState: row.to_state,
        fromRevision: Number(row.from_revision),
        toRevision: Number(row.to_revision),
        stateRunId: row.state_run_id,
        sessionId: row.session_id,
        outcome: row.outcome ?? null,
        summary: row.summary,
        idempotencyKey: row.idempotency_key,
        transitionedAt: row.transitioned_at,
    };
}

function rowToJobWait(row: any): JobWaitRow {
    return {
        waitId: row.wait_id,
        jobId: row.job_id,
        stateRunId: row.state_run_id,
        definitionId: row.definition_id,
        sessionId: row.session_id,
        externalOperationId: row.external_operation_id ?? null,
        signalKey: row.signal_key ?? null,
        waitKey: row.wait_key,
        kind: row.kind,
        status: row.status,
        detectionMode: row.detection_mode,
        expectedStateRevision: Number(row.expected_state_revision),
        prompt: row.prompt ?? {},
        responseSchema: row.response_schema ?? {},
        responderPolicy: row.responder_policy ?? {},
        provider: row.provider ?? null,
        target: row.target ?? null,
        predicate: row.predicate ?? null,
        providerCursor: row.provider_cursor ?? null,
        latestObservation: row.latest_observation ?? null,
        conditionOverrides: Array.isArray(row.condition_overrides)
            ? (row.condition_overrides as string[])
            : [],
        responseId: row.response_id ?? null,
        response: row.response ?? null,
        responseDeliveryStatus: row.response_delivery_status ?? "none",
        responseEnqueuedAt: row.response_enqueued_at ?? null,
        satisfactionEvidence: row.satisfaction_evidence ?? null,
        satisfiedBy: row.satisfied_by ?? null,
        deadlineAt: row.deadline_at ?? null,
        nextCheckAt: row.next_check_at ?? null,
        checkAttempts: Number(row.check_attempts ?? 0),
        consecutiveCheckFailures: Number(row.consecutive_check_failures ?? 0),
        lastCheckedAt: row.last_checked_at ?? null,
        checkLeaseOwner: row.check_lease_owner ?? null,
        checkLeaseExpiresAt: row.check_lease_expires_at ?? null,
        lastCheckError: row.last_check_error ?? null,
        waitStartedAt: row.wait_started_at ?? null,
        waitCompletedAt: row.wait_completed_at ?? null,
        satisfiedAt: row.satisfied_at ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function rowToJobExternalOperation(row: any): JobExternalOperationRow {
    return {
        operationId: row.operation_id,
        jobId: row.job_id,
        stateRunId: row.state_run_id,
        definitionId: row.definition_id,
        createdSessionId: row.created_session_id,
        sessionId: row.session_id,
        provider: row.provider,
        kind: row.kind,
        operationKey: row.operation_key,
        idempotencyKey: row.idempotency_key,
        correlationId: row.correlation_id,
        signalKey: row.signal_key,
        request: row.request ?? {},
        status: row.status,
        result: row.result ?? null,
        evidence: row.evidence ?? null,
        error: row.error ?? null,
        nextPollAt: row.next_poll_at,
        pollLeaseOwner: row.poll_lease_owner ?? null,
        pollLeaseExpiresAt: row.poll_lease_expires_at ?? null,
        completedAt: row.completed_at ?? null,
        waitStartedAt: row.wait_started_at ?? null,
        waitCompletedAt: row.wait_completed_at ?? null,
        signalStatus: row.signal_status,
        signalAttempts: Number(row.signal_attempts),
        nextSignalAt: row.next_signal_at ?? null,
        signalLeaseOwner: row.signal_lease_owner ?? null,
        signalLeaseExpiresAt: row.signal_lease_expires_at ?? null,
        signalDeliveredAt: row.signal_delivered_at ?? null,
        lastSignalError: row.last_signal_error ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
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
