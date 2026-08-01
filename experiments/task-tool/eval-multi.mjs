// Phase 1c: multi-turn accretion eval — the production pathology.
//
// One session per (arm × model), 8 sequential exploration/command turns.
// Every tool result that lands in the parent transcript is re-sent as input
// on EVERY subsequent model call, so isolation compounds with turn count.
// Measures the per-turn parent context curve and cumulative input tokens.
//
// Models: claude-sonnet-5 (github) and gpt-5.4 (BYOK azure-openai — the
// waldemort-chk production model, expected to be chattier with tools).
//
// Usage: node eval-multi.mjs [--concurrency N]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, makeMarkerTools, runExperiment, sdkProviderFor } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE = path.resolve(HERE, "../..");
const env = loadEnv();

const TURNS = [
    {
        id: "t1-tool-sweep",
        prompt: "List the name of every LLM tool defined via defineTool() in packages/sdk/src/managed-session.ts, in definition order. Just the names.",
        expect: ["spawn_agent", "message_agent"],
    },
    {
        id: "t2-warm-discard",
        prompt: "In packages/sdk/src/session-manager.ts, under exactly which conditions is an existing warm in-memory Copilot session discarded instead of reused? List each condition.",
        expect: ["epoch"],
    },
    {
        id: "t3-noisy-cmd",
        prompt: "Run experiments/task-tool/fixture/scripts/noisy-build2.sh and report whether the build succeeded and the CHECKSUM value it printed. The checksum is computed at runtime, so you must actually run it.",
        expect: ["eb101da4d478"],
    },
    {
        id: "t4-copilot-home",
        prompt: "Which files under packages/sdk/src reference COPILOT_HOME? Name each file and say in one sentence why it touches COPILOT_HOME.",
        expect: ["session-manager.ts", "regen-worker.ts"],
    },
    {
        id: "t5-spawn-params",
        prompt: "List every parameter of the spawn_agent tool declaration in managed-session.ts with its type and a one-phrase purpose.",
        expect: ["agent_name", "reasoning_effort"],
    },
    {
        id: "t6-provider-azure",
        prompt: "Explain what _resolveProviderConfig in session-manager.ts does for azure-type providers, covering both the registry path and the legacy single-provider path.",
        expect: ["deployments"],
    },
    {
        id: "t7-search-paths",
        prompt: "List, in order, the search paths that resolveModelProvidersPath checks in packages/sdk/src/model-providers.ts.",
        expect: [".model_providers.json"],
    },
    {
        id: "t8-count-files",
        prompt: "Count how many .ts files under packages/sdk/src contain the string 'defineTool(' (run the count), report the number and name three such files.",
        expect: ["managed-session"],
    },
];

const BASE_PROMPT =
    "You are a PilotSwarm experiment session working in a TypeScript monorepo. " +
    "Answer questions about the codebase accurately and concisely. " +
    "You have PilotSwarm durability tools (ps_store_fact, ps_spawn_agent) for durable cross-restart work.";

// Trigger-based delineation — the crisp rules we would ship.
const DELINEATION =
    " You also have a 'task' tool for ephemeral in-process subagents: 'explore' (read-only codebase search) and " +
    "'swarm-task' (command execution). Delegation rules: (1) When answering requires searching or reading source " +
    "files, dispatch 'explore' with the question instead of grepping or viewing files yourself — relay its answer. " +
    "(2) When asked to run a build, test, script, or any command whose output you only need summarized, dispatch " +
    "'swarm-task'. (3) Only touch files directly yourself when you must edit them. Ephemeral subagents die with the " +
    "turn — that is fine; use ps_* durability tools only for work that must survive beyond this session.";

const LOCKED_SETTINGS = JSON.stringify({
    subagents: {
        disabledSubagents: [
            "task", "general-purpose", "code-review", "rubber-duck",
            "security-review", "rem-agent", "research",
        ],
    },
}, null, 2);

// on2: ALL built-ins disabled (explore too — its haiku pin spirals);
// custom agents only, no model pins → inherit the parent session model.
const LOCKED_SETTINGS_2 = JSON.stringify({
    subagents: {
        disabledSubagents: [
            "task", "general-purpose", "code-review", "rubber-duck",
            "security-review", "rem-agent", "research", "explore",
        ],
    },
}, null, 2);

const SWARM_EXPLORE_AGENT = {
    name: "swarm-explore",
    displayName: "Swarm Explorer",
    description: "Fast read-only codebase exploration and question answering in a separate context window. Safe to call in parallel.",
    tools: ["grep", "glob", "view", "bash"],
    prompt: "You are a read-only exploration agent. Answer the dispatching prompt from the codebase efficiently — prefer targeted grep over broad reading, keep it under 6 tool calls. Report a concise, complete answer, then stop.",
};

const SWARM_TASK_AGENT = {
    name: "swarm-task",
    displayName: "Swarm Task Runner",
    description: "Execute development commands (tests, builds, linters, shell). Brief summary on success plus requested values, full output on failure. Shell and file access only.",
    tools: ["bash", "view", "grep", "glob"],
    prompt: "You are a command-execution agent. Run exactly what the dispatching prompt asks. Report a one-line summary on success plus any specifically requested values, full output on failure. Do not retry or fix anything.",
};

function jobConfig(arm, modelKey, markerTools) {
    const model = modelKey === "sonnet" ? "claude-sonnet-5" : "gpt-5.4";
    const provider = modelKey === "sonnet" ? {} : { provider: sdkProviderFor("azure-openai", "gpt-5.4", env) };
    const common = { model, ...provider, workingDirectory: WORKTREE, tools: markerTools };
    if (arm === "off") {
        return { sessionConfig: { ...common, systemMessage: { content: BASE_PROMPT }, excludedTools: ["task"] } };
    }
    if (arm === "on2") {
        const delineation2 = DELINEATION.replaceAll("'explore'", "'swarm-explore'");
        return {
            homeFiles: { "settings.json": LOCKED_SETTINGS_2 },
            sessionConfig: {
                ...common,
                systemMessage: { content: BASE_PROMPT + delineation2 },
                customAgents: [SWARM_EXPLORE_AGENT, SWARM_TASK_AGENT],
            },
        };
    }
    return {
        homeFiles: { "settings.json": LOCKED_SETTINGS },
        sessionConfig: { ...common, systemMessage: { content: BASE_PROMPT + DELINEATION }, customAgents: [SWARM_TASK_AGENT] },
    };
}

// Per-turn analysis: context curve + input tokens per turn, split by lane.
function analyzeMultiTurn(eventsPath) {
    const turns = [];
    let cur = null;
    for (const line of fs.readFileSync(eventsPath, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (e.type === "user.message" && !e.agentId) {
            cur = { parentInput: 0, parentOutput: 0, subInput: 0, subOutput: 0, parentCtxEnd: null, taskUsed: false, subagents: [], parentToolCalls: 0, subToolCalls: 0 };
            turns.push(cur);
        }
        if (!cur) continue;
        if (e.type === "assistant.usage") {
            const d = e.data ?? {};
            const inTok = (d.inputTokens ?? 0) + (d.cacheReadTokens ?? 0) + (d.cacheWriteTokens ?? 0);
            if (e.agentId) { cur.subInput += inTok; cur.subOutput += d.outputTokens ?? 0; }
            else { cur.parentInput += inTok; cur.parentOutput += d.outputTokens ?? 0; }
        }
        if (e.type === "session.usage_info" && !e.agentId) cur.parentCtxEnd = e.data?.currentTokens ?? cur.parentCtxEnd;
        if (e.type === "subagent.started") { cur.taskUsed = true; cur.subagents.push(e.data?.agentName); }
        if (e.type === "tool.execution_start") {
            if (e.agentId) cur.subToolCalls += 1;
            else cur.parentToolCalls += 1;
        }
    }
    return turns;
}

async function runJob({ arm, modelKey }) {
    const invocations = [];
    const markerTools = makeMarkerTools(invocations);
    const cfg = jobConfig(arm, modelKey, markerTools);
    const { summary, eventsPath } = await runExperiment({
        name: `evalmulti-${arm}-${modelKey}`,
        env,
        turns: TURNS.map((t) => t.prompt),
        timeoutMs: 300_000,
        ...cfg,
    });
    const perTurn = analyzeMultiTurn(eventsPath);
    const graded = summary.turns.map((t, i) => ({
        id: TURNS[i]?.id,
        correct: TURNS[i]?.expect.every((x) => (t.reply ?? "").toLowerCase().includes(x.toLowerCase())),
        wallMs: t.ms,
        ...(perTurn[i] ?? {}),
    }));
    return {
        arm,
        model: modelKey,
        errors: summary.errors,
        markerInvocations: invocations,
        turns: graded,
        totals: {
            correct: graded.filter((g) => g.correct).length,
            n: graded.length,
            taskUsedTurns: graded.filter((g) => g.taskUsed).length,
            parentInput: graded.reduce((a, g) => a + (g.parentInput ?? 0), 0),
            subInput: graded.reduce((a, g) => a + (g.subInput ?? 0), 0),
            finalParentCtx: graded.at(-1)?.parentCtxEnd ?? null,
            wallMs: graded.reduce((a, g) => a + (g.wallMs ?? 0), 0),
        },
    };
}

const concurrency = Number(process.argv[process.argv.indexOf("--concurrency") + 1]) || 2;
const jobArgs = process.argv.slice(2).filter((a) => /^(off|on|on2)-(sonnet|gpt)$/.test(a));
const jobs = jobArgs.length
    ? jobArgs.map((a) => { const [arm, modelKey] = a.split("-"); return { arm, modelKey }; })
    : [
        { arm: "off", modelKey: "sonnet" },
        { arm: "on", modelKey: "sonnet" },
        { arm: "off", modelKey: "gpt" },
        { arm: "on", modelKey: "gpt" },
    ];

console.error(`running ${jobs.length} multi-turn sessions (8 turns each, concurrency ${concurrency})`);
const results = [];
let i = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
    while (i < jobs.length) {
        const idx = i++;
        try { results[idx] = await runJob(jobs[idx]); }
        catch (err) { results[idx] = { error: err?.message, job: jobs[idx] }; }
    }
}));

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = path.join(HERE, "results", `eval-multi-${stamp}.json`);
fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

for (const r of results) {
    if (r.error) { console.log(JSON.stringify(r)); continue; }
    console.log(JSON.stringify({ arm: r.arm, model: r.model, ...r.totals, ctxCurve: r.turns.map((t) => t.parentCtxEnd), taskCurve: r.turns.map((t) => t.taskUsed ? 1 : 0) }));
}
console.error(`full results: ${outPath}`);
