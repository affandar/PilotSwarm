#!/usr/bin/env node
/**
 * Bounded single-turn session worker.
 *
 * Boots a REAL PilotSwarm worker (a duroxide Runtime) against the deployed
 * durable store, serves the ONE already-seeded turn for the target session
 * (SESSION_ID), confirms the response landed in the store, then stops and
 * exits. Bounded so a per-run invoker (e.g. an ADO pipeline job) completes on
 * its own.
 *
 * Substrate-agnostic: it talks only to the durable store and calls no
 * ADO/CI APIs. ADO is merely the current invoker — the one ADO-flavored input
 * is the optional BUILD_SOURCESDIRECTORY checkout dir (with the generic
 * PILOTSWARM_SESSION_WORKING_DIR override) used to root the session so the
 * Copilot CLI can discover the enlistment's `.github` skills/agents.
 *
 * The turn is seeded OUT OF BAND by the customer client (the local portal's
 * REST API). This process only provides the worker (the compute that claims
 * and runs the turn) and then asserts completion by reading the session's
 * latest response straight from the CMS — no orchestration id required.
 *
 * Scoping note: this worker is UNSCOPED (no tag filter yet — see TODO
 * ado-hybrid-tag-pin). It is safe ONLY when no other workers poll the store
 * (the AKS worker pool is empty / scaled to zero), making this the sole
 * consumer. Do NOT run this against a store with other active workers until
 * the tag-based pin lands.
 *
 * Env:
 *   DATABASE_URL          full store URL (overrides the PG* builder if set)
 *   PGHOST_FQDN, PGDB, PGUSER_ENTRA, PG_ENTRA_TOKEN, PGPORT
 *                          store creds (Entra token as libpq password) when
 *                          DATABASE_URL is not supplied
 *   PILOTSWARM_USE_MANAGED_IDENTITY, PILOTSWARM_DB_AAD_USER
 *                          use az-login / MI token minting instead of a
 *                          password URL (local dev); default off (agent uses
 *                          the PG_ENTRA_TOKEN password URL)
 *   SESSION_ID            the seeded session id to serve (required)
 *   LLM_ENDPOINT, LLM_PROVIDER_TYPE, COPILOT_MODEL, LLM_API_KEY, LLM_API_VERSION
 *                          model provider (auto-built from env by the SDK)
 *   WORKER_NODE_ID        worker identity (default: AGENT_NAME|POD_NAME|hostname)
 *   SERVE_TIMEOUT_MS      overall watchdog (default: 300000)
 *   SERVE_POLL_MS         completion poll interval (default: 3000)
 *
 * Exit codes: 0 = turn served (SERVE_OK); 1 = failure; 2 = watchdog.
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

function buildStoreUrl() {
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
    const host = process.env.PGHOST_FQDN;
    const database = process.env.PGDB || "postgres";
    const user = process.env.PGUSER_ENTRA;
    const token = process.env.PG_ENTRA_TOKEN;
    const port = Number.parseInt(process.env.PGPORT || "5432", 10);
    const missing = [];
    if (!host) missing.push("PGHOST_FQDN");
    if (!user) missing.push("PGUSER_ENTRA");
    if (!token) missing.push("PG_ENTRA_TOKEN");
    if (missing.length) throw new Error(`missing required env: ${missing.join(", ")} (or set DATABASE_URL)`);
    return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(token)}` +
        `@${host}:${port}/${database}?sslmode=require`;
}

function redact(url) {
    return url.replace(/:\/\/([^:]+):[^@]+@/, "://$1:***@");
}

const truthy = (v) => ["1", "true", "yes", "on"].includes(String(v || "").trim().toLowerCase());

const OK = "SERVE_OK: worker served the seeded turn against the deployed store";
const FAIL = "SERVE_FAIL";
const timeoutMs = Number.parseInt(process.env.SERVE_TIMEOUT_MS || "300000", 10);
const pollMs = Number.parseInt(process.env.SERVE_POLL_MS || "3000", 10);

const bail = setTimeout(() => {
    console.error(`${FAIL}: serve did not complete within ${timeoutMs}ms`);
    process.exit(2);
}, timeoutMs);
bail.unref?.();

let worker = null;
let mgmt = null;

try {
    console.log(`[session-worker] node ${process.version} on ${os.platform()}-${os.arch()} (${os.hostname()})`);

    const sessionId = process.env.SESSION_ID || process.env.SESSION_TREE_ID;
    if (!sessionId) throw new Error("SESSION_ID is required");

    const store = buildStoreUrl();
    const useManagedIdentity = truthy(process.env.PILOTSWARM_USE_MANAGED_IDENTITY);
    const aadDbUser = process.env.PILOTSWARM_DB_AAD_USER || undefined;
    console.log(`[session-worker] store: ${redact(store)} (managedIdentity=${useManagedIdentity})`);
    console.log(`[session-worker] target session=${sessionId}`);
    console.log(`[session-worker] model provider: type=${process.env.LLM_PROVIDER_TYPE || "(unset)"} model=${process.env.COPILOT_MODEL || "(unset)"} endpoint=${process.env.LLM_ENDPOINT || "(unset)"}`);

    const workerNodeId = process.env.WORKER_NODE_ID
        || process.env.AGENT_NAME || process.env.POD_NAME || `${os.hostname()}#${process.pid}`;

    // Platform-owned session working directory: when the ADO agent checked out
    // the enlistment (`checkout: self`), root every served session at that
    // checkout so the Copilot CLI discovers the repo's `.github`
    // skills/agents/instructions. The CUSTOMER never sets this — the platform
    // derives it from the agent's checkout (BUILD_SOURCESDIRECTORY), or an
    // explicit PILOTSWARM_SESSION_WORKING_DIR override. Guarded by an on-disk
    // `.github` probe so an empty (`checkout: none`) sources dir is ignored.
    let sessionWorkingDirectory;
    const workDirCandidates = [
        process.env.PILOTSWARM_SESSION_WORKING_DIR,
        process.env.BUILD_SOURCESDIRECTORY,
    ].filter(Boolean);
    for (const cand of workDirCandidates) {
        try {
            if (fs.existsSync(path.join(cand, ".github"))) { sessionWorkingDirectory = cand; break; }
        } catch { /* ignore probe errors */ }
    }
    // Config discovery (the gate for `.github/skills` auto-discovery, SDK
    // default off) is turned on automatically whenever we rooted a checkout;
    // an explicit env can force it on without a detected checkout.
    const enableConfigDiscovery = sessionWorkingDirectory
        ? true
        : truthy(process.env.PILOTSWARM_ENABLE_CONFIG_DISCOVERY);
    if (sessionWorkingDirectory) {
        console.log(`[session-worker] platform session workingDirectory=${sessionWorkingDirectory} (enableConfigDiscovery=${enableConfigDiscovery}) — repo .github skills/agents will be discovered`);
    } else {
        console.log(`[session-worker] no enlistment checkout detected (PILOTSWARM_SESSION_WORKING_DIR / BUILD_SOURCESDIRECTORY lacked .github); sessions use the worker cwd — repo .github skills NOT discovered (enableConfigDiscovery=${enableConfigDiscovery})`);
    }

    const { PilotSwarmWorker, PilotSwarmManagementClient } = await import("pilotswarm-sdk");

    worker = new PilotSwarmWorker({
        store,
        workerNodeId,
        logLevel: process.env.LOG_LEVEL || "info",
        traceWriter: (m) => console.log(m),
        useManagedIdentity,
        aadDbUser,
        sessionWorkingDirectory,
        enableConfigDiscovery,
        blobAccountUrl: process.env.AZURE_STORAGE_ACCOUNT_URL || undefined,
        blobConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING || undefined,
        blobContainer: process.env.AZURE_STORAGE_CONTAINER || undefined,
    });
    console.log(`[session-worker] worker constructed (workerNodeId=${workerNodeId}); starting runtime...`);
    await worker.start();
    console.log("[session-worker] worker.start() complete — runtime is polling the durable store");

    mgmt = new PilotSwarmManagementClient({ store, useManagedIdentity, aadDbUser });
    await mgmt.start();
    console.log(`[session-worker] observing session completion (timeout=${timeoutMs}ms, poll=${pollMs}ms)...`);

    const t0 = Date.now();
    let latest = null;
    while (Date.now() - t0 < timeoutMs) {
        latest = await mgmt.getLatestResponse(sessionId).catch(() => null);
        const type = latest?.type;
        if (type === "completed" || type === "error" || type === "input_required") {
            console.log(`[session-worker] session reached terminal response type=${type} in ${Date.now() - t0}ms`);
            break;
        }
        await new Promise((r) => setTimeout(r, pollMs));
    }

    if (latest?.type !== "completed") {
        throw new Error(`session did not complete (last response type=${latest?.type ?? "none"})`);
    }

    console.log("----- RESPONSE BEGIN -----");
    console.log(latest.content ?? "(no content)");
    console.log("----- RESPONSE END -----");

    clearTimeout(bail);
    console.log(OK);
    await mgmt.stop?.().catch?.(() => {});
    await worker.stop?.().catch?.(() => {});
    process.exit(0);
} catch (err) {
    clearTimeout(bail);
    console.error(`${FAIL}: ${err?.stack || err}`);
    try { await mgmt?.stop?.(); } catch { /* ignore */ }
    try { await worker?.stop?.(); } catch { /* ignore */ }
    process.exit(1);
}
