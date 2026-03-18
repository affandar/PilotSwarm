import { CopilotClient, type CopilotSession, type Tool } from "@github/copilot-sdk";
import { ManagedSession } from "./managed-session.js";
import type { SessionStateStore } from "./session-store.js";
import { SESSION_STATE_MISSING_PREFIX, type ManagedSessionConfig, type SerializableSessionConfig } from "./types.js";
import type { ModelProviderRegistry } from "./model-providers.js";
import { composeSystemPrompt, extractPromptContent } from "./prompt-layering.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_SESSION_STATE_DIR = path.join(os.homedir(), ".copilot", "session-state");

/** Worker-level defaults — applied to every session. */
export interface WorkerDefaults {
    frameworkBasePrompt?: string;
    appDefaultPrompt?: string;
    /** Backward-compatible alias for older code paths/tests. */
    systemMessage?: string;
    /** Raw prompt lookup for named and system agents bound directly to sessions. */
    agentPromptLookup?: Record<string, { prompt: string; kind: "app-agent" | "app-system-agent" | "pilotswarm-system-agent" }>;
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
    /** Turn timeout in milliseconds. 0 or undefined = no timeout. */
    turnTimeoutMs?: number;
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
    private sessionStore: SessionStateStore | null = null;
    /** In-memory configs with non-serializable fields (tools, hooks). */
    private sessionConfigs = new Map<string, ManagedSessionConfig>();
    /** Worker-level tool registry — shared reference from PilotSwarmWorker. */
    private toolRegistry = new Map<string, Tool<any>>();
    /** Worker-level defaults for building blocks. */
    private workerDefaults: WorkerDefaults;
    /** Base directory for local session state files. */
    private sessionStateDir: string;

    constructor(
        private githubToken?: string,
        sessionStore?: SessionStateStore | null,
        workerDefaults?: WorkerDefaults,
        sessionStateDir?: string,
    ) {
        this.sessionStore = sessionStore ?? null;
        this.workerDefaults = workerDefaults ?? {};
        this.sessionStateDir = sessionStateDir ?? DEFAULT_SESSION_STATE_DIR;
    }

    /** Store full config (with tools/hooks) for a session. Called by PilotSwarmClient. */
    setConfig(sessionId: string, config: ManagedSessionConfig): void {
        this.sessionConfigs.set(sessionId, config);
    }

    /** Get a human-readable model summary for LLM tool consumption. */
    getModelSummary(): string | undefined {
        return this.workerDefaults.modelProviders?.getModelSummaryForLLM();
    }

    /**
     * Normalize a model reference against the configured registry.
     * Throws for unknown models. When `requireQualified` is true, the caller
     * must provide the exact `provider:model` string rather than a bare alias.
     */
    normalizeModelRef(model?: string, options?: { requireQualified?: boolean }): string | undefined {
        const registry = this.workerDefaults.modelProviders;
        if (!registry) return model;

        const ref = model || registry.defaultModel;
        if (!ref) return undefined;

        const normalized = registry.normalize(ref);
        if (!normalized) {
            throw new Error(
                `Unknown model "${ref}". Call list_available_models and choose an exact configured provider:model value.`,
            );
        }
        if (options?.requireQualified && ref !== normalized) {
            throw new Error(
                `Model "${ref}" is not allowed. Use the exact provider:model value returned by list_available_models, for example "${normalized}".`,
            );
        }
        return normalized;
    }

    /** Set the worker-level tool registry. Called by PilotSwarmWorker. */
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

    private _missingSessionStateError(sessionId: string, turnIndex: number, detail?: string): Error {
        const suffix = detail ? ` ${detail}` : "";
        return new Error(
            `${SESSION_STATE_MISSING_PREFIX} turn ${turnIndex} expected resumable Copilot session state for ${sessionId}, ` +
            `but none was found in memory, on disk, or in the session store.${suffix}`,
        );
    }

    private async _resetSessionState(sessionId: string): Promise<void> {
        const existing = this.sessions.get(sessionId);
        if (existing) {
            try {
                await existing.destroy();
            } catch {}
            this.sessions.delete(sessionId);
        }

        try {
            const client = await this.ensureClient();
            await client.deleteSession(sessionId);
        } catch {}

        const sessionDir = path.join(this.sessionStateDir, sessionId);
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }

        if (this.sessionStore) {
            try {
                await this.sessionStore.delete(sessionId);
            } catch {}
        }
    }

    /**
     * Get existing session or create/resume one.
     * Merges: worker defaults → serializable config (from client) → in-memory config (tools/hooks).
     */
    async getOrCreate(
        sessionId: string,
        serializableConfig: SerializableSessionConfig,
        options?: { turnIndex?: number },
    ): Promise<ManagedSession> {
        const turnIndex = options?.turnIndex;
        // Resolve tools: merge per-session (setConfig) + registry (toolNames)
        const storedConfig = this.sessionConfigs.get(sessionId);
        const resolvedTools = this._resolveTools(storedConfig, serializableConfig);

        const config: ManagedSessionConfig = {
            ...storedConfig,
            ...serializableConfig,
            tools: resolvedTools.length > 0 ? resolvedTools : undefined,
            hooks: storedConfig?.hooks,
            turnTimeoutMs: this.workerDefaults.turnTimeoutMs,
        };

        const client = await this.ensureClient();
        const sessionDir = path.join(this.sessionStateDir, sessionId);

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
        const systemMessage = this._buildSystemMessage(config);

        // Resolve model: config.model may be qualified (provider:model) or bare.
        // The SDK needs the bare model name; the provider config is separate.
        // Fall back to registry default if no model specified.
        const registry = this.workerDefaults.modelProviders;
        const effectiveModel = this.normalizeModelRef(config.model) || "";
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
            configDir: path.dirname(this.sessionStateDir),
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

        // 1. Check if already in memory (warm) — update config in case
        //    tools were registered after the session was first created.
        const existing = this.sessions.get(sessionId);
        if (existing) {
            if (turnIndex === 0) {
                console.warn(
                    `[SessionManager] stale in-memory Copilot session found for turn 0 (${sessionId}); ` +
                    `discarding it and creating a fresh session.`,
                );
                await this._resetSessionState(sessionId);
            } else {
                existing.updateConfig(config);
                return existing;
            }
        }

        const localExists = fs.existsSync(sessionDir);
        const storedExists = this.sessionStore ? await this.sessionStore.exists(sessionId).catch(() => false) : false;

        if (turnIndex === 0) {
            if (localExists || storedExists) {
                console.warn(
                    `[SessionManager] stale persisted Copilot session found for turn 0 (${sessionId}); ` +
                    `discarding it and creating a fresh session.`,
                );
                await this._resetSessionState(sessionId);
            }

            copilotSession = await client.createSession(sessionConfig);
        } else if (turnIndex != null && turnIndex > 0) {
            if (fs.existsSync(sessionDir)) {
                copilotSession = await client.resumeSession(sessionId, sessionConfig);
            } else if (this.sessionStore && storedExists) {
                await this.sessionStore.hydrate(sessionId);
                if (!fs.existsSync(sessionDir)) {
                    throw this._missingSessionStateError(sessionId, turnIndex, " Hydration completed but no local session directory was restored.");
                }
                copilotSession = await client.resumeSession(sessionId, sessionConfig);
            } else {
                throw this._missingSessionStateError(sessionId, turnIndex);
            }
        } else {
            // Backward-compatible permissive path for older orchestration versions.
            if (fs.existsSync(sessionDir)) {
                copilotSession = await client.resumeSession(sessionId, sessionConfig);
            } else if (this.sessionStore) {
                try {
                    await this.sessionStore.hydrate(sessionId);
                    if (fs.existsSync(sessionDir)) {
                        copilotSession = await client.resumeSession(sessionId, sessionConfig);
                    } else {
                        copilotSession = await client.createSession(sessionConfig);
                    }
                } catch {
                    copilotSession = await client.createSession(sessionConfig);
                }
            } else {
                copilotSession = await client.createSession(sessionConfig);
            }
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
     * Dehydrate a session: destroy in memory, then persist state to the configured session store.
     *
     * The Copilot SDK's disconnect path preserves session state on disk, so we
     * first release the in-memory session and then archive the resulting local
     * session files into the configured session store.
     *
     * If destroy() fails (e.g., Copilot connection already disposed), we retry
     * by re-creating the session from local files and destroying again.
     * After MAX_RETRIES, we still attempt the session-store write and throw a
     * clear error if that also fails.
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
                    const sessionDir = path.join(this.sessionStateDir, sessionId);
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

        // Phase 2: Persist to the session store (always attempt, even if destroy failed)
        if (this.sessionStore) {
            try {
                await this.sessionStore.dehydrate(sessionId, { reason });
            } catch (storeErr: any) {
                if (lastError) {
                    throw new Error(
                        `Session ${sessionId} is not dehydratable: ` +
                        `destroy failed (${lastError.message}), ` +
                        `session-store persistence also failed (${storeErr.message}). ` +
                        `Session state may be lost on worker recycle.`
                    );
                }
                throw storeErr;
            }
        }

        if (lastError) {
            console.warn(
                `[SessionManager] destroy() failed for ${sessionId} after ${MAX_RETRIES} attempts ` +
                `(${lastError.message}), but session-store persistence succeeded. Session state is preserved.`
            );
        }
    }

    /**
     * Hydrate session state from the configured session store to local disk.
     * The next getOrCreate() will detect local files and resume.
     */
    async hydrate(sessionId: string): Promise<void> {
        if (this.sessionStore) {
            await this.sessionStore.hydrate(sessionId);
        }
    }

    /**
     * Return true when the next turn must hydrate state from the session store.
     * This supports abrupt worker loss and direct worker-side dehydration.
     */
    async needsHydration(sessionId: string): Promise<boolean> {
        if (!this.sessionStore) return false;
        if (this.sessions.has(sessionId)) return false;

        const sessionDir = path.join(this.sessionStateDir, sessionId);
        if (fs.existsSync(sessionDir)) return false;

        try {
            return await this.sessionStore.exists(sessionId);
        } catch {
            return false;
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
     * Checkpoint session state without destroying the session or
     * releasing affinity. Used for crash resilience — session stays warm.
     */
    async checkpoint(sessionId: string): Promise<void> {
        if (this.sessionStore) {
            await this.sessionStore.checkpoint(sessionId);
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
     * Build the final system message from:
     * 1. embedded PilotSwarm framework base
     * 2. app-level default instructions
     * 3. bound agent prompt (for named/system sessions)
     * 4. caller/runtime context
     */
    private _buildSystemMessage(
        config: SerializableSessionConfig,
    ): string | undefined {
        const frameworkBase = this.workerDefaults.frameworkBasePrompt ?? this.workerDefaults.systemMessage;
        const runtimeContext = extractPromptContent(config.systemMessage);
        const boundAgentName = config.boundAgentName;
        const layerKind = config.promptLayering?.kind ?? (boundAgentName ? "app-agent" : undefined);
        const activeAgentPrompt = boundAgentName
            ? this.workerDefaults.agentPromptLookup?.[boundAgentName]?.prompt
            : undefined;

        if (!layerKind || !activeAgentPrompt) {
            return composeSystemPrompt({
                frameworkBase,
                appDefault: this.workerDefaults.appDefaultPrompt,
                runtimeContext,
            });
        }

        return composeSystemPrompt({
            frameworkBase,
            appDefault: layerKind === "pilotswarm-system-agent"
                ? undefined
                : this.workerDefaults.appDefaultPrompt,
            activeAgentPrompt,
            runtimeContext,
        });
    }
}
