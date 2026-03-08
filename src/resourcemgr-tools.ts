/**
 * Resource Manager Agent Tools — infrastructure monitoring and cleanup tools
 * for tracking compute, storage, database, and runtime footprint.
 *
 * Provides read-only stats (infra, storage, DB) plus controlled cleanup
 * operations (orphan purge, event purge, DB compaction, scaling, termination).
 *
 * These are registered as worker-level tools and referenced by the Resource
 * Manager Agent session via toolNames.
 *
 * @module
 * @internal
 */

import { defineTool } from "@github/copilot-sdk";
import { execSync } from "node:child_process";
import type { SessionCatalogProvider } from "./cms.js";
import type { SessionBlobStore } from "./blob-store.js";
import type { Tool } from "@github/copilot-sdk";

/**
 * Create resource manager tools bound to the given dependencies.
 */
export function createResourceManagerTools(opts: {
    catalog: SessionCatalogProvider;
    duroxideClient: any;
    blobStore: SessionBlobStore | null;
    duroxideSchema?: string;
    cmsSchema?: string;
}): Tool<any>[] {
    const { catalog, duroxideClient, blobStore } = opts;
    const duroxideSchema = opts.duroxideSchema ?? "duroxide";
    const cmsSchema = opts.cmsSchema ?? "copilot_sessions";

    // ── get_infrastructure_stats ─────────────────────────────

    const infraStatsTool = defineTool("get_infrastructure_stats", {
        description:
            "Get AKS/Kubernetes infrastructure stats: pod count, status, restarts, " +
            "node count, and namespace info. Returns structured JSON. " +
            "Requires kubectl access (fails gracefully if unavailable).",
        parameters: {
            type: "object" as const,
            properties: {
                namespace: {
                    type: "string",
                    description: "Kubernetes namespace. Default: copilot-runtime",
                },
            },
        },
        handler: async (args: { namespace?: string }) => {
            const ns = args.namespace ?? "copilot-runtime";
            try {
                const raw = execSync(
                    `kubectl get pods -n ${ns} -o json 2>/dev/null`,
                    { timeout: 15_000, encoding: "utf-8" },
                );
                const data = JSON.parse(raw);
                const pods = data.items ?? [];

                const result = {
                    namespace: ns,
                    pods: {
                        total: pods.length,
                        running: 0, pending: 0, failed: 0, terminating: 0, other: 0,
                    },
                    restarts: { total: 0, pods: [] as string[] },
                    podDetails: [] as any[],
                };

                for (const pod of pods) {
                    const name = pod.metadata?.name ?? "unknown";
                    const phase = pod.metadata?.deletionTimestamp
                        ? "Terminating"
                        : (pod.status?.phase ?? "Unknown");

                    switch (phase) {
                        case "Running": result.pods.running++; break;
                        case "Pending": result.pods.pending++; break;
                        case "Failed": result.pods.failed++; break;
                        case "Terminating": result.pods.terminating++; break;
                        default: result.pods.other++; break;
                    }

                    let podRestarts = 0;
                    for (const cs of pod.status?.containerStatuses ?? []) {
                        podRestarts += cs.restartCount ?? 0;
                    }
                    if (podRestarts > 0) {
                        result.restarts.total += podRestarts;
                        result.restarts.pods.push(`${name} (${podRestarts})`);
                    }

                    result.podDetails.push({
                        name: name.slice(-20), // last 20 chars for readability
                        phase,
                        restarts: podRestarts,
                        age: pod.metadata?.creationTimestamp ?? null,
                    });
                }

                // Node count
                try {
                    const nodesRaw = execSync(
                        `kubectl get nodes -o json 2>/dev/null`,
                        { timeout: 10_000, encoding: "utf-8" },
                    );
                    const nodesData = JSON.parse(nodesRaw);
                    (result as any).nodes = (nodesData.items ?? []).length;
                } catch {
                    (result as any).nodes = "unavailable";
                }

                return result;
            } catch (err: any) {
                return {
                    error: "kubectl unavailable or failed",
                    message: err.message?.slice(0, 200),
                    hint: "This tool requires kubectl configured with cluster access.",
                };
            }
        },
    });

    // ── get_storage_stats ────────────────────────────────────

    const storageStatsTool = defineTool("get_storage_stats", {
        description:
            "Get Azure Blob Storage statistics: total blob count, total size, " +
            "breakdown by type (session state, metadata, artifacts), and orphaned blob count. " +
            "Returns structured JSON. Requires blob storage to be configured.",
        parameters: {
            type: "object" as const,
            properties: {
                detectOrphans: {
                    type: "boolean",
                    description: "Cross-reference blobs with CMS to find orphans. Default: true. Slower for large blob counts.",
                },
            },
        },
        handler: async (args: { detectOrphans?: boolean }) => {
            if (!blobStore) {
                return { error: "Blob storage not configured." };
            }

            try {
                const detectOrphans = args.detectOrphans !== false;

                // Access the container client via the blob store's internal container
                // We need to iterate all blobs — use the internal containerClient
                const containerClient = (blobStore as any).containerClient;
                if (!containerClient) {
                    return { error: "Cannot access blob storage container." };
                }

                const stats = {
                    totalBlobs: 0,
                    totalSizeBytes: 0,
                    totalSizeMB: 0,
                    byType: {
                        sessionState: { count: 0, sizeBytes: 0 },
                        metadata: { count: 0, sizeBytes: 0 },
                        artifacts: { count: 0, sizeBytes: 0 },
                        other: { count: 0, sizeBytes: 0 },
                    },
                    orphanedBlobs: 0,
                    orphanedSizeMB: 0,
                    sessionIds: new Set<string>(),
                };

                for await (const blob of containerClient.listBlobsFlat({ includeMetadata: true })) {
                    const size = blob.properties?.contentLength ?? 0;
                    stats.totalBlobs++;
                    stats.totalSizeBytes += size;

                    const name = blob.name;
                    if (name.startsWith("artifacts/")) {
                        stats.byType.artifacts.count++;
                        stats.byType.artifacts.sizeBytes += size;
                        // Extract session ID from artifacts/<sessionId>/...
                        const parts = name.split("/");
                        if (parts[1]) stats.sessionIds.add(parts[1]);
                    } else if (name.endsWith(".tar.gz")) {
                        stats.byType.sessionState.count++;
                        stats.byType.sessionState.sizeBytes += size;
                        stats.sessionIds.add(name.replace(".tar.gz", ""));
                    } else if (name.endsWith(".meta.json")) {
                        stats.byType.metadata.count++;
                        stats.byType.metadata.sizeBytes += size;
                        stats.sessionIds.add(name.replace(".meta.json", ""));
                    } else {
                        stats.byType.other.count++;
                        stats.byType.other.sizeBytes += size;
                    }
                }

                stats.totalSizeMB = Math.round(stats.totalSizeBytes / 1024 / 1024 * 100) / 100;

                // Orphan detection: blobs whose session IDs have no CMS entry
                let orphanedBlobs = 0;
                let orphanedSizeBytes = 0;
                if (detectOrphans && stats.sessionIds.size > 0) {
                    const cmsSessions = await catalog.listSessions();
                    const cmsIds = new Set(cmsSessions.map(s => s.sessionId));

                    for (const blobSessionId of stats.sessionIds) {
                        if (!cmsIds.has(blobSessionId)) {
                            orphanedBlobs++;
                            // Count size of orphaned blobs
                            orphanedSizeBytes +=
                                (stats.byType.sessionState.sizeBytes / Math.max(stats.byType.sessionState.count, 1)) +
                                (stats.byType.metadata.sizeBytes / Math.max(stats.byType.metadata.count, 1));
                        }
                    }
                }

                return {
                    totalBlobs: stats.totalBlobs,
                    totalSizeMB: stats.totalSizeMB,
                    byType: {
                        sessionState: {
                            count: stats.byType.sessionState.count,
                            sizeMB: Math.round(stats.byType.sessionState.sizeBytes / 1024 / 1024 * 100) / 100,
                        },
                        metadata: {
                            count: stats.byType.metadata.count,
                            sizeMB: Math.round(stats.byType.metadata.sizeBytes / 1024 / 1024 * 100) / 100,
                        },
                        artifacts: {
                            count: stats.byType.artifacts.count,
                            sizeMB: Math.round(stats.byType.artifacts.sizeBytes / 1024 / 1024 * 100) / 100,
                        },
                        other: {
                            count: stats.byType.other.count,
                            sizeMB: Math.round(stats.byType.other.sizeBytes / 1024 / 1024 * 100) / 100,
                        },
                    },
                    uniqueSessionIds: stats.sessionIds.size,
                    orphanedBlobs,
                    orphanedSizeMB: Math.round(orphanedSizeBytes / 1024 / 1024 * 100) / 100,
                };
            } catch (err: any) {
                return { error: err.message };
            }
        },
    });

    // ── get_database_stats ───────────────────────────────────

    const dbStatsTool = defineTool("get_database_stats", {
        description:
            "Get database statistics across both schemas: CMS (sessions, events) and " +
            "duroxide (orchestration instances, executions, history, queues). " +
            "Returns row counts, averages, and queue depths.",
        parameters: {
            type: "object" as const,
            properties: {},
        },
        handler: async () => {
            try {
                // Access the pg pool from the catalog provider
                const pool = (catalog as any).pool;
                if (!pool) {
                    return { error: "Database pool not available — using non-PostgreSQL provider" };
                }

                // CMS stats
                const cmsStats: any = {};
                try {
                    const sessResult = await pool.query(
                        `SELECT
                            COUNT(*) as total,
                            COUNT(*) FILTER (WHERE deleted_at IS NULL) as active,
                            COUNT(*) FILTER (WHERE deleted_at IS NOT NULL) as deleted,
                            COUNT(*) FILTER (WHERE state = 'running' AND deleted_at IS NULL) as running,
                            COUNT(*) FILTER (WHERE state = 'completed' AND deleted_at IS NULL) as completed,
                            COUNT(*) FILTER (WHERE state = 'pending' AND deleted_at IS NULL) as pending,
                            COUNT(*) FILTER (WHERE state = 'failed' AND deleted_at IS NULL) as failed,
                            COUNT(*) FILTER (WHERE is_system = true AND deleted_at IS NULL) as system_sessions,
                            COUNT(*) FILTER (WHERE parent_session_id IS NOT NULL AND deleted_at IS NULL) as sub_agents
                        FROM ${cmsSchema}.sessions`,
                    );
                    Object.assign(cmsStats, sessResult.rows[0]);

                    const evtResult = await pool.query(
                        `SELECT
                            COUNT(*) as total_events,
                            COUNT(DISTINCT session_id) as sessions_with_events,
                            MIN(created_at) as earliest_event,
                            MAX(created_at) as latest_event
                        FROM ${cmsSchema}.session_events`,
                    );
                    cmsStats.events = evtResult.rows[0];

                    // Avg events per session
                    if (cmsStats.events.sessions_with_events > 0) {
                        cmsStats.events.avg_per_session = Math.round(
                            Number(cmsStats.events.total_events) / Number(cmsStats.events.sessions_with_events),
                        );
                    }
                } catch (err: any) {
                    cmsStats.error = err.message;
                }

                // Duroxide stats
                const duroxideStats: any = {};
                try {
                    // Instances
                    const instResult = await pool.query(
                        `SELECT
                            COUNT(*) as total_instances,
                            COUNT(*) FILTER (WHERE runtime_status = 'Running') as running,
                            COUNT(*) FILTER (WHERE runtime_status = 'Completed') as completed,
                            COUNT(*) FILTER (WHERE runtime_status = 'Failed') as failed,
                            COUNT(*) FILTER (WHERE runtime_status = 'Suspended') as suspended,
                            COUNT(*) FILTER (WHERE runtime_status = 'Terminated') as terminated
                        FROM ${duroxideSchema}.instances`,
                    );
                    duroxideStats.instances = instResult.rows[0];
                } catch (err: any) {
                    duroxideStats.instancesError = err.message;
                }

                try {
                    // Executions
                    const execResult = await pool.query(
                        `SELECT COUNT(*) as total_executions FROM ${duroxideSchema}.executions`,
                    );
                    duroxideStats.totalExecutions = Number(execResult.rows[0].total_executions);

                    // Avg executions per instance
                    const instCount = Number(duroxideStats.instances?.total_instances ?? 1);
                    if (instCount > 0) {
                        duroxideStats.avgExecutionsPerInstance =
                            Math.round((duroxideStats.totalExecutions / instCount) * 10) / 10;
                    }
                } catch (err: any) {
                    duroxideStats.executionsError = err.message;
                }

                try {
                    // History events
                    const histResult = await pool.query(
                        `SELECT COUNT(*) as total_history FROM ${duroxideSchema}.history`,
                    );
                    duroxideStats.totalHistoryEvents = Number(histResult.rows[0].total_history);
                } catch (err: any) {
                    duroxideStats.historyError = err.message;
                }

                try {
                    // Queue depths
                    const queueResult = await pool.query(`
                        SELECT
                            (SELECT COUNT(*) FROM ${duroxideSchema}.orchestrator_queue) as orchestrator_queue,
                            (SELECT COUNT(*) FROM ${duroxideSchema}.worker_queue) as worker_queue,
                            (SELECT COUNT(*) FROM ${duroxideSchema}.timer_queue) as timer_queue
                    `);
                    duroxideStats.queues = queueResult.rows[0];
                } catch (err: any) {
                    duroxideStats.queuesError = err.message;
                }

                // Database size (overall)
                const dbSize: any = {};
                try {
                    const sizeResult = await pool.query(
                        `SELECT pg_size_pretty(pg_database_size(current_database())) as db_size`,
                    );
                    dbSize.totalSize = sizeResult.rows[0].db_size;

                    // Schema sizes
                    const schemaSizes = await pool.query(`
                        SELECT schemaname, pg_size_pretty(SUM(pg_total_relation_size(schemaname || '.' || tablename))) as size
                        FROM pg_tables
                        WHERE schemaname IN ($1, $2)
                        GROUP BY schemaname
                    `, [cmsSchema, duroxideSchema]);
                    for (const row of schemaSizes.rows) {
                        dbSize[row.schemaname] = row.size;
                    }
                } catch (err: any) {
                    dbSize.error = err.message;
                }

                return { cms: cmsStats, duroxide: duroxideStats, database: dbSize };
            } catch (err: any) {
                return { error: err.message };
            }
        },
    });

    // ═══════════════════════════════════════════════════════════
    // CLEANUP / CONTROL TOOLS
    // ═══════════════════════════════════════════════════════════

    // ── purge_orphaned_blobs ─────────────────────────────────

    const purgeOrphansTool = defineTool("purge_orphaned_blobs", {
        description:
            "Delete blobs (session state .tar.gz + .meta.json) whose session ID has no " +
            "matching CMS entry. Dry-run by default — returns what WOULD be deleted. " +
            "Pass confirm=true to actually delete.",
        parameters: {
            type: "object" as const,
            properties: {
                confirm: {
                    type: "boolean",
                    description: "Actually delete orphaned blobs. Default: false (dry-run).",
                },
            },
        },
        handler: async (args: { confirm?: boolean }) => {
            if (!blobStore) return { error: "Blob storage not configured." };

            try {
                const containerClient = (blobStore as any).containerClient;
                if (!containerClient) return { error: "Cannot access blob storage container." };

                const confirm = args.confirm === true;

                // Collect all session IDs referenced in blob storage
                const blobSessionIds = new Set<string>();
                for await (const blob of containerClient.listBlobsFlat()) {
                    const name = blob.name;
                    if (name.endsWith(".tar.gz")) {
                        blobSessionIds.add(name.replace(".tar.gz", ""));
                    } else if (name.startsWith("artifacts/")) {
                        const parts = name.split("/");
                        if (parts[1]) blobSessionIds.add(parts[1]);
                    }
                }

                // Cross-reference with CMS
                const cmsSessions = await catalog.listSessions();
                const cmsIds = new Set(cmsSessions.map(s => s.sessionId));

                const orphanIds: string[] = [];
                for (const blobId of blobSessionIds) {
                    if (!cmsIds.has(blobId)) {
                        orphanIds.push(blobId);
                    }
                }

                if (!confirm) {
                    return {
                        dryRun: true,
                        orphanCount: orphanIds.length,
                        orphanIds: orphanIds.slice(0, 50), // Cap display
                        message: orphanIds.length > 0
                            ? "Call again with confirm=true to delete these."
                            : "No orphaned blobs found.",
                    };
                }

                // Actually delete
                let deletedBlobs = 0;
                for (const sessionId of orphanIds) {
                    try {
                        await blobStore.delete(sessionId);
                        deletedBlobs += 2; // .tar.gz + .meta.json
                    } catch {}
                    // Also delete artifacts
                    try {
                        const artCount = await blobStore.deleteArtifacts(sessionId);
                        deletedBlobs += artCount;
                    } catch {}
                }

                return {
                    dryRun: false,
                    orphansDeleted: orphanIds.length,
                    blobsDeleted: deletedBlobs,
                };
            } catch (err: any) {
                return { error: err.message };
            }
        },
    });

    // ── purge_old_events ─────────────────────────────────────

    const purgeEventsTool = defineTool("purge_old_events", {
        description:
            "Delete CMS session_events rows older than N minutes. Events are write-once " +
            "diagnostic logs — safe to prune after consumption. The events table is the " +
            "fastest-growing table. Minimum age: 60 minutes (enforced).",
        parameters: {
            type: "object" as const,
            properties: {
                olderThanMinutes: {
                    type: "number",
                    description: "Delete events older than this many minutes. Default: 1440 (24h). Minimum: 60.",
                },
            },
        },
        handler: async (args: { olderThanMinutes?: number }) => {
            try {
                const pool = (catalog as any).pool;
                if (!pool) return { error: "Database pool not available." };

                const minutes = Math.max(args.olderThanMinutes ?? 1440, 60);
                const cutoff = new Date(Date.now() - minutes * 60 * 1000);

                const result = await pool.query(
                    `DELETE FROM ${cmsSchema}.session_events WHERE created_at < $1`,
                    [cutoff],
                );

                return {
                    eventsDeleted: result.rowCount ?? 0,
                    cutoff: cutoff.toISOString(),
                    olderThanMinutes: minutes,
                };
            } catch (err: any) {
                return { error: err.message };
            }
        },
    });

    // ── compact_database ─────────────────────────────────────

    const compactDbTool = defineTool("compact_database", {
        description:
            "Run VACUUM ANALYZE on CMS and duroxide schemas to reclaim disk space " +
            "after bulk deletes and update query planner statistics. Safe, non-blocking " +
            "(regular VACUUM, not FULL).",
        parameters: {
            type: "object" as const,
            properties: {},
        },
        handler: async () => {
            try {
                const pool = (catalog as any).pool;
                if (!pool) return { error: "Database pool not available." };

                const results: string[] = [];

                // VACUUM ANALYZE must run outside a transaction
                const client = await pool.connect();
                try {
                    for (const table of [
                        `${cmsSchema}.sessions`,
                        `${cmsSchema}.session_events`,
                        `${duroxideSchema}.instances`,
                        `${duroxideSchema}.executions`,
                        `${duroxideSchema}.history`,
                    ]) {
                        try {
                            await client.query(`VACUUM ANALYZE ${table}`);
                            results.push(`${table}: OK`);
                        } catch (err: any) {
                            results.push(`${table}: ${err.message}`);
                        }
                    }
                } finally {
                    client.release();
                }

                return { results };
            } catch (err: any) {
                return { error: err.message };
            }
        },
    });

    // ── scale_workers ────────────────────────────────────────

    const scaleWorkersTool = defineTool("scale_workers", {
        description:
            "Scale the AKS worker deployment to a specified number of replicas. " +
            "Min: 1, Max: 12. Requires kubectl access.",
        parameters: {
            type: "object" as const,
            properties: {
                replicas: {
                    type: "number",
                    description: "Target replica count. Required. Range: 1-12.",
                },
                namespace: {
                    type: "string",
                    description: "Kubernetes namespace. Default: copilot-runtime",
                },
                deployment: {
                    type: "string",
                    description: "Deployment name. Default: copilot-runtime-worker",
                },
            },
            required: ["replicas"],
        },
        handler: async (args: { replicas: number; namespace?: string; deployment?: string }) => {
            const replicas = Math.round(args.replicas);
            if (replicas < 1 || replicas > 12) {
                return { error: `Replica count must be 1-12 (got ${replicas}).` };
            }

            const ns = args.namespace ?? "copilot-runtime";
            const deploy = args.deployment ?? "copilot-runtime-worker";

            try {
                const output = execSync(
                    `kubectl scale deployment ${deploy} -n ${ns} --replicas=${replicas} 2>&1`,
                    { timeout: 15_000, encoding: "utf-8" },
                );
                return {
                    ok: true,
                    replicas,
                    output: output.trim(),
                };
            } catch (err: any) {
                return {
                    error: "kubectl scale failed",
                    message: err.message?.slice(0, 300),
                };
            }
        },
    });

    // ── force_terminate_session ──────────────────────────────

    const forceTerminateTool = defineTool("force_terminate_session", {
        description:
            "Force-terminate a stuck session: soft-deletes CMS entry and destroys the " +
            "duroxide orchestration instance. Use for sessions that are unresponsive or " +
            "stuck in a loop. Refuses to terminate system sessions.",
        parameters: {
            type: "object" as const,
            properties: {
                sessionId: {
                    type: "string",
                    description: "The session ID to terminate. Required.",
                },
            },
            required: ["sessionId"],
        },
        handler: async (args: { sessionId: string }) => {
            const { sessionId } = args;
            if (!sessionId) return { error: "sessionId is required." };

            try {
                // Check if session exists and is not a system session
                const session = await catalog.getSession(sessionId);
                if (!session) {
                    return { error: `Session ${sessionId} not found.` };
                }
                if (session.isSystem) {
                    return { error: "Cannot terminate system sessions." };
                }

                // Check if session is actually stuck (no activity for > 10 minutes)
                const inactiveMinutes = session.lastActiveAt
                    ? (Date.now() - new Date(session.lastActiveAt).getTime()) / 60_000
                    : Infinity;

                if (inactiveMinutes < 10 && session.state === "running") {
                    return {
                        error: `Session is still active (last activity ${Math.round(inactiveMinutes)} min ago). ` +
                            `Only sessions inactive for > 10 minutes can be force-terminated.`,
                    };
                }

                // Destroy duroxide orchestration
                const orchId = `session-${sessionId}`;
                try {
                    await duroxideClient.deleteInstance(orchId, true);
                } catch {
                    // May already be gone
                }

                // Soft-delete CMS entry
                await catalog.softDeleteSession(sessionId);

                // Also clean up blobs
                let blobsCleaned = 0;
                if (blobStore) {
                    try {
                        await blobStore.delete(sessionId);
                        blobsCleaned += 2;
                    } catch {}
                    try {
                        blobsCleaned += await blobStore.deleteArtifacts(sessionId);
                    } catch {}
                }

                return {
                    ok: true,
                    sessionId,
                    inactiveMinutes: Math.round(inactiveMinutes),
                    blobsCleaned,
                };
            } catch (err: any) {
                return { error: err.message };
            }
        },
    });

    return [
        infraStatsTool,
        storageStatsTool,
        dbStatsTool,
        purgeOrphansTool,
        purgeEventsTool,
        compactDbTool,
        scaleWorkersTool,
        forceTerminateTool,
    ];
}
