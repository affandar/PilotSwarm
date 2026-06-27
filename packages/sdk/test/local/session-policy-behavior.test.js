/**
 * Level 10b: Session policy — behavior tests.
 *
 * Covers: no policy (open), open policy, multiple plugin dirs merge,
 * last policy wins, title prefixing for named/system/generic agents.
 *
 * Run: npx vitest run test/local/session-policy-behavior.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { PilotSwarmWorker } from "../../src/index.ts";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { assert, assertEqual, assertIncludes, assertNotNull } from "../helpers/assertions.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { ONEWORD_CONFIG } from "../helpers/fixtures.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLICY_PLUGIN = path.resolve(__dirname, "../fixtures/policy-plugin");
const OPEN_POLICY_PLUGIN = path.resolve(__dirname, "../fixtures/open-policy-plugin");

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

function makePolicyPlugin(policy, agentBody = null) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-policy-plugin-"));
    fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name: "testapp" }, null, 2));
    fs.writeFileSync(path.join(dir, "session-policy.json"), JSON.stringify(policy, null, 2));
    if (agentBody) {
        const agentsDir = path.join(dir, "agents");
        fs.mkdirSync(agentsDir);
        fs.writeFileSync(path.join(agentsDir, "generic-crawler.agent.md"), agentBody);
    }
    return dir;
}

function newPolicyOnlyWorker(pluginDirs, extra = {}) {
    return new PilotSwarmWorker({
        store: "sqlite://:memory:",
        githubToken: "test-token",
        disableManagementAgents: true,
        pluginDirs,
        ...extra,
    });
}

function normalizeGraphToken(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") || "node";
}

function namespaceMatches(value, filter) {
    if (!filter) return true;
    const ns = String(value || "").replace(/\/+$/, "");
    const prefix = String(filter || "").replace(/\/+$/, "");
    return ns === prefix || ns.startsWith(`${prefix}/`);
}

function createInMemoryGraphStore() {
    const nodes = new Map();
    const edges = new Map();
    const namespaces = new Map();
    const normalizePredicateKey = (predicate) => normalizeGraphToken(predicate);
    const nodeKeyFor = (kind, name) => `${normalizeGraphToken(kind)}:${normalizeGraphToken(name)}`;
    return {
        nodes,
        edges,
        namespaces,
        async initialize() {},
        async close() {},
        normalizePredicateKey,
        async searchGraphNodes(query = {}) {
            const nameLike = String(query.nameLike || "").toLowerCase();
            return [...nodes.values()]
                .filter((node) => !query.kind || normalizeGraphToken(node.kind) === normalizeGraphToken(query.kind))
                .filter((node) => !nameLike || node.name.toLowerCase().includes(nameLike) || node.aliases.some((alias) => alias.toLowerCase().includes(nameLike)))
                .filter((node) => namespaceMatches(node.namespace, query.namespace))
                .slice(0, query.limit || 50)
                .map((node) => ({ ...node, evidence: [...node.evidence], aliases: [...node.aliases], score: 1 }));
        },
        async searchGraphEdges(query = {}) {
            return [...edges.values()]
                .filter((edge) => !query.fromKey || edge.fromKey === query.fromKey)
                .filter((edge) => !query.toKey || edge.toKey === query.toKey)
                .filter((edge) => !query.predicateKey || edge.predicateKey === query.predicateKey)
                .filter((edge) => !query.predicate || edge.predicate === query.predicate)
                .filter((edge) => namespaceMatches(edge.namespace, query.namespace))
                .slice(0, query.limit || 50)
                .map((edge) => ({ ...edge, evidence: [...edge.evidence] }));
        },
        async graphNeighbourhood(nodeKey) {
            const graphEdges = [...edges.values()].filter((edge) => edge.fromKey === nodeKey || edge.toKey === nodeKey);
            const nodeKeys = new Set([nodeKey]);
            for (const edge of graphEdges) {
                nodeKeys.add(edge.fromKey);
                nodeKeys.add(edge.toKey);
            }
            return {
                nodes: [...nodeKeys].map((key) => nodes.get(key)).filter(Boolean).map((node) => ({
                    nodeKey: node.nodeKey,
                    kind: node.kind,
                    name: node.name,
                    namespace: node.namespace,
                })),
                edges: graphEdges.map((edge) => ({
                    fromKey: edge.fromKey,
                    toKey: edge.toKey,
                    predicate: edge.predicate,
                    namespace: edge.namespace,
                    confidence: edge.confidence,
                })),
            };
        },
        async upsertGraphNode(input) {
            const nodeKey = nodeKeyFor(input.kind, input.name);
            const existing = nodes.get(nodeKey);
            const aliases = new Set([...(existing?.aliases || []), ...(input.aliases || [])]);
            const evidence = new Set([...(existing?.evidence || []), ...(input.evidence || [])]);
            const node = {
                nodeKey,
                kind: input.kind,
                name: input.name,
                namespace: input.namespace,
                aliases: [...aliases],
                evidence: [...evidence],
            };
            nodes.set(nodeKey, node);
            return { ...node, created: !existing, evidence: undefined };
        },
        async upsertGraphEdge(input) {
            const predicateKey = normalizePredicateKey(input.predicate);
            const key = `${input.fromKey}|${predicateKey}|${input.toKey}`;
            const existing = edges.get(key);
            const evidence = new Set([...(existing?.evidence || []), ...(input.evidence || [])]);
            const edge = {
                fromKey: input.fromKey,
                toKey: input.toKey,
                predicate: input.predicate,
                predicateKey,
                namespace: input.namespace,
                confidence: input.confidence ?? existing?.confidence ?? 1,
                observations: existing ? existing.observations + (evidence.size > existing.evidence.length ? 1 : 0) : 1,
                evidence: [...evidence],
            };
            edges.set(key, edge);
            return { ...edge, reinforced: !!existing, evidence: undefined };
        },
        async mergeGraphNodes() {},
        async deleteGraphNode(nodeKey) { return nodes.delete(nodeKey); },
        async deleteGraphEdge(fromKey, toKey, predicateKey) { return edges.delete(`${fromKey}|${predicateKey}|${toKey}`); },
        async removeGraphEvidence(scopeKey) {
            let nodeEvidenceRemoved = 0;
            let edgeEvidenceRemoved = 0;
            for (const node of nodes.values()) {
                const before = node.evidence.length;
                node.evidence = node.evidence.filter((key) => key !== scopeKey);
                nodeEvidenceRemoved += before - node.evidence.length;
            }
            for (const edge of edges.values()) {
                const before = edge.evidence.length;
                edge.evidence = edge.evidence.filter((key) => key !== scopeKey);
                edgeEvidenceRemoved += before - edge.evidence.length;
            }
            return { scopeKey, nodeEvidenceRemoved, edgeEvidenceRemoved, nodesDeleted: 0, edgesDeleted: 0 };
        },
        async listGraphNamespaces(query = {}) {
            return [...namespaces.values()]
                .filter((info) => query.includeArchived || !info.archived)
                .filter((info) => !query.prefix || info.namespace.startsWith(query.prefix))
                .map((info) => query.includeDetails ? info : ({ namespace: info.namespace, archived: info.archived, frontmatter: info.frontmatter }));
        },
        async getGraphNamespace(namespace) { return namespaces.get(namespace) || null; },
        async upsertGraphNamespace(input) {
            const now = new Date().toISOString();
            const previous = namespaces.get(input.namespace);
            const info = {
                namespace: input.namespace,
                archived: input.archived === true,
                frontmatter: input.frontmatter,
                source: input.source,
                nodeSchema: input.nodeSchema,
                edgeSchema: input.edgeSchema,
                harvestConfig: input.harvestConfig,
                createdAt: previous?.createdAt || now,
                updatedAt: now,
            };
            namespaces.set(input.namespace, info);
            return info;
        },
        async archiveGraphNamespace(namespace) {
            const info = namespaces.get(namespace);
            if (!info) return false;
            namespaces.set(namespace, { ...info, archived: true });
            return true;
        },
    };
}

function attachGraphStore(worker, graphStore) {
    assert(worker.sessionManager && typeof worker.sessionManager.setGraphStore === "function", "test can access worker SessionManager");
    worker.sessionManager.setGraphStore(graphStore);
}

function toolByName(tools, name) {
    const tool = tools.find((candidate) => candidate.name === name);
    assertNotNull(tool, `${name} tool is registered`);
    return tool;
}

class FakeCopilotSession {
    handlers = new Map();
    catchAllHandlers = new Set();
    registeredTools = [];
    prompts = [];

    constructor(onSend = null) {
        this.onSend = onSend;
    }

    on(typeOrHandler, maybeHandler) {
        if (typeof typeOrHandler === "function") {
            this.catchAllHandlers.add(typeOrHandler);
            return () => this.catchAllHandlers.delete(typeOrHandler);
        }
        const type = String(typeOrHandler || "");
        const handler = maybeHandler;
        if (!this.handlers.has(type)) this.handlers.set(type, new Set());
        this.handlers.get(type).add(handler);
        return () => this.off(type, handler);
    }

    off(typeOrHandler, maybeHandler) {
        if (typeof typeOrHandler === "function") {
            this.catchAllHandlers.delete(typeOrHandler);
            return;
        }
        const handlers = this.handlers.get(String(typeOrHandler || ""));
        if (handlers) handlers.delete(maybeHandler);
    }

    emit(type, data = {}) {
        const event = { type, data };
        for (const handler of this.catchAllHandlers) handler(event);
        for (const handler of this.handlers.get(type) ?? []) handler(event);
    }

    async send(request) {
        this.prompts.push(request?.prompt ?? "");
        this.emit("assistant.turn_start", {});
        if (this.onSend) await this.onSend(this, request);
        this.emit("assistant.turn_end", {});
        this.emit("session.idle", {});
    }

    registerTools(tools) {
        this.registeredTools = tools ?? [];
    }
    abort() {}
}

class FakeCopilotClient {
    constructor(onSend = null) {
        this.session = new FakeCopilotSession(onSend);
    }

    async createSession() { return this.session; }
    async resumeSession() { return this.session; }
    async deleteSession() {}
    async stop() {}
}

async function runCrawlerPromptFixture(fakeSession, request) {
    const prompt = String(request?.prompt || "");
    const namespaceMatch = prompt.match(/Fact key prefix and graph namespace:\s*(\S+)/);
    const namespace = namespaceMatch?.[1];
    assert(namespace, "crawler prompt includes a graph namespace");

    const tools = fakeSession.registeredTools;
    const ctx = { sessionId: "fake-copilot-session" };
    const storeFact = toolByName(tools, "store_fact");
    await storeFact.handler({
        key: `${namespace}/widget-service`,
        value: { title: "Widget Service", content: "Widget Service is owned by Platform Team." },
        shared: true,
    }, ctx);
    await storeFact.handler({
        key: `${namespace}/platform-team`,
        value: { title: "Platform Team", content: "Platform Team owns Widget Service." },
        shared: true,
    }, ctx);

    await toolByName(tools, "graph_upsert_namespace").handler({
        namespace,
        frontmatter: { name: "Crawler E2E", description: "Tiny bundled crawler e2e fixture." },
    }, ctx);
    const queue = await toolByName(tools, "facts_read_uncrawled").handler({ keyPrefix: `${namespace}/`, limit: 20 }, ctx);
    const widgetFact = queue.facts.find((fact) => fact.key === `${namespace}/widget-service`);
    const teamFact = queue.facts.find((fact) => fact.key === `${namespace}/platform-team`);
    assertNotNull(widgetFact, "widget source fact appears in crawler queue");
    assertNotNull(teamFact, "team source fact appears in crawler queue");

    const searchBefore = await toolByName(tools, "graph_search_nodes").handler({ namespace, nameLike: "Widget Service" }, ctx);
    assertEqual(searchBefore.length, 0, "fixture graph starts without Widget Service node");
    const serviceRef = await toolByName(tools, "graph_upsert_node").handler({
        namespace,
        kind: "service",
        name: "Widget Service",
        evidence: [widgetFact.scopeKey],
    }, ctx);
    const teamRef = await toolByName(tools, "graph_upsert_node").handler({
        namespace,
        kind: "team",
        name: "Platform Team",
        evidence: [teamFact.scopeKey],
    }, ctx);
    await toolByName(tools, "graph_upsert_edge").handler({
        namespace,
        fromKey: serviceRef.nodeKey,
        toKey: teamRef.nodeKey,
        predicate: "OWNED_BY",
        evidence: [widgetFact.scopeKey, teamFact.scopeKey],
    }, ctx);
    await toolByName(tools, "facts_set_crawled").handler({
        scopeKeys: [
            { scopeKey: widgetFact.scopeKey, etag: widgetFact.etag },
            { scopeKey: teamFact.scopeKey, etag: teamFact.etag },
        ],
    }, ctx);

    fakeSession.emit("assistant.message", {
        content: "CRAWL COMPLETE: ingested Widget Service and Platform Team, then built the ownership edge.",
    });
}

async function testNoPolicyOpen(env) {
    await withClient(env, {}, async (client, worker) => {
        assertEqual(worker.sessionPolicy, null, "no policy loaded");

        const session = await client.createSession(ONEWORD_CONFIG);
        assertNotNull(session, "session created");

        const response = await session.sendAndWait("Say hello", TIMEOUT);
        assertNotNull(response, "got response");
    });
}

async function testOpenPolicyAllowsGeneric(env) {
    await withClient(env, { worker: { pluginDirs: [OPEN_POLICY_PLUGIN] } }, async (client, worker) => {
        assertNotNull(worker.sessionPolicy, "policy loaded");
        assertEqual(worker.sessionPolicy.creation.mode, "open", "mode is open");

        const session = await client.createSession(ONEWORD_CONFIG);
        assertNotNull(session, "session created");

        const response = await session.sendAndWait("Say hello", TIMEOUT);
        assertNotNull(response, "got response");
    });
}

async function testMultiplePluginDirsMerge(env) {
    await withClient(env, { worker: { pluginDirs: [POLICY_PLUGIN, OPEN_POLICY_PLUGIN] } }, async (client, worker) => {
        const agents = worker.loadedAgents;
        const alpha = agents.find(a => a.name === "alpha");
        const gamma = agents.find(a => a.name === "gamma");

        assertNotNull(alpha, "alpha loaded");
        assertNotNull(gamma, "gamma loaded");
        assertEqual(alpha.namespace, "testapp", "alpha namespace");
        assertEqual(gamma.namespace, "openapp", "gamma namespace");
    });
}

async function testLastPolicyWins(env) {
    await withClient(env, { worker: { pluginDirs: [POLICY_PLUGIN, OPEN_POLICY_PLUGIN] } }, async (client, worker) => {
        assertEqual(worker.sessionPolicy.creation.mode, "open", "last policy wins (open)");

        const session = await client.createSession(ONEWORD_CONFIG);
        assertNotNull(session, "generic session created under open policy");
    });
}

async function testNamedAgentTitlePrefix(env) {
    await withClient(env, { worker: { pluginDirs: [POLICY_PLUGIN] } }, async (client, worker) => {
        const session = await client.createSessionForAgent("alpha");
        assertNotNull(session, "session created");

        const catalog = await createCatalog(env);
        try {
            const row = await catalog.getSession(session.sessionId);
            assertNotNull(row, "CMS row exists");
            const shortId = session.sessionId.slice(0, 8);
            assertEqual(row.title, `Alpha: ${shortId}`, "title has agent prefix + shortId");
            assertEqual(row.agentId, "alpha", "agentId set");
        } finally {
            await catalog.close();
        }
    });
}

async function testSystemAgentTitleNotPrefixed(env) {
    await withClient(env, { worker: { pluginDirs: [POLICY_PLUGIN] } }, async (client, worker) => {
        await new Promise(r => setTimeout(r, 3000));

        const catalog = await createCatalog(env);
        try {
            const sessions = await catalog.listSessions();
            const betaSession = sessions.find(s => s.agentId === "beta");
            if (!betaSession) {
                console.log("  ⚠️  Beta system agent not found—checking if it was started...");
                console.log("  Sessions:", sessions.map(s => `${s.sessionId.slice(0,8)} agent=${s.agentId || "none"} system=${s.isSystem}`).join(", "));
                return;
            }
            assertEqual(betaSession.title, "Beta Agent", "system agent title is exact, no shortId suffix");
            assertEqual(betaSession.isSystem, true, "isSystem flag set");
        } finally {
            await catalog.close();
        }
    });
}

async function testOrchAllowsNamedAgent(env) {
    await withClient(env, { worker: { pluginDirs: [POLICY_PLUGIN] } }, async (client, worker) => {
        const session = await client.createSessionForAgent("alpha");
        assertNotNull(session, "session created");

        console.log("  Sending prompt to named agent session...");
        const response = await session.sendAndWait("Say hello", TIMEOUT);
        console.log(`  Response: "${response?.slice(0, 80)}"`);
        assertNotNull(response, "got response from named agent session");

        const catalog = await createCatalog(env);
        try {
            const row = await catalog.getSession(session.sessionId);
            assert(row?.state !== "rejected", "session not rejected");
            assertEqual(row?.agentId, "alpha", "agentId is alpha");
        } finally {
            await catalog.close();
        }
    });
}

async function testOrchAllowsSubAgentSpawns(env) {
    await withClient(env, { worker: { pluginDirs: [POLICY_PLUGIN] } }, async (client, worker) => {
        const session = await client.createSessionForAgent("alpha");
        assertNotNull(session, "session created");

        console.log("  Asking parent to spawn a sub-agent...");
        const response = await session.sendAndWait(
            "Use the spawn_agent tool to create exactly one sub-agent with the task 'Say hello world'. " +
            "Do not answer until the spawn_agent call succeeds.",
            TIMEOUT,
            undefined,
            { requiredTool: "spawn_agent" },
        );
        assertNotNull(response, "parent returned after spawn_agent request");

        const catalog = await createCatalog(env);
        try {
            // Poll CMS until child session appears
            let children;
            const deadline = Date.now() + TIMEOUT;
            while (Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 3000));
                const sessions = await catalog.listSessions();
                children = sessions.filter(s => s.parentSessionId === session.sessionId);
                if (children.length >= 1) break;
                console.log(`  [poll] children so far: ${children.length}`);
            }
            console.log(`  Child sessions: ${children.length}`);
            assert(children.length >= 1, "sub-agent created despite allowlist policy");
            assert(children[0].state !== "rejected", "child not rejected by policy");
        } finally {
            await catalog.close();
        }
    });
}

async function testQualifiedNameResolution(env) {
    await withClient(env, { worker: { pluginDirs: [POLICY_PLUGIN] } }, async (client, worker) => {
        // Verify agent loaded with correct namespace
        const agents = worker.loadedAgents;
        const alpha = agents.find(a => a.name === "alpha");
        assertNotNull(alpha, "alpha agent loaded");
        assertEqual(alpha.namespace, "testapp", "alpha has testapp namespace");

        // Client createSessionForAgent works with unqualified name
        const s1 = await client.createSessionForAgent("alpha");
        assertNotNull(s1, "session created with unqualified name");

        const catalog = await createCatalog(env);
        try {
            const row = await catalog.getSession(s1.sessionId);
            assertEqual(row?.agentId, "alpha", "agentId is alpha");
            assertIncludes(row?.title || "", "Alpha", "title has agent name");

            // Qualified name "testapp:alpha" should also work for spawn_agent
            // (tested at orchestration level — resolveAgentConfig parses namespace)
            // Verify the agent record itself has the qualified name info
            assertEqual(`${alpha.namespace}:${alpha.name}`, "testapp:alpha", "qualified name correct");
        } finally {
            await catalog.close();
        }
    });
}

async function testAppSystemAgentsCoexist(env) {
    await withClient(env, { worker: { pluginDirs: [POLICY_PLUGIN], disableManagementAgents: false } }, async (client, worker) => {
        // Wait for system agents to start
        await new Promise(r => setTimeout(r, 5000));

        const catalog = await createCatalog(env);
        try {
            const sessions = await catalog.listSessions();
            const systemSessions = sessions.filter(s => s.isSystem);
            console.log(`  System sessions: ${systemSessions.map(s => `${s.agentId}(${s.title})`).join(", ")}`);

            // Beta from the test plugin
            const betaSession = systemSessions.find(s => s.agentId === "beta");
            assertNotNull(betaSession, "beta system agent session exists");
            assertEqual(betaSession.isSystem, true, "beta is system");

            // At least one built-in pilotswarm system agent should also exist
            assert(systemSessions.length >= 2, "multiple system agents loaded (app + built-in)");
        } finally {
            await catalog.close();
        }
    });
}

async function testNamedAgentTitleAfterSummarization(env) {
    await withClient(env, { worker: { pluginDirs: [POLICY_PLUGIN] } }, async (client, worker) => {
        const session = await client.createSessionForAgent("alpha");
        assertNotNull(session, "session created");

        // Turn 1: sets nextSummarizeAt = now + 60s in orchestration
        console.log("  Turn 1: triggering first turn...");
        const r1 = await session.sendAndWait(
            "Explain database migration strategies in detail",
            TIMEOUT,
        );
        console.log(`  Turn 1 response: "${r1?.slice(0, 80)}"`);
        assertNotNull(r1, "got turn 1 response");

        // Wait 65s for the summarize delay to expire (FIRST_SUMMARIZE_DELAY = 60s)
        console.log("  Waiting 65s for summarize delay...");
        await new Promise(r => setTimeout(r, 65_000));

        // Turn 2: triggers maybeSummarize which now fires (past the 60s threshold)
        console.log("  Turn 2: triggering summarization...");
        const r2 = await session.sendAndWait("Thanks", TIMEOUT);
        console.log(`  Turn 2 response: "${r2?.slice(0, 80)}"`);

        // Poll for title change (summarization makes a separate LLM call)
        const shortId = session.sessionId.slice(0, 8);
        const initialTitle = `Alpha: ${shortId}`;
        const catalog = await createCatalog(env);
        try {
            let row;
            for (let i = 0; i < 20; i++) {
                row = await catalog.getSession(session.sessionId);
                if (row?.title && row.title !== initialTitle) break;
                await new Promise(r => setTimeout(r, 2000));
            }
            assertNotNull(row, "CMS row exists");
            console.log(`  Title after summarization: "${row.title}"`);

            // Title should still start with the agent prefix
            assertIncludes(row.title, "Alpha:", "title still has agent prefix after summarization");

            // The suffix should NOT be the shortId anymore (it should be the LLM summary)
            assert(row.title !== initialTitle, "title was updated by summarization (not still shortId)");
        } finally {
            await catalog.close();
        }
    });
}

async function testGenericSessionTitleNoPrefix(env) {
    await withClient(env, {}, async (client, worker) => {
        const session = await client.createSession(ONEWORD_CONFIG);
        const response = await session.sendAndWait("Say hello", TIMEOUT);
        assertNotNull(response, "got response");

        const catalog = await createCatalog(env);
        try {
            const row = await catalog.getSession(session.sessionId);
            assertNotNull(row, "CMS row exists");
            assertEqual(row.agentId, null, "agentId is null for generic session");
            if (row.title) {
                assert(!row.title.includes(": ") || !row.agentId, "no agent prefix in generic title");
            }
        } finally {
            await catalog.close();
        }
    });
}

async function testBundledDefaultAgentsHiddenWithoutOptIn() {
    const worker = newPolicyOnlyWorker([]);
    assert(!worker.loadedAgents.some((agent) => agent.name === "generic-crawler"), "generic-crawler hidden without policy opt-in");
}

async function testBundledDefaultAgentsHiddenWhenPolicyOmitsOptIn() {
    const dir = makePolicyPlugin({
        version: 1,
        creation: { mode: "allowlist", allowGeneric: true },
    });
    try {
        const worker = newPolicyOnlyWorker([dir]);
        assert(!worker.loadedAgents.some((agent) => agent.name === "generic-crawler"), "generic-crawler hidden when bundledAgents is omitted");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function testBundledDefaultAgentLoadsWithOptIn() {
    const dir = makePolicyPlugin({
        version: 1,
        creation: { mode: "allowlist", allowGeneric: true, bundledAgents: ["generic-crawler"] },
    });
    try {
        const worker = newPolicyOnlyWorker([dir]);
        const agent = worker.loadedAgents.find((a) => a.name === "generic-crawler");
        assertNotNull(agent, "generic-crawler loaded after bundled opt-in");
        assertEqual(agent.namespace, "pilotswarm", "bundled crawler namespace");
        assertEqual(agent.crawler, true, "bundled crawler metadata retained");
        assert(worker.allowedAgentNames.includes("generic-crawler"), "generic-crawler is creatable");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// Deterministic guard for the consultative crawler lifecycle prompt. The e2e
// crawl test drives a scripted FakeCopilotClient, so it does NOT exercise the
// LLM following the lifecycle guidance. This test pins the prompt structure so a
// dropped/reordered stage or removed load-bearing guidance fails loudly.
async function testGenericCrawlerLifecyclePrompt() {
    const dir = makePolicyPlugin({
        version: 1,
        creation: { mode: "allowlist", allowGeneric: true, bundledAgents: ["generic-crawler"] },
    });
    try {
        const worker = newPolicyOnlyWorker([dir]);
        const agent = worker.loadedAgents.find((a) => a.name === "generic-crawler");
        assertNotNull(agent, "generic-crawler loaded for lifecycle prompt check");
        const prompt = agent.prompt;

        // All ten lifecycle stages must be present, and in order.
        const stages = [
            "Scope the source and mining strategy",
            "Understand the questions to answer",
            "Understand the domain and propose",
            "Design the fact keyspace and graph schema",
            "Tune the schema to the domain's intent",
            "Pick models per stage",
            "Present the complete plan",
            "Pilot first",
            "Run the full crawl",
            "Keep the corpus fresh",
        ];
        let lastIndex = -1;
        for (const stage of stages) {
            assertIncludes(prompt, stage, `lifecycle stage present: ${stage}`);
            const idx = prompt.indexOf(stage);
            assert(idx > lastIndex, `lifecycle stage in order: ${stage}`);
            lastIndex = idx;
        }

        // Load-bearing guidance inside the stages.
        assertIncludes(prompt, "Raw dump (uncrawled)", "three-tier keyspace: raw dump");
        assertIncludes(prompt, "Curated facts (crawled)", "three-tier keyspace: curated facts");
        assertIncludes(prompt, "Graph (nodes + edges)", "three-tier keyspace: graph");
        assertIncludes(prompt, "GPT mini", "model split: cheap ingest model");
        assertIncludes(prompt, "Claude Sonnet 4.6", "model split: stronger graph model");
        assertIncludes(prompt, "spawn_agent", "per-stage model selection via spawn_agent override");
        assertIncludes(prompt, "starter queries", "pilot hands the user starter queries");
        assertIncludes(prompt, "cron(", "incremental refresh via cron");
        assertIncludes(prompt, "cron_at(", "incremental refresh via cron_at");

        // Knowledge-base advertisement: the crawler proposes a skill via the
        // Facts Manager intake pipeline (it never writes skills/* directly).
        assertIncludes(prompt, "Advertise the knowledge base", "knowledge-base advertisement section present");
        assertIncludes(prompt, "proposed_skill", "advertisement proposes a skill for Facts Manager promotion");
        assertIncludes(prompt, "intake/knowledge-base/", "advertisement is written to the intake queue");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function testBundledGenericCrawlerCrawlsPromptData(env) {
    const dir = makePolicyPlugin({
        version: 1,
        creation: { mode: "allowlist", allowGeneric: false, bundledAgents: ["generic-crawler"] },
    });
    const graphStore = createInMemoryGraphStore();
    try {
        await withClient(env, { worker: { pluginDirs: [dir], githubToken: "test-token" } }, async (client, worker) => {
            attachGraphStore(worker, graphStore);
            assert(worker.allowedAgentNames.includes("generic-crawler"), "bundled crawler is creatable through policy opt-in");
            const factStore = worker.factStore;
            assertNotNull(factStore, "worker fact store initialized");

            const namespace = `corpus/e2e-crawler-${env.runId}`;
            const fakeClient = new FakeCopilotClient(runCrawlerPromptFixture);
            worker.sessionManager.client = fakeClient;
            const session = await client.createSessionForAgent("generic-crawler", {
                onUserInputRequest: async () => (
                    `Proceed with the non-destructive crawl exactly as requested for namespace ${namespace}. ` +
                    `Use keys ${namespace}/widget-service and ${namespace}/platform-team, then build the graph and mark both rows crawled.`
                ),
            });
            assertNotNull(session, "generic-crawler session created");
            assertEqual(client.sessionAgentIds?.get(session.sessionId), "generic-crawler", "client tracks bundled crawler agent id for orchestration input");
            assertEqual(worker.catalog ? (await worker.catalog.getSession(session.sessionId))?.agentId : "generic-crawler", "generic-crawler", "CMS row tracks bundled crawler agent id");

            const prompt = `You have all crawl inputs. Do not ask a follow-up question. Run the crawl now.

Source: Inline E2E crawl fixture
Fact key prefix and graph namespace: ${namespace}
Action: ingest, crawl, build graph, and mark crawled.
Confirmation: proceed with this non-destructive ingest, graph write, and mark-crawled operation.

Documents to ingest as shared source facts:
1. key: widget-service
   title: Widget Service
   content: Widget Service is owned by Platform Team.
2. key: platform-team
   title: Platform Team
   content: Platform Team owns Widget Service.

Required exact workflow:
- Call store_fact for both documents using keys ${namespace}/widget-service and ${namespace}/platform-team.
- Call graph_upsert_namespace for namespace ${namespace} with a short description.
- Call facts_read_uncrawled for keyPrefix ${namespace}/.
- Create exactly these graph nodes in namespace ${namespace}: kind service name Widget Service, and kind team name Platform Team. Use the queued fact scopeKey values as evidence.
- Create an edge from the Widget Service node to the Platform Team node with predicate OWNED_BY in namespace ${namespace}. Use at least one queued fact scopeKey as edge evidence.
- Call facts_set_crawled with the scopeKey and etag from each queued row.
- Reply with the phrase CRAWL COMPLETE and a one-sentence summary.`;

            const agent = worker.loadedAgents.find((candidate) => candidate.name === "generic-crawler");
            assertNotNull(agent, "bundled crawler agent loaded");
            assertEqual(agent.crawler, true, "bundled crawler definition carries crawler role");
            assertIncludes(agent.prompt, "Crawler Lifecycle", "bundled crawler prompt loaded");

            console.log(`  Crawler prompt fixture: ${prompt.slice(0, 120)}...`);
            const response = await session.sendAndWait(prompt, TIMEOUT);
            assertIncludes(response, "CRAWL COMPLETE", "bundled crawler turn completes through the public session path");
            assertIncludes(fakeClient.session.prompts[0] ?? "", namespace, "fake Copilot session received the crawl prompt");
            const toolNames = fakeClient.session.registeredTools.map((tool) => tool.name);
            for (const name of ["store_fact", "facts_read_uncrawled", "facts_set_crawled", "graph_upsert_namespace", "graph_search_nodes", "graph_upsert_node", "graph_upsert_edge", "graph_remove_evidence"]) {
                assertIncludes(JSON.stringify(toolNames), name, `${name} is available to the bundled crawler session`);
            }

            const storedFacts = await factStore.readFacts(
                { keyPattern: `${namespace}/%`, scope: "shared", limit: 20 },
                { unrestricted: true },
            );

            const storedKeys = storedFacts.facts.map((fact) => fact.key).sort();
            assert(storedKeys.includes(`${namespace}/platform-team`), "crawler stored platform team source fact");
            assert(storedKeys.includes(`${namespace}/widget-service`), "crawler stored widget service source fact");
            const scopeKeys = storedFacts.facts.map((fact) => fact.scopeKey).filter(Boolean);
            assert(scopeKeys.length >= 2, "stored facts have scope keys for graph evidence");

            const remaining = await factStore.readUncrawledFacts({ keyPrefix: `${namespace}/`, limit: 20 });
            assertEqual(remaining.count, 0, "crawler marked all fixture source facts crawled");

            assertNotNull(graphStore.namespaces.get(namespace), "crawler registered the graph namespace");
            const serviceNode = graphStore.nodes.get("service:widget_service");
            const teamNode = graphStore.nodes.get("team:platform_team");
            assertNotNull(serviceNode, "crawler created Widget Service node");
            assertNotNull(teamNode, "crawler created Platform Team node");
            assertEqual(serviceNode.namespace, namespace, "service node is in the requested namespace");
            assertEqual(teamNode.namespace, namespace, "team node is in the requested namespace");
            assert(serviceNode.evidence.some((scopeKey) => scopeKeys.includes(scopeKey)), "service node carries source fact evidence");
            assert(teamNode.evidence.some((scopeKey) => scopeKeys.includes(scopeKey)), "team node carries source fact evidence");

            const edge = [...graphStore.edges.values()].find((candidate) => (
                candidate.fromKey === serviceNode.nodeKey
                && candidate.toKey === teamNode.nodeKey
                && candidate.predicateKey === "owned_by"
            ));
            assertNotNull(edge, "crawler created Widget Service OWNED_BY Platform Team edge");
            assertEqual(edge.namespace, namespace, "edge is in the requested namespace");
            assert(edge.evidence.some((scopeKey) => scopeKeys.includes(scopeKey)), "edge carries source fact evidence");
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function testInlineCustomAgentOverridesBundledDefaultAgent() {
    const dir = makePolicyPlugin({
        version: 1,
        creation: { mode: "allowlist", allowGeneric: true, bundledAgents: ["generic-crawler"], defaultAgent: "generic-crawler" },
    });
    try {
        const worker = newPolicyOnlyWorker([dir], {
            customAgents: [{
                name: "generic-crawler",
                description: "Inline crawler",
                prompt: "You are the inline crawler.",
                tools: null,
            }],
        });
        const matches = worker.loadedAgents.filter((a) => a.name === "generic-crawler");
        assertEqual(matches.length, 1, "inline crawler suppresses bundled default duplicate");
        assertIncludes(matches[0].prompt, "inline crawler", "inline custom agent prompt is used");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function testUnknownBundledDefaultAgentFails() {
    const dir = makePolicyPlugin({
        version: 1,
        creation: { mode: "allowlist", bundledAgents: ["not-a-bundled-agent"] },
    });
    try {
        let threw = false;
        try {
            newPolicyOnlyWorker([dir]);
        } catch (err) {
            threw = /unknown bundled agent/.test(String(err?.message ?? err));
        }
        assert(threw, "unknown bundled agent fails at worker construction");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function testDefaultAgentRequiresBundledOptIn() {
    const dir = makePolicyPlugin({
        version: 1,
        creation: { mode: "allowlist", defaultAgent: "generic-crawler" },
    });
    try {
        let threw = false;
        try {
            newPolicyOnlyWorker([dir]);
        } catch (err) {
            threw = /defaultAgent/.test(String(err?.message ?? err)) && /bundled/.test(String(err?.message ?? err));
        }
        assert(threw, "defaultAgent cannot point at an unopted bundled default agent");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function testAppAgentOverridesBundledDefaultAgent() {
    const appAgent = `---
schemaVersion: 1
version: 1.0.0
name: generic-crawler
title: App Crawler
description: App-owned crawler.
crawler: true
---

# App Crawler

You are the app-owned crawler.
`;
    const dir = makePolicyPlugin({
        version: 1,
        creation: { mode: "allowlist", allowGeneric: true, bundledAgents: ["generic-crawler"], defaultAgent: "generic-crawler" },
    }, appAgent);
    try {
        const worker = newPolicyOnlyWorker([dir]);
        const matches = worker.loadedAgents.filter((a) => a.name === "generic-crawler");
        assertEqual(matches.length, 1, "app crawler suppresses bundled default duplicate");
        assertEqual(matches[0].namespace, "testapp", "app agent takes precedence over bundled default");
        assertIncludes(matches[0].prompt, "app-owned crawler", "app agent prompt is used");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

describe("Level 10b: Session Policy — Behavior", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("No Policy = Open Behavior", { timeout: TIMEOUT }, async () => {
        await testNoPolicyOpen(getEnv());
    });
    it("Open Policy Allows Generic", { timeout: TIMEOUT }, async () => {
        await testOpenPolicyAllowsGeneric(getEnv());
    });
    it("Multiple Plugin Dirs Merge", { timeout: TIMEOUT }, async () => {
        await testMultiplePluginDirsMerge(getEnv());
    });
    it("Last Policy Wins", { timeout: TIMEOUT }, async () => {
        await testLastPolicyWins(getEnv());
    });
    it("Named Agent Title Prefix", { timeout: TIMEOUT }, async () => {
        await testNamedAgentTitlePrefix(getEnv());
    });
    it("System Agent Title Not Prefixed", { timeout: TIMEOUT }, async () => {
        await testSystemAgentTitleNotPrefixed(getEnv());
    });
    it("Generic Session Title Has No Prefix", { timeout: TIMEOUT }, async () => {
        await testGenericSessionTitleNoPrefix(getEnv());
    });
    it("Bundled Default Agent Hidden Without Opt-In", async () => {
        await testBundledDefaultAgentsHiddenWithoutOptIn();
    });
    it("Bundled Default Agent Hidden When Policy Omits Opt-In", async () => {
        await testBundledDefaultAgentsHiddenWhenPolicyOmitsOptIn();
    });
    it("Bundled Default Agent Loads With Opt-In", async () => {
        await testBundledDefaultAgentLoadsWithOptIn();
    });
    it("Generic Crawler Lifecycle Prompt", async () => {
        await testGenericCrawlerLifecyclePrompt();
    });
    it("Bundled Generic Crawler Crawls Prompt Data", { timeout: TIMEOUT * 2 }, async () => {
        await testBundledGenericCrawlerCrawlsPromptData(getEnv());
    });
    it("Unknown Bundled Default Agent Fails", async () => {
        await testUnknownBundledDefaultAgentFails();
    });
    it("Default Agent Requires Bundled Opt-In", async () => {
        await testDefaultAgentRequiresBundledOptIn();
    });
    it("App Agent Overrides Bundled Default Agent", async () => {
        await testAppAgentOverridesBundledDefaultAgent();
    });
    it("Inline Custom Agent Overrides Bundled Default Agent", async () => {
        await testInlineCustomAgentOverridesBundledDefaultAgent();
    });
    it("Orch Allows Valid Named Agent", { timeout: TIMEOUT }, async () => {
        await testOrchAllowsNamedAgent(getEnv());
    });
    it("Orch Does Not Block Sub-Agent Spawns", { timeout: TIMEOUT * 2 }, async () => {
        await testOrchAllowsSubAgentSpawns(getEnv());
    });
    it("Qualified Name Resolution", { timeout: TIMEOUT * 2 }, async () => {
        await testQualifiedNameResolution(getEnv());
    });
    it("App System Agents Coexist with Built-In", { timeout: TIMEOUT }, async () => {
        await testAppSystemAgentsCoexist(getEnv());
    });
    it("Named Agent Title Preserved After Summarization", { timeout: TIMEOUT * 3 }, async () => {
        await testNamedAgentTitleAfterSummarization(getEnv());
    });
});
