// pilotswarm-horizon-store — HorizonDB-backed GraphStore provider.
//
// SEPARATE PROVIDER (07 D2): the open knowledge graph is its own injected
// interface, implemented by its own provider with its own pool and an AGE-only
// fail-fast. It is NOT bundled into the fact provider (HorizonDBFactStore) and
// it never reads the facts table — evidence scopeKeys are opaque ids; resolving
// them back to fact values is the caller's tool-layer composition
// (graphStore.searchGraphNodes(...) -> factStore.readFacts({ scopeKeys })).
//
// The bundled HorizonDB deployment is simply HorizonDBFactStore +
// HorizonDBGraphStore pointed at one database (two pools). The base-facts +
// graph tier is PgFactStore + HorizonDBGraphStore (this provider needs only AGE).
//
// All graph access goes through the typed Cypher layer (graph-queries.ts); this
// class is the lifecycle wrapper (create / initialize / close) plus the
// GraphStore method surface.

import type {
    AccessContext, GraphEdgeHit, GraphEdgeInput, GraphEdgeQuery, GraphNodeHit,
    GraphNamespaceQuery, GraphNodeInput, GraphNodeQuery, GraphNodeRef, GraphEdgeRef, GraphStore, SubGraph,
    GraphNamespaceInfo, GraphNamespaceInput, GraphNamespaceListQuery, GraphNamespaceDeleteResult, GraphNamespaceFrontmatter,
} from "./types.js";
import type { HorizonFactsConfig } from "./config.js";
import { resolveConfig, buildPoolConfig, DEFAULT_NAMESPACE_CACHE_TTL_MS } from "./config.js";
import { loadMigrations, HORIZON_FACTS_LOCK_SEED, hashSchemaName } from "./horizon-migrator.js";
import { assertGraphExtensions } from "./preconditions.js";
import { ident } from "./sql-util.js";
import { GraphQueries } from "./graph-queries.js";
import { predicateKey } from "./graph-model.js";

/** The single graph-bootstrap migration (AGE extension + create_graph). */
const GRAPH_BOOTSTRAP_VERSION = "0003";
/** The graph namespace registry sidecar migration (graph-fact-search). */
const GRAPH_NAMESPACES_VERSION = "0013";
/** Registry key for the reserved unscoped/NULL partition. */
const DEFAULT_NS_KEY = "default";
/** Frontmatter caps so the compact list stays compact. */
const MAX_FRONTMATTER_NAME = 120;
const MAX_FRONTMATTER_DESC = 600;

/** Internal shape of a graph_namespaces row. */
interface NamespaceRow {
    namespace: string;
    archived: boolean;
    frontmatter: any;
    source: string | null;
    node_schema: any;
    edge_schema: any;
    harvest_config: any;
    created_at: Date | string;
    updated_at: Date | string;
}

export class HorizonDBGraphStore implements GraphStore {
    private pool: any;
    private initialized = false;
    private readonly graphQueries: GraphQueries;
    // Single full snapshot of the (small) namespace table; compact/detail views
    // and prefix/archived filters are projected in memory. Writes invalidate it
    // in-process; other workers converge within the TTL. `nsClock` is an
    // injectable seam so expiry can be tested without sleeping.
    private nsCache: { rows: NamespaceRow[]; at: number } | null = null;
    private nsClock: () => number = () => Date.now();

    private constructor(
        pool: any,
        private readonly cfg: Required<Pick<HorizonFactsConfig, "schema" | "graphName" | "embeddingDim">> & HorizonFactsConfig,
    ) {
        this.pool = pool;
        this.graphQueries = new GraphQueries(pool, cfg.graphName);
    }

    static async create(config: Partial<HorizonFactsConfig> = {}): Promise<HorizonDBGraphStore> {
        const cfg = resolveConfig(config);
        // Managed-identity / AAD token auth is not yet implemented in this
        // provider (07 P5) — keep the runtime dep surface to `pg` only. Fail
        // FAST rather than silently ignoring the request (mirrors the fact store).
        if (cfg.useManagedIdentity) {
            throw new Error(
                "HorizonDBGraphStore does not support managed-identity (AAD token) auth yet. " +
                "Provide a connection string with embedded credentials, or run without a graph store " +
                "for managed-identity deployments. (enhancedfactstore 07 P5)",
            );
        }
        const { default: pg } = await import("pg");
        const pool = new pg.Pool(buildPoolConfig(cfg.connectionString, cfg.poolMax!));
        pool.on("error", (err: Error) => console.error("[horizon-graph] pool error (non-fatal):", err.message));
        return new HorizonDBGraphStore(pool, cfg as any);
    }

    // ─── lifecycle ────────────────────────────────────────────────────────────

    /**
     * Fail-fast on AGE only (07 D2) — a graph deployment needs `age`, nothing
     * else — then run the idempotent AGE bootstrap (CREATE EXTENSION age +
     * create_graph, both guarded). No vector / textsearch / pg_durable here;
     * this provider can pair with a plain PgFactStore.
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;
        await assertGraphExtensions(this.pool);
        const migrations = loadMigrations({
            schema: this.cfg.schema!,
            graphName: this.cfg.graphName!,
            registrySchema: this.registrySchema,
            embeddingDim: this.cfg.embeddingDim ?? 1,
        });
        const bootstrap = migrations.find((m) => m.version === GRAPH_BOOTSTRAP_VERSION);
        if (!bootstrap) {
            throw new Error(`horizon-graph: graph bootstrap migration ${GRAPH_BOOTSTRAP_VERSION} not found`);
        }
        const nsMigration = migrations.find((m) => m.version === GRAPH_NAMESPACES_VERSION);
        if (!nsMigration) {
            throw new Error(`horizon-graph: namespace registry migration ${GRAPH_NAMESPACES_VERSION} not found`);
        }
        // The registry schema MUST differ from the AGE graph name: create_graph()
        // owns a Postgres schema of that name, so colocating the sidecar there
        // would make it droppable by drop_graph and mix relational DDL into the
        // AGE-managed schema. Fail fast rather than silently corrupt placement.
        if (this.registrySchema === this.cfg.graphName) {
            throw new Error(
                `horizon-graph: registrySchema "${this.registrySchema}" must differ from the AGE graph name ` +
                `"${this.cfg.graphName}" (Apache AGE owns a schema of that name). Set a distinct registrySchema / ` +
                `HORIZON_GRAPH_REGISTRY_SCHEMA.`,
            );
        }
        const lockKey = hashSchemaName("horizon-graph-bootstrap", HORIZON_FACTS_LOCK_SEED);
        const client = await this.pool.connect();
        try {
            for (let attempt = 1; attempt <= 10; attempt++) {
                try {
                    await client.query("BEGIN");
                    await client.query("SELECT pg_advisory_xact_lock($1)", [lockKey]);
                    await client.query(bootstrap.sql);
                    await client.query("COMMIT");
                    break;
                } catch (err: any) {
                    await client.query("ROLLBACK").catch(() => {});
                    const transient = /tuple concurrently updated|already exists/i.test(String(err?.message ?? err));
                    if (!transient) throw err;
                    const { rows } = await client.query(
                        "SELECT 1 FROM ag_catalog.ag_graph WHERE name = $1 LIMIT 1",
                        [this.cfg.graphName!],
                    );
                    if (rows.length > 0) break;
                    if (attempt === 10) throw err;
                    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
                }
            }
        } finally {
            client.release();
        }

        // Namespace registry sidecar (graph-fact-search): a SECOND idempotent
        // bootstrap, isolated from the 0003 AGE-race retry so a transient here
        // never short-circuits on ag_graph existence. Folded into the graph
        // bootstrap (no second migration framework) per the design.
        const nsLockKey = hashSchemaName("horizon-graph-namespaces", HORIZON_FACTS_LOCK_SEED);
        const nsClient = await this.pool.connect();
        try {
            for (let attempt = 1; attempt <= 10; attempt++) {
                try {
                    await nsClient.query("BEGIN");
                    await nsClient.query("SELECT pg_advisory_xact_lock($1)", [nsLockKey]);
                    await nsClient.query(nsMigration.sql);
                    await nsClient.query("COMMIT");
                    break;
                } catch (err: any) {
                    await nsClient.query("ROLLBACK").catch(() => {});
                    const transient = /tuple concurrently updated|already exists|deadlock detected/i.test(String(err?.message ?? err));
                    if (!transient || attempt === 10) throw err;
                    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
                }
            }
        } finally {
            nsClient.release();
        }

        this.initialized = true;
    }

    async close(): Promise<void> {
        await this.pool.end();
    }

    // ─── GraphStore (delegated to the typed Cypher layer) ────────────────────

    searchGraphNodes(q: GraphNodeQuery, access?: AccessContext): Promise<GraphNodeHit[]> {
        return this.graphQueries.searchGraphNodes(q, access);
    }
    searchGraphEdges(q: GraphEdgeQuery, access?: AccessContext): Promise<GraphEdgeHit[]> {
        return this.graphQueries.searchGraphEdges(q, access);
    }
    normalizePredicateKey(predicate: string): string {
        return predicateKey(predicate);
    }
    graphNeighbourhood(nodeKey: string, depth: number, access?: AccessContext, opts?: GraphNamespaceQuery): Promise<SubGraph> {
        return this.graphQueries.graphNeighbourhood(nodeKey, depth, access, opts);
    }
    upsertGraphNode(n: GraphNodeInput): Promise<GraphNodeRef> {
        return this.graphQueries.upsertGraphNode(n);
    }
    upsertGraphEdge(e: GraphEdgeInput): Promise<GraphEdgeRef> {
        return this.graphQueries.upsertGraphEdge(e);
    }
    mergeGraphNodes(fromKey: string, intoKey: string, reason: string, opts?: GraphNamespaceQuery): Promise<void> {
        return this.graphQueries.mergeGraphNodes(fromKey, intoKey, reason, opts);
    }
    deleteGraphNode(nodeKey: string, opts?: GraphNamespaceQuery): Promise<boolean> {
        return this.graphQueries.deleteGraphNode(nodeKey, opts);
    }
    deleteGraphEdge(fromKey: string, toKey: string, predicateKey: string, opts?: GraphNamespaceQuery): Promise<boolean> {
        return this.graphQueries.deleteGraphEdge(fromKey, toKey, predicateKey, opts);
    }
    removeGraphEvidence(scopeKey: string, opts?: GraphNamespaceQuery) {
        return this.graphQueries.removeGraphEvidence(scopeKey, opts);
    }

    /** Cheap whole-graph counts for graph_stats (07 P5) — single count() Cypher
     * per axis, no client-side fan-out. The SDK tool adds the crawl backlog. */
    graphStats(opts?: GraphNamespaceQuery): Promise<{ nodeCount: number; edgeCount: number }> {
        return this.graphQueries.graphStats(opts);
    }

    // ─── namespace registry (graph-fact-search enhancements) ─────────────────

    private get registrySchema(): string {
        return this.cfg.registrySchema ?? `${this.cfg.graphName}_registry`;
    }
    private nsTable(): string {
        return `${ident(this.registrySchema)}.graph_namespaces`;
    }
    private get nsCacheTtlMs(): number {
        return this.cfg.namespaceCacheTtlMs ?? DEFAULT_NAMESPACE_CACHE_TTL_MS;
    }
    /** Test seam: override the cache clock to exercise TTL expiry deterministically. */
    setNamespaceCacheClock(clock: () => number): void {
        this.nsClock = clock;
    }
    private invalidateNamespaceCache(): void {
        this.nsCache = null;
    }

    /**
     * Map any caller namespace to its REGISTRY key. The unscoped partition is
     * keyed by the literal `default` row; `default`/empty/trailing-slash all
     * resolve to it. Concrete corpora keep their trimmed key.
     */
    private namespaceKey(namespace: string): string {
        const clean = (namespace ?? "").trim().replace(/\/+$/g, "");
        if (clean.length === 0 || clean.toLowerCase() === DEFAULT_NS_KEY) return DEFAULT_NS_KEY;
        return clean;
    }

    private validateFrontmatter(key: string, fm: GraphNamespaceFrontmatter | undefined): GraphNamespaceFrontmatter {
        const rawName = fm?.name != null ? String(fm.name).trim() : "";
        const name = (rawName.length > 0 ? rawName : key).slice(0, MAX_FRONTMATTER_NAME);
        const rawDescription = fm?.description != null ? String(fm.description).trim() : "";
        if (rawDescription.length === 0) {
            throw new Error(
                `upsertGraphNamespace(${JSON.stringify(key)}): frontmatter.description is required ` +
                `(it is the discovery hint readers use to choose a corpus).`,
            );
        }
        const description = rawDescription.slice(0, MAX_FRONTMATTER_DESC);
        return { name, description };
    }

    private nsRowToInfo(r: NamespaceRow, includeDetails: boolean): GraphNamespaceInfo {
        const fm = (r.frontmatter ?? {}) as GraphNamespaceFrontmatter;
        const info: GraphNamespaceInfo = {
            namespace: r.namespace,
            archived: !!r.archived,
            frontmatter: { name: fm.name ?? r.namespace, description: fm.description ?? "" },
        };
        if (includeDetails) {
            if (r.source != null) info.source = r.source;
            if (r.node_schema != null) info.nodeSchema = r.node_schema;
            if (r.edge_schema != null) info.edgeSchema = r.edge_schema;
            if (r.harvest_config != null) info.harvestConfig = r.harvest_config;
            info.createdAt = r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at);
            info.updatedAt = r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at);
        }
        return info;
    }

    private async loadNamespaceRows(): Promise<NamespaceRow[]> {
        const ttl = this.nsCacheTtlMs;
        const now = this.nsClock();
        if (ttl > 0 && this.nsCache && now - this.nsCache.at < ttl) return this.nsCache.rows;
        const { rows } = await this.pool.query(
            `SELECT namespace, archived, frontmatter, source, node_schema, edge_schema, harvest_config, created_at, updated_at
             FROM ${this.nsTable()} ORDER BY namespace`);
        this.nsCache = ttl > 0 ? { rows, at: now } : null;
        return rows;
    }

    async listGraphNamespaces(q: GraphNamespaceListQuery = {}): Promise<GraphNamespaceInfo[]> {
        const rows = await this.loadNamespaceRows();
        const prefix = q.prefix?.trim() ?? "";
        const includeArchived = q.includeArchived === true;
        const includeDetails = q.includeDetails === true;
        return rows
            .filter((r) => includeArchived || !r.archived)
            .filter((r) => prefix.length === 0 || r.namespace.startsWith(prefix))
            .map((r) => this.nsRowToInfo(r, includeDetails));
    }

    async getGraphNamespace(namespace: string): Promise<GraphNamespaceInfo | null> {
        const key = this.namespaceKey(namespace);
        const { rows } = await this.pool.query(
            `SELECT namespace, archived, frontmatter, source, node_schema, edge_schema, harvest_config, created_at, updated_at
             FROM ${this.nsTable()} WHERE namespace = $1`, [key]);
        return rows.length > 0 ? this.nsRowToInfo(rows[0], true) : null;
    }

    async upsertGraphNamespace(input: GraphNamespaceInput): Promise<GraphNamespaceInfo> {
        const key = this.namespaceKey(input.namespace);
        const frontmatter = this.validateFrontmatter(key, input.frontmatter);
        // `default` is always active — it cannot be archived.
        const archived = key === DEFAULT_NS_KEY ? false : input.archived === true;
        const { rows } = await this.pool.query(
            `INSERT INTO ${this.nsTable()} AS gn
                 (namespace, archived, frontmatter, source, node_schema, edge_schema, harvest_config)
             VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6::jsonb, $7::jsonb)
             ON CONFLICT (namespace) DO UPDATE SET
                 archived       = EXCLUDED.archived,
                 frontmatter    = EXCLUDED.frontmatter,
                 source         = COALESCE(EXCLUDED.source, gn.source),
                 node_schema    = COALESCE(EXCLUDED.node_schema, gn.node_schema),
                 edge_schema    = COALESCE(EXCLUDED.edge_schema, gn.edge_schema),
                 harvest_config = COALESCE(EXCLUDED.harvest_config, gn.harvest_config)
             RETURNING namespace, archived, frontmatter, source, node_schema, edge_schema, harvest_config, created_at, updated_at`,
            [
                key,
                archived,
                JSON.stringify(frontmatter),
                input.source ?? null,
                input.nodeSchema != null ? JSON.stringify(input.nodeSchema) : null,
                input.edgeSchema != null ? JSON.stringify(input.edgeSchema) : null,
                input.harvestConfig != null ? JSON.stringify(input.harvestConfig) : null,
            ]);
        this.invalidateNamespaceCache();
        return this.nsRowToInfo(rows[0], true);
    }

    async archiveGraphNamespace(namespace: string): Promise<boolean> {
        const key = this.namespaceKey(namespace);
        if (key === DEFAULT_NS_KEY) return false; // default is never archived
        const res = await this.pool.query(
            `UPDATE ${this.nsTable()} SET archived = true WHERE namespace = $1`, [key]);
        this.invalidateNamespaceCache();
        return (res.rowCount ?? 0) > 0;
    }

    async deleteGraphNamespace(namespace: string): Promise<GraphNamespaceDeleteResult> {
        const key = this.namespaceKey(namespace);
        if (key === DEFAULT_NS_KEY) {
            throw new Error("the 'default' namespace cannot be deleted");
        }
        // Graph data FIRST (re-runnable), then the registry row, so a mid-delete
        // crash recovers: a re-run drops any remaining data and the row.
        const { nodesDeleted, edgesDeleted } = await this.graphQueries.deleteNamespaceData(key);
        const res = await this.pool.query(
            `DELETE FROM ${this.nsTable()} WHERE namespace = $1`, [key]);
        this.invalidateNamespaceCache();
        return { deleted: (res.rowCount ?? 0) > 0, nodesDeleted, edgesDeleted };
    }
}
