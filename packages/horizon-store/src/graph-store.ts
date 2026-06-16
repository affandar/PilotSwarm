// @pilotswarm/horizon-store — HorizonDB-backed GraphStore provider.
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
    GraphNodeInput, GraphNodeQuery, GraphNodeRef, GraphEdgeRef, GraphStore, SubGraph,
} from "./types.js";
import type { HorizonFactsConfig } from "./config.js";
import { resolveConfig, buildPoolConfig } from "./config.js";
import { loadMigrations } from "./horizon-migrator.js";
import { assertGraphExtensions } from "./preconditions.js";
import { GraphQueries } from "./graph-queries.js";

/** The single graph-bootstrap migration (AGE extension + create_graph). */
const GRAPH_BOOTSTRAP_VERSION = "0003";

export class HorizonDBGraphStore implements GraphStore {
    private pool: any;
    private initialized = false;
    private readonly graphQueries: GraphQueries;

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
        const bootstrap = loadMigrations({
            schema: this.cfg.schema!,
            graphName: this.cfg.graphName!,
            embeddingDim: this.cfg.embeddingDim ?? 1,
        }).find((m) => m.version === GRAPH_BOOTSTRAP_VERSION);
        if (!bootstrap) {
            throw new Error(`horizon-graph: graph bootstrap migration ${GRAPH_BOOTSTRAP_VERSION} not found`);
        }
        // Idempotent: the bootstrap migration guards the extension with an
        // IF-NOT-EXISTS clause and create_graph() with an ag_graph existence
        // check, so a direct run is safe under concurrent boots against distinct
        // graph names.
        await this.pool.query(bootstrap.sql);
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
    graphNeighbourhood(nodeKey: string, depth: number, access?: AccessContext): Promise<SubGraph> {
        return this.graphQueries.graphNeighbourhood(nodeKey, depth, access);
    }
    upsertGraphNode(n: GraphNodeInput): Promise<GraphNodeRef> {
        return this.graphQueries.upsertGraphNode(n);
    }
    upsertGraphEdge(e: GraphEdgeInput): Promise<GraphEdgeRef> {
        return this.graphQueries.upsertGraphEdge(e);
    }
    mergeGraphNodes(fromKey: string, intoKey: string, reason: string): Promise<void> {
        return this.graphQueries.mergeGraphNodes(fromKey, intoKey, reason);
    }
    deleteGraphNode(nodeKey: string): Promise<boolean> {
        return this.graphQueries.deleteGraphNode(nodeKey);
    }
    deleteGraphEdge(fromKey: string, toKey: string, predicateKey: string): Promise<boolean> {
        return this.graphQueries.deleteGraphEdge(fromKey, toKey, predicateKey);
    }

    /** Cheap whole-graph counts for graph_stats (07 P5) — single count() Cypher
     * per axis, no client-side fan-out. The SDK tool adds the crawl backlog. */
    graphStats(): Promise<{ nodeCount: number; edgeCount: number }> {
        return this.graphQueries.graphStats();
    }
}
