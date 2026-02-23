import { CopilotClient, type CopilotSession } from "@github/copilot-sdk";
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
        // 1. Check if already in memory (warm)
        const existing = this.sessions.get(sessionId);
        if (existing) {
            return existing;
        }

        // Merge: in-memory full config takes precedence for tools/hooks,
        // serializable config (from orchestration) takes precedence for model/systemMessage
        const storedConfig = this.sessionConfigs.get(sessionId);
        const config: ManagedSessionConfig = {
            ...storedConfig,
            ...serializableConfig,
            // Non-serializable fields come from in-memory store
            tools: storedConfig?.tools,
            hooks: storedConfig?.hooks,
        };

        const client = await this.ensureClient();
        const sessionDir = path.join(SESSION_STATE_DIR, sessionId);

        const sessionConfig = {
            sessionId,
            tools: config.tools ?? [],
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
}
