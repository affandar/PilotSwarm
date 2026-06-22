// FR-027: the OBO smoke profile.
//
// Exercises the deployed stamp end-to-end:
//   1. portal-health     — GET /api/health returns ok=true
//   2. worker-ready      — kubectl reports the worker deployment is ready
//   3. session-create    — drives /api/rpc createSession
//   4. whoami            — sends "Run obo_smoke_whoami"; asserts mode=obo_ok
//   5. force-reauth      — sends "Run obo_smoke_force_reauth"; asserts the
//                          tool outcome is interaction_required
//   6. cleanup           — best-effort cancel of the smoke session
//
// All calls flow through the stamp's real /api/rpc surface, so a
// successful run proves the full path: portal MSAL → envelope-encrypt
// → durable queue → worker decrypt → user-context store → tool
// handler.

const PROFILE_NAME = "obo";

async function pollForToolOutcome({ portalRpc, sessionId, expectedToolName, log, timeoutMs = 120_000 }) {
    const deadline = Date.now() + timeoutMs;
    let cursor = 0;
    while (Date.now() < deadline) {
        const events = await portalRpc.rpc("listSessionEvents", { sessionId, cursor, limit: 200 });
        const list = Array.isArray(events?.events) ? events.events : (Array.isArray(events) ? events : []);
        for (const ev of list) {
            cursor = Math.max(cursor, ev?.cursor ?? cursor);
            if (ev?.type === "tool.execution_complete" && ev?.data?.tool_name === expectedToolName) {
                return ev;
            }
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`timed out waiting for ${expectedToolName} tool outcome on session ${sessionId}`);
}

async function run({ ctx, step }) {
    const { portalRpc, log } = ctx;

    await step("portal-health", async () => {
        const health = await portalRpc.health();
        if (!health || health.ok !== true) {
            const err = new Error(`portal health returned ${JSON.stringify(health)}`);
            err.reasonCode = "portal_health_failed";
            throw err;
        }
        return { ok: true };
    });

    await step("worker-ready", async () => {
        if (!ctx.kubeContext) {
            return { skipped: true, reason: "no K8S_CONTEXT in stamp env; relying on whoami success as implicit readiness signal" };
        }
        const deployment = ctx.stampEnv.WORKER_DEPLOYMENT_NAME ?? "pilotswarm-worker";
        const out = ctx.runKubectl(
            ["get", "deployment", deployment, "-o", "json"],
            { context: ctx.kubeContext, namespace: ctx.namespace },
        );
        if (out.status !== 0) {
            const err = new Error(`kubectl get deployment ${deployment} failed: ${out.stderr.trim()}`);
            err.reasonCode = "worker_not_found";
            throw err;
        }
        let parsed;
        try {
            parsed = JSON.parse(out.stdout);
        } catch (e) {
            const err = new Error(`kubectl returned non-JSON for deployment ${deployment}`);
            err.reasonCode = "worker_inspect_failed";
            throw err;
        }
        const ready = parsed?.status?.readyReplicas ?? 0;
        const total = parsed?.status?.replicas ?? 0;
        if (!(total > 0 && ready === total)) {
            const err = new Error(`worker deployment '${deployment}' not fully ready: ${ready}/${total}`);
            err.reasonCode = "worker_not_ready";
            throw err;
        }
        return { deployment, ready, total };
    });

    const sessionId = await step("session-create", async () => {
        const session = await portalRpc.rpc("createSession", {
            title: `obo-smoke ${ctx.stamp} ${ctx.timestamp ?? new Date().toISOString()}`,
        });
        const id = session?.id ?? session?.sessionId ?? session?.session?.id;
        if (typeof id !== "string" || id.length === 0) {
            const err = new Error(`createSession returned no usable session id: ${JSON.stringify(session)}`);
            err.reasonCode = "session_create_failed";
            throw err;
        }
        return id;
    });

    let cleanupPending = true;
    try {
        const whoamiOutcome = await step("whoami", async () => {
            await portalRpc.rpc("sendMessage", {
                sessionId,
                content: "Please run the obo_smoke_whoami tool and return its result.",
            });
            const ev = await pollForToolOutcome({
                portalRpc, sessionId,
                expectedToolName: "obo_smoke_whoami",
                log,
            });
            const result = ev?.data?.result ?? ev?.data;
            const mode = result?.mode;
            if (mode !== "obo_ok") {
                const err = new Error(`obo_smoke_whoami returned mode=${mode} (expected obo_ok); reason=${result?.reason ?? "(none)"}`);
                err.reasonCode = `whoami_${mode ?? "unknown"}`;
                throw err;
            }
            const expectedUpn = ctx.stampEnv.OBO_SMOKE_TEST_USER_UPN;
            if (typeof expectedUpn === "string" && expectedUpn.length > 0) {
                if (result?.graph?.upn !== expectedUpn) {
                    const err = new Error(`graph.upn mismatch: got ${result?.graph?.upn}, expected ${expectedUpn}`);
                    err.reasonCode = "whoami_upn_mismatch";
                    throw err;
                }
            }
            return {
                mode,
                backend: result?.backend ?? null,
                graphUpn: result?.graph?.upn ?? null,
                principalEmail: result?.principal?.email ?? null,
            };
        });

        const reauthOutcome = await step("force-reauth", async () => {
            await portalRpc.rpc("sendMessage", {
                sessionId,
                content: "Please run the obo_smoke_force_reauth tool and return its result.",
            });
            const ev = await pollForToolOutcome({
                portalRpc, sessionId,
                expectedToolName: "obo_smoke_force_reauth",
                log,
            });
            const outcome = ev?.data?.outcome ?? ev?.data?.result?.__pilotswarmToolOutcome?.kind;
            if (outcome !== "interaction_required") {
                const err = new Error(`obo_smoke_force_reauth produced outcome=${outcome} (expected interaction_required)`);
                err.reasonCode = "force_reauth_outcome_mismatch";
                throw err;
            }
            const reasonCode = ev?.data?.outcome_payload?.reasonCode
                ?? ev?.data?.result?.__pilotswarmToolOutcome?.payload?.reasonCode;
            if (reasonCode !== "reauth_required") {
                const err = new Error(`force-reauth reasonCode=${reasonCode} (expected reauth_required)`);
                err.reasonCode = "force_reauth_reason_mismatch";
                throw err;
            }
            return { outcome, reasonCode };
        });

        await step("cleanup", async () => {
            try {
                await portalRpc.rpc("cancelSession", { sessionId });
                cleanupPending = false;
                return { cancelled: true };
            } catch (err) {
                return { cancelled: false, error: err?.message ?? String(err) };
            }
        });

        return { sessionId, whoami: whoamiOutcome, forceReauth: reauthOutcome };
    } finally {
        if (cleanupPending) {
            try {
                await portalRpc.rpc("cancelSession", { sessionId });
            } catch {
                // best-effort
            }
        }
    }
}

const profile = { name: PROFILE_NAME, run };
export default profile;
