import type { ApiClient } from "pilotswarm-sdk/api";
import type {
    FactStore, EnhancedFactStore, FactRecord, StoreFactInput, StoredFactResult, ReadFactsQuery,
    DeleteFactInput, DeletedFactResult, DeletedFactsResult, AccessContext, FactsStatsRow,
    FactsTombstoneStats, SetFactsCrawledInput, ForcePurgeFactsInput, SearchOpts, SimilarOpts,
    SearchResult, FactsCapabilities, EmbedderStatus,
} from "../facts-store.js";
import { EnhancedFactsUnsupportedError } from "../facts-store.js";

/**
 * `FactStore` over the PilotSwarm Web API.
 *
 * Implements the same interface the runtime programs against, so any consumer
 * typed as `FactStore` (the MCP server, SDK tools) works unchanged over the
 * API — no direct database connection. Constructed via
 * {@link createWebFactStore}, which reads `/facts/capabilities` first and
 * returns the enhanced subclass when the deployment supports search.
 *
 * Access control is server-side: `AccessContext` arguments are accepted for
 * interface compatibility but ignored on the wire — the server derives access
 * from the authenticated principal. Crawler/sweeper methods (`readUncrawledFacts`,
 * `setFactsCrawled`, `purgeExpiredFacts`, `deleteSessionFactsForSession`) are
 * in-cluster machinery, not exposed over the API, and throw here.
 */
export class WebFactStore implements FactStore {
    protected readonly api: ApiClient;

    constructor(api: ApiClient) {
        this.api = api;
    }

    async initialize(): Promise<void> {
        // No-op: the server owns store lifecycle. Present for interface parity.
    }

    async close(): Promise<void> {
        // No-op: the ApiClient is owned by the caller / MCP context.
    }

    storeFact(input: StoreFactInput): Promise<StoredFactResult>;
    storeFact(input: StoreFactInput[]): Promise<{ stored: number; facts: StoredFactResult[] }>;
    async storeFact(input: StoreFactInput | StoreFactInput[]): Promise<any> {
        return this.api.call("storeFact", { input });
    }

    async readFacts(query: ReadFactsQuery, _access?: AccessContext): Promise<{ count: number; facts: FactRecord[] }> {
        return this.api.call("readFacts", { ...query });
    }

    deleteFact(input: DeleteFactInput & { pattern: true }): Promise<DeletedFactsResult>;
    deleteFact(input: DeleteFactInput & { pattern?: false | undefined }): Promise<DeletedFactResult>;
    async deleteFact(input: DeleteFactInput): Promise<DeletedFactResult | DeletedFactsResult> {
        return this.api.call("deleteFact", { input });
    }

    async getSessionFactsStats(sessionId: string): Promise<FactsStatsRow[]> {
        const result = await this.api.call("getSessionFactsStats", { sessionId });
        return result?.rows ?? result ?? [];
    }

    async getFactsStatsForSessions(_sessionIds: string[]): Promise<FactsStatsRow[]> {
        // No direct multi-session stats op; the tree-stats surface covers the
        // spawn-tree case. Not needed by remote callers today.
        throw new EnhancedFactsUnsupportedError("getFactsStatsForSessions (web)");
    }

    async getSharedFactsStats(): Promise<FactsStatsRow[]> {
        const result = await this.api.call("getSharedFactsStats");
        return result?.rows ?? result ?? [];
    }

    async getFactsTombstoneStats(ttlSeconds?: number): Promise<FactsTombstoneStats> {
        return this.api.call("getFactsTombstoneStats", { ttlSeconds });
    }

    // ── Crawler/sweeper machinery — not exposed over the API ──────────
    async readUncrawledFacts(): Promise<{ count: number; facts: FactRecord[] }> {
        throw new EnhancedFactsUnsupportedError("readUncrawledFacts (web)");
    }
    async setFactsCrawled(_input: SetFactsCrawledInput): Promise<{ affected: number; skipped: number }> {
        throw new EnhancedFactsUnsupportedError("setFactsCrawled (web)");
    }
    async purgeExpiredFacts(): Promise<number> {
        throw new EnhancedFactsUnsupportedError("purgeExpiredFacts (web)");
    }
    async deleteSessionFactsForSession(): Promise<number> {
        throw new EnhancedFactsUnsupportedError("deleteSessionFactsForSession (web)");
    }

    // ── Admin operational (server enforces the admin role) ────────────
    async forcePurgeFacts(input: ForcePurgeFactsInput): Promise<number> {
        return this.api.call("forcePurgeFacts", { input });
    }
}

/** Enhanced variant, present only when the deployment advertises search. */
export class WebEnhancedFactStore extends WebFactStore implements EnhancedFactStore {
    readonly capabilities: FactsCapabilities;

    constructor(api: ApiClient, capabilities: FactsCapabilities) {
        super(api);
        this.capabilities = capabilities;
    }

    async searchFacts(query: string, opts?: SearchOpts, _access?: AccessContext): Promise<SearchResult> {
        return this.api.call("searchFacts", { query, opts });
    }

    async similarFacts(scopeKey: string, opts?: SimilarOpts, _access?: AccessContext): Promise<SearchResult> {
        return this.api.call("similarFacts", { scopeKey, opts });
    }

    async configureEmbedder(): Promise<EmbedderStatus> {
        // configureEmbedder carries an embedding endpoint (with secrets) and is
        // a worker-side concern; not exposed. start/stop/status are.
        throw new EnhancedFactsUnsupportedError("configureEmbedder (web)");
    }

    async startEmbedder(opts?: { intervalSeconds?: number; batch?: number }): Promise<EmbedderStatus> {
        return this.api.call("startFactsEmbedder", { intervalSeconds: opts?.intervalSeconds, batch: opts?.batch });
    }

    async stopEmbedder(reason?: string): Promise<EmbedderStatus> {
        return this.api.call("stopFactsEmbedder", { reason });
    }

    async embedderStatus(): Promise<EmbedderStatus> {
        const st = await this.api.call("getEmbedderStatus");
        return { running: Boolean(st?.running), instanceId: st?.instanceId, status: st?.status };
    }
}

/** Facts capabilities as reported by the deployment. */
export interface WebFactsCapabilities extends FactsCapabilities {
    graph: boolean;
}

/**
 * Build a `FactStore` (or `EnhancedFactStore`) over the Web API. Reads
 * `/facts/capabilities` so `isEnhancedFactStore(store)` is accurate — the
 * remote equivalent of the PgFactStore-vs-HorizonDBFactStore distinction.
 */
export async function createWebFactStore(api: ApiClient): Promise<FactStore> {
    const caps = (await api.call("factsCapabilities")) as WebFactsCapabilities;
    if (caps?.search) {
        return new WebEnhancedFactStore(api, { search: Boolean(caps.search), embedder: Boolean(caps.embedder) });
    }
    return new WebFactStore(api);
}
