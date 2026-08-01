// Phase 1 A/B eval: native task tool ON (locked config) vs OFF (today's prod).
//
// Each question runs as a fresh single-turn session against the worktree
// codebase. Ground truth is a substring the correct answer must contain.
//
// Metrics per run, parsed from the captured event stream:
//   - correct: expected substring present in the final reply
//   - wallMs: turn latency
//   - taskUsed: whether the model dispatched a native subagent
//   - parentFinalCtx: last parent-lane session.usage_info.currentTokens
//   - parentTokens/subagentTokens: assistant.usage split by agentId lane
//   - leak canary: any ps_* marker invocation from a subagent lane fails the run
//
// Usage: node eval.mjs <on|off|both> [--concurrency N]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, makeMarkerTools, runExperiment } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE = path.resolve(HERE, "../..");
const env = loadEnv();

const QUESTIONS = [
    {
        id: "q1-subagent-defs",
        prompt: "In this repo, which file defines the static method subAgentToolDefs? Give the path.",
        expect: ["managed-session.ts"],
    },
    {
        id: "q2-excluded-tools",
        prompt: "In packages/sdk/src/session-manager.ts, what exact value is passed as excludedTools in the session config?",
        expect: ["task"],
    },
    {
        id: "q3-providers-env",
        prompt: "Which environment variables can override the model providers config file path in this repo? Name them exactly.",
        expect: ["PS_MODEL_PROVIDERS_PATH"],
    },
    {
        id: "q4-azure-apiversion",
        prompt: "What default Azure apiVersion string does packages/sdk/src/model-providers.ts fall back to?",
        expect: ["2024-10-21"],
    },
    {
        id: "q5-message-tool",
        prompt: "What is the name of the LLM tool (defined in managed-session.ts) that sends a message to a running sub-agent?",
        expect: ["message_agent"],
    },
    {
        id: "q6-search-fallbacks",
        prompt: "What is the primary (non-legacy) filename that resolveModelProvidersPath searches for?",
        expect: [".model_providers.json"],
    },
    {
        id: "q7-streaming-flag",
        prompt: "In packages/sdk/src/session-manager.ts, what value is set for includeSubAgentStreamingEvents in the session config, and why per the adjacent comment?",
        expect: ["false"],
    },
    {
        id: "q8-run-command",
        prompt: "Run `ls packages/` in the working directory and report exactly which package directories exist.",
        expect: ["horizon-store"],
    },
];

const SYSTEM = {
    content:
        "You are a PilotSwarm experiment session working in a TypeScript monorepo. " +
        "Answer questions about the codebase accurately and concisely. " +
        "You have PilotSwarm durability tools (ps_store_fact, ps_spawn_agent) for durable cross-restart work. " +
        "If a 'task' tool is available, you may use it to delegate exploration or command execution to " +
        "ephemeral subagents to keep your own context clean. Choose whatever approach answers fastest and most accurately.",
};

const LOCKED_SETTINGS = JSON.stringify({
    subagents: {
        disabledSubagents: [
            "task", "general-purpose", "code-review", "rubber-duck",
            "security-review", "rem-agent", "research",
        ],
    },
}, null, 2);

const SWARM_TASK_AGENT = {
    name: "swarm-task",
    displayName: "Swarm Task Runner",
    description: "Execute development commands (tests, builds, linters, shell). Brief summary on success, full output on failure. Shell and file access only.",
    tools: ["bash", "view", "grep", "glob"],
    prompt: "You are a command-execution agent. Run exactly what the dispatching prompt asks. Report a one-line summary on success, full output on failure. Do not retry or fix anything.",
};

function armConfig(arm, markerTools) {
    const common = {
        model: "claude-sonnet-5",
        workingDirectory: WORKTREE,
        tools: markerTools,
        systemMessage: SYSTEM,
    };
    if (arm === "off") return { sessionConfig: { ...common, excludedTools: ["task"] } };
    return {
        homeFiles: { "settings.json": LOCKED_SETTINGS },
        sessionConfig: { ...common, customAgents: [SWARM_TASK_AGENT] },
    };
}

function analyzeEvents(eventsPath) {
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

async function runOne(arm, q) {
    const invocations = [];
    const markerTools = makeMarkerTools(invocations);
    const cfg = armConfig(arm, markerTools);
    const { summary, eventsPath } = await runExperiment({
        name: `eval-${arm}-${q.id}`,
        env,
        turns: [q.prompt],
        timeoutMs: 300_000,
        ...cfg,
    });
    const turn = summary.turns[0] ?? {};
    const reply = turn.reply ?? "";
    const analysis = analyzeEvents(eventsPath);
    const subagentMarkerCalls = invocations.length && analysis.taskUsed ? invocations : [];
    return {
        arm,
        id: q.id,
        correct: q.expect.every((s) => reply.toLowerCase().includes(s.toLowerCase())),
        wallMs: turn.ms ?? null,
        reply: reply.slice(0, 400),
        errors: summary.errors,
        markerInvocations: invocations,
        possibleLeak: subagentMarkerCalls,
        ...analysis,
    };
}

async function pool(items, worker, concurrency) {
    const results = [];
    let i = 0;
    const runners = Array.from({ length: concurrency }, async () => {
        while (i < items.length) {
            const idx = i++;
            try {
                results[idx] = await worker(items[idx]);
            } catch (err) {
                results[idx] = { error: err?.message, item: items[idx] };
            }
        }
    });
    await Promise.all(runners);
    return results;
}

const which = process.argv[2] ?? "both";
const concurrency = Number(process.argv[process.argv.indexOf("--concurrency") + 1]) || 3;
const arms = which === "both" ? ["off", "on"] : [which];
const jobs = arms.flatMap((arm) => QUESTIONS.map((q) => ({ arm, q })));

console.error(`running ${jobs.length} sessions (arms: ${arms.join(",")}, concurrency ${concurrency})`);
const results = await pool(jobs, ({ arm, q }) => runOne(arm, q), concurrency);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = path.join(HERE, "results", `eval-${stamp}.json`);
fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

// aggregate
for (const arm of arms) {
    const rs = results.filter((r) => r.arm === arm && !r.error);
    const agg = {
        arm,
        n: rs.length,
        correct: rs.filter((r) => r.correct).length,
        taskUsed: rs.filter((r) => r.taskUsed).length,
        meanWallMs: Math.round(rs.reduce((a, r) => a + (r.wallMs ?? 0), 0) / (rs.length || 1)),
        meanParentFinalCtx: Math.round(rs.reduce((a, r) => a + (r.parentFinalCtx ?? 0), 0) / (rs.length || 1)),
        meanParentInputTok: Math.round(rs.reduce((a, r) => a + r.parentTokens.input + r.parentTokens.cacheRead + r.parentTokens.cacheWrite, 0) / (rs.length || 1)),
        meanSubagentTok: Math.round(rs.reduce((a, r) => a + r.subagentTokens.input + r.subagentTokens.cacheRead + r.subagentTokens.cacheWrite, 0) / (rs.length || 1)),
        parentToolCalls: rs.reduce((a, r) => a + r.parentToolCalls, 0),
        subagentToolCalls: rs.reduce((a, r) => a + r.subagentToolCalls, 0),
        leaks: rs.filter((r) => r.possibleLeak.length).map((r) => r.id),
    };
    console.log(JSON.stringify(agg, null, 2));
}
console.error(`full results: ${outPath}`);
