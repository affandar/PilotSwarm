import { CopilotClient, type CopilotSession } from "@github/copilot-sdk";

/**
 * Manages Copilot CLI sessions.
 * Keeps an in-memory map of active sessions for liveness detection.
 * @internal
 */
export class SessionManager {
    private client: CopilotClient | null = null;
    private sessions = new Map<string, CopilotSession>();

    constructor(private githubToken?: string) {}

    /** Ensure the CopilotClient is started. */
    async ensureClient(): Promise<CopilotClient> {
        if (!this.client) {
            this.client = new CopilotClient({
                githubToken: this.githubToken,
                logLevel: "error",
            });
        }
        return this.client;
    }

    /** Create a new Copilot session and track it. */
    async createSession(
        config: Parameters<CopilotClient["createSession"]>[0]
    ): Promise<CopilotSession> {
        const client = await this.ensureClient();
        const session = await client.createSession(config);
        this.sessions.set(session.sessionId, session);
        return session;
    }

    /** Resume an existing session. Returns null if session files don't exist. */
    async resumeSession(
        sessionId: string,
        config: Parameters<CopilotClient["resumeSession"]>[1]
    ): Promise<CopilotSession | null> {
        try {
            const client = await this.ensureClient();
            const session = await client.resumeSession(sessionId, config);
            this.sessions.set(sessionId, session);
            return session;
        } catch {
            return null;
        }
    }

    /** Get a tracked session by ID, or null if not tracked. */
    getSession(sessionId: string): CopilotSession | null {
        return this.sessions.get(sessionId) ?? null;
    }

    /** Check if a session is alive (in-memory guard). */
    isAlive(sessionId: string): boolean {
        return this.sessions.has(sessionId);
    }

    /** Destroy a session and remove from tracking. */
    async destroySession(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId);
        if (session) {
            await session.destroy();
            this.sessions.delete(sessionId);
        }
    }

    /** Get all tracked session IDs. */
    activeSessionIds(): string[] {
        return [...this.sessions.keys()];
    }

    /** Shut down the client and all sessions. */
    async shutdown(): Promise<void> {
        if (this.client) {
            await this.client.stop();
            this.client = null;
        }
        this.sessions.clear();
    }
}
