/**
 * PilotSwarmManagementClient — runtime/session fleet management.
 *
 * Provides public APIs for listing sessions, renaming, cancelling,
 * deleting, model listing, session dumps, and status watching.
 *
 * This is the management surface for TUI and admin tools.
 * It replaces direct usage of private client internals, raw duroxide
 * client handles, and raw CMS catalog handles.
 *
 * @module
 */

import type { PilotSwarmSessionStatus } from "./types.js";
import type { SessionCatalogProvider } from "./cms.js";
import { PgSessionCatalogProvider } from "./cms.js";
import { SessionDumper } from "./session-dumper.js";
import { loadModelProviders, type ModelProviderRegistry, type ModelDescriptor } from "./model-providers.js";

// duroxide is CommonJS — use createRequire for ESM compatibility
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SqliteProvider, PostgresProvider, Client } = require("duroxide");

const DEFAULT_DUROXIDE_SCHEMA = "duroxide";

// ─── Types ───────────────────────────────────────────────────────

/** Merged view of a session for management UIs. */
export interface PilotSwarmSessionView {
    sessionId: string;
    title?: string;
    /** Live status from orchestration customStatus (idle, running, waiting, etc.) */
    status: PilotSwarmSessionStatus;
    /** Duroxide orchestration runtime status (Running, Completed, Failed, Terminated). */
    orchestrationStatus?: string;
    createdAt: number;
    updatedAt?: number;
    iterations?: number;
    parentSessionId?: string;
    isSystem?: boolean;
    model?: string;
    error?: string;
    waitReason?: string;
    /** customStatusVersion for change tracking. */
    statusVersion?: number;
}

/** Model summary for UI display. */
export interface ModelSummary {
    qualifiedName: string;
    providerId: string;
    providerType: string;
    modelName: string;
    description?: string;
    cost?: string;
}

/** Status change result from watchSessionStatus. */
export interface SessionStatusChange {
    customStatus: any;
    customStatusVersion: number;
    orchestrationStatus?: string;
}

/** Options for PilotSwarmManagementClient. */
export interface PilotSwarmManagementClientOptions {
    /** Store URL (postgres:// or sqlite://). */
    store: string;
    /** PostgreSQL schema for duroxide tables. Default: "duroxide". */
    duroxideSchema?: string;
    /** PostgreSQL schema for CMS tables. Default: "copilot_sessions". */
    cmsSchema?: string;
    /** Path to model_providers.json. Auto-discovers if not set. */
    modelProvidersPath?: string;
}

// ─── Management Client ──────────────────────────────────────────

export class PilotSwarmManagementClient {
    private config: PilotSwarmManagementClientOptions;
    private _catalog: SessionCatalogProvider | null = null;
    private _duroxideClient: any = null;
    private _modelProviders: ModelProviderRegistry | null = null;
    private _started = false;

    constructor(options: PilotSwarmManagementClientOptions) {
        this.config = options;
    }

    // ─── Lifecycle ───────────────────────────────────────────

    async start(): Promise<void> {
        if (this._started) return;
        const store = this.config.store;

        // Create duroxide client
        let provider: any;
        if (store === "sqlite::memory:") provider = SqliteProvider.inMemory();
        else if (store.startsWith("sqlite://")) provider = SqliteProvider.open(store);
        else if (store.startsWith("postgres://") || store.startsWith("postgresql://")) {
            provider = await PostgresProvider.connectWithSchema(
                store,
                this.config.duroxideSchema ?? DEFAULT_DUROXIDE_SCHEMA,
            );
        } else {
            throw new Error(`Unsupported store URL: ${store}`);
        }
        this._duroxideClient = new Client(provider);

        // Create CMS catalog
        if (store.startsWith("postgres://") || store.startsWith("postgresql://")) {
            this._catalog = await PgSessionCatalogProvider.create(store, this.config.cmsSchema);
            await this._catalog.initialize();
        }

        // Load model providers
        this._modelProviders = loadModelProviders(this.config.modelProvidersPath);

        this._started = true;
    }

    async stop(): Promise<void> {
        if (this._catalog) {
            try { await this._catalog.close(); } catch {}
            this._catalog = null;
        }
        this._duroxideClient = null;
        this._started = false;
    }

    // ─── Session Listing ─────────────────────────────────────

    /**
     * List all sessions with merged CMS + orchestration state.
     * Returns a ready-to-render view model.
     *
     * **Optimized path**: reads entirely from CMS (single SQL query).
     * Live status is kept up-to-date by activity-level writeback in
     * the runTurn activity (session-proxy). For real-time status of a
     * single session, use getSession() which still hits duroxide.
     */
    async listSessions(): Promise<PilotSwarmSessionView[]> {
        this._ensureStarted();

        // Single CMS query — no duroxide fan-out
        const cmsSessions = await this._catalog!.listSessions();

        return cmsSessions.map((row) => {
            const liveStatus: PilotSwarmSessionStatus =
                (row.state as PilotSwarmSessionStatus) || "pending";

            return {
                sessionId: row.sessionId,
                title: row.title ?? undefined,
                status: liveStatus,
                orchestrationStatus: undefined, // not available in CMS-only path
                createdAt: row.createdAt.getTime(),
                updatedAt: row.updatedAt?.getTime(),
                iterations: row.currentIteration ?? 0,
                parentSessionId: row.parentSessionId ?? undefined,
                isSystem: row.isSystem || undefined,
                model: row.model ?? undefined,
                error: row.lastError ?? undefined,
                waitReason: row.waitReason ?? undefined,
                statusVersion: undefined,
            };
        });
    }

    /**
     * Get a single session view by ID.
     */
    async getSession(sessionId: string): Promise<PilotSwarmSessionView | null> {
        this._ensureStarted();
        const row = await this._catalog!.getSession(sessionId);
        if (!row) return null;

        const orchId = `session-${sessionId}`;
        let orchStatus = "Unknown";
        let createdAt = row.createdAt.getTime();
        let customStatus: any = {};
        let statusVersion = 0;

        try {
            const [info, status] = await Promise.all([
                this._duroxideClient.getInstanceInfo(orchId),
                this._duroxideClient.getStatus(orchId),
            ]);
            orchStatus = info?.status || "Unknown";
            if (info?.createdAt) createdAt = info.createdAt;
            statusVersion = status?.customStatusVersion || 0;
            if (status?.customStatus) {
                try {
                    customStatus = typeof status.customStatus === "string"
                        ? JSON.parse(status.customStatus)
                        : status.customStatus;
                } catch {}
            }
        } catch {}

        let liveStatus: PilotSwarmSessionStatus = customStatus.status
            ?? (row.state as PilotSwarmSessionStatus)
            ?? "pending";
        if (orchStatus === "Completed") liveStatus = "completed";
        if (orchStatus === "Failed") liveStatus = "failed";

        return {
            sessionId: row.sessionId,
            title: row.title ?? undefined,
            status: liveStatus,
            orchestrationStatus: orchStatus,
            createdAt,
            updatedAt: row.updatedAt?.getTime(),
            iterations: customStatus.iteration ?? row.currentIteration ?? 0,
            parentSessionId: row.parentSessionId ?? undefined,
            isSystem: row.isSystem || undefined,
            model: row.model ?? undefined,
            error: customStatus.error ?? row.lastError ?? undefined,
            waitReason: customStatus.waitReason,
            statusVersion,
        };
    }

    // ─── Session Actions ─────────────────────────────────────

    /**
     * Rename a session. Updates the title in CMS.
     */
    async renameSession(sessionId: string, title: string): Promise<void> {
        this._ensureStarted();
        await this._catalog!.updateSession(sessionId, { title: title.slice(0, 60) });
    }

    /**
     * Cancel a session's orchestration.
     * Refuses to cancel system sessions.
     */
    async cancelSession(sessionId: string, reason?: string): Promise<void> {
        this._ensureStarted();
        const session = await this._catalog!.getSession(sessionId);
        if (session?.isSystem) {
            throw new Error("Cannot cancel system session");
        }
        const orchId = `session-${sessionId}`;
        await this._duroxideClient.cancelInstance(orchId, reason ?? "Cancelled by management client");
        // Sync terminal state to CMS so listSessions() (CMS-only) reflects it
        await this._catalog!.updateSession(sessionId, {
            state: "failed",
            lastError: reason ?? "Cancelled by management client",
            waitReason: null,
        });
    }

    /**
     * Delete a session: cancel orchestration + soft-delete from CMS.
     * Refuses to delete system sessions.
     */
    async deleteSession(sessionId: string, reason?: string): Promise<void> {
        this._ensureStarted();
        const session = await this._catalog!.getSession(sessionId);
        if (session?.isSystem) {
            throw new Error("Cannot delete system session");
        }

        // Set terminal state in CMS before soft-delete so any last read picks it up
        await this._catalog!.updateSession(sessionId, {
            state: "failed",
            lastError: reason ?? "Deleted by management client",
            waitReason: null,
        });

        // CMS soft-delete
        await this._catalog!.softDeleteSession(sessionId);

        // Duroxide: delete instance (best effort)
        try {
            await this._duroxideClient.deleteInstance(`session-${sessionId}`, true);
        } catch {}
    }

    // ─── Status Watching ─────────────────────────────────────

    /**
     * Get current orchestration status for a session.
     * Returns parsed customStatus + orchestration status.
     */
    async getSessionStatus(sessionId: string): Promise<SessionStatusChange> {
        this._ensureStarted();
        const orchId = `session-${sessionId}`;
        const status = await this._duroxideClient.getStatus(orchId);
        let customStatus: any = null;
        if (status.customStatus) {
            try {
                customStatus = typeof status.customStatus === "string"
                    ? JSON.parse(status.customStatus)
                    : status.customStatus;
            } catch {}
        }
        return {
            customStatus,
            customStatusVersion: status.customStatusVersion || 0,
            orchestrationStatus: status.status,
        };
    }

    /**
     * Wait for a session's status to change.
     * Blocks until customStatusVersion advances past `afterVersion`,
     * or until `timeoutMs` elapses.
     */
    async waitForStatusChange(
        sessionId: string,
        afterVersion: number,
        pollIntervalMs?: number,
        timeoutMs?: number,
    ): Promise<SessionStatusChange> {
        this._ensureStarted();
        const orchId = `session-${sessionId}`;
        const result = await this._duroxideClient.waitForStatusChange(
            orchId,
            afterVersion,
            pollIntervalMs ?? 200,
            timeoutMs ?? 30_000,
        );
        let customStatus: any = null;
        if (result.customStatus) {
            try {
                customStatus = typeof result.customStatus === "string"
                    ? JSON.parse(result.customStatus)
                    : result.customStatus;
            } catch {}
        }
        return {
            customStatus,
            customStatusVersion: result.customStatusVersion || 0,
            orchestrationStatus: result.status,
        };
    }

    /**
     * Send a prompt message to a session's orchestration.
     */
    async sendMessage(sessionId: string, prompt: string): Promise<void> {
        this._ensureStarted();
        const orchId = `session-${sessionId}`;
        await this._duroxideClient.enqueueEvent(
            orchId,
            "messages",
            JSON.stringify({ prompt }),
        );
    }

    /**
     * Send an answer to a pending question from a session.
     */
    async sendAnswer(sessionId: string, answer: string): Promise<void> {
        this._ensureStarted();
        const orchId = `session-${sessionId}`;
        await this._duroxideClient.enqueueEvent(
            orchId,
            "messages",
            JSON.stringify({ answer, wasFreeform: true }),
        );
    }

    /**
     * Send a command to a session's orchestration.
     */
    async sendCommand(sessionId: string, command: { cmd: string; id: string; args?: Record<string, unknown> }): Promise<void> {
        this._ensureStarted();
        const orchId = `session-${sessionId}`;
        await this._duroxideClient.enqueueEvent(
            orchId,
            "messages",
            JSON.stringify({ type: "cmd", ...command }),
        );
    }

    // ─── Models ──────────────────────────────────────────────

    /**
     * List all available models across all configured providers.
     */
    listModels(): ModelSummary[] {
        if (!this._modelProviders) return [];
        return this._modelProviders.allModels.map((m: ModelDescriptor) => ({
            qualifiedName: m.qualifiedName,
            providerId: m.providerId,
            providerType: m.providerType,
            modelName: m.modelName,
            description: m.description,
            cost: m.cost,
        }));
    }

    /**
     * Get models grouped by provider for display.
     */
    getModelsByProvider(): Array<{ providerId: string; type: string; models: ModelSummary[] }> {
        if (!this._modelProviders) return [];
        return this._modelProviders.getModelsByProvider().map(g => ({
            providerId: g.providerId,
            type: g.type,
            models: g.models.map((m: ModelDescriptor) => ({
                qualifiedName: m.qualifiedName,
                providerId: m.providerId,
                providerType: m.providerType,
                modelName: m.modelName,
                description: m.description,
                cost: m.cost,
            })),
        }));
    }

    /**
     * Get the default model name, if configured.
     */
    getDefaultModel(): string | undefined {
        return this._modelProviders?.defaultModel;
    }

    /**
     * Normalize a model reference to qualified `provider:model` format.
     */
    normalizeModel(ref?: string): string | undefined {
        return this._modelProviders?.normalize(ref);
    }

    // ─── Session Dump ────────────────────────────────────────

    /**
     * Dump a session and all its descendants to Markdown.
     */
    async dumpSession(sessionId: string): Promise<string> {
        this._ensureStarted();
        const dumper = new SessionDumper(this._catalog!);
        return dumper.dump(sessionId);
    }

    // ─── Internal ────────────────────────────────────────────

    private _ensureStarted(): void {
        if (!this._started) {
            throw new Error("ManagementClient not started. Call start() first.");
        }
    }
}
