import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";

const SYSTEM_AGENTS = ["sweeper", "resourcemgr", "facts-manager"];

const FACTS_PREFIXES = ["skills/%", "asks/%"] as const;

interface SessionSnapshot {
    sessionId: string;
    updatedAt: string | null;
    status: string;
}

interface FactsSnapshot {
    count: number;
    latestUpdatedAt: string | null;
}

/**
 * Starts a background poller that detects session/resource changes and emits
 * MCP `notifications/resources/updated` notifications. The poller activates
 * when the first subscription arrives and stops when all subscriptions clear.
 */
export function enableResourceSubscriptions(
    server: McpServer,
    ctx: ServerContext,
    pollIntervalMs = 5_000,
) {
    const subscriptions = new Set<string>();
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let lastSnapshot = new Map<string, SessionSnapshot>();
    let lastFactsSnapshot = new Map<string, FactsSnapshot>();

    // Access the lower-level Server for sendResourceUpdated
    const lowLevel = (server as any).server;
    if (!lowLevel?.sendResourceUpdated) return;

    function startPoller() {
        if (pollTimer) return;
        pollTimer = setInterval(async () => {
            try {
                await pollForChanges();
                await pollFactsChanges();
            } catch {
                // Swallow — poller is best-effort
            }
        }, pollIntervalMs);
    }

    function stopPoller() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    async function pollForChanges() {
        if (subscriptions.size === 0) return;

        const sessions = await ctx.mgmt.listSessions();
        const currentSnapshot = new Map<string, SessionSnapshot>();

        for (const s of sessions as any[]) {
            currentSnapshot.set(s.sessionId, {
                sessionId: s.sessionId,
                updatedAt: s.updatedAt ?? null,
                status: s.status,
            });

            const prev = lastSnapshot.get(s.sessionId);
            const changed = !prev
                || prev.updatedAt !== (s.updatedAt ?? null)
                || prev.status !== s.status;

            if (changed) {
                // Session-specific resource
                const sessionUri = `pilotswarm://sessions/${s.sessionId}`;
                if (subscriptions.has(sessionUri)) {
                    try {
                        await lowLevel.sendResourceUpdated({ uri: sessionUri });
                    } catch { /* ignore */ }
                }

                // System agent alias resources
                if (s.isSystem && s.agentId && SYSTEM_AGENTS.includes(s.agentId)) {
                    const agentUri = `pilotswarm://agents/${s.agentId}`;
                    if (subscriptions.has(agentUri)) {
                        try {
                            await lowLevel.sendResourceUpdated({ uri: agentUri });
                        } catch { /* ignore */ }
                    }
                }
            }
        }

        // Sessions list changed if any session added/removed/modified
        if (subscriptions.has("pilotswarm://sessions")) {
            const anyChange = currentSnapshot.size !== lastSnapshot.size
                || [...currentSnapshot.entries()].some(([id, snap]) => {
                    const prev = lastSnapshot.get(id);
                    return !prev || prev.updatedAt !== snap.updatedAt || prev.status !== snap.status;
                });
            if (anyChange) {
                try {
                    await lowLevel.sendResourceUpdated({ uri: "pilotswarm://sessions" });
                } catch { /* ignore */ }
            }
        }

        lastSnapshot = currentSnapshot;
    }

    async function pollFactsChanges() {
        const factsUris = [
            "pilotswarm://facts/skills",
            "pilotswarm://facts/asks",
        ];

        const subscribedFacts = factsUris.filter(u => subscriptions.has(u));
        if (subscribedFacts.length === 0) return;

        const currentFactsSnapshot = new Map<string, FactsSnapshot>();

        for (const uri of subscribedFacts) {
            const prefix = uri === "pilotswarm://facts/skills" ? "skills/%" : "asks/%";
            try {
                const result = await ctx.facts.readFacts({ keyPattern: prefix, limit: 1000 });
                const facts = result.facts ?? [];
                const latestUpdatedAt = facts.reduce((latest: string | null, f: any) => {
                    const u = f.updatedAt ?? f.updated_at ?? null;
                    if (!u) return latest;
                    return !latest || u > latest ? u : latest;
                }, null);

                currentFactsSnapshot.set(uri, {
                    count: result.count ?? facts.length,
                    latestUpdatedAt,
                });

                const prev = lastFactsSnapshot.get(uri);
                const changed = !prev
                    || prev.count !== (result.count ?? facts.length)
                    || prev.latestUpdatedAt !== latestUpdatedAt;

                if (changed) {
                    try {
                        await lowLevel.sendResourceUpdated({ uri });
                    } catch { /* ignore */ }
                }
            } catch {
                // Facts store may not be available
            }
        }

        lastFactsSnapshot = currentFactsSnapshot;
    }

    // Hook into MCP subscribe/unsubscribe via the low-level server
    try {
        lowLevel.setRequestHandler?.(
            { method: "resources/subscribe" },
            async (request: any) => {
                const uri = request?.params?.uri;
                if (uri) {
                    subscriptions.add(uri);
                    startPoller();
                }
                return {};
            },
        );

        lowLevel.setRequestHandler?.(
            { method: "resources/unsubscribe" },
            async (request: any) => {
                const uri = request?.params?.uri;
                if (uri) subscriptions.delete(uri);
                if (subscriptions.size === 0) stopPoller();
                return {};
            },
        );
    } catch {
        // MCP SDK may not support subscribe handlers in this version — degrade gracefully
    }
}
