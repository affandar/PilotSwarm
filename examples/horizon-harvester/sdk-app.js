#!/usr/bin/env node

/**
 * Horizon Harvester — SDK Example
 *
 * Demonstrates PilotSwarm's optional EnhancedFactStore + knowledge-graph providers:
 *   - A `harvester: true` agent crawls a mock knowledge source into durable facts
 *     and builds an open knowledge graph (nodes + edges with fact-scopeKey evidence)
 *   - A reader agent answers questions using multi-signal search + graph traversal
 *   - Worker/client wire the providers from HORIZON_* env via horizonConfigFromEnv()
 *
 * Harvesting REQUIRES a graph store: the crawl + graph-write tools key off
 * !!graphStore, so this sample requires BOTH providers and fails fast without them.
 * The fact store tier decides search: a base fact store + graph still harvests but
 * has no facts_search / facts_similar; this sample uses the enhanced tier for both.
 *
 * Usage:
 *   node --env-file=.env.horizondb examples/horizon-harvester/sdk-app.js            # full: harvest then ask
 *   HARVESTER_SCENARIO=harvest node --env-file=.env.horizondb .../sdk-app.js        # just harvest
 *   HARVESTER_SCENARIO=delete  node --env-file=.env.horizondb .../sdk-app.js        # harvest, delete one source, reconcile graph
 *   HARVESTER_SCENARIO=ask     node --env-file=.env.horizondb .../sdk-app.js        # just ask (after a harvest)
 *
 * Requires:
 *   DATABASE_URL               — PostgreSQL connection string (CMS + orchestration)
 *   GITHUB_TOKEN               — GitHub Copilot API token
 *   HORIZON_DATABASE_URL       — HorizonDB enhanced facts store (pgvector/pg_textsearch/pg_durable)
 *   HORIZON_GRAPH_DATABASE_URL — Knowledge graph target (Apache AGE); may reuse the facts URL
 *   HORIZON_EMBED_*            — (optional) durable embedder; omit ⇒ lexical-only search
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { PilotSwarmClient, PilotSwarmWorker, horizonConfigFromEnv } from "pilotswarm-sdk";
import { createSourceTools } from "./tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.join(__dirname, "plugin");

const STORE = process.env.DATABASE_URL;
if (!STORE) {
    throw new Error("Missing DATABASE_URL. Horizon Harvester requires PostgreSQL for the PilotSwarm CMS and orchestration.");
}

// The harvester pattern needs the two optional HorizonDB-backed providers. Fail
// early with a clear message rather than silently degrading to a plain store.
const horizon = horizonConfigFromEnv();
if (!horizon.enhancedFactsDatabaseUrl) {
    throw new Error(
        "Missing HORIZON_DATABASE_URL. This sample demonstrates the EnhancedFactStore + " +
        "knowledge graph, which require a HorizonDB cluster. See the README and .env.example.",
    );
}
if (!horizon.graphDatabaseUrl) {
    throw new Error(
        "Missing HORIZON_GRAPH_DATABASE_URL. The harvester builds a knowledge graph (Apache AGE); " +
        "set it (it may reuse HORIZON_DATABASE_URL with a distinct graph schema). See the README.",
    );
}

const SCENARIO = process.env.HARVESTER_SCENARIO || "full";
const VALID = new Set(["full", "harvest", "delete", "ask"]);
if (!VALID.has(SCENARIO)) {
    console.error(`Unknown HARVESTER_SCENARIO="${SCENARIO}". Available: ${[...VALID].join(", ")}`);
    process.exit(1);
}

const HARVEST_PROMPT =
    "Run a full harvest cycle: ingest every document from the knowledge source into " +
    "corpus/northwind facts, then drain the crawl queue with namespace 'corpus/northwind' — " +
    "for each fact resolve existing entities first (facts_similar + graph_search_nodes with " +
    "namespace 'corpus/northwind') so you don't duplicate, then " +
    "extract services, teams, and people into graph nodes and OWNED_BY / LED_BY / " +
    "DEPENDS_ON edges (anchored to each fact's scopeKey and stamped with namespace " +
    "'corpus/northwind'), and mark each fact crawled with " +
    "its exact scopeKey and etag. Finish with a short summary of documents ingested and " +
    "nodes/edges created.";

const DELETE_PROMPT =
    "Run the source-deletion reconciliation scenario for corpus/northwind/svc-telemetry. " +
    "First call delete_fact for key 'corpus/northwind/svc-telemetry' with shared=true. " +
    "Then drain facts_read_uncrawled(keyPrefix='corpus/northwind/', limit=20). " +
    "For every row with deletedAt set, call graph_remove_evidence(scopeKey=row.scopeKey, namespace='corpus/northwind') " +
    "to remove that source's node anchors and edge evidence. For live rows, do not rebuild unless they are uncrawled for another reason. " +
    "Finally call facts_set_crawled with scopeKeys entries containing each processed row's exact scopeKey and etag, and summarize what evidence was removed.";

const ASK_PROMPT =
    "Question: if telemetry-pipeline has an outage, which services are affected, and which " +
    "teams (and team leads) own them? Seed with facts_search(namespace='corpus/northwind'), " +
    "expand through the graph's DEPENDS_ON and OWNED_BY edges with namespace 'corpus/northwind', " +
    "and ground your answer in what you retrieve.";

const HARVEST_TIMEOUT_MS = 300_000;
const ASK_TIMEOUT_MS = 180_000;

console.log("📚 Horizon Harvester (SDK)");
console.log(`   Store: ${STORE.startsWith("postgres") ? "PostgreSQL" : STORE}`);
console.log(`   Enhanced facts: HorizonDB`);
console.log(`   Knowledge graph: ${horizon.graphDatabaseUrl === horizon.enhancedFactsDatabaseUrl ? "shared HorizonDB" : "separate target"}`);
console.log(`   Embedder: ${horizon.horizonEmbed ? "on (semantic + hybrid search)" : "off (lexical-only)"}`);
console.log(`   Scenario: ${SCENARIO}\n`);

if (!horizon.horizonEmbed) {
    console.warn(
        "   ⚠ No embedder configured (HORIZON_EMBED_* unset). The durable in-DB embed\n" +
        "     loop will NOT run, so the facts.embedding column stays empty and the\n" +
        "     harvester's facts_similar resolve step returns nothing (search is\n" +
        "     lexical-only). Set HORIZON_EMBED_URL / _MODEL / _DIM (and a key if your\n" +
        "     endpoint needs one) in .env to populate embeddings. See the README.\n",
    );
}

function attachEventStream(label, session) {
    session.on((event) => {
        const type = event.eventType;
        if (type === "tool.execution_start") {
            console.log(`   🔧 [${label}] ${event.data?.toolName || event.data?.name}`);
        } else if (type === "assistant.turn_end") {
            console.log(`   ✓ [${label}] turn complete`);
        }
    });
}

async function runAgent(label, agentName, prompt, timeoutMs) {
    console.log(`━━━ ${label} ━━━\n`);
    const session = await client.createSessionForAgent(agentName);
    worker.setSessionConfig(session.sessionId, {});
    attachEventStream(label, session);

    const info = await session.getInfo();
    console.log(`   Session: ${session.sessionId}`);
    console.log(`   Agent: ${info.agentId}\n`);
    console.log(`   Sending: ${prompt}\n`);

    const response = await session.sendAndWait(prompt, timeoutMs);

    console.log(`\n━━━ ${label} Result ━━━\n`);
    console.log(response?.slice(0, 2000) || "(no response)");
    console.log("\n");

    const finalInfo = await session.getInfo();
    console.log(`   Final status: ${finalInfo.status}`);
    console.log(`   Iterations: ${finalInfo.iterations}\n`);
    return response;
}

// ─── Start worker: source tools + plugin + HorizonDB providers ───

const worker = new PilotSwarmWorker({
    store: STORE,
    githubToken: process.env.GITHUB_TOKEN,
    pluginDirs: [PLUGIN_DIR],
    disableManagementAgents: true, // keep the demo focused on the two app agents
    ...horizon,                    // enhancedFactsDatabaseUrl / graphDatabaseUrl / horizonEmbed / *Schema
});
worker.registerTools(createSourceTools());
await worker.start();

console.log(`   Agents: ${worker.loadedAgents.map(a => `${a.name}${a.system ? " (system)" : ""}`).join(", ")}`);
console.log(`   Policy: ${worker.sessionPolicy?.creation?.mode || "open"}\n`);

// ─── Start client (inherits policy + facts target from the worker) ───

const client = new PilotSwarmClient({
    store: STORE,
    ...horizon, // client/management must resolve the SAME facts target as the worker
    ...(worker.sessionPolicy ? { sessionPolicy: worker.sessionPolicy } : {}),
    ...(worker.allowedAgentNames?.length ? { allowedAgentNames: worker.allowedAgentNames } : {}),
});
await client.start();

// ─── Scenario runner ─────────────────────────────────────────────

try {
    if (SCENARIO === "delete") {
        await runAgent("Harvest", "source-harvester", HARVEST_PROMPT, HARVEST_TIMEOUT_MS);
        await runAgent("Delete/Reconcile", "source-harvester", DELETE_PROMPT, HARVEST_TIMEOUT_MS);
    }
    if (SCENARIO === "full" || SCENARIO === "harvest") {
        await runAgent("Harvest", "source-harvester", HARVEST_PROMPT, HARVEST_TIMEOUT_MS);
    }
    if (SCENARIO === "full" || SCENARIO === "ask") {
        await runAgent("Ask", "librarian", ASK_PROMPT, ASK_TIMEOUT_MS);
    }
} finally {
    await client.stop();
    await worker.stop();
}

console.log("   Done ✓");
process.exit(0);
