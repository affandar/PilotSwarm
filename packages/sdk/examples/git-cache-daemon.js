#!/usr/bin/env node

/**
 * Cross-platform git-cache daemon — Node port of deploy/gitops/git-cache's
 * shell `fetch-loop.sh` ConfigMap.
 *
 * WHY a Node port: the Linux git-cache DaemonSet runs a POSIX shell script from
 * a ConfigMap in an `alpine/git` container. A Windows git-cache pod can't run
 * that (no busybox/ash, no alpine image), so the Windows git-cache DaemonSet
 * runs THIS file with the same Node-based worker image
 * (`node packages/sdk/examples/git-cache-daemon.js`). It is intentionally
 * cross-platform so the same daemon can back both the Windows and (optionally)
 * the Linux git-cache pool. See docs/proposals/windows-worker-image-followup.md.
 *
 * Behaviour parity with fetch-loop.sh:
 *   1. Initial `git clone --mirror` into a temp dir with bounded exponential
 *      backoff; on success set gc.auto=0 (append-only), atomically rename to the
 *      mirror dir, write the `<repo>.ready` sentinel.
 *   2. Best-effort node self-patch: add the ready LABEL (the primary scheduling
 *      gate) and try to clear the cache-not-ready TAINT (kept if pool-managed).
 *   3. Steady-state jittered `git fetch --prune` loop with GC off.
 *
 * URL-free: REPO_URL / REPO_NAME come entirely from env set by the per-repo
 * DaemonSet whose values live outside this repo. Never logs the ADO PAT.
 *
 * Env (superset of fetch-loop.sh):
 *   REPO_URL   (required)  ADO clone URL
 *   REPO_NAME  (required)  DNS-safe short name; mirror = <CACHE_ROOT>/<name>.git
 *   CACHE_ROOT            mirror store root (default: /mnt/git-cache, or
 *                         C:\git-cache on win32). The DaemonSet always sets it.
 *   FETCH_INTERVAL_SECONDS (3600) / FETCH_JITTER_SECONDS (300)
 *   CACHE_NOT_READY_TAINT_KEY (pilotswarm.io/cache-not-ready)
 *   READY_LABEL_KEY (pilotswarm.io/git-cache-<REPO_NAME>)
 *   NODE_NAME  (fieldRef spec.nodeName)   ADO_PAT (optional; Basic auth)
 *   CLONE_MAX_ATTEMPTS (6) / CLONE_BACKOFF_SECONDS (15) / CLONE_BACKOFF_CAP_SECONDS (300)
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import https from "node:https";

const env = process.env;
const REPO_URL = req("REPO_URL");
const REPO_NAME = req("REPO_NAME");
const CACHE_ROOT = env.CACHE_ROOT || (process.platform === "win32" ? "C:\\git-cache" : "/mnt/git-cache");
const FETCH_INTERVAL = intEnv("FETCH_INTERVAL_SECONDS", 3600);
const FETCH_JITTER = intEnv("FETCH_JITTER_SECONDS", 300);
const TAINT_KEY = env.CACHE_NOT_READY_TAINT_KEY || "pilotswarm.io/cache-not-ready";
const READY_LABEL = env.READY_LABEL_KEY || `pilotswarm.io/git-cache-${REPO_NAME}`;
const NODE_NAME = env.NODE_NAME || "unknown-node";
const CLONE_MAX_ATTEMPTS = intEnv("CLONE_MAX_ATTEMPTS", 6);
const CLONE_BACKOFF = intEnv("CLONE_BACKOFF_SECONDS", 15);
const CLONE_BACKOFF_CAP = intEnv("CLONE_BACKOFF_CAP_SECONDS", 300);

const MIRROR_DIR = path.join(CACHE_ROOT, `${REPO_NAME}.git`);
const TMP_DIR = path.join(CACHE_ROOT, `.${REPO_NAME}.git.tmp`);
const READY_SENTINEL = path.join(CACHE_ROOT, `${REPO_NAME}.ready`);

// Transport hardening for large ADO mirror transfers (identical intent to
// fetch-loop.sh GIT_NET_OPTS): force HTTP/1.1 to dodge ADO's HTTP/2 long-stream
// resets, big postBuffer, and a fail-fast-on-stall threshold.
const GIT_NET_OPTS = [
  "-c", "http.version=HTTP/1.1",
  "-c", "http.postBuffer=2147483648",
  "-c", "http.lowSpeedLimit=1000",
  "-c", "http.lowSpeedTime=120",
];

// ADO PAT -> HTTP Basic ':<PAT>' via http.extraHeader, injected per-invocation
// so the secret is never in a logged argv (we control what we log) or on disk.
let AUTH_ARGS = [];
if (env.ADO_PAT) {
  const b64 = Buffer.from(`:${env.ADO_PAT}`, "utf8").toString("base64");
  AUTH_ARGS = ["-c", `http.extraHeader=AUTHORIZATION: Basic ${b64}`];
  log("ADO PAT present -> authenticating mirror fetches as Basic (redacted)");
} else {
  log("WARN no ADO_PAT set -> assuming an unauthenticated/anonymous remote");
}

function req(name) {
  const v = env[name];
  if (!v) { console.error(`${name} is required (set by the per-repo DaemonSet)`); process.exit(1); }
  return v;
}
function intEnv(name, dflt) { const n = parseInt(env[name] ?? "", 10); return Number.isFinite(n) ? n : dflt; }
function ts() { return new Date().toISOString().replace(/\.\d+Z$/, "Z"); }
function log(msg) { console.log(`${ts()} [git-hydration] [${REPO_NAME}] [${NODE_NAME}] ${msg}`); }
function sleep(sec) { return new Promise((r) => setTimeout(r, sec * 1000)); }

// git wrapper: net-hardening + optional auth in front of every invocation. We
// never echo AUTH_ARGS. Returns true on exit 0.
function git(args, { quiet = false } = {}) {
  try {
    execFileSync("git", [...GIT_NET_OPTS, ...AUTH_ARGS, ...args], {
      stdio: quiet ? ["ignore", "ignore", "inherit"] : "inherit",
    });
    return true;
  } catch { return false; }
}
// git with NO auth/net-opts (local plumbing like config on the bare mirror).
function gitLocal(args) { execFileSync("git", args, { stdio: "inherit" }); }

async function cloneMirror() {
  let attempt = 1, delay = CLONE_BACKOFF;
  for (;;) {
    rmSync(TMP_DIR, { recursive: true, force: true });
    log(`clone attempt ${attempt}/${CLONE_MAX_ATTEMPTS}: --mirror -> ${TMP_DIR}`);
    const t = Date.now();
    if (git(["clone", "--mirror", REPO_URL, TMP_DIR])) {
      log(`clone attempt ${attempt} COMPLETE in ${sec(t)}s`);
      return true;
    }
    log(`clone attempt ${attempt} FAILED after ${sec(t)}s`);
    rmSync(TMP_DIR, { recursive: true, force: true });
    if (attempt >= CLONE_MAX_ATTEMPTS) {
      log(`clone exhausted ${CLONE_MAX_ATTEMPTS} attempts -> deferring to next fetch loop`);
      return false;
    }
    log(`backing off ${delay}s before clone retry`);
    await sleep(delay);
    delay = Math.min(delay * 2, CLONE_BACKOFF_CAP);
    attempt += 1;
  }
}
const sec = (t) => Math.round((Date.now() - t) / 1000);

function promoteMirror() {
  // Disable auto-GC: keep the mirror append-only so a borrowing worker clone
  // can never race a repack (AKS-GIT-HYDRATION.md section 5).
  gitLocal(["--git-dir=" + TMP_DIR, "config", "gc.auto", "0"]);
  rmSync(MIRROR_DIR, { recursive: true, force: true });
  renameSync(TMP_DIR, MIRROR_DIR);
  writeFileSync(READY_SENTINEL, "");
}

// --- Kubernetes self node-patch (add ready label; best-effort taint clear) ---
const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
function k8sReady() { return existsSync(`${SA_DIR}/token`) && existsSync(`${SA_DIR}/ca.crt`); }

// Reach the API server via the kubelet-injected ClusterIP env vars (no DNS) and
// fall back to the FQDN — NOT the bare "kubernetes.default.svc" short name.
// Windows pods on AKS fail to resolve the short name (getaddrinfo ENOTFOUND),
// which silently broke the node ready-label / taint self-patch on the Windows
// git-cache pods; the ClusterIP + FQDN both work on both OSes.
const K8S_HOST = process.env.KUBERNETES_SERVICE_HOST || "kubernetes.default.svc.cluster.local";
const K8S_PORT = process.env.KUBERNETES_SERVICE_PORT || 443;

function k8sCall(method, apiPath, body) {
  return new Promise((resolve) => {
    let token, ca;
    try { token = readFileSync(`${SA_DIR}/token`, "utf8").trim(); ca = readFileSync(`${SA_DIR}/ca.crt`); }
    catch { return resolve({ ok: false, body: "" }); }
    const data = body ? JSON.stringify(body) : undefined;
    const req = https.request({
      hostname: K8S_HOST, port: K8S_PORT, path: apiPath, method, ca,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(data ? { "Content-Type": "application/merge-patch+json", "Content-Length": Buffer.byteLength(data) } : {}),
      },
      timeout: 15000,
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, body: buf }));
    });
    req.on("error", () => resolve({ ok: false, body: "" }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, body: "" }); });
    if (data) req.write(data);
    req.end();
  });
}

async function markNodeReady() {
  if (!k8sReady()) { log("WARN cannot self-patch node (no SA token/ca) -> leaving taint/label to an operator"); return; }
  // (1) Ready label — the PRIMARY readiness signal workers select on.
  const lbl = await k8sCall("PATCH", `/api/v1/nodes/${NODE_NAME}`, { metadata: { labels: { [READY_LABEL]: "ready" } } });
  log(lbl.ok ? `node labeled ${READY_LABEL}=ready (readiness signal for workers)` : `WARN failed to add ready label ${READY_LABEL}`);
  // (2) Best-effort taint removal (kept as a permanent gate if pool-managed).
  const got = await k8sCall("GET", `/api/v1/nodes/${NODE_NAME}`);
  if (!got.ok) return;
  let node; try { node = JSON.parse(got.body); } catch { return; }
  const taints = node?.spec?.taints ?? [];
  if (taints.some((t) => t.key === TAINT_KEY)) {
    const remaining = taints.filter((t) => t.key !== TAINT_KEY);
    const res = await k8sCall("PATCH", `/api/v1/nodes/${NODE_NAME}`, { spec: { taints: remaining } });
    log(res.ok
      ? `cleared node taint ${TAINT_KEY} (workers may now schedule)`
      : `note: taint ${TAINT_KEY} retained (removal blocked, e.g. AKS pool-managed) -> ready label is the gate`);
  }
}

async function main() {
  mkdirSync(CACHE_ROOT, { recursive: true });

  // --- 1) initial mirror (frontloaded) ---
  if (existsSync(MIRROR_DIR)) {
    log(`mirror already present at ${MIRROR_DIR} (surviving hostPath) -> skipping initial clone`);
  } else {
    log("==== INITIAL CLONE starting ====");
    const t = Date.now();
    if (await cloneMirror()) { promoteMirror(); log(`==== INITIAL CLONE COMPLETE in ${sec(t)}s ====`); }
    else log(`==== INITIAL CLONE FAILED after ${sec(t)}s -> will retry next loop ====`);
  }

  // --- 2) readiness sentinel + node gating ---
  if (existsSync(MIRROR_DIR)) {
    if (!existsSync(READY_SENTINEL)) writeFileSync(READY_SENTINEL, "");
    log(`readiness sentinel written: ${READY_SENTINEL}`);
    await markNodeReady();
  }

  // --- 3) steady-state fetch loop (delta only, GC off) ---
  log(`entering fetch loop: interval=${FETCH_INTERVAL}s jitter<=${FETCH_JITTER}s gc.auto=0`);
  let cycle = 0;
  for (;;) {
    const jitter = Math.floor(Math.random() * (FETCH_JITTER + 1));
    const sleepFor = FETCH_INTERVAL + jitter;
    log(`sleeping ${sleepFor}s until next fetch (interval=${FETCH_INTERVAL}s + jitter=${jitter}s)`);
    await sleep(sleepFor);
    cycle += 1;

    if (!existsSync(MIRROR_DIR)) {
      log(`mirror missing at fetch #${cycle} -> retrying INITIAL CLONE`);
      const t = Date.now();
      if (await cloneMirror()) { promoteMirror(); log(`retry clone COMPLETE in ${sec(t)}s`); await markNodeReady(); }
      else log(`retry clone FAILED after ${sec(t)}s`);
      continue;
    }

    log(`fetch #${cycle} starting (git fetch --prune)`);
    const t = Date.now();
    const ok = git(["--git-dir=" + MIRROR_DIR, "fetch", "--prune", "--no-write-fetch-head",
      "origin", "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"]);
    log(ok ? `fetch #${cycle} COMPLETE in ${sec(t)}s` : `WARN fetch #${cycle} FAILED after ${sec(t)}s (mirror kept; will retry)`);
  }
}

main().catch((e) => { log(`FATAL ${e?.stack || e}`); process.exit(1); });
