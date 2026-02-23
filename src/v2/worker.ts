import { SessionManager } from "./session-manager.js";
import { SessionBlobStore } from "../blob-store.js";
import { registerActivities } from "./session-proxy.js";
import { durableSessionOrchestration } from "./orchestration.js";
import { PgSessionCatalogProvider } from "./cms.js";
import type { SessionCatalogProvider } from "./cms.js";
import type { DurableCopilotWorkerOptions, ManagedSessionConfig } from "./types.js";

// duroxide is CommonJS — use createRequire for ESM compatibility
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { SqliteProvider, PostgresProvider, Runtime } = require("duroxide");

const ORCHESTRATION_NAME = "durable-session-v2";
const DUROXIDE_SCHEMA = "duroxide";

/**
 * DurableCopilotWorker — runs activities and orchestrations.
 *
 * Owns:
 *   - SessionManager (creates/resumes CopilotSessions, holds tools/hooks)
 *   - duroxide Runtime (dispatches activities + orchestrations)
 *   - BlobStore (optional, for session dehydration/hydration)
 *
 * In single-process mode, pass this worker to DurableCopilotClient's
 * constructor so they share the database provider and the client can
 * forward tool/hook registrations.
 */
export class DurableCopilotWorker {
    private config: DurableCopilotWorkerOptions & { waitThreshold: number };
    private sessionManager: SessionManager;
    private blobStore: SessionBlobStore | null = null;
    private runtime: any = null;
    private _provider: any = null;
    private _catalog: SessionCatalogProvider | null = null;
    private _started = false;

    constructor(options: DurableCopilotWorkerOptions) {
        this.config = {
            ...options,
            waitThreshold: options.waitThreshold ?? 30,
        };

        if (options.blobConnectionString) {
            this.blobStore = new SessionBlobStore(
                options.blobConnectionString,
                options.blobContainer ?? "copilot-sessions",
            );
        }

        this.sessionManager = new SessionManager(
            options.githubToken,
            this.blobStore,
        );
    }

    // ─── Public API ──────────────────────────────────────────

    /** Store full config (with tools/hooks) for a session. */
    setSessionConfig(sessionId: string, config: ManagedSessionConfig): void {
        this.sessionManager.setConfig(sessionId, config);
    }

    /** Whether blob storage is configured. */
    get blobEnabled(): boolean {
        return this.blobStore !== null;
    }

    /** Whether the worker runtime is running. */
    get isStarted(): boolean {
        return this._started;
    }

    /** @internal — shared with co-located DurableCopilotClient. */
    get provider(): any {
        return this._provider;
    }

    /** Session catalog (CMS) — available when store is PostgreSQL. */
    get catalog(): SessionCatalogProvider | null {
        return this._catalog;
    }

    // ─── Lifecycle ───────────────────────────────────────────

    async start(): Promise<void> {
        if (this._started) return;

        this._provider = await this._createProvider();

        // Initialize CMS catalog for PostgreSQL stores
        const store = this.config.store;
        if (store.startsWith("postgres://") || store.startsWith("postgresql://")) {
            try {
                this._catalog = await PgSessionCatalogProvider.create(store);
                await this._catalog.initialize();
            } catch (err) {
                console.error("[DurableCopilotWorker] CMS initialization failed:", err);
                this._catalog = null;
            }
        }

        this.runtime = new Runtime(this._provider, {
            dispatcherPollIntervalMs: 10,
            workerLockTimeoutMs: 10_000,
            logLevel: this.config.logLevel ?? "error",
            maxSessionsPerRuntime: this.config.maxSessionsPerRuntime ?? 50,
            sessionIdleTimeoutMs: this.config.sessionIdleTimeoutMs ?? 3_600_000,
            workerNodeId: this.config.workerNodeId,
        });

        registerActivities(
            this.runtime,
            this.sessionManager,
            this.blobStore,
            this.config.githubToken,
            this._catalog,
        );

        this.runtime.registerOrchestration(ORCHESTRATION_NAME, durableSessionOrchestration);

        this.runtime.start().catch((err: any) => {
            console.error("[DurableCopilotWorker] Runtime error:", err);
        });
        this._started = true;

        await new Promise(r => setTimeout(r, 200));
    }

    async stop(): Promise<void> {
        if (this.runtime) {
            await this.runtime.shutdown(5000);
            this.runtime = null;
        }
        await this.sessionManager.shutdown();
        if (this._catalog) {
            try { await this._catalog.close(); } catch {}
            this._catalog = null;
        }
        this._provider = null;
        this._started = false;
    }

    /** Dehydrate all active sessions, then stop. */
    async gracefulShutdown(): Promise<void> {
        if (this.blobStore) {
            const ids = this.sessionManager.activeSessionIds();
            if (ids.length > 0) {
                console.error(`[DurableCopilotWorker] Dehydrating ${ids.length} sessions...`);
                await Promise.allSettled(
                    ids.map(id => this.sessionManager.dehydrate(id, "shutdown").catch(() => {})),
                );
            }
        }
        await this.stop();
    }

    /** Destroy a session on this worker. */
    async destroySession(sessionId: string): Promise<void> {
        await this.sessionManager.destroySession(sessionId);
    }

    // ─── Internal ────────────────────────────────────────────

    private async _createProvider(): Promise<any> {
        const store = this.config.store;
        if (store === "sqlite::memory:") return SqliteProvider.inMemory();
        if (store.startsWith("sqlite://")) return SqliteProvider.open(store);
        if (store.startsWith("postgres://") || store.startsWith("postgresql://")) {
            return PostgresProvider.connectWithSchema(store, DUROXIDE_SCHEMA);
        }
        throw new Error(`Unsupported store URL: ${store}`);
    }
}
