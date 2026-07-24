/**
 * Session footprint — the "how degraded is this session" sensor
 * (docs/proposals/session-regen-and-footprint.md §11).
 *
 * Control-plane only by construction: every axis is answered from CMS
 * aggregates, persisted metric summaries, and orchestration runtime stats —
 * computing a footprint never wakes a dehydrated session.
 *
 * The context/compaction counters are DERIVED from persisted SDK transcript
 * events (`session.usage_info`, `session.compaction_start/_complete` — none
 * of which are in the ephemeral filter), using the type-scoped event index.
 * Definitions (per the proposal):
 *   - compactionCount        completes observed this epoch
 *   - compactionGeneration   summaries-of-summaries depth. Under infinite
 *                            sessions the transcript permanently contains a
 *                            summary after the first compaction, so every
 *                            subsequent compaction's input includes one:
 *                            generation = max(0, completes - 1).
 *   - failedOrStuck          failed completes + starts with no complete
 *   - sustained utilization  the last SUSTAINED_WINDOW usage readings all
 *                            above the threshold — never a single reading.
 */

import type {
    SessionCompactionStats,
    SessionEventStats,
    SessionMetricSummary,
} from "./cms.js";

// ── Assessment thresholds (exported for tests) ──────────────────

export const FOOTPRINT_UTILIZATION_ELEVATED = 0.7;
export const FOOTPRINT_UTILIZATION_DEGRADED = 0.85;
export const FOOTPRINT_SUSTAINED_WINDOW = 3;
export const FOOTPRINT_GENERATION_DEGRADED = 2;
export const FOOTPRINT_EVENTS_PRUNE_BYTES = 64 * 1024 * 1024;
export const FOOTPRINT_CACHE_TTL_MS = 15_000;
/** An unmatched compaction start younger than this is RUNNING, not stuck. */
export const FOOTPRINT_STUCK_COMPACTION_MS = 10 * 60 * 1000;
/** Sweep threshold: entries are pruned on write once the cache exceeds this. */
export const FOOTPRINT_CACHE_SWEEP_SIZE = 512;

/** Sentinel "after everything" seq for reverse event reads. */
const MAX_SEQ = Number.MAX_SAFE_INTEGER;

export type FootprintLevel = "ok" | "elevated" | "degraded" | "rebuilding";
export type FootprintRecommendation = "none" | "regenerate" | "prune-events";

export interface SessionFootprint {
    sessionId: string;
    transcriptEpoch: number;
    regenCount: number;
    epochAgeDays: number | null;
    turnsThisEpoch: number | null;
    context: {
        tokenLimit: number | null;
        currentTokens: number | null;
        utilization: number | null;
        /** True when the last SUSTAINED_WINDOW readings all exceed the degraded threshold. */
        sustainedHighUtilization: boolean;
        compactionCount: number;
        compactionGeneration: number;
        tokensRemovedCumulative: number;
        failedOrStuckCompactions: number;
    };
    transcript: {
        snapshotSizeBytes: number | null;
        rawSizeBytes: number | null;
    };
    events: {
        count: number;
        bytes: number;
        maxSeq: number;
        sinceEpochStart: number;
    };
    facts: { count: number; bytes: number } | null;
    children: { descendantCount: number } | null;
    orchestration: {
        historyEventCount?: number;
        historySizeBytes?: number;
        queuePendingCount?: number;
        orchestrationVersion?: string;
    } | null;
    /** Regen eligibility read model (§10.2). Advisory; the cmd handler is the authority. */
    regenEligibility: { eligible: boolean; reason?: string };
    assessment: {
        level: FootprintLevel;
        reasons: string[];
        recommendation: FootprintRecommendation;
    };
    computedAt: number;
}

/** Structural dependencies — satisfied by ManagementClient's catalog + helpers. */
export interface FootprintSources {
    getSession(sessionId: string): Promise<
        | {
              createdAt?: number | Date | null;
              currentIteration?: number | null;
              transcriptEpoch?: number | null;
              lastRegeneratedAt?: number | Date | null;
          }
        | null
    >;
    getSessionEventStats(sessionId: string, afterSeq?: number): Promise<SessionEventStats>;
    getSessionCompactionStats(sessionId: string, afterSeq?: number): Promise<SessionCompactionStats>;
    /** Reverse-ordered read of typed events (existing getSessionEventsBefore proc). */
    getSessionEventsBefore(
        sessionId: string,
        beforeSeq: number,
        limit?: number,
        eventTypes?: string[],
    ): Promise<Array<{ seq: number; data?: unknown }>>;
    getSessionMetricSummary(sessionId: string): Promise<SessionMetricSummary | null>;
    getDescendantSessionIds?(sessionId: string): Promise<string[]>;
    getSessionFactsStats?(
        sessionId: string,
    ): Promise<{ totalCount: number; totalBytes: number }>;
    getOrchestrationStats?(sessionId: string): Promise<Record<string, unknown> | null>;
    /**
     * Epoch boundary seq (the session.epoch_committed event) when the session
     * has regenerated. Absent/0 → epoch 0, whole-session axes. Wired in M1.
     */
    getEpochBoundarySeq?(sessionId: string): Promise<number | null>;
}

function toEpochMs(value: number | Date | null | undefined): number | null {
    if (value == null) return null;
    if (value instanceof Date) return value.getTime();
    return Number.isFinite(value) ? Number(value) : null;
}

function finite(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Compute a session's footprint. `notFoundOk` is false: callers should have
 * resolved the session first; a missing session throws.
 */
export async function computeSessionFootprint(
    sources: FootprintSources,
    sessionId: string,
): Promise<SessionFootprint> {
    const session = await sources.getSession(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);

    const transcriptEpoch = finite(session.transcriptEpoch as number) ?? 0;
    let boundarySeq = 0;
    if (transcriptEpoch > 0) {
        // A regenerated session assessed from WHOLE-SESSION counters would
        // inherit the dead epoch's degradation — refuse loudly rather than
        // silently lie (the caller wires getEpochBoundarySeq; its absence or
        // failure here is a bug, not a fallback).
        if (!sources.getEpochBoundarySeq) {
            throw new Error(
                `footprint: session ${sessionId} is at epoch ${transcriptEpoch} but no epoch boundary source is wired`,
            );
        }
        const seq = await sources.getEpochBoundarySeq(sessionId);
        if (seq == null || seq <= 0) {
            throw new Error(
                `footprint: session ${sessionId} is at epoch ${transcriptEpoch} but the epoch boundary seq is unavailable`,
            );
        }
        boundarySeq = seq;
    }
    const afterSeq = boundarySeq > 0 ? boundarySeq : undefined;

    const [eventStatsAll, eventStatsEpoch, compaction, usageEvents, summary] = await Promise.all([
        sources.getSessionEventStats(sessionId),
        afterSeq != null
            ? sources.getSessionEventStats(sessionId, afterSeq)
            : Promise.resolve<SessionEventStats | null>(null),
        sources.getSessionCompactionStats(sessionId, afterSeq),
        sources.getSessionEventsBefore(sessionId, MAX_SEQ, FOOTPRINT_SUSTAINED_WINDOW + 3, [
            "session.usage_info",
        ]),
        sources.getSessionMetricSummary(sessionId),
    ]);

    // Optional axes degrade independently — a failure in one never sinks the rest.
    const [factsResult, descendantsResult, orchResult] = await Promise.allSettled([
        sources.getSessionFactsStats?.(sessionId) ?? Promise.resolve(null),
        sources.getDescendantSessionIds?.(sessionId) ?? Promise.resolve(null),
        sources.getOrchestrationStats?.(sessionId) ?? Promise.resolve(null),
    ]);

    // ── context axis from the most recent usage readings ────────
    const readings = usageEvents
        .slice()
        .sort((a, b) => a.seq - b.seq)
        .map((e) => {
            const data = (e.data ?? {}) as Record<string, unknown>;
            const tokenLimit = finite(data.tokenLimit);
            const currentTokens = finite(data.currentTokens);
            return tokenLimit != null && currentTokens != null && tokenLimit > 0
                ? { tokenLimit, currentTokens, utilization: currentTokens / tokenLimit }
                : null;
        })
        .filter((r): r is NonNullable<typeof r> => r != null)
        // Collapse consecutive identical readings: usage_info fires more than
        // once per turn, and the sustained window must span distinct states,
        // not one long turn echoing the same number.
        .filter((r, i, all) => i === 0 || r.currentTokens !== all[i - 1].currentTokens);
    const latest = readings.length > 0 ? readings[readings.length - 1] : null;
    const window = readings.slice(-FOOTPRINT_SUSTAINED_WINDOW);
    const sustainedHighUtilization =
        window.length >= FOOTPRINT_SUSTAINED_WINDOW &&
        window.every((r) => r.utilization > FOOTPRINT_UTILIZATION_DEGRADED);

    // Failed completes inject no summary — they cannot deepen the
    // summaries-of-summaries chain, so depth counts SUCCEEDED compactions only.
    const succeeded = Math.max(0, compaction.completes - compaction.failed);
    const compactionCount = succeeded;
    const compactionGeneration = Math.max(0, succeeded - 1);
    // A single unmatched start is a compaction IN FLIGHT until the stuck
    // timeout passes — without the age gate every live compaction (and,
    // permanently, one crashed worker) would read degraded.
    const unmatchedStarts = Math.max(0, compaction.starts - compaction.completes);
    const newestStartMs = compaction.lastStartAtMs ?? 0;
    const trailingStartIsStuck =
        unmatchedStarts > 0 &&
        (newestStartMs === 0 || Date.now() - newestStartMs > FOOTPRINT_STUCK_COMPACTION_MS);
    const stuck = trailingStartIsStuck ? unmatchedStarts : Math.max(0, unmatchedStarts - 1);
    const failedOrStuck = compaction.failed + stuck;

    // ── assessment ──────────────────────────────────────────────
    const reasons: string[] = [];
    if (compactionGeneration >= FOOTPRINT_GENERATION_DEGRADED) {
        reasons.push(`compactionGeneration >= ${FOOTPRINT_GENERATION_DEGRADED}`);
    }
    if (sustainedHighUtilization) {
        reasons.push(`utilization > ${FOOTPRINT_UTILIZATION_DEGRADED} sustained`);
    }
    if (failedOrStuck >= 1) reasons.push("failed or stuck compaction");

    let level: FootprintLevel;
    if (reasons.length > 0) {
        level = "degraded";
    } else if (
        compactionCount >= 1 ||
        (latest != null && latest.utilization > FOOTPRINT_UTILIZATION_ELEVATED)
    ) {
        level = "elevated";
        if (compactionCount >= 1) reasons.push("compaction has occurred");
        if (latest != null && latest.utilization > FOOTPRINT_UTILIZATION_ELEVATED) {
            reasons.push(`utilization > ${FOOTPRINT_UTILIZATION_ELEVATED}`);
        }
    } else {
        level = "ok";
    }

    let recommendation: FootprintRecommendation = "none";
    if (level === "degraded") recommendation = "regenerate";
    else if (eventStatsAll.dataBytes > FOOTPRINT_EVENTS_PRUNE_BYTES) recommendation = "prune-events";

    const createdAtMs = toEpochMs(session.createdAt);
    const lastRegenMs = toEpochMs(session.lastRegeneratedAt);
    const epochStartMs = transcriptEpoch > 0 ? lastRegenMs : createdAtMs;
    const epochAgeDays =
        epochStartMs != null ? (Date.now() - epochStartMs) / (24 * 60 * 60 * 1000) : null;

    const facts =
        factsResult.status === "fulfilled" && factsResult.value
            ? { count: factsResult.value.totalCount, bytes: factsResult.value.totalBytes }
            : null;
    const descendants =
        descendantsResult.status === "fulfilled" && Array.isArray(descendantsResult.value)
            ? { descendantCount: descendantsResult.value.length }
            : null;
    const orchStatsRaw = orchResult.status === "fulfilled" ? orchResult.value : null;
    const orchestration = orchStatsRaw
        ? {
              ...(finite((orchStatsRaw as any).historyEventCount) != null
                  ? { historyEventCount: Number((orchStatsRaw as any).historyEventCount) }
                  : {}),
              ...(finite((orchStatsRaw as any).historySizeBytes) != null
                  ? { historySizeBytes: Number((orchStatsRaw as any).historySizeBytes) }
                  : {}),
              ...(finite((orchStatsRaw as any).queuePendingCount) != null
                  ? { queuePendingCount: Number((orchStatsRaw as any).queuePendingCount) }
                  : {}),
              ...(typeof (orchStatsRaw as any).orchestrationVersion === "string"
                  ? { orchestrationVersion: (orchStatsRaw as any).orchestrationVersion }
                  : {}),
          }
        : null;

    return {
        sessionId,
        transcriptEpoch,
        regenCount: transcriptEpoch, // M1 refines: rollbacks advance epochs without distillation
        epochAgeDays,
        turnsThisEpoch: finite(session.currentIteration as number),
        context: {
            tokenLimit: latest?.tokenLimit ?? null,
            currentTokens: latest?.currentTokens ?? null,
            utilization: latest != null ? Number(latest.utilization.toFixed(4)) : null,
            sustainedHighUtilization,
            compactionCount,
            compactionGeneration,
            tokensRemovedCumulative: compaction.tokensRemoved,
            failedOrStuckCompactions: failedOrStuck,
        },
        transcript: {
            snapshotSizeBytes: summary?.snapshotSizeBytes ?? null,
            rawSizeBytes: summary?.rawSizeBytes ?? null,
        },
        events: {
            count: eventStatsAll.eventCount,
            bytes: eventStatsAll.dataBytes,
            maxSeq: eventStatsAll.maxSeq,
            sinceEpochStart: (eventStatsEpoch ?? eventStatsAll).eventCount,
        },
        facts,
        children: descendants,
        orchestration,
        // Regeneration ships in M1; until then the read model reports it plainly.
        regenEligibility: { eligible: false, reason: "not_available" },
        assessment: { level, reasons, recommendation },
        computedAt: Date.now(),
    };
}

// ── TTL cache ───────────────────────────────────────────────────
//
// TTL-only by design: no cross-process invalidation is claimed — checking
// max seq is itself a query, and every consumer tolerates seconds of
// staleness. A maintained aggregate row is the upgrade path if this bites.

export class FootprintCache {
    private readonly entries = new Map<string, { at: number; value: SessionFootprint }>();

    constructor(private readonly ttlMs: number = FOOTPRINT_CACHE_TTL_MS) {}

    get(sessionId: string): SessionFootprint | null {
        const entry = this.entries.get(sessionId);
        if (!entry) return null;
        if (Date.now() - entry.at > this.ttlMs) {
            this.entries.delete(sessionId);
            return null;
        }
        return entry.value;
    }

    set(footprint: SessionFootprint): void {
        if (this.entries.size > FOOTPRINT_CACHE_SWEEP_SIZE) {
            const cutoff = Date.now() - this.ttlMs;
            for (const [key, entry] of this.entries) {
                if (entry.at < cutoff) this.entries.delete(key);
            }
            // Pathological churn (fleet-wide pollers): hard reset beats growth.
            if (this.entries.size > FOOTPRINT_CACHE_SWEEP_SIZE * 8) this.entries.clear();
        }
        this.entries.set(footprint.sessionId, { at: Date.now(), value: footprint });
    }

    clear(): void {
        this.entries.clear();
    }
}
