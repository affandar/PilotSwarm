#!/usr/bin/env node
// LIVE smoke — MCP server in Web API mode (the supported mode).
//
// Boots the portal server (no-auth, embedded worker) and drives the REAL MCP
// bin over stdio with `--api-url`. The MCP server holds no database
// credentials. Covers:
//
//   1. Cold-session send: create_session without a prompt, then send through
//      the send_and_wait tool — the resumeSession+send path (the B2 fix),
//      end-to-end through the Web API.
//   2. Cached-handle cursor refresh: create_session with a fire-and-forget
//      prompt, let it finish, then send_and_wait returns only response two.
//   3. list_models field shape (qualified_name + model_name) served WITHOUT
//      --model-providers: web mode reads models from the deployment
//      (mgmt.getModelsByProvider fallback).
//   4. switch_model in web mode (mgmt.setSessionModel — the portal UI path).
//   5. send_command surfaces the clear direct-mode-only error.
//
// Usage:  node packages/app/mcp/test/integration/smoke.live.mjs
// Requires: PostgreSQL via DATABASE_URL, GITHUB_TOKEN (or model provider
//           credentials) in .env, SDK + portal + mcp-server built.

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startWebEnv, mcpStdioArgs } from "./web-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../../../..");

const results = [];
function record(name, status, detail = "") {
    results.push({ name, status, detail });
    const icon = status === "PASS" ? "✅" : status === "FAIL" ? "❌" : "⚠️ ";
    console.log(`${icon} ${name.padEnd(48)} ${status}${detail ? ` (${detail})` : ""}`);
}
function fail(name, err) {
    record(name, "FAIL", err?.message?.slice(0, 200) ?? String(err).slice(0, 200));
}
function parseToolResult(result) {
    const text = result?.content?.[0]?.text;
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
}

async function waitForSettledSession(client, sessionId, timeoutMs = 180_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const detail = parseToolResult(await client.callTool({
            name: "get_session_detail",
            arguments: { session_id: sessionId, include: ["status", "response"] },
        }));
        const status = detail?.session?.status;
        if (["idle", "waiting", "input_required", "completed", "failed", "cancelled"].includes(status)) return detail;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    throw new Error(`session ${sessionId} did not settle within ${timeoutMs}ms`);
}

async function main() {
    const env = await startWebEnv(ROOT);
    const transport = new StdioClientTransport(mcpStdioArgs(ROOT, env.apiUrl));
    const client = new Client({ name: "mcp-web-smoke", version: "1.0.0" }, { capabilities: {} });

    let sessionId = null;
    let cursorSessionId = null;
    try {
        await client.connect(transport);
        record("connect (stdio, --api-url)", "PASS");

        // ── 1. list_models works with NO --model-providers (web fallback) ──
        try {
            const res = await client.callTool({ name: "list_models", arguments: {} });
            const data = parseToolResult(res);
            const first = data?.models?.[0];
            if (res.isError || !first) {
                record("list_models via Web API", "FAIL", JSON.stringify(data)?.slice(0, 120));
            } else if (first.qualified_name && first.model_name && !("name" in first)) {
                record("list_models via Web API", "PASS", `${data.models.length} models, first=${first.qualified_name}`);
            } else {
                record("list_models via Web API", "FAIL", `bad field shape: ${JSON.stringify(first).slice(0, 120)}`);
            }
        } catch (err) { fail("list_models via Web API", err); }

        // ── 2. Cold session: create WITHOUT prompt, then send_and_wait ──
        // The MCP send tools follow the resumeSession+send path (B2): a
        // dormant orchestration must boot when the first send arrives.
        try {
            const created = parseToolResult(await client.callTool({
                name: "create_session",
                arguments: { title: "mcp-web-smoke" },
            }));
            sessionId = created?.session_id ?? null;
            if (!sessionId) throw new Error(`no session_id in ${JSON.stringify(created).slice(0, 120)}`);
            record("create_session (cold, no prompt)", "PASS", sessionId.slice(0, 8));

            const answer = parseToolResult(await client.callTool({
                name: "send_and_wait",
                arguments: {
                    session_id: sessionId,
                    message: "Reply with exactly one word: pong",
                    timeout_ms: 180_000,
                },
            }));
            const text = String(answer?.response ?? answer ?? "");
            if (text.toLowerCase().includes("pong")) {
                record("cold-session send_and_wait (B2 path)", "PASS", `"${text.slice(0, 40)}"`);
            } else {
                record("cold-session send_and_wait (B2 path)", "FAIL", `response: ${text.slice(0, 120)}`);
            }
        } catch (err) { fail("cold-session send_and_wait (B2 path)", err); }

        // ── 3. Cached handle: initial fire-and-forget must not satisfy turn 2 ──
        try {
            const firstMarker = "FIRST_CURSOR_MARKER";
            const secondMarker = "SECOND_CURSOR_MARKER";
            const created = parseToolResult(await client.callTool({
                name: "create_session",
                arguments: {
                    title: "mcp-web-cursor-smoke",
                    prompt: `Reply with exactly: ${firstMarker}`,
                },
            }));
            cursorSessionId = created?.session_id ?? null;
            if (!cursorSessionId) throw new Error(`no session_id in ${JSON.stringify(created).slice(0, 120)}`);
            await waitForSettledSession(client, cursorSessionId);

            const answer = parseToolResult(await client.callTool({
                name: "send_and_wait",
                arguments: {
                    session_id: cursorSessionId,
                    message: `Reply with exactly: ${secondMarker}`,
                    timeout_ms: 180_000,
                },
            }));
            const text = String(answer?.response ?? answer ?? "");
            if (text.includes(secondMarker) && !text.includes(firstMarker)) {
                record("cached send_and_wait cursor refresh", "PASS", `"${text.slice(0, 60)}"`);
            } else {
                record("cached send_and_wait cursor refresh", "FAIL", `response: ${text.slice(0, 120)}`);
            }
        } catch (err) { fail("cached send_and_wait cursor refresh", err); }

        // ── 4. switch_model over the Web API ──
        if (sessionId) {
            try {
                const models = parseToolResult(await client.callTool({ name: "list_models", arguments: {} }));
                const target = models?.default_model || models?.models?.[0]?.qualified_name;
                const res = await client.callTool({
                    name: "switch_model",
                    arguments: { session_id: sessionId, model: target },
                });
                const data = parseToolResult(res);
                if (data?.switched === true) {
                    record("switch_model (web setSessionModel path)", "PASS", target);
                } else {
                    record("switch_model (web setSessionModel path)", "FAIL", JSON.stringify(data)?.slice(0, 120));
                }
            } catch (err) { fail("switch_model (web setSessionModel path)", err); }
        }

        // ── 5. send_command is direct-mode only ──
        if (sessionId) {
            try {
                const res = await client.callTool({
                    name: "send_command",
                    arguments: { session_id: sessionId, command: "get_info" },
                });
                const data = parseToolResult(res);
                if (res.isError && String(data?.error ?? "").includes("direct-mode only")) {
                    record("send_command → direct-mode-only error", "PASS");
                } else {
                    record("send_command → direct-mode-only error", "FAIL", JSON.stringify(data)?.slice(0, 120));
                }
            } catch (err) { fail("send_command → direct-mode-only error", err); }
        }
    } finally {
        // Cleanup: delete the smoke session, disconnect, stop the portal.
        try {
            if (sessionId) await client.callTool({ name: "delete_session", arguments: { session_id: sessionId } });
            if (cursorSessionId) await client.callTool({ name: "delete_session", arguments: { session_id: cursorSessionId } });
        } catch {}
        try { await client.close(); } catch {}
        await env.stop();
    }

    const failed = results.filter((r) => r.status === "FAIL");
    console.log(`\nSummary: ${results.length - failed.length} PASS, ${failed.length} FAIL`);
    process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
    console.error("❌ smoke crashed:", err);
    process.exit(2);
});
