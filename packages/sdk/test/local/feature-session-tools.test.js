import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "../../src/session-manager.ts";
import { FEATURE_OPERATION_SPECS } from "../../src/feature-tools.ts";
import { FeatureFlagError } from "../../src/feature-flags.ts";
import { createFeaturePolicy } from "../helpers/feature-policy.mjs";

const featureNames = FEATURE_OPERATION_SPECS.map(spec => spec.name).sort();
const declarations = options => options.tools.filter(tool => featureNames.includes(tool.name));

async function fixture(run, { native = false } = {}) {
    const home = mkdtempSync(join(tmpdir(), "ps-feature-session-"));
    const sessionId = randomUUID();
    const owner = { provider: "test", subject: sessionId };
    let role = "user";
    let row = { sessionId, owner, isSystem: false };
    let failure = false;
    const featureCalls = [];
    const catalog = {
        getSession: vi.fn(async () => { if (failure) throw new Error("catalog unavailable"); return row; }),
        getUserRole: vi.fn(async () => ({ role, seenAt: new Date() })),
        recordEvents: async () => {},
        features: {
            mutate: async (viewer, scope, input) => {
                featureCalls.push({ viewer, scope, input });
                if (!viewer.isAdmin) throw new FeatureFlagError("FEATURE_FORBIDDEN", "Admin required", 403);
                return { revision: "2" };
            },
        },
    };
    const options = [];
    const create = config => {
        options.push(config);
        mkdirSync(join(home, "session-state", sessionId), { recursive: true });
        return { sessionId, disconnect: vi.fn(async () => {}), registerTools: vi.fn() };
    };
    const manager = new SessionManager(undefined, null, { nativeSubagents: native ? "sync" : "off" }, join(home, "session-state"));
    manager.setSessionCatalog(catalog);
    manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
    manager.client = { createSession: async config => create(config), resumeSession: async (_id, config) => create(config), stop: async () => {} };
    const policy = await createFeaturePolicy(true);
    manager.setFeatureFlagCache(policy.cache);
    try {
        await run({ manager, sessionId, owner, catalog, options, featureCalls,
            setRole: value => { role = value; }, setRow: value => { row = value; }, fail: value => { failure = value; } });
    } finally {
        await manager.shutdown();
        await policy.cache.stop();
        rmSync(home, { recursive: true, force: true });
    }
}

describe("feature tool session surfaces", () => {
    it("rebinds the same warm session for promotion and demotion without duplicate declarations", async () => {
        await fixture(async ({ manager, sessionId, options, setRole }) => {
            const config = { model: "gpt-5.6-terra", agentIdentity: "agent-manager" };
            const first = await manager.getOrCreate(sessionId, config, { turnIndex: 0 });
            expect(declarations(options[0])).toEqual([]);
            expect(await manager.getOrCreate(sessionId, config, { turnIndex: 1 })).toBe(first);
            setRole("admin");
            const promoted = await manager.getOrCreate(sessionId, config, { turnIndex: 2 });
            expect(promoted).not.toBe(first);
            expect(first.getCopilotSession().disconnect).toHaveBeenCalledTimes(1);
            expect(declarations(options.at(-1)).map(tool => tool.name).sort()).toEqual(featureNames);
            expect(await manager.getOrCreate(sessionId, config, { turnIndex: 3 })).toBe(promoted);
            setRole("user");
            const demoted = await manager.getOrCreate(sessionId, config, { turnIndex: 4 });
            expect(demoted).not.toBe(promoted);
            expect(promoted.getCopilotSession().disconnect).toHaveBeenCalledTimes(1);
            expect(declarations(options.at(-1))).toEqual([]);
            expect(options).toHaveLength(3);
            expect(manager.activeSessionIds()).toEqual([sessionId]);
        });
    });

    it("rechecks role on an already-declared handler and does not allow an admin-shaped argument", async () => {
        await fixture(async ({ manager, sessionId, options, setRole, featureCalls, owner }) => {
            setRole("admin");
            await manager.getOrCreate(sessionId, { model: "gpt-5.6-terra", agentIdentity: "agent-manager" }, { turnIndex: 0 });
            const tool = declarations(options[0]).find(tool => tool.name === "set_cluster_feature_flag");
            const input = { featureKey: "copilot.native_tasks", expectedRevision: "1", requestId: "first", enabled: true, allowUserOverride: false };
            await expect(tool.handler(input, { sessionId })).resolves.toContain('"revision":"2"');
            setRole("user");
            await expect(tool.handler({ ...input, isAdmin: true, principal: { provider: "system", subject: "system" } }, { sessionId })).rejects.toMatchObject({ code: "FEATURE_FORBIDDEN" });
            expect(featureCalls.at(-1).viewer).toEqual({ principal: owner, isAdmin: false });
        });
    });

    it.each(["user", "admin"])("reserves feature tool names against user/package definitions for %s owners", async role => {
        await fixture(async ({ manager, sessionId, options, setRole }) => {
            setRole(role);
            const collision = vi.fn(() => "WRONG_HANDLER");
            manager.setConfig(sessionId, { tools: [{ name: "set_cluster_feature_flag", description: "Collision", parameters: { type: "object" }, handler: collision }] });
            const config = { model: "gpt-5.6-terra", agentIdentity: "agent-manager" };
            await manager.getOrCreate(sessionId, config, { turnIndex: 0 });
            const matching = declarations(options[0]).filter(tool => tool.name === "set_cluster_feature_flag");
            expect(matching).toHaveLength(role === "admin" ? 1 : 0);
            expect(matching[0]?.handler).not.toBe(collision);
            await manager.getOrCreate(sessionId, config, { turnIndex: 1 });
            expect(collision).not.toHaveBeenCalled();
        });
    });

    it("does not grant system authority from an agent name or a system-shaped owner alone", async () => {
        await fixture(async ({ manager, sessionId, options, setRow }) => {
            setRow({ sessionId, owner: { provider: "system", subject: "system" }, isSystem: false });
            await manager.getOrCreate(sessionId, { model: "gpt-5.6-terra", agentIdentity: "resourcemgr" }, { turnIndex: 0 });
            expect(declarations(options[0])).toEqual([]);
            setRow({ sessionId, owner: { provider: "system", subject: "system" }, isSystem: true });
            await manager.getOrCreate(sessionId, { model: "gpt-5.6-terra", agentIdentity: "resourcemgr" }, { turnIndex: 1 });
            expect(declarations(options.at(-1)).map(tool => tool.name).sort()).toEqual(featureNames);
        });
    });

    it.each(["pilotswarm", "resourcemgr"])("boots the persisted ownerless %s system session with its trusted feature identity", async agentIdentity => {
        await fixture(async ({ manager, sessionId, options, setRow, featureCalls }) => {
            // PgSessionCatalog deliberately leaves worker-provisioned system
            // sessions ownerless; isSystem is their persisted service identity.
            setRow({ sessionId, owner: null, isSystem: true, agentId: agentIdentity });
            await manager.getOrCreate(sessionId, { model: "gpt-5.6-terra", agentIdentity }, { turnIndex: 0 });
            expect(declarations(options[0]).map(tool => tool.name).sort()).toEqual(featureNames);
            const tool = declarations(options[0]).find(tool => tool.name === "set_cluster_feature_flag");
            await tool.handler({ featureKey: "copilot.native_tasks", expectedRevision: "1", requestId: "system-bootstrap", enabled: false, allowUserOverride: false }, { sessionId });
            expect(featureCalls.at(-1).viewer).toMatchObject({ principal: { provider: "system", subject: "system" }, isAdmin: true });

            // An ownerless ordinary session with the same agent name cannot
            // acquire authority after the service classification is removed.
            setRow({ sessionId, owner: null, isSystem: false, agentId: agentIdentity });
            await expect(tool.handler({}, { sessionId })).rejects.toMatchObject({ code: "FEATURE_FORBIDDEN" });
        });
    });
});

describe("session-scoped Copilot tool exclusions", () => {
    it("augments defaults and rebinds when the exclusion selectors change", async () => {
        await fixture(async ({ manager, sessionId, options }) => {
            const first = await manager.getOrCreate(sessionId, {
                model: "gpt-5.6-terra",
                excludedTools: ["mcp:*"],
            }, { turnIndex: 0 });
            expect(options[0].excludedTools).toEqual(["task", "mcp:*"]);

            const rebound = await manager.getOrCreate(sessionId, {
                model: "gpt-5.6-terra",
                excludedTools: ["mcp:*", "builtin:github"],
            }, { turnIndex: 1 });
            expect(rebound).not.toBe(first);
            expect(first.getCopilotSession().disconnect).toHaveBeenCalledTimes(1);
            expect(options.at(-1).excludedTools).toEqual(["task", "mcp:*", "builtin:github"]);
        });
    });
});

describe("native owner resolution", () => {
    it.each(["unreadable", "absent", "ownerless"])("fails closed for a %s CMS owner while cluster native policy is ON", async condition => {
        await fixture(async ({ manager, sessionId, options, fail, setRow }) => {
            if (condition === "unreadable") fail(true);
            if (condition === "absent") setRow(null);
            if (condition === "ownerless") setRow({ sessionId, isSystem: false });
            await manager.getOrCreate(sessionId, { model: "gpt-5.6-terra" }, { turnIndex: 0 });
            expect(options[0].excludedTools).toContain("task");
        }, { native: true });
    });
});
