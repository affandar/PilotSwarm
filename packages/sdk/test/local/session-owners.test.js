import { beforeAll, describe, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PilotSwarmManagementClient, PgSessionCatalogProvider } from "../../src/index.ts";
import { createInspectTools } from "../../src/index.ts";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

async function directQuery(env, sql, params = []) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: env.store });
    try {
        await client.connect();
        return await client.query(sql, params);
    } finally {
        try { await client.end(); } catch {}
    }
}

function uniqueId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function findTool(tools, name) {
    return tools.find((tool) => tool.name === name);
}

describe("session owner catalog", () => {
    beforeAll(async () => {
        await directQuery(getEnv(), "SELECT 1");
    });

    it("lazily registers users with first-seen profile fields", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const subject = uniqueId("owner-user");
        const firstSessionId = uniqueId("owned-session-a");
        const secondSessionId = uniqueId("owned-session-b");

        try {
            await catalog.createSession(firstSessionId, {
                owner: {
                    provider: "test",
                    subject,
                    email: "first@example.com",
                    displayName: "First Seen",
                },
            });
            await catalog.createSession(secondSessionId, {
                owner: {
                    provider: "test",
                    subject,
                    email: "second@example.com",
                    displayName: "Second Seen",
                },
            });

            const { rows: users } = await directQuery(
                env,
                `SELECT email, display_name FROM "${env.cmsSchema}".users WHERE provider = $1 AND subject = $2`,
                ["test", subject],
            );
            assertEqual(users.length, 1, "same provider/subject should register one user");
            assertEqual(users[0].email, "first@example.com", "first-seen email should win");
            assertEqual(users[0].display_name, "First Seen", "first-seen display name should win");

            const firstRow = await catalog.getSession(firstSessionId);
            const secondRow = await catalog.getSession(secondSessionId);
            assertEqual(firstRow?.owner?.email, "first@example.com", "first session should expose joined owner email");
            assertEqual(secondRow?.owner?.displayName, "First Seen", "second session should expose first-seen user profile");
        } finally {
            await catalog.close();
        }
    });

    it("keeps first session owner, inherits to non-system children, and leaves system sessions unowned", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const parentId = uniqueId("owned-parent");
        const childId = uniqueId("owned-child");
        const systemChildId = uniqueId("system-child");

        try {
            await catalog.createSession(parentId, {
                owner: {
                    provider: "test",
                    subject: `${parentId}-first`,
                    email: "first-owner@example.com",
                    displayName: "First Owner",
                },
            });
            await catalog.createSession(parentId, {
                owner: {
                    provider: "test",
                    subject: `${parentId}-second`,
                    email: "second-owner@example.com",
                    displayName: "Second Owner",
                },
            });
            await catalog.createSession(childId, { parentSessionId: parentId });
            await catalog.createSession(systemChildId, { parentSessionId: parentId, isSystem: true });

            const parent = await catalog.getSession(parentId);
            const child = await catalog.getSession(childId);
            const systemChild = await catalog.getSession(systemChildId);

            assertEqual(parent?.owner?.email, "first-owner@example.com", "first session owner assignment should win");
            assertEqual(child?.owner?.email, "first-owner@example.com", "non-system child should inherit parent owner");
            assert(systemChild?.owner == null, "system child should remain unowned");
        } finally {
            await catalog.close();
        }
    });

    it("surfaces owner metadata through management session listings", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        const mgmt = new PilotSwarmManagementClient({
            store: env.store,
            duroxideSchema: env.duroxideSchema,
            cmsSchema: env.cmsSchema,
            modelProvidersPath: path.join(env.baseDir, "model-providers.owner-test.json"),
        });
        const sessionId = uniqueId("managed-owned");

        try {
            fs.writeFileSync(path.join(env.baseDir, "model-providers.owner-test.json"), JSON.stringify({
                providers: [{
                    id: "owner-test",
                    type: "openai",
                    baseUrl: "https://example.invalid/v1",
                    apiKey: "test-key",
                    models: ["test-model"],
                }],
                defaultModel: "owner-test:test-model",
            }));
            await catalog.initialize();
            await catalog.createSession(sessionId, {
                owner: {
                    provider: "test",
                    subject: `${sessionId}-subject`,
                    email: "managed@example.com",
                    displayName: "Managed Owner",
                },
            });

            await mgmt.start();
            const sessions = await mgmt.listSessions();
            const view = sessions.find((session) => session.sessionId === sessionId);
            assert(view, "management list should include the owned session");
            assertEqual(view.owner?.displayName, "Managed Owner", "management view should expose owner display name");
            assertEqual(view.owner?.email, "managed@example.com", "management view should expose owner email");
        } finally {
            await mgmt.stop().catch(() => {});
            await catalog.close();
        }
    });

    it("aggregates user stats by owner and model", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const subject = uniqueId("stats-owner");
        const firstSessionId = uniqueId("user-stats-a");
        const secondSessionId = uniqueId("user-stats-b");
        const unownedSessionId = uniqueId("user-stats-unowned");

        try {
            const owner = {
                provider: "test",
                subject,
                email: "stats-owner@example.com",
                displayName: "Stats Owner",
            };
            await catalog.createSession(firstSessionId, { model: "model-a", owner });
            await catalog.createSession(secondSessionId, { model: "model-b", owner });
            await catalog.createSession(unownedSessionId, { model: "model-a" });
            await catalog.upsertSessionMetricSummary(firstSessionId, {
                tokensInputIncrement: 100,
                tokensOutputIncrement: 25,
                tokensCacheReadIncrement: 50,
                snapshotSizeBytes: 1024,
            });
            await catalog.upsertSessionMetricSummary(secondSessionId, {
                tokensInputIncrement: 200,
                tokensOutputIncrement: 50,
                snapshotSizeBytes: 2048,
            });
            await catalog.upsertSessionMetricSummary(unownedSessionId, {
                tokensInputIncrement: 75,
                snapshotSizeBytes: 512,
            });

            const stats = await catalog.getUserStats({ includeDeleted: true });
            const owned = stats.users.find((user) => user.owner?.subject === subject);
            assert(owned, "owned stats bucket should be present");
            assertEqual(owned.sessionCount, 2, "owned bucket should count both sessions");
            assertEqual(owned.totalTokensInput, 300, "owned bucket should sum input tokens");
            assertEqual(owned.totalSnapshotSizeBytes, 3072, "owned bucket should sum snapshots");
            assertEqual(owned.cacheHitRatio, 50 / 300, "owned bucket should derive cache ratio");
            assert(owned.byModel.some((row) => row.model === "model-a" && row.sessionIds.includes(firstSessionId)), "model-a row should include first session id");
            assert(owned.byModel.some((row) => row.model === "model-b" && row.sessionIds.includes(secondSessionId)), "model-b row should include second session id");

            const unowned = stats.users.find((user) => user.ownerKind === "unowned" && user.sessionIds.includes(unownedSessionId));
            assert(unowned, "unowned stats bucket should be present");
            assertEqual(unowned.totalTokensInput, 75, "unowned bucket should sum input tokens");
        } finally {
            await catalog.close();
        }
    });

    it("lets system agents query sessions and owner stats by owner filters", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const ownerSessionId = uniqueId("owner-filter-session");
        const otherSessionId = uniqueId("owner-filter-other");

        try {
            await catalog.createSession(ownerSessionId, {
                model: "model-a",
                owner: {
                    provider: "test",
                    subject: `${ownerSessionId}-subject`,
                    email: "owner-filter@example.com",
                    displayName: "Owner Filter",
                },
            });
            await catalog.createSession(otherSessionId, { model: "model-b" });
            await catalog.upsertSessionMetricSummary(ownerSessionId, {
                tokensInputIncrement: 120,
                tokensCacheReadIncrement: 60,
                snapshotSizeBytes: 512,
            });

            const tools = createInspectTools({ catalog, agentIdentity: "pilotswarm" });

            const list = await findTool(tools, "list_all_sessions").handler({
                owner_query: "owner-filter@example.com",
                owner_kind: "user",
                include_system: false,
            }, { sessionId: "system-agent" });
            assertEqual(list.count, 1, "owner query should return the matching owned session only");
            assertEqual(list.sessions[0].sessionId, ownerSessionId, "owner query should surface the owned session");
            assertEqual(list.sessions[0].ownerLabel, "Owner Filter <owner-filter@example.com>", "owner query should include a readable owner label");

            const info = await findTool(tools, "read_session_info").handler({
                session_id: ownerSessionId,
            }, { sessionId: "system-agent" });
            assertEqual(info.ownerKind, "user", "session info should classify owned sessions as user-owned");
            assertEqual(info.owner?.email, "owner-filter@example.com", "session info should return owner metadata");

            const userStats = await findTool(tools, "read_user_stats").handler({
                owner_query: "owner filter",
                owner_kind: "user",
            }, { sessionId: "system-agent" });
            assertEqual(userStats.users.length, 1, "owner stats should return only the matching owner bucket");
            assertEqual(userStats.users[0].ownerLabel, "Owner Filter <owner-filter@example.com>", "owner stats should include a readable owner label");
            assertEqual(userStats.totals.totalTokensInput, 120, "filtered owner stats should aggregate only matching owners");
        } finally {
            await catalog.close();
        }
    });
});
