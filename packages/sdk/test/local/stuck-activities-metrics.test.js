import { describe, expect, it, vi } from "vitest";
import { countStuckWorkerQueueActivities } from "../../src/stuck-activities-metrics.ts";

describe("stuck activities metrics", () => {
    it("counts unlocked worker queue rows older than the threshold", async () => {
        const pool = {
            query: vi.fn(async () => ({ rows: [{ count: 3 }] })),
        };

        const count = await countStuckWorkerQueueActivities(pool, {
            duroxideSchema: "duroxide",
            thresholdMs: 60_000,
        });

        expect(count).toBe(3);
        expect(pool.query).toHaveBeenCalledWith(
            expect.stringContaining("FROM \"duroxide\".worker_queue"),
            [60_000],
        );
        expect(pool.query.mock.calls[0][0]).toContain("lock_token IS NULL");
        expect(pool.query.mock.calls[0][0]).toContain("visible_at < now()");
    });

    it("quotes custom Duroxide schema names", async () => {
        const pool = {
            query: vi.fn(async () => ({ rows: [{ count: 0 }] })),
        };

        await countStuckWorkerQueueActivities(pool, {
            duroxideSchema: 'tenant"schema',
            thresholdMs: 1_000,
        });

        expect(pool.query.mock.calls[0][0]).toContain('FROM "tenant""schema".worker_queue');
    });
});
