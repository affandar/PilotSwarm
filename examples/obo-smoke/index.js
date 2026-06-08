/**
 * OBO Smoke Plugin — reference implementation of the
 * User OBO Propagation feature contract.
 *
 * This plugin exposes two tools that exercise the end-to-end OBO flow
 * without any external consumer being present. It is the release-gate
 * vehicle for the `pilotswarm-sdk` OBO surface (Spec FR-018):
 *
 *   - `obo_smoke_whoami` — proves the worker-side lookup
 *     (`getUserContextForSession`) returns the portal-bound principal
 *     (SC-001) and, when configured, that the worker can perform a real
 *     OBO exchange against Microsoft Graph (SC-007). When OBO env vars
 *     are unset, the tool degrades to a principal-only report — still
 *     proves SC-001 but skips the Graph call.
 *
 *   - `obo_smoke_force_reauth` — always emits `interactionRequired(...)`
 *     so a maintainer can manually verify the portal re-auth UX path
 *     and that the next worker-bound RPC observes the freshly-acquired
 *     downstream token (SC-008 / FR-011 / SC-006).
 *
 * Loadable test ensures the module imports cleanly and the registered
 * tools have the expected names + handler shape, regardless of whether
 * Entra/Graph credentials are present.
 *
 * # Smoke-plugin env namespace (Spec Phase-5 Changes Required)
 *
 * Worker-app credentials for the optional real-OBO path MUST be
 * namespaced `OBO_SMOKE_WORKER_APP_*` so they are physically distinct
 * from any production OBO env vars. They are read on a per-tool-call
 * basis (no module-load-time capture) so a contributor cannot
 * accidentally bake them into a non-smoke worker by importing this
 * module.
 *
 * Required for the real-OBO path (all four):
 *
 *   - `OBO_SMOKE_WORKER_APP_TENANT_ID`
 *   - `OBO_SMOKE_WORKER_APP_CLIENT_ID`
 *   - `OBO_SMOKE_WORKER_APP_CLIENT_SECRET`
 *   - `OBO_SMOKE_WORKER_APP_GRAPH_SCOPE`
 *     (e.g., `https://graph.microsoft.com/User.Read`)
 *
 * If ANY of these are missing the tool falls back to the
 * principal-only report and explicitly logs which env vars are
 * missing — never silently disables.
 *
 * @module
 */

import { defineTool, getUserContextForSession, interactionRequired } from "pilotswarm-sdk";

const REAL_OBO_ENV_KEYS = [
    "OBO_SMOKE_WORKER_APP_TENANT_ID",
    "OBO_SMOKE_WORKER_APP_CLIENT_ID",
    "OBO_SMOKE_WORKER_APP_CLIENT_SECRET",
    "OBO_SMOKE_WORKER_APP_GRAPH_SCOPE",
];

function readSmokeEnv(env) {
    const out = {};
    const missing = [];
    for (const key of REAL_OBO_ENV_KEYS) {
        const value = env[key];
        if (typeof value === "string" && value.trim().length > 0) {
            out[key] = value.trim();
        } else {
            missing.push(key);
        }
    }
    return { values: out, missing };
}

/**
 * Perform the OAuth 2.0 On-Behalf-Of exchange against Entra and call
 * Microsoft Graph `/me`. Uses confidential-client + client-secret
 * (local-developer variant per Phase 5; AKS workload-identity FIC is
 * out of scope for the smoke plugin per Spec FR-015 — that lives in
 * each downstream consumer's deploy stack).
 *
 * Returns `{ ok: true, upn, objectId }` on success, or
 * `{ ok: false, reason: string }` on any failure (token acquisition
 * error, Graph call non-2xx, malformed response).
 */
async function exchangeAndCallGraph({ tenantId, clientId, clientSecret, graphScope, userAccessToken }) {
    const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
    const tokenForm = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        client_id: clientId,
        client_secret: clientSecret,
        assertion: userAccessToken,
        scope: graphScope,
        requested_token_use: "on_behalf_of",
    });
    let tokenResponse;
    try {
        tokenResponse = await fetch(tokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: tokenForm.toString(),
        });
    } catch (err) {
        return { ok: false, reason: `token endpoint unreachable: ${err?.message ?? err}` };
    }
    if (!tokenResponse.ok) {
        const text = await tokenResponse.text().catch(() => "");
        return { ok: false, reason: `OBO exchange failed: ${tokenResponse.status} ${text.slice(0, 200)}` };
    }
    let tokenJson;
    try {
        tokenJson = await tokenResponse.json();
    } catch (err) {
        return { ok: false, reason: `OBO exchange returned non-JSON: ${err?.message ?? err}` };
    }
    const downstreamAccessToken = tokenJson?.access_token;
    if (typeof downstreamAccessToken !== "string" || downstreamAccessToken.length === 0) {
        return { ok: false, reason: "OBO exchange returned no access_token" };
    }

    let graphResponse;
    try {
        graphResponse = await fetch("https://graph.microsoft.com/v1.0/me", {
            headers: { Authorization: `Bearer ${downstreamAccessToken}` },
        });
    } catch (err) {
        return { ok: false, reason: `Graph unreachable: ${err?.message ?? err}` };
    }
    if (!graphResponse.ok) {
        const text = await graphResponse.text().catch(() => "");
        return { ok: false, reason: `Graph /me returned ${graphResponse.status}: ${text.slice(0, 200)}` };
    }
    let me;
    try {
        me = await graphResponse.json();
    } catch (err) {
        return { ok: false, reason: `Graph /me returned non-JSON: ${err?.message ?? err}` };
    }
    return {
        ok: true,
        upn: typeof me?.userPrincipalName === "string" ? me.userPrincipalName : null,
        objectId: typeof me?.id === "string" ? me.id : null,
    };
}

/**
 * Build the obo_smoke_whoami tool definition.
 *
 * The tool resolves the active session's user context via
 * `getUserContextForSession`. When all four `OBO_SMOKE_WORKER_APP_*`
 * env vars are present AND the lookup returns a non-null access
 * token, it performs a real OBO exchange and calls Graph `/me`. In
 * every other case it returns a structured principal-only report
 * with an explicit `mode` field so a maintainer running the smoke
 * checklist can see why the real-OBO path was skipped.
 */
function defineWhoamiTool() {
    return defineTool("obo_smoke_whoami", {
        description:
            "OBO smoke tool: returns the engineer's identity as resolved by the worker-side " +
            "lookup, optionally enriched with a Microsoft Graph /me lookup performed via " +
            "OAuth 2.0 On-Behalf-Of when smoke env vars are configured. Use this to verify " +
            "an end-to-end OBO sign-in works for a designated smoke tenant before publish.",
        parameters: {
            type: "object",
            properties: {},
        },
        handler: async (_args, ctx) => {
            const sessionId = ctx?.sessionId;
            if (typeof sessionId !== "string" || sessionId.length === 0) {
                return {
                    mode: "error",
                    error: "obo_smoke_whoami: missing sessionId on tool context",
                };
            }
            const userContext = getUserContextForSession(sessionId);
            if (!userContext) {
                return {
                    mode: "no_user_context",
                    sessionId,
                    message:
                        "No user context bound to this session. This is expected for system / " +
                        "orchestration-initiated sessions and for local-TUI hosts without a portal " +
                        "principal envelope.",
                };
            }

            const principalReport = {
                provider: userContext.provider,
                subject: userContext.subject,
                email: userContext.email,
                displayName: userContext.displayName,
                hasAccessToken: typeof userContext.accessToken === "string" && userContext.accessToken.length > 0,
                accessTokenExpiresAt: userContext.accessTokenExpiresAt,
            };

            const env = readSmokeEnv(process.env);
            if (env.missing.length > 0) {
                return {
                    mode: "principal_only",
                    reason: `OBO smoke env vars missing: ${env.missing.join(", ")} — set OBO_SMOKE_WORKER_APP_* to enable Graph round-trip`,
                    principal: principalReport,
                };
            }
            if (!principalReport.hasAccessToken) {
                return {
                    mode: "principal_only",
                    reason:
                        "User context is bound but accessToken is null — either no downstream scope " +
                        "configured at the portal, or envelope decrypt failed (look for system.tool_outcome).",
                    principal: principalReport,
                };
            }

            const exchange = await exchangeAndCallGraph({
                tenantId: env.values.OBO_SMOKE_WORKER_APP_TENANT_ID,
                clientId: env.values.OBO_SMOKE_WORKER_APP_CLIENT_ID,
                clientSecret: env.values.OBO_SMOKE_WORKER_APP_CLIENT_SECRET,
                graphScope: env.values.OBO_SMOKE_WORKER_APP_GRAPH_SCOPE,
                userAccessToken: userContext.accessToken,
            });
            if (!exchange.ok) {
                return {
                    mode: "obo_failed",
                    reason: exchange.reason,
                    principal: principalReport,
                };
            }
            return {
                mode: "obo_ok",
                principal: principalReport,
                graph: { upn: exchange.upn, objectId: exchange.objectId },
            };
        },
    });
}

/**
 * Build the obo_smoke_force_reauth tool definition.
 *
 * Always returns an `interaction_required` structured outcome so a
 * maintainer can verify the portal re-auth banner UX and confirm
 * that after re-auth the next worker-bound RPC observes the fresh
 * downstream token (SC-008 / FR-011 / SC-006). Has no side effects.
 */
function defineForceReauthTool() {
    return defineTool("obo_smoke_force_reauth", {
        description:
            "OBO smoke tool: always emits a structured interaction_required outcome with " +
            "reasonCode=reauth_required. Use this to verify the portal re-auth UX and that the " +
            "next worker-bound RPC observes the freshly-acquired downstream token after the user " +
            "re-authenticates. This tool has no side effects.",
        parameters: {
            type: "object",
            properties: {},
        },
        handler: async () => {
            return interactionRequired({
                reasonCode: "reauth_required",
                message: "Smoke tool: forcing re-auth path",
            });
        },
    });
}

/**
 * Build the array of OBO smoke tools.
 *
 * Exported as a function (not a pre-built array) so the env read at
 * tool-call time happens against the live process.env, never against
 * a captured snapshot from module import time.
 */
export function buildOboSmokeTools() {
    return [defineWhoamiTool(), defineForceReauthTool()];
}

/**
 * Convenience helper for callers that prefer to register the tools in
 * one line: `registerOboSmokeTools(worker)`. Equivalent to
 * `worker.registerTools(buildOboSmokeTools())`.
 */
export function registerOboSmokeTools(worker) {
    if (!worker || typeof worker.registerTools !== "function") {
        throw new Error("registerOboSmokeTools: worker.registerTools(...) is required");
    }
    worker.registerTools(buildOboSmokeTools());
}

export default buildOboSmokeTools;
