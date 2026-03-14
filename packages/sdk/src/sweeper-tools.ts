/**
 * Sweeper Agent Tools — system maintenance tools for scanning and cleaning
 * up completed/zombie sessions.
 *
 * Leverages duroxide's bulk prune APIs (deleteInstanceBulk, pruneExecutionsBulk)
 * for efficient cleanup, plus CMS-level soft-delete for session metadata.
 *
 * These are registered as worker-level tools and referenced by the Sweeper
 * Agent session via toolNames.
 *
 * @module
 * @internal
 */

import { defineTool } from "@github/copilot-sdk";
import type { SessionCatalogProvider } from "./cms.js";
import type { Tool } from "@github/copilot-sdk";

/**
 * Create sweeper tools bound to the given CMS catalog and duroxide client.
 *
 * Call this after the worker has initialized the catalog and duroxide provider,
 * then register the returned tools via `worker.registerTools(tools)`.
 */
export function createSweeperTools(opts: {
    catalog: SessionCatalogProvider;
    duroxideClient: any;
    duroxideSchema?: string;
    storeUrl?: string;
}): Tool<any>[] {
    const { catalog, duroxideClient } = opts;

    // ── scan_completed_sessions ───────────────────────────────

    const scanTool = defineTool("scan_completed_sessions", {
        description:
            "Scan for completed, failed, or orphaned sessions that are eligible for cleanup. " +
            "Returns a list of sessions that have been idle/completed longer than the specified grace period.",
        parameters: {
            type: "object" as const,
            properties: {
                graceMinutes: {
                    type: "number",
                    description:
                        "Only return sessions that completed/failed more than this many minutes ago. Default: 5",
                },
                includeOrphans: {
                    type: "boolean",
                    description:
                        "Include orphaned sub-agents whose parent session no longer exists. Default: true",
                },
            },
        },
        handler: async (args: { graceMinutes?: number; includeOrphans?: boolean }) => {
            const graceMinutes = args.graceMinutes ?? 5;
            const includeOrphans = args.includeOrphans ?? true;
            const results: Array<{
                sessionId: string;
                parentSessionId?: string;
                status: string;
                title?: string;
                age: string;
                reason: string;
            }> = [];

            try {
                const allSessions = await catalog.listSessions();
                const sessionIds = new Set(allSessions.map(s => s.sessionId));
                const cutoff = new Date(Date.now() - graceMinutes * 60 * 1000);

                for (const session of allSessions) {
                    // Never touch system sessions
                    if (session.isSystem) continue;

                    let orchStatus: any = {};
                    let customStatus: any = {};

                    try {
                        orchStatus = await duroxideClient.getStatus(`session-${session.sessionId}`);
                        if (orchStatus.customStatus) {
                            customStatus = typeof orchStatus.customStatus === "string"
                                ? JSON.parse(orchStatus.customStatus)
                                : orchStatus.customStatus;
                        }
                    } catch {
                        // Orchestration not found — treat as completed
                        orchStatus = { status: "NotFound" };
                    }

                    const ageMs = Date.now() - session.updatedAt.getTime();
                    const ageStr = ageMs > 3_600_000
                        ? `${Math.round(ageMs / 3_600_000)}h`
                        : `${Math.round(ageMs / 60_000)}m`;

                    // Check for completed/failed orchestrations
                    if (
                        orchStatus.status === "Completed" ||
                        orchStatus.status === "Failed" ||
                        orchStatus.status === "Terminated" ||
                        orchStatus.status === "NotFound"
                    ) {
                        if (session.updatedAt < cutoff) {
                            results.push({
                                sessionId: session.sessionId,
                                parentSessionId: session.parentSessionId ?? undefined,
                                status: orchStatus.status,
                                title: session.title ?? undefined,
                                age: ageStr,
                                reason: `Orchestration ${orchStatus.status.toLowerCase()}`,
                            });
                        }
                        continue;
                    }

                    // Check for idle sub-agents (completed their task but orch still running)
                    if (
                        session.parentSessionId &&
                        customStatus.status === "idle" &&
                        session.updatedAt < cutoff
                    ) {
                        results.push({
                            sessionId: session.sessionId,
                            parentSessionId: session.parentSessionId,
                            status: "zombie",
                            title: session.title ?? undefined,
                            age: ageStr,
                            reason: "Sub-agent idle (zombie)",
                        });
                        continue;
                    }

                    // Check for orphaned sub-agents
                    if (
                        includeOrphans &&
                        session.parentSessionId &&
                        !sessionIds.has(session.parentSessionId) &&
                        session.updatedAt < cutoff
                    ) {
                        results.push({
                            sessionId: session.sessionId,
                            parentSessionId: session.parentSessionId,
                            status: "orphan",
                            title: session.title ?? undefined,
                            age: ageStr,
                            reason: "Parent session no longer exists",
                        });
                    }
                }

                return {
                    found: results.length,
                    graceMinutes,
                    sessions: results,
                };
            } catch (err: any) {
                return { error: err.message, found: 0, sessions: [] };
            }
        },
    });

    // ── cleanup_session ──────────────────────────────────────

    const cleanupTool = defineTool("cleanup_session", {
        description:
            "Delete a completed/zombie session and all its descendants. " +
            "Removes from CMS (soft-delete) and deletes the duroxide orchestration instance. " +
            "Refuses to delete system sessions.",
        parameters: {
            type: "object" as const,
            properties: {
                sessionId: {
                    type: "string",
                    description: "The session ID to clean up",
                },
                reason: {
                    type: "string",
                    description: "Reason for cleanup (logged for auditing)",
                },
            },
            required: ["sessionId"] as const,
        },
        handler: async (args: { sessionId: string; reason?: string }) => {
            const { sessionId, reason } = args;
            const deleteReason = reason ?? "Cleaned up by Sweeper Agent";

            try {
                // Check if session exists and is not a system session
                const session = await catalog.getSession(sessionId);
                if (!session) {
                    return { ok: false, error: "Session not found" };
                }
                if (session.isSystem) {
                    return { ok: false, error: "Cannot delete system session" };
                }

                // Find and delete all descendants first
                const descendants = await catalog.getDescendantSessionIds(sessionId);
                let deletedCount = 0;

                for (const descId of descendants) {
                    try {
                        await catalog.softDeleteSession(descId);
                        try {
                            await duroxideClient.deleteInstance(`session-${descId}`, true);
                        } catch {}
                        deletedCount++;
                    } catch {}
                }

                // Delete the session itself
                await catalog.softDeleteSession(sessionId);
                try {
                    await duroxideClient.deleteInstance(`session-${sessionId}`, true);
                } catch {}
                deletedCount++;

                return {
                    ok: true,
                    sessionId,
                    deletedCount,
                    reason: deleteReason,
                    descendants: descendants.length,
                };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        },
    });

    // ── prune_orchestrations ─────────────────────────────────
    // Uses duroxide's bulk APIs for efficient cleanup at the orchestration level.
    // Modeled after toygres's system-pruner pattern.

    const pruneTool = defineTool("prune_orchestrations", {
        description:
            "Bulk prune duroxide orchestration state. " +
            "Two operations: (1) delete terminal (Completed/Failed/Terminated) orchestration " +
            "instances older than N minutes, and (2) prune old executions from all instances, " +
            "keeping only the last N executions per instance. " +
            "This is a system-level operation that cleans up duroxide storage directly.",
        parameters: {
            type: "object" as const,
            properties: {
                deleteTerminalOlderThanMinutes: {
                    type: "number",
                    description:
                        "Delete completed/failed orchestration instances older than this many minutes. Default: 5",
                },
                keepExecutions: {
                    type: "number",
                    description:
                        "Keep only the last N executions per instance (current execution is never pruned). Default: 3",
                },
                batchLimit: {
                    type: "number",
                    description:
                        "Max instances to process per batch. Default: 1000",
                },
            },
        },
        handler: async (args: {
            deleteTerminalOlderThanMinutes?: number;
            keepExecutions?: number;
            batchLimit?: number;
        }) => {
            const deleteMinutes = args.deleteTerminalOlderThanMinutes ?? 5;
            const keepExecutions = args.keepExecutions ?? 3;
            const batchLimit = args.batchLimit ?? 1000;

            try {
                const cutoffMs = Date.now() - deleteMinutes * 60 * 1000;

                // Step 1: Delete terminal instances older than cutoff
                const deleteResult = await duroxideClient.deleteInstanceBulk({
                    completedBefore: cutoffMs,
                    limit: batchLimit,
                });

                // Step 2: Prune old executions across all instances
                const pruneResult = await duroxideClient.pruneExecutionsBulk(
                    { limit: batchLimit },
                    { keepLast: keepExecutions },
                );

                // Step 3: Also soft-delete CMS rows for deleted terminal instances
                // (CMS may have stale rows for instances duroxide just deleted)
                let cmsCleanedUp = 0;
                try {
                    const cmsSessions = await catalog.listSessions();
                    for (const s of cmsSessions) {
                        if (s.isSystem) continue;
                        try {
                            await duroxideClient.getStatus(`session-${s.sessionId}`);
                        } catch {
                            // Instance no longer exists in duroxide — clean up CMS
                            try {
                                await catalog.softDeleteSession(s.sessionId);
                                cmsCleanedUp++;
                            } catch {}
                        }
                    }
                } catch {}

                return {
                    ok: true,
                    deleteTerminal: {
                        instancesDeleted: deleteResult.instancesDeleted ?? 0,
                        executionsDeleted: deleteResult.executionsDeleted ?? 0,
                        eventsDeleted: deleteResult.eventsDeleted ?? 0,
                    },
                    pruneExecutions: {
                        instancesProcessed: pruneResult.instancesProcessed ?? 0,
                        executionsDeleted: pruneResult.executionsDeleted ?? 0,
                        eventsDeleted: pruneResult.eventsDeleted ?? 0,
                    },
                    cmsCleanedUp,
                };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        },
    });

    // ── get_system_stats ─────────────────────────────────────

    const statsTool = defineTool("get_system_stats", {
        description:
            "Get runtime statistics: total sessions, active count, completed count, " +
            "zombie count, memory usage, uptime, and database connection info.",
        parameters: {
            type: "object" as const,
            properties: {},
        },
        handler: async () => {
            try {
                const allSessions = await catalog.listSessions();

                // Parse database host/name from store URL (strip credentials)
                let database: { host?: string; port?: string; name?: string; provider?: string } = {};
                if (opts.storeUrl) {
                    try {
                        const url = new URL(opts.storeUrl);
                        database.host = url.hostname;
                        database.port = url.port || "5432";
                        database.name = url.pathname.replace(/^\//, "") || "postgres";
                        // Detect provider from hostname
                        if (url.hostname.includes(".horizondb.azure.com")) database.provider = "Azure HorizonDB";
                        else if (url.hostname.includes(".postgres.database.azure.com")) database.provider = "Azure Flexible Server";
                        else if (url.hostname.includes(".azure.com")) database.provider = "Azure";
                        else database.provider = "PostgreSQL";
                    } catch {}
                }

                const stats = {
                    total: allSessions.length,
                    byState: {} as Record<string, number>,
                    systemSessions: 0,
                    subAgents: 0,
                    rootSessions: 0,
                    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
                    uptimeMinutes: Math.round(process.uptime() / 60),
                    database,
                };

                for (const s of allSessions) {
                    stats.byState[s.state] = (stats.byState[s.state] ?? 0) + 1;
                    if (s.isSystem) stats.systemSessions++;
                    if (s.parentSessionId) stats.subAgents++;
                    else stats.rootSessions++;
                }

                return stats;
            } catch (err: any) {
                return { error: err.message };
            }
        },
    });

    return [scanTool, cleanupTool, pruneTool, statsTool];
}
