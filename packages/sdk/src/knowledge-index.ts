import type { FactStore } from "./facts-store.js";

export interface KnowledgeIndexSkill {
    key: string;
    name: string;
    description: string;
}

export interface KnowledgeIndexAsk {
    key: string;
    summary: string;
}

export interface KnowledgeIndex {
    skills: KnowledgeIndexSkill[];
    asks: KnowledgeIndexAsk[];
}

function normalizeBlock(text?: string | null): string | undefined {
    const value = (text ?? "").trim();
    return value || undefined;
}

export async function loadKnowledgeIndexFromFactStore(
    factStore: FactStore,
    cap = 50,
    opts: { includeSkills?: boolean } = {},
): Promise<KnowledgeIndex> {
    const includeSkills = opts.includeSkills ?? true;
    const skills: KnowledgeIndexSkill[] = [];
    // Enhanced-retrieval sessions PULL ranked skills via `search_skills` every
    // turn (07 §1.6), so they pass includeSkills:false — skip the capped-50
    // skills read entirely rather than reading then discarding it.
    if (includeSkills) {
        const skillResult = await factStore.readFacts(
            { keyPattern: "skills/%", scope: "shared", limit: cap },
            { readerSessionId: null, grantedSessionIds: [] },
        );
        if (skillResult?.facts?.length) {
            for (const row of skillResult.facts) {
                const val = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
                if (val?.status === "aged-out") continue;
                skills.push({
                    key: row.key,
                    name: val?.name ?? row.key?.replace("skills/", "").replace(/\//g, "-") ?? "unknown",
                    description: val?.description ?? "",
                });
            }
        }
    }

    const askResult = await factStore.readFacts(
        { keyPattern: "asks/%", scope: "shared", limit: cap },
        { readerSessionId: null, grantedSessionIds: [] },
    );
    const asks: KnowledgeIndexAsk[] = [];
    if (askResult?.facts?.length) {
        for (const row of askResult.facts) {
            const val = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
            if (val?.status !== "open") continue;
            asks.push({
                key: row.key,
                summary: val?.summary ?? "",
            });
        }
    }

    if (skills.length + asks.length > cap) {
        const skillCap = Math.min(skills.length, Math.floor(cap * 0.7));
        const askCap = cap - skillCap;
        skills.splice(skillCap);
        asks.splice(askCap);
    }

    return { skills, asks };
}

export function buildKnowledgePromptBlocks(knowledgeIndex: KnowledgeIndex, opts: { includeNamespaceRules?: boolean } = {}): {
    askBlock?: string;
    skillBlock?: string;
} {
    const includeNamespaceRules = opts.includeNamespaceRules ?? true;
    const namespaceRules =
        `\n\n[FACT NAMESPACE RULES]\n` +
        `- You can WRITE to: intake/<topic>/<session-id> (shared observations)\n` +
        `- You can READ from: skills/*, asks/* (curated knowledge, open requests)\n` +
        `- You CANNOT write to skills/ or asks/ (Facts Manager only)\n` +
        `- You CANNOT read from intake/ (Facts Manager only)`;
    const askBlock = knowledgeIndex.asks.length > 0
        ? `[ACTIVE FACT REQUESTS]\n` +
            `The Facts Manager is seeking corroboration on these topics.\n` +
            `If any are relevant to your current task, read the full ask\n` +
            `with read_facts and contribute intake evidence if you can.\n` +
            `${knowledgeIndex.asks.map((a) => `- ${a.key}`).join("\n")}` +
            (includeNamespaceRules ? namespaceRules : "")
        : undefined;

    const skillBlock = knowledgeIndex.skills.length > 0
        ? `[CURATED SKILLS]\n` +
            `The following shared skills are available. If one is relevant to your current task,\n` +
            `call read_facts(key_pattern="<key>", scope="shared") to load the full instructions before applying.\n\n` +
            `${knowledgeIndex.skills.map((s) => `- ${s.key} — ${s.name}: ${s.description}`).join("\n")}`
        : undefined;

    return {
        askBlock: normalizeBlock(askBlock),
        skillBlock: normalizeBlock(skillBlock),
    };
}

export function mergePromptBlocks(parts: Array<string | null | undefined>): string | undefined {
    const normalized = parts
        .map((part) => normalizeBlock(part))
        .filter((part): part is string => Boolean(part));
    return normalized.length > 0 ? normalized.join("\n\n") : undefined;
}

/**
 * Enhanced-retrieval instruction block (enhancedfactstore 07 §1.6). Replaces the
 * capped-50 skills PUSH when the store is an EnhancedFactStore with search: the
 * agent PULLS the most relevant curated skills with `search_skills` every turn,
 * and can retrieve its own memory with `facts_search` / `facts_similar` instead
 * of only literal-key `read_facts` scans. Intake-writing rules are unchanged.
 *
 * `semantic` reflects whether an embedder is available (capabilities.embedder /
 * durable embedder running). When false, the store still offers enhanced
 * lexical search and HYBRID degrades to lexical — so the block must NOT promise
 * semantic recall (an explicit semantic request would error). The retrieval
 * tools are named either way; only the wording about meaning-based recall is
 * gated.
 */
export function buildEnhancedRetrievalPromptBlock(opts: { semantic: boolean } = { semantic: true }): string {
    const header = opts.semantic
        ? `[KNOWLEDGE RETRIEVAL — semantic search available]`
        : `[KNOWLEDGE RETRIEVAL — enhanced lexical search]`;
    const recallLine = opts.semantic
        ? `Beyond skills, you can recall your OWN facts/memory with facts_search (lexical / semantic\n` +
          `/ hybrid) and facts_similar — semantic and hybrid recall over your whole accessible\n` +
          `corpus is often more effective than a literal read_facts key-pattern scan.\n\n`
        : `Beyond skills, you can recall your OWN facts/memory with facts_search (use mode "lexical"\n` +
          `or "hybrid"; no embedder is configured, so semantic mode is unavailable and hybrid runs\n` +
          `as lexical) — ranked full-text recall is often better than a literal read_facts scan.\n\n`;
    return (
        `${header}\n` +
        `Curated skills are NOT pre-listed for you. At the START of every turn, call\n` +
        `search_skills(query="<derived from your current task>") to pull the most relevant\n` +
        `shared skills (e.g. "azure deployment errors", "horizondb connection"). Call it more\n` +
        `than once for different facets of the task. Load a returned skill's full instructions\n` +
        `with read_facts(key_pattern="<key>", scope="shared") before applying it.\n` +
        recallLine +
        `[FACT NAMESPACE RULES]\n` +
        `- You can WRITE to: intake/<topic>/<session-id> (shared observations)\n` +
        `- You can READ from: skills/*, asks/* (curated knowledge, open requests)\n` +
        `- You CANNOT write to skills/ or asks/ (Facts Manager only)\n` +
        `- You CANNOT read from intake/ (Facts Manager only)`
    );
}


/**
 * Graph-reader instruction block (enhancedfactstore 07 §1.5/§1.6). Lights up
 * whenever a graph store is configured — including base-facts + graph. The
 * semantic-seed sentence is included only when the facts axis is enhanced (so a
 * reader can pivot from semantically-found facts into the graph); base-facts +
 * graph still gets the graph read tools, just without that sentence.
 */
export function buildGraphReaderPromptBlock(opts: { semanticSeed: boolean }): string {
    const seedLine = opts.semanticSeed
        ? `From facts you found (their scope keys), seed graph_search_nodes({ seeds: [...] }) to pull\n` +
          `connected entities and relationships.\n`
        : ``;
    return (
        `[KNOWLEDGE GRAPH — read access]\n` +
        `A shared knowledge graph of entities and relationships is available. Explore it with\n` +
        `graph_search_nodes (by name/kind/seed), graph_search_edges, and graph_neighbourhood.\n` +
        seedLine +
        `Graph reads honour the same visibility as your facts — you only see nodes/edges your\n` +
        `accessible facts evidence.`
    );
}
