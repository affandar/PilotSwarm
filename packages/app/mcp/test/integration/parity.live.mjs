#!/usr/bin/env node
// LIVE parity suite — the mcp-web-api-parity surface end-to-end.
//
// Boots the portal server (no-auth ⇒ admin role "anonymous") and drives the
// REAL MCP bin over stdio in Web API mode. Capability-dependent groups
// (enhanced facts, graph) key off get_capabilities and are SKIPPED — not
// failed — on deployments without the providers, so the suite is valid
// against both base and horizon-enabled dev databases.
//
// Covers: G1 capabilities (+ flag cross-check against /facts/capabilities),
// G3 turn/queue control, G4 artifacts round-trip, G5 groups round-trip,
// G6 observability, G7 system status, and G2 facts/graph when available.
//
// Usage:  node packages/app/mcp/test/integration/parity.live.mjs
// Requires: PostgreSQL via DATABASE_URL in .env, SDK + portal + mcp built.
//
// MCP_PARITY_REQUIRE=search,graph turns the capability SKIPs into FAILs —
// set it when the run is *dedicated* to a provider (e.g. the horizondb npm
// script), so a misconfigured provider cannot silently degrade to a green
// base run.

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startWebEnv, mcpStdioArgs } from "./web-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../../../..");

// Capabilities this run REQUIRES (comma-separated: search, graph). Absent
// required capability ⇒ FAIL, not SKIP.
const REQUIRED = new Set(
    (process.env.MCP_PARITY_REQUIRE ?? "").split(",").map((s) => s.trim()).filter(Boolean),
);

const results = [];
function record(name, status, detail = "") {
    results.push({ name, status });
    const icon = status === "PASS" ? "✅" : status === "FAIL" ? "❌" : "⚠️ ";
    console.log(`${icon} ${name.padEnd(56)} ${status}${detail ? ` (${String(detail).slice(0, 160)})` : ""}`);
}
function fail(name, err) {
    record(name, "FAIL", err?.message ?? String(err));
}
const parse = (res) => {
    const text = res?.content?.[0]?.text;
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
};

async function main() {
    const env = await startWebEnv(ROOT);
    const transport = new StdioClientTransport(mcpStdioArgs(ROOT, env.apiUrl));
    const client = new Client({ name: "mcp-parity-live", version: "1.0.0" }, { capabilities: {} });

    let sessionId = null;
    let groupId = null;

    try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        const toolNames = new Set(tools.map((t) => t.name));
        console.log(`connected — ${toolNames.size} tools\n`);

        // ── G1: capabilities, cross-checked against the API ─────────────
        let caps = null;
        try {
            caps = parse(await client.callTool({ name: "get_capabilities", arguments: {} }));
            const apiCaps = await fetch(`${env.apiUrl}/api/v1/facts/capabilities`).then((r) => r.json());
            const apiFlags = apiCaps?.result ?? apiCaps; // envelope tolerance
            const match = caps.facts.search === Boolean(apiFlags.search)
                && caps.facts.embedder === Boolean(apiFlags.embedder)
                && caps.graph === Boolean(apiFlags.graph);
            record("capabilities match /facts/capabilities", match ? "PASS" : "FAIL",
                `mcp=${JSON.stringify(caps.facts)}/g:${caps.graph} api=${JSON.stringify(apiFlags)}`);
            record("capabilities: no-auth ⇒ admin", caps.admin === true ? "PASS" : "FAIL");
            record("capabilities: mode=web", caps.mode === "web" ? "PASS" : "FAIL");
        } catch (err) { fail("capabilities", err); }

        // Tool presence must be consistent with flags.
        const graphConsistent = Boolean(caps?.graph) === toolNames.has("graph_search_nodes");
        const searchConsistent = Boolean(caps?.facts?.search) === toolNames.has("search_facts");
        record("tool list consistent with capability flags", graphConsistent && searchConsistent ? "PASS" : "FAIL",
            `graph=${caps?.graph}/${toolNames.has("graph_search_nodes")} search=${caps?.facts?.search}/${toolNames.has("search_facts")}`);

        // ── G7: system status preflight ─────────────────────────────────
        try {
            const status = parse(await client.callTool({ name: "get_system_status", arguments: {} }));
            // The harness portal runs embedded workers, so ≥ 1 here; remote
            // deployments with dedicated worker pods legitimately report 0.
            const workers = status?.workers?.embedded_count;
            record("system status: embedded workers ≥ 1 (harness)", Number(workers) >= 1 ? "PASS" : "FAIL", `workers=${JSON.stringify(status?.workers)}`);
            record("system status: policy present", status?.policy !== undefined ? "PASS" : "FAIL");
        } catch (err) { fail("system status", err); }

        // ── G5: session groups round-trip ────────────────────────────────
        try {
            const created = parse(await client.callTool({
                name: "manage_session_group",
                arguments: { action: "create", title: "parity-live group", description: "created by parity.live.mjs" },
            }));
            groupId = created?.group?.groupId ?? created?.group?.id;
            record("group create", groupId ? "PASS" : "FAIL", `groupId=${groupId}`);

            const updated = parse(await client.callTool({
                name: "manage_session_group",
                arguments: { action: "update", group_id: groupId, title: "parity-live group (renamed)" },
            }));
            record("group update", updated?.updated === true ? "PASS" : "FAIL");

            const listed = parse(await client.callTool({ name: "list_session_groups", arguments: {} }));
            const found = (listed?.groups ?? []).some((g) => (g.groupId ?? g.id) === groupId);
            record("group listed", found ? "PASS" : "FAIL", `count=${listed?.count}`);
        } catch (err) { fail("session groups", err); }

        // ── Session in a group, prompt-booted so a worker claims it ─────
        try {
            const created = parse(await client.callTool({
                name: "create_session",
                arguments: {
                    title: "parity-live session",
                    group_id: groupId ?? undefined,
                    prompt: "Reply with exactly: parity-ready. Then wait for further instructions.",
                },
            }));
            sessionId = created?.session_id;
            record("create_session (group_id + prompt)", sessionId ? "PASS" : "FAIL", `id=${sessionId}`);

            // Queue-and-monitor: watch the session's own status until the
            // orchestration starts (the async contract — no claim probing).
            let started = false;
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline && !started) {
                const detail = parse(await client.callTool({
                    name: "get_session_detail",
                    arguments: { session_id: sessionId, include: ["status"] },
                }));
                const orch = detail?.orchestration_status?.orchestrationStatus;
                if (orch && orch !== "NotFound") started = true;
                else await new Promise((r) => setTimeout(r, 500));
            }
            record("session status monitor → orchestration started", started ? "PASS" : "FAIL");
        } catch (err) { fail("create_session", err); }

        // ── G3: queue control — enqueue + cancel pending ────────────────
        // The orchestration is started (monitored above), so the command
        // channel is live. Residual race: the worker could consume the
        // enqueued message before cancel lands; detail prints if so.
        if (sessionId) {
            try {
                const msgId = `parity-${Date.now()}`;
                const sent = parse(await client.callTool({
                    name: "send_message",
                    arguments: { session_id: sessionId, message: "queued message (should be cancelled)", client_message_ids: [msgId], enqueue_only: true },
                }));
                record("send_message enqueue_only", sent?.sent === true ? "PASS" : "FAIL");
                const cancelled = parse(await client.callTool({
                    name: "cancel_pending_messages",
                    arguments: { session_id: sessionId, client_message_ids: [msgId] },
                }));
                record("cancel_pending_messages", cancelled?.cancelled === true ? "PASS" : "FAIL",
                    cancelled?.cancelled === true ? "" : JSON.stringify(cancelled));
            } catch (err) { fail("queue control", err); }
        }

        // ── G5b: viewer-private placement round-trip ─────────────────────
        if (sessionId && groupId) {
            try {
                const placed = parse(await client.callTool({
                    name: "manage_session_group",
                    arguments: { action: "place", group_id: groupId, session_ids: [sessionId] },
                }));
                const placedRoot = (placed?.results ?? []).find((r) => r.rootSessionId === sessionId);
                record("group place → placed root result", placed?.placed === true && placedRoot?.placed === true ? "PASS" : "FAIL", JSON.stringify(placed?.results ?? null));

                const listed = parse(await client.callTool({ name: "list_sessions", arguments: {} }));
                const row = (listed?.sessions ?? []).find((s) => s.session_id === sessionId);
                record("list_sessions carries viewer_group_id", row?.viewer_group_id === groupId ? "PASS" : "FAIL", `viewer_group_id=${row?.viewer_group_id}`);
                record("list_sessions has no legacy group field", row && !("group_id" in row) && !("groupId" in row) ? "PASS" : "FAIL");

                const ungrouped = parse(await client.callTool({
                    name: "manage_session_group",
                    arguments: { action: "place", session_ids: [sessionId] },
                }));
                const ungroupedRoot = (ungrouped?.results ?? []).find((r) => r.rootSessionId === sessionId);
                record("group place (null) → ungrouped", ungrouped?.placed === true && ungroupedRoot?.placed === true ? "PASS" : "FAIL");
            } catch (err) { fail("viewer placement", err); }
        }

        // ── G4: artifacts round-trip ─────────────────────────────────────
        if (sessionId) {
            try {
                const up = parse(await client.callTool({
                    name: "upload_artifact",
                    arguments: { session_id: sessionId, filename: "parity.md", content: "# parity artifact\nhello", content_type: "text/markdown" },
                }));
                record("artifact upload", up?.uploaded === true ? "PASS" : "FAIL");

                const listed = parse(await client.callTool({ name: "list_artifacts", arguments: { session_id: sessionId } }));
                record("artifact listed", (listed?.artifacts ?? []).some((a) => (a.filename ?? a.name) === "parity.md") ? "PASS" : "FAIL", `count=${listed?.count}`);

                const got = parse(await client.callTool({
                    name: "get_artifact",
                    arguments: { session_id: sessionId, filename: "parity.md", include: ["meta", "text"] },
                }));
                const text = typeof got?.text === "string" ? got.text : got?.text?.content ?? "";
                record("artifact text round-trip", String(text).includes("parity artifact") ? "PASS" : "FAIL");
                record("artifact meta + download_url", got?.meta && got?.download_url ? "PASS" : "FAIL");

                const del = parse(await client.callTool({ name: "delete_artifact", arguments: { session_id: sessionId, filename: "parity.md" } }));
                record("artifact delete", del?.deleted === true ? "PASS" : "FAIL");

                const relisted = parse(await client.callTool({ name: "list_artifacts", arguments: { session_id: sessionId } }));
                record("artifact gone after delete", !(relisted?.artifacts ?? []).some((a) => (a.filename ?? a.name) === "parity.md") ? "PASS" : "FAIL");
            } catch (err) { fail("artifacts", err); }
        }

        // ── G6: observability ───────────────────────────────────────────
        if (sessionId) {
            try {
                const metrics = parse(await client.callTool({
                    name: "get_session_metrics",
                    arguments: { session_id: sessionId, include: ["summary", "tokens_by_model", "facts_stats"] },
                }));
                // A no-turn session may legitimately have empty axes; shape is
                // what we assert — the keys exist or are isolated in errors.
                const shapeOk = metrics && ("summary" in metrics || "errors" in metrics);
                record("session metrics shape", shapeOk ? "PASS" : "FAIL", JSON.stringify(Object.keys(metrics ?? {})));
            } catch (err) { fail("session metrics", err); }

            try {
                const fleet = parse(await client.callTool({
                    name: "get_fleet_overview",
                    arguments: { include: ["stats", "shared_facts"] },
                }));
                record("fleet overview", fleet?.stats !== undefined ? "PASS" : "FAIL");
            } catch (err) { fail("fleet overview", err); }

            try {
                const events = parse(await client.callTool({
                    name: "get_session_events",
                    arguments: { session_id: sessionId, before_seq: 1000000, limit: 5 },
                }));
                record("events backward paging", Array.isArray(events?.events) ? "PASS" : "FAIL", `count=${events?.count}`);
            } catch (err) { fail("events backward paging", err); }

            // debug_session — the tuner-grade bundle, including the
            // retrieval/graph observability axes served by the NEW Web API
            // routes (this suite boots the portal from the working tree).
            try {
                const dbg = parse(await client.callTool({
                    name: "debug_session",
                    arguments: {
                        session_id: sessionId,
                        include: ["info", "status", "summary", "events", "retrieval_usage", "graph_searches", "orchestration_stats"],
                        events_limit: 10,
                    },
                }));
                const coreOk = dbg?.info && dbg?.status !== undefined && Array.isArray(dbg?.events);
                record("debug_session core axes", coreOk ? "PASS" : "FAIL", `keys=${Object.keys(dbg ?? {}).join(",")}`);
                const newRoutesOk = !dbg?.errors?.retrieval_usage && !dbg?.errors?.graph_searches;
                record("debug_session retrieval/graph axes (new API routes)", newRoutesOk ? "PASS" : "FAIL",
                    newRoutesOk ? "" : JSON.stringify(dbg?.errors));
            } catch (err) { fail("debug_session", err); }
        }

        // ── G2: enhanced facts (conditional) ─────────────────────────────
        if (caps?.facts?.search) {
            try {
                const key = `parity/live-${Date.now()}`;
                await client.callTool({ name: "store_fact", arguments: { key, value: { note: "parity search corpus zebra-quartz" }, shared: true } });
                const found = parse(await client.callTool({
                    name: "search_facts",
                    arguments: { query: "zebra-quartz", mode: "lexical", limit: 5 },
                }));
                record("search_facts lexical hit", (found?.facts ?? []).length > 0 ? "PASS" : "FAIL", `count=${found?.count}`);
                await client.callTool({ name: "delete_fact", arguments: { key } });
            } catch (err) { fail("enhanced facts", err); }

            try {
                const st = parse(await client.callTool({ name: "embedder_status", arguments: {} }));
                record("embedder_status", st && typeof st.running === "boolean" ? "PASS" : "FAIL");
            } catch (err) { fail("embedder_status", err); }
        } else if (REQUIRED.has("search")) {
            record("enhanced facts", "FAIL", "MCP_PARITY_REQUIRE=search but the deployment reports no search capability — provider misconfigured?");
        } else {
            record("enhanced facts", "SKIP", "deployment has no search capability");
        }

        // ── G2: graph (conditional) ──────────────────────────────────────
        if (caps?.graph) {
            try {
                const nodeA = parse(await client.callTool({
                    name: "graph_upsert_node",
                    arguments: { kind: "service", name: `parity-a-${Date.now()}` },
                }));
                const nodeB = parse(await client.callTool({
                    name: "graph_upsert_node",
                    arguments: { kind: "service", name: `parity-b-${Date.now()}` },
                }));
                const aKey = nodeA?.node?.nodeKey;
                const bKey = nodeB?.node?.nodeKey;
                record("graph node upserts", aKey && bKey ? "PASS" : "FAIL");

                const edge = parse(await client.callTool({
                    name: "graph_upsert_edge",
                    arguments: { from_key: aKey, to_key: bKey, predicate: "parity depends on" },
                }));
                record("graph edge upsert", edge?.upserted === true ? "PASS" : "FAIL");

                const hood = parse(await client.callTool({
                    name: "graph_neighbourhood",
                    arguments: { node_key: aKey, depth: 1 },
                }));
                const touchesB = JSON.stringify(hood ?? {}).includes(bKey);
                record("graph neighbourhood contains edge target", touchesB ? "PASS" : "FAIL");

                await client.callTool({ name: "graph_delete_edge", arguments: { from_key: aKey, to_key: bKey, predicate: "parity depends on" } });
                await client.callTool({ name: "graph_delete_node", arguments: { node_key: aKey } });
                const delB = parse(await client.callTool({ name: "graph_delete_node", arguments: { node_key: bKey } }));
                record("graph cleanup deletes", delB?.deleted === true ? "PASS" : "FAIL");
            } catch (err) { fail("graph round-trip", err); }
        } else if (REQUIRED.has("graph")) {
            record("graph round-trip", "FAIL", "MCP_PARITY_REQUIRE=graph but the deployment reports no graph store — provider misconfigured?");
        } else {
            record("graph round-trip", "SKIP", "deployment has no graph store");
        }

        // ── G3: complete_session (terminal-state distinctness) ──────────
        if (sessionId) {
            try {
                const done = parse(await client.callTool({ name: "complete_session", arguments: { session_id: sessionId, reason: "parity complete" } }));
                record("complete_session", done?.completed === true ? "PASS" : "FAIL");
                const detail = parse(await client.callTool({ name: "get_session_detail", arguments: { session_id: sessionId } }));
                const status = detail?.session?.status?.toLowerCase?.() ?? "";
                record("completed ≠ cancelled", status.includes("cancel") ? "FAIL" : "PASS", `status=${status}`);
            } catch (err) { fail("complete_session", err); }
        }
    } finally {
        // Cleanup: session then group (delete requires empty group).
        try {
            if (sessionId) await client.callTool({ name: "delete_session", arguments: { session_id: sessionId } });
            if (groupId) {
                if (sessionId) {
                    await client.callTool({ name: "manage_session_group", arguments: { action: "move", session_ids: [sessionId] } }).catch(() => {});
                }
                await client.callTool({ name: "manage_session_group", arguments: { action: "delete", group_id: groupId } }).catch(() => {});
            }
        } catch { /* best-effort */ }
        await client.close().catch(() => {});
        await env.stop();
    }

    const failed = results.filter((r) => r.status === "FAIL");
    console.log(`\n${results.filter((r) => r.status === "PASS").length} passed, ${failed.length} failed, ${results.filter((r) => r.status === "SKIP").length} skipped`);
    process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
});
