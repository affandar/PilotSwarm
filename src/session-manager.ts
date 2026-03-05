import { CopilotClient, type CopilotSession, type Tool } from "@github/copilot-sdk";
import { ManagedSession } from "./managed-session.js";
import { SessionBlobStore } from "./blob-store.js";
import type { ManagedSessionConfig, SerializableSessionConfig } from "./types.js";
import type { ModelProviderRegistry } from "./model-providers.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SESSION_STATE_DIR = path.join(os.homedir(), ".copilot", "session-state");

/** Worker-level defaults — applied to every session. */
export interface WorkerDefaults {
    systemMessage?: string;
    /** Skill directories to pass to the Copilot SDK. */
    skillDirectories?: string[];
    /** Custom agents to pass to the Copilot SDK. */
    customAgents?: Array<{ name: string; description?: string; prompt: string; tools?: string[] | null }>;
    /** MCP server configs to pass to the Copilot SDK. */
    mcpServers?: Record<string, any>;
    /**
     * @deprecated Use `modelProviders` instead. Kept for backwards compatibility.
     * Custom LLM provider config (BYOK). Passed to every session.
     */
    provider?: {
        type?: "openai" | "azure" | "anthropic";
        baseUrl: string;
        apiKey?: string;
        azure?: { apiVersion?: string };
    };
    /** Multi-provider model registry. Takes precedence over `provider`. */
    modelProviders?: ModelProviderRegistry;
}

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
    /** Worker-level defaults for building blocks. */
    private workerDefaults: WorkerDefaults;

    constructor(
        private githubToken?: string,
        blobStore?: SessionBlobStore | null,
        workerDefaults?: WorkerDefaults,
    ) {
        this.blobStore = blobStore ?? null;
        this.workerDefaults = workerDefaults ?? {};
    }

    /** Store full config (with tools/hooks) for a session. Called by DurableCopilotClient. */
    setConfig(sessionId: string, config: ManagedSessionConfig): void {
        this.sessionConfigs.set(sessionId, config);
    }

    /** Get a human-readable model summary for LLM tool consumption. */
    getModelSummary(): string | undefined {
        return this.workerDefaults.modelProviders?.getModelSummaryForLLM();
    }

    /** Set the worker-level tool registry. Called by DurableCopilotWorker. */
    setToolRegistry(registry: Map<string, Tool<any>>): void {
        this.toolRegistry = registry;
    }

    /** Ensure the CopilotClient is started. */
    private async ensureClient(): Promise<CopilotClient> {
        if (!this.client) {
            // Resolve githubToken: explicit > registry (github provider) > none
            let token = this.githubToken;
            if (!token && this.workerDefaults.modelProviders) {
                // Check if any provider is type=github
                for (const p of this.workerDefaults.modelProviders.allProviders) {
                    if (p.type === "github" && p.models.length > 0) {
                        const firstModel = typeof p.models[0] === "string" ? p.models[0] : p.models[0].name;
                        const resolved = this.workerDefaults.modelProviders.resolve(`${p.id}:${firstModel}`);
                        token = resolved?.githubToken;
                        break;
                    }
                }
            }
            this.client = new CopilotClient({
                githubToken: token,
                logLevel: "error",
            });
        }
        return this.client;
    }

    /**
     * Get existing session or create/resume one.
     * Merges: worker defaults → serializable config (from client) → in-memory config (tools/hooks).
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

        // Merge user tools with system tool definitions (wait, ask_user, sub-agent tools)
        // so the LLM sees them at session creation time.
        const userTools = config.tools ?? [];
        const systemTools = ManagedSession.systemToolDefs();
        const subAgentTools = ManagedSession.subAgentToolDefs();
        const SYSTEM_TOOL_NAMES = new Set([...systemTools, ...subAgentTools].map((t: any) => t.name));
        const allTools = [
            ...userTools.filter((t: any) => !SYSTEM_TOOL_NAMES.has(t.name)),
            ...systemTools,
            ...subAgentTools,
        ];

        // Build system message: worker base + client override
        const systemMessage = this._buildSystemMessage(config.systemMessage);

        // Resolve model: config.model may be qualified (provider:model) or bare.
        // The SDK needs the bare model name; the provider config is separate.
        // Fall back to registry default if no model specified.
        const registry = this.workerDefaults.modelProviders;
        const effectiveModel = config.model || registry?.defaultModel || "";
        const resolvedProviderConfig = this._resolveProviderConfig(effectiveModel);
        let sdkModelName = effectiveModel;
        if (registry && effectiveModel) {
            const desc = registry.getDescriptor(effectiveModel);
            if (desc) sdkModelName = desc.modelName;
        }

        const sessionConfig: any = {
            sessionId,
            tools: allTools,
            model: sdkModelName,
            systemMessage: systemMessage
                ? (typeof systemMessage === "string" ? { content: systemMessage } : systemMessage)
                : undefined,
            workingDirectory: config.workingDirectory,
            hooks: config.hooks,
            onPermissionRequest: (config as any).onPermissionRequest ?? (async () => ({ kind: "approved" as const })),
            infiniteSessions: { enabled: false },
            // Custom LLM provider — resolve from registry or legacy single provider
            ...resolvedProviderConfig,
            // Pass loaded skills, agents, and MCP from worker defaults
            ...(this.workerDefaults.skillDirectories?.length && { skillDirectories: this.workerDefaults.skillDirectories }),
            ...(this.workerDefaults.customAgents?.length && { customAgents: this.workerDefaults.customAgents }),
            ...(this.workerDefaults.mcpServers && Object.keys(this.workerDefaults.mcpServers).length > 0 && { mcpServers: this.workerDefaults.mcpServers }),
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
     *
     * If destroy() fails (e.g., Copilot connection already disposed), we retry
     * by re-creating the session from local files and destroying again. The
     * session files on disk are the source of truth — they were written during
     * runTurn. We need destroy() to succeed (or at least not leave the session
     * in a broken state) before we can upload to blob.
     *
     * After MAX_RETRIES, we still attempt the blob upload (session files on
     * disk are likely valid) but throw a clear error if that also fails.
     */
    async dehydrate(sessionId: string, reason: string): Promise<void> {
        const MAX_RETRIES = 3;
        let lastError: Error | undefined;

        // Phase 1: Destroy the in-memory session (with retries)
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            const session = this.sessions.get(sessionId);
            if (!session) break; // No in-memory session — nothing to destroy

            try {
                await session.destroy();
                this.sessions.delete(sessionId);
                break; // Success
            } catch (err: any) {
                lastError = err;
                this.sessions.delete(sessionId); // Remove broken session from map

                if (attempt < MAX_RETRIES) {
                    // Re-create the session from local files so we can try destroy again.
                    // The session directory should exist — runTurn wrote to it.
                    const sessionDir = path.join(SESSION_STATE_DIR, sessionId);
                    if (fs.existsSync(sessionDir)) {
                        try {
                            const client = await this.ensureClient();
                            const copilotSession = await client.resumeSession(sessionId, {
                                tools: [...ManagedSession.systemToolDefs(), ...ManagedSession.subAgentToolDefs()],
                                onPermissionRequest: async () => ({ kind: "approved" as const }),
                            });
                            const config = this.sessionConfigs.get(sessionId) ?? {};
                            const managed = new ManagedSession(sessionId, copilotSession, config);
                            this.sessions.set(sessionId, managed);
                            // Brief pause before retry
                            await new Promise(r => setTimeout(r, 500 * attempt));
                        } catch {
                            // Can't resume — session files may be corrupt. Fall through.
                            break;
                        }
                    } else {
                        break; // No local files — can't retry
                    }
                }
            }
        }

        // Phase 2: Upload to blob storage (always attempt, even if destroy failed)
        if (this.blobStore) {
            try {
                await this.blobStore.dehydrate(sessionId, { reason });
            } catch (blobErr: any) {
                // If destroy AND blob both failed, throw a combined error
                if (lastError) {
                    throw new Error(
                        `Session ${sessionId} is not dehydratable: ` +
                        `destroy failed (${lastError.message}), ` +
                        `blob upload also failed (${blobErr.message}). ` +
                        `Session state may be lost on pod recycle.`
                    );
                }
                throw blobErr;
            }
        }

        // If destroy failed but blob succeeded, the session is safe in blob.
        // Log but don't throw — the session can be recovered.
        if (lastError) {
            console.warn(
                `[SessionManager] destroy() failed for ${sessionId} after ${MAX_RETRIES} attempts ` +
                `(${lastError.message}), but blob upload succeeded. Session state is preserved.`
            );
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

    /**
     * Checkpoint: upload session state to blob without destroying the session or
     * releasing affinity. Used for crash resilience — session stays warm.
     */
    async checkpoint(sessionId: string): Promise<void> {
        if (this.blobStore) {
            await this.blobStore.checkpoint(sessionId);
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

    /**
     * Resolve the provider config for a given model.
     * Prefers ModelProviderRegistry, falls back to legacy single provider.
     */
    private _resolveProviderConfig(model?: string): Record<string, any> {
        // 1. Try the multi-provider registry
        const registry = this.workerDefaults.modelProviders;
        if (registry) {
            const resolved = registry.resolve(model);
            if (resolved) {
                if (resolved.type === "github") {
                    // GitHub provider — no SDK provider needed, uses githubToken on the client
                    return {};
                }
                if (resolved.sdkProvider) {
                    return { provider: resolved.sdkProvider };
                }
            }
        }

        // 2. Fall back to legacy single provider
        const p = this.workerDefaults.provider;
        if (!p) return {};

        // For Azure, dynamically construct deployment URL
        if (p.type === "azure" && model && !p.baseUrl.includes("/deployments/")) {
            return {
                provider: {
                    ...p,
                    baseUrl: `${p.baseUrl.replace(/\/+$/, "")}/deployments/${model}`,
                },
            };
        }
        return { provider: p };
    }

    /**
     * Build the final system message by combining:
     * 1. Worker base system message (from workerDefaults)
     * 2. Client override (append or replace)
     * Skills/agents are NOT injected here — the Copilot SDK discovers
     * them from plugins installed in configDir.
     */
    private _buildSystemMessage(
        clientMessage?: string | { mode: "append" | "replace"; content: string },
    ): string | { mode: "append" | "replace"; content: string } | undefined {
        const base = this.workerDefaults.systemMessage ?? "";

        if (!clientMessage) {
            return base || undefined;
        }
        if (typeof clientMessage === "string") {
            return base ? `${base}\n\n${clientMessage}` : clientMessage;
        }
        if (clientMessage.mode === "replace") {
            return clientMessage.content;
        }
        // mode === "append"
        return base ? `${base}\n\n${clientMessage.content}` : clientMessage.content;
    }
}
