/**
 * Inspect Tools — read-only inspection tools for agents.
 *
 * `read_agent_events` is available to every session. It lets an ancestor
 * read the durable event stream of a descendant in its spawn tree using
 * the existing `session_events.seq` cursor.
 *
 * A small read-only subset is exposed to permanent system agents so they can
 * inspect sessions and owner-scoped usage without mutating state. The deeper
 * diagnostic tools are the diagnostic bundle — historically the `agent-tuner`
 * system agent's alone, and soon an installable package's (see
 * docs/proposals/agent-authoring-capability.md).
 *
 * ── The viewer spine ──────────────────────────────────────────────
 * These tools used to take no principal at all: `agentIdentity` decided
 * everything, and the tuner bypassed the one scoping rule that existed. That
 * was sound only while the sole holder was an ownerless system session. The
 * moment a USER-owned session holds the diagnostic bundle, "no principal"
 * becomes "every principal", so every session-touching tool now resolves a
 * viewer from its session's OWNER and routes through one of three rules:
 *
 *   scopeSessions(rows)          — lists: filter to what the viewer may see
 *   ensureVisible(id)            — direct reads: refuse what they may not
 *   requireAdmin(tool)           — fleet aggregates, which have neither a
 *                                  session id nor a session list to filter
 *
 * A tool that touches sessions and uses none of the three is a bug; the
 * inspect-viewer-spine test greps for exactly that.
 *
 * The decision itself is NOT reimplemented here — `evaluateSessionAccess`
 * comes from pilotswarm-sdk/api, the same function the portal's HTTP routes
 * call, so a rule change lands on both surfaces at once.
 *
 * Inspect tools never mutate state.
 *
 * @module
 * @internal
 */

import { defineTool } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import type { SessionCatalog, SessionEvent } from "./cms.js";
import { computeSessionFootprint, FootprintCache } from "./footprint.js";
import { isEnhancedFactStore } from "./facts-store.js";
import { formatOwnerBucketLabel, formatSessionOwnerLabel, getSessionOwnerKind, matchesOwnerBucketFilters, matchesSessionOwnerFilters } from "./session-owner-utils.js";
// One predicate, two surfaces: this is the same function the portal's HTTP
// layer evaluates for /api/v1 routes.
import { evaluateSessionAccess, systemSessionsReadable } from "../api/src/session-authz.js";
// MANAGER_AGENT_IDS lives there so the declaration and the per-turn handler
// in managed-session gate on the SAME list.
import { createAgentManagerTools, MANAGER_AGENT_IDS } from "./agent-manager-tools.js";

/**
 * Agent ids that hold the manager bundle.
 *
 * `agent-tuner` stays listed until every deployment has migrated off the old
 * built-in system agent; `agent-manager` is the installable package that
 * replaces it. Both are NAMES, and per §15 A10 a name must never GRANT — so
 * be clear about what this actually decides: it selects which agents BEHAVE
 * like managers, not what a manager may do. Authority comes from the viewer
 * spine and the database's creator-or-admin checks, both of which apply
 * identically whoever holds these tools. A hostile package declaring the same
 * id gains nothing its owner did not already have through the portal.
 */

/**
 * System agents, which are immune to package operations by construction.
 *
 * `agent-tuner` is deliberately NOT here any more: it became an installable
 * package (phase E), so it has an owner, a version and a lifecycle like any
 * other package. The remaining four are the agents that hold background jobs.
 */
const SYSTEM_AGENT_IDS = new Set([
    "pilotswarm",
    "facts-manager",
    "sweeper",
    "resourcemgr",
]);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Shared TTL cache for the context_health tool (per worker process). */
const contextHealthCache = new FootprintCache();
const MAX_DATA_BYTES = 4 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

interface SerializedEvent {
    seq: number;
    eventType: string;
    createdAt: string;
    workerNodeId?: string;
    data?: unknown;
    _truncated?: boolean;
}

function normalizeSessionId(raw: string): string {
    return raw?.startsWith("session-") ? raw.slice("session-".length) : raw;
}

function clampLimit(limit: number | undefined): number {
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
    return Math.min(Math.floor(limit), MAX_LIMIT);
}

function truncateData(data: unknown): { data: unknown; truncated: boolean } {
    if (data == null) return { data, truncated: false };
    let serialized: string;
    try {
        serialized = JSON.stringify(data);
    } catch {
        return { data: "[unserializable]", truncated: true };
    }
    if (serialized.length <= MAX_DATA_BYTES) {
        return { data, truncated: false };
    }
    return {
        data: serialized.slice(0, MAX_DATA_BYTES) + "…",
        truncated: true,
    };
}

function eventTimestamp(event: SessionEvent): string {
    const t = event.createdAt as any;
    if (t instanceof Date) return t.toISOString();
    if (typeof t === "string") return t;
    if (typeof t === "number") return new Date(t).toISOString();
    return new Date().toISOString();
}

function serializeEvents(events: SessionEvent[]): { serialized: SerializedEvent[]; hasMore: boolean } {
    const out: SerializedEvent[] = [];
    let total = 0;
    let hasMore = false;
    for (const event of events) {
        const { data, truncated } = truncateData(event.data);
        const item: SerializedEvent = {
            seq: Number((event as any).seq),
            eventType: event.eventType,
            createdAt: eventTimestamp(event),
            ...(event.workerNodeId ? { workerNodeId: event.workerNodeId } : {}),
            ...(data !== undefined ? { data } : {}),
            ...(truncated ? { _truncated: true } : {}),
        };
        const itemSize = JSON.stringify(item).length;
        if (total + itemSize > MAX_RESPONSE_BYTES && out.length > 0) {
            hasMore = true;
            break;
        }
        out.push(item);
        total += itemSize;
    }
    return { serialized: out, hasMore };
}

/**
 * Who these tools act as. Derived from the SESSION OWNER — never from a tool
 * argument, or the model could name its own privileges.
 */
export interface InspectViewer {
    provider: string;
    subject: string;
    /**
     * Resolved fresh, not stamped at session creation: a session can outlive
     * the role that created it, and stamping would let a demoted admin keep
     * fleet-wide reach for as long as their session stayed alive.
     */
    isAdmin: boolean;
    /**
     * The first-class System principal (ownerless platform sessions). Reaches
     * everything, as it does today — the sweeper cannot do its job otherwise.
     */
    isSystemPrincipal: boolean;
}

/**
 * FAIL CLOSED. Every unknown becomes the least privilege, never the most:
 * an unresolvable owner is not an admin and owns nothing, so it can read
 * exactly nothing rather than everything. Returned whenever a resolver is
 * absent, throws, or yields an identity we cannot use.
 */
export const NO_VIEWER: InspectViewer = Object.freeze({
    provider: "",
    subject: "",
    isAdmin: false,
    isSystemPrincipal: false,
});

export interface CreateInspectToolsOptions {
    catalog: SessionCatalog;
    agentIdentity?: string;
    /**
     * Resolve the acting viewer. Called PER TOOL INVOCATION (implementations
     * should cache per turn) so a role change takes effect on the next turn
     * rather than the next session.
     *
     * Omitted → NO_VIEWER → session-touching tools refuse. That default is
     * deliberate: a caller that forgets to pass this gets a useless agent,
     * not a fleet-wide reader.
     */
    resolveViewer?: () => Promise<InspectViewer | null> | InspectViewer | null;
    /**
     * Optional duroxide client used by tuner-only tools that read
     * orchestration stats and execution history. May be omitted for
     * non-tuner sessions; the corresponding tools simply don't get
     * registered.
     */
    duroxideClient?: any;
    /**
     * Optional fact store used by tuner-only facts-stats tools. When
     * omitted, the facts-stats inspect tools are not registered and
     * the tuner falls back to the management API surface.
     */
    factStore?: import("./facts-store.js").FactStore;
    /**
     * Artifact store, for the write bundle's patch artifacts. Omitted →
     * `propose_agent_patch` refuses with a clear message rather than throwing.
     */
    artifactStore?: import("./session-store.js").ArtifactStore | null;
    /** The session these tools act in, used to attach patch artifacts. */
    sessionId?: string;
}

export function createInspectTools(opts: CreateInspectToolsOptions): Tool<any>[] {
    const { catalog, agentIdentity, duroxideClient, factStore, resolveViewer } = opts;
    const isTuner = MANAGER_AGENT_IDS.has(agentIdentity || "");
    const isSystemAgent = SYSTEM_AGENT_IDS.has(agentIdentity || "");
    /**
     * Does this session get the deep diagnostic bundle?
     *
     * Named for the CAPABILITY, not the holder. Today the answer is still "is
     * it the built-in tuner", because that is the only holder that exists —
     * but the question is now asked in terms that survive the tuner becoming
     * an installable package, at which point this becomes a check on what the
     * agent DECLARED rather than on what it is CALLED. That distinction is
     * load-bearing: with per-user namespaces, two different packages can both
     * be named `agent-tuner`, so a name can never again be the thing that
     * grants.
     *
     * Widening the bundle no longer widens ACCESS: everything below is
     * owner-scoped by the viewer spine regardless of who holds it.
     */
    const diagnosticBundle = isTuner;

    // ── The viewer spine ─────────────────────────────────────────────────
    // Resolved per invocation, never captured once: see InspectViewer.
    const viewerFor = async (): Promise<InspectViewer> => {
        if (!resolveViewer) return NO_VIEWER;
        try {
            const viewer = await resolveViewer();
            if (!viewer) return NO_VIEWER;
            // A viewer with no identity that also claims no system standing is
            // indistinguishable from "we could not work out who this is".
            if (!viewer.isSystemPrincipal && !(viewer.provider && viewer.subject)) return NO_VIEWER;
            return viewer;
        } catch {
            // Resolution failed (DB blip, deprovisioned owner, provider
            // outage). Fail closed — the alternative is that an outage grants
            // fleet-wide read.
            return NO_VIEWER;
        }
    };

    /** RULE 1 — lists. Keep only rows the viewer may read. */
    const scopeSessions = async <T extends { sessionId: string }>(rows: T[]): Promise<T[]> => {
        const viewer = await viewerFor();
        if (viewer.isSystemPrincipal || viewer.isAdmin) return rows;
        if (viewer === NO_VIEWER) return [];
        const decisions = await Promise.all(rows.map(async (row) => {
            try {
                const snapshot = await catalog.getSessionAccess(row.sessionId, viewer);
                // A missing snapshot means the row vanished between the list
                // and the check. evaluateSessionAccess treats null as "nothing
                // to protect", which is right for a point lookup and wrong
                // here — omit it rather than leak it.
                if (!snapshot) return false;
                return evaluateSessionAccess("session:read", snapshot, {
                    isAdmin: false,
                    systemReadable: systemSessionsReadable(),
                }).allowed;
            } catch {
                return false;
            }
        }));
        return rows.filter((_, i) => decisions[i]);
    };

    /**
     * RULE 2 — direct reads. `notFound` is preserved deliberately: an
     * admitted caller must not learn which session ids exist from the shape
     * of a refusal.
     */
    const ensureVisible = async (
        toolName: string,
        sessionId: string,
        accessClass: "session:read" | "session:write" = "session:read",
    ): Promise<null | { error: string }> => {
        const viewer = await viewerFor();
        if (viewer.isSystemPrincipal) return null;
        if (viewer === NO_VIEWER) {
            return { error: `${toolName}: no owner identity resolved for this session; inspection is unavailable.` };
        }
        let snapshot;
        try {
            snapshot = await catalog.getSessionAccess(sessionId, viewer);
        } catch (err: any) {
            return { error: `${toolName}: access check failed: ${err?.message || String(err)}` };
        }
        if (!snapshot) return { error: `${toolName}: session ${sessionId.slice(0, 8)} not found.` };
        const decision = evaluateSessionAccess(accessClass, snapshot, {
            isAdmin: viewer.isAdmin,
            // Same policy the portal applies, from the same env var: a user who
            // can see the PilotSwarm root in their session list must not be
            // told by an agent that it does not exist.
            systemReadable: systemSessionsReadable(),
        });
        if (decision.allowed) return null;
        if (decision.notFound) return { error: `${toolName}: session ${sessionId.slice(0, 8)} not found.` };
        return { error: `${toolName}: ${decision.reason || "not permitted."}` };
    };

    /**
     * RULE 3 — fleet aggregates. These take no session id and return no
     * session list, so neither rule above can reach them; without this they
     * would disclose other users' activity to any holder of the bundle.
     */
    const requireAdmin = async (toolName: string): Promise<null | { error: string }> => {
        const viewer = await viewerFor();
        if (viewer.isSystemPrincipal || viewer.isAdmin) return null;
        return {
            error:
                `${toolName}: fleet-wide totals are available to administrators only. `
                + `Use the session- or tree-scoped equivalent for your own sessions.`,
        };
    };

    const parseSince = (toolName: string, sinceIso?: string): Date | { error: string } | undefined => {
        if (!sinceIso) return undefined;
        const d = new Date(sinceIso);
        if (Number.isNaN(d.getTime())) return { error: `${toolName}: invalid since_iso` };
        return d;
    };

    /**
     * The lineage gate every ORDINARY agent obeys: self plus descendants.
     *
     * The `if (isTuner) return null` bypass that used to head this function is
     * gone. It was the identity-keyed carve-out this work exists to delete —
     * and with per-user package namespaces an agent id is not a trustworthy
     * thing to grant on. Holders of the diagnostic bundle now widen through
     * `ensureVisible` (owner-scoped), not by being named.
     */
    const ensureSelfOrDescendant = async (toolName: string, targetSessionId: string, callerSessionId?: string): Promise<null | { error: string }> => {
        if (diagnosticBundle) return ensureVisible(toolName, targetSessionId);
        if (!callerSessionId) return { error: `${toolName}: caller session id is required` };
        if (targetSessionId === callerSessionId) return null;
        try {
            const descendants = await catalog.getDescendantSessionIds(callerSessionId);
            if (descendants.includes(targetSessionId)) return null;
            return {
                error:
                    `${toolName}: session_id ${targetSessionId.slice(0, 8)} is not your session or a descendant. ` +
                    `You may only inspect yourself or sessions in your spawn tree.`,
            };
        } catch (err: any) {
            return { error: `${toolName}: descendant lookup failed: ${err?.message || String(err)}` };
        }
    };

    const readAgentEventsTool = defineTool("read_agent_events", {
        description:
            "Read durable events from a descendant agent in your spawn tree, paginated by seq cursor. " +
            "Use cursor=null (or omit) for the most recent page; pass the returned prevCursor to walk backwards in time. " +
            "Use this when check_agents / wait_for_agents / store_fact / read_facts are not enough to understand what the descendant did " +
            "(e.g. you need to see the child's reasoning, tool calls, or intermediate outputs). " +
            "Default page is newest-first, returned in chronological order inside the page. " +
            "Use the event_types filter to keep token cost low.",
        parameters: {
            type: "object" as const,
            properties: {
                agent_id: {
                    type: "string",
                    description:
                        "Descendant session id (must be a direct or transitive child you spawned). " +
                        "Either the raw UUID or the 'session-<uuid>' form is accepted.",
                },
                cursor: {
                    type: "number",
                    description:
                        "Optional seq cursor. Omit (or pass 0) for the most recent page; " +
                        "pass a positive integer to return events strictly older than that seq.",
                },
                limit: {
                    type: "number",
                    description: `Max events per page. Default ${DEFAULT_LIMIT}, hard cap ${MAX_LIMIT}.`,
                },
                event_types: {
                    type: "array",
                    items: { type: "string" },
                    description:
                        "Optional event-type filter, e.g. ['assistant.message','tool.invoked','turn completed']. " +
                        "Filtering happens after the page is fetched, so very narrow filters may return fewer rows than `limit`.",
                },
            },
            required: ["agent_id"],
        },
        handler: async (
            args: {
                agent_id: string;
                cursor?: number | null;
                limit?: number;
                event_types?: string[];
            },
            ctx?: { sessionId?: string },
        ) => {
            const callerSessionId = ctx?.sessionId;
            if (!callerSessionId) {
                return { error: "read_agent_events: caller session id is required" };
            }

            const targetSessionId = normalizeSessionId(args.agent_id || "");
            if (!targetSessionId) {
                return { error: "read_agent_events: agent_id is required" };
            }

            // Lineage / target gate. The diagnostic bundle widens this to the
            // owner's whole visible set — but widens it through the viewer
            // spine, so "wider" still stops at what the owner may read.
            if (diagnosticBundle) {
                const denied = await ensureVisible("read_agent_events", targetSessionId);
                if (denied) return denied;
            }
            if (!diagnosticBundle) {
                if (targetSessionId === callerSessionId) {
                    return { error: "read_agent_events: cannot read your own session events" };
                }
                let descendants: string[] = [];
                try {
                    descendants = await catalog.getDescendantSessionIds(callerSessionId);
                } catch (err: any) {
                    return { error: `read_agent_events: descendant lookup failed: ${err?.message || String(err)}` };
                }
                if (!descendants.includes(targetSessionId)) {
                    return {
                        error:
                            `read_agent_events: agent_id ${targetSessionId.slice(0, 8)} is not a descendant of your session. ` +
                            `You may only read events for sessions you (or your descendants) spawned.`,
                    };
                }
            }

            // Target row check (existence + system-agent guard).
            // `getSession` filters out soft-deleted rows. For non-tuner callers
            // the lineage gate above already filters those out; for the tuner we
            // still attempt to read events (events are not deleted with the row).
            let targetRow;
            try {
                targetRow = await catalog.getSession(targetSessionId);
            } catch (err: any) {
                return { error: `read_agent_events: session lookup failed: ${err?.message || String(err)}` };
            }
            if (targetRow?.isSystem && SYSTEM_AGENT_IDS.has(targetRow.agentId ?? "")) {
                // System-agent internals are admin territory. The bundle alone
                // is not enough — a user-owned holder must not read the
                // sweeper's reasoning just because it holds the tools.
                const viewer = await viewerFor();
                if (!viewer.isSystemPrincipal && !viewer.isAdmin) {
                    return { error: "read_agent_events: cannot read events for a system agent session" };
                }
            }

            const limit = clampLimit(args.limit);
            const cursor = typeof args.cursor === "number" && args.cursor > 0 ? args.cursor : null;

            // Fetch a page.
            // - cursor == null: return newest `limit` events. We use getSessionEvents with
            //   a large after_seq=0 then take the tail. To avoid pulling massive history,
            //   call getSessionEventsBefore with before_seq = MAX_SAFE_INTEGER which the
            //   stored proc treats as "give me the newest <limit>" via its DESC + LIMIT
            //   internal path.
            // - cursor > 0: events strictly older than cursor.
            let pageEvents: SessionEvent[];
            try {
                if (cursor != null) {
                    pageEvents = await catalog.getSessionEventsBefore(targetSessionId, cursor, limit);
                } else {
                    // The "before" proc with a huge sentinel returns the newest <limit>
                    // ascending — exactly what we want for the tail.
                    pageEvents = await catalog.getSessionEventsBefore(
                        targetSessionId,
                        Number.MAX_SAFE_INTEGER,
                        limit,
                    );
                }
            } catch (err: any) {
                return { error: `read_agent_events: event fetch failed: ${err?.message || String(err)}` };
            }

            // Apply event_types filter (post-fetch — pagination cursors are still
            // anchored to the underlying page boundaries).
            const filterTypes = Array.isArray(args.event_types) && args.event_types.length > 0
                ? new Set(args.event_types)
                : null;
            const filteredEvents = filterTypes
                ? pageEvents.filter((event) => filterTypes.has(event.eventType))
                : pageEvents;

            const { serialized, hasMore: tokenTruncated } = serializeEvents(filteredEvents);

            const firstSeq = pageEvents.length > 0 ? Number((pageEvents[0] as any).seq) : null;
            const lastSeq = pageEvents.length > 0 ? Number((pageEvents[pageEvents.length - 1] as any).seq) : null;

            // hasMore is anchored on the underlying (unfiltered) page so the LLM
            // can keep walking even if its filter dropped everything in this page.
            const hasMoreOlder = pageEvents.length === limit || tokenTruncated;
            const prevCursor = hasMoreOlder && firstSeq != null ? firstSeq : null;
            const nextCursor = cursor != null && lastSeq != null ? lastSeq : null;

            const deletedAt = targetRow && (targetRow as any).deletedAt
                ? ((targetRow as any).deletedAt instanceof Date
                    ? (targetRow as any).deletedAt.toISOString()
                    : String((targetRow as any).deletedAt))
                : null;
            const targetMissing = !targetRow;
            const noEvents = pageEvents.length === 0;

            return {
                agentId: targetSessionId,
                events: serialized,
                prevCursor,
                nextCursor,
                hasMore: hasMoreOlder,
                ...(deletedAt ? { deletedAt } : {}),
                ...(targetMissing && noEvents ? { deleted: true } : {}),
                ...(targetMissing && !noEvents ? { deletedAt: "unknown" } : {}),
            };
        },
    });

    const listAllSessionsTool = defineTool("list_all_sessions", {
        description:
            "List every session in the system (CMS only, no orchestration fan-out). " +
            "Use to locate a target by description, owner, or agent. Leave owner filters unset for normal system-session discovery; only set them when the user explicitly asks to scope by owner, user, system, or unowned sessions. " +
            "Returns a compact view: id, title, owner, agentId, parentSessionId, model, state, isSystem, deletedAt.",
        parameters: {
            type: "object" as const,
            properties: {
                limit: { type: "number", description: "Cap returned rows (default 100, max 500)." },
                include_system: { type: "boolean", description: "Include system-agent sessions. Default true for system agents." },
                agent_id_filter: { type: "string", description: "Optional substring match on agentId." },
                owner_query: { type: "string", description: "Optional substring match across owner display name, email, subject, or provider. Not for session titles or agent names." },
                owner_kind: { type: "string", enum: ["user", "system", "unowned"], description: "Optional owner bucket filter. Use only when explicitly requested." },
            },
        },
        handler: async (args: { limit?: number; include_system?: boolean; agent_id_filter?: string; owner_query?: string; owner_kind?: string }) => {
            const includeSystem = args.include_system !== false;
            const cap = Math.min(Math.max(1, Number(args.limit) || 100), 500);
            try {
                // RULE 1. The owner_query / owner_kind parameters below are
                // the MODEL's choice and were never enforcement; this is.
                // Scope first, then apply the model's filters to what is left,
                // so a filter can only ever narrow an already-legal set.
                const rows = await scopeSessions(await catalog.listSessions());
                const filterAgent = (args.agent_id_filter || "").toLowerCase();
                const filtered = rows.filter((r) => {
                    if (!matchesSessionOwnerFilters(r, {
                        includeSystem,
                        ownerQuery: args.owner_query,
                        ownerKind: args.owner_kind,
                    })) return false;
                    if (filterAgent && !(r.agentId ?? "").toLowerCase().includes(filterAgent)) return false;
                    return true;
                }).slice(0, cap);
                return {
                    count: filtered.length,
                    truncated: rows.length > cap,
                    sessions: filtered.map((r) => ({
                        sessionId: r.sessionId,
                        title: r.title ?? null,
                        ownerKind: getSessionOwnerKind(r),
                        ownerLabel: formatSessionOwnerLabel(r),
                        owner: r.owner ?? null,
                        agentId: r.agentId ?? null,
                        parentSessionId: r.parentSessionId ?? null,
                        model: r.model ?? null,
                        state: r.state,
                        iterations: r.currentIteration ?? 0,
                        isSystem: !!r.isSystem,
                        createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
                        deletedAt: (r as any).deletedAt
                            ? ((r as any).deletedAt instanceof Date ? (r as any).deletedAt.toISOString() : String((r as any).deletedAt))
                            : null,
                    })),
                };
            } catch (err: any) {
                return { error: `list_all_sessions: ${err?.message || String(err)}` };
            }
        },
    });

    const readSessionInfoTool = defineTool("read_session_info", {
        description:
            "Read the full CMS row for a session (any session — not just descendants). " +
            "Title, owner, agent, model, parent, status, iterations, last error, wait reason, timestamps.",
        parameters: {
            type: "object" as const,
            properties: { session_id: { type: "string" } },
            required: ["session_id"],
        },
        handler: async (args: { session_id: string }) => {
            const id = normalizeSessionId(args.session_id);
            const denied = await ensureVisible("read_session_info", id);   // RULE 2
            if (denied) return denied;
            try {
                const row = await catalog.getSession(id);
                if (!row) return { sessionId: id, exists: false };
                return {
                    sessionId: row.sessionId,
                    exists: true,
                    title: row.title ?? null,
                    ownerKind: getSessionOwnerKind(row),
                    ownerLabel: formatSessionOwnerLabel(row),
                    owner: row.owner ?? null,
                    agentId: row.agentId ?? null,
                    parentSessionId: row.parentSessionId ?? null,
                    model: row.model ?? null,
                    state: row.state,
                    iterations: row.currentIteration ?? 0,
                    isSystem: !!row.isSystem,
                    lastError: row.lastError ?? null,
                    waitReason: row.waitReason ?? null,
                    splash: row.splash ?? null,
                    splashMobile: row.splashMobile ?? null,
                    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
                    updatedAt: row.updatedAt
                        ? (row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt))
                        : null,
                    deletedAt: (row as any).deletedAt
                        ? ((row as any).deletedAt instanceof Date ? (row as any).deletedAt.toISOString() : String((row as any).deletedAt))
                        : null,
                };
            } catch (err: any) {
                return { error: `read_session_info: ${err?.message || String(err)}` };
            }
        },
    });

    const readUserStatsTool = defineTool("read_user_stats", {
        description:
            "Read owner-bucketed session, token, snapshot, and orchestration-history totals. " +
            "Use this for ownership-aware usage questions and to compare specific users or cohorts.",
        parameters: {
            type: "object" as const,
            properties: {
                include_deleted: { type: "boolean", description: "Default false." },
                since_iso: { type: "string", description: "Optional ISO timestamp lower bound on session_created_at." },
                owner_query: { type: "string", description: "Optional substring match across owner display name, email, subject, or provider." },
                owner_kind: { type: "string", enum: ["user", "system", "unowned"], description: "Optional owner bucket filter." },
            },
        },
        handler: async (args: { include_deleted?: boolean; since_iso?: string; owner_query?: string; owner_kind?: string }) => {
            const denied = await requireAdmin("read_user_stats");   // RULE 3
            if (denied) return denied;
            try {
                const opts: { includeDeleted?: boolean; since?: Date } = {};
                if (args.include_deleted) opts.includeDeleted = true;
                if (args.since_iso) {
                    const d = new Date(args.since_iso);
                    if (Number.isNaN(d.getTime())) return { error: "read_user_stats: invalid since_iso" };
                    opts.since = d;
                }
                const stats = await catalog.getUserStats(opts);
                const users = stats.users
                    .filter((bucket) => matchesOwnerBucketFilters(bucket, {
                        ownerQuery: args.owner_query,
                        ownerKind: args.owner_kind,
                    }))
                    .map((bucket) => ({
                        ...bucket,
                        ownerLabel: formatOwnerBucketLabel(bucket),
                    }));
                const totals = users.reduce((acc, bucket) => {
                    acc.sessionCount += bucket.sessionCount || 0;
                    acc.totalSnapshotSizeBytes += bucket.totalSnapshotSizeBytes || 0;
                    acc.totalOrchestrationHistorySizeBytes += bucket.totalOrchestrationHistorySizeBytes || 0;
                    acc.totalTokensInput += bucket.totalTokensInput || 0;
                    acc.totalTokensOutput += bucket.totalTokensOutput || 0;
                    acc.totalTokensCacheRead += bucket.totalTokensCacheRead || 0;
                    acc.totalTokensCacheWrite += bucket.totalTokensCacheWrite || 0;
                    return acc;
                }, {
                    sessionCount: 0,
                    totalSnapshotSizeBytes: 0,
                    totalOrchestrationHistorySizeBytes: 0,
                    totalTokensInput: 0,
                    totalTokensOutput: 0,
                    totalTokensCacheRead: 0,
                    totalTokensCacheWrite: 0,
                });
                return {
                    windowStart: stats.windowStart,
                    earliestSessionCreatedAt: stats.earliestSessionCreatedAt,
                    users,
                    totals: {
                        ...totals,
                        cacheHitRatio: totals.totalTokensInput > 0
                            ? totals.totalTokensCacheRead / totals.totalTokensInput
                            : null,
                    },
                };
            } catch (err: any) {
                return { error: `read_user_stats: ${err?.message || String(err)}` };
            }
        },
    });

    const systemReadTools = [listAllSessionsTool, readSessionInfoTool, readUserStatsTool];

    // ─── Tuner-only read tools ─────────────────────────────────────────────
    // Bypass the lineage gate; expose CMS state, metric summaries, and
    // (when a duroxide client is provided) orchestration stats and history.

    const readSessionMetricSummaryTool = defineTool("read_session_metric_summary", {
        description:
            "Read durable metric summary for a session: tokens (input/output/cache_read/cache_write), " +
            "snapshot bytes, dehydration / hydration / lossy-handoff counts, last hydrated/dehydrated/checkpoint timestamps.",
        parameters: {
            type: "object" as const,
            properties: { session_id: { type: "string" } },
            required: ["session_id"],
        },
        handler: async (args: { session_id: string }) => {
            const id = normalizeSessionId(args.session_id);
            const denied = await ensureVisible("read_session_metric_summary", id);   // RULE 2
            if (denied) return denied;
            try {
                const summary = await catalog.getSessionMetricSummary(id);
                if (!summary) return { sessionId: id, exists: false };
                return { sessionId: id, exists: true, summary };
            } catch (err: any) {
                return { error: `read_session_metric_summary: ${err?.message || String(err)}` };
            }
        },
    });

    const readSessionTokensByModelTool = defineTool("read_session_tokens_by_model", {
        description:
            "Read per-session token totals grouped by provider:model:reasoning effort, with turn counts. " +
            "Use this when diagnosing model switches, model self-identification, or cost/latency attribution within one session.",
        parameters: {
            type: "object" as const,
            properties: { session_id: { type: "string" } },
            required: ["session_id"],
        },
        handler: async (args: { session_id: string }) => {
            const id = normalizeSessionId(args.session_id);
            const denied = await ensureVisible("read_session_tokens_by_model", id);   // RULE 2
            if (denied) return denied;
            try {
                const rows = await catalog.getSessionTokensByModel(id);
                return {
                    sessionId: id,
                    rows,
                    modelBucketCount: rows.length,
                    totalTurnCount: rows.reduce((sum, row) => sum + (Number((row as any).turnCount) || 0), 0),
                    totalTokensInput: rows.reduce((sum, row) => sum + (Number((row as any).totalTokensInput) || 0), 0),
                    totalTokensOutput: rows.reduce((sum, row) => sum + (Number((row as any).totalTokensOutput) || 0), 0),
                };
            } catch (err: any) {
                return { error: `read_session_tokens_by_model: ${err?.message || String(err)}` };
            }
        },
    });

    const readSessionGraphSearchesTool = defineTool("read_session_graph_searches", {
        description:
            "Graph-search forensics: the `graph.searched` events a session emitted — what graph queries it ran " +
            "(search_nodes / search_edges / neighbourhood, with the query args) and how many results each returned. " +
            "Use to answer 'what did session X search the graph for, and what did it get back?'",
        parameters: {
            type: "object" as const,
            properties: {
                session_id: { type: "string" },
                limit: { type: "number", description: "Max session events to scan (default 500)." },
            },
            required: ["session_id"],
        },
        handler: async (args: { session_id: string; limit?: number }) => {
            const id = normalizeSessionId(args.session_id);
            const denied = await ensureVisible("read_session_graph_searches", id);   // RULE 2
            if (denied) return denied;
            try {
                const events = await catalog.getSessionEvents(id, undefined, args.limit ?? 500);
                const searches = events
                    .filter((e: any) => e.eventType === "graph.searched")
                    .map((e: any) => {
                        const d = e.data ?? {};
                        return {
                            seq: e.seq,
                            at: eventTimestamp(e),
                            operation: d.operation ?? d.kind ?? "",
                            namespace: d.namespace ?? null,
                            nodeKind: d.operation === "graph_search_nodes" ? d.kind ?? null : null,
                            queryPreview: d.queryPreview ?? d.nameLikePreview ?? null,
                            resultCount: d.resultCount ?? 0,
                            nodeCount: d.nodeCount ?? null,
                            edgeCount: d.edgeCount ?? null,
                        };
                    });
                return { sessionId: id, count: searches.length, searches };
            } catch (err: any) {
                return { error: `read_session_graph_searches: ${err?.message || String(err)}` };
            }
        },
    });

    const readSessionTreeStatsTool = defineTool("read_session_tree_stats", {
        description:
            "Read rolled-up stats across the spawn tree rooted at the given session: " +
            "tokens, snapshot bytes, dehydrations, hydrations, per-descendant breakdown.",
        parameters: {
            type: "object" as const,
            properties: { session_id: { type: "string" } },
            required: ["session_id"],
        },
        handler: async (args: { session_id: string }) => {
            const id = normalizeSessionId(args.session_id);
            const denied = await ensureVisible("read_session_tree_stats", id);   // RULE 2
            if (denied) return denied;
            try {
                const tree = await catalog.getSessionTreeStats(id);
                if (!tree) return { sessionId: id, exists: false };
                return { sessionId: id, exists: true, tree };
            } catch (err: any) {
                return { error: `read_session_tree_stats: ${err?.message || String(err)}` };
            }
        },
    });

    const readFleetStatsTool = defineTool("read_fleet_stats", {
        description:
            "Read fleet-wide stats aggregates broken down by agent and model. " +
            "Use for cross-session baselines and to spot outliers.",
        parameters: {
            type: "object" as const,
            properties: {
                include_deleted: { type: "boolean", description: "Default false." },
                since_iso: { type: "string", description: "Optional ISO timestamp lower bound on session_created_at." },
            },
        },
        handler: async (args: { include_deleted?: boolean; since_iso?: string }) => {
            const denied = await requireAdmin("read_fleet_stats");   // RULE 3
            if (denied) return denied;
            try {
                const opts: { includeDeleted?: boolean; since?: Date } = {};
                if (args.include_deleted) opts.includeDeleted = true;
                if (args.since_iso) {
                    const d = new Date(args.since_iso);
                    if (Number.isNaN(d.getTime())) return { error: "read_fleet_stats: invalid since_iso" };
                    opts.since = d;
                }
                const stats = await catalog.getFleetStats(opts);
                return stats;
            } catch (err: any) {
                return { error: `read_fleet_stats: ${err?.message || String(err)}` };
            }
        },
    });

    const readSessionSkillUsageTool = defineTool("read_session_skill_usage", {
        description:
            "Read per-session skill usage. Returns one row per (kind, name, plugin) " +
            "where kind is 'static' (Copilot SDK skill.invoked) or 'learned' (read_facts " +
            "against the skills/ knowledge namespace). Useful for verifying which skills " +
            "an agent actually consumed during a session.",
        parameters: {
            type: "object" as const,
            properties: {
                session_id: { type: "string" },
                since_iso: { type: "string", description: "Optional ISO timestamp lower bound." },
            },
            required: ["session_id"],
        },
        handler: async (args: { session_id: string; since_iso?: string }) => {
            const id = normalizeSessionId(args.session_id);
            const denied = await ensureVisible("read_session_skill_usage", id);   // RULE 2
            if (denied) return denied;
            try {
                const opts: { since?: Date } = {};
                if (args.since_iso) {
                    const d = new Date(args.since_iso);
                    if (Number.isNaN(d.getTime())) return { error: "read_session_skill_usage: invalid since_iso" };
                    opts.since = d;
                }
                const skills = await catalog.getSessionSkillUsage(id, opts);
                return { sessionId: id, skills, totalInvocations: skills.reduce((a, s) => a + s.invocations, 0) };
            } catch (err: any) {
                return { error: `read_session_skill_usage: ${err?.message || String(err)}` };
            }
        },
    });

    const readSessionTreeSkillUsageTool = defineTool("read_session_tree_skill_usage", {
        description:
            "Read skill usage rolled up across the spawn tree rooted at the given session. " +
            "Returns per-session breakdown plus a flat rolled-up summary across the whole tree. " +
            "Each row carries kind ('static' | 'learned'), name, plugin metadata, and counts.",
        parameters: {
            type: "object" as const,
            properties: {
                session_id: { type: "string" },
                since_iso: { type: "string", description: "Optional ISO timestamp lower bound." },
            },
            required: ["session_id"],
        },
        handler: async (args: { session_id: string; since_iso?: string }) => {
            const id = normalizeSessionId(args.session_id);
            const denied = await ensureVisible("read_session_tree_skill_usage", id);   // RULE 2
            if (denied) return denied;
            try {
                const opts: { since?: Date } = {};
                if (args.since_iso) {
                    const d = new Date(args.since_iso);
                    if (Number.isNaN(d.getTime())) return { error: "read_session_tree_skill_usage: invalid since_iso" };
                    opts.since = d;
                }
                const tree = await catalog.getSessionTreeSkillUsage(id, opts);
                return tree;
            } catch (err: any) {
                return { error: `read_session_tree_skill_usage: ${err?.message || String(err)}` };
            }
        },
    });

    const readFleetSkillUsageTool = defineTool("read_fleet_skill_usage", {
        description:
            "Read fleet-wide skill usage broken down by agent and skill kind (static | learned). " +
            "Use for spotting unused or hot skills across all agents. Always pass since_iso for " +
            "the default UI window (e.g. last 7 days) to keep the scan bounded.",
        parameters: {
            type: "object" as const,
            properties: {
                include_deleted: { type: "boolean", description: "Default false." },
                since_iso: { type: "string", description: "Optional ISO timestamp lower bound on event time." },
            },
        },
        handler: async (args: { include_deleted?: boolean; since_iso?: string }) => {
            const denied = await requireAdmin("read_fleet_skill_usage");   // RULE 3
            if (denied) return denied;
            try {
                const opts: { includeDeleted?: boolean; since?: Date } = {};
                if (args.include_deleted) opts.includeDeleted = true;
                if (args.since_iso) {
                    const d = new Date(args.since_iso);
                    if (Number.isNaN(d.getTime())) return { error: "read_fleet_skill_usage: invalid since_iso" };
                    opts.since = d;
                }
                return await catalog.getFleetSkillUsage(opts);
            } catch (err: any) {
                return { error: `read_fleet_skill_usage: ${err?.message || String(err)}` };
            }
        },
    });

    const readSessionRetrievalUsageTool = defineTool("read_session_retrieval_usage", {
        description:
            "Read per-session retrieval usage for facts_search, facts_similar, search_skills, and graph reads. " +
            "Returns count-only aggregates from session_events; no returned facts/nodes/edges are stored.",
        parameters: {
            type: "object" as const,
            properties: {
                session_id: { type: "string" },
                since_iso: { type: "string", description: "Optional ISO timestamp lower bound." },
            },
            required: ["session_id"],
        },
        handler: async (args: { session_id: string; since_iso?: string }, ctx?: { sessionId?: string }) => {
            const id = normalizeSessionId(args.session_id);
            try {
                const denied = await ensureSelfOrDescendant("read_session_retrieval_usage", id, ctx?.sessionId);
                if (denied) return denied;
                const since = parseSince("read_session_retrieval_usage", args.since_iso);
                if (since && "error" in since) return since;
                const rows = await catalog.getSessionRetrievalUsage(id, since ? { since } : undefined);
                return { enabled: true, sessionId: id, rows, totalCalls: rows.reduce((a, r) => a + r.calls, 0) };
            } catch (err: any) {
                return { error: `read_session_retrieval_usage: ${err?.message || String(err)}` };
            }
        },
    });

    const readSessionTreeRetrievalUsageTool = defineTool("read_session_tree_retrieval_usage", {
        description:
            "Read retrieval usage rolled up across a session spawn tree. Parents can use this to understand " +
            "their children facts/graph consumption; tuner can read any tree.",
        parameters: {
            type: "object" as const,
            properties: {
                session_id: { type: "string" },
                since_iso: { type: "string", description: "Optional ISO timestamp lower bound." },
            },
            required: ["session_id"],
        },
        handler: async (args: { session_id: string; since_iso?: string }, ctx?: { sessionId?: string }) => {
            const id = normalizeSessionId(args.session_id);
            try {
                const denied = await ensureSelfOrDescendant("read_session_tree_retrieval_usage", id, ctx?.sessionId);
                if (denied) return denied;
                const since = parseSince("read_session_tree_retrieval_usage", args.since_iso);
                if (since && "error" in since) return since;
                return await catalog.getSessionTreeRetrievalUsage(id, since ? { since } : undefined);
            } catch (err: any) {
                return { error: `read_session_tree_retrieval_usage: ${err?.message || String(err)}` };
            }
        },
    });

    const readFleetRetrievalUsageTool = defineTool("read_fleet_retrieval_usage", {
        description:
            "Read fleet-wide count-only retrieval usage broken down by agent, surface, operation, and namespace. " +
            "Always pass since_iso for the default UI/tuner window to keep the scan bounded.",
        parameters: {
            type: "object" as const,
            properties: {
                include_deleted: { type: "boolean", description: "Default false." },
                since_iso: { type: "string", description: "Optional ISO timestamp lower bound on event time." },
            },
        },
        handler: async (args: { include_deleted?: boolean; since_iso?: string }) => {
            const denied = await requireAdmin("read_fleet_retrieval_usage");   // RULE 3
            if (denied) return denied;
            try {
                const since = parseSince("read_fleet_retrieval_usage", args.since_iso);
                if (since && "error" in since) return since;
                return await catalog.getFleetRetrievalUsage({ since: since as Date | undefined, includeDeleted: args.include_deleted === true });
            } catch (err: any) {
                return { error: `read_fleet_retrieval_usage: ${err?.message || String(err)}` };
            }
        },
    });

    const readSessionGraphNodeUsageTool = defineTool("read_session_graph_node_usage", {
        description:
            "Read exact graph node-key usage for a session: node keys searched as exact seeds and node keys loaded " +
            "as neighbourhood anchors. Supports node_key_like and kind searched|loaded.",
        parameters: {
            type: "object" as const,
            properties: {
                session_id: { type: "string" },
                since_iso: { type: "string", description: "Optional ISO timestamp lower bound." },
                limit: { type: "number", description: "Max rows (default 100, max 500)." },
                node_key_like: { type: "string", description: "Optional substring match over nodeKey." },
                kind: { type: "string", enum: ["searched", "loaded"], description: "Optional row kind filter." },
            },
            required: ["session_id"],
        },
        handler: async (args: { session_id: string; since_iso?: string; limit?: number; node_key_like?: string; kind?: "searched" | "loaded" }, ctx?: { sessionId?: string }) => {
            const id = normalizeSessionId(args.session_id);
            try {
                const denied = await ensureSelfOrDescendant("read_session_graph_node_usage", id, ctx?.sessionId);
                if (denied) return denied;
                const since = parseSince("read_session_graph_node_usage", args.since_iso);
                if (since && "error" in since) return since;
                const rows = await catalog.getSessionGraphNodeUsage(id, {
                    since: since as Date | undefined,
                    limit: args.limit,
                    nodeKeyLike: args.node_key_like,
                    kind: args.kind,
                });
                return { enabled: true, sessionId: id, rows };
            } catch (err: any) {
                return { error: `read_session_graph_node_usage: ${err?.message || String(err)}` };
            }
        },
    });

    const readFleetGraphNodeUsageTool = defineTool("read_fleet_graph_node_usage", {
        description:
            "Read fleet-wide exact graph node-key usage. Use since_iso plus optional node_key_like/kind to answer " +
            "how often a node key was searched or loaded over a bounded window.",
        parameters: {
            type: "object" as const,
            properties: {
                include_deleted: { type: "boolean", description: "Default false." },
                since_iso: { type: "string", description: "Optional ISO timestamp lower bound on event time." },
                limit: { type: "number", description: "Max rows (default 100, max 500)." },
                node_key_like: { type: "string", description: "Optional substring match over nodeKey." },
                kind: { type: "string", enum: ["searched", "loaded"], description: "Optional row kind filter." },
            },
        },
        handler: async (args: { include_deleted?: boolean; since_iso?: string; limit?: number; node_key_like?: string; kind?: "searched" | "loaded" }) => {
            const denied = await requireAdmin("read_fleet_graph_node_usage");   // RULE 3
            if (denied) return denied;
            try {
                const since = parseSince("read_fleet_graph_node_usage", args.since_iso);
                if (since && "error" in since) return since;
                return await catalog.getFleetGraphNodeUsage({
                    since: since as Date | undefined,
                    includeDeleted: args.include_deleted === true,
                    limit: args.limit,
                    nodeKeyLike: args.node_key_like,
                    kind: args.kind,
                });
            } catch (err: any) {
                return { error: `read_fleet_graph_node_usage: ${err?.message || String(err)}` };
            }
        },
    });

    const readSessionGraphEdgeSearchUsageTool = defineTool("read_session_graph_edge_search_usage", {
        description:
            "Read requested graph edge-search shapes for a session, grouped by predicateKey/fromKey/toKey/namespace.",
        parameters: {
            type: "object" as const,
            properties: {
                session_id: { type: "string" },
                since_iso: { type: "string", description: "Optional ISO timestamp lower bound." },
                limit: { type: "number", description: "Max rows (default 100, max 500)." },
            },
            required: ["session_id"],
        },
        handler: async (args: { session_id: string; since_iso?: string; limit?: number }, ctx?: { sessionId?: string }) => {
            const id = normalizeSessionId(args.session_id);
            try {
                const denied = await ensureSelfOrDescendant("read_session_graph_edge_search_usage", id, ctx?.sessionId);
                if (denied) return denied;
                const since = parseSince("read_session_graph_edge_search_usage", args.since_iso);
                if (since && "error" in since) return since;
                const rows = await catalog.getSessionGraphEdgeSearchUsage(id, { since: since as Date | undefined, limit: args.limit });
                return { enabled: true, sessionId: id, rows };
            } catch (err: any) {
                return { error: `read_session_graph_edge_search_usage: ${err?.message || String(err)}` };
            }
        },
    });

    const lineageRetrievalTools = [
        readSessionRetrievalUsageTool,
        readSessionTreeRetrievalUsageTool,
        readSessionGraphNodeUsageTool,
        readSessionGraphEdgeSearchUsageTool,
    ];

    // context_health is a SELF-scoped footprint sensor: it reads the CALLER's
    // own session (ctx.sessionId) and returns epoch, turns-this-epoch, context
    // utilization, compaction depth, transcript/event sizes and an ok/elevated/
    // degraded assessment. Every agent needs it to detect its own degradation
    // and decide whether to regenerate — so it must ship to ordinary
    // (non-system) sessions, not just the tuner. Defined before the tool-set
    // branches so all return paths can include it.
    const contextHealthTool = defineTool("context_health", {
        description:
            "Check YOUR OWN context health: transcript epoch, token utilization, compaction depth "
            + "(summaries-of-summaries), event-log and snapshot sizes, and an overall assessment "
            + "(ok / elevated / degraded) with a recommendation. This is the regeneration/footprint "
            + "sensor — call it when asked for regen or context stats, when you have been running a "
            + "long time, notice yourself losing track of earlier work, or want to decide whether to "
            + "regenerate your context at a natural boundary. Cheap (control-plane, cached).",
        parameters: { type: "object" as const, properties: {} },
        handler: async (_args: Record<string, never>, ctx?: { sessionId?: string }) => {
            const sessionId = ctx?.sessionId;
            if (!sessionId) return { error: "context_health: caller session id is required" };
            try {
                const cached = contextHealthCache.get(sessionId);
                const footprint = cached ?? await computeSessionFootprint(
                    {
                        getSession: (id) => catalog.getSession(id),
                        getSessionEventStats: (id, afterSeq) => catalog.getSessionEventStats(id, afterSeq),
                        getSessionCompactionStats: (id, afterSeq) => catalog.getSessionCompactionStats(id, afterSeq),
                        getSessionEventsBefore: (id, beforeSeq, limit, eventTypes) =>
                            catalog.getSessionEventsBefore(id, beforeSeq, limit, eventTypes),
                        getSessionMetricSummary: (id) => catalog.getSessionMetricSummary(id),
                        getEpochBoundarySeq: async (id) => {
                            const rows = await catalog.getSessionEventsBefore(
                                id, Number.MAX_SAFE_INTEGER, 1, ["session.epoch_committed"],
                            );
                            return rows.length > 0 ? Number((rows[0] as any).seq) : null;
                        },
                    },
                    sessionId,
                );
                if (!cached) contextHealthCache.set(footprint);
                const { assessment } = footprint;
                const recommendationText =
                    assessment.level === "degraded"
                        ? "Consider calling regenerate_context at a natural boundary (finish the current step first)."
                        : assessment.level === "elevated"
                            ? "Context is aging but workable. Re-anchor on facts if you feel unsure about earlier work."
                            : "Context is healthy. No action needed.";
                return {
                    sessionId: footprint.sessionId,
                    transcriptEpoch: footprint.transcriptEpoch,
                    epochAgeDays: footprint.epochAgeDays,
                    turnsThisEpoch: footprint.turnsThisEpoch,
                    context: footprint.context,
                    transcript: footprint.transcript,
                    events: footprint.events,
                    assessment,
                    recommendation: recommendationText,
                };
            } catch (err: any) {
                return { error: `context_health: ${err?.message || String(err)}` };
            }
        },
    });

    // Ordinary agents get the lineage-scoped surface and stop here.
    //
    // `diagnosticBundle` is checked ALONGSIDE `isSystemAgent`, not nested
    // inside it: the Agent Manager is deliberately not a system agent any
    // more (phase E made it an installable package with an owner and a
    // version), so gating the bundle on system membership would have silently
    // stripped every tool it exists to hold.
    if (!isSystemAgent && !diagnosticBundle) {
        return [readAgentEventsTool, contextHealthTool, ...lineageRetrievalTools];
    }

    if (!diagnosticBundle) {
        return [readAgentEventsTool, contextHealthTool, ...systemReadTools, ...lineageRetrievalTools];
    }

    const factsTools: Tool<any>[] = [];
    if (factStore) {
        factsTools.push(defineTool("read_session_facts_stats", {
            description:
                "Read per-session non-shared facts grouped by knowledge namespace " +
                "(skills | asks | intake | config | (other)). Returns counts and " +
                "value-byte totals only — never the fact values themselves. " +
                "Use to spot sessions producing unusually large facts payloads.",
            parameters: {
                type: "object" as const,
                properties: { session_id: { type: "string" } },
                required: ["session_id"],
            },
            handler: async (args: { session_id: string }) => {
                const id = normalizeSessionId(args.session_id);
                const denied = await ensureVisible("read_session_facts_stats", id);   // RULE 2
                if (denied) return denied;
                try {
                    const rows = await factStore.getSessionFactsStats(id);
                    return {
                        sessionId: id,
                        rows,
                        totalCount: rows.reduce((a, r) => a + r.factCount, 0),
                        totalBytes: rows.reduce((a, r) => a + r.totalValueBytes, 0),
                    };
                } catch (err: any) {
                    return { error: `read_session_facts_stats: ${err?.message || String(err)}` };
                }
            },
        }));

        factsTools.push(defineTool("read_session_tree_facts_stats", {
            description:
                "Read facts stats rolled up across the spawn tree rooted at a session. " +
                "Resolves descendants from the CMS first, then aggregates in the " +
                "facts schema. Same row shape as read_session_facts_stats.",
            parameters: {
                type: "object" as const,
                properties: { session_id: { type: "string" } },
                required: ["session_id"],
            },
            handler: async (args: { session_id: string }) => {
                const id = normalizeSessionId(args.session_id);
                const denied = await ensureVisible("read_session_tree_facts_stats", id);   // RULE 2
                if (denied) return denied;
                try {
                    const descendants = await catalog.getDescendantSessionIds(id);
                    const ids = Array.from(new Set([id, ...descendants]));
                    const rolledUp = await factStore.getFactsStatsForSessions(ids);
                    return {
                        rootSessionId: id,
                        sessionIds: ids,
                        rolledUp,
                        totalCount: rolledUp.reduce((a, r) => a + r.factCount, 0),
                        totalBytes: rolledUp.reduce((a, r) => a + r.totalValueBytes, 0),
                    };
                } catch (err: any) {
                    return { error: `read_session_tree_facts_stats: ${err?.message || String(err)}` };
                }
            },
        }));

        factsTools.push(defineTool("read_shared_facts_stats", {
            description:
                "Read shared (cross-session) facts grouped by knowledge namespace. " +
                "Use to verify Facts Manager output (curated 'skills/' growth) and to " +
                "spot stalled or runaway shared-fact production.",
            parameters: { type: "object" as const, properties: {} },
            handler: async () => {
                try {
                    const rows = await factStore.getSharedFactsStats();
                    return {
                        rows,
                        totalCount: rows.reduce((a, r) => a + r.factCount, 0),
                        totalBytes: rows.reduce((a, r) => a + r.totalValueBytes, 0),
                    };
                } catch (err: any) {
                    return { error: `read_shared_facts_stats: ${err?.message || String(err)}` };
                }
            },
        }));

        factsTools.push(defineTool("read_facts_tombstone_stats", {
            description:
                "Read soft-deleted fact tombstone backlog stats. Use to diagnose graph crawler lag: " +
                "unreconciled tombstones still have last_crawled_at NULL and may strand graph evidence if TTL-purged.",
            parameters: {
                type: "object" as const,
                properties: {
                    ttl_seconds: { type: "number", description: "Tombstone TTL in seconds. Default 21600 (6h)." },
                },
            },
            handler: async (args: { ttl_seconds?: number }) => {
                try {
                    return await factStore.getFactsTombstoneStats(args.ttl_seconds);
                } catch (err: any) {
                    return { error: `read_facts_tombstone_stats: ${err?.message || String(err)}` };
                }
            },
        }));

        // Durable embedder status (07 P5) — semantic/hybrid search only returns
        // semantic hits while the in-DB embed loop is running. Base PgFactStore
        // (or an enhanced store with no embedding endpoint) reports unsupported.
        factsTools.push(defineTool("read_embedder_status", {
            description:
                "Read the durable embedder status for the facts store: whether the in-database batch-embedding " +
                "loop is running. Semantic and hybrid facts_search only return semantic hits while it runs; if it " +
                "is stopped or unsupported, search is lexical-only. Use when diagnosing why semantic search returns nothing.",
            parameters: { type: "object" as const, properties: {} },
            handler: async () => {
                try {
                    // Gate ONLY on EnhancedFactStore (guarantees embedderStatus()).
                    // NOT on construction-time capabilities.embedder — the durable
                    // loop may be running for the schema even if THIS store was
                    // built without an embedding endpoint. embedderStatus() reads
                    // durable df.instances state (the truth).
                    if (!isEnhancedFactStore(factStore)) {
                        return { supported: false, note: "facts store has no durable embedder (lexical-only search)." };
                    }
                    const st = await factStore.embedderStatus();
                    return { supported: true, running: st.running, instanceId: st.instanceId, status: st.status };
                } catch (err: any) {
                    return { error: `read_embedder_status: ${err?.message || String(err)}` };
                }
            },
        }));
    }

    const tools: Tool<any>[] = [
        readAgentEventsTool,
        contextHealthTool,
        ...systemReadTools,
        readSessionMetricSummaryTool,
        readSessionTokensByModelTool,
        readSessionGraphSearchesTool,
        readSessionTreeStatsTool,
        readFleetStatsTool,
        readSessionSkillUsageTool,
        readSessionTreeSkillUsageTool,
        readFleetSkillUsageTool,
        readSessionRetrievalUsageTool,
        readSessionTreeRetrievalUsageTool,
        readFleetRetrievalUsageTool,
        readSessionGraphNodeUsageTool,
        readFleetGraphNodeUsageTool,
        readSessionGraphEdgeSearchUsageTool,
        ...factsTools,
    ];

    if (duroxideClient) {
        const readOrchestrationStatsTool = defineTool("read_orchestration_stats", {
            description:
                "Read duroxide runtime stats for the orchestration backing a session: " +
                "history event count + bytes, queue pending count, KV key count + bytes, current orchestrationVersion.",
            parameters: {
                type: "object" as const,
                properties: { session_id: { type: "string" } },
                required: ["session_id"],
            },
            handler: async (args: { session_id: string }) => {
                const id = normalizeSessionId(args.session_id);
                const denied = await ensureVisible("read_orchestration_stats", id);   // RULE 2
                if (denied) return denied;
                const orchId = `session-${id}`;
                try {
                    const [statsRes, infoRes] = await Promise.allSettled([
                        duroxideClient.getOrchestrationStats(orchId),
                        duroxideClient.getInstanceInfo(orchId),
                    ]);
                    const out: Record<string, unknown> = { sessionId: id };
                    if (statsRes.status === "fulfilled" && statsRes.value && typeof statsRes.value === "object") {
                        const s = statsRes.value as any;
                        for (const k of [
                            "historyEventCount", "historySizeBytes", "queuePendingCount",
                            "kvUserKeyCount", "kvTotalValueBytes",
                        ]) {
                            const n = Number(s[k]);
                            if (Number.isFinite(n)) out[k] = n;
                        }
                    }
                    if (infoRes.status === "fulfilled" && infoRes.value) {
                        const info = infoRes.value as any;
                        if (typeof info.orchestrationVersion === "string") out.orchestrationVersion = info.orchestrationVersion;
                        if (typeof info.status === "string") out.orchestrationStatus = info.status;
                    }
                    return out;
                } catch (err: any) {
                    return { error: `read_orchestration_stats: ${err?.message || String(err)}` };
                }
            },
        });

        const readExecutionHistoryTool = defineTool("read_execution_history", {
            description:
                "Read the raw duroxide execution history for a session's current (or specified) execution. " +
                "Definitive ground truth for replay and nondeterminism investigations. " +
                "Use sparingly — history can be large; prefer paginating via limit / offset.",
            parameters: {
                type: "object" as const,
                properties: {
                    session_id: { type: "string" },
                    execution_id: { type: "number", description: "Optional. Defaults to the latest execution." },
                    limit: { type: "number", description: "Max events to return (default 100, hard cap 500)." },
                    offset: { type: "number", description: "Number of events to skip from the start." },
                },
                required: ["session_id"],
            },
            handler: async (args: {
                session_id: string;
                execution_id?: number;
                limit?: number;
                offset?: number;
            }) => {
                const id = normalizeSessionId(args.session_id);
                const denied = await ensureVisible("read_execution_history", id);   // RULE 2
                if (denied) return denied;
                const orchId = `session-${id}`;
                const cap = Math.min(Math.max(1, Number(args.limit) || 100), 500);
                const offset = Math.max(0, Number(args.offset) || 0);
                try {
                    let execId = args.execution_id;
                    if (execId == null) {
                        const executions: number[] = await duroxideClient.listExecutions(orchId);
                        if (!Array.isArray(executions) || executions.length === 0) {
                            return { sessionId: id, executionId: null, events: [], hasMore: false };
                        }
                        execId = executions[executions.length - 1];
                    }
                    const events = await duroxideClient.readExecutionHistory(orchId, execId);
                    if (!Array.isArray(events)) {
                        return { sessionId: id, executionId: execId, events: [], hasMore: false };
                    }
                    const slice = events.slice(offset, offset + cap);
                    return {
                        sessionId: id,
                        executionId: execId,
                        totalCount: events.length,
                        offset,
                        events: slice.map((e: any) => ({
                            eventId: Number(e.eventId) || 0,
                            kind: String(e.kind || ""),
                            ...(e.sourceEventId != null ? { sourceEventId: Number(e.sourceEventId) } : {}),
                            timestampMs: Number(e.timestampMs) || 0,
                            ...(e.data != null ? { data: String(e.data).slice(0, MAX_DATA_BYTES) } : {}),
                        })),
                        hasMore: offset + slice.length < events.length,
                    };
                } catch (err: any) {
                    return { error: `read_execution_history: ${err?.message || String(err)}` };
                }
            },
        });

        const listOrchestrationsByStatusTool = defineTool("list_orchestrations_by_status", {
            description:
                "List duroxide orchestration instances by lifecycle status. " +
                "Use to find every Running / Failed / Suspended / Completed / Terminated orchestration across the fleet.",
            parameters: {
                type: "object" as const,
                properties: {
                    status: {
                        type: "string",
                        enum: ["Running", "Failed", "Suspended", "Completed", "Terminated"],
                    },
                    limit: { type: "number", description: "Cap returned rows (default 100, max 500)." },
                },
                required: ["status"],
            },
            handler: async (args: { status: string; limit?: number }) => {
                const cap = Math.min(Math.max(1, Number(args.limit) || 100), 500);
                try {
                    const instances = await duroxideClient.listInstancesByStatus(args.status);
                    const arr = Array.isArray(instances) ? instances : [];
                    const slice = arr.slice(0, cap);
                    return {
                        status: args.status,
                        totalCount: arr.length,
                        truncated: arr.length > cap,
                        instances: slice.map((inst: any) => ({
                            orchestrationId: String(inst?.instanceId ?? inst?.orchId ?? ""),
                            sessionId: typeof inst?.instanceId === "string" && inst.instanceId.startsWith("session-")
                                ? inst.instanceId.slice("session-".length)
                                : null,
                            status: String(inst?.status ?? ""),
                            ...(inst?.orchestrationVersion ? { orchestrationVersion: String(inst.orchestrationVersion) } : {}),
                        })),
                    };
                } catch (err: any) {
                    return { error: `list_orchestrations_by_status: ${err?.message || String(err)}` };
                }
            },
        });

        tools.push(readOrchestrationStatsTool, readExecutionHistoryTool, listOrchestrationsByStatusTool);
    }

    // ── The WRITE bundle ─────────────────────────────────────────────────
    //
    // Gated on the same capability as the deep read bundle, and acting as the
    // same resolved viewer. It adds no authority: every mutation lands on the
    // catalog functions the Web API already calls, which enforce
    // creator-or-admin inside the database. What the gate decides is which
    // agents BEHAVE like managers, not what a manager is allowed to do.
    if (diagnosticBundle) {
        tools.push(...createAgentManagerTools({
            catalog,
            artifactStore: opts.artifactStore ?? null,
            sessionId: opts.sessionId,
            resolveViewer: viewerFor,
        }));
    }

    return tools;
}
