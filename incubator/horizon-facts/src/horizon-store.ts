// @incubator/horizon-facts — HorizonDB-backed EnhancedFactStore adapter.
//
// DROP-IN: implements the full FactStore API (storeFact/readFacts/deleteFact/
// stats/…) with identical semantics, so it can replace PgFactStore anywhere a
// FactStore is expected. It ADDS the enhanced retrieval methods (searchFacts/
// relatedFacts/lineageFacts) and the open-graph crawler interface — all of
// which are additive and optional.
//
// The adapter is intentionally THIN: pure decisions live in graph-model.ts and
// query-builder.ts; this file only issues parameterized SQL and AGE Cypher.

import type {
    AccessContext, DeleteFactInput, EnhancedFactStore, EntityAssertion, EntityHit,
    EntityQuery, FactRecord, FactsStatsRow, GraphCrawlerInterface, LineageOpts,
    ReadFactsQuery, RelAssertion, RelHit, RelQuery, RelRef, EntityRef, RelatedOpts,
    ScoredFact, SearchOpts, SearchResult, StoreFactInput, SubGraph,
} from "./types.js";
import type { HorizonFactsConfig, EmbeddingEndpointConfig } from "./config.js";
import { resolveConfig } from "./config.js";
import { EmbeddingClient, toVectorLiteral } from "./embedding-client.js";
import { setupSchema, prepareAgeSession } from "./migrations.js";
import { setupHttpEmbedding, type HttpEmbeddingCapability } from "./http-embedding.js";
import { ident, cypherStr, cypherNum, cypherStrList } from "./sql-util.js";
import {
    entityKey as makeEntityKey, predicateKey as makePredicateKey, mergeAliases,
    validateAssertion, decideEdgeMerge,
} from "./graph-model.js";
import { buildWebsearchQuery, namespacePrefix, fuseWeighted, type Candidate } from "./query-builder.js";

function computeScopeKey(key: string, shared: boolean, sessionId?: string | null): string {
    if (shared) return `shared:${key}`;
    if (!sessionId) throw new Error("Session-scoped facts require a sessionId.");
    return `session:${sessionId}:${key}`;
}

function namespaceOf(key: string): FactsStatsRow["namespace"] {
    const head = key.split("/")[0];
    if (head === "skills" || head === "asks" || head === "intake" || head === "config") return head;
    return "(other)";
}

interface AclClause { sql: string; params: unknown[]; }

/** Lifecycle state of the provider's background embedding generator. */
export interface EmbedderStatus {
    /** True while the durable embedder loop is pending/running. */
    running: boolean;
    /** The pg_durable instance id of the embedder loop, when one exists. */
    instanceId?: string;
    /** Raw pg_durable status (pending/running/completed/cancelled/failed). */
    status?: string;
}

export class HorizonFactStore implements EnhancedFactStore, GraphCrawlerInterface {
    private pool: any;
    private initialized = false;
    private readonly embedder?: EmbeddingClient;
    private httpEmbedding?: HttpEmbeddingCapability;

    private constructor(
        pool: any,
        private readonly cfg: Required<Pick<HorizonFactsConfig, "schema" | "graphName">> & HorizonFactsConfig,
    ) {
        this.pool = pool;
        if (cfg.embedding) this.embedder = new EmbeddingClient(cfg.embedding);
    }

    static async create(config: Partial<HorizonFactsConfig> = {}): Promise<HorizonFactStore> {
        const cfg = resolveConfig(config);
        const { default: pg } = await import("pg");
        const pool = new pg.Pool({ connectionString: cfg.connectionString, max: cfg.poolMax });
        pool.on("error", (err: Error) => console.error("[horizon-facts] pool error (non-fatal):", err.message));
        return new HorizonFactStore(pool, cfg as any);
    }

    private get schema() { return this.cfg.schema!; }
    private get graph() { return this.cfg.graphName!; }

    // ─── lifecycle ──────────────────────────────────────────────────────────

    async initialize(): Promise<void> {
        if (this.initialized) return;
        await setupSchema(this.pool, {
            schema: this.schema,
            graphName: this.graph,
            embeddingDim: this.cfg.embedding?.dim ?? 1536,
            enableSemantic: !!this.cfg.embedding,
            annIndex: this.cfg.annIndex ?? "auto",
        });
        if (this.cfg.embedding) {
            this.httpEmbedding = await setupHttpEmbedding(this.pool, this.schema, this.cfg.embedding);
        }
        this.initialized = true;
    }

    /** Whether the in-DB df.http embedding pipeline is installed on this cluster. */
    httpEmbeddingCapability(): HttpEmbeddingCapability | undefined {
        return this.httpEmbedding;
    }

    async close(): Promise<void> {
        await this.pool.end();
    }

    // ─── base FactStore (drop-in) ─────────────────────────────────────────────

    async storeFact(input: StoreFactInput): Promise<{ key: string; shared: boolean; stored: true }> {
        const shared = input.shared === true;
        const scopeKey = computeScopeKey(input.key, shared, input.sessionId);
        const s = ident(this.schema);
        await this.pool.query(
            `INSERT INTO ${s}.facts (scope_key, key, value, agent_id, session_id, shared, transient, tags, updated_at)
             VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, now())
             ON CONFLICT (scope_key) DO UPDATE SET
                value = EXCLUDED.value, agent_id = EXCLUDED.agent_id, tags = EXCLUDED.tags,
                shared = EXCLUDED.shared, updated_at = now()`,
            [scopeKey, input.key, JSON.stringify(input.value), input.agentId ?? null,
             input.sessionId ?? null, shared, !shared, input.tags ?? []],
        );
        return { key: input.key, shared, stored: true };
    }

    private aclClause(query: ReadFactsQuery, access: AccessContext | undefined, startIdx: number): AclClause {
        if (access?.unrestricted) return { sql: "TRUE", params: [] };
        const reader = access?.readerSessionId ?? query.sessionId ?? null;
        const granted = access?.grantedSessionIds ?? [];
        const scope = query.scope ?? "accessible";
        let i = startIdx;
        switch (scope) {
            case "shared":
                return { sql: `shared = TRUE`, params: [] };
            case "session":
                return { sql: `(shared = FALSE AND session_id = $${i})`, params: [reader] };
            case "descendants":
                return { sql: `(shared = FALSE AND session_id = ANY($${i}))`, params: [granted] };
            case "accessible":
            default:
                return {
                    sql: `(shared = TRUE OR session_id = $${i} OR session_id = ANY($${i + 1}))`,
                    params: [reader, granted],
                };
        }
    }

    async readFacts(query: ReadFactsQuery, access?: AccessContext): Promise<{ count: number; facts: FactRecord[] }> {
        const s = ident(this.schema);
        const where: string[] = [];
        const params: unknown[] = [];
        let i = 1;

        const acl = this.aclClause(query, access, i);
        where.push(acl.sql);
        params.push(...acl.params);
        i += acl.params.length;

        if (query.keyPattern) {
            const pat = query.keyPattern.includes("%") ? query.keyPattern : query.keyPattern.replaceAll("*", "%");
            where.push(`key LIKE $${i++}`);
            params.push(pat);
        }
        if (query.tags && query.tags.length > 0) {
            where.push(`tags @> $${i++}`);
            params.push(query.tags);
        }
        if (query.agentId) {
            where.push(`agent_id = $${i++}`);
            params.push(query.agentId);
        }
        const limit = Math.min(query.limit ?? 100, 1000);
        const { rows } = await this.pool.query(
            `SELECT scope_key, key, value, agent_id, session_id, shared, tags, created_at, updated_at
             FROM ${s}.facts WHERE ${where.join(" AND ")}
             ORDER BY updated_at DESC LIMIT $${i}`,
            [...params, limit],
        );
        return { count: rows.length, facts: rows.map(mapFactRow) };
    }

    async deleteFact(input: DeleteFactInput): Promise<{ key: string; shared: boolean; deleted: boolean }> {
        const shared = input.shared === true;
        const scopeKey = computeScopeKey(input.key, shared, input.sessionId);
        const s = ident(this.schema);
        const { rowCount } = await this.pool.query(`DELETE FROM ${s}.facts WHERE scope_key = $1`, [scopeKey]);
        return { key: input.key, shared, deleted: (rowCount ?? 0) > 0 };
    }

    async deleteSessionFactsForSession(sessionId: string): Promise<number> {
        const s = ident(this.schema);
        const { rowCount } = await this.pool.query(
            `DELETE FROM ${s}.facts WHERE shared = FALSE AND session_id = $1`, [sessionId]);
        return rowCount ?? 0;
    }

    private async statsForWhere(where: string, params: unknown[]): Promise<FactsStatsRow[]> {
        const s = ident(this.schema);
        const { rows } = await this.pool.query(
            `SELECT key, value, created_at, updated_at FROM ${s}.facts WHERE ${where}`, params);
        const buckets = new Map<string, FactsStatsRow>();
        for (const r of rows) {
            const ns = namespaceOf(r.key);
            const bytes = Buffer.byteLength(JSON.stringify(r.value ?? null));
            const cur = buckets.get(ns) ?? {
                namespace: ns as FactsStatsRow["namespace"], factCount: 0, totalValueBytes: 0,
                oldestCreatedAt: null, newestUpdatedAt: null,
            };
            cur.factCount += 1;
            cur.totalValueBytes += bytes;
            cur.oldestCreatedAt = !cur.oldestCreatedAt || r.created_at < cur.oldestCreatedAt ? r.created_at : cur.oldestCreatedAt;
            cur.newestUpdatedAt = !cur.newestUpdatedAt || r.updated_at > cur.newestUpdatedAt ? r.updated_at : cur.newestUpdatedAt;
            buckets.set(ns, cur);
        }
        return [...buckets.values()];
    }

    getSessionFactsStats(sessionId: string): Promise<FactsStatsRow[]> {
        return this.statsForWhere(`shared = FALSE AND session_id = $1`, [sessionId]);
    }
    getFactsStatsForSessions(sessionIds: string[]): Promise<FactsStatsRow[]> {
        return this.statsForWhere(`shared = FALSE AND session_id = ANY($1)`, [sessionIds]);
    }
    getSharedFactsStats(): Promise<FactsStatsRow[]> {
        return this.statsForWhere(`shared = TRUE`, []);
    }

    // ─── embedding maintenance ────────────────────────────────────────────────

    // ─── embedding lifecycle (provider-internal generator) ────────────────────
    //
    // Embedding generation is an INTERNAL capability of this provider, not part
    // of the EnhancedFactStore contract. Callers never trigger embedding directly
    // or wait on any df instance — they write facts and observe the result (the
    // vector appears / semantic search returns the fact). The only public surface
    // is the lifecycle: configureEmbedder / startEmbedder / stopEmbedder /
    // embedderStatus. In production the generator is the durable pg_durable cron
    // (df.loop → CALL embed_new_facts_durable → df.http per fact). The two methods
    // below (_embedPendingNode / _embedNewFactsInDbOnce) are NOT production paths;
    // they exist only as sanity checks that we call the embedding endpoint the
    // right way, and are exercised by the provider's own integration tests.

    /**
     * Stable pg_durable label for this schema's embedder loop instance.
     * @internal
     */
    private get embedderLabel(): string {
        return `hz-embed-cron:${this.schema}`;
    }

    /**
     * Set or replace the embedding endpoint config for this store (writes the
     * single-row embedding_config table the df.http procedure reads, with the
     * df.http allow-list host rewrite applied). Safe to call before or while the
     * embedder is running; the running loop picks up the new config on its next
     * tick. Requires the in-DB df.http pipeline to be installed.
     */
    async configureEmbedder(endpoint: EmbeddingEndpointConfig): Promise<HttpEmbeddingCapability> {
        this.httpEmbedding = await setupHttpEmbedding(this.pool, this.schema, endpoint);
        return this.httpEmbedding;
    }

    /**
     * Start the durable background embedder: a pg_durable instance that, every
     * `intervalSeconds`, embeds any facts whose content changed since their last
     * embedding (embedding IS NULL OR last_embedded_hash <> content_hash). The
     * cadence is a fixed interval via df.sleep (sub-minute granularity, which
     * cron expressions can't express), wrapped in df.loop so it self-perpetuates
     * durably:
     *
     *   df.loop( df.seq( df.sleep(intervalSeconds), df.sql("CALL embed_new_facts_durable") ) )
     *
     * The loop is pure scheduling; the per-fact df.http embedding lives in the
     * procedure it CALLs. Idempotent: if a non-terminal instance for this schema
     * already exists, returns it. Requires the in-DB df.http pipeline.
     */
    async startEmbedder(opts: { intervalSeconds?: number; batch?: number } = {}): Promise<EmbedderStatus> {
        const intervalSeconds = opts.intervalSeconds ?? 5;
        const batch = opts.batch ?? 128;
        if (!this.httpEmbedding?.inDbHttp) {
            throw new Error(
                "startEmbedder requires the in-DB df.http pipeline; " +
                `httpEmbeddingCapability(): ${JSON.stringify(this.httpEmbedding ?? null)}`);
        }
        if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) {
            throw new Error(`intervalSeconds must be a positive integer, got ${intervalSeconds}`);
        }
        const existing = await this.embedderStatus();
        if (existing.running) return existing;

        const s = ident(this.schema);
        const call = `CALL ${s}.embed_new_facts_durable(${Number(batch)}, NULL)`;
        await this.pool.query(
            `SELECT df.start(
                 df.loop(df.seq(df.sleep($1::bigint), df.sql($2))),
                 $3, NULL) AS iid`,
            [intervalSeconds, call, this.embedderLabel]);
        return this.embedderStatus();
    }

    /**
     * Stop the background embedder for this schema (if running). Returns the
     * resulting status (running:false). No-op if already stopped.
     */
    async stopEmbedder(reason = "stopped by host"): Promise<EmbedderStatus> {
        const st = await this.embedderStatus();
        if (st.running && st.instanceId) {
            await this.pool.query(`SELECT df.cancel($1, $2)`, [st.instanceId, reason]);
        }
        return this.embedderStatus();
    }

    /**
     * Current embedder lifecycle state, derived from the most recent loop
     * instance with this schema's label. `running` is true while the durable
     * loop is pending/running; terminal statuses (completed/cancelled/failed)
     * report running:false.
     */
    async embedderStatus(): Promise<EmbedderStatus> {
        const { rows } = await this.pool.query(
            `SELECT id, status FROM df.instances
             WHERE label = $1 ORDER BY created_at DESC LIMIT 1`,
            [this.embedderLabel]);
        if (rows.length === 0) return { running: false };
        const status = String(rows[0].status);
        const running = status === "pending" || status === "running";
        return { running, instanceId: String(rows[0].id), status };
    }

    // ─── embedding endpoint sanity checks (provider tests only, NOT production) ─

    /**
     * SANITY CHECK — not a production path. Embeds pending facts host-side via
     * Node fetch, sending the EXACT request the in-DB df.http procedure sends
     * (same URL + headers + body, read from the stored embedding_config row).
     * Its only purpose is to validate, against a Node-reachable endpoint (e.g.
     * the local test stub), that the request shape we hand to df.http is correct.
     * The production embedder is the durable df.http cron; never call this in a
     * real deployment.
     * @internal
     */
    async _embedPendingNode(batch = 128): Promise<number> {
        const s = ident(this.schema);
        const { rows: cfgRows } = await this.pool.query(
            `SELECT url, model, dim, api_key, key_header, input_field, timeout_seconds
             FROM ${s}.embedding_config WHERE id = 1`);
        if (cfgRows.length === 0) {
            throw new Error("_embedPendingNode: embedding_config not set; call configureEmbedder first.");
        }
        const c = cfgRows[0];
        const { rows } = await this.pool.query(
            `SELECT id, key, value, content_hash FROM ${s}.facts
             WHERE embedding IS NULL OR last_embedded_hash IS DISTINCT FROM content_hash
             ORDER BY id LIMIT $1`, [batch]);
        if (rows.length === 0) return 0;

        // Build the IDENTICAL request df.http sends (see http-embedding.ts):
        //   headers = { <key_header>: api_key, content-type: application/json }
        //   body    = { <input_field>: <text>, model: <model> }
        for (const r of rows) {
            const text = textForEmbedding(r);
            const headers: Record<string, string> = { "content-type": "application/json" };
            if (c.api_key) headers[c.key_header || "api-key"] = c.api_key;
            const body = JSON.stringify({ [c.input_field || "input"]: text, model: c.model });

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), (c.timeout_seconds ?? 30) * 1000);
            let res: Response;
            try {
                res = await fetch(c.url, { method: "POST", headers, body, signal: controller.signal });
            } finally {
                clearTimeout(timer);
            }
            if (!res.ok) {
                const detail = await res.text().catch(() => "");
                throw new Error(`embedding endpoint ${res.status}: ${detail.slice(0, 200)}`);
            }
            const json: any = await res.json();
            const emb = json?.data?.[0]?.embedding;
            if (!Array.isArray(emb)) throw new Error("embedding endpoint returned no data[0].embedding[]");
            if (emb.length !== c.dim) {
                throw new Error(`embedding dim mismatch: got ${emb.length}, expected ${c.dim}`);
            }
            await this.pool.query(
                `UPDATE ${s}.facts SET embedding = $1::vector, embedded_at = now(),
                    embedding_model = $2, last_embedded_hash = content_hash WHERE id = $3`,
                [toVectorLiteral(emb), c.model, r.id]);
        }
        return rows.length;
    }

    /**
     * SANITY CHECK — not a production path. One-shot synchronous trigger of the
     * durable in-DB procedure embed_new_facts_durable (the same procedure the
     * background cron CALLs each tick), returning the number embedded. Used by
     * provider tests to verify the df.http path works without waiting on the
     * loop cadence. Production uses startEmbedder (the cron), never this.
     * @internal
     */
    async _embedNewFactsInDbOnce(batch = 128): Promise<number> {
        const s = ident(this.schema);
        const { rows } = await this.pool.query(
            `CALL ${s}.embed_new_facts_durable($1, NULL)`, [batch]);
        return Number(rows[0]?.p_count ?? 0);
    }

    // ─── enhanced retrieval ───────────────────────────────────────────────────

    async searchFacts(query: string, opts: SearchOpts = {}, access: AccessContext = {}): Promise<SearchResult> {
        const mode = opts.mode ?? "hybrid";
        const limit = opts.limit ?? 20;
        const pool = opts.candidatePool ?? 50;

        const doLexical = mode === "lexical" || mode === "hybrid";
        const doSemantic = (mode === "semantic" || mode === "hybrid") && !!this.embedder;

        const byKey = new Map<string, Candidate>();
        const records = new Map<string, FactRecord>();
        const upsert = (sk: string, sig: Partial<Candidate>, rec: FactRecord) => {
            const c = byKey.get(sk) ?? { scopeKey: sk };
            Object.assign(c, sig);
            byKey.set(sk, c);
            records.set(sk, rec);
        };

        if (doLexical) {
            for (const r of await this.lexicalCandidates(query, opts, access, pool)) {
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

    private aclForSearch(access: AccessContext, scope: ReadFactsQuery["scope"], startIdx: number): AclClause {
        return this.aclClause({ scope }, access, startIdx);
    }

    private async lexicalCandidates(query: string, opts: SearchOpts, access: AccessContext, poolN: number) {
        const s = ident(this.schema);
        const tsq = buildWebsearchQuery(query);
        if (!tsq) return [];
        const params: unknown[] = [tsq];
        let i = 2;
        const acl = this.aclForSearch(access, opts.scope, i);
        params.push(...acl.params); i += acl.params.length;
        const extra: string[] = [];
        const nsPrefix = namespacePrefix(opts.namespace);
        if (nsPrefix) { extra.push(`key LIKE $${i++}`); params.push(nsPrefix); }
        if (opts.tags?.length) { extra.push(`tags @> $${i++}`); params.push(opts.tags); }
        params.push(poolN);
        const { rows } = await this.pool.query(
            `SELECT *, ts_rank(search_tsv, websearch_to_tsquery('english', $1)) AS rank
             FROM ${s}.facts
             WHERE search_tsv @@ websearch_to_tsquery('english', $1) AND ${acl.sql}
             ${extra.length ? "AND " + extra.join(" AND ") : ""}
             ORDER BY rank DESC LIMIT $${i}`, params);
        return rows.map((r: any) => ({ fact: r, score: Number(r.rank) }));
    }

    private async semanticCandidates(query: string, opts: SearchOpts, access: AccessContext, poolN: number) {
        if (!this.embedder) return [];
        const s = ident(this.schema);
        const vec = toVectorLiteral(await this.embedder.embed(query));
        const params: unknown[] = [vec];
        let i = 2;
        const acl = this.aclForSearch(access, opts.scope, i);
        params.push(...acl.params); i += acl.params.length;
        const extra: string[] = [];
        const nsPrefix = namespacePrefix(opts.namespace);
        if (nsPrefix) { extra.push(`key LIKE $${i++}`); params.push(nsPrefix); }
        if (opts.tags?.length) { extra.push(`tags @> $${i++}`); params.push(opts.tags); }
        params.push(poolN);
        const { rows } = await this.pool.query(
            `SELECT *, 1 - (embedding <=> $1::vector) AS sim
             FROM ${s}.facts
             WHERE embedding IS NOT NULL AND ${acl.sql}
             ${extra.length ? "AND " + extra.join(" AND ") : ""}
             ORDER BY embedding <=> $1::vector ASC LIMIT $${i}`, params);
        const min = opts.minSemanticScore ?? 0;
        return rows.map((r: any) => ({ fact: r, score: Number(r.sim) }))
                   .filter((r: any) => r.score >= min);
    }

    async relatedFacts(scopeKey: string, opts: RelatedOpts = {}, access: AccessContext = {}): Promise<SearchResult> {
        const s = ident(this.schema);
        const k = opts.k ?? 8;
        const min = opts.minScore ?? 0.75;
        const params: unknown[] = [scopeKey];
        let i = 2;
        const acl = this.aclForSearch(access, "accessible", i);
        params.push(...acl.params); i += acl.params.length;
        params.push(min, k);
        const { rows } = await this.pool.query(
            `WITH anchor AS (SELECT embedding FROM ${s}.facts WHERE scope_key = $1)
             SELECT f.*, 1 - (f.embedding <=> a.embedding) AS sim
             FROM ${s}.facts f, anchor a
             WHERE f.scope_key <> $1 AND f.embedding IS NOT NULL AND a.embedding IS NOT NULL
               AND ${acl.sql} AND (1 - (f.embedding <=> a.embedding)) >= $${i}
             ORDER BY f.embedding <=> a.embedding ASC LIMIT $${i + 1}`, params);
        const facts: ScoredFact[] = rows.map((r: any) => ({
            ...mapFactRow(r), score: Number(r.sim), signals: { semantic: Number(r.sim) },
        }));
        return { count: facts.length, mode: "semantic", facts };
    }

    async lineageFacts(sessionId: string, opts: LineageOpts = {}, access: AccessContext = {}): Promise<SearchResult> {
        // Incubation: session-scoped retrieval. Spawn-tree (AGE SPAWNED) traversal
        // is a future enhancement; callers pass grantedSessionIds for the tree.
        const ids = [sessionId, ...(access.grantedSessionIds ?? [])];
        if (opts.query) {
            return this.searchFacts(opts.query, { mode: opts.mode ?? "hybrid", limit: opts.limit },
                { ...access, grantedSessionIds: ids, readerSessionId: sessionId });
        }
        const { facts } = await this.readFacts(
            { scope: "descendants", limit: opts.limit }, { ...access, grantedSessionIds: ids });
        return { count: facts.length, mode: opts.mode ?? "hybrid",
                 facts: facts.map((f) => ({ ...f, score: 0, signals: {} })) };
    }

    // ─── AGE helpers ──────────────────────────────────────────────────────────

    private async withAge<T>(fn: (client: any) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await prepareAgeSession(client);
            return await fn(client);
        } finally {
            client.release();
        }
    }

    private async cypher(client: any, query: string, columns: string[]): Promise<any[]> {
        const colDefs = columns.map((c) => `${c} agtype`).join(", ");
        const { rows } = await client.query(
            `SELECT * FROM cypher(${cypherStr(this.graph)}, $$ ${query} $$) AS (${colDefs})`);
        return rows;
    }

    // ─── open-graph crawler ───────────────────────────────────────────────────

    async searchEntities(q: EntityQuery): Promise<EntityHit[]> {
        const filters: string[] = [];
        if (q.kind) filters.push(`e.kind = ${cypherStr(q.kind)}`);
        if (q.nameLike) {
            const pat = cypherStr(q.nameLike.toLowerCase());
            // AGE does not support the `any(x IN list WHERE pred)` predicate; use
            // the list-comprehension form `size([x IN list WHERE pred]) > 0`.
            filters.push(`(toLower(e.name) CONTAINS ${pat} OR size([a IN e.aliases WHERE toLower(a) CONTAINS ${pat}]) > 0)`);
        }
        const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
        const limit = cypherNum(q.limit ?? 20);
        return this.withAge(async (c) => {
            const rows = await this.cypher(c,
                `MATCH (e:Entity) ${where} RETURN e.entity_key, e.kind, e.name, e.aliases LIMIT ${limit}`,
                ["entity_key", "kind", "name", "aliases"]);
            return rows.map((r) => ({
                entityKey: ag(r.entity_key), kind: ag(r.kind), name: ag(r.name),
                aliases: agArr(r.aliases),
            }));
        });
    }

    async searchRelationships(q: RelQuery): Promise<RelHit[]> {
        const filters: string[] = [];
        const pk = q.predicateKey ?? (q.predicate ? makePredicateKey(q.predicate) : undefined);
        if (pk) filters.push(`r.predicate_key = ${cypherStr(pk)}`);
        if (q.fromKey) filters.push(`a.entity_key = ${cypherStr(q.fromKey)}`);
        if (q.toKey) filters.push(`b.entity_key = ${cypherStr(q.toKey)}`);
        if (q.minConfidence != null) filters.push(`r.confidence >= ${cypherNum(q.minConfidence)}`);
        const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
        const limit = cypherNum(q.limit ?? 50);
        return this.withAge(async (c) => {
            const rows = await this.cypher(c,
                `MATCH (a:Entity)-[r:REL]->(b:Entity) ${where}
                 RETURN a.entity_key, b.entity_key, r.predicate, r.predicate_key, r.confidence, r.observations, r.evidence
                 LIMIT ${limit}`,
                ["from_key", "to_key", "predicate", "predicate_key", "confidence", "observations", "evidence"]);
            return rows.map((r) => ({
                fromKey: ag(r.from_key), toKey: ag(r.to_key), predicate: ag(r.predicate),
                predicateKey: ag(r.predicate_key), confidence: Number(ag(r.confidence)),
                observations: Number(ag(r.observations)), evidence: agArr(r.evidence),
            }));
        });
    }

    async neighbourhood(entityKey: string, depth: number): Promise<SubGraph> {
        const d = Math.max(1, Math.min(Math.trunc(depth), 5));
        return this.withAge(async (c) => {
            const nodeRows = await this.cypher(c,
                `MATCH (e:Entity { entity_key: ${cypherStr(entityKey)} })-[:REL*1..${d}]-(n:Entity)
                 RETURN DISTINCT n.entity_key, n.kind, n.name`,
                ["entity_key", "kind", "name"]);
            const nodes = nodeRows.map((r) => ({ entityKey: ag(r.entity_key), kind: ag(r.kind), name: ag(r.name) }));

            // Edges among the reachable set (+ anchor). Avoids AGE-unsupported
            // startNode/endNode/UNWIND on variable-length paths.
            const keys = [entityKey, ...nodes.map((n) => n.entityKey)];
            const list = cypherStrList([...new Set(keys)]);
            const edgeRows = await this.cypher(c,
                `MATCH (a:Entity)-[r:REL]->(b:Entity)
                 WHERE a.entity_key IN ${list} AND b.entity_key IN ${list}
                 RETURN a.entity_key, b.entity_key, r.predicate, r.confidence`,
                ["from_key", "to_key", "predicate", "confidence"]);
            return {
                nodes,
                edges: edgeRows.map((r) => ({
                    fromKey: ag(r.from_key), toKey: ag(r.to_key),
                    predicate: ag(r.predicate), confidence: Number(ag(r.confidence)),
                })),
            };
        });
    }

    async upsertEntity(e: EntityAssertion): Promise<EntityRef> {
        const key = makeEntityKey(e.kind, e.name);
        return this.withAge(async (c) => {
            const existing = await this.cypher(c,
                `MATCH (e:Entity { entity_key: ${cypherStr(key)} }) RETURN e.aliases`, ["aliases"]);
            const incomingAliases = mergeAliases(e.aliases ?? [], [e.name]);
            if (existing.length > 0) {
                const merged = mergeAliases(agArr(existing[0].aliases), incomingAliases);
                await this.cypher(c,
                    `MATCH (e:Entity { entity_key: ${cypherStr(key)} })
                     SET e.aliases = ${cypherStrList(merged)}, e.updated_at = timestamp()
                     RETURN e.entity_key`, ["entity_key"]);
                return { entityKey: key, kind: e.kind, name: e.name, aliases: merged, created: false };
            }
            await this.cypher(c,
                `CREATE (e:Entity { entity_key: ${cypherStr(key)}, kind: ${cypherStr(e.kind)},
                    name: ${cypherStr(e.name)}, aliases: ${cypherStrList(incomingAliases)},
                    created_by: ${cypherStr(e.agentId)} }) RETURN e.entity_key`, ["entity_key"]);
            return { entityKey: key, kind: e.kind, name: e.name, aliases: incomingAliases, created: true };
        });
    }

    async assertRelationship(r: RelAssertion): Promise<RelRef> {
        const err = validateAssertion(r);
        if (err) throw new Error(`assertion rejected: ${err}`);
        const pk = makePredicateKey(r.predicate);
        return this.withAge(async (c) => {
            const existing = await this.cypher(c,
                `MATCH (a:Entity { entity_key: ${cypherStr(r.fromKey)} })-[rel:REL { predicate_key: ${cypherStr(pk)} }]->(b:Entity { entity_key: ${cypherStr(r.toKey)} })
                 RETURN rel.confidence, rel.observations, rel.evidence`,
                ["confidence", "observations", "evidence"]);
            const prior = existing.length > 0
                ? {
                    fromKey: r.fromKey, toKey: r.toKey, predicateKey: pk,
                    confidence: Number(ag(existing[0].confidence)),
                    observations: Number(ag(existing[0].observations)),
                    evidence: agArr(existing[0].evidence),
                  }
                : null;
            const decision = decideEdgeMerge(r, prior);
            const evidence = decision.evidence;

            if (prior) {
                await this.cypher(c,
                    `MATCH (a:Entity { entity_key: ${cypherStr(r.fromKey)} })-[rel:REL { predicate_key: ${cypherStr(pk)} }]->(b:Entity { entity_key: ${cypherStr(r.toKey)} })
                     SET rel.confidence = ${cypherNum(decision.confidence)}, rel.observations = ${cypherNum(decision.observations)},
                         rel.evidence = ${cypherStrList(evidence)}, rel.last_seen = timestamp()
                     RETURN rel.predicate_key`, ["predicate_key"]);
            } else {
                await this.cypher(c,
                    `MATCH (a:Entity { entity_key: ${cypherStr(r.fromKey)} }), (b:Entity { entity_key: ${cypherStr(r.toKey)} })
                     CREATE (a)-[rel:REL { predicate: ${cypherStr(r.predicate)}, predicate_key: ${cypherStr(pk)},
                        confidence: ${cypherNum(decision.confidence)}, observations: ${cypherNum(decision.observations)},
                        asserted_by: ${cypherStrList([r.agentId])}, evidence: ${cypherStrList(evidence)},
                        model: ${cypherStr(r.model ?? "")}, first_seen: timestamp(), last_seen: timestamp() }]->(b)
                     RETURN rel.predicate_key`, ["predicate_key"]);
            }
            return {
                fromKey: r.fromKey, toKey: r.toKey, predicate: r.predicate, predicateKey: pk,
                confidence: decision.confidence, observations: decision.observations, reinforced: !!prior,
            };
        });
    }

    async linkEvidence(nodeOrEdgeKey: string, factScopeKeys: string[]): Promise<void> {
        if (factScopeKeys.length === 0) return;
        await this.withAge(async (c) => {
            for (const fk of factScopeKeys) {
                await this.cypher(c,
                    `MATCH (e:Entity { entity_key: ${cypherStr(nodeOrEdgeKey)} })
                     MERGE (f:Fact { scope_key: ${cypherStr(fk)} })
                     MERGE (e)-[:EVIDENCED_BY]->(f) RETURN f.scope_key`, ["scope_key"]);
            }
        });
    }

    async mergeEntities(fromKey: string, intoKey: string, reason: string): Promise<void> {
        // Best-effort: union aliases onto the survivor, repoint outgoing/incoming
        // REL edges, then delete the duplicate. AGE lacks APOC refactor, so we
        // recreate edges. Incubation-grade.
        await this.withAge(async (c) => {
            const dup = await this.cypher(c,
                `MATCH (e:Entity { entity_key: ${cypherStr(fromKey)} }) RETURN e.aliases`, ["aliases"]);
            if (dup.length === 0) return;
            const survivor = await this.cypher(c,
                `MATCH (e:Entity { entity_key: ${cypherStr(intoKey)} }) RETURN e.aliases`, ["aliases"]);
            if (survivor.length === 0) throw new Error(`merge target not found: ${intoKey}`);
            const merged = mergeAliases(agArr(survivor[0].aliases), agArr(dup[0].aliases));
            await this.cypher(c,
                `MATCH (s:Entity { entity_key: ${cypherStr(intoKey)} })
                 SET s.aliases = ${cypherStrList(merged)}, s.merged_note = ${cypherStr(reason)} RETURN s.entity_key`,
                ["entity_key"]);
            await this.cypher(c,
                `MATCH (d:Entity { entity_key: ${cypherStr(fromKey)} })-[r:REL]->(t:Entity), (s:Entity { entity_key: ${cypherStr(intoKey)} })
                 CREATE (s)-[:REL { predicate: r.predicate, predicate_key: r.predicate_key, confidence: r.confidence,
                    observations: r.observations, evidence: r.evidence }]->(t) RETURN r.predicate_key`, ["predicate_key"]);
            await this.cypher(c,
                `MATCH (o:Entity)-[r:REL]->(d:Entity { entity_key: ${cypherStr(fromKey)} }), (s:Entity { entity_key: ${cypherStr(intoKey)} })
                 CREATE (o)-[:REL { predicate: r.predicate, predicate_key: r.predicate_key, confidence: r.confidence,
                    observations: r.observations, evidence: r.evidence }]->(s) RETURN r.predicate_key`, ["predicate_key"]);
            await this.cypher(c,
                `MATCH (d:Entity { entity_key: ${cypherStr(fromKey)} }) DETACH DELETE d`, []);
        });
    }
}

// ─── row mapping + agtype helpers ───────────────────────────────────────────

function mapFactRow(r: any): FactRecord {
    return {
        key: r.key, value: r.value, agentId: r.agent_id ?? null, sessionId: r.session_id ?? null,
        shared: !!r.shared, tags: r.tags ?? [], createdAt: r.created_at, updatedAt: r.updated_at,
    };
}

function textForEmbedding(r: any): string {
    const v = r.value ?? {};
    return [r.key, v.name, v.description, v.text].filter(Boolean).join(" ");
}

/** Parse a scalar agtype column value into a JS value. */
function ag(v: any): any {
    if (v == null) return v;
    if (typeof v !== "string") return v;
    // agtype scalars come back as JSON text (quoted strings, numbers, arrays).
    const stripped = v.replace(/::[a-z]+$/i, "");
    try { return JSON.parse(stripped); } catch { return stripped; }
}

/** Parse an agtype array column into string[]. */
function agArr(v: any): string[] {
    const parsed = ag(v);
    return Array.isArray(parsed) ? parsed.map(String) : [];
}
