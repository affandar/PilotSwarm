// Phase 0 harness for the native Copilot SDK "task" (subagent) tool experiments.
//
// Mirrors the session config that packages/sdk/src/session-manager.ts builds
// (streaming, includeSubAgentStreamingEvents:false, infiniteSessions, custom
// tools registered at createSession time) so findings transfer to the worker.
//
// Runs standalone against @github/copilot-sdk resolved from the main checkout's
// node_modules — no build of the monorepo needed.

import { CopilotClient, defineTool, approveAll } from "@github/copilot-sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN_REPO = "/Users/affandar/workshop/drox/pilotswarm";
const RESULTS_DIR = path.join(HERE, "results");

// ── env loading (main repo .env, no dotenv dep) ─────────────────────────────
export function loadEnv() {
    const envPath = path.join(MAIN_REPO, ".env");
    const out = {};
    if (fs.existsSync(envPath)) {
        for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
            const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
            if (m && !line.trim().startsWith("#")) out[m[1]] = m[2];
        }
    }
    return out;
}

export function loadProviderRegistry() {
    return JSON.parse(fs.readFileSync(path.join(MAIN_REPO, ".model_providers.json"), "utf-8"));
}

// Mirror of ModelProviderRegistry.resolve() for BYOK providers.
export function sdkProviderFor(providerId, modelName, env) {
    const reg = loadProviderRegistry();
    const p = reg.providers.find((x) => x.id === providerId);
    if (!p) throw new Error(`provider ${providerId} not in .model_providers.json`);
    const resolveEnv = (v) => (v?.startsWith("env:") ? env[v.slice(4)] : v);
    const baseUrl = p.type === "azure" && !p.baseUrl.includes("/deployments/")
        ? `${p.baseUrl.replace(/\/+$/, "")}/deployments/${modelName}`
        : p.baseUrl;
    return {
        type: p.type,
        baseUrl,
        apiKey: resolveEnv(p.apiKey),
        ...(p.type === "azure" && { azure: { apiVersion: p.apiVersion || "2024-10-21" } }),
    };
}

// ── marker tools: stand-ins for PilotSwarm durability tools ──────────────────
// Handlers record every invocation so we can tell exactly WHO called them
// (parent turn vs subagent) from the paired tool.execution events.
export function makeMarkerTools(invocationLog) {
    const mk = (name, description, parameters) =>
        defineTool(name, {
            description,
            parameters,
            handler: async (args) => {
                invocationLog.push({ tool: name, args, at: new Date().toISOString() });
                return `${name}: recorded (experiment stub)`;
            },
        });
    return [
        mk(
            "ps_store_fact",
            "Store a durable fact in the PilotSwarm shared knowledge store. (PilotSwarm durability tool)",
            {
                type: "object",
                properties: {
                    key: { type: "string", description: "Fact key" },
                    value: { type: "string", description: "Fact value" },
                },
                required: ["key", "value"],
            },
        ),
        mk(
            "ps_spawn_agent",
            "Spawn a durable PilotSwarm sub-agent session that survives worker restarts. (PilotSwarm durability tool)",
            {
                type: "object",
                properties: { task: { type: "string", description: "Task for the durable sub-agent" } },
                required: ["task"],
            },
        ),
    ];
}

// ── event-stream analysis (shared by evals) ─────────────────────────────────
export function analyzeEvents(eventsPath) {
    const out = {
        taskUsed: false,
        subagentNames: [],
        parentFinalCtx: null,
        parentTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 },
        subagentTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 },
        parentToolCalls: 0,
        subagentToolCalls: 0,
    };
    for (const line of fs.readFileSync(eventsPath, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        const lane = e.agentId ? "subagent" : "parent";
        if (e.type === "subagent.started") {
            out.taskUsed = true;
            out.subagentNames.push(e.data?.agentName);
        }
        if (e.type === "session.usage_info" && !e.agentId) {
            out.parentFinalCtx = e.data?.currentTokens ?? out.parentFinalCtx;
        }
        if (e.type === "assistant.usage") {
            const bucket = lane === "subagent" ? out.subagentTokens : out.parentTokens;
            bucket.input += e.data?.inputTokens ?? 0;
            bucket.output += e.data?.outputTokens ?? 0;
            bucket.cacheRead += e.data?.cacheReadTokens ?? 0;
            bucket.cacheWrite += e.data?.cacheWriteTokens ?? 0;
            bucket.calls += 1;
        }
        if (e.type === "tool.execution_start") {
            if (lane === "subagent") out.subagentToolCalls += 1;
            else out.parentToolCalls += 1;
        }
    }
    return out;
}

// ── experiment runner ────────────────────────────────────────────────────────
export async function runExperiment({ name, env, sessionConfig, turns, timeoutMs = 240_000, homeFiles }) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const eventsPath = path.join(RESULTS_DIR, `${name}-${stamp}.events.jsonl`);
    const summaryPath = path.join(RESULTS_DIR, `${name}-${stamp}.summary.json`);
    const eventsFd = fs.openSync(eventsPath, "w");

    const home = path.join(RESULTS_DIR, ".copilot-home", `${name}-${stamp}`);
    fs.mkdirSync(home, { recursive: true });
    for (const [rel, content] of Object.entries(homeFiles ?? {})) {
        const p = path.join(home, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
    }

    const client = new CopilotClient({
        ...(env.GITHUB_TOKEN ? { gitHubToken: env.GITHUB_TOKEN } : {}),
        logLevel: "error",
        env: { ...process.env, ...env, COPILOT_HOME: home },
    });

    const summary = { name, eventsPath, turns: [], subagentEvents: [], toolCalls: [], errors: [] };
    try {
        const session = await client.createSession({
            onPermissionRequest: approveAll,
            streaming: true,
            includeSubAgentStreamingEvents: false,
            infiniteSessions: { enabled: true },
            ...sessionConfig,
        });

        session.on((event) => {
            const rec = { at: new Date().toISOString(), ...event };
            fs.writeSync(eventsFd, JSON.stringify(rec) + "\n");
            const t = event.type ?? "";
            if (t.startsWith("subagent")) {
                summary.subagentEvents.push({ type: t, agentId: event.agentId, data: event.data });
            }
            if (t === "tool.execution_start") {
                summary.toolCalls.push({
                    tool: event.data?.toolName ?? event.data?.name,
                    agentId: event.agentId ?? null,
                    args: event.data?.arguments ?? event.data?.input ?? null,
                });
            }
            if (t === "session.error" || t === "error") summary.errors.push(event);
        });

        for (const turn of turns) {
            const t0 = Date.now();
            const reply = await session.sendAndWait({ prompt: turn }, timeoutMs);
            summary.turns.push({
                prompt: turn,
                ms: Date.now() - t0,
                reply: reply?.data?.content ?? reply?.content ?? null,
            });
        }

        await session.destroy?.();
    } catch (err) {
        summary.errors.push({ fatal: true, message: err?.message, stack: err?.stack });
    } finally {
        await client.stop().catch(() => {});
        fs.closeSync(eventsFd);
        fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    }
    return { summary, summaryPath, eventsPath };
}
