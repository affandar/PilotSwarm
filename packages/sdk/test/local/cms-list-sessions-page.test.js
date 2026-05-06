import { describe, it, expect } from "vitest";
import { PgSessionCatalogProvider, PilotSwarmManagementClient } from "../../src/index.ts";

function createMockPool(returnRows = []) {
    const calls = [];
    const pool = {
        async query(sql, params) {
            calls.push({ sql: String(sql), params: params ?? [] });
            return { rows: returnRows };
        },
        on() {},
        async end() {},
    };
    return { pool, calls };
}

function buildProvider(mockPool) {
    const schema = "copilot_sessions";
    const s = `"${schema}"`;
    const provider = Object.create(PgSessionCatalogProvider.prototype);
    provider.pool = mockPool;
    provider.initialized = true;
    provider.sql = {
        schema,
        fn: {
            listSessionsPage: `${s}.cms_list_sessions_page`,
        },
    };
    return provider;
}

describe("PgSessionCatalogProvider.listSessionsPage", () => {
    it("uses limit+1 probe and computes hasMore/nextCursor", async () => {
        const rows = [
            {
                session_id: "s3",
                created_at: "2026-04-30T01:00:00.000Z",
                updated_at: "2026-04-30T03:00:00.000Z",
                title: "s3",
                state: "idle",
                current_iteration: 1,
            },
            {
                session_id: "s2",
                created_at: "2026-04-30T01:00:00.000Z",
                updated_at: "2026-04-30T02:00:00.000Z",
                title: "s2",
                state: "idle",
                current_iteration: 1,
            },
            {
                session_id: "s1",
                created_at: "2026-04-30T01:00:00.000Z",
                updated_at: "2026-04-30T01:00:00.000Z",
                title: "s1",
                state: "idle",
                current_iteration: 1,
            },
        ];
        const { pool, calls } = createMockPool(rows);
        const provider = buildProvider(pool);

        const page = await provider.listSessionsPage({ limit: 2 });

        expect(calls).toHaveLength(1);
        expect(calls[0].sql).toContain("cms_list_sessions_page");
        expect(calls[0].params).toEqual([3, null, null, false]);
        expect(page.items).toHaveLength(2);
        expect(page.hasMore).toBe(true);
        expect(page.nextCursor).toEqual({
            updatedAt: "2026-04-30T02:00:00.000Z",
            sessionId: "s2",
        });
    });

    it("clamps limits and forwards cursor/includeDeleted", async () => {
        const rows = [{
            session_id: "s9",
            created_at: "2026-04-30T01:00:00.000Z",
            updated_at: "2026-04-30T09:00:00.000Z",
            title: "s9",
            state: "idle",
            current_iteration: 1,
        }];
        const { pool, calls } = createMockPool(rows);
        const provider = buildProvider(pool);

        await provider.listSessionsPage({
            limit: 9999,
            cursor: { updatedAt: "2026-04-30T08:00:00.000Z", sessionId: "s8" },
            includeDeleted: true,
        });

        expect(calls[0].params).toEqual([
            201,
            "2026-04-30T08:00:00.000Z",
            "s8",
            true,
        ]);
    });
});

describe("PilotSwarmManagementClient.listSessionsPage", () => {
    it("maps SessionRow page to PilotSwarmSessionView page", async () => {
        const mgmt = Object.create(PilotSwarmManagementClient.prototype);
        mgmt._started = true;
        mgmt._catalog = {
            async listSessionsPage() {
                return {
                    items: [{
                        sessionId: "s1",
                        title: "Session 1",
                        agentId: "agent",
                        splash: null,
                        state: "idle",
                        model: "github-copilot:gpt-5-mini",
                        createdAt: new Date("2026-04-30T01:00:00.000Z"),
                        updatedAt: new Date("2026-04-30T01:05:00.000Z"),
                        currentIteration: 2,
                        parentSessionId: null,
                        isSystem: false,
                        lastError: null,
                        waitReason: null,
                    }],
                    nextCursor: { updatedAt: "2026-04-30T01:05:00.000Z", sessionId: "s1" },
                    hasMore: true,
                };
            },
        };

        const page = await mgmt.listSessionsPage({ limit: 50 });
        expect(page.items).toHaveLength(1);
        expect(page.items[0].sessionId).toBe("s1");
        expect(page.items[0].status).toBe("idle");
        expect(page.nextCursor).toEqual({
            updatedAt: "2026-04-30T01:05:00.000Z",
            sessionId: "s1",
        });
        expect(page.hasMore).toBe(true);
    });
});
