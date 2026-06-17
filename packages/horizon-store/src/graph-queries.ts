// @pilotswarm/horizon-store — typed Cypher layer (AGE).
//
// ALL graph access goes through this module (03-design §1: graph access is a
// typed Cypher layer in TypeScript, not plpgsql-wrapped Cypher). The data
// model (03-design §2.2):
//
//   (:GraphNode {node_key, kind, name, aliases, namespace, created_by})
//       -[:REL {predicate, predicate_key, confidence, observations,
//               evidence[], asserted_by[], namespace, model}]-> (:GraphNode)
//       -[:EVIDENCED_BY]-> (:Fact {scope_key})
//
// Evidence has two physical forms: a NODE's evidence is a real EVIDENCED_BY
// edge to a content-free :Fact anchor (traversable — the seed pivot matches
// it); a REL edge's evidence is a property array (property graphs have no
// edge-to-edge links). Both surface as `evidence: string[]`, ACL-filtered to
// the caller at result assembly (01 §6.1a). Inaccessible fact SEEDS are
// ignored (treated as unknown).
//
// AGE quirks encapsulated here: no parameterized cypher (escaped literals via
// sql-util), no `any(x IN ...)` predicate (list comprehension instead), no
// startNode/endNode/UNWIND on var-length paths (edges re-matched over the
// reachable key set).

import type {
    AccessContext, GraphEdgeHit, GraphEdgeInput, GraphEdgeQuery,
    GraphNodeHit, GraphNodeInput, GraphNodeQuery, GraphNodeRef, GraphEdgeRef, SubGraph,
} from "./types.js";
import { scopeKeyAccessible } from "./types.js";
import { cypherStr, cypherNum, cypherStrList } from "./sql-util.js";
import { withDbRetry, isLabelCreationRaceError } from "./db-retry.js";
import { nodeKeyOf, predicateKey as makePredicateKey, mergeAliases, decideEdgeUpsert, reinforceConfidence, clamp01 } from "./graph-model.js";

const FACT_SEED = /^(shared|session):/;

function normalizeNamespace(namespace?: string): string | null {
    const clean = namespace?.trim().replace(/\/+$/g, "") ?? "";
    return clean.length > 0 ? clean : null;
}

function namespacePredicate(alias: string, namespace?: string): string | null {
    const ns = normalizeNamespace(namespace);
    if (!ns) return null;
    return `(${alias}.namespace = ${cypherStr(ns)} OR ${alias}.namespace STARTS WITH ${cypherStr(`${ns}/`)})`;
}

function namespaceMatches(value: unknown, namespace?: string): boolean {
    const ns = normalizeNamespace(namespace);
    if (!ns) return true;
    const current = typeof value === "string" ? normalizeNamespace(value) : null;
    return current === ns || current?.startsWith(`${ns}/`) === true;
}

function namespaceProp(namespace?: string): string {
    const ns = normalizeNamespace(namespace);
    return ns ? `, namespace: ${cypherStr(ns)}` : "";
}

function namespaceSet(alias: string, namespace?: string): string {
    const ns = normalizeNamespace(namespace);
    return ns ? `, ${alias}.namespace = ${cypherStr(ns)}` : "";
}

function edgeNamespacePredicate(namespace?: string): string | null {
    const ns = normalizeNamespace(namespace);
    if (!ns) return null;
    const exact = cypherStr(ns);
    const prefix = cypherStr(`${ns}/`);
    return `(` +
        `r.namespace = ${exact} OR r.namespace STARTS WITH ${prefix} OR ` +
        `a.namespace = ${exact} OR a.namespace STARTS WITH ${prefix} OR ` +
        `b.namespace = ${exact} OR b.namespace STARTS WITH ${prefix}` +
        `)`;
}

/**
 * Load the AGE shared library for this session. On managed Postgres where age
 * is preloaded via shared_preload_libraries, an explicit LOAD is rejected with
 * `access to library "age" is not allowed` — tolerated, since preloaded means
 * there is nothing to do.
 */
export async function prepareAgeSession(client: any): Promise<void> {
    try {
        await client.query(`LOAD 'age'`);
    } catch (err: any) {
        const msg = String(err?.message ?? "");
        if (!/access to library "age" is not allowed/i.test(msg)) throw err;
    }
    await client.query(`SET search_path = ag_catalog, "$user", public`);
}

/** Parse a scalar agtype column value into a JS value. */
export function ag(v: any): any {
    if (v == null) return v;
    if (typeof v !== "string") return v;
    const stripped = v.replace(/::[a-z]+$/i, "");
    try { return JSON.parse(stripped); } catch { return stripped; }
}

/** Parse an agtype array column into string[]. */
export function agArr(v: any): string[] {
    const parsed = ag(v);
    return Array.isArray(parsed) ? parsed.map(String) : [];
}

/**
 * Typed Cypher layer (AGE). Provides the GraphStore READ/WRITE method bodies;
 * `HorizonDBGraphStore` wraps this with the lifecycle (initialize/close) to form
 * the full `GraphStore` provider (07 D2). This inner class deliberately does NOT
 * implement the lifecycle, so it is not itself a `GraphStore`.
 */
export class GraphQueries {
    // Physical connections whose AGE session is already prepared (LOAD age +
    // search_path). Keyed on the pg client object, which the pool reuses per
    // physical connection — so the (otherwise per-checkout) setup runs ONCE per
    // connection instead of on every graph op. On a remote cluster that removes
    // ~2 round trips (a wasted LOAD attempt + SET) from every upsert. A reset
    // connection yields a NEW client object → re-prepared automatically, and a
    // stale-but-cached connection self-heals: its query fails transiently,
    // withDbRetry re-acquires a fresh (unprepared) client, and we prepare that.
    private readonly prepared = new WeakSet<object>();

    constructor(private readonly pool: any, private readonly graphName: string) {}

    private async withAge<T>(fn: (client: any) => Promise<T>): Promise<T> {
        // Retry the whole acquire+run on transient HorizonDB CONNECTION drops
        // (needs a fresh client). The AGE label-creation race is handled one
        // level down in cypher() — that one can retry on the same client.
        return withDbRetry("graph_cypher", async () => {
            const client = await this.pool.connect();
            try {
                if (!this.prepared.has(client)) {
                    await prepareAgeSession(client);
                    this.prepared.add(client);
                }
                return await fn(client);
            } finally {
                client.release();
            }
        });
    }

    private async cypher(client: any, query: string, columns: string[]): Promise<any[]> {
        // AGE requires a non-empty column list even for write-only queries
        // (DELETE/DETACH DELETE return no rows) — use a dummy column then.
        const colDefs = (columns.length > 0 ? columns : ["_ok"]).map((c) => `${c} agtype`).join(", ");
        const sql = `SELECT * FROM cypher(${cypherStr(this.graphName)}, $$ ${query} $$) AS (${colDefs})`;
        // AGE creates a label's backing table LAZILY on the first CREATE/MERGE
        // that references it. Concurrent first-references to the same label race
        // that internal CREATE TABLE; the loser aborts the whole statement
        // (nothing persisted) with EITHER 42P07 `relation "<label>" already
        // exists` OR 23505 on a pg_catalog index (e.g. pg_class_relname_nsp_index).
        // The label now EXISTS, so re-running the SAME statement on the same
        // client succeeds (each cypher call is its own autocommit statement, so a
        // prior failure does not poison the connection). We only retry this
        // label-race class — every other error surfaces. Label-agnostic on
        // purpose: labels are owned by the layer above us.
        const { rows } = await withDbRetry<{ rows: any[] }>(
            "graph_label_race", () => client.query(sql), { isRetryable: isLabelCreationRaceError });
        return rows;
    }

    // ─── reads ────────────────────────────────────────────────────────────────

    async searchGraphNodes(q: GraphNodeQuery, access?: AccessContext): Promise<GraphNodeHit[]> {
        const limit = Math.max(1, Math.min(Math.trunc(q.limit ?? 50), 500));
        const depth = Math.max(1, Math.min(Math.trunc(q.depth ?? 1), 5));

        return this.withAge(async (c) => {
            const found = new Map<string, { nodeKey: string; kind: string; name: string; namespace?: string; aliases: string[] }>();
            const collect = (rows: any[]) => {
                for (const r of rows) {
                    const nodeKey = ag(r.node_key);
                    if (!found.has(nodeKey)) {
                        const namespace = ag(r.namespace);
                        found.set(nodeKey, {
                            nodeKey,
                            kind: ag(r.kind),
                            name: ag(r.name),
                            ...(typeof namespace === "string" ? { namespace } : {}),
                            aliases: agArr(r.aliases),
                        });
                    }
                }
            };
            const RET = `RETURN DISTINCT n.node_key, n.kind, n.name, n.namespace, n.aliases`;
            const COLS = ["node_key", "kind", "name", "namespace", "aliases"];

            const seeds = q.seeds ?? [];
            if (seeds.length > 0) {
                // Inaccessible fact seeds are IGNORED — byte-identical to unknown
                // seeds, so seeding cannot probe private facts (01 §6.5).
                const factSeeds = seeds.filter((s) => FACT_SEED.test(s) && scopeKeyAccessible(s, access));
                const nodeSeeds = seeds.filter((s) => !FACT_SEED.test(s));

                const baseKeys = new Set<string>();
                if (factSeeds.length > 0) {
                    const rows = await this.cypher(c,
                        `MATCH (f:Fact)<-[:EVIDENCED_BY]-(n:GraphNode)
                         WHERE f.scope_key IN ${cypherStrList(factSeeds)} ${RET}`, COLS);
                    collect(rows);
                    for (const r of rows) baseKeys.add(ag(r.node_key));
                }
                if (nodeSeeds.length > 0) {
                    const rows = await this.cypher(c,
                        `MATCH (n:GraphNode) WHERE n.node_key IN ${cypherStrList(nodeSeeds)} ${RET}`, COLS);
                    collect(rows);
                    for (const r of rows) baseKeys.add(ag(r.node_key));
                }
                if (baseKeys.size > 0 && depth >= 1) {
                    const rows = await this.cypher(c,
                        `MATCH (s:GraphNode)-[:REL*1..${depth}]-(n:GraphNode)
                         WHERE s.node_key IN ${cypherStrList([...baseKeys])} ${RET}`, COLS);
                    collect(rows);
                }
                // kind/nameLike/namespace combine as post-filters when seeds anchor the query.
                if (q.kind || q.nameLike || q.namespace) {
                    const kindNorm = q.kind;
                    const pat = q.nameLike?.toLowerCase();
                    for (const [k, n] of [...found]) {
                        if (kindNorm && n.kind !== kindNorm) { found.delete(k); continue; }
                        if (!namespaceMatches(n.namespace, q.namespace)) { found.delete(k); continue; }
                        if (pat) {
                            const hay = [n.name, ...n.aliases].map((x) => x.toLowerCase());
                            if (!hay.some((x) => x.includes(pat))) found.delete(k);
                        }
                    }
                }
            } else {
                const filters: string[] = [];
                if (q.kind) filters.push(`n.kind = ${cypherStr(q.kind)}`);
                const ns = namespacePredicate("n", q.namespace);
                if (ns) filters.push(ns);
                if (q.nameLike) {
                    const pat = cypherStr(q.nameLike.toLowerCase());
                    // AGE lacks `any(x IN list WHERE ...)`; use list comprehension.
                    filters.push(`(toLower(n.name) CONTAINS ${pat} OR size([a IN n.aliases WHERE toLower(a) CONTAINS ${pat}]) > 0)`);
                }
                const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
                collect(await this.cypher(c,
                    `MATCH (n:GraphNode) ${where} ${RET} LIMIT ${cypherNum(limit)}`, COLS));
            }

            const hits = [...found.values()].slice(0, limit);
            const evidence = await this.evidenceFor(c, hits.map((h) => h.nodeKey), access);
            return hits.map((h) => ({ ...h, evidence: evidence.get(h.nodeKey) ?? [] }));
        });
    }

    /**
     * Idempotent, duplicate-anchor-proof evidence linking. A naive
     * `MERGE (f:Fact {scope_key}) MERGE (e)-[:EVIDENCED_BY]->(f)` is NOT safe
     * here: AGE has no unique constraints, so concurrent upserts can race the
     * anchor MERGE into duplicate :Fact nodes — after which a later MERGE
     * binds EVERY duplicate and mints extra edges. Instead: skip when any
     * edge already exists; bind exactly ONE anchor (WITH … LIMIT 1) or create
     * it when none exists.
     */
    private async linkEvidenceAnchor(client: any, nodeKey: string, scopeKey: string): Promise<void> {
        const linked = await this.cypher(client,
            `MATCH (e:GraphNode { node_key: ${cypherStr(nodeKey)} })-[:EVIDENCED_BY]->(f:Fact { scope_key: ${cypherStr(scopeKey)} })
             RETURN f.scope_key LIMIT 1`, ["scope_key"]);
        if (linked.length > 0) return;
        const anchored = await this.cypher(client,
            `MATCH (e:GraphNode { node_key: ${cypherStr(nodeKey)} })
             MATCH (f:Fact { scope_key: ${cypherStr(scopeKey)} })
             WITH e, f LIMIT 1
             CREATE (e)-[:EVIDENCED_BY]->(f) RETURN f.scope_key`, ["scope_key"]);
        if (anchored.length === 0) {
            await this.cypher(client,
                `MATCH (e:GraphNode { node_key: ${cypherStr(nodeKey)} })
                 CREATE (f:Fact { scope_key: ${cypherStr(scopeKey)} })
                 CREATE (e)-[:EVIDENCED_BY]->(f) RETURN f.scope_key`, ["scope_key"]);
        }
    }

    /** EVIDENCED_BY scopeKeys per node, ACL-filtered (01 §6.1a), deduped
     * (duplicate anchors must never surface as duplicate evidence keys). */
    private async evidenceFor(client: any, nodeKeys: string[], access?: AccessContext): Promise<Map<string, string[]>> {
        const out = new Map<string, string[]>();
        if (nodeKeys.length === 0) return out;
        const rows = await this.cypher(client,
            `MATCH (n:GraphNode)-[:EVIDENCED_BY]->(f:Fact)
             WHERE n.node_key IN ${cypherStrList(nodeKeys)}
             RETURN n.node_key, f.scope_key`, ["node_key", "scope_key"]);
        for (const r of rows) {
            const nk = ag(r.node_key);
            const sk = ag(r.scope_key);
            if (!scopeKeyAccessible(sk, access)) continue;   // traversal saw it; the caller doesn't
            const arr = out.get(nk) ?? [];
            if (!arr.includes(sk)) arr.push(sk);
            out.set(nk, arr);
        }
        return out;
    }

    async searchGraphEdges(q: GraphEdgeQuery, access?: AccessContext): Promise<GraphEdgeHit[]> {
        const filters: string[] = [];
        const pk = q.predicateKey ?? (q.predicate ? makePredicateKey(q.predicate) : undefined);
        if (pk) filters.push(`r.predicate_key = ${cypherStr(pk)}`);
        if (q.fromKey) filters.push(`a.node_key = ${cypherStr(q.fromKey)}`);
        if (q.toKey) filters.push(`b.node_key = ${cypherStr(q.toKey)}`);
        const ns = edgeNamespacePredicate(q.namespace);
        if (ns) filters.push(ns);
        if (q.minConfidence != null) filters.push(`r.confidence >= ${cypherNum(q.minConfidence)}`);
        const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
        const limit = cypherNum(Math.max(1, Math.min(Math.trunc(q.limit ?? 50), 500)));
        return this.withAge(async (c) => {
            const rows = await this.cypher(c,
                `MATCH (a:GraphNode)-[r:REL]->(b:GraphNode) ${where}
                 RETURN a.node_key, b.node_key, r.predicate, r.predicate_key, r.namespace, r.confidence, r.observations, r.evidence
                 LIMIT ${limit}`,
                ["from_key", "to_key", "predicate", "predicate_key", "namespace", "confidence", "observations", "evidence"]);
            return rows.map((r) => ({
                fromKey: ag(r.from_key), toKey: ag(r.to_key), predicate: ag(r.predicate),
                predicateKey: ag(r.predicate_key), namespace: ag(r.namespace) ?? undefined,
                confidence: Number(ag(r.confidence)),
                observations: Number(ag(r.observations)),
                evidence: agArr(r.evidence).filter((sk) => scopeKeyAccessible(sk, access)),
            }));
        });
    }

    async graphNeighbourhood(nodeKey: string, depth: number, _access?: AccessContext, opts: { namespace?: string } = {}): Promise<SubGraph> {
        const d = Math.max(1, Math.min(Math.trunc(depth), 5));
        return this.withAge(async (c) => {
            const ns = namespacePredicate("n", opts.namespace);
            const nodeRows = await this.cypher(c,
                `MATCH (e:GraphNode { node_key: ${cypherStr(nodeKey)} })-[:REL*1..${d}]-(n:GraphNode)
                 ${ns ? `WHERE ${ns}` : ""}
                 RETURN DISTINCT n.node_key, n.kind, n.name, n.namespace`,
                ["node_key", "kind", "name", "namespace"]);
            const nodes = nodeRows.map((r) => {
                const namespace = ag(r.namespace);
                return {
                    nodeKey: ag(r.node_key),
                    kind: ag(r.kind),
                    name: ag(r.name),
                    ...(typeof namespace === "string" ? { namespace } : {}),
                };
            });
            if (nodes.length === 0) return { nodes: [], edges: [] };

            // Edges among the reachable set (+ anchor); avoids AGE-unsupported
            // startNode/endNode/UNWIND on variable-length paths.
            const keys = [...new Set([nodeKey, ...nodes.map((n) => n.nodeKey)])];
            const list = cypherStrList(keys);
            const edgeRows = await this.cypher(c,
                `MATCH (a:GraphNode)-[r:REL]->(b:GraphNode)
                 WHERE a.node_key IN ${list} AND b.node_key IN ${list}
                 RETURN a.node_key, b.node_key, r.predicate, r.namespace, r.confidence`,
                ["from_key", "to_key", "predicate", "namespace", "confidence"]);
            return {
                nodes,
                edges: edgeRows.map((r) => {
                    const namespace = ag(r.namespace);
                    return {
                        fromKey: ag(r.from_key), toKey: ag(r.to_key),
                        predicate: ag(r.predicate),
                        ...(typeof namespace === "string" ? { namespace } : {}),
                        confidence: Number(ag(r.confidence)),
                    };
                }),
            };
        });
    }

    /**
     * Cheap whole-graph counts for `graph_stats` (enhancedfactstore 07 P5):
     * a single `count()` Cypher per axis instead of a client-side fan-out.
     * AGE has no edge-only catalog, so edges are counted via a directed match.
     */
    async graphStats(opts: { namespace?: string } = {}): Promise<{ nodeCount: number; edgeCount: number }> {
        return this.withAge(async (c) => {
            const nodeFilters = [namespacePredicate("n", opts.namespace)].filter(Boolean);
            const nodeWhere = nodeFilters.length ? `WHERE ${nodeFilters.join(" AND ")}` : "";
            const edgeFilters = [edgeNamespacePredicate(opts.namespace)].filter(Boolean);
            const edgeWhere = edgeFilters.length ? `WHERE ${edgeFilters.join(" AND ")}` : "";
            const nodeRows = await this.cypher(c, `MATCH (n:GraphNode) ${nodeWhere} RETURN count(n) AS c`, ["c"]);
            const edgeRows = await this.cypher(c, `MATCH (a:GraphNode)-[r]->(b:GraphNode) ${edgeWhere} RETURN count(r) AS c`, ["c"]);
            return {
                nodeCount: Number(ag(nodeRows[0]?.c) ?? 0),
                edgeCount: Number(ag(edgeRows[0]?.c) ?? 0),
            };
        });
    }

    // ─── writes ───────────────────────────────────────────────────────────────

    async upsertGraphNode(n: GraphNodeInput): Promise<GraphNodeRef> {
        if (!n.kind?.trim() || !n.name?.trim()) {
            throw new Error("upsertGraphNode requires non-empty kind and name");
        }
        if (!n.agentId) throw new Error("upsertGraphNode requires agentId");
        const key = nodeKeyOf(n.kind, n.name);
        return this.withAge(async (c) => {
            const existing = await this.cypher(c,
                `MATCH (e:GraphNode { node_key: ${cypherStr(key)} }) RETURN e.aliases, e.namespace`, ["aliases", "namespace"]);
            const incomingAliases = mergeAliases(n.aliases ?? [], [n.name]);
            let ref: GraphNodeRef;
            if (existing.length > 0) {
                const merged = mergeAliases(agArr(existing[0].aliases), incomingAliases);
                const namespace = normalizeNamespace(n.namespace) ?? normalizeNamespace(ag(existing[0].namespace));
                await this.cypher(c,
                    `MATCH (e:GraphNode { node_key: ${cypherStr(key)} })
                     SET e.aliases = ${cypherStrList(merged)}, e.updated_at = timestamp()${namespaceSet("e", n.namespace)}
                     RETURN e.node_key`, ["node_key"]);
                ref = { nodeKey: key, kind: n.kind, name: n.name, ...(namespace ? { namespace } : {}), aliases: merged, created: false };
            } else {
                const namespace = normalizeNamespace(n.namespace);
                await this.cypher(c,
                    `CREATE (e:GraphNode { node_key: ${cypherStr(key)}, kind: ${cypherStr(n.kind)},
                        name: ${cypherStr(n.name)}, aliases: ${cypherStrList(incomingAliases)}${namespaceProp(n.namespace)},
                        created_by: ${cypherStr(n.agentId)} }) RETURN e.node_key`, ["node_key"]);
                ref = { nodeKey: key, kind: n.kind, name: n.name, ...(namespace ? { namespace } : {}), aliases: incomingAliases, created: true };
            }
            // Node evidence = real EVIDENCED_BY edges to lazy :Fact anchors
            // (03-design §2.2). Unioned on every upsert.
            for (const sk of new Set(n.evidence ?? [])) {
                await this.linkEvidenceAnchor(c, key, sk);
            }
            return ref;
        });
    }

    async upsertGraphEdge(e: GraphEdgeInput): Promise<GraphEdgeRef> {
        if (!e.fromKey || !e.toKey) throw new Error("upsertGraphEdge requires fromKey and toKey");
        if (e.fromKey === e.toKey) throw new Error("self-referential edge rejected");
        if (!e.predicate?.trim()) throw new Error("upsertGraphEdge requires a predicate");
        if (!e.agentId) throw new Error("upsertGraphEdge requires agentId");
        const conf = e.confidence ?? 1.0;
        if (typeof conf !== "number" || conf < 0 || conf > 1) throw new Error("confidence must be in [0,1]");
        const pk = makePredicateKey(e.predicate);

        return this.withAge(async (c) => {
            // Both endpoints must exist (02 §6).
            const ends = await this.cypher(c,
                `MATCH (n:GraphNode) WHERE n.node_key IN ${cypherStrList([e.fromKey, e.toKey])}
                 RETURN n.node_key`, ["node_key"]);
            const present = new Set(ends.map((r) => ag(r.node_key)));
            for (const k of [e.fromKey, e.toKey]) {
                if (!present.has(k)) throw new Error(`upsertGraphEdge: endpoint node not found: ${k}`);
            }

            const MATCH_EDGE =
                `MATCH (a:GraphNode { node_key: ${cypherStr(e.fromKey)} })` +
                `-[rel:REL { predicate_key: ${cypherStr(pk)} }]->` +
                `(b:GraphNode { node_key: ${cypherStr(e.toKey)} })`;

            const existingRows = await this.cypher(c,
                `${MATCH_EDGE} RETURN rel.confidence, rel.observations, rel.evidence, rel.namespace`,
                ["confidence", "observations", "evidence", "namespace"]);
            const existing = existingRows.length > 0
                ? {
                    confidence: Number(ag(existingRows[0].confidence)),
                    observations: Number(ag(existingRows[0].observations)),
                    evidence: agArr(existingRows[0].evidence),
                    namespace: normalizeNamespace(ag(existingRows[0].namespace)),
                  }
                : null;

            const d = decideEdgeUpsert({ confidence: conf, evidence: e.evidence }, existing);

            if (d.action === "create") {
                await this.cypher(c,
                    `MATCH (a:GraphNode { node_key: ${cypherStr(e.fromKey)} }), (b:GraphNode { node_key: ${cypherStr(e.toKey)} })
                     CREATE (a)-[rel:REL { predicate: ${cypherStr(e.predicate)}, predicate_key: ${cypherStr(pk)},
                        confidence: ${cypherNum(d.confidence)}, observations: ${cypherNum(d.observations)},
                        asserted_by: ${cypherStrList([e.agentId])}, evidence: ${cypherStrList(d.evidence)}${namespaceProp(e.namespace)},
                        model: ${cypherStr(e.model ?? "")}, first_seen: timestamp(), last_seen: timestamp() }]->(b)
                     RETURN rel.predicate_key`, ["predicate_key"]);
            } else if (d.action === "reinforce") {
                await this.cypher(c,
                    `${MATCH_EDGE}
                     SET rel.confidence = ${cypherNum(d.confidence)}, rel.observations = ${cypherNum(d.observations)},
                         rel.evidence = ${cypherStrList(d.evidence)}, rel.last_seen = timestamp()${namespaceSet("rel", e.namespace)}
                     RETURN rel.predicate_key`, ["predicate_key"]);
            }
            // action === "noop": already-known evidence only — leave untouched (GR7).

            const namespace = normalizeNamespace(e.namespace) ?? existing?.namespace ?? undefined;
            return {
                fromKey: e.fromKey, toKey: e.toKey, predicate: e.predicate, predicateKey: pk,
                ...(namespace ? { namespace } : {}),
                confidence: d.confidence, observations: d.observations,
                reinforced: d.action === "reinforce",
            };
        });
    }

    async mergeGraphNodes(fromKey: string, intoKey: string, reason: string, opts: { namespace?: string } = {}): Promise<void> {
        await this.withAge(async (c) => {
            const ns = namespacePredicate("e", opts.namespace);
            const dup = await this.cypher(c,
                `MATCH (e:GraphNode { node_key: ${cypherStr(fromKey)} }) ${ns ? `WHERE ${ns}` : ""} RETURN e.aliases`, ["aliases"]);
            if (dup.length === 0) return; // nothing to merge
            const survivorNs = namespacePredicate("e", opts.namespace);
            const survivor = await this.cypher(c,
                `MATCH (e:GraphNode { node_key: ${cypherStr(intoKey)} }) ${survivorNs ? `WHERE ${survivorNs}` : ""} RETURN e.aliases`, ["aliases"]);
            if (survivor.length === 0) throw new Error(`mergeGraphNodes: merge target not found: ${intoKey}`);

            // 1. Union aliases onto the survivor (+ audit note).
            const merged = mergeAliases(agArr(survivor[0].aliases), agArr(dup[0].aliases));
            await this.cypher(c,
                `MATCH (s:GraphNode { node_key: ${cypherStr(intoKey)} })
                 SET s.aliases = ${cypherStrList(merged)}, s.merged_note = ${cypherStr(reason)}
                 RETURN s.node_key`, ["node_key"]);

            // 2. Repoint REL edges, HARDENED against duplicate triples (03 §7):
            //    when the survivor already has the same (other, predicate_key)
            //    edge, COMBINE (evidence union, observations sum, noisy-OR)
            //    instead of creating a second edge. AGE has no APOC refactor,
            //    so this is read-decide-write per edge.
            const repoint = async (direction: "out" | "in") => {
                const match = direction === "out"
                    ? `MATCH (d:GraphNode { node_key: ${cypherStr(fromKey)} })-[r:REL]->(t:GraphNode)`
                    : `MATCH (t:GraphNode)-[r:REL]->(d:GraphNode { node_key: ${cypherStr(fromKey)} })`;
                const rows = await this.cypher(c,
                    `${match} RETURN t.node_key, r.predicate, r.predicate_key, r.confidence, r.observations, r.evidence`,
                    ["other_key", "predicate", "predicate_key", "confidence", "observations", "evidence"]);
                for (const r of rows) {
                    const other = ag(r.other_key);
                    if (other === intoKey) continue; // dup↔survivor edge: drop, never self-loop
                    const pk = ag(r.predicate_key);
                    const fromK = direction === "out" ? intoKey : other;
                    const toK = direction === "out" ? other : intoKey;
                    const ex = await this.cypher(c,
                        `MATCH (a:GraphNode { node_key: ${cypherStr(fromK)} })-[rel:REL { predicate_key: ${cypherStr(pk)} }]->(b:GraphNode { node_key: ${cypherStr(toK)} })
                         RETURN rel.confidence, rel.observations, rel.evidence`,
                        ["confidence", "observations", "evidence"]);
                    if (ex.length > 0) {
                        // Evidence-aware combine (same principle as GR7): when the
                        // duplicate edge brings NO novel evidence, the survivor
                        // already absorbed it — drop the dup edge without summing
                        // observations / noisy-OR-ing again, so a replayed merge
                        // cannot double-count. Evidence-less duplicates can't be
                        // deduped and still combine.
                        const exEv = agArr(ex[0].evidence);
                        const dupEv = agArr(r.evidence);
                        const known = new Set(exEv);
                        const novel = dupEv.filter((e) => !known.has(e));
                        if (dupEv.length > 0 && novel.length === 0) continue;
                        const conf = reinforceConfidence(Number(ag(ex[0].confidence)), Number(ag(r.confidence)));
                        const obs = Number(ag(ex[0].observations)) + Number(ag(r.observations));
                        const ev = [...exEv, ...novel];
                        await this.cypher(c,
                            `MATCH (a:GraphNode { node_key: ${cypherStr(fromK)} })-[rel:REL { predicate_key: ${cypherStr(pk)} }]->(b:GraphNode { node_key: ${cypherStr(toK)} })
                             SET rel.confidence = ${cypherNum(clamp01(conf))}, rel.observations = ${cypherNum(obs)},
                                 rel.evidence = ${cypherStrList(ev)}
                             RETURN rel.predicate_key`, ["predicate_key"]);
                    } else {
                        await this.cypher(c,
                            `MATCH (a:GraphNode { node_key: ${cypherStr(fromK)} }), (b:GraphNode { node_key: ${cypherStr(toK)} })
                             CREATE (a)-[rel:REL { predicate: ${cypherStr(ag(r.predicate))}, predicate_key: ${cypherStr(pk)},
                                confidence: ${cypherNum(Number(ag(r.confidence)))}, observations: ${cypherNum(Number(ag(r.observations)))},
                                evidence: ${cypherStrList(agArr(r.evidence))} }]->(b)
                             RETURN rel.predicate_key`, ["predicate_key"]);
                    }
                }
            };
            await repoint("out");
            await repoint("in");

            // 3. Repoint node evidence (EVIDENCED_BY anchors) onto the survivor.
            const anchors = await this.cypher(c,
                `MATCH (d:GraphNode { node_key: ${cypherStr(fromKey)} })-[:EVIDENCED_BY]->(f:Fact)
                 RETURN f.scope_key`, ["scope_key"]);
            for (const r of anchors) {
                await this.linkEvidenceAnchor(c, intoKey, ag(r.scope_key));
            }

            // 4. Remove the duplicate (and all its remaining edges).
            await this.cypher(c,
                `MATCH (d:GraphNode { node_key: ${cypherStr(fromKey)} }) DETACH DELETE d`, []);
        });
    }

    async deleteGraphNode(nodeKey: string, opts: { namespace?: string } = {}): Promise<boolean> {
        return this.withAge(async (c) => {
            const ns = namespacePredicate("e", opts.namespace);
            const exists = await this.cypher(c,
                `MATCH (e:GraphNode { node_key: ${cypherStr(nodeKey)} }) ${ns ? `WHERE ${ns}` : ""} RETURN e.node_key`, ["node_key"]);
            if (exists.length === 0) return false;
            await this.cypher(c,
                `MATCH (e:GraphNode { node_key: ${cypherStr(nodeKey)} }) ${ns ? `WHERE ${ns}` : ""} DETACH DELETE e`, []);
            return true;
        });
    }

    async deleteGraphEdge(fromKey: string, toKey: string, predicateKey: string, opts: { namespace?: string } = {}): Promise<boolean> {
        return this.withAge(async (c) => {
            const MATCH =
                `MATCH (a:GraphNode { node_key: ${cypherStr(fromKey)} })` +
                `-[r:REL { predicate_key: ${cypherStr(predicateKey)} }]->` +
                `(b:GraphNode { node_key: ${cypherStr(toKey)} })`;
            const ns = edgeNamespacePredicate(opts.namespace);
            const where = ns ? ` WHERE ${ns}` : "";
            const exists = await this.cypher(c, `${MATCH}${where} RETURN r.predicate_key`, ["predicate_key"]);
            if (exists.length === 0) return false;
            await this.cypher(c, `${MATCH}${where} DELETE r`, []);
            return true;
        });
    }
}
