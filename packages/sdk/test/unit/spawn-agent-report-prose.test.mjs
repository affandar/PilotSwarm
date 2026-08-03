// The native spawn_agent report is an LLM-facing compatibility surface: agents and prompts key off
// its exact wording. A refactor that moved failure rendering behind a structured result silently
// changed every validation failure from an em-dash form to a colon form, and the suite stayed green
// because nothing asserted the bytes. These expectations are transcribed from the pre-refactor
// inline strings recovered from git history, so the prose cannot drift again unnoticed.
import test from "node:test";
import assert from "node:assert/strict";
import { renderSpawnAgentReport } from "../../dist/session-proxy.js";

const EM_DASH = "\u2014";

test("a successful spawn renders the unchanged success report", () => {
    assert.equal(
        renderSpawnAgentReport({ ok: true, agentId: "session-child-1", agentName: "researcher", task: "scan the index" }),
        `[SYSTEM: Sub-agent spawned successfully.\n` +
        `  Agent ID: session-child-1\n` +
        `  Agent: researcher\n  Task: "scan the index"\n` +
        `  The agent is now running autonomously. Continue your work in this SAME turn and keep following the user's remaining steps. ` +
        `Do NOT stop just because the child started. If your plan says to pause, call wait or wait_for_agents explicitly. ` +
        `You can also use check_agents to poll status, ` +
        `or message_agent to send instructions.]`,
    );
});

test("a successful spawn without an agent name omits the Agent line", () => {
    const report = renderSpawnAgentReport({ ok: true, agentId: "session-child-2", task: "custom work" });
    assert.ok(report.startsWith(`[SYSTEM: Sub-agent spawned successfully.\n  Agent ID: session-child-2\n  Task: "custom work"\n`));
    assert.ok(!report.includes("Agent: "));
});

test("the nesting-limit rejection keeps the em-dash failure form", () => {
    assert.equal(
        renderSpawnAgentReport({
            ok: false,
            validationFailure: true,
            error: "you are already at nesting level 3 (max 3). " +
                "Sub-agents at this depth cannot spawn further sub-agents. Handle the task directly instead.",
        }),
        `[SYSTEM: spawn_agent failed ${EM_DASH} you are already at nesting level 3 (max 3). ` +
        `Sub-agents at this depth cannot spawn further sub-agents. Handle the task directly instead.]`,
    );
});

test("the active-agent-limit rejection keeps the em-dash failure form", () => {
    assert.equal(
        renderSpawnAgentReport({
            ok: false,
            validationFailure: true,
            error: "you already have 50 running sub-agents (max 50). Wait for some to complete before spawning more.",
        }),
        `[SYSTEM: spawn_agent failed ${EM_DASH} you already have 50 running sub-agents (max 50). ` +
        `Wait for some to complete before spawning more.]`,
    );
});

test("the unknown-agent rejection keeps the em-dash failure form", () => {
    assert.equal(
        renderSpawnAgentReport({
            ok: false,
            validationFailure: true,
            error: `agent "ghost" not found. Use ps_list_agents to see available agents.`,
        }),
        `[SYSTEM: spawn_agent failed ${EM_DASH} agent "ghost" not found. Use ps_list_agents to see available agents.]`,
    );
});

test("the system-agent rejection keeps the em-dash failure form", () => {
    assert.equal(
        renderSpawnAgentReport({
            ok: false,
            validationFailure: true,
            error: `agent "sweeper" is a worker-managed system agent and cannot be spawned from a session. ` +
                `If it is missing, the workers likely need to be restarted.`,
        }),
        `[SYSTEM: spawn_agent failed ${EM_DASH} agent "sweeper" is a worker-managed system agent and cannot be spawned from a session. ` +
        `If it is missing, the workers likely need to be restarted.]`,
    );
});

test("the invalid-model rejection keeps the em-dash failure form", () => {
    assert.equal(
        renderSpawnAgentReport({
            ok: false,
            validationFailure: true,
            error: `model "sonnet" is not allowed. ` +
                `When overriding a sub-agent model, first call list_available_models and then use the exact provider:model value from that list. ` +
                `If you are unsure, omit model so the sub-agent inherits your current model.`,
        }),
        `[SYSTEM: spawn_agent failed ${EM_DASH} model "sonnet" is not allowed. ` +
        `When overriding a sub-agent model, first call list_available_models and then use the exact provider:model value from that list. ` +
        `If you are unsure, omit model so the sub-agent inherits your current model.]`,
    );
});

// A thrown error is NOT a pre-flight rejection and has always used the colon form.
test("a thrown spawn error keeps the colon failure form", () => {
    assert.equal(
        renderSpawnAgentReport({ ok: false, error: "boom" }),
        "[SYSTEM: spawn_agent failed: boom]",
    );
});
