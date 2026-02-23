import { CopilotClient, type CopilotSession, type Tool } from "@github/copilot-sdk";
import { ManagedSession } from "./managed-session.js";
import { SessionBlobStore } from "./blob-store.js";
import type { ManagedSessionConfig, SerializableSessionConfig } from "./types.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SESSION_STATE_DIR = path.join(os.homedir(), ".copilot", "session-state");

/**
 * SessionManager — singleton per worker node.
 * Owns session lifecycle, wraps CopilotClient.
 *
 * Three ways a session appears:
 *   1. Brand new → createSession
 *   2. Same node, still warm → getSession returns it
 *   3. Post-hydration → local files exist → resumeSession
 *
 * @internal
 */
export class SessionManager {
    private client: CopilotClient | null = null;
    private sessions = new Map<string, ManagedSession>();
    private blobStore: SessionBlobStore | null = null;
    /** In-memory configs with non-serializable fields (tools, hooks). */
    private sessionConfigs = new Map<string, ManagedSessionConfig>();
    /** Worker-level tool registry — shared reference from DurableCopilotWorker. */
    private toolRegistry = new Map<string, Tool<any>>();

    constructor(
        private githubToken?: string,
        blobStore?: SessionBlobStore | null,
    ) {
        this.blobStore = blobStore ?? null;
    }

    /** Store full config (with tools/hooks) for a session. Called by DurableCopilotClient. */
    setConfig(sessionId: string, config: ManagedSessionConfig): void {
        this.sessionConfigs.set(sessionId, config);
    }

    /** Set the worker-level tool registry. Called by DurableCopilotWorker. */
    setToolRegistry(registry: Map<string, Tool<any>>): void {
        this.toolRegistry = registry;
    }

    /** Ensure the CopilotClient is started. */
    private async ensureClient(): Promise<CopilotClient> {
        if (!this.client) {
            this.client = new CopilotClient({
                githubToken: this.githubToken,
                logLevel: "error",
            });
        }
        return this.client;
    }

    /**
     * Get existing session or create/resume one.
     * Merges serializable config (from duroxide) with in-memory config (tools/hooks).
     */
    async getOrCreate(sessionId: string, serializableConfig: SerializableSessionConfig): Promise<ManagedSession> {
        // Resolve tools: merge per-session (setConfig) + registry (toolNames)
        const storedConfig = this.sessionConfigs.get(sessionId);
        const resolvedTools = this._resolveTools(storedConfig, serializableConfig);

        const config: ManagedSessionConfig = {
            ...storedConfig,
            ...serializableConfig,
            tools: resolvedTools.length > 0 ? resolvedTools : undefined,
            hooks: storedConfig?.hooks,
        };

        // 1. Check if already in memory (warm) — update config in case
        //    tools were registered after the session was first created.
        const existing = this.sessions.get(sessionId);
        if (existing) {
            existing.updateConfig(config);
            return existing;
        }

        const client = await this.ensureClient();
        const sessionDir = path.join(SESSION_STATE_DIR, sessionId);

        // Merge user tools with system tool definitions (wait, ask_user)
        // so the LLM sees them at session creation time.
        const userTools = config.tools ?? [];
        const systemTools = ManagedSession.systemToolDefs();
        const allTools = [
            ...userTools.filter((t: any) => t.name !== "wait" && t.name !== "ask_user"),
            ...systemTools,
        ];

        const sessionConfig = {
            sessionId,
            tools: allTools,
            model: config.model,
            systemMessage:
                typeof config.systemMessage === "string"
                    ? { content: config.systemMessage }
                    : config.systemMessage,
            workingDirectory: config.workingDirectory,
            hooks: config.hooks,
            infiniteSessions: { enabled: false },
        };

        let copilotSession: CopilotSession;

        // 2. Check if local session files exist (post-hydration or same node restart)
        if (fs.existsSync(sessionDir)) {
            copilotSession = await client.resumeSession(sessionId, sessionConfig);
        } else if (this.blobStore) {
            // 3. Try to hydrate from blob (files missing, e.g. pod restarted)
            try {
                await this.blobStore.hydrate(sessionId);
                if (fs.existsSync(sessionDir)) {
                    copilotSession = await client.resumeSession(sessionId, sessionConfig);
                } else {
                    copilotSession = await client.createSession(sessionConfig);
                }
            } catch {
                copilotSession = await client.createSession(sessionConfig);
            }
        } else {
            // 4. Brand new session
            copilotSession = await client.createSession(sessionConfig);
        }

        const managed = new ManagedSession(sessionId, copilotSession, config);
        this.sessions.set(sessionId, managed);
        return managed;
    }

    /** Get a session by ID (null if not in memory on this node). */
    get(sessionId: string): ManagedSession | null {
        return this.sessions.get(sessionId) ?? null;
    }

    /**
     * Dehydrate a session: destroy in memory → tar → upload to blob.
     */
    async dehydrate(sessionId: string, reason: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (session) {
            await session.destroy();
            this.sessions.delete(sessionId);
        }
        if (this.blobStore) {
            await this.blobStore.dehydrate(sessionId, { reason });
        }
    }

    /**
     * Hydrate: download session state from blob to local disk.
     * The next getOrCreate() will detect local files and resume.
     */
    async hydrate(sessionId: string): Promise<void> {
        if (this.blobStore) {
            await this.blobStore.hydrate(sessionId);
        }
    }

    /**
     * Destroy a session and remove from tracking.
     */
    async destroySession(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (session) {
            await session.destroy();
            this.sessions.delete(sessionId);
        }
    }

    /** List all in-memory session IDs on this node. */
    activeSessionIds(): string[] {
        return [...this.sessions.keys()];
    }

    /** Shutdown: destroy all sessions, stop CopilotClient. */
    async shutdown(): Promise<void> {
        for (const [_, session] of this.sessions) {
            try { await session.destroy(); } catch {}
        }
        this.sessions.clear();
        if (this.client) {
            await this.client.stop();
            this.client = null;
        }
    }

    /**
     * Resolve tools from per-session config + worker-level registry.
     * Per-session tools take precedence over registry tools with the same name.
     */
    private _resolveTools(
        storedConfig: ManagedSessionConfig | undefined,
        serializableConfig: SerializableSessionConfig,
    ): Tool<any>[] {
        const registryTools: Tool<any>[] = [];
        if (serializableConfig.toolNames?.length) {
            for (const name of serializableConfig.toolNames) {
                const tool = this.toolRegistry.get(name);
                if (tool) registryTools.push(tool);
            }
        }

        const combined = [
            ...(storedConfig?.tools ?? []),
            ...registryTools,
        ];

        // Deduplicate by name — per-session tools take precedence
        const seen = new Set<string>();
        const deduped: Tool<any>[] = [];
        for (const tool of combined) {
            const name = (tool as any).name;
            if (!seen.has(name)) {
                seen.add(name);
                deduped.push(tool);
            }
        }
        return deduped;
    }
}
