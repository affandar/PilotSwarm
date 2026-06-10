// FR-027: smoke driver orchestrator.
//
// Pure-ish function that loads a stamp's `.env`, validates
// preconditions, acquires a user access token, runs the named
// profile, and emits a structured pass/fail record. All side
// effects (filesystem reads, HTTP, kubectl, MSAL) flow through the
// `deps` object so the driver can be unit-tested with in-memory
// doubles per SC-017 / FR-027.

import { loadEnv } from "../../../../deploy/scripts/lib/common.mjs";
import { acquireUserAccessTokens as defaultAcquireUserAccessTokens } from "./auth.js";
import { createPortalRpcClient as defaultCreatePortalRpcClient } from "./portal-rpc.js";
import { runKubectl as defaultRunKubectl, acquireKubeContext as defaultAcquireKubeContext } from "./kube.js";

/**
 * Default driver dependency map. Tests substitute any subset of these
 * with in-memory doubles to drive the orchestrator deterministically
 * without touching the network, MSAL, or kubectl.
 */
export const DEFAULT_DRIVER_DEPS = {
    loadStampEnv: (stamp) => loadEnv(stamp),
    httpFetch: (...args) => fetch(...args),
    runKubectl: defaultRunKubectl,
    acquireKubeContext: defaultAcquireKubeContext,
    acquireUserAccessTokens: defaultAcquireUserAccessTokens,
    createPortalRpcClient: defaultCreatePortalRpcClient,
    log: (msg) => process.stderr.write(`[smoke] ${msg}\n`),
    now: () => new Date().toISOString(),
};

function nonSentinel(v) {
    if (typeof v !== "string") return false;
    const t = v.trim();
    if (t.length === 0) return false;
    if (t === "__PS_UNSET__") return false;
    return true;
}

function failRecord({ profile, stamp, timestamp, failedStep, reasonCode, message, details }) {
    // Preflight failures (failed before any user-token acquisition or
    // any RPC was attempted) exit with code 2 to distinguish them
    // from genuine smoke failures (exit code 1). Steps that ran but
    // failed downstream are returned by the runDriver catch block,
    // not this helper.
    return {
        pass: false,
        profile,
        stamp,
        timestamp,
        failedStep,
        reasonCode,
        message,
        details: details ?? null,
        exitCode: 2,
    };
}

/**
 * Run the named profile against the named stamp.
 *
 * `opts` shape: { stamp, profile, authMode, portalBaseUrl, profileImpl, json }
 */
export async function runDriver(opts, deps = DEFAULT_DRIVER_DEPS) {
    const timestamp = deps.now();
    const { stamp, profile, profileImpl } = opts;

    // 1. Load the stamp's .env so we know how to reach it.
    let stampEnv;
    try {
        const loaded = deps.loadStampEnv(stamp);
        stampEnv = loaded?.env ?? loaded;
    } catch (err) {
        return failRecord({
            profile, stamp, timestamp,
            failedStep: "load-stamp-env",
            reasonCode: "preflight",
            message: `failed to load stamp env: ${err?.message ?? err}`,
        });
    }

    // 2. Preflight: required keys for the OBO profile.
    if (!nonSentinel(stampEnv.OBO_SMOKE_ENABLED) || stampEnv.OBO_SMOKE_ENABLED !== "true") {
        return failRecord({
            profile, stamp, timestamp,
            failedStep: "preflight-obo-smoke-enabled",
            reasonCode: "smoke_tools_not_registered",
            message: `stamp '${stamp}' has OBO_SMOKE_ENABLED=${stampEnv.OBO_SMOKE_ENABLED ?? "(unset)"} — smoke tools won't be registered on the worker`,
        });
    }
    if (!nonSentinel(stampEnv.OBO_ENABLED) || stampEnv.OBO_ENABLED !== "true") {
        return failRecord({
            profile, stamp, timestamp,
            failedStep: "preflight-obo-enabled",
            reasonCode: "obo_disabled_on_stamp",
            message: `stamp '${stamp}' has OBO_ENABLED=${stampEnv.OBO_ENABLED ?? "(unset)"} — envelope-encrypted token path is disabled, smoke cannot exercise the full OBO flow`,
        });
    }
    if (!nonSentinel(stampEnv.PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE)) {
        return failRecord({
            profile, stamp, timestamp,
            failedStep: "preflight-downstream-scope",
            reasonCode: "downstream_scope_unset",
            message: `stamp '${stamp}' has no PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE configured — portal won't acquire an OBO token`,
        });
    }
    if (!nonSentinel(stampEnv.PORTAL_AUTH_ENTRA_TENANT_ID) || !nonSentinel(stampEnv.PORTAL_AUTH_ENTRA_CLIENT_ID)) {
        return failRecord({
            profile, stamp, timestamp,
            failedStep: "preflight-portal-entra",
            reasonCode: "portal_entra_unset",
            message: `stamp '${stamp}' is missing PORTAL_AUTH_ENTRA_{TENANT_ID,CLIENT_ID}`,
        });
    }

    // 3. Resolve portal base URL.
    const portalBaseUrl = opts.portalBaseUrl
        ?? stampEnv.PORTAL_BASE_URL
        ?? (stampEnv.PORTAL_DNS_LABEL ? `https://${stampEnv.PORTAL_DNS_LABEL}` : null);
    if (!portalBaseUrl) {
        return failRecord({
            profile, stamp, timestamp,
            failedStep: "preflight-portal-url",
            reasonCode: "portal_url_unresolvable",
            message: `cannot resolve portal base URL — pass --portal-base-url or set PORTAL_BASE_URL / PORTAL_DNS_LABEL`,
        });
    }

    // 3b. Optionally bootstrap kubeconfig for the stamp. Skipped when
    // the caller has already loaded credentials (CI / GitHub Actions
    // does this in an explicit `az aks get-credentials` step before
    // invoking the driver) or when `--skip-kube-bootstrap` is passed.
    // For local interactive runs (`pilotswarm smoke <stamp>`), the
    // stamp .env carries RESOURCE_GROUP + AKS_CLUSTER_NAME; we use
    // those to acquire credentials so the user doesn't have to prep
    // their kubeconfig manually before running the smoke driver.
    if (!opts.skipKubeBootstrap
        && stampEnv.RESOURCE_GROUP
        && stampEnv.AKS_CLUSTER_NAME) {
        try {
            deps.acquireKubeContext({
                subscription: stampEnv.SUBSCRIPTION_ID ?? null,
                resourceGroup: stampEnv.RESOURCE_GROUP,
                cluster: stampEnv.AKS_CLUSTER_NAME,
                kubeconfigPath: opts.kubeconfigPath ?? stampEnv.KUBECONFIG ?? `${process.env.HOME ?? process.env.USERPROFILE ?? "."}/.kube/config-${stamp}`,
            });
        } catch (err) {
            return failRecord({
                profile, stamp, timestamp,
                failedStep: "preflight-kube-bootstrap",
                reasonCode: "kube_bootstrap_failed",
                message: `failed to acquire kubeconfig for stamp '${stamp}': ${err?.message ?? err}`,
            });
        }
    }

    // 4. Acquire user access tokens (admission + downstream).
    let tokens;
    try {
        tokens = await deps.acquireUserAccessTokens({
            tenantId: stampEnv.PORTAL_AUTH_ENTRA_TENANT_ID,
            clientId: stampEnv.PORTAL_AUTH_ENTRA_CLIENT_ID,
            admissionScope: stampEnv.PORTAL_AUTH_ENTRA_ADMISSION_SCOPE
                ?? `${stampEnv.PORTAL_AUTH_ENTRA_CLIENT_ID}/.default`,
            downstreamScope: stampEnv.PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE,
            mode: opts.authMode ?? "device-code",
            authorityHost: stampEnv.AZURE_AUTHORITY_HOST ?? null,
        });
    } catch (err) {
        return failRecord({
            profile, stamp, timestamp,
            failedStep: "acquire-user-tokens",
            reasonCode: "auth_failed",
            message: `failed to acquire user access tokens: ${err?.message ?? err}`,
        });
    }

    // 5. Build the per-profile context and run.
    const portalRpc = deps.createPortalRpcClient({
        portalBaseUrl,
        admissionToken: tokens.admissionToken,
        downstreamToken: tokens.downstreamToken,
        downstreamExpiresAt: tokens.downstreamExpiresAt,
        httpFetch: deps.httpFetch,
    });

    const ctx = {
        stamp,
        stampEnv,
        portalBaseUrl,
        portalRpc,
        tokens,
        kubeContext: stampEnv.K8S_CONTEXT ?? null,
        namespace: stampEnv.K8S_NAMESPACE ?? "default",
        runKubectl: deps.runKubectl,
        log: deps.log,
        httpFetch: deps.httpFetch,
    };

    const steps = [];
    let failedStep = null;
    let stepError = null;
    try {
        const result = await profileImpl.run({
            ctx,
            step: async (name, fn) => {
                deps.log(`step: ${name}`);
                try {
                    const out = await fn();
                    steps.push({ name, ok: true, result: out ?? null });
                    return out;
                } catch (err) {
                    steps.push({ name, ok: false, error: err?.message ?? String(err) });
                    failedStep = name;
                    stepError = err;
                    throw err;
                }
            },
        });
        return {
            pass: true,
            profile,
            stamp,
            timestamp,
            steps,
            result: result ?? null,
        };
    } catch (err) {
        return {
            pass: false,
            profile,
            stamp,
            timestamp,
            failedStep: failedStep ?? "profile-error",
            reasonCode: stepError?.reasonCode ?? "step_failed",
            message: stepError?.message ?? err?.message ?? String(err),
            steps,
            exitCode: 1,
        };
    }
}
