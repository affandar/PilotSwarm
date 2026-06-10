/**
 * OBO Smoke Plugin — reference implementation of the User OBO
 * Propagation feature contract.
 *
 * Two tools:
 *   - `obo_smoke_whoami` — proves the worker-side lookup
 *     (`getUserContextForSession`) returns the portal-bound principal
 *     (SC-001) and, when env-configured, that the worker can perform
 *     a real OBO exchange against Microsoft Graph (SC-007).
 *   - `obo_smoke_force_reauth` — always emits `interactionRequired(...)`
 *     so a maintainer can verify the portal re-auth UX path
 *     (SC-008 / FR-011 / SC-006).
 *
 * # Auth-backend selection (FR-025)
 *
 * The plugin auto-selects between two OBO backends at *handler-call*
 * time (never at module load):
 *
 *   - **FIC** (workload-identity Federated Identity Credential):
 *     selected when `AZURE_FEDERATED_TOKEN_FILE` is present. The
 *     production-shape path used by deployed AKS pods. Wins precedence
 *     when both backends are configured (FR-025); when both are present
 *     a single startup-style log line records that the secret was
 *     ignored.
 *
 *   - **client-secret**: selected when only the four
 *     `OBO_SMOKE_WORKER_APP_*` keys are set. The local-developer path.
 *
 *   - When neither set is satisfied, the handler returns a structured
 *     `serviceUnavailable({ reasonCode: "smoke_misconfigured" })`
 *     outcome. Module load itself never throws.
 *
 * Both backends route through `@azure/msal-node`'s
 * `ConfidentialClientApplication.acquireTokenOnBehalfOf` so the OBO
 * request shape matches the production-shape MSAL path consumers
 * (e.g., ExampleApp) actually use. The FIC `clientAssertion` callback
 * re-reads `AZURE_FEDERATED_TOKEN_FILE` on **every** acquisition (the
 * projected SA token rotates); caching the assertion in the CCA
 * config would silently break after rotation. SC-018 pins this.
 *
 * # Smoke-plugin env namespace
 *
 * Worker-app credentials for the local-developer path live under
 * `OBO_SMOKE_WORKER_APP_*` so they are physically distinct from any
 * production OBO env vars. They are read on a per-tool-call basis (no
 * module-load-time capture) so a contributor cannot accidentally bake
 * them into a non-smoke worker by importing this module.
 *
 *   - `OBO_SMOKE_WORKER_APP_TENANT_ID`         (both backends)
 *   - `OBO_SMOKE_WORKER_APP_CLIENT_ID`         (both backends)
 *   - `OBO_SMOKE_WORKER_APP_GRAPH_SCOPE`       (both backends)
 *   - `OBO_SMOKE_WORKER_APP_CLIENT_SECRET`     (client-secret backend)
 *   - `AZURE_FEDERATED_TOKEN_FILE`             (FIC backend; auto-set
 *                                               by the AKS workload-identity
 *                                               webhook)
 *   - `AZURE_AUTHORITY_HOST` (optional override; defaults to the
 *                             public cloud authority)
 *
 * @module
 */

import fs from "node:fs/promises";
import { defineTool, getUserContextForSession, interactionRequired, serviceUnavailable } from "pilotswarm-sdk";
import { ConfidentialClientApplication } from "@azure/msal-node";

const COMMON_ENV_KEYS = [
    "OBO_SMOKE_WORKER_APP_TENANT_ID",
    "OBO_SMOKE_WORKER_APP_CLIENT_ID",
    "OBO_SMOKE_WORKER_APP_GRAPH_SCOPE",
];

const SECRET_BACKEND_KEY = "OBO_SMOKE_WORKER_APP_CLIENT_SECRET";
const FIC_TOKEN_FILE_KEY = "AZURE_FEDERATED_TOKEN_FILE";

/**
 * Read the smoke-plugin env tuple from the live `env` map (always
 * `process.env` in production; injected for tests).
 *
 * Returns `{ values, backend, missing, secretIgnoredReason }` where:
 *   - `backend` is `"fic" | "client-secret" | null`
 *   - `missing` describes which keys are missing for each backend so
 *     the structured `serviceUnavailable` outcome can name them
 *   - `secretIgnoredReason` is set when both FIC and the secret are
 *     present (FIC wins; the secret is logged once as ignored)
 */
export function selectAuthBackend(env) {
    const common = {};
    const missingCommon = [];
    for (const key of COMMON_ENV_KEYS) {
        const v = env[key];
        if (typeof v === "string" && v.trim().length > 0) {
            common[key] = v.trim();
        } else {
            missingCommon.push(key);
        }
    }

    const ficTokenFile = (typeof env[FIC_TOKEN_FILE_KEY] === "string" && env[FIC_TOKEN_FILE_KEY].trim().length > 0)
        ? env[FIC_TOKEN_FILE_KEY].trim()
        : null;
    const clientSecret = (typeof env[SECRET_BACKEND_KEY] === "string" && env[SECRET_BACKEND_KEY].trim().length > 0)
        ? env[SECRET_BACKEND_KEY].trim()
        : null;

    // FIC wins precedence (FR-025): the production-shape path is always
    // preferred when its prerequisite is satisfied. The secret is
    // explicitly noted as ignored so an operator can see what
    // happened.
    if (ficTokenFile && missingCommon.length === 0) {
        return {
            backend: "fic",
            values: { ...common, [FIC_TOKEN_FILE_KEY]: ficTokenFile },
            missing: { fic: [], "client-secret": clientSecret ? [] : [SECRET_BACKEND_KEY] },
            secretIgnoredReason: clientSecret
                ? "AZURE_FEDERATED_TOKEN_FILE is set; OBO_SMOKE_WORKER_APP_CLIENT_SECRET ignored due to FIC precedence (FR-025)."
                : null,
        };
    }
    if (clientSecret && missingCommon.length === 0) {
        return {
            backend: "client-secret",
            values: { ...common, [SECRET_BACKEND_KEY]: clientSecret },
            missing: { fic: [FIC_TOKEN_FILE_KEY], "client-secret": [] },
            secretIgnoredReason: null,
        };
    }

    // Neither backend's prerequisites are satisfied. Return the full
    // missing-key map so the handler can name what's missing for each
    // backend.
    return {
        backend: null,
        values: common,
        missing: {
            fic: [...missingCommon, ...(ficTokenFile ? [] : [FIC_TOKEN_FILE_KEY])],
            "client-secret": [...missingCommon, ...(clientSecret ? [] : [SECRET_BACKEND_KEY])],
        },
        secretIgnoredReason: null,
    };
}

// One-shot startup-style log dedupe: emit the FIC-precedence message
// at most once per process per (tenant, client) tuple.
const _loggedSecretIgnored = new Set();
function logSecretIgnoredOnce(reason, tenantId, clientId) {
    if (!reason) return;
    const key = `${tenantId}::${clientId}`;
    if (_loggedSecretIgnored.has(key)) return;
    _loggedSecretIgnored.add(key);
    console.log(`[obo-smoke] ${reason}`);
}

// Per-(backend, tenant, clientId) CCA cache. The CCA itself is cheap
// to build but caches token state internally between acquisitions, so
// reusing one across calls keeps the OBO exchange fast.
const _ccaCache = new Map();

function authority(env, tenantId) {
    const host = (typeof env.AZURE_AUTHORITY_HOST === "string" && env.AZURE_AUTHORITY_HOST.trim().length > 0)
        ? env.AZURE_AUTHORITY_HOST.trim().replace(/\/+$/, "")
        : "https://login.microsoftonline.com";
    return `${host}/${tenantId}`;
}

/**
 * Construct (or look up) the confidential-client app for the given
 * backend. Public for unit-test injection.
 */
export function getCachedCca({ backend, tenantId, clientId, env }, { newCca = null } = {}) {
    const key = `${backend}::${tenantId}::${clientId}`;
    const cached = _ccaCache.get(key);
    if (cached) return cached;

    const auth = {
        clientId,
        authority: authority(env, tenantId),
    };
    if (backend === "client-secret") {
        auth.clientSecret = env[SECRET_BACKEND_KEY];
    } else if (backend === "fic") {
        // CRITICAL invariant: re-read AZURE_FEDERATED_TOKEN_FILE on
        // every acquisition. The projected SA token rotates on a
        // schedule; capturing its contents here would break after the
        // first rotation. SC-018(b) pins this.
        auth.clientAssertion = async () => {
            const tokenFile = env[FIC_TOKEN_FILE_KEY];
            if (typeof tokenFile !== "string" || tokenFile.trim().length === 0) {
                throw new Error("FIC backend: AZURE_FEDERATED_TOKEN_FILE missing at acquisition time");
            }
            const raw = await fs.readFile(tokenFile.trim(), "utf8");
            return raw.trim();
        };
    } else {
        throw new Error(`getCachedCca: unsupported backend ${backend}`);
    }

    const cca = (typeof newCca === "function")
        ? newCca({ auth })
        : new ConfidentialClientApplication({ auth });
    _ccaCache.set(key, cca);
    return cca;
}

// Test-only hook: clear caches between sub-tests.
export function _resetSmokePluginStateForTests() {
    _ccaCache.clear();
    _loggedSecretIgnored.clear();
}

/**
 * Perform OBO via MSAL CCA and call Microsoft Graph `/me`. Both
 * backends share this code path; the only difference is how the CCA
 * was constructed (above).
 */
async function exchangeAndCallGraph({
    backend,
    tenantId,
    clientId,
    graphScope,
    userAccessToken,
    env,
    deps,
}) {
    let cca;
    try {
        cca = getCachedCca({ backend, tenantId, clientId, env }, { newCca: deps?.newCca });
    } catch (err) {
        return { ok: false, reason: `MSAL CCA construction failed: ${err?.message ?? err}` };
    }

    let tokenResult;
    try {
        tokenResult = await cca.acquireTokenOnBehalfOf({
            oboAssertion: userAccessToken,
            scopes: [graphScope],
        });
    } catch (err) {
        return { ok: false, reason: `OBO exchange failed: ${err?.errorCode || err?.message || err}` };
    }
    const downstreamAccessToken = tokenResult?.accessToken;
    if (typeof downstreamAccessToken !== "string" || downstreamAccessToken.length === 0) {
        return { ok: false, reason: "OBO exchange returned no accessToken" };
    }

    const fetchImpl = deps?.fetch ?? fetch;
    let graphResponse;
    try {
        graphResponse = await fetchImpl("https://graph.microsoft.com/v1.0/me", {
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
 * `deps` is an optional injection seam used by tests:
 *   - `deps.env` — substitutes `process.env` for backend selection
 *   - `deps.newCca({ auth })` — substitutes the CCA constructor
 *   - `deps.fetch` — substitutes `fetch` for the Graph call
 */
function defineWhoamiTool(deps = {}) {
    return defineTool("obo_smoke_whoami", {
        description:
            "OBO smoke tool: returns the engineer's identity as resolved by the worker-side " +
            "lookup, optionally enriched with a Microsoft Graph /me lookup performed via " +
            "OAuth 2.0 On-Behalf-Of when smoke env vars are configured. Auto-selects between " +
            "client-secret and workload-identity FIC backends; FIC wins precedence when both are present.",
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
                provider: userContext.principal.provider,
                subject: userContext.principal.subject,
                email: userContext.principal.email,
                displayName: userContext.principal.displayName,
                hasAccessToken: typeof userContext.accessToken === "string" && userContext.accessToken.length > 0,
                accessTokenExpiresAt: userContext.accessTokenExpiresAt,
            };

            const env = deps.env ?? process.env;
            const selection = selectAuthBackend(env);
            if (selection.backend === null) {
                // Handler-time refusal as a structured outcome — matches
                // the Phase-4 outcome family, three-way distinguishable
                // from `interactionRequired` and generic failure.
                return serviceUnavailable({
                    reasonCode: "smoke_misconfigured",
                    message:
                        `OBO smoke env not configured for either backend. ` +
                        `For FIC: set { ${selection.missing.fic.join(", ")} }. ` +
                        `For client-secret: set { ${selection.missing["client-secret"].join(", ")} }.`,
                });
            }

            logSecretIgnoredOnce(
                selection.secretIgnoredReason,
                selection.values.OBO_SMOKE_WORKER_APP_TENANT_ID,
                selection.values.OBO_SMOKE_WORKER_APP_CLIENT_ID,
            );

            if (!principalReport.hasAccessToken) {
                return {
                    mode: "principal_only",
                    backend: selection.backend,
                    reason:
                        "User context is bound but accessToken is null — either no downstream scope " +
                        "configured at the portal, or envelope decrypt failed (look for system.tool_outcome).",
                    principal: principalReport,
                };
            }

            const exchange = await exchangeAndCallGraph({
                backend: selection.backend,
                tenantId: selection.values.OBO_SMOKE_WORKER_APP_TENANT_ID,
                clientId: selection.values.OBO_SMOKE_WORKER_APP_CLIENT_ID,
                graphScope: selection.values.OBO_SMOKE_WORKER_APP_GRAPH_SCOPE,
                userAccessToken: userContext.accessToken,
                env,
                deps,
            });
            if (!exchange.ok) {
                return {
                    mode: "obo_failed",
                    backend: selection.backend,
                    reason: exchange.reason,
                    principal: principalReport,
                };
            }
            return {
                mode: "obo_ok",
                backend: selection.backend,
                principal: principalReport,
                graph: { upn: exchange.upn, objectId: exchange.objectId },
            };
        },
    });
}

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
 * Build the array of OBO smoke tools. `deps` is forwarded to the
 * whoami tool for unit-test injection (env / fetch / CCA constructor
 * substitutions). Production callers use `buildOboSmokeTools()` with
 * no arguments.
 */
export function buildOboSmokeTools(deps = {}) {
    return [defineWhoamiTool(deps), defineForceReauthTool()];
}

export function registerOboSmokeTools(worker, deps = {}) {
    if (!worker || typeof worker.registerTools !== "function") {
        throw new Error("registerOboSmokeTools: worker.registerTools(...) is required");
    }
    worker.registerTools(buildOboSmokeTools(deps));
}

export default buildOboSmokeTools;
