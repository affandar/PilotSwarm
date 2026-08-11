#!/usr/bin/env node
/**
 * Headless pilotswarm ADO placement scheduler.
 *
 * A control-plane SERVICE — NOT a customer app and NOT a sample. It runs as a
 * leader-elected singleton K8s pod (`pilotswarm-scheduler` Deployment,
 * replicas: 1, strategy: Recreate) INSIDE the AKS cluster, exactly like the
 * headless worker (examples/worker.js) runs as the `copilot-runtime-worker`
 * pod. Customers never run it — they only touch the portal REST API. A platform
 * operator can also run it locally as a pod stand-in against the deployed store
 * (DefaultAzureCredential picks up `az login` locally and the pod's workload
 * identity in-cluster — no code change between the two).
 *
 * The pull→push bridge for the ADO worker substrate. In AKS the copilot-runtime
 * worker Deployment is always-on and self-schedules by polling the durable store
 * (dispatcherPollIntervalMs=10). On the ADO substrate there are NO always-on
 * pollers — a "worker" is a pipeline run that costs ~7 min to stand up — so this
 * component must OBSERVE the store and PUSH (queue a run) per session tree on
 * demand. It is the ADO Placement Provider, the inverse of MAF's CapacityController.
 *
 *   observe  → CMS: root sessions in a runnable state (status='running')
 *   decide   → planSessionPlacement / evaluateLease  (see PilotSwarm SDK
 *              src/ado-placement.ts — the pure, unit-tested decision logic this
 *              loop mirrors inline until the feature branches reconcile; SOURCE
 *              OF TRUTH)
 *   activate → queue ADO pipeline run (58097) with SESSION_ID via managed
 *              identity + upsert session_tree_affinity (dedup / lease)
 *
 * Packaged by deploy/Dockerfile.ADOScheduler; deployed by
 * deploy/gitops/ado-scheduler/**. Design:
 * SqlOrchestrationPlatform/docs/PILOTSWARM_ADO_WORKER_DESIGN.md §4.2.
 *
 * Env — durable store (same contract as cp1-serve-one.mjs):
 *   PGHOST_FQDN, PGDB, PGUSER_ENTRA, PGPORT       store coordinates
 *   PG_ENTRA_TOKEN                                Entra token as libpq password
 *                                                 (optional when using MI)
 *   PILOTSWARM_USE_MANAGED_IDENTITY              mint tokens via DefaultAzureCredential
 *   PILOTSWARM_DB_AAD_USER                        AAD db user (defaults to PGUSER_ENTRA)
 *   PILOTSWARM_DUROXIDE_SCHEMA / _CMS_SCHEMA / _FACTS_SCHEMA
 *                                                 store schemas (must match the
 *                                                 deployed portal/worker)
 * Env — ADO placement:
 *   ADO_ORG            (default: msdata)
 *   ADO_PROJECT        (default: Database Systems)
 *   ADO_PIPELINE_ID    (default: 58097)           the PoC worker pipeline
 *   ADO_BRANCH_REF     (default: refs/heads/users/kchung/pilotswarm-worker-poc)
 *   PILOTSWARM_REF     (default: feature/windows-worker-packaging)  pilotswarmRef param
 * Env — run secrets injected into each queued run:
 *   LLM_API_KEY        (required unless SCHED_DRY_RUN)  passed as a masked var
 *   PG_ENTRA_TOKEN     minted per-queue via MI (or reused from env)
 * Env — scheduler loop:
 *   SCHED_POLL_MS              (default: 5000)
 *   SCHED_ONCE                 (default: off)  one observe/decide/act pass, then exit
 *   SCHED_DRY_RUN              (default: off)  decide + log, but never queue / write affinity
 *   SCHED_MAX_QUEUE_PER_PASS   (default: 1)    safety cap on runs queued per pass
 *   SCHED_LEASE_TTL_SECONDS    (default: 1200) CP1b lease covers a full run lifetime.
 *                                              ado-placement.ts uses 45s, which assumes the
 *                                              worker RENEWS the lease on each heartbeat (the
 *                                              crash signal). CP1b has no heartbeat-renewal
 *                                              wiring yet, so a 45s lease would lapse while a
 *                                              run is still booting and the loop would
 *                                              double-queue. A long lease is the CP1b stand-in;
 *                                              TODO(cp2-heartbeat): renew on workerHeartbeat and
 *                                              restore the 45s crash-detection semantics.
 *   SCHED_TARGET_STATUS        (default: running)  CMS status that means "needs compute"
 *   SCHED_RETRY_ON_LEASE_EXPIRY (default: off)  when a session is STILL a candidate
 *                                              after its lease lapses, its prior run failed
 *                                              to drive it terminal. Re-queuing then (the
 *                                              default before this flag) produced a perpetual
 *                                              run storm because there is no heartbeat-renewed
 *                                              lease or run-status reconcile yet (CP2). Until
 *                                              those land we attempt each session ONCE; set
 *                                              this to 1 to restore blind retry-on-expiry.
 *   SCHED_AFFINITY_SCHEMA      (default: PILOTSWARM_CMS_SCHEMA or copilot_sessions)
 *   SCHED_SESSION_ID           (optional)  restrict to ONE session id (smoke)
 *
 * TODO(146): replace the injected PG_ENTRA_TOKEN / LLM_API_KEY secrets with a
 *   workload-identity / service-connection MI on the pipeline so no tokens are
 *   passed as run variables at all.
 */
import os from "node:os";
import pg from "pg";
import { DefaultAzureCredential } from "@azure/identity";

// ─── config / env ────────────────────────────────────────────────────────────
const truthy = (v) => ["1", "true", "yes", "on"].includes(String(v || "").trim().toLowerCase());
const intEnv = (k, d) => Number.parseInt(process.env[k] || String(d), 10);

const PG_AAD_SCOPE = "https://ossrdbms-aad.database.windows.net/.default";
const ADO_SCOPE = "499b84ac-1321-427f-aa17-267ca6975798/.default";
const KV_SCOPE = "https://vault.azure.net/.default";

const cfg = {
    host: process.env.PGHOST_FQDN,
    port: intEnv("PGPORT", 5432),
    database: process.env.PGDB || "postgres",
    user: process.env.PGUSER_ENTRA || process.env.PILOTSWARM_DB_AAD_USER,
    pgTokenEnv: process.env.PG_ENTRA_TOKEN || null,
    useMi: truthy(process.env.PILOTSWARM_USE_MANAGED_IDENTITY),
    aadDbUser: process.env.PILOTSWARM_DB_AAD_USER || process.env.PGUSER_ENTRA || undefined,
    cmsSchema: process.env.PILOTSWARM_CMS_SCHEMA || "copilot_sessions",

    adoOrg: process.env.ADO_ORG || "msdata",
    adoProject: process.env.ADO_PROJECT || "Database Systems",
    pipelineId: intEnv("ADO_PIPELINE_ID", 58097),
    branchRef: process.env.ADO_BRANCH_REF || "refs/heads/users/kchung/pilotswarm-worker-poc",
    pilotswarmRef: process.env.PILOTSWARM_REF || "feature/windows-worker-packaging",
    llmApiKey: process.env.LLM_API_KEY || null,
    adoPat: process.env.ADO_PAT || null,
    // Key Vault source for the ADO PAT: fetched at startup via workload
    // identity (the pod's UAMI has Key Vault Secrets User), so the PAT lives
    // only in the vault — never in git or a plain K8s Secret. An explicit
    // ADO_PAT env still wins (local dev).
    adoPatKvUri: process.env.ADO_PAT_KV_URI || null,
    adoPatSecretName: process.env.ADO_PAT_SECRET_NAME || null,

    pollMs: intEnv("SCHED_POLL_MS", 5000),
    once: truthy(process.env.SCHED_ONCE),
    dryRun: truthy(process.env.SCHED_DRY_RUN),
    maxQueuePerPass: intEnv("SCHED_MAX_QUEUE_PER_PASS", 1),
    leaseTtlSeconds: intEnv("SCHED_LEASE_TTL_SECONDS", 1200),
    targetStatus: process.env.SCHED_TARGET_STATUS || "running",
    retryOnLeaseExpiry: truthy(process.env.SCHED_RETRY_ON_LEASE_EXPIRY),
    affinitySchema: process.env.SCHED_AFFINITY_SCHEMA || process.env.PILOTSWARM_CMS_SCHEMA || "copilot_sessions",
    onlySessionId: process.env.SCHED_SESSION_ID || null,
};

const log = (msg) => console.log(`[cp1b-sched] ${msg}`);
const errlog = (msg) => console.error(`[cp1b-sched] ${msg}`);

// ─── credentials ─────────────────────────────────────────────────────────────
const credential = new DefaultAzureCredential();
async function mintPgToken() {
    const t = await credential.getToken(PG_AAD_SCOPE);
    if (!t?.token) throw new Error("failed to mint PG Entra token");
    return t.token;
}
async function mintAdoToken() {
    const t = await credential.getToken(ADO_SCOPE);
    if (!t?.token) throw new Error("failed to mint ADO token");
    return t.token;
}

// Load the ADO PAT from Key Vault via workload identity when configured (and no
// explicit ADO_PAT env is present). Uses the pod UAMI's federated token — the
// PAT never lands in git or a K8s Secret. Raw REST keeps the image lean (no
// @azure/keyvault-secrets dependency); the credential already covers the scope.
async function loadAdoPatFromKeyVault() {
    if (cfg.adoPat) return; // explicit env PAT wins (local dev)
    if (!cfg.adoPatKvUri || !cfg.adoPatSecretName) return;
    const t = await credential.getToken(KV_SCOPE);
    if (!t?.token) throw new Error("failed to mint Key Vault token");
    const base = cfg.adoPatKvUri.replace(/\/+$/, "");
    const url = `${base}/secrets/${encodeURIComponent(cfg.adoPatSecretName)}?api-version=7.4`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${t.token}` } });
    const text = await res.text();
    if (!res.ok) throw new Error(`Key Vault get-secret ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    const value = JSON.parse(text)?.value;
    if (!value) throw new Error(`Key Vault secret ${cfg.adoPatSecretName} has no value`);
    cfg.adoPat = value;
    log(`ADO PAT loaded from Key Vault (${base} secret=${cfg.adoPatSecretName})`);
}

// libpq password provider for the affinity pool (auto-refresh: pg calls this per new connection)
async function pgPassword() {
    if (cfg.useMi) return mintPgToken();
    if (cfg.pgTokenEnv) return cfg.pgTokenEnv;
    throw new Error("no PG credential: set PILOTSWARM_USE_MANAGED_IDENTITY or PG_ENTRA_TOKEN");
}

function buildStoreUrl(pgToken) {
    if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
    const missing = [];
    if (!cfg.host) missing.push("PGHOST_FQDN");
    if (!cfg.user) missing.push("PGUSER_ENTRA");
    if (!pgToken) missing.push("PG_ENTRA_TOKEN|MI");
    if (missing.length) throw new Error(`missing store env: ${missing.join(", ")}`);
    return `postgresql://${encodeURIComponent(cfg.user)}:${encodeURIComponent(pgToken)}` +
        `@${cfg.host}:${cfg.port}/${cfg.database}?sslmode=require`;
}
const redact = (u) => u.replace(/:\/\/([^:]+):[^@]+@/, "://$1:***@");

// ─── affinity store (session_tree_affinity) ──────────────────────────────────
const q = (s) => `"${s.replace(/"/g, '""')}"`;
const affinityTable = `${q(cfg.affinitySchema)}.session_tree_affinity`;

async function ensureAffinityTable(pool) {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${q(cfg.affinitySchema)}`);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS ${affinityTable} (
            session_tree_id   text PRIMARY KEY,
            ado_run_id        text,
            worker_node_id    text,
            lease_expires_at  timestamptz,
            run_state         text,
            checkpoint_epoch  int DEFAULT 0,
            updated_at        timestamptz DEFAULT now()
        )`);
}
async function getAffinity(pool, treeId) {
    const r = await pool.query(`SELECT * FROM ${affinityTable} WHERE session_tree_id = $1`, [treeId]);
    return r.rows[0] || null;
}
async function upsertAffinity(pool, a) {
    await pool.query(
        `INSERT INTO ${affinityTable}
             (session_tree_id, ado_run_id, worker_node_id, lease_expires_at, run_state, checkpoint_epoch, updated_at)
         VALUES ($1,$2,$3, now() + ($4 || ' seconds')::interval, $5, $6, now())
         ON CONFLICT (session_tree_id) DO UPDATE SET
             ado_run_id = EXCLUDED.ado_run_id,
             worker_node_id = EXCLUDED.worker_node_id,
             lease_expires_at = EXCLUDED.lease_expires_at,
             run_state = EXCLUDED.run_state,
             updated_at = now()`,
        [a.treeId, a.adoRunId, a.workerNodeId, String(cfg.leaseTtlSeconds), a.runState, a.checkpointEpoch ?? 0],
    );
}

// ─── placement decision (mirrors src/ado-placement.ts — SOURCE OF TRUTH) ─────
// CP1b root-only: sub-agent co-location, hold/release and wake are deferred (CP2).
function decidePlacement(session, affinity, nowMs) {
    if (session.parentSessionId) return { action: "colocate", reason: "sub-agent (deferred to CP2)" };
    if (affinity) {
        const leaseMs = affinity.lease_expires_at ? new Date(affinity.lease_expires_at).getTime() : 0;
        const alive = nowMs < leaseMs && affinity.run_state !== "releasing";
        if (alive) return { action: "colocate", reason: `live run ${affinity.ado_run_id} (lease ok)` };
        // Lease lapsed but the session is STILL a candidate → its prior run
        // never drove it terminal (failed / canceled / no worker). Blindly
        // re-queuing here is what caused the run storm: with no heartbeat-
        // renewed lease or run-status reconcile (CP2), every lapse re-fires a
        // run forever. Attempt each session ONCE until that lands; the flag
        // restores the old behavior when we're ready.
        if (!cfg.retryOnLeaseExpiry) {
            return {
                action: "skip-retry-disabled",
                reason: `prior run ${affinity.ado_run_id} ended, still ${cfg.targetStatus}; retry disabled (SCHED_RETRY_ON_LEASE_EXPIRY=1 to re-enable)`,
            };
        }
        return { action: "queue-ado-run", reason: `lease expired (run ${affinity.ado_run_id})` };
    }
    return { action: "queue-ado-run", reason: "root, no affinity" };
}

// ─── ADO REST — queue a pipeline run (mirrors AdoWorkerActivator) ─────────────
async function queueAdoRun(sessionId) {
    const pgToken = await pgPassword();
    // ADO auth: a scoped PAT (ADO_PAT, HTTP Basic) is the CP1b path — the
    // scheduler's workload-identity SP is not an msdata org member (adding it
    // needs org "Add Users", which the operator lacks), so the passwordless
    // AAD-token route can't queue yet. When ADO_PAT is unset, fall back to a
    // workload-identity AAD token (the hardening target). The PAT lives only in
    // Key Vault (loaded at startup via the pod UAMI), never in git or a Secret.
    const authHeader = cfg.adoPat
        ? `Basic ${Buffer.from(`:${cfg.adoPat}`).toString("base64")}`
        : `Bearer ${await mintAdoToken()}`;
    const base = `https://dev.azure.com/${encodeURIComponent(cfg.adoOrg)}/${encodeURIComponent(cfg.adoProject)}`;
    const url = `${base}/_apis/pipelines/${cfg.pipelineId}/runs?api-version=7.1`;
    // SESSION_ID scopes the run to one session's work. Secrets (PG token, LLM
    // key) are only injected when the scheduler actually holds them; when the
    // pipeline self-sources them (ADO variable group / Key Vault / keyless
    // Foundry MI — the SEC-6 hardening target) they are omitted here so no
    // secret traverses the run API. See docs/developer/deploy/kchtest-minimal-proof-shortcuts.md.
    const variables = { SESSION_ID: { value: sessionId, isSecret: false } };
    if (pgToken) variables.PG_ENTRA_TOKEN = { value: pgToken, isSecret: true };
    if (cfg.llmApiKey) variables.LLM_API_KEY = { value: cfg.llmApiKey, isSecret: true };
    const body = {
        resources: { repositories: { self: { refName: cfg.branchRef } } },
        templateParameters: { pilotswarmRef: cfg.pilotswarmRef },
        variables,
    };
    const res = await fetch(url, {
        method: "POST",
        headers: { authorization: authHeader, "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ADO queue ${res.status} ${res.statusText}: ${text.slice(0, 600)}`);
    const run = JSON.parse(text);
    return { runId: String(run.id), webUrl: run._links?.web?.href || run.url || null };
}

// ─── observe / act pass ──────────────────────────────────────────────────────
async function pass(mgmt, pool) {
    const nowMs = Date.now();
    const sessions = await mgmt.listSessions();
    let candidates = sessions.filter((s) =>
        !s.parentSessionId && !s.isSystem && s.status === cfg.targetStatus);
    if (cfg.onlySessionId) candidates = candidates.filter((s) => s.sessionId === cfg.onlySessionId);

    log(`observed ${sessions.length} sessions; ${candidates.length} runnable root candidate(s)` +
        (cfg.onlySessionId ? ` (filtered to ${cfg.onlySessionId})` : ""));

    let queued = 0;
    for (const s of candidates) {
        const affinity = await getAffinity(pool, s.sessionId);
        const decision = decidePlacement(s, affinity, nowMs);
        if (decision.action !== "queue-ado-run") {
            log(`  skip ${s.sessionId} — ${decision.action}: ${decision.reason}`);
            continue;
        }
        if (queued >= cfg.maxQueuePerPass) {
            log(`  defer ${s.sessionId} — per-pass cap ${cfg.maxQueuePerPass} reached`);
            break;
        }
        if (cfg.dryRun) {
            log(`  DRY-RUN would queue run for ${s.sessionId} — ${decision.reason}`);
            queued++;
            continue;
        }
        if (!cfg.llmApiKey) {
            log(`  note: LLM_API_KEY not set on scheduler — pipeline must self-source it (SEC-6). Proceeding.`);
        }
        log(`  QUEUE ${s.sessionId} — ${decision.reason}`);
        const { runId, webUrl } = await queueAdoRun(s.sessionId);
        await upsertAffinity(pool, {
            treeId: s.sessionId,
            adoRunId: runId,
            workerNodeId: `ado-run-${runId}`,
            runState: "queued",
            checkpointEpoch: 0,
        });
        log(`  QUEUED run ${runId} for ${s.sessionId}; affinity upserted (lease ${cfg.leaseTtlSeconds}s). ${webUrl ?? ""}`);
        queued++;
    }
    return queued;
}

// ─── main ────────────────────────────────────────────────────────────────────
let mgmt = null;
let pool = null;
try {
    log(`node ${process.version} on ${os.platform()}-${os.arch()} (${os.hostname()})`);
    log(`ADO: org=${cfg.adoOrg} project="${cfg.adoProject}" pipeline=${cfg.pipelineId} ref=${cfg.branchRef} pilotswarmRef=${cfg.pilotswarmRef}`);
    log(`store: ${cfg.host}/${cfg.database} user=${cfg.user} mi=${cfg.useMi} cmsSchema=${cfg.cmsSchema} affinitySchema=${cfg.affinitySchema}`);
    log(`loop: pollMs=${cfg.pollMs} once=${cfg.once} dryRun=${cfg.dryRun} maxQueue/pass=${cfg.maxQueuePerPass} targetStatus=${cfg.targetStatus} retryOnLeaseExpiry=${cfg.retryOnLeaseExpiry}`);

    // Load the ADO PAT from Key Vault (workload identity) before any queue call.
    await loadAdoPatFromKeyVault();
    log(`ADO auth: ${cfg.adoPat ? "PAT (Basic)" : "workload-identity AAD token (Bearer)"}`);

    const pgToken = cfg.useMi ? await mintPgToken() : cfg.pgTokenEnv;
    const store = buildStoreUrl(pgToken);
    log(`store url: ${redact(store)}`);

    // Affinity pool (raw pg, control-plane table).
    pool = new pg.Pool({
        host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user,
        password: pgPassword, ssl: { rejectUnauthorized: false }, max: 4,
    });
    await ensureAffinityTable(pool);
    log(`affinity table ready: ${affinitySchemaTable()}`);

    // Read-only observe path (CMS) via the SDK management client.
    const { PilotSwarmManagementClient } = await import("pilotswarm-sdk");
    mgmt = new PilotSwarmManagementClient({ store, useManagedIdentity: cfg.useMi, aadDbUser: cfg.aadDbUser });
    await mgmt.start();
    log("management client started (observe path ready)");

    if (cfg.once) {
        const n = await pass(mgmt, pool);
        log(`single pass complete — queued ${n} run(s)`);
        await shutdown(0);
    } else {
        log(`entering poll loop (Ctrl-C to stop)`);
        let stopping = false;
        const stop = () => { stopping = true; };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
        while (!stopping) {
            try { await pass(mgmt, pool); }
            catch (e) { errlog(`pass error: ${e?.stack || e}`); }
            if (stopping) break;
            await new Promise((r) => setTimeout(r, cfg.pollMs));
        }
        log("stop signal received");
        await shutdown(0);
    }
} catch (err) {
    errlog(`FATAL: ${err?.stack || err}`);
    await shutdown(1);
}

function affinitySchemaTable() { return affinityTable; }

async function shutdown(code) {
    try { await mgmt?.stop?.(); } catch { /* ignore */ }
    try { await pool?.end?.(); } catch { /* ignore */ }
    process.exit(code);
}
