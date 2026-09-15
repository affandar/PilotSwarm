import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeatureFlagCache } from "../../src/feature-flag-cache.ts";
import { FEATURE_FLAGS } from "../../src/feature-flags.ts";
import { FeatureStore } from "../../src/feature-store.ts";
import { resolveBaseAgentPolicy, baseAgentInstructions } from "../../src/base-agent-policy.ts";
import { SessionManager } from "../../src/session-manager.ts";
import { NativeTaskAccess } from "../../src/native-task-policy.ts";
import { nativeSubagentGuidance } from "../../src/native-subagents.ts";

const owner = { provider: "test", subject: "base-policy-owner" };
const base = "agents.base_v2", native = "copilot.native_tasks";
const cleanup = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()(); });

async function flags(initial = {}) {
    let revision = 1;
    const values = { [base]: { enabled: false, allowUserOverride: true },
        [native]: { enabled: true, allowUserOverride: true }, ...initial };
    const snapshot = () => ({
        definitions: Object.entries(FEATURE_FLAGS).map(([featureKey, definition]) => ({
            featureKey, ...definition, revision: String(revision),
        })),
        settings: Object.entries(values).flatMap(([featureKey, value]) => [
            { featureKey, scope: "cluster", userId: null, enabled: value.enabled,
                allowUserOverride: value.allowUserOverride, revision: String(revision) },
            ...(typeof value.user === "boolean" ? [{ featureKey, scope: "user", userId: 1,
                owner, enabled: value.user, allowUserOverride: null, revision: String(revision) }] : []),
        ]),
    });
    const cache = new FeatureFlagCache({
        revisions: async () => Object.keys(FEATURE_FLAGS).map(featureKey => ({ featureKey, revision: String(revision) })),
        snapshot: async () => snapshot(),
    });
    await cache.pollRevisionsAndRefresh();
    cleanup.push(() => cache.stop());
    return { cache, snapshot, async set(key, patch) {
        values[key] = { ...values[key], ...patch }; revision++;
        await cache.pollRevisionsAndRefresh();
    } };
}

function effectivePolicy(cache, principal = owner) {
    const nativeEnabled = cache.resolve(native, principal, { fallback: false }).enabled;
    return resolveBaseAgentPolicy(cache, principal, nativeEnabled);
}

async function sessionFixture(policy, { named = false, isSystem = false, workerNative = true } = {}) {
    const home = mkdtempSync(join(tmpdir(), "ps-base-policy-review-"));
    const calls = [];
    const row = { sessionId: "policy-session", owner, isSystem };
    const defaults = {
        frameworkBasePrompt: "V1 FRAMEWORK: prefer the named specialist when its role fits.",
        appDefaultPrompt: "APP SECURITY: never disclose deployment credentials.",
        nativeSubagents: workerNative ? "sync" : "off",
        agentPromptLookup: { analyst: { prompt: "NAMED SECURITY: read-only investigation; do not execute mutations.",
            toolNames: [], kind: "app-agent" } },
    };
    const manager = new SessionManager(undefined, null, defaults, home);
    manager.setFeatureFlagCache(policy.cache);
    manager.setSessionCatalog({
        getSession: async () => row,
        getUserRole: async () => ({ role: "user", seenAt: new Date() }),
        recordEvents: async () => {},
    });
    manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
    const open = config => {
        mkdirSync(join(home, config.sessionId), { recursive: true });
        const handle = { sessionId: config.sessionId, disconnect: vi.fn(async () => {}), registerTools: vi.fn() };
        calls.push({ config, handle });
        return handle;
    };
    manager.ensureClient = async () => ({ createSession: async config => open(config),
        resumeSession: async (_id, config) => open(config), deleteSession: async () => {} });
    cleanup.push(async () => {
        for (const id of [...manager.sessions.keys()]) await manager.dropWarmSession(id);
        rmSync(home, { recursive: true, force: true });
    });
    const config = { model: "gpt-5.6-terra", ...(named ? { boundAgentName: "analyst", boundAgentSource: "deployment" } : {}) };
    return { manager, calls, config, row, async turn(index) {
        return manager.getOrCreate(row.sessionId, config, { turnIndex: index });
    } };
}

describe("Base V2 adversarial policy boundaries", () => {
    it.each([
        ["cluster default off", {}, "v1"],
        ["owner opts in", { [base]: { enabled: false, allowUserOverride: true, user: true } }, "v2"],
        ["owner opts out", { [base]: { enabled: true, allowUserOverride: true, user: false } }, "v1"],
        ["cluster locks off", { [base]: { enabled: false, allowUserOverride: false, user: true } }, "v1"],
        ["native owner opts out", { [base]: { enabled: true, allowUserOverride: true },
            [native]: { enabled: true, allowUserOverride: true, user: false } }, "v1"],
        ["native cluster locks off", { [base]: { enabled: true, allowUserOverride: true },
            [native]: { enabled: false, allowUserOverride: false, user: true } }, "v1"],
    ])("resolves %s against independent effective flags", async (_label, initial, expected) => {
        const policy = await flags(initial);
        expect(effectivePolicy(policy.cache).version).toBe(expected);
    });

    it("fails closed without an owner or initialized catalog", async () => {
        const policy = await flags({ [base]: { enabled: true, allowUserOverride: true } });
        expect(effectivePolicy(policy.cache, null)).toMatchObject({ version: "v1", reason: "owner_unavailable" });
        expect(resolveBaseAgentPolicy(null, owner, true).version).toBe("v1");
    });

    it.each([false, true])("changes only the framework instructions at the next boundary (named=%s)", async named => {
        const policy = await flags();
        const h = await sessionFixture(policy, { named });
        const first = await h.turn(0);
        const originalTools = h.calls[0].config.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
        const originalPrompt = h.calls[0].config.systemMessage.sections.custom_instructions.content;
        expect(originalPrompt).toContain("V1 FRAMEWORK");
        await policy.set(base, { user: true });
        expect(h.calls).toHaveLength(1);
        const second = await h.turn(1);
        expect(second).not.toBe(first);
        expect(h.calls[0].handle.disconnect).toHaveBeenCalledTimes(1);
        const v2 = h.calls.at(-1).config;
        expect(v2.sessionId).toBe(h.row.sessionId);
        expect(v2.systemMessage.sections.custom_instructions.content).toContain("search_capabilities");
        expect(v2.systemMessage.sections.guidelines.content).toContain("APP SECURITY");
        expect(v2.systemMessage.sections.custom_instructions.content).not.toContain("V1 FRAMEWORK");
        const last = await v2.systemMessage.sections.last_instructions.action("");
        if (named) expect(last).toContain("NAMED SECURITY");
        expect(v2.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }))).toEqual(originalTools);
        expect(await h.turn(2)).toBe(second);
        await policy.set(base, { user: false });
        expect((await h.turn(3)).config.baseAgentPolicy.version).toBe("v1");
        expect(h.calls.at(-1).config.systemMessage.sections.custom_instructions.content).toContain("V1 FRAMEWORK");
        expect(h.calls).toHaveLength(3);
    });

    it.each([{ isSystem: true }, { workerNative: false }])("does not enable V2 for native-ineligible sessions: %o", async options => {
        const policy = await flags({ [base]: { enabled: true, allowUserOverride: true } });
        const h = await sessionFixture(policy, options);
        const session = await h.turn(0);
        expect(session.config.baseAgentPolicy.version).toBe("v1");
        expect(h.calls[0].config.excludedTools).toContain("task");
    });

    it("reports a blocked prerequisite consistently in feature reads and runtime selection", async () => {
        const policy = await flags({ [base]: { enabled: true, allowUserOverride: true },
            [native]: { enabled: false, allowUserOverride: true } });
        const client = { release: vi.fn(), query: async () => ({ rows: [{ result: { userId: 1, ...policy.snapshot() } }] }) };
        const store = new FeatureStore({ connect: async () => client }, "review");
        const view = await store.read({ principal: owner, isAdmin: false }, "user");
        const baseView = view.flags.find(flag => flag.featureKey === base);
        expect(effectivePolicy(policy.cache).version).toBe("v1");
        expect(baseView.effective).toBe(false);
        expect(baseView.reason).toBe("requires_native_tasks");
        expect(baseView.cluster.enabled).toBe(true);
        expect(policy.cache.resolve(base, owner, { fallback: false })).toMatchObject({ enabled: false, reason: "requires_native_tasks" });
        await policy.set(native, { user: true });
        expect(effectivePolicy(policy.cache).version).toBe("v2");
        const refreshed = await store.read({ principal: owner, isAdmin: false }, "user");
        expect(refreshed.flags.find(flag => flag.featureKey === base)).toMatchObject({ effective: true, cluster: { enabled: true } });
        expect(refreshed.flags.find(flag => flag.featureKey === base).reason).toBeUndefined();
    });

    it("does not deny artifact capabilities explicitly granted to native tasks", () => {
        const tool = { name: "read_artifact", description: "read", parameters: { type: "object" } };
        const access = new NativeTaskAccess({ "swarm-explore": ["read_artifact"] }, [tool], new Set([tool.name]), {});
        expect(access.tools["swarm-explore"]).toContain("read_artifact");
        const prompt = baseAgentInstructions({ version: "v2" }, "legacy");
        expect(prompt).not.toMatch(/native tasks cannot call artifact tools/i);
    });

    it("requires early discovery for naturally named capabilities only in V2", () => {
        const v2 = baseAgentInstructions({ version: "v2" }, "legacy");
        expect(v2.indexOf("## Capability Discovery")).toBeLessThan(v2.indexOf("## Critical Rules"));
        expect(v2).toContain('"X exploration"');
        expect(v2).toContain("The user does not need to call X a tool or capability");
        expect(v2).toContain("your first task-related tool call MUST be `search_capabilities`");
        expect(v2).toContain('"Do a deep wiki exploration of this repository" names "deep wiki"');
        expect(v2).toContain("Do not call web search/fetch, GitHub or other repository tools, shell, native tasks or durable agents until this discovery call returns");
        expect(v2).toContain("Do not skip discovery merely because an already attached general-purpose tool");
        expect(v2).toContain("static, published and curated skills");
        expect(v2).toContain("Before or as you apply it, tell the user which authored agent supplied the instructions");
        expect(v2).toContain("use_package");
        expect(v2).toContain("An agent result is a reusable workflow reference, not a command to spawn that agent");
        expect(v2).toContain("Do not call `spawn_agent` merely to acquire a named agent's tools or follow its method");
        expect(v2).toContain('attach `mcp_servers: ["deepwiki"]` with `use_package`');
        expect(v2).toContain("Do not spawn the `deepwiki` agent for that bounded exploration");
        expect(baseAgentInstructions({ version: "v1" }, "legacy")).toBe("legacy");
    });

    it("requires concise milestone updates only in V2", () => {
        const v2 = baseAgentInstructions({ version: "v2" }, "legacy");
        expect(v2).toContain("## Milestone Updates");
        expect(v2).toContain("After every substantial milestone");
        expect(v2).toContain("diagnosis, implementation, verification, deployment or release");
        expect(v2).toContain("the outcome, the most useful evidence and the next step");
        expect(v2).toContain("the next externally visible action must be an assistant progress message");
        expect(v2).toContain("before any tool call for the next phase");
        expect(v2).toContain("do not batch all milestone updates into the final answer");
        expect(v2).toContain("Do not narrate routine commands or report every tool call");
        expect(v2).toContain("continue working unless the user must provide information or approval");
        expect(v2).toContain("The final response must stand on its own");
        expect(baseAgentInstructions({ version: "v1" }, "legacy")).toBe("legacy");
    });

    it("requires V2 sessions to keep driving the outcome after status updates or partial blockers", () => {
        const v2 = baseAgentInstructions({ version: "v2" }, "legacy");
        expect(v2).toContain("## Outcome Ownership");
        expect(v2).toContain("A status reply or milestone update is a checkpoint, not a stopping condition");
        expect(v2).toContain("select and execute the next concrete action in the same turn");
        expect(v2).toContain("verify the blocker, pursue safe alternatives and finish all independent work");
        expect(v2).toContain("Ask for the smallest specific decision only when it truly cannot be inferred");
        expect(v2).toContain("Do not become idle merely because one workstream is waiting");
        expect(v2).toContain("Stop only when the goal is complete, the user pauses or cancels it");
        expect(v2).toContain("Do not present executable next steps as future work");
        expect(v2).toContain("perform that work before ending the turn");
        expect(baseAgentInstructions({ version: "v1" }, "legacy")).toBe("legacy");
    });

    it("keeps legacy native routing in V1 and selects native-first routing only in V2", () => {
        const v1 = nativeSubagentGuidance(undefined, "v1");
        const v2 = nativeSubagentGuidance(undefined, "v2");
        expect(v1).toContain("If a specialist fits, prefer spawn_agent");
        expect(v1).toContain("User words such as \"subagent\"");
        expect(v2).toContain("performs bounded investigation");
        expect(v2).toContain("Follow the base and selected workflow instructions");
        expect(v2).not.toContain("If a specialist fits, prefer spawn_agent");
    });
});
