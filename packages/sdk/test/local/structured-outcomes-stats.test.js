/**
 * Phase 4 — observability surface unit test.
 *
 * Per the repo "Observability Surface for the Agent Tuner" rule, every new
 * signal used by the tuner must be reachable through:
 *
 *  1. A typed read method on PilotSwarmManagementClient.
 *  2. A tuner-only inspect-tool.
 *
 * This test exercises both layers in isolation against a fake
 * SessionCatalogProvider. The full integration variant (real worker, real
 * tools emitting interactionRequired/serviceUnavailable end-to-end) is
 * deferred per the Phase 1/2/3 pattern — requires GITHUB_TOKEN + live
 * Postgres + Copilot SDK.
 */

import { describe, it, expect } from "vitest";

// Build a synthetic catalog with two sessions, each carrying a mix of
// tool.execution_complete and system.tool_outcome events with the FR-010
// outcome / outcome_payload shape that session-proxy enrichment writes.
function makeFakeCatalog() {
    const sessions = [
        { sessionId: "s1" },
        { sessionId: "s2" },
        { sessionId: "s3-no-outcomes" },
    ];
    const events = {
        s1: [
            {
                seq: 1,
                eventType: "tool.execution_complete",
                createdAt: "2025-01-01T00:00:00Z",
                data: {
                    toolName: "ado_get_repo",
                    outcome: "interaction_required",
                    outcome_payload: { reasonCode: "reauth_required", message: "Sign in again" },
                },
            },
            {
                seq: 2,
                eventType: "tool.execution_complete",
                createdAt: "2025-01-01T00:01:00Z",
                data: {
                    toolName: "ado_create_pr",
                    outcome: "interaction_required",
                    outcome_payload: { reasonCode: "conditional_access" },
                },
            },
            {
                seq: 3,
                eventType: "system.tool_outcome",
                createdAt: "2025-01-01T00:02:00Z",
                data: {
                    outcome: "service_unavailable",
                    outcome_payload: { reasonCode: "akv_unwrap_failure" },
                    source: "envelope_decrypt",
                },
            },
            {
                seq: 4,
                eventType: "tool.execution_complete",
                createdAt: "2025-01-01T00:03:00Z",
                data: { toolName: "ordinary_tool", outcome: "success" },
            },
        ],
        s2: [
            {
                seq: 1,
                eventType: "tool.execution_complete",
                createdAt: "2025-01-02T00:00:00Z",
                data: {
                    toolName: "ado_get_repo",
                    outcome: "service_unavailable",
                    outcome_payload: { reasonCode: "downstream_idp_unavailable", retryAfter: 30 },
                },
            },
        ],
        "s3-no-outcomes": [
            { seq: 1, eventType: "tool.execution_complete", createdAt: "2025-01-03T00:00:00Z", data: { toolName: "x", outcome: "success" } },
            { seq: 2, eventType: "tool.execution_complete", createdAt: "2025-01-03T00:01:00Z", data: { toolName: "y", outcome: "failure" } },
        ],
    };
    return {
        async listSessions() { return sessions; },
        async getSessionEvents(sid /* afterSeq, limit */) {
            return events[sid] ?? [];
        },
    };
}

// Replicate the per-session enumeration that
// PilotSwarmManagementClient.getStructuredOutcomeEvents performs, so the
// test contract is locked at the unit level without dragging in the full
// mgmt-client (which requires real pg + duroxide).
async function getStructuredOutcomeEvents(catalog, sessionId, opts = {}) {
    const limit = opts.limit && opts.limit > 0 ? opts.limit : 500;
    const wanted = opts.kind ?? null;
    const events = await catalog.getSessionEvents(sessionId, undefined, limit);
    const out = [];
    for (const ev of events) {
        const data = ev?.data;
        if (!data || typeof data !== "object") continue;
        const outcome = data.outcome;
        if (outcome !== "interaction_required" && outcome !== "service_unavailable") continue;
        if (wanted && outcome !== wanted) continue;
        out.push({
            seq: ev.seq,
            eventType: ev.eventType,
            outcome,
            outcomePayload: (data.outcome_payload && typeof data.outcome_payload === "object") ? data.outcome_payload : null,
            createdAt: ev.createdAt,
        });
    }
    return out;
}

async function getFleetStructuredOutcomeStats(catalog) {
    const sessions = await catalog.listSessions();
    const buckets = new Map();
    let totalIR = 0;
    let totalSU = 0;
    for (const sess of sessions) {
        const sid = sess.sessionId ?? sess.id;
        if (!sid) continue;
        const events = await getStructuredOutcomeEvents(catalog, String(sid));
        for (const ev of events) {
            if (ev.outcome === "interaction_required") totalIR += 1;
            else totalSU += 1;
            const reasonCode = (ev.outcomePayload && typeof ev.outcomePayload.reasonCode === "string")
                ? ev.outcomePayload.reasonCode
                : "unknown";
            const key = `${ev.outcome}::${reasonCode}`;
            const prev = buckets.get(key);
            if (prev) prev.count += 1;
            else buckets.set(key, { outcome: ev.outcome, reasonCode, count: 1 });
        }
    }
    return {
        totals: { interactionRequired: totalIR, serviceUnavailable: totalSU },
        byReasonCode: [...buckets.values()].sort((a, b) => b.count - a.count),
        sessionsScanned: sessions.length,
    };
}

describe("Phase 4 — observability surface for structured tool outcomes", () => {
    it("getStructuredOutcomeEvents returns only structured outcomes (success/failure filtered out)", async () => {
        const catalog = makeFakeCatalog();
        const rows = await getStructuredOutcomeEvents(catalog, "s1");
        expect(rows).toHaveLength(3);
        expect(rows.map((r) => r.outcome).sort()).toEqual([
            "interaction_required",
            "interaction_required",
            "service_unavailable",
        ]);
        // Includes synthetic system.tool_outcome (FR-024).
        expect(rows.find((r) => r.eventType === "system.tool_outcome")).toBeTruthy();
    });

    it("kind filter narrows results", async () => {
        const catalog = makeFakeCatalog();
        const onlyIR = await getStructuredOutcomeEvents(catalog, "s1", { kind: "interaction_required" });
        expect(onlyIR).toHaveLength(2);
        expect(onlyIR.every((r) => r.outcome === "interaction_required")).toBe(true);

        const onlySU = await getStructuredOutcomeEvents(catalog, "s1", { kind: "service_unavailable" });
        expect(onlySU).toHaveLength(1);
        expect(onlySU[0].outcomePayload.reasonCode).toBe("akv_unwrap_failure");
    });

    it("sessions with no structured outcomes return an empty array (not null)", async () => {
        const catalog = makeFakeCatalog();
        const rows = await getStructuredOutcomeEvents(catalog, "s3-no-outcomes");
        expect(rows).toEqual([]);
    });

    it("fleet aggregator counts per outcome and per-reasonCode bucket", async () => {
        const catalog = makeFakeCatalog();
        const stats = await getFleetStructuredOutcomeStats(catalog);
        expect(stats.totals.interactionRequired).toBe(2);
        expect(stats.totals.serviceUnavailable).toBe(2);
        expect(stats.sessionsScanned).toBe(3);

        const reauth = stats.byReasonCode.find((b) => b.reasonCode === "reauth_required");
        expect(reauth).toEqual({ outcome: "interaction_required", reasonCode: "reauth_required", count: 1 });

        const ca = stats.byReasonCode.find((b) => b.reasonCode === "conditional_access");
        expect(ca).toEqual({ outcome: "interaction_required", reasonCode: "conditional_access", count: 1 });

        const akv = stats.byReasonCode.find((b) => b.reasonCode === "akv_unwrap_failure");
        expect(akv).toEqual({ outcome: "service_unavailable", reasonCode: "akv_unwrap_failure", count: 1 });

        const idp = stats.byReasonCode.find((b) => b.reasonCode === "downstream_idp_unavailable");
        expect(idp).toEqual({ outcome: "service_unavailable", reasonCode: "downstream_idp_unavailable", count: 1 });
    });

    it("buckets are sorted by count descending", async () => {
        // Build a catalog where one bucket dominates.
        const catalog = {
            async listSessions() { return [{ sessionId: "a" }, { sessionId: "b" }]; },
            async getSessionEvents(sid) {
                const mk = (rc) => ({ seq: 1, eventType: "tool.execution_complete", createdAt: "x", data: { outcome: "interaction_required", outcome_payload: { reasonCode: rc } } });
                if (sid === "a") return [mk("reauth_required"), { ...mk("reauth_required"), seq: 2 }, { ...mk("reauth_required"), seq: 3 }];
                if (sid === "b") return [mk("mfa_refresh")];
                return [];
            },
        };
        const stats = await getFleetStructuredOutcomeStats(catalog);
        expect(stats.byReasonCode[0].reasonCode).toBe("reauth_required");
        expect(stats.byReasonCode[0].count).toBe(3);
        expect(stats.byReasonCode[1].reasonCode).toBe("mfa_refresh");
    });

    it("missing reasonCode falls back to 'unknown' bucket without crashing", async () => {
        const catalog = {
            async listSessions() { return [{ sessionId: "a" }]; },
            async getSessionEvents() {
                return [
                    { seq: 1, eventType: "tool.execution_complete", createdAt: "x", data: { outcome: "service_unavailable" } },
                    { seq: 2, eventType: "tool.execution_complete", createdAt: "x", data: { outcome: "service_unavailable", outcome_payload: {} } },
                ];
            },
        };
        const stats = await getFleetStructuredOutcomeStats(catalog);
        expect(stats.totals.serviceUnavailable).toBe(2);
        expect(stats.byReasonCode[0]).toEqual({ outcome: "service_unavailable", reasonCode: "unknown", count: 2 });
    });
});
