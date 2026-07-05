/**
 * Literal fault-injection harness (session lifecycle protocol §4.4).
 *
 * Forks REAL PilotSwarmWorker processes (test/helpers/worker-process.js,
 * running built dist/ code) with `PILOTSWARM_FAULT_INJECT` armed so the
 * process dies via process.exit(137) at an exact protocol boundary, then
 * lets the REAL duroxide retry machinery re-dispatch the in-flight turn to
 * a fresh worker process. Nothing is simulated: the crash is a process
 * death, the recovery is duroxide's, the store is the shared filesystem
 * snapshot store.
 *
 * Store sharing geometry: each worker gets its own
 * `<base>/kill-<id>/session-state` dir — the basename MUST be
 * `session-state` because the Copilot CLI writes to
 * `$COPILOT_HOME/session-state/<id>` with COPILOT_HOME set to the dir's
 * parent — while all workers share ONE explicit snapshot store dir
 * (`<base>/kill-shared-store`, wired through worker-process.js as an
 * explicit FilesystemSessionStore). Separate "disks", one store, exactly
 * like separate pods sharing blob storage.
 *
 * Timing: work-item lock reclaim is tuned to 2s via
 * PILOTSWARM_WORKER_LOCK_TIMEOUT_MS, but duroxide's SESSION lock (~30s,
 * not exposed to Node) is the floor for re-dispatching session-pinned
 * work after a kill — each kill/recovery cycle costs ~30-40s.
 */
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = resolve(__dirname, "worker-process.js");
const WORKSPACE_ROOT = resolve(__dirname, "../../../../");

const FAST_LOCK_MS = "2000";

/**
 * Fork one worker process. Returns handles for readiness, exit, logs, kill.
 *
 * @param {object} env       createTestEnv() suite env
 * @param {string} id        worker id suffix (also the workerNodeId)
 * @param {object} [opts]
 * @param {string} [opts.faultInject]  PILOTSWARM_FAULT_INJECT value to arm
 */
/** Shared snapshot-store dir for every kill-harness worker in this suite. */
export function killStoreDir(env) {
    return resolve(dirname(env.sessionStateDir), "kill-shared-store");
}

export function forkKillWorker(env, id, opts = {}) {
    const base = dirname(env.sessionStateDir);
    const stateDir = resolve(base, `kill-${id}`, "session-state");
    const storeDir = killStoreDir(env);
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(storeDir, { recursive: true });

    const child = fork(WORKER_SCRIPT, [], {
        cwd: WORKSPACE_ROOT,
        env: {
            ...process.env,
            PILOTSWARM_WORKER_LOCK_TIMEOUT_MS: FAST_LOCK_MS,
            PILOTSWARM_COMMIT_RETRY_DELAY_MS: "100",
            ...(opts.faultInject ? { PILOTSWARM_FAULT_INJECT: opts.faultInject } : {}),
        },
        stdio: ["pipe", "pipe", "pipe", "ipc"],
    });

    const logs = [];
    const capture = (stream, tag) => {
        stream.on("data", (data) => {
            for (const line of data.toString().split("\n")) {
                if (!line.trim() || line.includes("ExperimentalWarning")) continue;
                logs.push(line);
                if (process.env.PS_KILL_HARNESS_VERBOSE) {
                    console.log(`    [${id} ${tag}] ${line}`);
                }
            }
        });
    };
    capture(child.stdout, "out");
    capture(child.stderr, "err");

    const exited = new Promise((resolveExit) => {
        child.on("exit", (code, signal) => resolveExit({ code, signal }));
    });

    const ready = new Promise((resolveReady, reject) => {
        const timeout = setTimeout(() => reject(new Error(`worker ${id} did not start in 45s`)), 45_000);
        child.on("message", function handler(msg) {
            if (msg.type === "ready") {
                clearTimeout(timeout);
                child.removeListener("message", handler);
                resolveReady();
            } else if (msg.type === "error") {
                clearTimeout(timeout);
                child.removeListener("message", handler);
                reject(new Error(`worker ${id} failed: ${msg.error}`));
            }
        });
        child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });

    child.send({
        type: "start",
        store: env.store,
        githubToken: process.env.GITHUB_TOKEN,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        sessionStateDir: stateDir,
        sessionStoreDir: storeDir,
        workerNodeId: `kill-${id}`,
        logLevel: process.env.DUROXIDE_LOG_LEVEL || "warn",
    });

    return {
        id,
        child,
        stateDir,
        logs,
        ready,
        exited,
        faultFired: () => logs.some((line) => line.includes("[fault-injection] hit point=")),
        async stop() {
            try { child.send({ type: "stop" }); } catch {}
            await Promise.race([exited, new Promise((r) => setTimeout(r, 3_000))]);
            try { child.kill("SIGKILL"); } catch {}
        },
        killHard() {
            child.kill("SIGKILL");
            return exited;
        },
    };
}

/** Wait for a forked worker to die AT the armed fault (exit code 137). */
export async function expectFaultDeath(worker, label) {
    const { code, signal } = await Promise.race([
        worker.exited,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}: worker ${worker.id} did not die at the fault within 240s`)), 240_000)),
    ]);
    if (code !== 137) {
        throw new Error(`${label}: worker ${worker.id} exited code=${code} signal=${signal}, expected fault exit 137. Logs tail:\n${worker.logs.slice(-15).join("\n")}`);
    }
    if (!worker.faultFired()) {
        throw new Error(`${label}: worker ${worker.id} exited 137 but no fault-injection hit line was logged`);
    }
}
