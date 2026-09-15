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

    it("requires discovery before substituting for an explicitly named capability only in V2", () => {
        const v2 = baseAgentInstructions({ version: "v2" }, "legacy");
        expect(v2).toContain("When the user names a skill, package, tool, MCP server, capability or authored workflow");
        expect(v2).toContain("search for that named capability before substituting another available tool");
        expect(v2).toContain("static or published capability source with use_package");
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
