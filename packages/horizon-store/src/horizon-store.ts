// @pilotswarm/horizon-store — HorizonDB-backed EnhancedFactStore provider.
//
// DROP-IN: implements the full FactStore API with identical semantics, so it
// can replace PgFactStore anywhere a FactStore is expected. It ADDS:
//   - searchFacts (lexical BM25 / semantic / hybrid — facts store only)
//   - similarFacts (semantic kNN of a known fact; inaccessible anchor ≡ unknown)
//   - crawl tracking (readUncrawledFacts / markFactsCrawled — PRIVILEGED)
//   - the embedder lifecycle (configure/start/stop/status; restart-on-configure)
//
// The open knowledge graph is a SEPARATE provider — HorizonDBGraphStore in
// graph-store.ts (07 D2). This class implements EnhancedFactStore only.
//
// Layering (03-design §1): ALL relational + vector data access goes through
// stored procedures created by the numbered migrations — no inline SQL here
// (the 04 §6 M1 grep guard enforces it). Graph access goes through
// graph-queries.ts. df.* calls are durable-orchestration control, not data
// access.

import type {
    AccessContext, CrawledFactStamp, DeletedFactResult, DeletedFactsResult, DeleteFactInput, EmbedderLoopStatus, EmbedderStatus,
    EmbeddingEndpointConfig, EnhancedFactStore, FactRecord, FactsStatsRow,
    ReadFactsQuery, ScoredFact, SearchOpts, SearchResult, SimilarOpts,
    StoreFactInput, StoredFactResult,
} from "./types.js";
import type { HorizonFactsConfig } from "./config.js";
import { resolveConfig, buildPoolConfig } from "./config.js";
import { EmbeddingClient, toVectorLiteral } from "./embedding-client.js";
import { loadMigrations, runMigrations, HORIZON_FACTS_LOCK_SEED, hashSchemaName } from "./horizon-migrator.js";
import { assertFactExtensions, assertDurableHttpUsable } from "./preconditions.js";
import { ident } from "./sql-util.js";
import { withDbRetry } from "./db-retry.js";
import { buildLexicalQuery, namespacePrefix, fuseWeighted, type Candidate } from "./query-builder.js";

function computeScopeKey(key: string, shared: boolean, sessionId?: string | null): string {
    if (shared) return `shared:${key}`;
    if (!sessionId) throw new Error("Session-scoped facts require a sessionId.");
    return `session:${sessionId}:${key}`;
}

/** df-allow-list normalization: the Azure AI Foundry unified host is blocked
 * for df.http; the classic AOAI host points at the same deployment. */
export function toAllowlistedAzureHost(url: string): { url: string; rewritten: boolean } {
    try {
        const u = new URL(url);
        if (u.hostname.endsWith(".services.ai.azure.com")) {
            const sub = u.hostname.slice(0, -".services.ai.azure.com".length);
            u.hostname = `${sub}.openai.azure.com`;
            return { url: u.toString(), rewritten: true };
        }
    } catch { /* not a parseable URL — leave as-is */ }
    return { url, rewritten: false };
}

const EMBED_VAR_SUFFIXES = ["url", "model", "dim", "key", "keyhdr", "bearer", "inputfield", "timeout", "interval", "batch"] as const;
type EmbedVarSuffix = (typeof EMBED_VAR_SUFFIXES)[number];

export class HorizonDBFactStore implements EnhancedFactStore {
    private pool: any;
    private initialized = false;
    /** Snapshot of the configured endpoint (mirrors the durable vars). */
    private embedConfig?: EmbeddingEndpointConfig;
    private queryEmbedder?: EmbeddingClient;

    /** Capability descriptor (enhancedfactstore 07 §1.4) — HorizonDB always
     * backs multi-signal search (lexical works with no endpoint). `embedder`
     * reflects whether an embedding endpoint was provisioned at construction:
     * the durable in-DB embed loop only runs (and semantic/hybrid return
     * semantic hits) when one is configured. A store created without
     * `embedding` reports `embedder:false` so the runtime can gate the embedder
     * lifecycle on real configuration rather than a hardcoded `true`. */
    readonly capabilities: { search: boolean; embedder: boolean };

    private constructor(
        pool: any,
        private readonly cfg: Required<Pick<HorizonFactsConfig, "schema" | "graphName" | "embeddingDim">> & HorizonFactsConfig,
    ) {
        this.pool = pool;
        this.capabilities = { search: true, embedder: !!cfg.embedding };
    }

    static async create(config: Partial<HorizonFactsConfig> = {}): Promise<HorizonDBFactStore> {
        const cfg = resolveConfig(config);
        // Managed-identity / AAD token auth is not yet implemented in this
        // provider — it would require minting AAD tokens via @azure/identity in
        // a pg `password` callback, and the provider deliberately keeps its
        // runtime dependency surface to `pg` only (07 P2). Fail FAST and loud
        // rather than silently building a pool that ignores the request and
        // authenticates with whatever (if anything) the URL carries.
        if (cfg.useManagedIdentity) {
            throw new Error(
                "HorizonDBFactStore does not support managed-identity (AAD token) auth yet. " +
                "Provide a connection string with embedded credentials, or use the default " +
                "PgFactStore for managed-identity deployments. (enhancedfactstore 07 P5)",
            );
        }
        const { default: pg } = await import("pg");
        const pool = new pg.Pool(buildPoolConfig(cfg.connectionString, cfg.poolMax!));
        pool.on("error", (err: Error) => console.error("[horizon-facts] pool error (non-fatal):", err.message));
        return new HorizonDBFactStore(pool, cfg as any);
    }

    private get schema() { return this.cfg.schema!; }
    private get s() { return ident(this.schema); }

    // ─── lifecycle ────────────────────────────────────────────────────────────

    /**
     * Fail-fast (01 §5.5): verify every required extension is available —
     * itemized error otherwise — then apply the numbered migrations, then
     * verify df.http usability. When the config carries an embedding endpoint,
     * configure the embedder from it.
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;
        await assertFactExtensions(this.pool);
        await runMigrations(
            this.pool,
            this.schema,
            // Facts provider runs the facts migrations only — the 0003 AGE
            // bootstrap belongs to HorizonDBGraphStore (07 D2). graphName is
            // still passed for token validation; the filtered set excludes it.
            loadMigrations({
                schema: this.schema,
                graphName: this.cfg.graphName!,
                embeddingDim: this.cfg.embeddingDim,
            }).filter((m) => m.version !== "0003"),
            HORIZON_FACTS_LOCK_SEED,
        );
        await assertDurableHttpUsable(this.pool);
        this.initialized = true;
        if (this.cfg.embedding) {
            // Auto-start the eternal embed loop on init. configureEmbedder with
            // restartIfRunning:false refreshes the durable config vars WITHOUT
            // bouncing a loop another instance already started, and
            // startEmbedder is idempotent + advisory-locked, so repeated /
            // concurrent provider instantiations converge on exactly one
            // running loop per schema rather than creating duplicates.
            //
            // NON-FATAL (07 P5): the durable embedder is a best-effort enhancement.
            // If configure/start fails (endpoint unreachable, df.http hiccup,
            // transient lock contention), the store must still come up so the
            // worker boots — semantic/hybrid search simply degrades to lexical
            // until a later boot or an explicit configureEmbedder() succeeds.
            // `initialized` is already true above, so migrations are never re-run.
            try {
                await this.configureEmbedder(this.cfg.embedding, { restartIfRunning: false });
                await this.startEmbedder();
            } catch (err: any) {
                console.error(
                    "[horizon-facts] embedder auto-start failed (non-fatal; search degrades to lexical): " +
                    (err?.message || String(err)),
                );
            }
        }
    }

    async close(): Promise<void> {
        await this.pool.end();
    }

    // ─── base FactStore (drop-in; all access via procs) ──────────────────────

    async storeFact(input: StoreFactInput): Promise<StoredFactResult>;
    async storeFact(input: StoreFactInput[]): Promise<{ stored: number; facts: StoredFactResult[] }>;
    async storeFact(input: StoreFactInput | StoreFactInput[]): Promise<StoredFactResult | { stored: number; facts: StoredFactResult[] }> {
        const inputs = Array.isArray(input) ? input : [input];
        if (inputs.length === 0) return { stored: 0, facts: [] };
        const facts = inputs.map((input) => {
            const shared = input.shared === true;
            return {
                scopeKey: computeScopeKey(input.key, shared, input.sessionId),
                key: input.key,
                value: input.value,
                agentId: input.agentId ?? null,
                sessionId: input.sessionId ?? null,
                shared,
                tags: input.tags ?? [],
            };
        });
        await withDbRetry("facts_store", () => this.pool.query(
            `SELECT ${this.s}.facts_store($1::jsonb)`,
            [JSON.stringify(facts)],
        ));
        const storedFacts: StoredFactResult[] = facts.map((fact) => ({ key: fact.key, shared: fact.shared, stored: true }));
        const result = { stored: facts.length, facts: storedFacts };
        return Array.isArray(input) ? result : result.facts[0];
    }

    async readFacts(query: ReadFactsQuery, access?: AccessContext): Promise<{ count: number; facts: FactRecord[] }> {
        const keyPattern = query.keyPattern
            ? (query.keyPattern.includes("%") ? query.keyPattern : query.keyPattern.replaceAll("*", "%"))
            : null;
        const { rows } = await withDbRetry<{ rows: any[] }>("facts_read", () => this.pool.query(
            `SELECT * FROM ${this.s}.facts_read($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
                access?.readerSessionId ?? query.sessionId ?? null,
                access?.grantedSessionIds ?? [],
                access?.unrestricted === true,
                query.scope ?? "accessible",
                keyPattern,
                query.scopeKeys ?? null,
                query.tags?.length ? query.tags : null,
                query.agentId ?? null,
                Math.min(query.limit ?? 50, 1000),
            ],
        ));
        return { count: rows.length, facts: rows.map(mapFactRow) };
    }

    async deleteFact(input: DeleteFactInput & { pattern: true }): Promise<DeletedFactsResult>;
    async deleteFact(input: DeleteFactInput & { pattern?: false | undefined }): Promise<DeletedFactResult>;
    async deleteFact(input: DeleteFactInput): Promise<DeletedFactResult | DeletedFactsResult>;
    async deleteFact(input: DeleteFactInput): Promise<DeletedFactResult | DeletedFactsResult> {
        if (input.pattern === true) {
            const keyPattern = input.key?.includes("%") ? input.key : input.key?.replaceAll("*", "%");
            if (!keyPattern) throw new Error("deleteFact pattern mode requires key");
            const scope = input.scope ?? (input.shared === true ? "shared" : "session");
            const { rows } = await withDbRetry<{ rows: any[] }>("facts_delete", () => this.pool.query(
                `SELECT ${this.s}.facts_delete($1, $2, $3, $4, $5) AS deleted`,
                [keyPattern, true, scope, input.sessionId ?? null, input.unrestricted === true],
            ));
            return { keyPattern, scope, deleted: Number(rows[0]?.deleted ?? 0) };
        }
        const shared = input.shared === true;
        const scopeKey = computeScopeKey(input.key, shared, input.sessionId);
        const { rows } = await withDbRetry<{ rows: any[] }>("facts_delete", () => this.pool.query(
            `SELECT ${this.s}.facts_delete($1, $2, $3, $4, $5) AS deleted`, [scopeKey, false, null, null, false]));
        return { key: input.key, shared, deleted: Number(rows[0]?.deleted ?? 0) > 0 };
    }

    async deleteSessionFactsForSession(sessionId: string): Promise<number> {
        const { rows } = await withDbRetry<{ rows: any[] }>("facts_delete_session", () => this.pool.query(
            `SELECT ${this.s}.facts_delete_session($1) AS n`, [sessionId]));
        return Number(rows[0]?.n ?? 0);
    }

    private async stats(mode: "session" | "sessions" | "shared", sessionIds: string[]): Promise<FactsStatsRow[]> {
        const { rows } = await withDbRetry<{ rows: any[] }>("facts_stats", () => this.pool.query(
            `SELECT * FROM ${this.s}.facts_stats($1, $2)`, [mode, sessionIds]));
        return rows.map((r: any) => ({
            namespace: r.namespace,
            factCount: Number(r.fact_count),
            totalValueBytes: Number(r.total_value_bytes),
            oldestCreatedAt: r.oldest_created_at,
            newestUpdatedAt: r.newest_updated_at,
        }));
    }

    getSessionFactsStats(sessionId: string): Promise<FactsStatsRow[]> {
        return this.stats("session", [sessionId]);
    }
    getFactsStatsForSessions(sessionIds: string[]): Promise<FactsStatsRow[]> {
        return this.stats("sessions", sessionIds);
    }
    getSharedFactsStats(): Promise<FactsStatsRow[]> {
        return this.stats("shared", []);
    }

    // ─── enhanced retrieval (02 §3) ───────────────────────────────────────────

    async searchFacts(query: string, opts: SearchOpts = {}, access: AccessContext = {}): Promise<SearchResult> {
        const mode = opts.mode ?? "hybrid";
        if (mode !== "lexical" && mode !== "semantic" && mode !== "hybrid") {
            throw new Error(`searchFacts: unknown mode ${JSON.stringify(mode)} (no "graph" mode — use the graph API)`);
        }
        const limit = opts.limit ?? 20;
        const pool = opts.candidatePool ?? 50;

        const normalized = buildLexicalQuery(query);
        if (!normalized) return { count: 0, mode, facts: [] };   // defined empty (04 L4)

        const byKey = new Map<string, Candidate>();
        const records = new Map<string, FactRecord>();
        const upsert = (sk: string, sig: Partial<Candidate>, rec: FactRecord) => {
            const c = byKey.get(sk) ?? { scopeKey: sk };
            Object.assign(c, sig);
            byKey.set(sk, c);
            records.set(sk, rec);
        };

        // A zero weight disables its signal entirely (04 H2/H3: weight
        // overrides emulate the single mode — membership included, not just
        // ranking), and saves the fetch.
        const w = { lexical: opts.weights?.lexical ?? 1, semantic: opts.weights?.semantic ?? 1 };
        const doLexical = mode === "lexical" || (mode === "hybrid" && w.lexical !== 0);
        let doSemantic = mode === "semantic" || (mode === "hybrid" && w.semantic !== 0);

        // Hybrid-degrade (enhancedfactstore 07 P5 / HIGH#5): when no embedding
        // endpoint is configured, the semantic signal cannot run. For HYBRID
        // (the default mode) degrade gracefully to lexical-only instead of
        // throwing — a deployment with search but no embedder must still serve
        // facts_search. For an EXPLICIT `semantic` request we preserve the
        // clear error (the caller asked for something the store can't provide).
        if (doSemantic && !(await this.hasEmbedder())) {
            if (mode === "semantic") {
                throw new Error(
                    "semantic search requires a configured embedding endpoint — " +
                    "configure horizonEmbed / call configureEmbedder(endpoint) first, or use mode 'lexical'/'hybrid'.",
                );
            }
            doSemantic = false; // hybrid → lexical-only
        }

        if (doLexical) {
            for (const r of await this.lexicalCandidates(normalized, opts, access, pool)) {
                upsert(r.fact.scope_key, { lexical: r.score }, mapFactRow(r.fact));
            }
        }
        if (doSemantic) {
            for (const r of await this.semanticCandidates(query, opts, access, pool)) {
                upsert(r.fact.scope_key, { semantic: r.score }, mapFactRow(r.fact));
            }
        }

        const fused = fuseWeighted([...byKey.values()], opts.weights).slice(0, limit);
        const facts: ScoredFact[] = fused.map((f) => ({
            ...(records.get(f.scopeKey) as FactRecord),
            score: f.score,
            signals: f.signals,
        }));
        return { count: facts.length, mode, facts };
    }

    private aclParams(access: AccessContext, scope: ReadFactsQuery["scope"]): [string | null, string[], boolean, string] {
        return [
            access.readerSessionId ?? null,
            access.grantedSessionIds ?? [],
            access.unrestricted === true,
            scope ?? "accessible",
        ];
    }

    private async lexicalCandidates(query: string, opts: SearchOpts, access: AccessContext, poolN: number) {
        const { rows } = await withDbRetry<{ rows: any[] }>("facts_search_lexical", () => this.pool.query(
            `SELECT * FROM ${this.s}.facts_search_lexical($1, $2, $3, $4, $5, $6, $7, $8)`,
            [query, ...this.aclParams(access, opts.scope),
             namespacePrefix(opts.namespace), opts.tags?.length ? opts.tags : null, poolN],
        ));
        return rows.map((r: any) => ({ fact: r, score: Number(r.rank) }));
    }

    private async semanticCandidates(query: string, opts: SearchOpts, access: AccessContext, poolN: number) {
        const embedder = await this.requireQueryEmbedder();
        const vec = toVectorLiteral(await embedder.client.embed(query));
        const { rows } = await withDbRetry<{ rows: any[] }>("facts_search_semantic", () => this.pool.query(
            `SELECT * FROM ${this.s}.facts_search_semantic($1::vector, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [vec, embedder.model, ...this.aclParams(access, opts.scope),
             namespacePrefix(opts.namespace), opts.tags?.length ? opts.tags : null,
             opts.minSemanticScore ?? 0, poolN],
        ));
        return rows.map((r: any) => ({ fact: r, score: Number(r.sim) }));
    }

    async similarFacts(scopeKey: string, opts: SimilarOpts = {}, access: AccessContext = {}): Promise<SearchResult> {
        // The anchor is ACL-checked INSIDE the proc: an existing-but-inaccessible
        // anchor returns empty, byte-identical to an unknown key (01 §4.3).
        const model = this.embedConfig?.model ?? null;
        const { rows } = await withDbRetry<{ rows: any[] }>("facts_similar", () => this.pool.query(
            `SELECT * FROM ${this.s}.facts_similar($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [scopeKey, model, ...this.aclParams(access, "accessible"),
             namespacePrefix(opts.namespace), opts.minScore ?? 0, Math.max(1, Math.min(opts.k ?? 8, 100))],
        ));
        const facts: ScoredFact[] = rows.map((r: any) => ({
            ...mapFactRow(r), score: Number(r.sim), signals: { semantic: Number(r.sim) },
        }));
        return { count: facts.length, mode: "semantic", facts };
    }

    // ─── crawl tracking (02 §3a — PRIVILEGED harvester surface) ──────────────

    async readUncrawledFacts(opts: { namespace?: string; limit?: number; embeddedOnly?: boolean } = {}):
        Promise<{ count: number; facts: FactRecord[] }> {
        const { rows } = await withDbRetry<{ rows: any[] }>("facts_read_uncrawled", () => this.pool.query(
            `SELECT * FROM ${this.s}.facts_read_uncrawled($1, $2, $3)`,
            [namespacePrefix(opts.namespace), Math.min(opts.limit ?? 20, 500), opts.embeddedOnly ?? false],
        ));
        const facts = rows.map(mapFactRow);
        return { count: facts.length, facts };
    }

    async markFactsCrawled(stamps: CrawledFactStamp[]): Promise<{ marked: number; skipped: number }> {
        if (!Array.isArray(stamps) || stamps.length === 0) return { marked: 0, skipped: 0 };
        for (const st of stamps) {
            if (!st?.scopeKey) {
                throw new Error("markFactsCrawled: every stamp requires { scopeKey } (the receipt from readUncrawledFacts)");
            }
        }
        const { rows } = await withDbRetry<{ rows: any[] }>("facts_mark_crawled", () => this.pool.query(
            `SELECT * FROM ${this.s}.facts_mark_crawled($1::jsonb)`, [JSON.stringify(stamps)]));
        return { marked: Number(rows[0]?.marked ?? 0), skipped: Number(rows[0]?.skipped ?? 0) };
    }

    // ─── embedder lifecycle (02 §4) ──────────────────────────────────────────
    //
    // Config lives in durable variables (df.setvar), namespaced per schema.
    // pg_durable captures variables at df.start and they are immutable for the
    // run, so configureEmbedder RESTARTS a running loop to apply changes —
    // including key rotation (03-design §3).

    private varName(suffix: EmbedVarSuffix): string {
        return `hz_${this.schema}_${suffix}`;
    }

    private embedderLabel(kind: "batch" | "retry"): string {
        return `hz-embed-${kind}-cron:${this.schema}`;
    }

    private get legacyEmbedderLabel(): string {
        return `hz-embed-cron:${this.schema}`;
    }

    private get embedderLabels(): Record<"batch" | "retry", string> {
        return { batch: this.embedderLabel("batch"), retry: this.embedderLabel("retry") };
    }

    private async cancelRunningLabel(label: string, reason: string, exec: any = this.pool): Promise<void> {
        const { rows } = await exec.query(
            `SELECT id FROM df.instances
             WHERE label = $1 AND status IN ('pending', 'running')
             ORDER BY created_at DESC`,
            [label],
        );
        for (const row of rows) {
            await exec.query(`SELECT df.cancel($1, $2)`, [row.id, reason]);
        }
    }

    /**
     * Serialize embedder start/restart across processes. Two providers
     * initializing the same schema concurrently must not both df.start (the
     * design is ONE loop per schema, label hz-embed-cron:<schema>). Reuses the
     * migrator's advisory-lock pattern: hold a session-level lock on a single
     * checked-out client for the whole critical section, then release it.
     */
    private async withEmbedderLock<T>(fn: (client: any) => Promise<T>): Promise<T> {
        const lockKey = hashSchemaName(`hz-embed-cron:${this.schema}`, HORIZON_FACTS_LOCK_SEED);
        const client = await this.pool.connect();
        try {
            await client.query("SELECT pg_advisory_lock($1)", [lockKey]);
            return await fn(client);
        } finally {
            await client.query("SELECT pg_advisory_unlock($1)", [lockKey]).catch(() => {});
            client.release();
        }
    }

    async configureEmbedder(
        endpoint: EmbeddingEndpointConfig,
        opts: { restartIfRunning?: boolean } = {},
    ): Promise<EmbedderStatus> {
        const restartIfRunning = opts.restartIfRunning ?? true;
        if (!endpoint?.url || !endpoint?.model) {
            throw new Error("configureEmbedder requires { url, model, dim }");
        }
        if (Math.trunc(endpoint.dim) !== this.cfg.embeddingDim) {
            throw new Error(
                `configureEmbedder: endpoint dim ${endpoint.dim} != vector(${this.cfg.embeddingDim}) column. ` +
                `A dimension change requires a column migration + full re-embed (01 §5.2).`,
            );
        }
        const { url } = toAllowlistedAzureHost(endpoint.url);
        const vars: Record<EmbedVarSuffix, string | null> = {
            url,
            model: endpoint.model,
            dim: String(Math.trunc(endpoint.dim)),
            key: endpoint.apiKey ?? null,            // ⚠ plaintext at rest — accepted incubation TODO (01 §5.4)
            keyhdr: endpoint.apiKeyHeader ?? "api-key",
            bearer: endpoint.bearer ? "true" : "false",
            inputfield: endpoint.inputField ?? "input",
            timeout: String(Math.max(1, Math.ceil((endpoint.timeoutMs ?? 30_000) / 1000))),
            interval: null,                          // written by startEmbedder
            batch: null,
        };
        for (const suffix of EMBED_VAR_SUFFIXES) {
            const v = vars[suffix];
            if (v === null) continue;
            await this.pool.query(`SELECT df.setvar($1, $2)`, [this.varName(suffix), v]);
        }
        this.embedConfig = { ...endpoint, url };
        this.queryEmbedder = undefined;

        // Restart-on-configure: a running loop never sees new config otherwise
        // (pg_durable captures vars at df.start). Skipped when restartIfRunning
        // is false — the auto-start path on initialize() must not bounce a loop
        // another instance is already running.
        if (!restartIfRunning) return this.embedderStatus();
        return this.withEmbedderLock(async (client) => {
            const st = await this.embedderStatus(client);
            if (!st.running) return st;
            for (const loop of st.loops ?? []) {
                if (loop.running && loop.instanceId) await client.query(`SELECT df.cancel($1, $2)`, [loop.instanceId, "reconfigured"]);
            }
            await this.cancelRunningLabel(this.legacyEmbedderLabel, "reconfigured", client);
            const interval = await this.getvar("interval");
            const batch = await this.getvar("batch");
            return this.startLoops(Number(interval ?? 5), Number(batch ?? 128), client);
        });
    }

    async startEmbedder(opts: { intervalSeconds?: number; batch?: number } = {}): Promise<EmbedderStatus> {
        const intervalSeconds = opts.intervalSeconds ?? 5;
        const batch = opts.batch ?? 128;
        if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) {
            throw new Error(`intervalSeconds must be a positive integer, got ${intervalSeconds}`);
        }
        const url = this.embedConfig?.url ?? (await this.getvar("url"));
        if (!url) {
            throw new Error("startEmbedder: embedder not configured — call configureEmbedder(endpoint) first.");
        }
        // Advisory-locked check-then-start so concurrent callers can't both
        // df.start: re-check status UNDER the lock and only start if no loop is
        // already running (E3 idempotent).
        return this.withEmbedderLock(async (client) => {
            const existing = await this.embedderStatus(client);
            if (existing.running) return existing;
            return this.startLoops(intervalSeconds, batch, client);
        });
    }

    private async startLoops(intervalSeconds: number, batch: number, exec: any = this.pool): Promise<EmbedderStatus> {
        await exec.query(`SELECT df.setvar($1, $2)`, [this.varName("interval"), String(intervalSeconds)]);
        await exec.query(`SELECT df.setvar($1, $2)`, [this.varName("batch"), String(batch)]);
        const labels = this.embedderLabels;
        await this.cancelRunningLabel(this.legacyEmbedderLabel, "superseded by two-loop embedder", exec);
        await exec.query(
            `SELECT df.start(${this.s}.embedder_workflow($1, $2, $3), $4, NULL) AS iid`,
            ["batch", intervalSeconds, batch, labels.batch],
        );
        await exec.query(
            `SELECT df.start(${this.s}.embedder_workflow($1, $2, $3), $4, NULL) AS iid`,
            ["retry", intervalSeconds, 1, labels.retry],
        );
        return this.embedderStatus(exec);
    }

    async stopEmbedder(reason = "stopped by host"): Promise<EmbedderStatus> {
        const st = await this.embedderStatus();
        for (const loop of st.loops ?? []) {
            if (loop.running && loop.instanceId) {
                await this.pool.query(`SELECT df.cancel($1, $2)`, [loop.instanceId, reason]);
            }
        }
        await this.cancelRunningLabel(this.legacyEmbedderLabel, reason);
        return this.embedderStatus();
    }

    async embedderStatus(exec: any = this.pool): Promise<EmbedderStatus> {
        const labels = this.embedderLabels;
        const loops: EmbedderLoopStatus[] = [];
        for (const name of ["batch", "retry"] as const) {
            const { rows } = await exec.query(
                `SELECT id, status FROM df.instances
                 WHERE label = $1 ORDER BY created_at DESC LIMIT 1`,
                [labels[name]],
            );
            const row = rows[0];
            const status = row ? String(row.status) : undefined;
            const running = status === "pending" || status === "running";
            loops.push({ name, label: labels[name], running, instanceId: row ? String(row.id) : undefined, status });
        }
        const running = loops.every((loop) => loop.running);
        return {
            running,
            instanceId: loops.find((loop) => loop.name === "batch")?.instanceId,
            status: running ? "running" : loops.map((loop) => `${loop.name}:${loop.status ?? "missing"}`).join(","),
            loops,
        };
    }

    private async getvar(suffix: EmbedVarSuffix): Promise<string | null> {
        const { rows } = await this.pool.query(`SELECT df.getvar($1) AS v`, [this.varName(suffix)]);
        return rows[0]?.v ?? null;
    }

    /** Query-time embedding client, resolved from the configured endpoint
     * (memory snapshot → durable vars). Throws when semantic search is
     * attempted with no endpoint configured (02 §6). */
    /**
     * Whether an embedding endpoint is available to this store — either the
     * in-memory snapshot or the durable config vars written by configureEmbedder
     * (possibly by another process). Non-throwing; used by searchFacts to decide
     * whether HYBRID can include the semantic signal or must degrade to lexical.
     */
    private async hasEmbedder(): Promise<boolean> {
        if (this.embedConfig || this.queryEmbedder) return true;
        const [url, model, dim] = await Promise.all([
            this.getvar("url"), this.getvar("model"), this.getvar("dim"),
        ]);
        return !!(url && model && dim);
    }

    private async requireQueryEmbedder(): Promise<{ client: EmbeddingClient; model: string }> {
        if (!this.queryEmbedder) {
            let cfg = this.embedConfig;
            if (!cfg) {
                const [url, model, dim, key, keyhdr, bearer, inputfield, timeout] = await Promise.all([
                    this.getvar("url"), this.getvar("model"), this.getvar("dim"), this.getvar("key"),
                    this.getvar("keyhdr"), this.getvar("bearer"), this.getvar("inputfield"), this.getvar("timeout"),
                ]);
                if (url && model && dim) {
                    cfg = {
                        url, model, dim: Number(dim),
                        apiKey: key ?? undefined,
                        apiKeyHeader: keyhdr ?? undefined,
                        bearer: bearer === "true",
                        inputField: inputfield ?? undefined,
                        timeoutMs: timeout ? Number(timeout) * 1000 : undefined,
                    };
                    this.embedConfig = cfg;
                }
            }
            if (!cfg) {
                throw new Error("semantic search requires a configured embedding endpoint — call configureEmbedder(endpoint) first.");
            }
            this.queryEmbedder = new EmbeddingClient(cfg);
        }
        return { client: this.queryEmbedder, model: this.embedConfig!.model };
    }

    // ─── GraphStore lives in graph-store.ts (separate provider, 07 D2) ───────
}

// ─── row mapping ─────────────────────────────────────────────────────────────

function mapFactRow(r: any): FactRecord {
    return {
        scopeKey: r.scope_key,
        key: r.key, value: r.value, agentId: r.agent_id ?? null, sessionId: r.session_id ?? null,
        shared: !!r.shared, tags: r.tags ?? [], createdAt: r.created_at, updatedAt: r.updated_at,
    };
}
