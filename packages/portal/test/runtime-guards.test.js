import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock NodeSdkTransport before importing PortalRuntime ──────────

const mockTransport = vi.hoisted(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    listSessionsPage: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    getSessionEvents: vi.fn().mockResolvedValue([]),
    getSessionEventsBefore: vi.fn().mockResolvedValue([]),
    getSessionTurnMetrics: vi.fn().mockResolvedValue([]),
    getFleetTurnAnalytics: vi.fn().mockResolvedValue([]),
    getHourlyTokenBuckets: vi.fn().mockResolvedValue([]),
    getFleetDbCallMetrics: vi.fn().mockResolvedValue([]),
    getTopEventEmitters: vi.fn().mockResolvedValue([]),
}));

vi.mock("pilotswarm-cli/portal", () => ({
    // Must use a regular function (not arrow) so `new` works; returning an object
    // from a constructor uses that object as the result instead of `this`.
    NodeSdkTransport: vi.fn(function () { return mockTransport; }),
}));

import { PortalRuntime, clampInt, clampLimit, enforceMaxWindowDays } from "../runtime.js";

// ─── Helper guard unit tests ───────────────────────────────────────

describe("clampInt", () => {
    it("returns value within range unchanged", () => {
        expect(clampInt(50, 10, 1, 100)).toBe(50);
    });
    it("clamps to max when value exceeds max", () => {
        expect(clampInt(9999, 10, 1, 500)).toBe(500);
    });
    it("clamps to min when value is below min", () => {
        expect(clampInt(-5, 10, 1, 500)).toBe(1);
    });
    it("returns fallback for undefined", () => {
        expect(clampInt(undefined, 200, 1, 500)).toBe(200);
    });
    it("returns fallback for NaN string", () => {
        expect(clampInt("bad", 200, 1, 500)).toBe(200);
    });
    it("parses numeric strings", () => {
        expect(clampInt("300", 10, 1, 500)).toBe(300);
    });
    it("clamps parsed numeric string to max", () => {
        expect(clampInt("9999", 10, 1, 500)).toBe(500);
    });
    it("applies min boundary exactly", () => {
        expect(clampInt(1, 10, 1, 500)).toBe(1);
    });
    it("applies max boundary exactly", () => {
        expect(clampInt(500, 10, 1, 500)).toBe(500);
    });
});

describe("clampLimit", () => {
    it("min is always 1", () => {
        expect(clampLimit(0, 200, 500)).toBe(1);
        expect(clampLimit(-100, 200, 500)).toBe(1);
    });
    it("caps at max", () => {
        expect(clampLimit(9999, 200, 500)).toBe(500);
    });
    it("uses fallback for undefined", () => {
        expect(clampLimit(undefined, 200, 500)).toBe(200);
    });
    it("passes valid value through unchanged", () => {
        expect(clampLimit(100, 200, 500)).toBe(100);
    });
});

describe("enforceMaxWindowDays", () => {
    it("returns undefined for undefined input", () => {
        expect(enforceMaxWindowDays(undefined, 30, "since")).toBeUndefined();
    });
    it("returns null for null input", () => {
        expect(enforceMaxWindowDays(null, 30, "since")).toBeNull();
    });
    it("returns date unchanged when within window", () => {
        const d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 days ago
        expect(enforceMaxWindowDays(d, 30, "since")).toBe(d);
    });
    it("throws when date is older than maxDays", () => {
        const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000); // 31 days ago
        expect(() => enforceMaxWindowDays(old, 30, "since"))
            .toThrow(/Invalid RPC parameter "since": must be within the last 30 days/);
    });
    it("throws for a clearly ancient date", () => {
        expect(() => enforceMaxWindowDays(new Date("2025-01-01"), 30, "since"))
            .toThrow(/Invalid RPC parameter "since"/);
    });
    it("uses fieldName in error message", () => {
        const old = new Date("2020-01-01");
        expect(() => enforceMaxWindowDays(old, 30, "myField"))
            .toThrow(/"myField"/);
    });
    it("accepts a date exactly at the boundary (within a second)", () => {
        const boundary = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000 + 1000); // 1s inside
        expect(() => enforceMaxWindowDays(boundary, 30, "since")).not.toThrow();
    });
});

// ─── PortalRuntime switch-case integration tests ───────────────────

let runtime;
beforeEach(() => {
    vi.clearAllMocks();
    runtime = new PortalRuntime({ store: "postgresql://test", mode: "test" });
    runtime.started = true; // skip actual start() call
    runtime.transport = mockTransport;
});

describe("listSessionsPage guards", () => {
    it("uses default limit 50 when limit is undefined", async () => {
        await runtime.call("listSessionsPage", {});
        expect(mockTransport.listSessionsPage).toHaveBeenCalledWith(
            expect.objectContaining({ limit: 50, cursor: undefined }),
        );
    });

    it("clamps listSessionsPage limit to max 200", async () => {
        await runtime.call("listSessionsPage", { limit: 9999 });
        expect(mockTransport.listSessionsPage).toHaveBeenCalledWith(
            expect.objectContaining({ limit: 200 }),
        );
    });

    it("throws when cursor has only updatedAt", async () => {
        await expect(
            runtime.call("listSessionsPage", { cursor: { updatedAt: new Date().toISOString() } }),
        ).rejects.toThrow(/Invalid RPC parameter "cursor": must include both "updatedAt" and "sessionId"/);
    });

    it("throws when cursor has only sessionId", async () => {
        await expect(
            runtime.call("listSessionsPage", { cursor: { sessionId: "s1" } }),
        ).rejects.toThrow(/Invalid RPC parameter "cursor": must include both "updatedAt" and "sessionId"/);
    });

    it("throws when cursor.updatedAt is invalid", async () => {
        await expect(
            runtime.call("listSessionsPage", { cursor: { updatedAt: "bad", sessionId: "s1" } }),
        ).rejects.toThrow(/Invalid RPC parameter "cursor.updatedAt": expected ISO date value/);
    });

    it("passes normalized cursor when both fields are valid", async () => {
        await runtime.call("listSessionsPage", {
            cursor: { updatedAt: "2026-04-30T00:00:00.000Z", sessionId: "s1" },
            limit: 25,
            includeDeleted: true,
        });
        expect(mockTransport.listSessionsPage).toHaveBeenCalledWith({
            limit: 25,
            includeDeleted: true,
            cursor: {
                updatedAt: "2026-04-30T00:00:00.000Z",
                sessionId: "s1",
            },
        });
    });
});

// getSessionEvents limit clamping
describe("getSessionEvents limit cap", () => {
    it("uses default 200 when limit is undefined", async () => {
        await runtime.call("getSessionEvents", { sessionId: "s1" });
        expect(mockTransport.getSessionEvents).toHaveBeenCalledWith("s1", undefined, 200);
    });
    it("passes valid limit through", async () => {
        await runtime.call("getSessionEvents", { sessionId: "s1", limit: 100 });
        expect(mockTransport.getSessionEvents).toHaveBeenCalledWith("s1", undefined, 100);
    });
    it("clamps oversized limit to 500", async () => {
        await runtime.call("getSessionEvents", { sessionId: "s1", limit: 9999 });
        expect(mockTransport.getSessionEvents).toHaveBeenCalledWith("s1", undefined, 500);
    });
    it("clamps limit 0 to 1", async () => {
        await runtime.call("getSessionEvents", { sessionId: "s1", limit: 0 });
        expect(mockTransport.getSessionEvents).toHaveBeenCalledWith("s1", undefined, 1);
    });
    it("passes afterSeq unchanged", async () => {
        await runtime.call("getSessionEvents", { sessionId: "s1", afterSeq: 42, limit: 50 });
        expect(mockTransport.getSessionEvents).toHaveBeenCalledWith("s1", 42, 50);
    });
});

// getSessionEventsBefore limit clamping
describe("getSessionEventsBefore limit cap", () => {
    it("uses default 200 when limit is undefined", async () => {
        await runtime.call("getSessionEventsBefore", { sessionId: "s1", beforeSeq: 10 });
        expect(mockTransport.getSessionEventsBefore).toHaveBeenCalledWith("s1", 10, 200);
    });
    it("clamps oversized limit to 500", async () => {
        await runtime.call("getSessionEventsBefore", { sessionId: "s1", beforeSeq: 10, limit: 9999 });
        expect(mockTransport.getSessionEventsBefore).toHaveBeenCalledWith("s1", 10, 500);
    });
});

// getSessionTurnMetrics limit clamping
describe("getSessionTurnMetrics limit cap", () => {
    it("uses default 100 when limit is undefined", async () => {
        await runtime.call("getSessionTurnMetrics", { sessionId: "s1" });
        expect(mockTransport.getSessionTurnMetrics).toHaveBeenCalledWith("s1", expect.objectContaining({ limit: 100 }));
    });
    it("clamps oversized limit to 500", async () => {
        await runtime.call("getSessionTurnMetrics", { sessionId: "s1", limit: 9999 });
        expect(mockTransport.getSessionTurnMetrics).toHaveBeenCalledWith("s1", expect.objectContaining({ limit: 500 }));
    });
    it("passes valid limit through", async () => {
        await runtime.call("getSessionTurnMetrics", { sessionId: "s1", limit: 50 });
        expect(mockTransport.getSessionTurnMetrics).toHaveBeenCalledWith("s1", expect.objectContaining({ limit: 50 }));
    });
});

// getFleetTurnAnalytics window guard
describe("getFleetTurnAnalytics window guard", () => {
    it("passes when since is undefined", async () => {
        await runtime.call("getFleetTurnAnalytics", {});
        expect(mockTransport.getFleetTurnAnalytics).toHaveBeenCalledWith(
            expect.objectContaining({ since: expect.any(Date) }),
        );
    });
    it("passes when since is within 30 days", async () => {
        const recent = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        await runtime.call("getFleetTurnAnalytics", { since: recent });
        expect(mockTransport.getFleetTurnAnalytics).toHaveBeenCalled();
    });
    it("throws when since is older than 30 days", async () => {
        await expect(runtime.call("getFleetTurnAnalytics", { since: "2025-01-01T00:00:00Z" }))
            .rejects.toThrow(/Invalid RPC parameter "since": must be within the last 30 days/);
    });
});

// getHourlyTokenBuckets window guard
describe("getHourlyTokenBuckets window guard", () => {
    it("throws when since is missing", async () => {
        await expect(runtime.call("getHourlyTokenBuckets", {}))
            .rejects.toThrow(/Invalid RPC parameter "since": required ISO date value/);
    });
    it("throws when since is older than 30 days", async () => {
        await expect(runtime.call("getHourlyTokenBuckets", { since: "2024-01-01T00:00:00Z" }))
            .rejects.toThrow(/Invalid RPC parameter "since": must be within the last 30 days/);
    });
    it("passes when since is within 30 days", async () => {
        const recent = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
        await runtime.call("getHourlyTokenBuckets", { since: recent });
        expect(mockTransport.getHourlyTokenBuckets).toHaveBeenCalled();
    });
});

// getFleetDbCallMetrics window guard
describe("getFleetDbCallMetrics window guard", () => {
    it("passes when since is undefined", async () => {
        await runtime.call("getFleetDbCallMetrics", {});
        expect(mockTransport.getFleetDbCallMetrics).toHaveBeenCalledWith(
            expect.objectContaining({ since: expect.any(Date) }),
        );
    });
    it("throws when since is older than 30 days", async () => {
        await expect(runtime.call("getFleetDbCallMetrics", { since: "2024-06-01T00:00:00Z" }))
            .rejects.toThrow(/Invalid RPC parameter "since": must be within the last 30 days/);
    });
    it("passes when since is within 30 days", async () => {
        const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
        await runtime.call("getFleetDbCallMetrics", { since: recent });
        expect(mockTransport.getFleetDbCallMetrics).toHaveBeenCalled();
    });
});

// getTopEventEmitters guards
describe("getTopEventEmitters guards", () => {
    it("throws when since is missing", async () => {
        await expect(runtime.call("getTopEventEmitters", {}))
            .rejects.toThrow(/Invalid RPC parameter "since": required ISO date value/);
    });
    it("throws when since is not a valid date", async () => {
        await expect(runtime.call("getTopEventEmitters", { since: "not-a-date" }))
            .rejects.toThrow(/Invalid RPC parameter "since": expected ISO date value/);
    });
    it("throws when since is older than 30 days", async () => {
        await expect(runtime.call("getTopEventEmitters", { since: "2025-01-01T00:00:00Z" }))
            .rejects.toThrow(/Invalid RPC parameter "since": must be within the last 30 days/);
    });
    it("passes when since is within 30 days", async () => {
        const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
        await runtime.call("getTopEventEmitters", { since: recent });
        expect(mockTransport.getTopEventEmitters).toHaveBeenCalled();
    });
    it("uses default limit 20 when limit is undefined", async () => {
        const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
        await runtime.call("getTopEventEmitters", { since: recent });
        expect(mockTransport.getTopEventEmitters).toHaveBeenCalledWith(
            expect.objectContaining({ limit: 20 }),
        );
    });
    it("clamps oversized limit to 100", async () => {
        const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
        await runtime.call("getTopEventEmitters", { since: recent, limit: 9999 });
        expect(mockTransport.getTopEventEmitters).toHaveBeenCalledWith(
            expect.objectContaining({ limit: 100 }),
        );
    });
    it("clamps limit 0 to 1", async () => {
        const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
        await runtime.call("getTopEventEmitters", { since: recent, limit: 0 });
        expect(mockTransport.getTopEventEmitters).toHaveBeenCalledWith(
            expect.objectContaining({ limit: 1 }),
        );
    });
    it("passes valid limit through unchanged", async () => {
        const recent = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString();
        await runtime.call("getTopEventEmitters", { since: recent, limit: 50 });
        expect(mockTransport.getTopEventEmitters).toHaveBeenCalledWith(
            expect.objectContaining({ limit: 50 }),
        );
    });
});
