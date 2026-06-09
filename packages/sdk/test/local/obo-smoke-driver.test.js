/**
 * Phase 7 — smoke driver orchestrator (SC-017).
 *
 * Drives `runDriver` end-to-end through five injected dependency
 * doubles (no network, no MSAL, no kubectl). Three sub-tests:
 *
 *   1. Pass path: stamp env satisfies preflight, fake portal RPC
 *      returns the expected tool outcomes — driver returns a pass
 *      record with the canonical step shape.
 *
 *   2. OBO_SMOKE_ENABLED=false: driver fails fast at preflight with
 *      reasonCode 'smoke_tools_not_registered', exit code 2.
 *
 *   3. OBO_ENABLED=false: driver fails fast at preflight with
 *      reasonCode 'obo_disabled_on_stamp', exit code 2.
 */

import { describe, it, expect } from "vitest";
import { runDriver } from "../../../cli/src/smoke/driver.js";
import oboProfile from "../../../cli/src/smoke/profiles/obo.js";

function passingStampEnv(overrides = {}) {
    return {
        OBO_SMOKE_ENABLED: "true",
        OBO_ENABLED: "true",
        PORTAL_AUTH_ENTRA_TENANT_ID: "test-tenant",
        PORTAL_AUTH_ENTRA_CLIENT_ID: "test-portal-client",
        PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE: "api://test-worker-app/.default",
        PORTAL_BASE_URL: "https://portal.smoke.example",
        K8S_CONTEXT: "smoke-ctx",
        K8S_NAMESPACE: "smoke-ns",
        WORKER_DEPLOYMENT_NAME: "pilotswarm-worker",
        ...overrides,
    };
}

function makeFakePortalRpc({ events, sessionId = "smoke-session-1", health = { ok: true } }) {
    const calls = [];
    let polledTimes = 0;
    return {
        rpc: async (method, params) => {
            calls.push({ method, params });
            if (method === "createSession") return { id: sessionId };
            if (method === "sendMessage") return { ok: true };
            if (method === "listSessionEvents") {
                polledTimes += 1;
                return { events };
            }
            if (method === "cancelSession") return { ok: true };
            throw new Error(`unexpected RPC method: ${method}`);
        },
        health: async () => health,
        baseUrl: "https://portal.smoke.example",
        _calls: calls,
        get _polledTimes() { return polledTimes; },
    };
}

const PASS_EVENTS = [
    {
        type: "tool.execution_complete",
        cursor: 1,
        data: {
            tool_name: "obo_smoke_whoami",
            outcome: "success",
            result: {
                mode: "obo_ok",
                backend: "fic",
                principal: { email: "tester@example.com" },
                graph: { upn: "tester@example.com", objectId: "guid-1" },
            },
        },
    },
    {
        type: "tool.execution_complete",
        cursor: 2,
        data: {
            tool_name: "obo_smoke_force_reauth",
            outcome: "interaction_required",
            outcome_payload: { reasonCode: "reauth_required" },
        },
    },
];

function buildDeps({ stampEnv, portalRpc }) {
    return {
        loadStampEnv: () => ({ env: stampEnv }),
        httpFetch: async () => { throw new Error("httpFetch should not be called when portalRpc is mocked"); },
        runKubectl: () => ({
            stdout: JSON.stringify({ status: { readyReplicas: 1, replicas: 1 } }),
            stderr: "",
            status: 0,
        }),
        acquireKubeContext: () => ({ kubeconfigPath: "/tmp/kubeconfig" }),
        acquireUserAccessTokens: async () => ({
            admissionToken: "admission-jwt",
            downstreamToken: "downstream-jwt",
            downstreamExpiresAt: Date.now() + 60_000,
        }),
        createPortalRpcClient: () => portalRpc,
        log: () => {},
        now: () => "2026-06-09T00:00:00.000Z",
    };
}

describe("Phase 7 — smoke driver pass path (SC-017)", () => {
    it("returns pass: true with whoami + force-reauth + cleanup steps", async () => {
        const stampEnv = passingStampEnv();
        const portalRpc = makeFakePortalRpc({ events: PASS_EVENTS });
        const deps = buildDeps({ stampEnv, portalRpc });

        const result = await runDriver(
            { stamp: "smoketest", profile: "obo", profileImpl: oboProfile, authMode: "from-env" },
            deps,
        );

        expect(result.pass).toBe(true);
        expect(result.profile).toBe("obo");
        expect(result.stamp).toBe("smoketest");
        expect(result.timestamp).toBe("2026-06-09T00:00:00.000Z");
        const stepNames = result.steps.map((s) => s.name);
        expect(stepNames).toEqual(expect.arrayContaining([
            "portal-health",
            "worker-ready",
            "session-create",
            "whoami",
            "force-reauth",
            "cleanup",
        ]));
        for (const step of result.steps) {
            expect(step.ok).toBe(true);
        }
        expect(result.result?.whoami?.mode).toBe("obo_ok");
        expect(result.result?.forceReauth?.reasonCode).toBe("reauth_required");
        // Verify the portal RPC saw a sane call sequence:
        const methods = portalRpc._calls.map((c) => c.method);
        expect(methods).toContain("createSession");
        expect(methods).toContain("sendMessage");
        expect(methods).toContain("listSessionEvents");
    });
});

describe("Phase 7 — smoke driver fails fast at preflight (SC-017)", () => {
    it("OBO_SMOKE_ENABLED=false → smoke_tools_not_registered, exitCode=2", async () => {
        const stampEnv = passingStampEnv({ OBO_SMOKE_ENABLED: "false" });
        const portalRpc = makeFakePortalRpc({ events: [] });
        const deps = buildDeps({ stampEnv, portalRpc });

        const result = await runDriver(
            { stamp: "smoketest", profile: "obo", profileImpl: oboProfile, authMode: "from-env" },
            deps,
        );

        expect(result.pass).toBe(false);
        expect(result.reasonCode).toBe("smoke_tools_not_registered");
        expect(result.failedStep).toBe("preflight-obo-smoke-enabled");
        expect(result.exitCode).toBe(2);
        // Critical: no profile steps ran.
        expect(result.steps).toBeUndefined();
        // No RPCs were issued.
        expect(portalRpc._calls).toHaveLength(0);
    });

    it("OBO_ENABLED=false → obo_disabled_on_stamp, exitCode=2", async () => {
        const stampEnv = passingStampEnv({ OBO_ENABLED: "false" });
        const portalRpc = makeFakePortalRpc({ events: [] });
        const deps = buildDeps({ stampEnv, portalRpc });

        const result = await runDriver(
            { stamp: "smoketest", profile: "obo", profileImpl: oboProfile, authMode: "from-env" },
            deps,
        );

        expect(result.pass).toBe(false);
        expect(result.reasonCode).toBe("obo_disabled_on_stamp");
        expect(result.failedStep).toBe("preflight-obo-enabled");
        expect(result.exitCode).toBe(2);
        expect(portalRpc._calls).toHaveLength(0);
    });

    it("PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE unset → downstream_scope_unset, exitCode=2", async () => {
        const stampEnv = passingStampEnv({ PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE: "__PS_UNSET__" });
        const portalRpc = makeFakePortalRpc({ events: [] });
        const deps = buildDeps({ stampEnv, portalRpc });

        const result = await runDriver(
            { stamp: "smoketest", profile: "obo", profileImpl: oboProfile, authMode: "from-env" },
            deps,
        );

        expect(result.pass).toBe(false);
        expect(result.reasonCode).toBe("downstream_scope_unset");
        expect(result.exitCode).toBe(2);
    });
});

describe("Phase 7 — smoke driver kube bootstrap (FR-027)", () => {
    it("invokes acquireKubeContext when stamp env has RESOURCE_GROUP + AKS_CLUSTER_NAME", async () => {
        const stampEnv = passingStampEnv({
            RESOURCE_GROUP: "rg-smoke",
            AKS_CLUSTER_NAME: "aks-smoke",
            SUBSCRIPTION_ID: "sub-1",
        });
        const portalRpc = makeFakePortalRpc({ events: PASS_EVENTS });
        const calls = [];
        const deps = buildDeps({ stampEnv, portalRpc });
        deps.acquireKubeContext = (args) => {
            calls.push(args);
            return { kubeconfigPath: args.kubeconfigPath };
        };

        const result = await runDriver(
            { stamp: "smoketest", profile: "obo", profileImpl: oboProfile, authMode: "from-env" },
            deps,
        );

        expect(result.pass).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0].resourceGroup).toBe("rg-smoke");
        expect(calls[0].cluster).toBe("aks-smoke");
        expect(calls[0].subscription).toBe("sub-1");
    });

    it("skips acquireKubeContext when --skip-kube-bootstrap is set", async () => {
        const stampEnv = passingStampEnv({
            RESOURCE_GROUP: "rg-smoke",
            AKS_CLUSTER_NAME: "aks-smoke",
        });
        const portalRpc = makeFakePortalRpc({ events: PASS_EVENTS });
        const calls = [];
        const deps = buildDeps({ stampEnv, portalRpc });
        deps.acquireKubeContext = (args) => {
            calls.push(args);
            return { kubeconfigPath: args.kubeconfigPath };
        };

        const result = await runDriver(
            { stamp: "smoketest", profile: "obo", profileImpl: oboProfile, authMode: "from-env", skipKubeBootstrap: true },
            deps,
        );

        expect(result.pass).toBe(true);
        expect(calls).toHaveLength(0);
    });

    it("returns kube_bootstrap_failed (exitCode 2) when acquireKubeContext throws", async () => {
        const stampEnv = passingStampEnv({
            RESOURCE_GROUP: "rg-smoke",
            AKS_CLUSTER_NAME: "aks-smoke",
        });
        const portalRpc = makeFakePortalRpc({ events: [] });
        const deps = buildDeps({ stampEnv, portalRpc });
        deps.acquireKubeContext = () => { throw new Error("az aks get-credentials failed: AAD denied"); };

        const result = await runDriver(
            { stamp: "smoketest", profile: "obo", profileImpl: oboProfile, authMode: "from-env" },
            deps,
        );

        expect(result.pass).toBe(false);
        expect(result.reasonCode).toBe("kube_bootstrap_failed");
        expect(result.failedStep).toBe("preflight-kube-bootstrap");
        expect(result.exitCode).toBe(2);
        expect(portalRpc._calls).toHaveLength(0);
    });
});

describe("Phase 7 — smoke driver fails when whoami returns wrong mode", () => {
    it("returns pass: false with reasonCode whoami_<mode> when mode != obo_ok", async () => {
        const stampEnv = passingStampEnv();
        const events = [
            {
                type: "tool.execution_complete",
                cursor: 1,
                data: {
                    tool_name: "obo_smoke_whoami",
                    outcome: "success",
                    result: { mode: "principal_only", reason: "no token" },
                },
            },
        ];
        const portalRpc = makeFakePortalRpc({ events });
        const deps = buildDeps({ stampEnv, portalRpc });

        const result = await runDriver(
            { stamp: "smoketest", profile: "obo", profileImpl: oboProfile, authMode: "from-env" },
            deps,
        );

        expect(result.pass).toBe(false);
        expect(result.failedStep).toBe("whoami");
        expect(result.reasonCode).toBe("whoami_principal_only");
    });
});
