/**
 * E1 + E4 (enhancedfactstore 07 §1.5): capability × role tool-registration and
 * prompt-adaptation matrix, asserted END-TO-END through the REAL SessionManager
 * (not the createFactTools/createGraphTools factories in isolation —
 * graph-tools-gating.test.js already covers those).
 *
 * This closes the "session-manager gating" half of the earlier MED#9: it proves
 * that SessionManager's own gating expressions
 *   - enhancedFactStore = isEnhancedFactStore(store) && caps.search
 *   - graphTools registered iff !!graphStore
 *   - the agent-tuner read-only `.filter(...)`
 * compose correctly across the three orthogonal axes (facts capability, graph
 * presence, session role) and feed the factories the right inputs.
 *
 * DB-less: a FakeCopilotClient captures the exact tool list + structured system
 * message handed to session creation, and fake stores stand in for the providers
 * (the factories do no I/O at registration time). No LLM, no Postgres.
 *
 * Run: node --env-file=../../.env ../../node_modules/vitest/vitest.mjs run \
 *      test/local/enhanced-tool-gating.test.js
 */

import { describe, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { SessionManager } from "../../src/session-manager.ts";
import { isEnhancedFactStore } from "../../src/index.ts";
import { assert, assertEqual } from "../helpers/assertions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Fakes ───────────────────────────────────────────────────────────────────
// Minimal but faithful: the enhanced fake satisfies isEnhancedFactStore() and
// the base fake deliberately does NOT (no search/embedder methods), so the
// SessionManager gating sees them exactly as it would the real providers.

function baseFactSurface() {
    return {
        async initialize() {},
        async close() {},
        async storeFact(i) { return { key: i.key, shared: i.shared === true, stored: true }; },
        async readFacts() { return { count: 0, facts: [] }; },
        async deleteFact(i) { return { key: i.key, shared: i.shared === true, deleted: true }; },
        async deleteSessionFactsForSession() { return 0; },
        async getSessionFactsStats() { return []; },
        async getFactsStatsForSessions() { return []; },
        async getSharedFactsStats() { return []; },
        async readUncrawledFacts() { return { count: 0, facts: [] }; },
        async markFactsCrawled() { return { marked: 0, skipped: 0 }; },
    };
}

function fakeBaseStore() {
    // A plain FactStore — isEnhancedFactStore(...) MUST be false.
    return baseFactSurface();
}

function fakeEnhancedStore(caps = { search: true, embedder: true }) {
    return {
        ...baseFactSurface(),
        capabilities: caps,
        async searchFacts() { return { count: 0, mode: "hybrid", facts: [] }; },
        async similarFacts() { return { count: 0, mode: "semantic", facts: [] }; },
        async configureEmbedder() { return { running: false }; },
        async startEmbedder() { return { running: true }; },
        async stopEmbedder() { return { running: false }; },
        async embedderStatus() { return { running: false }; },
    };
}

function fakeGraphStore() {
    return {
        async initialize() {}, async close() {},
        async searchGraphNodes() { return []; },
        async searchGraphEdges() { return []; },
        async graphNeighbourhood() { return { nodes: [], edges: [] }; },
        async upsertGraphNode() { return {}; },
        async upsertGraphEdge() { return {}; },
        async mergeGraphNodes() {},
        async deleteGraphNode() { return true; },
        async deleteGraphEdge() { return true; },
    };
}

function noopCatalog() {
    return {
        async initialize() {}, async createSession() {}, async updateSession() {},
        async softDeleteSession() {}, async listSessions() { return []; },
        async getSession() { return null; }, async getDescendantSessionIds() { return []; },
        async getLastSessionId() { return null; }, async recordEvents() {},
        async getSessionEvents() { return []; }, async getSessionEventsBefore() { return []; },
        async getSessionMetricSummary() { return null; }, async getSessionTreeStats() { return null; },
        async getFleetStats() { return { totals: {}, perAgent: [] }; },
    };
}

class FakeCopilotSession {
    registeredToolSnapshots = [];
    on() {} off() {}
    async send() {} async sendAndWait() { return ""; }
    registerTools(tools) { this.registeredToolSnapshots.push((tools ?? []).map((t) => t.name)); }
    abort() {}
}

class FakeCopilotClient {
    createdSessionConfigs = [];
    session = new FakeCopilotSession();
    async createSession(config) { this.createdSessionConfigs.push(config); return this.session; }
    async resumeSession(_id, config) { this.createdSessionConfigs.push(config); return this.session; }
    async deleteSession() {} async stop() {}
}

// Build a fresh SessionManager wired with the given stores, create one session
// with the given role, and return the captured tool names + system message.
let stateDir;
beforeEach(() => { stateDir = mkdtempSync(path.join(tmpdir(), "ps-e1-")); });
afterEach(() => { if (stateDir) try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* best-effort */ } });

async function register({ factStore, graphStore, agentIdentity, isHarvester, workerDefaults }) {
    const manager = new SessionManager(process.env.GITHUB_TOKEN, null, workerDefaults ?? {}, stateDir);
    const fakeClient = new FakeCopilotClient();
    manager.client = fakeClient;
    if (factStore) manager.setFactStore(factStore);
    if (graphStore) manager.setGraphStore(graphStore);
    manager.setSessionCatalog(noopCatalog());
    const sid = `e1-${agentIdentity ?? "default"}-${isHarvester ? "harv" : "x"}-${Math.random().toString(36).slice(2, 8)}`;
    await manager.getOrCreate(sid, {
        agentIdentity: agentIdentity ?? "default",
        ...(isHarvester ? { isHarvester: true } : {}),
        toolNames: [],
    }, { turnIndex: 0 });
    const cfg = fakeClient.createdSessionConfigs[0] ?? {};
    const toolNames = (cfg.tools ?? []).map((t) => t.name);
    // No tool may be registered twice — a Set would silently mask a duplicate
    // (e.g. a fact tool also leaking through the user-tool path).
    assertEqual(toolNames.length, new Set(toolNames).size,
        `no duplicate tool registration (${agentIdentity ?? "default"})`);
    return {
        names: new Set(toolNames),
        toolNames,
        systemMessage: cfg.systemMessage,
    };
}

const SEARCH_TOOLS = ["facts_search", "facts_similar", "search_skills"];
const GRAPH_READS = ["graph_search_nodes", "graph_search_edges", "graph_neighbourhood"];
const GRAPH_WRITES = ["graph_upsert_node", "graph_upsert_edge", "graph_merge_nodes", "graph_delete_node", "graph_delete_edge"];
const CRAWL_TOOLS = ["facts_read_uncrawled", "facts_mark_crawled"];

const hasAll = (set, names) => names.every((n) => set.has(n));
const hasNone = (set, names) => names.every((n) => !set.has(n));

// ─── E4: capability sanity — the fakes model the real guard ──────────────────
describe("E4: isEnhancedFactStore guard distinguishes the fakes", () => {
    it("base fake → not enhanced; enhanced fake → enhanced", () => {
        assertEqual(isEnhancedFactStore(fakeBaseStore()), false, "base fake must read as a plain FactStore");
        assertEqual(isEnhancedFactStore(fakeEnhancedStore()), true, "enhanced fake must read as an EnhancedFactStore");
    });
});

// ─── E4: base store, no graph — today's surface, nothing new ─────────────────
describe("E4: base store + no graph (capability-limited)", () => {
    it("every role gets base KV tools and NONE of search/graph/crawl", async () => {
        for (const role of ["default", "facts-manager", "agent-tuner"]) {
            const { names } = await register({ factStore: fakeBaseStore(), agentIdentity: role });
            // read_facts is always present; store/delete are stripped for the
            // read-only agent-tuner but present for ordinary + facts-manager.
            assert(names.has("read_facts"), `${role}: read_facts present`);
            if (role === "agent-tuner") {
                assert(!names.has("store_fact") && !names.has("delete_fact"), "agent-tuner: no fact mutation");
            } else {
                assert(names.has("store_fact") && names.has("delete_fact"), `${role}: base KV write tools present`);
            }
            assert(hasNone(names, SEARCH_TOOLS), `${role}: no enhanced search tools on a base store`);
            assert(hasNone(names, [...GRAPH_READS, ...GRAPH_WRITES, ...CRAWL_TOOLS, "graph_stats"]),
                `${role}: no graph tools without a graphStore`);
        }
    });

    it("an opt-in harvester on a base/no-graph deployment still gets NO graph/crawl tools", async () => {
        const { names } = await register({ factStore: fakeBaseStore(), agentIdentity: "app-harvester", isHarvester: true });
        assert(hasNone(names, [...GRAPH_READS, ...GRAPH_WRITES, ...CRAWL_TOOLS]),
            "graph/crawl tools require !!graphStore, never the harvester flag alone");
    });
});

// ─── E1: enhanced store (search), no graph ───────────────────────────────────
describe("E1: enhanced facts (search) + no graph", () => {
    it("default reader → search tools, still NO graph tools", async () => {
        const { names } = await register({ factStore: fakeEnhancedStore(), agentIdentity: "default" });
        assert(hasAll(names, SEARCH_TOOLS), "reader gets facts_search/facts_similar/search_skills");
        assert(hasNone(names, [...GRAPH_READS, "graph_stats", ...GRAPH_WRITES, ...CRAWL_TOOLS]),
            "no graph tools without a graphStore");
    });

    it("facts-manager → facts_search but NOT search_skills (owns the skills namespace)", async () => {
        const { names } = await register({ factStore: fakeEnhancedStore(), agentIdentity: "facts-manager" });
        assert(names.has("facts_search") && names.has("facts_similar"), "facts-manager gets retrieval");
        assert(!names.has("search_skills"), "facts-manager does NOT get search_skills");
    });

    it("agent-tuner → read-only enhanced set, no mutating system tools", async () => {
        const { names } = await register({ factStore: fakeEnhancedStore(), agentIdentity: "agent-tuner" });
        assert(hasAll(names, ["read_facts", ...SEARCH_TOOLS]), "tuner keeps the full read surface");
        assert(!names.has("store_fact") && !names.has("delete_fact"), "tuner gets no fact mutation");
        assert(!names.has("update_session_summary") && !names.has("send_session_message"),
            "tuner gets no mutating system tools");
    });

    it("caps.search=false → enhanced store still yields NO search tools", async () => {
        const { names } = await register({
            factStore: fakeEnhancedStore({ search: false, embedder: true }),
            agentIdentity: "default",
        });
        assert(hasNone(names, SEARCH_TOOLS), "search tools gated off when caps.search is false");
    });

    it("search=true, embedder=FALSE → search tools STILL register (gating keys off search, not embedder)", async () => {
        // Regression guard: SessionManager gates enhanced search on
        // `capabilities.search` ALONE. If it ever also required
        // `capabilities.embedder`, a lexical-only enhanced store would silently
        // lose facts_search/facts_similar/search_skills. The embedder only
        // affects semantic ranking + prompt wording (asserted in E1b), never
        // whether the search tools exist.
        const { names } = await register({
            factStore: fakeEnhancedStore({ search: true, embedder: false }),
            agentIdentity: "default",
        });
        assert(hasAll(names, SEARCH_TOOLS), "search tools present on a search-capable, embedder-less store");
    });

    it("search=true, embedder=FALSE → facts-manager exclusion of search_skills is preserved", async () => {
        const { names } = await register({
            factStore: fakeEnhancedStore({ search: true, embedder: false }),
            agentIdentity: "facts-manager",
        });
        assert(names.has("facts_search") && names.has("facts_similar"), "facts-manager keeps retrieval without an embedder");
        assert(!names.has("search_skills"), "facts-manager still excluded from search_skills regardless of embedder");
    });
});

// ─── E1: enhanced store + graph — the full surface ───────────────────────────
describe("E1: enhanced facts (search) + graph", () => {
    const enh = () => fakeEnhancedStore();
    const g = () => fakeGraphStore();

    it("default reader → search + graph reads + graph write/delete, NO stats/crawl", async () => {
        const { names } = await register({ factStore: enh(), graphStore: g(), agentIdentity: "default" });
        assert(hasAll(names, SEARCH_TOOLS), "reader keeps search tools");
        assert(hasAll(names, GRAPH_READS), "reader gets graph read tools");
        assert(hasAll(names, GRAPH_WRITES), "reader now gets graph write/delete (shared-graph writes open to every non-tuner session)");
        assert(!names.has("graph_stats"), "ordinary reader gets no graph_stats");
        assert(hasNone(names, CRAWL_TOOLS), "reader gets no crawl queue (harvester/facts-manager only)");
    });

    it("facts-manager → graph reads + graph_stats + harvester tools (dormant)", async () => {
        const { names } = await register({ factStore: enh(), graphStore: g(), agentIdentity: "facts-manager" });
        assert(hasAll(names, GRAPH_READS), "facts-manager gets graph reads");
        assert(names.has("graph_stats"), "facts-manager gets graph_stats");
        assert(hasAll(names, CRAWL_TOOLS), "facts-manager holds the crawl queue (dormant)");
        assert(hasAll(names, GRAPH_WRITES), "facts-manager holds graph write/delete (dormant)");
    });

    it("agent-tuner → reads + graph_stats, NEVER write/crawl/delete", async () => {
        const { names } = await register({ factStore: enh(), graphStore: g(), agentIdentity: "agent-tuner" });
        assert(hasAll(names, GRAPH_READS), "tuner gets graph reads");
        assert(names.has("graph_stats"), "tuner gets graph_stats");
        assert(hasNone(names, GRAPH_WRITES), "tuner gets NO graph writes/deletes");
        assert(hasNone(names, CRAWL_TOOLS), "tuner gets NO crawl queue");
    });

    it("opt-in harvester role → reads + crawl queue + graph write/delete", async () => {
        const { names } = await register({ factStore: enh(), graphStore: g(), agentIdentity: "app-harvester", isHarvester: true });
        assert(hasAll(names, GRAPH_READS), "harvester gets graph reads");
        assert(hasAll(names, CRAWL_TOOLS), "harvester gets the crawl queue");
        assert(hasAll(names, GRAPH_WRITES), "harvester gets graph write/delete");
        assert(!names.has("graph_stats"), "harvester does not need graph_stats (that is a reporter tool)");
    });
});

// ─── manage_embedder: control-plane tool gated to facts-manager × embedder cap ─
//   The durable embedder loop is a shared fleet-wide resource, so its lifecycle
//   tool is restricted to the singleton Facts Manager AND requires the store to
//   actually have the embedder capability. Orthogonal to `search`.
describe("manage_embedder gating (capability × role)", () => {
    const EMBEDDER_TOOL = "manage_embedder";

    it("facts-manager + embedder capability → manage_embedder present", async () => {
        const { names } = await register({
            factStore: fakeEnhancedStore({ search: true, embedder: true }),
            agentIdentity: "facts-manager",
        });
        assert(names.has(EMBEDDER_TOOL), "facts-manager on an embedder-capable store gets manage_embedder");
    });

    it("facts-manager WITHOUT embedder capability → no manage_embedder", async () => {
        const { names } = await register({
            factStore: fakeEnhancedStore({ search: true, embedder: false }),
            agentIdentity: "facts-manager",
        });
        assert(!names.has(EMBEDDER_TOOL), "manage_embedder gated off when caps.embedder is false");
    });

    it("embedder-only store (search=false) → facts-manager STILL gets manage_embedder", async () => {
        // The control tool keys off `embedder`, not `search`: a deployment can
        // run the embedder loop to populate vectors even if the search tools are
        // gated off. SessionManager must pass the enhanced store through on the
        // embedder capability alone.
        const { names } = await register({
            factStore: fakeEnhancedStore({ search: false, embedder: true }),
            agentIdentity: "facts-manager",
        });
        assert(names.has(EMBEDDER_TOOL), "manage_embedder present on an embedder-capable, search-less store");
        assert(hasNone(names, SEARCH_TOOLS), "search tools still gated off when caps.search is false");
    });

    it("non-facts-manager roles NEVER get manage_embedder (control-plane restriction)", async () => {
        for (const role of ["default", "agent-tuner", "app-harvester"]) {
            const { names } = await register({
                factStore: fakeEnhancedStore({ search: true, embedder: true }),
                agentIdentity: role,
                ...(role === "app-harvester" ? { isHarvester: true } : {}),
            });
            assert(!names.has(EMBEDDER_TOOL), `${role}: manage_embedder is facts-manager-only`);
        }
    });

    it("base (non-enhanced) store → no manage_embedder for any role", async () => {
        for (const role of ["default", "facts-manager", "agent-tuner"]) {
            const { names } = await register({ factStore: fakeBaseStore(), agentIdentity: role });
            assert(!names.has(EMBEDDER_TOOL), `${role}: a base FactStore exposes no embedder control`);
        }
    });
});

// ─── E1: base facts + graph — the composition tier (graph keys off !!graphStore) ─
describe("E1: base facts + graph (composition tier)", () => {
    it("reader gets the FULL graph read surface but NO search tools", async () => {
        const { names } = await register({ factStore: fakeBaseStore(), graphStore: fakeGraphStore(), agentIdentity: "default" });
        assert(hasAll(names, GRAPH_READS), "graph reads light up off !!graphStore, independent of facts capability");
        assert(hasNone(names, SEARCH_TOOLS), "a base fact store yields no search tools even with a graph present");
    });

    it("harvester on base facts + graph gets crawl + graph write, still NO search tools", async () => {
        const { names } = await register({ factStore: fakeBaseStore(), graphStore: fakeGraphStore(), agentIdentity: "app-harvester", isHarvester: true });
        assert(hasAll(names, [...CRAWL_TOOLS, ...GRAPH_WRITES]), "base crawl queue + graph write drive an incremental harvest");
        assert(hasNone(names, SEARCH_TOOLS), "no search tools on a base store");
    });
});

// ─── E1c: agent-tuner read-only invariant (design §1.5) ──────────────────────
// The tuner is the privileged READ investigator: it must NEVER receive a
// mutating tool — not a fact write, not a graph write/delete/merge, not the
// crawl queue, not a mutating system tool — regardless of capability tier and
// EVEN IF a stale/forged config sets isHarvester:true. A regression that leaked
// any of these onto the tuner would be a privilege escalation, so this is an
// explicit, named invariant rather than a side-assertion.
describe("E1c: agent-tuner is strictly read-only (never a mutating tool)", () => {
    const FACT_WRITES = ["store_fact", "delete_fact"];
    const MUTATING_SYSTEM = ["update_session_summary", "send_session_message", "reply_session_message"];
    // Sub-agent / lifecycle controls the tuner must NEVER receive. The tuner is
    // allowed ONLY the read members check_agents + list_sessions (session-manager
    // readOnlyTunerSubAgentToolNames); everything else here is a mutation.
    const MUTATING_SUBAGENT = [
        "spawn_agent", "message_agent", "wait_for_agents",
        "complete_agent", "cancel_agent", "delete_agent",
    ];
    const ALL_MUTATIONS = [...FACT_WRITES, ...GRAPH_WRITES, ...CRAWL_TOOLS, ...MUTATING_SYSTEM, ...MUTATING_SUBAGENT];

    const tiers = [
        { label: "base facts, no graph", factStore: () => fakeBaseStore(), graph: false },
        { label: "enhanced facts, no graph", factStore: () => fakeEnhancedStore(), graph: false },
        { label: "base facts + graph", factStore: () => fakeBaseStore(), graph: true },
        { label: "enhanced facts + graph", factStore: () => fakeEnhancedStore(), graph: true },
    ];

    for (const tier of tiers) {
        it(`tuner gets ZERO mutating tools — ${tier.label}`, async () => {
            const { names } = await register({
                factStore: tier.factStore(),
                graphStore: tier.graph ? fakeGraphStore() : undefined,
                agentIdentity: "agent-tuner",
            });
            for (const tool of ALL_MUTATIONS) {
                assert(!names.has(tool), `agent-tuner must NOT have '${tool}' (${tier.label})`);
            }
            // Sanity: it still IS a functioning reader in this tier.
            assert(names.has("read_facts"), `tuner keeps read_facts (${tier.label})`);
            // And it keeps its two read-only sub-agent inspectors.
            assert(names.has("check_agents") && names.has("list_sessions"),
                `tuner keeps the read-only sub-agent inspectors (${tier.label})`);
            if (tier.graph) {
                assert(hasAll(names, GRAPH_READS), `tuner keeps graph reads (${tier.label})`);
                assert(names.has("graph_stats"), `tuner keeps graph_stats (${tier.label})`);
            }
        });
    }

    it("a forged isHarvester:true must NOT grant the tuner ANY mutating tool", async () => {
        // The harvester role is derived authoritatively every turn; even if a
        // stale serialized config smuggles isHarvester:true onto a tuner session,
        // the tuner read-only filter must still strip every mutation — fact write,
        // graph write/delete/merge, crawl queue, mutating system AND sub-agent
        // controls.
        const { names } = await register({
            factStore: fakeEnhancedStore(),
            graphStore: fakeGraphStore(),
            agentIdentity: "agent-tuner",
            isHarvester: true,
        });
        for (const tool of ALL_MUTATIONS) {
            assert(!names.has(tool), `forged-harvester tuner must NOT have '${tool}'`);
        }
        // Reads are unaffected.
        assert(hasAll(names, [...GRAPH_READS, "graph_stats", "read_facts", ...SEARCH_TOOLS]),
            "tuner keeps the full read surface despite the forged flag");
    });
});

// ─── E1b: prompt adaptation through the real SessionManager ──────────────────
// The same builder (_buildKnowledgeToolInstructionsSection) is exercised here
// THROUGH SessionManager, so capability → prompt is asserted end-to-end (the
// pure builders are unit-tested separately in knowledge-prompt-blocks.test.js).
describe("E1b: capability-aware knowledge prompt block (via SessionManager)", () => {
    const workerDefaults = {
        frameworkBasePrompt: "Framework base prompt",
        agentPromptLookup: { worker: { prompt: "Worker agent prompt", kind: "app-agent" } },
    };
    async function toolInstructions({ factStore, graphStore }) {
        const manager = new SessionManager(process.env.GITHUB_TOKEN, null, workerDefaults, stateDir);
        const fakeClient = new FakeCopilotClient();
        manager.client = fakeClient;
        manager.setFactStore(factStore);
        if (graphStore) manager.setGraphStore(graphStore);
        manager.setSessionCatalog(noopCatalog());
        await manager.getOrCreate(`e1b-${Math.random().toString(36).slice(2, 8)}`, {
            boundAgentName: "worker",
            promptLayering: { kind: "app-agent" },
            agentIdentity: "worker",
            toolNames: [],
        }, { turnIndex: 0 });
        const sm = fakeClient.createdSessionConfigs[0]?.systemMessage;
        const action = sm?.sections?.tool_instructions?.action;
        if (typeof action !== "function") return null;
        return action("Base tool instructions");
    }

    it("base store → today's block (curated skills push), no enhanced wording", async () => {
        const block = await toolInstructions({ factStore: fakeBaseStore() });
        assert(block != null, "base store still injects a knowledge block");
        assert(block.includes("Base tool instructions"), "preserves the existing SDK content");
        assert(!block.includes("search_skills"), "base block does NOT name the enhanced pull tool");
    });

    it("enhanced store → drops the curated-skills push, names search_skills", async () => {
        const block = await toolInstructions({ factStore: fakeEnhancedStore() });
        assert(block != null && block.includes("search_skills"), "enhanced block names the per-turn pull tool");
        assert(!block.includes("[CURATED SKILLS]"), "enhanced block drops the capped-50 skills push");
    });

    it("enhanced store with embedder → advertises semantic recall", async () => {
        const block = await toolInstructions({ factStore: fakeEnhancedStore({ search: true, embedder: true }) });
        assert(block.includes("semantic search available"), "embedder present → semantic header");
    });

    it("enhanced store WITHOUT embedder → no semantic promise (lexical/hybrid only)", async () => {
        const block = await toolInstructions({ factStore: fakeEnhancedStore({ search: true, embedder: false }) });
        assert(block.includes("search_skills"), "still the enhanced pull block");
        assert(!block.includes("semantic search available"), "no semantic header without an embedder");
    });

    it("base store + graph → graph reader guidance with NO semantic seed pivot", async () => {
        const block = await toolInstructions({ factStore: fakeBaseStore(), graphStore: fakeGraphStore() });
        assert(block.includes("graph_search_nodes"), "graph reader guidance present on the composition tier");
        assert(!block.includes("search_skills"), "no enhanced pull tool on a base store");
    });

    it("enhanced store + graph → both enhanced retrieval and graph guidance", async () => {
        const block = await toolInstructions({ factStore: fakeEnhancedStore(), graphStore: fakeGraphStore() });
        assert(block.includes("search_skills"), "enhanced retrieval guidance present");
        assert(block.includes("graph_search_nodes"), "graph reader guidance present");
    });
});

// ─── E2: graph-read ACL wiring — lineage → AccessContext (the SDK half of MED#9) ─
// The horizon provider already enforces evidence-ACL filtering against a real DB
// (graph-query.test.mjs GQ13–GQ16). E2 proves the SDK WIRING above it: that the
// SessionManager threads its read_facts lineage resolver into EVERY graph read
// tool as the AccessContext — so graph reads can only ever see what read_facts
// could. A regression here would silently widen graph visibility.
describe("E2: graph reads honor read_facts lineage (SessionManager → AccessContext)", () => {
    // A graph store that records the AccessContext (and key) each read receives.
    function recordingGraphStore() {
        const seen = {};
        return {
            seen,
            async initialize() {}, async close() {},
            async searchGraphNodes(_q, access) { seen.nodes = access; return []; },
            async searchGraphEdges(_q, access) { seen.edges = access; return []; },
            async graphNeighbourhood(nodeKey, depth, access) { seen.neigh = access; seen.neighKey = nodeKey; seen.neighDepth = depth; return { nodes: [], edges: [] }; },
            async upsertGraphNode() { return {}; }, async upsertGraphEdge() { return {}; },
            async mergeGraphNodes() {}, async deleteGraphNode() { return true; }, async deleteGraphEdge() { return true; },
        };
    }

    // An enhanced fact store that records the AccessContext read_facts receives,
    // so we can prove graph reads use the SAME resolver output as read_facts.
    function recordingFactStore() {
        const seen = {};
        const base = fakeEnhancedStore();
        return { ...base, seen, async readFacts(_q, access) { seen.readFacts = access; return { count: 0, facts: [] }; } };
    }

    // Build a session whose graph tool handlers are wired to a real lineage
    // resolver, return the captured tools + the recording stores.
    async function wire({ agentIdentity, lineage }) {
        const manager = new SessionManager(process.env.GITHUB_TOKEN, null, {}, stateDir);
        const fakeClient = new FakeCopilotClient();
        manager.client = fakeClient;
        const fs = recordingFactStore();
        manager.setFactStore(fs);
        const gs = recordingGraphStore();
        manager.setGraphStore(gs);
        manager.setSessionCatalog(noopCatalog());
        // The SessionManager wraps this into resolveAccess exactly as read_facts does.
        manager.setLineageSessionLookup(async (sid) => lineage[sid] ?? []);
        const sid = `e2-${agentIdentity}-${Math.random().toString(36).slice(2, 8)}`;
        await manager.getOrCreate(sid, { agentIdentity, toolNames: [] }, { turnIndex: 0 });
        const tools = fakeClient.createdSessionConfigs[0]?.tools ?? [];
        const byName = (n) => tools.find((t) => t.name === n);
        return { gs, fs, byName, sid };
    }

    it("a reader's graph_search_nodes runs with readerSessionId=self + granted lineage (self excluded, deduped)", async () => {
        const sid = "sessReader";
        // Lineage includes the caller (must be excluded) and a duplicate (must dedupe).
        const { gs, byName } = await wire({
            agentIdentity: "default",
            lineage: { [sid]: [sid, "ancestorA", "descendantB", "ancestorA"] },
        });
        // The session id used at call time must match the one resolveAccess sees.
        await byName("graph_search_nodes").handler({ nameLike: "x" }, { sessionId: sid });
        const acc = gs.seen.nodes;
        assert(acc && acc.unrestricted !== true, "reader graph read is NOT unrestricted");
        assertEqual(acc.readerSessionId, sid, "readerSessionId is the caller session");
        assertEqual([...acc.grantedSessionIds].sort().join(","), "ancestorA,descendantB",
            "granted lineage = resolver output minus self, deduped");
    });

    it("all three graph reads (nodes/edges/neighbourhood) receive the SAME lineage access", async () => {
        const sid = "sessReader2";
        const { gs, byName } = await wire({
            agentIdentity: "default",
            lineage: { [sid]: ["p1", "p2"] },
        });
        await byName("graph_search_nodes").handler({ nameLike: "x" }, { sessionId: sid });
        await byName("graph_search_edges").handler({ fromKey: "k" }, { sessionId: sid });
        await byName("graph_neighbourhood").handler({ nodeKey: "k", depth: 1 }, { sessionId: sid });
        // Fidelity: the neighbourhood handler must forward the real param name.
        assertEqual(gs.seen.neighKey, "k", "graph_neighbourhood forwards nodeKey to the store");
        assertEqual(gs.seen.neighDepth, 1, "graph_neighbourhood forwards depth to the store");
        for (const [tool, acc] of [["nodes", gs.seen.nodes], ["edges", gs.seen.edges], ["neighbourhood", gs.seen.neigh]]) {
            assert(acc && acc.unrestricted !== true, `${tool}: not unrestricted`);
            assertEqual(acc.readerSessionId, sid, `${tool}: reader is the caller`);
            assertEqual([...acc.grantedSessionIds].sort().join(","), "p1,p2", `${tool}: same granted lineage`);
        }
    });

    it("graph read access EQUALS the read_facts access for the same caller (one resolver, not two)", async () => {
        // The invariant is literally "graph reads use the SAME read_facts lineage".
        // Drive BOTH read_facts and graph_search_nodes for one caller and assert
        // the AccessContext each store receives is identical (self-excluded +
        // deduped + non-unrestricted). A future divergence between the two
        // resolvers would fail here even if each path looked correct alone.
        const sid = "dualReader";
        const { gs, fs, byName } = await wire({
            agentIdentity: "default",
            lineage: { [sid]: [sid, "ancA", "descB", "ancA"] },
        });
        await byName("read_facts").handler({}, { sessionId: sid });
        await byName("graph_search_nodes").handler({ nameLike: "x" }, { sessionId: sid });
        const rf = fs.seen.readFacts;
        const gn = gs.seen.nodes;
        assert(rf && gn, "both stores received an access context");
        assertEqual(rf.readerSessionId, gn.readerSessionId, "same readerSessionId");
        assertEqual(rf.unrestricted === true, gn.unrestricted === true, "same unrestricted flag (both false)");
        assertEqual([...rf.grantedSessionIds].sort().join(","), [...gn.grantedSessionIds].sort().join(","),
            "read_facts and graph reads resolve the SAME granted lineage set");
        assertEqual([...gn.grantedSessionIds].sort().join(","), "ancA,descB", "and it is the expected self-excluded/deduped set");
    });

    it("agent-tuner graph reads are UNRESTRICTED even with a lineage resolver present", async () => {
        const sid = "tunerSession";
        const { gs, byName } = await wire({
            agentIdentity: "agent-tuner",
            lineage: { [sid]: ["should", "be", "ignored"] },
        });
        await byName("graph_search_nodes").handler({ nameLike: "x" }, { sessionId: sid });
        assertEqual(gs.seen.nodes.unrestricted, true, "tuner is the privileged investigator: unrestricted");
    });

    it("a reader with NO lineage gets an empty grant (own session only — never a wildcard)", async () => {
        const sid = "loneReader";
        const { gs, byName } = await wire({ agentIdentity: "default", lineage: { [sid]: [] } });
        await byName("graph_search_nodes").handler({ nameLike: "x" }, { sessionId: sid });
        const acc = gs.seen.nodes;
        assert(acc.unrestricted !== true, "no lineage must NOT escalate to unrestricted");
        assertEqual(acc.readerSessionId, sid, "still scoped to the caller");
        assertEqual(acc.grantedSessionIds.length, 0, "no granted sessions");
    });
});

