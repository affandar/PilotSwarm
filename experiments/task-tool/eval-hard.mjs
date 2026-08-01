// Phase 1b: hard A/B eval — scenarios shaped like the task tool's actual niche
// (broad sweeps, noisy commands, fan-out). The easy eval (eval.mjs) showed
// zero adoption on trivial questions; this one measures whether the model
// reaches for task when the work is genuinely verbose, and what it saves.
//
// ON arm ships the delineation guidance we would actually deploy; OFF arm is
// today's prod config with the same base prompt minus task guidance.
//
// Usage: node eval-hard.mjs <on|off|both> [--concurrency N]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, makeMarkerTools, runExperiment, analyzeEvents } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKTREE = path.resolve(HERE, "../..");
const FIXTURE = path.join(HERE, "fixture");
const env = loadEnv();

const SCENARIOS = [
    {
        id: "h1-broad-sweep",
        cwd: WORKTREE,
        prompt:
            "List the name of every LLM tool defined via defineTool() in packages/sdk/src/managed-session.ts, " +
            "in definition order. Just the tool names.",
        expect: ["spawn_agent", "message_agent", "wait_for_agents", "complete_agent"],
    },
    {
        id: "h2-noisy-cmd",
        cwd: FIXTURE,
        prompt:
            "Run scripts/noisy-build.sh in the working directory. Confirm whether the build succeeded and report " +
            "the CHECKSUM value it prints.",
        expect: ["7f3a9c-e51b22"],
    },
    {
        id: "h3-fanout",
        cwd: WORKTREE,
        prompt:
            "Answer all four questions about this repo: " +
            "(a) Which file defines the static method subAgentToolDefs? " +
            "(b) What default Azure apiVersion does model-providers.ts fall back to? " +
            "(c) What is the primary (non-legacy) filename resolveModelProvidersPath searches for? " +
            "(d) What is the name of the LLM tool that sends a message to a running sub-agent?",
        expect: ["managed-session.ts", "2024-10-21", ".model_providers.json", "message_agent"],
    },
    {
        id: "h4-multi-file",
        cwd: WORKTREE,
        prompt:
            "Which files under packages/sdk/src reference COPILOT_HOME? Report every file path, and for each, " +
            "one sentence on why it touches COPILOT_HOME.",
        expect: ["session-manager.ts", "regen-worker.ts"],
    },
];

const BASE_PROMPT =
    "You are a PilotSwarm experiment session working in a TypeScript monorepo. " +
    "Answer questions about the codebase accurately and concisely. " +
    "You have PilotSwarm durability tools (ps_store_fact, ps_spawn_agent) for durable cross-restart work.";

// The delineation guidance the worker would actually ship with task enabled.
const DELINEATION =
    " You also have a 'task' tool that runs ephemeral in-process subagents ('explore' for read-only codebase " +
    "exploration, 'swarm-task' for running commands). Prefer delegating broad file sweeps and noisy command " +
    "execution to these subagents so their verbose output stays out of your context; they die with the turn and " +
    "that is fine. Use PilotSwarm durability tools (ps_*) only for work that must survive beyond this turn.";

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
    prompt: "You are a command-execution agent. Run exactly what the dispatching prompt asks. Report a one-line summary on success plus any specifically requested values, full output on failure. Do not retry or fix anything.",
};

function armConfig(arm, scenario, markerTools) {
    const common = {
        model: "claude-sonnet-5",
        workingDirectory: scenario.cwd,
        tools: markerTools,
    };
    if (arm === "off") {
        return {
            sessionConfig: {
                ...common,
                systemMessage: { content: BASE_PROMPT },
                excludedTools: ["task"],
            },
        };
    }
    return {
        homeFiles: { "settings.json": LOCKED_SETTINGS },
        sessionConfig: {
            ...common,
            systemMessage: { content: BASE_PROMPT + DELINEATION },
            customAgents: [SWARM_TASK_AGENT],
        },
    };
}

async function runOne(arm, s) {
    const invocations = [];
    const markerTools = makeMarkerTools(invocations);
    const cfg = armConfig(arm, s, markerTools);
    const { summary, eventsPath } = await runExperiment({
        name: `evalhard-${arm}-${s.id}`,
        env,
        turns: [s.prompt],
        timeoutMs: 300_000,
        ...cfg,
    });
    const turn = summary.turns[0] ?? {};
    const reply = turn.reply ?? "";
    const analysis = analyzeEvents(eventsPath);
    return {
        arm,
        id: s.id,
        correct: s.expect.every((x) => reply.toLowerCase().includes(x.toLowerCase())),
        wallMs: turn.ms ?? null,
        reply: reply.slice(0, 500),
        errors: summary.errors,
        markerInvocations: invocations,
        ...analysis,
    };
}

async function pool(items, worker, concurrency) {
    const results = [];
    let i = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
        while (i < items.length) {
            const idx = i++;
            try { results[idx] = await worker(items[idx]); }
            catch (err) { results[idx] = { error: err?.message, item: items[idx] }; }
        }
    }));
    return results;
}

const which = process.argv[2] ?? "both";
const concurrency = Number(process.argv[process.argv.indexOf("--concurrency") + 1]) || 3;
const arms = which === "both" ? ["off", "on"] : [which];
const jobs = arms.flatMap((arm) => SCENARIOS.map((s) => ({ arm, s })));

console.error(`running ${jobs.length} sessions (arms: ${arms.join(",")}, concurrency ${concurrency})`);
const results = await pool(jobs, ({ arm, s }) => runOne(arm, s), concurrency);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = path.join(HERE, "results", `eval-hard-${stamp}.json`);
fs.writeFileSync(outPath, JSON.stringify(results, null, 2));

for (const arm of arms) {
    const rs = results.filter((r) => r.arm === arm && !r.error);
    console.log(JSON.stringify({
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
        perScenario: rs.map((r) => ({ id: r.id, correct: r.correct, taskUsed: r.taskUsed, subagents: r.subagentNames, wallMs: r.wallMs, parentCtx: r.parentFinalCtx })),
    }, null, 2));
}
console.error(`full results: ${outPath}`);
