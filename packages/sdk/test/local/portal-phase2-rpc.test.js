/**
 * Phase 2 RPC plumbing contract tests.
 *
 * Verifies that the five new analytics methods are correctly wired through
 * all three layers of the portal RPC stack:
 *
 *   BrowserPortalTransport (browser-transport.js)
 *     → PortalRuntime.call()     (runtime.js)
 *       → NodeSdkTransport       (node-sdk-transport.js)
 *         → PilotSwarmManagementClient
 *
 * Two test strategies:
 *   1. File-content contracts: assertIncludes on the raw JS sources to verify
 *      structural presence (switch cases, method signatures, serialization logic).
 *   2. Functional BrowserPortalTransport tests: instantiate the class, spy on
 *      rpc(), and assert the correct method name + payload are sent.
 *
 * Run: npx vitest run test/local/portal-phase2-rpc.test.js
 */

import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

function readRepoFile(relPath) {
    return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

// ─── File-content helpers ─────────────────────────────────────────

function assertIncludes(src, needle, label) {
    if (!src.includes(needle)) {
        throw new Error(`${label}: expected to find\n  ${JSON.stringify(needle)}`);
    }
}

function assertNotIncludes(src, needle, label) {
    if (src.includes(needle)) {
        throw new Error(`${label}: expected NOT to find\n  ${JSON.stringify(needle)}`);
    }
}

// ─── Layer 1: node-sdk-transport.js ──────────────────────────────

describe("node-sdk-transport — Phase 2 delegation methods", () => {
    const src = readRepoFile("packages/cli/src/node-sdk-transport.js");

    it("delegates listSessionsPage to mgmt", () => {
        assertIncludes(src, "async listSessionsPage(params)", "node transport missing listSessionsPage");
        assertIncludes(src, "this.mgmt.listSessionsPage(params)", "node transport must delegate to mgmt.listSessionsPage");
    });

    it("delegates getSessionTurnMetrics to mgmt", () => {
        assertIncludes(src, "async getSessionTurnMetrics(sessionId, opts)", "node transport missing getSessionTurnMetrics");
        assertIncludes(src, "this.mgmt.getSessionTurnMetrics(sessionId, opts)", "node transport must delegate to mgmt.getSessionTurnMetrics");
    });

    it("delegates getFleetTurnAnalytics to mgmt", () => {
        assertIncludes(src, "async getFleetTurnAnalytics(opts)", "node transport missing getFleetTurnAnalytics");
        assertIncludes(src, "this.mgmt.getFleetTurnAnalytics(opts)", "node transport must delegate to mgmt.getFleetTurnAnalytics");
    });

    it("delegates getHourlyTokenBuckets to mgmt", () => {
        assertIncludes(src, "async getHourlyTokenBuckets(since, opts)", "node transport missing getHourlyTokenBuckets");
        assertIncludes(src, "this.mgmt.getHourlyTokenBuckets(since, opts)", "node transport must delegate to mgmt.getHourlyTokenBuckets");
    });

    it("delegates getFleetDbCallMetrics to mgmt", () => {
        assertIncludes(src, "async getFleetDbCallMetrics(opts)", "node transport missing getFleetDbCallMetrics");
        assertIncludes(src, "this.mgmt.getFleetDbCallMetrics(opts)", "node transport must delegate to mgmt.getFleetDbCallMetrics");
    });

    it("delegates pruneTurnMetrics to mgmt", () => {
        assertIncludes(src, "async pruneTurnMetrics(olderThan)", "node transport missing pruneTurnMetrics");
        assertIncludes(src, "this.mgmt.pruneTurnMetrics(olderThan)", "node transport must delegate to mgmt.pruneTurnMetrics");
    });

    it("delegates getSessionEvents to mgmt", () => {
        assertIncludes(src, "async getSessionEvents(", "node transport missing getSessionEvents");
        assertIncludes(src, "this.mgmt.getSessionEvents(", "node transport must delegate to mgmt.getSessionEvents");
    });

    it("delegates getSessionEventsBefore to mgmt", () => {
        assertIncludes(src, "async getSessionEventsBefore(", "node transport missing getSessionEventsBefore");
        assertIncludes(src, "this.mgmt.getSessionEventsBefore(", "node transport must delegate to mgmt.getSessionEventsBefore");
    });

    it("delegates getTopEventEmitters to mgmt", () => {
        assertIncludes(src, "async getTopEventEmitters(params)", "node transport missing getTopEventEmitters");
        assertIncludes(src, "this.mgmt.getTopEventEmitters(params)", "node transport must delegate to mgmt.getTopEventEmitters");
    });
});

// ─── Layer 2: runtime.js switch cases ────────────────────────────

describe("runtime.js — Phase 2 switch cases and date normalization", () => {
    const src = readRepoFile("packages/portal/runtime.js");

    it("has switch case for getSessionTurnMetrics", () => {
        assertIncludes(src, 'case "getSessionTurnMetrics":', "runtime missing getSessionTurnMetrics switch case");
        assertIncludes(src, "getSessionTurnMetrics(safeParams.sessionId", "runtime must pass sessionId to transport");
    });

    it("normalizes since param to Date for getSessionTurnMetrics", () => {
        // Verify optional-date parser helper usage
        const caseBlock = src.slice(src.indexOf('case "getSessionTurnMetrics":'));
        assertIncludes(caseBlock.slice(0, 300), "parseOptionalDate(safeParams.since)", "runtime must normalize optional since");
    });

    it("passes limit param for getSessionTurnMetrics", () => {
        const caseBlock = src.slice(src.indexOf('case "getSessionTurnMetrics":'));
        assertIncludes(caseBlock.slice(0, 300), "safeParams.limit", "runtime must forward limit param");
    });

    it("has switch case for getFleetTurnAnalytics", () => {
        assertIncludes(src, 'case "getFleetTurnAnalytics":', "runtime missing getFleetTurnAnalytics switch case");
        assertIncludes(src, "getFleetTurnAnalytics(", "runtime must call transport.getFleetTurnAnalytics");
    });

    it("normalizes since/agentId/model params for getFleetTurnAnalytics", () => {
        const start = src.indexOf('case "getFleetTurnAnalytics":');
        const caseBlock = src.slice(start, start + 400);
        assertIncludes(caseBlock, 'parseOptionalDate(safeParams.since, "since")', "runtime must validate+convert since for getFleetTurnAnalytics");
        assertIncludes(caseBlock, "defaultSinceDays(", "runtime must default missing since window for getFleetTurnAnalytics");
        assertIncludes(caseBlock, "enforceMaxWindowDays(", "runtime must enforce max since window for getFleetTurnAnalytics");
        assertIncludes(caseBlock, "safeParams.agentId", "runtime must forward agentId");
        assertIncludes(caseBlock, "safeParams.model", "runtime must forward model");
    });

    it("has switch case for getHourlyTokenBuckets with required since", () => {
        assertIncludes(src, 'case "getHourlyTokenBuckets":', "runtime missing getHourlyTokenBuckets switch case");
        const start = src.indexOf('case "getHourlyTokenBuckets":');
        const caseBlock = src.slice(start, start + 400);
        assertIncludes(caseBlock, 'parseRequiredDate(safeParams.since, "since")', "runtime must validate required since for getHourlyTokenBuckets");
    });

    it("has switch case for getFleetDbCallMetrics", () => {
        assertIncludes(src, 'case "getFleetDbCallMetrics":', "runtime missing getFleetDbCallMetrics switch case");
        const start = src.indexOf('case "getFleetDbCallMetrics":');
        const caseBlock = src.slice(start, start + 300);
        assertIncludes(caseBlock, 'parseOptionalDate(safeParams.since, "since")', "runtime must validate+convert since for getFleetDbCallMetrics");
        assertIncludes(caseBlock, "defaultSinceDays(", "runtime must default missing since window for getFleetDbCallMetrics");
        assertIncludes(caseBlock, "enforceMaxWindowDays(", "runtime must enforce max since window for getFleetDbCallMetrics");
    });

    it("has switch case for listSessionsPage with limit cap", () => {
        assertIncludes(src, 'case "listSessionsPage":', "runtime missing listSessionsPage switch case");
        const start = src.indexOf('case "listSessionsPage":');
        const caseBlock = src.slice(start, start + 300);
        assertIncludes(caseBlock, "clampLimit(safeParams.limit, 50, 200)", "runtime must clamp listSessionsPage limit");
        assertIncludes(caseBlock, "parseSessionPageCursor(safeParams.cursor)", "runtime must validate cursor shape");
    });

    it("has switch case for pruneTurnMetrics with required olderThan", () => {
        assertIncludes(src, 'case "pruneTurnMetrics":', "runtime missing pruneTurnMetrics switch case");
        const start = src.indexOf('case "pruneTurnMetrics":');
        const caseBlock = src.slice(start, start + 200);
        assertIncludes(caseBlock, 'parseRequiredDate(safeParams.olderThan, "olderThan")', "runtime must validate olderThan");
    });

    it("still throws for unknown methods", () => {
        assertIncludes(src, 'throw new Error(`Unsupported portal RPC method: ${method}`)', "runtime default case must still throw");
    });

    it("has switch case for getSessionEvents with limit cap", () => {
        assertIncludes(src, 'case "getSessionEvents":', "runtime missing getSessionEvents switch case");
        const start = src.indexOf('case "getSessionEvents":');
        const caseBlock = src.slice(start, start + 300);
        assertIncludes(caseBlock, "clampLimit(safeParams.limit, 200, 500)", "runtime must clamp getSessionEvents limit");
    });

    it("has switch case for getSessionEventsBefore with limit cap", () => {
        assertIncludes(src, 'case "getSessionEventsBefore":', "runtime missing getSessionEventsBefore switch case");
        const start = src.indexOf('case "getSessionEventsBefore":');
        const caseBlock = src.slice(start, start + 300);
        assertIncludes(caseBlock, "clampLimit(safeParams.limit, 200, 500)", "runtime must clamp getSessionEventsBefore limit");
    });

    it("has switch case for getTopEventEmitters with required since and limit cap", () => {
        assertIncludes(src, 'case "getTopEventEmitters":', "runtime missing getTopEventEmitters switch case");
        const start = src.indexOf('case "getTopEventEmitters":');
        const caseBlock = src.slice(start, start + 300);
        assertIncludes(caseBlock, 'parseRequiredDate(safeParams.since, "since")', "runtime must require since for getTopEventEmitters");
        assertIncludes(caseBlock, "enforceMaxWindowDays(", "runtime must enforce max window for getTopEventEmitters");
        assertIncludes(caseBlock, "clampLimit(safeParams.limit, 20, 100)", "runtime must clamp getTopEventEmitters limit");
    });
});

// ─── Layer 2: runtime.js — behavioral routing tests ──────────────

describe("PortalRuntime.call — behavioral routing for Phase 2 methods", () => {
    async function makeRuntime() {
        vi.resetModules();
        const calls = [];
        class MockNodeSdkTransport {
            constructor() {}
            async start() {}
            async getSessionTurnMetrics(sessionId, opts) {
                calls.push({ method: "getSessionTurnMetrics", sessionId, opts });
                return [{ ok: true }];
            }
            async getFleetTurnAnalytics(opts) {
                calls.push({ method: "getFleetTurnAnalytics", opts });
                return [{ ok: true }];
            }
            async getHourlyTokenBuckets(since, opts) {
                calls.push({ method: "getHourlyTokenBuckets", since, opts });
                return [{ ok: true }];
            }
            async getFleetDbCallMetrics(opts) {
                calls.push({ method: "getFleetDbCallMetrics", opts });
                return [{ ok: true }];
            }
            async listSessionsPage(params) {
                calls.push({ method: "listSessionsPage", params });
                return { items: [], hasMore: false };
            }
            async pruneTurnMetrics(olderThan) {
                calls.push({ method: "pruneTurnMetrics", olderThan });
                return 1;
            }
        }

        vi.doMock("pilotswarm-cli/portal", () => ({ NodeSdkTransport: MockNodeSdkTransport }));
        const { PortalRuntime } = await import("../../../../packages/portal/runtime.js");
        const runtime = new PortalRuntime({ store: {}, mode: "test" });
        return { runtime, calls };
    }

    it("routes getHourlyTokenBuckets with validated Date conversion", async () => {
        const { runtime, calls } = await makeRuntime();
        await runtime.call("getHourlyTokenBuckets", { since: "2026-04-26T00:00:00.000Z", agentId: "a1", model: "m1" });
        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe("getHourlyTokenBuckets");
        expect(calls[0].since).toBeInstanceOf(Date);
        expect(calls[0].since.toISOString()).toBe("2026-04-26T00:00:00.000Z");
        expect(calls[0].opts).toEqual({ agentId: "a1", model: "m1" });
    });

    it("rejects invalid getHourlyTokenBuckets.since with clear error", async () => {
        const { runtime } = await makeRuntime();
        await expect(runtime.call("getHourlyTokenBuckets", { since: "not-a-date" }))
            .rejects
            .toThrow('Invalid RPC parameter "since"');
    });

    it("rejects missing pruneTurnMetrics.olderThan with clear error", async () => {
        const { runtime } = await makeRuntime();
        await expect(runtime.call("pruneTurnMetrics", {}))
            .rejects
            .toThrow('Invalid RPC parameter "olderThan"');
    });

    it("routes optional since fields with 30-day default when omitted", async () => {
        const { runtime, calls } = await makeRuntime();
        await runtime.call("getFleetTurnAnalytics", {});
        expect(calls[0].method).toBe("getFleetTurnAnalytics");
        expect(calls[0].opts.since).toBeInstanceOf(Date);
    });

    it("routes listSessionsPage with clamped limit", async () => {
        const { runtime, calls } = await makeRuntime();
        await runtime.call("listSessionsPage", { limit: 9999 });
        expect(calls[0].method).toBe("listSessionsPage");
        expect(calls[0].params.limit).toBe(200);
    });
});

// ─── Layer 3: browser-transport.js — file contracts ──────────────

describe("browser-transport.js — Phase 2 method signatures and RPC names", () => {
    const src = readRepoFile("packages/portal/src/browser-transport.js");

    it("has listSessionsPage forwarding limit/cursor/includeDeleted", () => {
        assertIncludes(src, "async listSessionsPage(params = {})", "browser transport missing listSessionsPage");
        assertIncludes(src, 'this.rpc("listSessionsPage"', "browser transport must call rpc with listSessionsPage");
        assertIncludes(src, "limit: params?.limit", "browser transport must forward limit");
        assertIncludes(src, "includeDeleted: params?.includeDeleted", "browser transport must forward includeDeleted");
    });

    it("has getSessionTurnMetrics forwarding since/limit", () => {
        assertIncludes(src, "async getSessionTurnMetrics(sessionId, opts)", "browser transport missing getSessionTurnMetrics");
        assertIncludes(src, 'this.rpc("getSessionTurnMetrics"', "browser transport must call rpc with correct method name");
        assertIncludes(src, "opts?.since instanceof Date ? opts.since.toISOString() : opts?.since", "browser transport must serialize since to ISO");
        assertIncludes(src, "opts?.limit", "browser transport must forward limit");
    });

    it("has getFleetTurnAnalytics forwarding since/agentId/model", () => {
        assertIncludes(src, "async getFleetTurnAnalytics(opts)", "browser transport missing getFleetTurnAnalytics");
        assertIncludes(src, 'this.rpc("getFleetTurnAnalytics"', "browser transport must call rpc with correct method name");
        assertIncludes(src, "opts?.agentId", "browser transport must forward agentId");
        assertIncludes(src, "opts?.model", "browser transport must forward model");
    });

    it("has getHourlyTokenBuckets with positional since serialization", () => {
        assertIncludes(src, "async getHourlyTokenBuckets(since, opts)", "browser transport missing getHourlyTokenBuckets");
        assertIncludes(src, 'this.rpc("getHourlyTokenBuckets"', "browser transport must call rpc with correct method name");
        assertIncludes(src, "since instanceof Date ? since.toISOString() : since", "browser transport must serialize positional since");
    });

    it("has getFleetDbCallMetrics forwarding since", () => {
        assertIncludes(src, "async getFleetDbCallMetrics(opts)", "browser transport missing getFleetDbCallMetrics");
        assertIncludes(src, 'this.rpc("getFleetDbCallMetrics"', "browser transport must call rpc with correct method name");
    });

    it("has pruneTurnMetrics serializing olderThan", () => {
        assertIncludes(src, "async pruneTurnMetrics(olderThan)", "browser transport missing pruneTurnMetrics");
        assertIncludes(src, 'this.rpc("pruneTurnMetrics"', "browser transport must call rpc with correct method name");
        assertIncludes(src, "olderThan instanceof Date ? olderThan.toISOString() : olderThan", "browser transport must serialize olderThan to ISO");
    });

    it("has getTopEventEmitters with required since serialization and limit forwarding", () => {
        assertIncludes(src, "async getTopEventEmitters(params", "browser transport missing getTopEventEmitters");
        assertIncludes(src, 'this.rpc("getTopEventEmitters"', "browser transport must call rpc with correct method name");
        assertIncludes(src, "params.since instanceof Date ? params.since.toISOString() : params.since", "browser transport must serialize since to ISO");
        assertIncludes(src, "limit: params.limit", "browser transport must forward limit");
    });
});

// ─── Layer 3: browser-transport.js — functional payload tests ────

describe("BrowserPortalTransport — functional RPC payload shape", () => {
    // Import the class directly — we spy on rpc() so no fetch/WebSocket needed.
    async function makeTransport() {
        const { BrowserPortalTransport } = await import(
            "../../../../packages/portal/src/browser-transport.js"
        );
        const transport = new BrowserPortalTransport({
            getAccessToken: async () => null,
            onUnauthorized: () => {},
            onForbidden: () => {},
        });
        const rpcCalls = [];
        transport.rpc = async (method, params) => {
            rpcCalls.push({ method, params });
            return [];
        };
        return { transport, rpcCalls };
    }

    it("getSessionTurnMetrics serializes since Date to ISO string", async () => {
        const { transport, rpcCalls } = await makeTransport();
        const since = new Date("2026-04-01T00:00:00.000Z");
        await transport.getSessionTurnMetrics("sess-1", { since, limit: 25 });
        expect(rpcCalls).toHaveLength(1);
        expect(rpcCalls[0].method).toBe("getSessionTurnMetrics");
        expect(rpcCalls[0].params.sessionId).toBe("sess-1");
        expect(rpcCalls[0].params.since).toBe("2026-04-01T00:00:00.000Z");
        expect(rpcCalls[0].params.limit).toBe(25);
    });

    it("getSessionTurnMetrics passes undefined since when not provided", async () => {
        const { transport, rpcCalls } = await makeTransport();
        await transport.getSessionTurnMetrics("sess-2");
        expect(rpcCalls[0].params.since).toBeUndefined();
        expect(rpcCalls[0].params.limit).toBeUndefined();
    });

    it("getFleetTurnAnalytics serializes since and forwards agentId/model", async () => {
        const { transport, rpcCalls } = await makeTransport();
        const since = new Date("2026-04-10T00:00:00.000Z");
        await transport.getFleetTurnAnalytics({ since, agentId: "ag-1", model: "claude-sonnet-4-6" });
        const p = rpcCalls[0].params;
        expect(rpcCalls[0].method).toBe("getFleetTurnAnalytics");
        expect(p.since).toBe("2026-04-10T00:00:00.000Z");
        expect(p.agentId).toBe("ag-1");
        expect(p.model).toBe("claude-sonnet-4-6");
    });

    it("getFleetTurnAnalytics passes undefined fields when opts omitted", async () => {
        const { transport, rpcCalls } = await makeTransport();
        await transport.getFleetTurnAnalytics();
        const p = rpcCalls[0].params;
        expect(p.since).toBeUndefined();
        expect(p.agentId).toBeUndefined();
        expect(p.model).toBeUndefined();
    });

    it("getHourlyTokenBuckets serializes positional since Date", async () => {
        const { transport, rpcCalls } = await makeTransport();
        const since = new Date("2026-04-25T00:00:00.000Z");
        await transport.getHourlyTokenBuckets(since, { agentId: "ag-2" });
        const p = rpcCalls[0].params;
        expect(rpcCalls[0].method).toBe("getHourlyTokenBuckets");
        expect(p.since).toBe("2026-04-25T00:00:00.000Z");
        expect(p.agentId).toBe("ag-2");
        expect(p.model).toBeUndefined();
    });

    it("getFleetDbCallMetrics serializes since Date", async () => {
        const { transport, rpcCalls } = await makeTransport();
        const since = new Date("2026-04-26T00:00:00.000Z");
        await transport.getFleetDbCallMetrics({ since });
        expect(rpcCalls[0].method).toBe("getFleetDbCallMetrics");
        expect(rpcCalls[0].params.since).toBe("2026-04-26T00:00:00.000Z");
    });

    it("getFleetDbCallMetrics passes undefined since when opts omitted", async () => {
        const { transport, rpcCalls } = await makeTransport();
        await transport.getFleetDbCallMetrics();
        expect(rpcCalls[0].params.since).toBeUndefined();
    });

    it("pruneTurnMetrics serializes olderThan Date to ISO string", async () => {
        const { transport, rpcCalls } = await makeTransport();
        const olderThan = new Date("2026-01-01T00:00:00.000Z");
        await transport.pruneTurnMetrics(olderThan);
        expect(rpcCalls[0].method).toBe("pruneTurnMetrics");
        expect(rpcCalls[0].params.olderThan).toBe("2026-01-01T00:00:00.000Z");
    });

    it("all five original methods use the exact RPC method names matching runtime switch cases", async () => {
        const { transport, rpcCalls } = await makeTransport();
        const d = new Date("2026-04-01T00:00:00.000Z");
        await transport.getSessionTurnMetrics("s");
        await transport.getFleetTurnAnalytics();
        await transport.getHourlyTokenBuckets(d);
        await transport.getFleetDbCallMetrics();
        await transport.pruneTurnMetrics(d);
        const names = rpcCalls.map((c) => c.method);
        expect(names).toEqual([
            "getSessionTurnMetrics",
            "getFleetTurnAnalytics",
            "getHourlyTokenBuckets",
            "getFleetDbCallMetrics",
            "pruneTurnMetrics",
        ]);
    });

    it("getTopEventEmitters serializes since Date to ISO and forwards limit", async () => {
        const { transport, rpcCalls } = await makeTransport();
        const since = new Date("2026-04-25T00:00:00.000Z");
        await transport.getTopEventEmitters({ since, limit: 50 });
        expect(rpcCalls).toHaveLength(1);
        expect(rpcCalls[0].method).toBe("getTopEventEmitters");
        expect(rpcCalls[0].params.since).toBe("2026-04-25T00:00:00.000Z");
        expect(rpcCalls[0].params.limit).toBe(50);
    });

    it("getTopEventEmitters passes undefined limit when not provided", async () => {
        const { transport, rpcCalls } = await makeTransport();
        const since = new Date("2026-04-28T00:00:00.000Z");
        await transport.getTopEventEmitters({ since });
        expect(rpcCalls[0].params.limit).toBeUndefined();
        expect(rpcCalls[0].params.since).toBe("2026-04-28T00:00:00.000Z");
    });
});

// ─── Cross-layer alignment check ─────────────────────────────────

describe("cross-layer method name alignment", () => {
    it("all Phase 2 RPC names appear in all three layers", () => {
        const runtime          = readRepoFile("packages/portal/runtime.js");
        const nodeTransport    = readRepoFile("packages/cli/src/node-sdk-transport.js");
        const browserTransport = readRepoFile("packages/portal/src/browser-transport.js");

        const methods = [
            "listSessionsPage",
            "getSessionEvents",
            "getSessionEventsBefore",
            "getSessionTurnMetrics",
            "getFleetTurnAnalytics",
            "getHourlyTokenBuckets",
            "getFleetDbCallMetrics",
            "getTopEventEmitters",
            "pruneTurnMetrics",
        ];

        for (const m of methods) {
            assertIncludes(runtime, `case "${m}":`, `runtime.js missing switch case for ${m}`);
            assertIncludes(nodeTransport, `async ${m}(`, `node-sdk-transport.js missing method ${m}`);
            assertIncludes(browserTransport, `async ${m}(`, `browser-transport.js missing method ${m}`);
        }
    });
});
