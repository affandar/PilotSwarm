// Phase 0 experiments: native task tool dispatch, tool leakage, restriction, BYOK.
//
// Usage: node run.mjs <control|dispatch|leak|restricted|byok>

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, makeMarkerTools, runExperiment, sdkProviderFor } from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixture");
const env = loadEnv();

const invocations = [];
const markerTools = makeMarkerTools(invocations);

// Parent-visible system message: minimal, names both mechanisms like the
// worker prompt would, so mechanism choice is observable rather than forced.
const SYSTEM = {
    content:
        "You are a PilotSwarm experiment session. You have PilotSwarm durability tools " +
        "(ps_store_fact, ps_spawn_agent) for durable cross-restart work, and may also have " +
        "a native 'task' tool for ephemeral in-process subagents. Follow instructions exactly.",
};

const COMMON = {
    model: "claude-sonnet-5",
    workingDirectory: FIXTURE,
    tools: markerTools,
    systemMessage: SYSTEM,
};

const EXPERIMENTS = {
    // Baseline: today's worker config — task excluded. Sanity-check the harness
    // and record the control tool roster.
    control: {
        sessionConfig: { ...COMMON, excludedTools: ["task"] },
        turns: [
            "List the exact names of every tool you currently have access to, one per line. Do not call any tools.",
        ],
    },

    // Q1: does native subagent dispatch work at all (github provider)?
    // Q2 (partial): which model does the pinned-haiku explore agent report?
    dispatch: {
        sessionConfig: { ...COMMON },
        turns: [
            "Use your 'task' tool to launch an 'explore' agent. Its job: find the value of MAGIC_CONSTANT " +
            "in this project and report which file defines it. Relay the subagent's answer verbatim.",
        ],
    },

    // Q3: do SDK-registered custom tools (our durability markers) leak into
    // built-in subagents whose definition says tools: ['*']?
    leak: {
        sessionConfig: { ...COMMON },
        turns: [
            "Use your 'task' tool to launch a 'task' agent (the command-execution agent). Give it these " +
            "instructions verbatim: \"First, list the exact names of every tool you have access to, one per " +
            "line. Second, if a tool named ps_store_fact is available to you, call it with key='leak-probe' " +
            "and value='called-from-subagent'. Third, report whether the call succeeded.\" " +
            "Relay the subagent's full answer verbatim.",
        ],
    },

    // Q4: can a customAgents entry with an explicit tools allowlist keep the
    // durability tools out while still being dispatchable via the task tool?
    restricted: {
        sessionConfig: {
            ...COMMON,
            customAgents: [
                {
                    name: "swarm-worker",
                    displayName: "Swarm Worker",
                    description: "Restricted ephemeral worker: shell and file reading only. No durability tools.",
                    tools: ["bash", "view", "grep", "glob"],
                    prompt: "You are a restricted ephemeral worker. Do exactly what the dispatching prompt asks, then stop.",
                },
            ],
        },
        turns: [
            "Use your 'task' tool to launch the 'swarm-worker' agent. Give it these instructions verbatim: " +
            "\"First, list the exact names of every tool you have access to, one per line. Second, if a tool " +
            "named ps_store_fact is available to you, call it with key='restricted-probe' and value='should-not-happen'. " +
            "Third, report whether ps_store_fact was available.\" Relay the subagent's full answer verbatim.",
        ],
    },

    // Q5: can same-name customAgents SHADOW the leaky built-ins? If yes, the
    // worker can keep the familiar 'task'/'explore' names but pin restricted
    // tool rosters.
    shadow: {
        sessionConfig: {
            ...COMMON,
            customAgents: [
                {
                    name: "task",
                    displayName: "Task Agent (PilotSwarm restricted)",
                    description: "Execute development commands. Shell and file reading only; no PilotSwarm durability tools.",
                    tools: ["bash", "view", "grep", "glob"],
                    prompt: "You are a restricted command-execution agent. Do exactly what the dispatching prompt asks, then stop.",
                },
                {
                    name: "explore",
                    displayName: "Explore Agent (PilotSwarm restricted)",
                    description: "Fast read-only codebase exploration. No PilotSwarm durability tools.",
                    tools: ["grep", "glob", "view", "bash"],
                    prompt: "You are a read-only exploration agent. Answer the dispatching prompt from the codebase, then stop.",
                },
            ],
        },
        turns: [
            "Use your 'task' tool to launch a 'task' agent. Give it these instructions verbatim: \"First, list the " +
            "exact names of every tool you have access to, one per line. Second, if a tool named ps_store_fact is " +
            "available to you, call it with key='shadow-probe' and value='should-not-happen'. Third, report whether " +
            "ps_store_fact was available.\" Relay the subagent's full answer verbatim.",
        ],
    },

    // Q6: does a COPILOT_HOME settings.json subagents.disabledSubagents entry
    // actually remove built-in agent types from dispatch?
    disabled: {
        homeFiles: {
            "settings.json": JSON.stringify({
                subagents: {
                    disabledSubagents: ["code-review", "research", "rubber-duck", "security-review", "rem-agent", "task"],
                },
            }, null, 2),
        },
        sessionConfig: { ...COMMON },
        turns: [
            "Look at your 'task' tool's declaration. List every agent_type value it documents as available, one per " +
            "line. Do not call any tools.",
            "Now attempt to use the 'task' tool with agent_type 'task' and prompt 'echo hello'. Report exactly what happens, " +
            "including any error text.",
        ],
    },

    // Q7: the production-shaped config. Disable every wildcard-tools built-in,
    // keep explicit-roster explore, add a restricted custom task runner.
    // Expect: only explore + swarm-task dispatchable, and neither can see
    // ps_* tools.
    locked: {
        homeFiles: {
            "settings.json": JSON.stringify({
                subagents: {
                    disabledSubagents: [
                        "task", "general-purpose", "code-review", "rubber-duck",
                        "security-review", "rem-agent", "research",
                    ],
                },
            }, null, 2),
        },
        sessionConfig: {
            ...COMMON,
            customAgents: [
                {
                    name: "swarm-task",
                    displayName: "Swarm Task Runner",
                    description: "Execute development commands (tests, builds, linters). Brief summary on success, full output on failure. Shell and file access only.",
                    tools: ["bash", "view", "grep", "glob"],
                    prompt: "You are a command-execution agent. Run exactly what the dispatching prompt asks. Report a one-line summary on success, full output on failure. Do not retry or fix anything.",
                },
            ],
        },
        turns: [
            "Look at your 'task' tool's declaration. List every agent_type it documents as available, one per line. Do not call any tools.",
            "Use your 'task' tool to launch an 'explore' agent. Give it these instructions verbatim: \"List the exact names " +
            "of every tool you have access to, one per line. Then report whether a tool named ps_store_fact is available " +
            "to you; if it is, call it with key='locked-explore-probe' and value='should-not-happen'.\" Relay its full answer verbatim.",
            "Use your 'task' tool to launch a 'swarm-task' agent with the instruction: \"Run `ls src/` in the working " +
            "directory and report the file names.\" Relay its answer verbatim.",
        ],
    },

    // Q2 (full): BYOK provider (azure-openai, gpt-5.4-mini). The built-in explore
    // agent pins claude-haiku-4.5 which this provider does not serve — does
    // dispatch fail, or fall back to the session model?
    byok: {
        sessionConfig: {
            ...COMMON,
            model: "gpt-5.4-mini",
            provider: sdkProviderFor("azure-openai", "gpt-5.4-mini", env),
        },
        turns: [
            "Use your 'task' tool to launch an 'explore' agent. Its job: find the value of MAGIC_CONSTANT " +
            "in this project and report which file defines it. Relay the subagent's answer verbatim.",
        ],
    },
};

// Quantify the declaration cost of the task tool's dead companions
// (read_agent/list_agents/write_agent) in today's prod config.
EXPERIMENTS.deadtools_a = {
    sessionConfig: { ...COMMON, excludedTools: ["task"] },
    turns: ["Reply with exactly: OK"],
};
EXPERIMENTS.deadtools_b = {
    sessionConfig: { ...COMMON, excludedTools: ["task", "read_agent", "list_agents", "write_agent"] },
    turns: ["Reply with exactly: OK"],
};

const name = process.argv[2];
if (!EXPERIMENTS[name]) {
    console.error(`Unknown experiment '${name}'. One of: ${Object.keys(EXPERIMENTS).join(", ")}`);
    process.exit(1);
}

const { summary, summaryPath } = await runExperiment({ name, env, ...EXPERIMENTS[name] });
summary.markerInvocations = invocations;

console.log(JSON.stringify({
    experiment: name,
    turns: summary.turns.map((t) => ({ ms: t.ms, reply: t.reply })),
    subagentEvents: summary.subagentEvents,
    toolCalls: summary.toolCalls,
    markerInvocations: invocations,
    errors: summary.errors,
    summaryPath,
}, null, 2));
