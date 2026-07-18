#!/usr/bin/env node
// Unit test — action/include dispatch + error mapping for the parity tools.
//
// Covers, against recording mocks (no DB, no network):
//   1. manage_session_group: action dispatch → exact mgmt calls; input
//      validation (create without title, unknown action).
//   2. get_session_metrics: include[] → exactly the right mgmt methods,
//      tree variants, per-axis error isolation.
//   3. get_session_events: before_seq/after_seq mutual exclusion; before_seq
//      routes to getSessionEventsBefore.
//   4. 403 error mapping → actionable admin-role text.
//
// Usage:  node packages/app/mcp/test/unit/dispatch.unit.mjs

import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../dist/src/server.js";

const results = [];
function record(name, ok, detail = "") {
    results.push({ name, ok });
    console.log(`${ok ? "✅" : "❌"} ${name.padEnd(64)} ${ok ? "PASS" : "FAIL"}${detail ? ` (${detail})` : ""}`);
}

function recordingMgmt(calls) {
    const track = (name, ret) => async (...args) => { calls.push([name, ...args]); return ret; };
    return {
        listSessions: track("listSessions", []),
        getSession: track("getSession", { sessionId: "s" }),
        getDefaultModel: track("getDefaultModel", "m"),
        createSessionGroup: track("createSessionGroup", { groupId: "g1", title: "t" }),
        listSessionGroups: track("listSessionGroups", []),
        updateSessionGroup: track("updateSessionGroup", { groupId: "g1" }),
        assignSessionsToGroup: track("assignSessionsToGroup", undefined),
        moveSessionsToGroup: track("moveSessionsToGroup", undefined),
        placeSessionsInGroup: track("placeSessionsInGroup", [{ rootSessionId: "a", placed: true, reason: null }]),
        cancelSessionGroup: track("cancelSessionGroup", undefined),
        completeSessionGroup: track("completeSessionGroup", undefined),
        deleteSessionGroup: track("deleteSessionGroup", undefined),
        getSessionMetricSummary: track("getSessionMetricSummary", { turns: 1 }),
        getSessionTreeStats: track("getSessionTreeStats", { tree: {} }),
        getSessionTokensByModel: track("getSessionTokensByModel", []),
        getSessionSkillUsage: track("getSessionSkillUsage", []),
        getSessionTreeSkillUsage: track("getSessionTreeSkillUsage", {}),
        getSessionFactsStats: track("getSessionFactsStats", {}),
        getSessionTreeFactsStats: track("getSessionTreeFactsStats", {}),
        getOrchestrationStats: track("getOrchestrationStats", {}),
        getSessionEvents: track("getSessionEvents", []),
        getSessionEventsBefore: track("getSessionEventsBefore", [{ seq: 5 }]),
        getSessionStatus: track("getSessionStatus", {}),
        getLatestResponse: track("getLatestResponse", { text: "hi" }),
        getSessionRetrievalUsage: track("getSessionRetrievalUsage", []),
        getSessionTreeRetrievalUsage: track("getSessionTreeRetrievalUsage", {}),
        getSessionGraphNodeUsage: track("getSessionGraphNodeUsage", []),
        getSessionGraphEdgeSearchUsage: track("getSessionGraphEdgeSearchUsage", []),
        getSessionGraphSearches: track("getSessionGraphSearches", []),
        getFleetGraphNodeUsage: track("getFleetGraphNodeUsage", {}),
        getExecutionHistory: track("getExecutionHistory", []),
        listChildOutcomes: track("listChildOutcomes", []),
        stopSessionTurn: track("stopSessionTurn", { stopped: true }),
        completeSession: track("completeSession", undefined),
        cancelPendingMessage: track("cancelPendingMessage", undefined),
        restartSystemSession: track("restartSystemSession", {}),
        pruneDeletedSummaries: track("pruneDeletedSummaries", 3),
    };
}

function makeCtx(calls, overrides = {}) {
    return {
        client: {},
        mgmt: recordingMgmt(calls),
        facts: { async readFacts() { return { count: 0, facts: [] }; }, async forcePurgeFacts() { return 2; } },
        enhancedFacts: null,
        graph: null,
        api: null,
        admin: true,
        webMode: false,
        capabilityCatalog: null,
        models: null,
        skills: [],
        registeredAgents: [],
        systemAgentIds: new Set(),
        async refreshSystemAgentIds() {},
        ...overrides,
    };
}

async function connect(ctx) {
    const server = createMcpServer(ctx);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "dispatch-test", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return client;
}

const parse = (res) => { try { return JSON.parse(res.content[0].text); } catch { return res.content?.[0]?.text; } };

async function main() {
    const UUID = randomUUID();

    // ── 1. manage_session_group dispatch ────────────────────────────────
    {
        const calls = [];
        const client = await connect(makeCtx(calls));

        let res = await client.callTool({ name: "manage_session_group", arguments: { action: "create", title: "Batch A", description: "d" } });
        record("group create → createSessionGroup(title,description)",
            !res.isError && calls.some(([n, input]) => n === "createSessionGroup" && input.title === "Batch A" && input.description === "d"));

        res = await client.callTool({ name: "manage_session_group", arguments: { action: "create" } });
        record("group create without title → isError", res.isError === true);

        res = await client.callTool({ name: "manage_session_group", arguments: { action: "assign", group_id: "g1", session_ids: ["a", "b"] } });
        record("group assign (direct) → owner-adopting alias moveSessionsToGroup(g1,[a,b])",
            !res.isError && calls.some(([n, g, ids]) => n === "moveSessionsToGroup" && g === "g1" && ids?.length === 2));

        res = await client.callTool({ name: "manage_session_group", arguments: { action: "move", session_ids: ["a"] } });
        record("group move without group_id → moveSessionsToGroup(null)",
            !res.isError && calls.some(([n, g]) => n === "moveSessionsToGroup" && g === null));

        calls.length = 0;
        res = await client.callTool({ name: "manage_session_group", arguments: { action: "place", group_id: "g1", session_ids: ["a"] } });
        record("group place (direct) → owner-adopting alias moveSessionsToGroup(g1,[a])",
            !res.isError && calls.some(([n, g, ids]) => n === "moveSessionsToGroup" && g === "g1" && ids?.length === 1));

        res = await client.callTool({ name: "manage_session_group", arguments: { action: "place" } });
        record("group place without session_ids → isError", res.isError === true);

        res = await client.callTool({ name: "manage_session_group", arguments: { action: "explode", group_id: "g1" } });
        record("group unknown action → rejected by schema", res.isError === true);

        await client.close();
    }

    // ── 1b. manage_session_group place — web mode (viewer-private) ──────
    {
        const calls = [];
        const client = await connect(makeCtx(calls, { webMode: true }));

        let res = await client.callTool({ name: "manage_session_group", arguments: { action: "place", group_id: "g1", session_ids: ["a", "b"] } });
        let body = parse(res);
        record("group place (web) → placeSessionsInGroup([a,b],g1)",
            !res.isError && calls.some(([n, ids, g]) => n === "placeSessionsInGroup" && ids?.length === 2 && g === "g1"));
        record("group place (web) → per-root results surfaced",
            !res.isError && body.placed === true && body.results?.[0]?.rootSessionId === "a" && body.results[0].placed === true);

        calls.length = 0;
        res = await client.callTool({ name: "manage_session_group", arguments: { action: "place", session_ids: ["a"] } });
        record("group place (web) without group_id → placeSessionsInGroup([a],null)",
            !res.isError && calls.some(([n, ids, g]) => n === "placeSessionsInGroup" && ids?.length === 1 && g === null));

        calls.length = 0;
        res = await client.callTool({ name: "manage_session_group", arguments: { action: "move", group_id: "g1", session_ids: ["a"] } });
        record("group move (web) → delegates to placeSessionsInGroup",
            !res.isError && calls.some(([n]) => n === "placeSessionsInGroup") && !calls.some(([n]) => n === "moveSessionsToGroup"));

        calls.length = 0;
        res = await client.callTool({ name: "manage_session_group", arguments: { action: "assign", group_id: "g1", session_ids: ["a"] } });
        record("group assign (web) → delegates to placeSessionsInGroup",
            !res.isError && calls.some(([n]) => n === "placeSessionsInGroup") && !calls.some(([n]) => n === "assignSessionsToGroup"));

        await client.close();
    }

    // ── 1c. list_sessions projection — viewer_group_id, no legacy field ─
    {
        const calls = [];
        const ctx = makeCtx(calls);
        ctx.mgmt.listSessions = async () => [
            { sessionId: "s1", status: "running", viewerGroupId: "g9" },
            { sessionId: "s2", status: "idle" },
        ];
        const client = await connect(ctx);
        const res = await client.callTool({ name: "list_sessions", arguments: {} });
        const body = parse(res);
        const s1 = body.sessions?.find((s) => s.session_id === "s1");
        const s2 = body.sessions?.find((s) => s.session_id === "s2");
        record("list_sessions → viewer_group_id from viewerGroupId",
            !res.isError && s1?.viewer_group_id === "g9" && s2?.viewer_group_id === null);
        record("list_sessions → no legacy group_id/groupId keys",
            !res.isError && s1 && !("group_id" in s1) && !("groupId" in s1));
        await client.close();
    }

    // ── 1d. list_session_groups membership derives from viewerGroupId ───
    {
        const calls = [];
        const ctx = makeCtx(calls);
        ctx.mgmt.listSessionGroups = async () => [{ groupId: "g9", title: "mine" }];
        ctx.mgmt.listSessions = async () => [
            { sessionId: "s1", status: "running", viewerGroupId: "g9" },
            { sessionId: "s2", status: "idle", groupId: "g9" }, // legacy field must be ignored
        ];
        const client = await connect(ctx);
        const res = await client.callTool({ name: "list_session_groups", arguments: { include_sessions: true } });
        const body = parse(res);
        const members = body.groups?.[0]?.sessions ?? [];
        record("group membership → viewerGroupId placements only",
            !res.isError && members.length === 1 && members[0].session_id === "s1");
        await client.close();
    }

    // ── 2. get_session_metrics include mapping ──────────────────────────
    {
        const calls = [];
        const client = await connect(makeCtx(calls));

        await client.callTool({ name: "get_session_metrics", arguments: { session_id: UUID, include: ["summary", "tokens_by_model"] } });
        const names = calls.map(([n]) => n);
        record("metrics include → summary+tokens fetched",
            names.includes("getSessionMetricSummary") && names.includes("getSessionTokensByModel"));
        record("metrics include → unrequested axes NOT fetched",
            !names.includes("getSessionSkillUsage") && !names.includes("getOrchestrationStats") && !names.includes("getSessionFactsStats"));

        calls.length = 0;
        await client.callTool({ name: "get_session_metrics", arguments: { session_id: UUID, include: ["summary", "skill_usage"], tree: true } });
        const treeNames = calls.map(([n]) => n);
        record("metrics tree=true → tree variants",
            treeNames.includes("getSessionTreeStats") && treeNames.includes("getSessionTreeSkillUsage") && !treeNames.includes("getSessionMetricSummary"));

        const badRes = await client.callTool({ name: "get_session_metrics", arguments: { session_id: UUID, include: ["bogus_axis"] } });
        record("metrics unknown include → rejected by schema", badRes.isError === true);

        await client.close();
    }

    // ── 3. per-axis error isolation ──────────────────────────────────────
    {
        const calls = [];
        const ctx = makeCtx(calls);
        ctx.mgmt.getSessionTokensByModel = async () => { throw new Error("boom"); };
        const client = await connect(ctx);
        const res = await client.callTool({ name: "get_session_metrics", arguments: { session_id: UUID, include: ["summary", "tokens_by_model"] } });
        const body = parse(res);
        record("metrics axis error → isolated in errors{}, summary intact",
            !res.isError && body.summary && body.errors?.tokens_by_model === "boom");
        await client.close();
    }

    // ── 4. get_session_events paging modes ──────────────────────────────
    {
        const calls = [];
        const client = await connect(makeCtx(calls));

        const res = await client.callTool({ name: "get_session_events", arguments: { session_id: UUID, before_seq: 100, after_seq: 5 } });
        record("events before_seq+after_seq → isError", res.isError === true);

        calls.length = 0;
        const res2 = await client.callTool({ name: "get_session_events", arguments: { session_id: UUID, before_seq: 100, limit: 10, event_types: ["chat"] } });
        const call = calls.find(([n]) => n === "getSessionEventsBefore");
        record("events before_seq → getSessionEventsBefore(seq,limit,types)",
            !res2.isError && call && call[2] === 100 && call[3] === 10 && Array.isArray(call[4]));

        await client.close();
    }

    // ── 4b. debug_session axis mapping ───────────────────────────────────
    {
        const calls = [];
        const client = await connect(makeCtx(calls));

        await client.callTool({ name: "debug_session", arguments: { session_id: UUID, include: ["status", "retrieval_usage", "graph_searches"] } });
        const names = calls.map(([n]) => n);
        record("debug include → status+retrieval+graph_searches fetched",
            names.includes("getSessionStatus") && names.includes("getSessionRetrievalUsage") && names.includes("getSessionGraphSearches"));
        record("debug include → unrequested axes NOT fetched",
            !names.includes("getExecutionHistory") && !names.includes("getLatestResponse") && !names.includes("getSessionGraphNodeUsage"));

        calls.length = 0;
        await client.callTool({ name: "debug_session", arguments: { session_id: UUID, include: ["retrieval_usage"], tree: true } });
        record("debug tree=true → tree retrieval variant",
            calls.some(([n]) => n === "getSessionTreeRetrievalUsage") && !calls.some(([n]) => n === "getSessionRetrievalUsage"));

        const res = await client.callTool({ name: "debug_session", arguments: { session_id: UUID } });
        const body = parse(res);
        record("debug default axes → info/status/events/summary present",
            !res.isError && body.info && "status" in body && Array.isArray(body.events) && "summary" in body);

        await client.close();
    }

    // ── 5. 403 error mapping ─────────────────────────────────────────────
    {
        const calls = [];
        const ctx = makeCtx(calls);
        ctx.mgmt.stopSessionTurn = async () => { throw Object.assign(new Error("Forbidden"), { status: 403 }); };
        const client = await connect(ctx);
        const res = await client.callTool({ name: "stop_turn", arguments: { session_id: UUID } });
        record("403 from mgmt → actionable admin-role error",
            res.isError === true && /admin role/i.test(res.content[0].text));
        await client.close();
    }

    // ── 6. facts_admin dispatch ──────────────────────────────────────────
    {
        const calls = [];
        const client = await connect(makeCtx(calls));
        const res = await client.callTool({ name: "facts_admin", arguments: { action: "purge", cutoff: "2026-01-01T00:00:00Z" } });
        record("facts_admin purge → forcePurgeFacts, count returned", !res.isError && parse(res).purged === 2);

        const res2 = await client.callTool({ name: "facts_admin", arguments: { action: "prune_summaries", cutoff: "2026-01-01T00:00:00Z" } });
        record("facts_admin prune → pruneDeletedSummaries, count returned",
            !res2.isError && parse(res2).pruned === 3 && calls.some(([n, d]) => n === "pruneDeletedSummaries" && d instanceof Date));

        const res3 = await client.callTool({ name: "facts_admin", arguments: { action: "purge", cutoff: "not-a-date" } });
        record("facts_admin invalid cutoff → isError", res3.isError === true);
        await client.close();
    }

    // ── 7. create_session capabilities forwarding ────────────────────────
    {
        // Web mode: the web client cannot carry the capabilities param — the
        // tool must dispatch the create op directly with the override attached.
        const calls = [];
        const api = {
            async call(op, params) { calls.push(["api.call", op, params]); return { sessionId: UUID }; },
            async getAuthContext() { return { authorization: { role: "admin" } }; },
        };
        const webClient = {
            async createSession(cfg) { calls.push(["client.createSession", cfg]); return { sessionId: UUID, async send() {} }; },
            async createSessionForAgent(name, opts) { calls.push(["client.createSessionForAgent", name, opts]); return { sessionId: UUID, async send() {} }; },
            async resumeSession(id) { calls.push(["client.resumeSession", id]); return { sessionId: id, async send() {} }; },
        };
        const client = await connect(makeCtx(calls, { webMode: true, api, client: webClient }));

        const caps = { mcpServers: { enable: ["github"] }, tools: { disable: ["graph"] } };
        let res = await client.callTool({ name: "create_session", arguments: { agent: "researcher", capabilities: caps } });
        const agentCreate = calls.find(([n, op]) => n === "api.call" && op === "createSessionForAgent");
        record("create_session (web) agent+capabilities → createSessionForAgent op carries capabilities",
            !res.isError && agentCreate?.[2]?.agentName === "researcher" && agentCreate[2].capabilities?.tools?.disable?.[0] === "graph");
        record("create_session (web) capabilities → session handle resumed for the cache",
            !res.isError && calls.some(([n, id]) => n === "client.resumeSession" && id === UUID));

        calls.length = 0;
        res = await client.callTool({ name: "create_session", arguments: { capabilities: caps } });
        const genericCreate = calls.find(([n, op]) => n === "api.call" && op === "createSession");
        record("create_session (web) generic+capabilities → createSession op carries capabilities",
            !res.isError && genericCreate?.[2]?.capabilities?.mcpServers?.enable?.[0] === "github");

        calls.length = 0;
        res = await client.callTool({ name: "create_session", arguments: { agent: "researcher" } });
        record("create_session (web) without capabilities → web client path unchanged",
            !res.isError && calls.some(([n]) => n === "client.createSessionForAgent")
            && !calls.some(([n, op]) => n === "api.call" && (op === "createSession" || op === "createSessionForAgent")));

        res = await client.callTool({ name: "create_session", arguments: { capabilities: { bogus: { enable: ["x"] } } } });
        record("create_session unknown capability axis → rejected by schema", res.isError === true);

        await client.close();
    }
    {
        // Direct mode: capabilities pass through the SDK client's options.
        const calls = [];
        const directClient = {
            async createSession(cfg) { calls.push(["client.createSession", cfg]); return { sessionId: UUID, async send() {} }; },
            async createSessionForAgent(name, opts) { calls.push(["client.createSessionForAgent", name, opts]); return { sessionId: UUID, async send() {} }; },
        };
        const client = await connect(makeCtx(calls, { client: directClient }));
        const res = await client.callTool({ name: "create_session", arguments: { agent: "researcher", capabilities: { skills: { disable: ["deploy"] } } } });
        const call = calls.find(([n]) => n === "client.createSessionForAgent");
        record("create_session (direct) capabilities → client opts carry capabilities",
            !res.isError && call?.[2]?.capabilities?.skills?.disable?.[0] === "deploy");
        await client.close();
    }

    // ── 8. configure_session ─────────────────────────────────────────────
    {
        const calls = [];
        const api = {
            async call(op, params) {
                calls.push(["api.call", op, params]);
                if (op === "configureSession") return { appliesOn: "next_turn", commandDelivered: true };
                return {};
            },
            async getAuthContext() { return { authorization: { role: "admin" } }; },
        };
        const client = await connect(makeCtx(calls, { webMode: true, api }));

        let res = await client.callTool({ name: "configure_session", arguments: { session_id: UUID, capabilities: { tools: { disable: ["graph"] } } } });
        let body = parse(res);
        const call = calls.find(([n, op]) => n === "api.call" && op === "configureSession");
        record("configure_session (web) → configureSession op {sessionId, capabilities}",
            !res.isError && call?.[2]?.sessionId === UUID && call[2].capabilities?.tools?.disable?.[0] === "graph");
        record("configure_session (web) → op result verbatim + next-turn note",
            !res.isError && body.appliesOn === "next_turn" && body.commandDelivered === true && /next turn/i.test(body.note ?? ""));

        calls.length = 0;
        res = await client.callTool({ name: "configure_session", arguments: { session_id: UUID, capabilities: null } });
        const clear = calls.find(([n, op]) => n === "api.call" && op === "configureSession");
        record("configure_session (web) capabilities:null → clears the override",
            !res.isError && clear && clear[2].capabilities === null);

        res = await client.callTool({ name: "configure_session", arguments: { session_id: "not-a-uuid", capabilities: null } });
        record("configure_session invalid session_id shape → rejected", res.isError === true);

        res = await client.callTool({ name: "configure_session", arguments: { session_id: UUID, capabilities: { bogus: {} } } });
        record("configure_session unknown capability axis → rejected by schema", res.isError === true);

        await client.close();
    }
    {
        // Direct mode: the capability-override op is a Web API surface only.
        const calls = [];
        const client = await connect(makeCtx(calls));
        const res = await client.callTool({ name: "configure_session", arguments: { session_id: UUID, capabilities: null } });
        record("configure_session (direct) → clear web-mode-only error",
            res.isError === true && /web api mode/i.test(res.content[0].text));
        await client.close();
    }

    // ── 9. get_session_detail capability override ────────────────────────
    {
        const calls = [];
        const api = {
            async call(op, params) {
                calls.push(["api.call", op, params]);
                if (op === "getSessionCapabilities") return { tools: { disable: ["graph"] } };
                return {};
            },
            async getAuthContext() { return { authorization: { role: "admin" } }; },
        };
        const client = await connect(makeCtx(calls, { webMode: true, api }));

        let res = await client.callTool({ name: "get_session_detail", arguments: { session_id: UUID } });
        let body = parse(res);
        record("session detail (web) → capability_override from getSessionCapabilities",
            !res.isError && body.capability_override?.tools?.disable?.[0] === "graph"
            && calls.some(([n, op, p]) => n === "api.call" && op === "getSessionCapabilities" && p?.sessionId === UUID));

        api.call = async (op) => { calls.push(["api.call", op]); throw new Error("op not supported"); };
        res = await client.callTool({ name: "get_session_detail", arguments: { session_id: UUID } });
        body = parse(res);
        record("session detail (web) → override omitted on op error, detail intact",
            !res.isError && body.session && !("capability_override" in body));
        await client.close();
    }
    {
        // Direct mode: no capability_override key at all.
        const calls = [];
        const client = await connect(makeCtx(calls));
        const res = await client.callTool({ name: "get_session_detail", arguments: { session_id: UUID } });
        const body = parse(res);
        record("session detail (direct) → no capability_override key",
            !res.isError && body.session && !("capability_override" in body));
        await client.close();
    }

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
});
