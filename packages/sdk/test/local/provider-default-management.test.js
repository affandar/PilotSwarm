import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PilotSwarmManagementClient } from "../../dist/management-client.js";
import { PilotSwarmClient } from "../../dist/client.js";
import { SessionManager } from "../../dist/session-manager.js";
import { buildRuntimeRegistry } from "../../dist/provider-catalog.js";
import { useSuiteEnv } from "../helpers/local-env.js";

const getEnv = useSuiteEnv(import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-provider-defaults-"));
const modelProvidersPath = path.join(root, "model-providers.json");
const alice = { provider: "entra", subject: "alice", email: "alice@example.test", displayName: "Alice" };
const bob = { provider: "entra", subject: "bob", email: "bob@example.test", displayName: "Bob" };
const admin = { principal: alice, isAdmin: true };
const user = { principal: alice, isAdmin: false };
const other = { principal: bob, isAdmin: false };

beforeAll(() => {
    fs.writeFileSync(modelProvidersPath, JSON.stringify({
        providers: [
            {
                id: "azure-type",
                type: "openai",
                baseUrl: "https://example.invalid/v1",
                models: [{ name: "gpt-test", supportedReasoningEfforts: ["medium"], defaultReasoningEffort: "medium" }],
            },
            {
                id: "github-type",
                type: "github",
                models: [{
                    name: "claude-test",
                    supportedReasoningEfforts: ["high"],
                    defaultReasoningEffort: "high",
                    supportedContextTiers: ["default", "long_context"],
                    defaultContextTier: "default",
                }],
            },
        ],
    }));
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

async function withManagement(fn) {
    const env = getEnv();
    const mgmt = new PilotSwarmManagementClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        modelProvidersPath,
        disableManagementAgents: true,
        systemAgents: [
            { name: "root-system", id: "root-system", system: true, prompt: "root" },
            { name: "child-system", id: "child-system", system: true, parent: "root-system", prompt: "child" },
        ],
    });
    await mgmt.start();
    try {
        await mgmt.setUserProfileSettings(alice, {});
        await mgmt.setUserProfileSettings(bob, {});
        await fn(mgmt);
    } finally {
        await mgmt.stop();
    }
}

describe("provider and model default management", () => {
    it("creates providers from a type-only catalog and resolves user over cluster defaults", async () => {
        await withManagement(async (mgmt) => {
            await expect(mgmt.createMyProvider({ principal: null, isAdmin: true }, {
                name: "ownerless-personal", type: "github-type", credentials: { githubToken: "ownerless" },
            })).rejects.toMatchObject({ code: "PROVIDER_FORBIDDEN" });
            await mgmt.createProvider(admin, {
                name: "team-azure", type: "azure-type",
                credentials: { apiKey: "team-key" },
            });
            await mgmt.createMyProvider(user, {
                name: "alice-ghcp", type: "github-type",
                credentials: { githubToken: "alice-key" },
            });
            await mgmt.setModelDefault(admin, {
                scope: "cluster", provider: "team-azure", model: "gpt-test",
            });
            await mgmt.setModelDefault(user, {
                scope: "user", provider: "alice-ghcp", model: "claude-test",
            });

            const defaults = await mgmt.getModelDefaults(user);
            expect(defaults.clusterSession.configured.model).toBe("team-azure:gpt-test");
            expect(defaults.userSession.effective).toMatchObject({
                model: "alice-ghcp:claude-test", source: "user_default", reasoningEffort: "high",
            });
            expect(defaults.system.effective).toBeNull();
            expect(defaults.systemOverrides).toEqual([]);

            const listed = await mgmt.listProviders(admin);
            expect(listed.providers.find((provider) => provider.name === "alice-ghcp"))
                .toMatchObject({ name: "alice-ghcp", systemUseEnabled: false });
            const bobView = await mgmt.listProviders(other);
            expect(bobView.providers.some((provider) => provider.name === "alice-ghcp")).toBe(false);
            expect((await mgmt.listRuntimeModels(user)).map((model) => model.qualifiedName).sort())
                .toEqual(["alice-ghcp:claude-test", "team-azure:gpt-test"]);
            expect((await mgmt.listRuntimeModels(other)).map((model) => model.qualifiedName))
                .toEqual(["team-azure:gpt-test"]);

            const audit = await mgmt.listAuthzAudit({ limit: 50 });
            expect(audit.some((entry) => entry.action === "createMyProvider" && entry.target === "alice-ghcp")).toBe(true);
            expect(audit.some((entry) => entry.action === "setModelDefault")).toBe(true);
            expect(JSON.stringify(audit)).not.toContain("alice-key");

            const env = getEnv();
            const client = new PilotSwarmClient({
                store: env.store,
                duroxideSchema: env.duroxideSchema,
                cmsSchema: env.cmsSchema,
                factsSchema: env.factsSchema,
                modelProvidersPath,
            });
            await client.start();
            try {
                const aliceSession = await client.createSession({ owner: alice });
                const bobSession = await client.createSession({ owner: bob });
                expect(await mgmt.getSession(aliceSession.sessionId)).toMatchObject({
                    model: "alice-ghcp:claude-test",
                    reasoningEffort: "high",
                    contextTier: "default",
                });
                expect((await mgmt.getSession(bobSession.sessionId)).model).toBe("team-azure:gpt-test");
                const row = await mgmt._catalog.getSession(aliceSession.sessionId);
                expect(row.modelResolutionSource).toBe("user_default");
                const commands = [];
                mgmt.sendCommand = async (_sessionId, command) => commands.push(command);
                await mgmt.setSessionModel(aliceSession.sessionId, "team-azure:gpt-test", {
                    reasoningEffort: "medium",
                });
                expect(commands.at(-1)?.args?.model).toBe("team-azure:gpt-test");
                await expect(mgmt._catalog.createSession("forged-personal", {
                    model: "alice-ghcp:claude-test",
                    modelResolutionSource: "explicit",
                    owner: bob,
                })).rejects.toThrow(/PROVIDER_NOT_FOUND/);
            } finally {
                await client.stop();
            }
        });
    });

    it("allows only the admin owner to enable a personal provider for system use", async () => {
        await withManagement(async (mgmt) => {
            await mgmt.createMyProvider(user, {
                name: "alice-ghcp", type: "github-type", credentials: { githubToken: "alice-key" },
            });
            await expect(mgmt.setProviderSystemUse(user, { provider: "alice-ghcp", enabled: true }))
                .rejects.toMatchObject({ code: "PROVIDER_FORBIDDEN" });
            await expect(mgmt.setProviderSystemUse({ principal: bob, isAdmin: true }, { provider: "alice-ghcp", enabled: true }))
                .rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
            await expect(mgmt.setProviderSystemUse(admin, { provider: "alice-ghcp", enabled: true }))
                .resolves.toMatchObject({ systemUseEnabled: true });
            await mgmt._catalog.createSession("system-model-summary", {
                model: "alice-ghcp:claude-test",
                isSystem: true,
            });
            const registry = buildRuntimeRegistry(
                mgmt._modelProviders,
                await mgmt._catalog.providers.allCredentials(),
                null,
            );
            const manager = new SessionManager(undefined, null, { modelProviders: registry });
            manager.setSessionCatalog(mgmt._catalog);
            expect(await manager.getModelSummary("system-model-summary"))
                .toContain("alice-ghcp:claude-test");
            await mgmt.setProviderSystemUse(admin, { provider: "alice-ghcp", enabled: false });
            await mgmt._catalog.providers.pool.query(
                `UPDATE "${getEnv().cmsSchema}".provider_instances SET secret_ref='{}'::jsonb WHERE name='alice-ghcp'`,
            );
            expect((await mgmt.listRuntimeModels(user))
                .find((model) => model.qualifiedName === "alice-ghcp:claude-test")?.credentialAvailable)
                .toBe(false);
            await expect(mgmt.setProviderSystemUse(admin, { provider: "alice-ghcp", enabled: true }))
                .rejects.toMatchObject({ code: "PROVIDER_INVALID" });
        });
    });

    it("regeneration resolves personal runtime providers and rejects ambiguous bare models", async () => {
        await withManagement(async (mgmt) => {
            await mgmt.createMyProvider(user, {
                name: "alice-ghcp-a", type: "github-type", credentials: { githubToken: "alice-key-a" },
            });
            await mgmt.createMyProvider(user, {
                name: "alice-ghcp-b", type: "github-type", credentials: { githubToken: "alice-key-b" },
            });
            const client = new PilotSwarmClient({
                store: getEnv().store,
                duroxideSchema: getEnv().duroxideSchema,
                cmsSchema: getEnv().cmsSchema,
                factsSchema: getEnv().factsSchema,
                modelProvidersPath,
            });
            await client.start();
            try {
                await expect(client.createSession({ owner: alice, model: "claude-test" }))
                    .rejects.toMatchObject({
                        code: "MODEL_AMBIGUOUS",
                        candidates: ["alice-ghcp-a:claude-test", "alice-ghcp-b:claude-test"],
                    });
            } finally {
                await client.stop();
            }
            await mgmt._catalog.createSession("regen-runtime-provider", {
                model: "alice-ghcp-a:claude-test",
                modelResolutionSource: "explicit",
                owner: alice,
            });
            const commands = [];
            mgmt.sendCommand = async (_sessionId, command) => commands.push(command);

            await mgmt.regenerateSession("regen-runtime-provider", {
                model: "alice-ghcp-b:claude-test",
                distillerModel: "alice-ghcp-a:claude-test",
                distillerReasoningEffort: "high",
                distillerContextTier: "long_context",
                force: true,
            });
            expect(commands.at(-1)).toMatchObject({
                cmd: "regenerate",
                args: {
                    model: "alice-ghcp-b:claude-test",
                    distillerModel: "alice-ghcp-a:claude-test",
                    distillerReasoningEffort: "high",
                    distillerContextTier: "long_context",
                    force: true,
                },
            });

            await expect(mgmt.regenerateSession("regen-runtime-provider", {
                model: "claude-test",
            })).rejects.toThrow(/ambiguous/i);
        });
    });

    it("stores system defaults and excludes overridden agents from restart rollout", async () => {
        await withManagement(async (mgmt) => {
            await mgmt.createProvider(admin, {
                name: "team-azure", type: "azure-type", credentials: { apiKey: "team-key" },
            });
            await mgmt.setSystemSessionModel(admin, {
                agentId: "child-system", provider: "team-azure", model: "gpt-test",
            });
            for (const plan of mgmt._getSystemAgentPlans()) {
                await mgmt._catalog.createSession(plan.sessionId, {
                    model: "team-azure:gpt-test",
                    isSystem: true,
                    agentId: plan.agent.id,
                });
            }
            const restarted = [];
            mgmt.restartSystemSession = async (agentId, options) => {
                restarted.push({ agentId, options });
                const plan = mgmt._resolveSystemAgentPlan(agentId);
                await mgmt._catalog.updateSession(plan.sessionId, {
                    model: options.model,
                    reasoningEffort: options.reasoningEffort,
                    orchestrationId: `session-${plan.sessionId}`,
                    state: "running",
                });
                return { agentId, sessionId: agentId, disposition: options.disposition, startResults: [] };
            };

            const result = await mgmt.setSystemModelDefault(admin, {
                provider: "team-azure",
                model: "gpt-test",
                restartExisting: { disposition: "terminate" },
            });
            expect(result.effective).toMatchObject({ model: "team-azure:gpt-test", source: "system_default" });
            expect(result.restart).toMatchObject({ affected: 1, restarted: 1, failures: [] });
            expect(restarted.map((entry) => entry.agentId)).toEqual(["root-system"]);

            const retry = await mgmt.setSystemModelDefault(admin, {
                provider: "team-azure",
                model: "gpt-test",
                restartExisting: { disposition: "terminate" },
            });
            expect(retry.restart).toMatchObject({ affected: 0, restarted: 0, failures: [] });

            expect((await mgmt.getModelDefaults(admin)).systemOverrides)
                .toMatchObject([{ agentId: "child-system", model: "team-azure:gpt-test" }]);
            await expect(mgmt.clearSystemSessionModel(admin, "child-system"))
                .resolves.toEqual({ agentId: "child-system", cleared: true });
        });
    });

    it("adopts the legacy System GHCP key into the calling admin's private provider", async () => {
        await withManagement(async (mgmt) => {
            await mgmt.setSystemGitHubCopilotKey(alice, "github_pat_system_test");
            expect(await mgmt.getLegacyProviderMigrationStatus(admin)).toMatchObject({
                systemKeyPresent: true,
                systemKeyAdopted: false,
            });
            const adopted = await mgmt.adoptLegacySystemGitHubCopilotKey(admin, {
                name: "alice-system-ghcp",
            });
            expect(adopted.provider).toMatchObject({
                name: "alice-system-ghcp",
                class: "personal",
            });
            expect(adopted.status.systemKeyAdopted).toBe(true);
            const listed = await mgmt.listProviders(admin);
            expect(listed.providers.find((provider) => provider.name === "alice-system-ghcp"))
                .toMatchObject({ systemUseEnabled: true, systemEligible: true });
        });
    });
});
