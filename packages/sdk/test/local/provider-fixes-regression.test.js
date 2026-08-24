import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PilotSwarmManagementClient } from "../../dist/management-client.js";
import { useSuiteEnv } from "../helpers/local-env.js";

// Narrow regressions for the 2026-08-24 campaign fixes. Each case pins one
// defect; each was verified red against the pre-fix build.

const getEnv = useSuiteEnv(import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-provider-fixes-"));
const modelProvidersPath = path.join(root, "model-providers.json");
const alice = { provider: "entra", subject: "alice", email: "alice@example.test", displayName: "Alice" };
const bob = { provider: "entra", subject: "bob", email: "bob@example.test", displayName: "Bob" };
const admin = { principal: alice, isAdmin: true };
const owner = { principal: bob, isAdmin: false };

beforeAll(() => {
    fs.writeFileSync(modelProvidersPath, JSON.stringify({
        providers: [
            {
                id: "azure-type",
                type: "openai",
                baseUrl: "https://example.invalid/v1",
                models: [{ name: "gpt-test", supportedReasoningEfforts: ["medium"], defaultReasoningEffort: "medium" }],
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

describe("provider fixes regression (2026-08-24 campaign)", () => {
    it("M5: a hold ending in the past is refused, not stored and echoed as set", async () => {
        await withManagement(async (mgmt) => {
            await mgmt.createProvider(admin, {
                name: "hold-target", type: "azure-type", credentials: { apiKey: "k" },
            });
            await expect(mgmt.setProviderHold(admin, {
                provider: "hold-target", untilUtc: "2020-01-01T00:00:00Z",
            })).rejects.toMatchObject({ code: "PROVIDER_INVALID" });
            await expect(mgmt.setProviderHold(admin, {
                provider: "hold-target", untilUtc: "not-a-timestamp",
            })).rejects.toMatchObject({ code: "PROVIDER_INVALID" });

            // The refusal must not have stored anything.
            const listed = await mgmt.listProviders(admin);
            const row = listed.providers.find((p) => p.name === "hold-target");
            expect(row.holdUntilUtc).toBeNull();
            expect(row.holdIndefinite).toBe(false);

            // Future holds and releases still work.
            const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            const set = await mgmt.setProviderHold(admin, { provider: "hold-target", untilUtc: future });
            expect(set.holdUntilUtc).toBe(future);
            const released = await mgmt.setProviderHold(admin, { provider: "hold-target", release: true });
            expect(released.holdUntilUtc).toBeNull();
        });
    });

    it("M7: /me cannot delete a SHARED provider, even for an admin, and says not-found rather than forbidden", async () => {
        await withManagement(async (mgmt) => {
            await mgmt.createProvider(admin, {
                name: "shared-keep", type: "azure-type", credentials: { apiKey: "k" },
            });

            // Admin through the personal route: the name does not exist there.
            await expect(mgmt.deleteMyProvider(admin, "shared-keep"))
                .rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
            // Non-admin: same answer — not-found, never "forbidden" (an
            // existence oracle the read paths carefully avoid).
            await expect(mgmt.deleteMyProvider(owner, "shared-keep"))
                .rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });

            // The shared row survived both attempts.
            const listed = await mgmt.listProviders(admin);
            expect(listed.providers.some((p) => p.name === "shared-keep")).toBe(true);

            // The owner still deletes their own personal provider here.
            await mgmt.createMyProvider(owner, {
                name: "bob-own", type: "azure-type", credentials: { apiKey: "b" },
            });
            const deleted = await mgmt.deleteMyProvider(owner, "bob-own");
            expect(deleted.name).toBe("bob-own");
            // And nobody deletes another person's personal provider by name.
            await mgmt.createMyProvider(owner, {
                name: "bob-own-2", type: "azure-type", credentials: { apiKey: "b" },
            });
            await expect(mgmt.deleteMyProvider(admin, "bob-own-2"))
                .rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
        });
    });

    it("garbage limit values are refused before Postgres sees them (no raw 22P02)", async () => {
        await withManagement(async (mgmt) => {
            await mgmt.createProvider(admin, {
                name: "limit-target", type: "azure-type", credentials: { apiKey: "k" },
            });
            for (const bad of [1.5, "abc", NaN, -1, Infinity]) {
                await expect(mgmt.setProviderLimit(admin, {
                    provider: "limit-target", period: "day", tokens: bad,
                })).rejects.toMatchObject({ code: "PROVIDER_INVALID" });
            }
            // A whole number still saves.
            const saved = await mgmt.setProviderLimit(admin, {
                provider: "limit-target", period: "day", tokens: 1000,
            });
            expect(saved.ruleId).toBeTruthy();
        });
    });

    it("M6: restart-system rejects caller mistakes with coded 4xx errors, not bare 500-bound throws", async () => {
        await withManagement(async (mgmt) => {
            // Missing disposition: a client mistake, coded INVALID_REQUEST.
            await expect(mgmt.restartSystemSession("anything", {}))
                .rejects.toMatchObject({ code: "INVALID_REQUEST" });
            // Bogus disposition value: same code.
            await expect(mgmt.restartSystemSession("anything", { disposition: "detonate" }))
                .rejects.toMatchObject({ code: "INVALID_REQUEST" });
            // Unknown agent with a correct body: coded NOT_FOUND naming the id.
            await expect(mgmt.restartSystemSession("no-such-agent", { disposition: "complete" }))
                .rejects.toMatchObject({ code: "NOT_FOUND" });
        });
    });
});
