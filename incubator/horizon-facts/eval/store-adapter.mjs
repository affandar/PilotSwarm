// eval/store-adapter.mjs — the "enhanced API" surface the harvester tools call.
//
// This adapter is the boundary between the LLM-facing tool layer and the
// incubating HorizonFactStore. It presents the NEW enhanced-API shape described
// in docs/proposals/enhancedfactstore (search_facts / graph nodes+edges / crawl
// tracking) on top of the store's CURRENT method names. When the store is
// renamed to the new API, this adapter collapses to thin pass-throughs.
//
// Two genuinely-additive pieces are implemented here because the current store
// predates them:
//   • crawl tracking (last_crawled_at)  → modeled with marker facts
//     ("_crawlmark/<key>"). Production uses the real column + trigger.
//   • node EVIDENCED_BY readback        → the current searchEntities() doesn't
//     return evidence; upsert_graph_node still links it into the graph via
//     store.linkEvidence(), and edges DO carry evidence, which is what the eval
//     asserts on.

const ACCESS = { unrestricted: true };

export class EnhancedFactsAdapter {
    /**
     * @param {import("../dist/src/index.js").HorizonFactStore} store
     * @param {{ runId: string, namespace: string, agentId?: string }} opts
     */
    constructor(store, opts) {
        this.store = store;
        this.runId = opts.runId;
        this.namespace = opts.namespace;             // e.g. archive/pgsql-hackers/<runId>
        this.agentId = opts.agentId ?? "pg-mailing-list-harvester";
    }

    // ── facts retrieval ──────────────────────────────────────────────────────

    /** facts_search — query text → ranked facts over the facts store only. */
    async searchFacts({ query, mode, namespace, limit }) {
        // The eval store is configured without an embedding endpoint, so semantic
        // mode is unavailable; default to lexical. (Production: hybrid default.)
        const effectiveMode = mode === "semantic" || mode === "hybrid" ? "lexical" : (mode ?? "lexical");
        const res = await this.store.searchFacts(
            String(query ?? ""),
            { mode: effectiveMode, namespace: namespace ?? this.namespace, limit: limit ?? 10 },
            ACCESS,
        );
        return {
            count: res.count,
            mode: res.mode,
            facts: res.facts.map((f) => ({
                scopeKey: scopeKeyOf(f), key: f.key, value: f.value, tags: f.tags, score: f.score,
            })),
        };
    }

    // ── crawl queue (last_crawled_at modeled with marker facts) ──────────────

    /** facts_read_uncrawled — facts in the namespace with no crawl mark. */
    async readUncrawled({ namespace, limit } = {}) {
        const ns = namespace ?? this.namespace;
        const [corpus, marks] = await Promise.all([
            this.store.readFacts({ keyPattern: `${ns}/%`, scope: "shared", limit: 1000 }, ACCESS),
            this.store.readFacts({ keyPattern: `_crawlmark/${ns}/%`, scope: "shared", limit: 1000 }, ACCESS),
        ]);
        const marked = new Set(marks.facts.map((m) => m.key.replace(/^_crawlmark\//, "")));
        const pending = corpus.facts
            .filter((f) => !marked.has(f.key))
            .slice(0, limit ?? 20)
            .map((f) => ({ scopeKey: scopeKeyOf(f), key: f.key, value: f.value, tags: f.tags }));
        return { count: pending.length, facts: pending };
    }

    /** facts_mark_crawled — stamp facts incorporated so they leave the queue. */
    async markCrawled({ scopeKeys }) {
        const keys = Array.isArray(scopeKeys) ? scopeKeys : [];
        let marked = 0;
        for (const sk of keys) {
            const key = String(sk).replace(/^shared:/, "");
            await this.store.storeFact({
                key: `_crawlmark/${key}`, value: { crawledAt: new Date().toISOString() },
                shared: true, tags: ["_crawlmark"], agentId: this.agentId,
            });
            marked++;
        }
        return { marked };
    }

    // ── graph read ───────────────────────────────────────────────────────────

    /** graph_search_nodes — resolve a node by kind/nameLike (the dedup probe). */
    async searchGraphNodes({ kind, nameLike, seeds, depth, limit }) {
        const hits = await this.store.searchEntities({ kind, nameLike, limit: limit ?? 20 });
        let nodes = hits.map((h) => ({
            nodeKey: h.entityKey, kind: h.kind, name: h.name, aliases: h.aliases, evidence: [],
        }));
        // Best-effort seed expansion for node-key seeds (fact-key pivot needs the
        // new-API EVIDENCED_BY read, which the current store doesn't expose).
        if (Array.isArray(seeds) && seeds.length) {
            for (const s of seeds) {
                if (typeof s === "string" && s.includes(":") && !s.startsWith("shared:") && !s.startsWith("session:")) {
                    try {
                        const sub = await this.store.neighbourhood(s, depth ?? 1);
                        for (const n of sub.nodes) {
                            if (!nodes.some((x) => x.nodeKey === n.entityKey)) {
                                nodes.push({ nodeKey: n.entityKey, kind: n.kind, name: n.name, aliases: [], evidence: [] });
                            }
                        }
                    } catch { /* unknown seed → ignore */ }
                }
            }
        }
        return nodes;
    }

    /** graph_search_edges — anchor-and-explore or exact-predicate. */
    async searchGraphEdges({ predicate, predicateKey, fromKey, toKey, minConfidence, limit }) {
        const hits = await this.store.searchRelationships({
            predicate, predicateKey, fromKey, toKey, minConfidence, limit: limit ?? 50,
        });
        return hits;
    }

    /** graph_neighbourhood — bounded subgraph around a node. */
    async graphNeighbourhood({ nodeKey, depth }) {
        return this.store.neighbourhood(nodeKey, depth ?? 1);
    }

    // ── graph write ──────────────────────────────────────────────────────────

    /** graph_upsert_node — create/merge a node; links evidence into the graph. */
    async upsertGraphNode({ kind, name, aliases, evidence }) {
        const ref = await this.store.upsertEntity({
            kind, name, aliases: aliases ?? [], evidence: evidence ?? [], agentId: this.agentId,
        });
        if (Array.isArray(evidence) && evidence.length) {
            try { await this.store.linkEvidence(ref.entityKey, evidence); } catch { /* non-fatal */ }
        }
        return { nodeKey: ref.entityKey, kind: ref.kind, name: ref.name, aliases: ref.aliases, created: ref.created };
    }

    /** graph_upsert_edge — assert/reinforce a free-text relationship. */
    async upsertGraphEdge({ fromKey, toKey, predicate, confidence, evidence }) {
        const ev = Array.isArray(evidence) ? evidence : [];
        if (ev.length === 0) {
            // The current store enforces mandatory evidence; surface a helpful
            // message so the model corrects itself instead of failing opaquely.
            throw new Error("evidence is required: pass the source fact scope_key(s) that justify this edge.");
        }
        const ref = await this.store.assertRelationship({
            fromKey, toKey, predicate, confidence: confidence ?? 1.0, evidence: ev,
            agentId: this.agentId, model: "eval-harvester",
        });
        return ref;
    }

    // ── seeding / teardown helpers (used by the runner, not the agent) ────────

    async seedCorpus(messages) {
        for (const m of messages) {
            await this.store.storeFact({
                key: `${this.namespace}/msg/${m.id}`,
                value: { from: m.from, subject: m.subject, body: m.body },
                shared: true, tags: ["pgsql-hackers", "archive"], agentId: "eval-seed",
            });
        }
    }
}

function scopeKeyOf(f) {
    // FactRecord doesn't carry scope_key; reconstruct it from shared/session/key.
    if (f.shared) return `shared:${f.key}`;
    if (f.sessionId) return `session:${f.sessionId}:${f.key}`;
    return `shared:${f.key}`;
}
