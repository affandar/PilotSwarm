#!/usr/bin/env node
// Opt-in live Copilot evaluation. Only reads and in-memory fact stubs execute.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SessionManager } from "../packages/sdk/dist/session-manager.js";
import { NATIVE_SUBAGENT_GUIDANCE } from "../packages/sdk/dist/native-subagents.js";
import { scoreDelegation } from "./lib/native-delegation-score.mjs";
import { delegationCatalogDefinitions } from "./lib/native-delegation-catalog.mjs";
import { createAgentDiscoveryTool, listAgentDefinitionsForCaller } from "../packages/sdk/dist/agent-discovery.js";
import { FeatureFlagCache } from "../packages/sdk/dist/feature-flag-cache.js";
import { FEATURE_FLAGS } from "../packages/sdk/dist/feature-flags.js";
import { assertNativeEvaluationSetup } from "./lib/native-delegation-setup.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const model = option("model") || "gpt-5.6-terra";
const nativeMode = option("native-subagents") || "sync";
if (!["off", "sync"].includes(nativeMode)) throw new Error("--native-subagents must be off or sync");
const ref = option("ref");
const repeats = Number(option("repeats") || 1);
const out = path.resolve(option("out") || ".tmp/native-delegation-eval.json");
const selected = option("cases")?.split(",");
const suite = option("suite") || "all";
if (!["all", "named-selection", "routing"].includes(suite)) throw new Error("--suite must be all, named-selection or routing");
const readSource = file => ref
    ? execFileSync("git", ["show", `${ref}:${file}`], { cwd: root, encoding: "utf8" })
    : fs.readFileSync(path.join(root, file), "utf8");
const base = readSource("packages/sdk/plugins/system/agents/default.agent.md").replace(/^---\n[\s\S]*?\n---\n/, "");
const guidance = readSource("packages/sdk/src/native-subagents.ts").match(/NATIVE_SUBAGENT_GUIDANCE = `([\s\S]*?)`;/)?.[1];
if (!guidance) throw new Error("Native guidance not found");
if (!process.env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required; use an environment file, never a command-line token");
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error("repeats must be 1..10");
const cases = JSON.parse(fs.readFileSync(new URL("./fixtures/native-delegation-cases.json", import.meta.url)))
    .filter(c => !selected || selected.includes(c.id))
    .filter(c => suite !== "named-selection" || c.catalog === "specialists")
    .filter(c => suite !== "routing" || c.catalog !== "specialists")
    .map(c => nativeMode === "off" ? { ...c, expected: c.expected.includes("native") ? ["durable", "clarify"] : c.expected, expectedChildNative: false } : c);
if (!cases.length) throw new Error("No cases selected");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ps-delegation-eval-"));
const manager = new SessionManager(process.env.GITHUB_TOKEN, null, { nativeSubagents: "sync", frameworkBasePrompt: base }, path.join(home, "session-state"));
// Keep the worker ceiling enabled in both modes; exercise the actual feature
// flag, not just a constructor option that can mask a missing policy cache.
const featureKey = "copilot.native_tasks";
const featureCache = new FeatureFlagCache({
    revisions: async () => [{ featureKey, revision: "1" }],
    snapshot: async () => ({
        definitions: [{ featureKey, ...FEATURE_FLAGS[featureKey], revision: "1" }],
        settings: [{ featureKey, scope: "cluster", userId: null, enabled: nativeMode === "sync", allowUserOverride: false, revision: "1" }],
    }),
});
await featureCache.pollRevisionsAndRefresh();
manager.setFeatureFlagCache(featureCache);
const facts = new Map();
manager.setFactStore({
    readFacts: async () => ({ count: facts.size, facts: [...facts.values()] }),
    storeFact: async inputs => {
        const stored = inputs.map(input => ({ ...input, id: randomUUID() }));
        stored.forEach(fact => facts.set(fact.key, fact));
        return { stored: stored.length, facts: stored };
    },
});
// Use the worker's real visibility/selection helper with synthetic static and
// published definitions. Parent model choices remain live; child effects do not.
const isPreparation = (name, args) => ["ps_list_agents", "store_fact", "read_facts", "view", "rg", "glob", "grep"].includes(name)
    || name === "bash" && String(args?.command || "").split(/\s*&&\s*/).every(part => /^(pwd|git (remote -v|status --short|rev-parse (HEAD|--show-toplevel)|branch --show-current))$/.test(part.trim()));
const isDecision = (calls, scenario) => calls.some(t => ["spawn_agent", "task", "ask_user"].includes(t.name))
    || scenario.expected.includes("direct") && calls.length > 0;
const results = [];
const startedAt = new Date().toISOString();
const sourceHashes = Object.fromEntries([
    "packages/sdk/dist/session-manager.js", "packages/sdk/dist/managed-session.js", "packages/sdk/dist/agent-discovery.js",
    "scripts/lib/native-delegation-catalog.mjs", "scripts/lib/native-delegation-score.mjs", "scripts/fixtures/native-delegation-cases.json",
].map(file => [file, createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex")]));
const report = () => {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ model, nativeMode, suite, reasoningEffort: "medium", ref: ref || "working-tree", repeats,
        startedAt, sourceHashes, promptHashes: { base: createHash("sha256").update(base).digest("hex"), native: createHash("sha256").update(guidance).digest("hex") },
        method: "Real Copilot SDK/CLI and model; production SessionManager prompts/tool schemas and caller-visible agent discovery; in-memory real FeatureFlagCache with per-session admission and SDK agent-list assertions; synthetic loaded static/published definitions with personal visibility and shadowing; bounded read-only preparation and isolated in-memory facts allowed; external effects denied; score first delegation decision. Follow-up case supplies a conversation summary. --ref overrides authored base/native prompts, not tool definitions.",
        results, passed: results.filter(r => r.pass).length, total: results.length }, null, 2));
};
report();
try {
    for (let repeat = 1; repeat <= repeats; repeat++) for (const scenario of cases) {
        const sessionId = randomUUID();
        facts.clear();
        let capture;
        let preparationCount = 0;
        let catalogLookups = 0;
        const userAgents = delegationCatalogDefinitions(scenario.catalog);
        const getCallerOwnerKey = async () => `eval\u0001${scenario.caller || "alice"}`;
        const agents = await listAgentDefinitionsForCaller({ userAgents, getCallerOwnerKey });
        const discoveryTool = createAgentDiscoveryTool({
            getUserAgents: () => userAgents, getSystemAgents: () => [], getCallerOwnerKey,
        });
        const catalogResult = { agents, total: agents.length };
        const config = { model, reasoningEffort: "medium", contextTier: "default", workingDirectory: root,
            ...(scenario.catalogInContext !== false && { systemMessage: { content: `Current complete caller-visible user-creatable agent catalog: ${JSON.stringify(catalogResult)}. This is the same catalog returned by ps_list_agents.` } }),
            tools: [discoveryTool],
            hooks: { onPreToolUse: input => {
                if (input.toolName === "ps_list_agents") catalogLookups++;
                const calls = [{ name: input.toolName, arguments: input.toolArgs }];
                if (isDecision(calls, scenario)) capture?.({ content: "", calls });
                else if (++preparationCount < 12 && isPreparation(input.toolName, input.toolArgs)) return undefined;
                else if (preparationCount >= 12) capture?.({ content: "Preparation limit reached before delegation", calls });
                return { permissionDecision: "deny", permissionDecisionReason: "Evaluation capture: execution disabled" };
            } },
            onPermissionRequest: () => ({ kind: "approved" }) };
        manager.setConfig(sessionId, config);
        // Replace only the native overlay when comparing a prior revision; all
        // other prompt composition and tool definitions use the same runtime.
        const compose = manager._buildLastInstructionsSection.bind(manager);
        manager._buildLastInstructionsSection = (...args) => {
            const section = compose(...args);
            const action = section.action;
            return { ...section, action: async content => (await action(content)).replace(NATIVE_SUBAGENT_GUIDANCE, guidance) };
        };
        const start = Date.now();
        const managed = await manager.getOrCreate(sessionId, config, { turnIndex: 0 });
        manager._buildLastInstructionsSection = compose;
        const sdk = managed.getCopilotSession();
        const nativeSetup = {
            featureEnabled: featureCache.resolve(featureKey, null, { required: true }).enabled,
            canAdmitNativeTask: managed.canAdmitNativeTask(),
            agentNames: (await sdk.rpc.agent.list()).agents.map(agent => agent.name),
        };
        assertNativeEvaluationSetup(nativeMode, nativeSetup);
        let timer;
        let stop;
        try {
            const decision = new Promise((resolve, reject) => {
                capture = resolve;
                timer = setTimeout(() => reject(new Error("No decision within 90 seconds")), 90_000);
                stop = sdk.on(event => {
                    if (event.type === "assistant.message" && (isDecision(event.data.toolRequests || [], scenario) || event.data.phase === "final_answer" && !event.data.toolRequests?.length)) {
                        resolve({ content: event.data.content || "", calls: (event.data.toolRequests || []).map(t => ({ name: t.name, arguments: t.arguments })) });
                    } else if (event.type === "session.error") reject(new Error(event.data.message));
                });
            });
            await sdk.send({ prompt: scenario.prompt });
            const chosen = await decision;
            const names = chosen.calls.map(t => t.name);
            const score = scoreDelegation(scenario, chosen, { model, nativeMode, knownAgents: agents.map(a => a.agent_name), catalogLookups });
            const { route } = score;
            results.push({ id: scenario.id, split: scenario.split, repeat, sessionId, expected: scenario.expected, expectedAgent: scenario.expectedAgent,
                ...score, scenario, nativeSetup, preparationCount, catalogLookups, catalog: agents, durationMs: Date.now() - start, ...chosen });
            console.log(JSON.stringify({ id: scenario.id, repeat, route, pass: results.at(-1).pass, tools: names }));
        } catch (error) {
            results.push({ id: scenario.id, repeat, sessionId, scenario, expected: scenario.expected, route: "error", pass: false, error: error.message });
            console.log(JSON.stringify({ id: scenario.id, repeat, error: error.message }));
        } finally {
            clearTimeout(timer);
            stop?.();
            await sdk.abort();
            report();
        }
    }
} finally {
    await manager.shutdown();
    await featureCache.stop();
    fs.rmSync(home, { recursive: true, force: true });
}
console.log(JSON.stringify({ out, passed: results.filter(r => r.pass).length, total: results.length }));
if (results.some(r => !r.pass)) process.exitCode = 1;
