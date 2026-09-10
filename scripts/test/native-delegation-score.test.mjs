import test from "node:test";
import assert from "node:assert/strict";
import { scoreDelegation } from "../lib/native-delegation-score.mjs";

const options = { model: "gpt-5.6-terra", criticModel: "claude-sonnet-5", knownAgents: ["deepwiki", "generic-crawler"] };
const call = (name, args) => ({ name, arguments: args });
const decision = (name, args) => ({ calls: [call(name, args)] });
const nativeArgs = { agent_type: "swarm-explore", mode: "sync", prompt: "Read the worker and return findings." };
const nested = { expected: ["durable"], expectedChildNative: true };
function expectScore(scenario, chosen, pass, overrides = {}) {
    const result = scoreDelegation(scenario, chosen, { ...options, ...overrides });
    assert.equal(result.pass, pass, JSON.stringify(result));
    assert.equal(result.failures.length === 0, pass);
    return result;
}

for (const [name, args] of [
    ["direct imperative", { task: "Use a native task to inspect the repository." }],
    ["inline CLI call", { task: "Call `task(agent_type=\"swarm-explore\")` to inspect the source." }],
    ["native profile", { task: "Delegate source reads to the swarm-explore profile." }],
    ["native critic profile", { task: "Use the swarm-rubber-duck profile to critique the local implementation." }],
    ["subject directive", { task: "You MUST delegate local checks to native `task` calls (swarm-task)." }],
    ["via execution", { task: "Audit the service via native local tasks." }],
    ["contract purpose", { task: "Investigate the source.", contract: { purpose: "Inspect the source using native tasks." } }],
    ["contract criterion", { task: "Investigate the source.", contract: { successCriteria: ["Report findings", "Runs a native task for local verification"] } }],
    ["named contract", { agent_name: "deepwiki", contract: { purpose: "Use native tasks for local verification." } }],
    ["unrelated restriction", { task: "Do not edit source files. Use synchronous native tasks for inspection." }],
    ["positive after quoted context", { task: "The user said: \"Use native tasks\". Now run a native task to inspect the source." }],
    ["positive followed by contrast", { task: "Use native tasks, not separate durable children, for the source reads." }],
    ["separate prose and contract", { task: "Return a concise answer.", contract: { purpose: "Find references through native research tasks." } }],
]) test(`nested assignment accepts ${name}`, () => {
    expectScore(nested, decision("spawn_agent", args), true);
});

for (const [name, args] of [
    ["no instruction", { task: "Research the repository." }],
    ["title only", { task: "Research the repository.", title: "Run native tasks" }],
    ["metadata only", { task: "Research the repository.", contract: { metadata: { instructions: "Run native tasks" } } }],
    ["artifact name only", { task: "Research the repository.", contract: { expectedArtifacts: [{ name: "Use native tasks" }] } }],
    ["double quoted user request", { task: "The user requested: \"Use native tasks\". Summarize the repository yourself." }],
    ["multiline quoted request", { task: "The user requested:\n\"Use native tasks\nfor the local source reads.\"\nSummarize the repository yourself." }],
    ["single quoted intent", { task: "The request was 'run a native task'. Read the source yourself." }],
    ["smart quoted intent", { task: "The user said: “use native tasks”. Work directly." }],
    ["unquoted reported intent", { task: "The user asked us to use native tasks. Work directly." }],
    ["blockquote", { task: "> Use native tasks\nSummarize that request." }],
    ["fenced example", { task: "Example:\n```text\nUse native tasks\n```\nWork directly." }],
    ["inline example without directive", { task: "Example: `task(agent_type=\"swarm-explore\")`. Research directly." }],
    ["backtick imperative example", { task: "Example: `Use native tasks`. Research directly." }],
    ["unquoted labeled intent", { task: "User intent: use native tasks. Research directly." }],
    ["negated imperative", { task: "Do not use native tasks. Research directly." }],
    ["contract negation", { task: "Research directly.", contract: { purpose: "Do not invoke swarm-explore." } }],
    ["critic negation", { task: "Do not use swarm-rubber-duck for the review." }],
    ["apostrophe contraction", { task: "Don't run a native task." }],
    ["smart apostrophe contraction", { task: "You shouldn’t run a native task." }],
    ["never", { task: "Never invoke task(agent_type=\"swarm-explore\")." }],
    ["avoid", { task: "Avoid using native tasks for this work." }],
    ["without", { task: "Perform the investigation without native tasks." }],
    ["rather than", { task: "Work directly rather than using native tasks." }],
    ["trailing prohibition", { task: "Native tasks are forbidden. Research directly." }],
    ["conflicting task", { task: "Use native tasks. Do not use native tasks." }],
    ["same-clause contradiction", { task: "Use native tasks but do not use native tasks." }],
    ["conflicting contract", { task: "Use native tasks.", contract: { successCriteria: ["Do not run native tasks"] } }],
    ["prohibition with commas", { task: "Do not, under any circumstances, launch native tasks." }],
    ["quoted success criterion", { task: "Research directly.", contract: { successCriteria: ['The user said "Run native tasks"'] } }],
    ["malformed criterion", { task: "Research directly.", contract: { successCriteria: [{ text: "Run native tasks" }, null] } }],
]) test(`nested assignment rejects ${name}`, () => {
    expectScore(nested, decision("spawn_agent", args), false);
});

test("every nested child must preserve the native assignment", () => {
    const good = call("spawn_agent", { task: "Run a native task to inspect source." });
    const bad = call("spawn_agent", { task: "Inspect source directly.", title: "Native tasks" });
    for (const calls of [[good, bad], [bad, good], [good, good, bad]]) expectScore(nested, { calls }, false);
    expectScore(nested, { calls: [good, good] }, true);
    expectScore(nested, { calls: [] }, false);
});

for (const [name, patch] of [
    ["unsupported profile", { agent_type: "explore" }],
    ["built-in critic", { agent_type: "rubber-duck" }],
    ["built-in rem agent", { agent_type: "rem-agent" }],
    ["absent profile", { agent_type: undefined }],
    ["background mode", { mode: "background" }],
    ["empty mode", { mode: "" }],
    ["null mode", { mode: null }],
    ["foreign model", { model: "other" }],
    ["empty model", { model: "" }],
    ["null model", { model: null }],
    ["reasoning override", { reasoning_effort: "high" }],
    ["null reasoning override", { reasoning_effort: null }],
    ["context override", { context_tier: "default" }],
    ["missing prompt", { prompt: undefined }],
    ["empty prompt", { prompt: "  " }],
    ["object prompt", { prompt: { text: "Read source" } }],
]) test(`native arguments reject ${name}`, () => {
    expectScore({ expected: ["native"] }, decision("task", { ...nativeArgs, ...patch }), false);
});

test("admitted native profiles and inherited mode/model pass, and every call is validated", () => {
    for (const args of [nativeArgs, { ...nativeArgs, agent_type: "swarm-task" },
        { ...nativeArgs, agent_type: "swarm-rubber-duck" },
        { ...nativeArgs, mode: undefined }, { ...nativeArgs, model: options.model }]) {
        expectScore({ expected: ["native"] }, decision("task", args), true);
    }
    expectScore({ expected: ["native"] }, { calls: [call("task", nativeArgs), call("task", { ...nativeArgs, mode: "background" })] }, false);
});

test("native critic requires an available selected model and cannot borrow the parent or another provider", () => {
    const criticArgs = { ...nativeArgs, agent_type: "swarm-rubber-duck" };
    expectScore({ expected: ["native"] }, decision("task", criticArgs), false, { criticModel: undefined });
    expectScore({ expected: ["native"] }, decision("task", criticArgs), false, { criticModel: null });
    expectScore({ expected: ["native"] }, decision("task", { ...criticArgs, model: options.criticModel }), true);
    for (const model of [options.model, "another-provider:claude-sonnet-5"]) {
        expectScore({ expected: ["native"] }, decision("task", { ...criticArgs, model }), false);
    }
    for (const agent_type of ["swarm-explore", "swarm-task"]) {
        expectScore({ expected: ["native"] }, decision("task", { ...nativeArgs, agent_type, model: options.criticModel }), false);
    }
});

for (const [name, args] of [
    ["missing task", {}], ["blank task", { task: "  " }], ["object task", { task: {} }],
    ["unknown name", { agent_name: "imaginary" }], ["blank name", { agent_name: "" }],
    ["null name", { agent_name: null }], ["task override", { agent_name: "deepwiki", task: "Replace role" }],
    ["empty task override", { agent_name: "deepwiki", task: "" }],
    ["null task override", { agent_name: "deepwiki", task: null }],
    ["system override", { agent_name: "deepwiki", system_message: "Replace role" }],
    ["empty system override", { agent_name: "deepwiki", system_message: "" }],
]) test(`durable arguments reject ${name}`, () => {
    expectScore({ expected: ["durable"] }, decision("spawn_agent", args), false);
});

test("exact named selection applies to every child and requires discovery when requested", () => {
    const scenario = { expected: ["durable"], expectedAgent: "deepwiki", expectedCatalogLookup: true };
    const good = call("spawn_agent", { agent_name: "deepwiki", contract: { purpose: "Explain repository architecture" } });
    for (const catalogLookups of [0, -1, "1", NaN, Infinity, 0.5]) expectScore(scenario, { calls: [good] }, false, { catalogLookups });
    for (const catalogLookups of [1, 3]) expectScore(scenario, { calls: [good, good] }, true, { catalogLookups });
    for (const bad of [call("spawn_agent", { agent_name: "generic-crawler" }), call("spawn_agent", { task: "Generic investigation" })]) {
        expectScore(scenario, { calls: [good, bad] }, false, { catalogLookups: 1 });
    }
    expectScore({ expected: ["durable"], expectedAgent: "deepwiki" }, { calls: [good] }, true);
});

test("mixed routes cannot masquerade as either requested topology", () => {
    const chosen = { calls: [call("spawn_agent", { task: "Use native tasks." }), call("task", nativeArgs)] };
    for (const expected of [["durable"], ["native"], ["native", "durable"]]) {
        assert.equal(expectScore({ expected }, chosen, false).route, "mixed");
    }
    expectScore({ expected: ["mixed"] }, chosen, true);
});

test("off mode rejects native calls even when native is an accepted route", () => {
    expectScore({ expected: ["native"] }, decision("task", nativeArgs), false, { nativeMode: "off" });
    expectScore({ expected: ["native"] }, decision("task", { ...nativeArgs, agent_type: "swarm-rubber-duck" }), false, { nativeMode: "off" });
    expectScore({ expected: ["mixed"] }, { calls: [call("spawn_agent", { task: "Research" }), call("task", nativeArgs)] }, false, { nativeMode: "off" });
    for (const [scenario, chosen] of [
        [{ expected: ["durable"] }, decision("spawn_agent", { task: "Research" })],
        [{ expected: ["durable"], expectedAgent: "deepwiki" }, decision("spawn_agent", { agent_name: "deepwiki" })],
        [{ expected: ["direct"] }, decision("view", { path: "package.json" })],
        [{ expected: ["clarify"] }, decision("ask_user", { question: "Which repository?" })],
    ]) expectScore(scenario, chosen, true, { nativeMode: "off" });
});

test("malformed decision envelopes and argument objects fail without throwing", () => {
    for (const chosen of [null, {}, { calls: {} }, { calls: [null] }, { calls: [{ name: "" }] }]) {
        expectScore({ expected: ["clarify"] }, chosen, false);
    }
    for (const [name, expected] of [["task", "native"], ["spawn_agent", "durable"]]) {
        for (const args of [null, undefined, [], "{}", 1]) expectScore({ expected: [expected] }, decision(name, args), false);
    }
});
