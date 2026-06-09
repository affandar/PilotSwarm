// Phase 7 (FR-027): thin wrappers around `kubectl` and
// `az aks get-credentials` for the smoke driver. Kept separate from
// the orchestrator so the orchestrator can be unit-tested with
// in-memory `runKubectl` doubles.

import { spawnSync } from "node:child_process";

/**
 * Run a kubectl command synchronously. Returns `{ stdout, stderr,
 * status }`. Does NOT throw on non-zero exit; the caller decides
 * how to interpret the status.
 */
export function runKubectl(args, { context, namespace, env } = {}) {
    const fullArgs = [];
    if (context) fullArgs.push("--context", context);
    if (namespace) fullArgs.push("--namespace", namespace);
    fullArgs.push(...args);
    const result = spawnSync("kubectl", fullArgs, {
        encoding: "utf8",
        env: env ?? process.env,
    });
    return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        status: typeof result.status === "number" ? result.status : -1,
    };
}

/**
 * Acquire a kubeconfig for the given AKS cluster via
 * `az aks get-credentials`. Idempotent — overwrites the target
 * kubeconfig file if it exists.
 *
 * Mirrors the pattern in deploy/scripts/lib/wait-rollout.mjs
 * but deliberately scoped narrow (no fancy retry / wait logic;
 * that's the deploy's job, not the smoke driver's).
 */
export function acquireKubeContext({ subscription, resourceGroup, cluster, kubeconfigPath, env }) {
    const args = [
        "aks", "get-credentials",
        "--resource-group", resourceGroup,
        "--name", cluster,
        "--file", kubeconfigPath,
        "--overwrite-existing",
    ];
    if (subscription) args.push("--subscription", subscription);
    const result = spawnSync("az", args, {
        encoding: "utf8",
        env: env ?? process.env,
    });
    if (result.status !== 0) {
        throw new Error(`az aks get-credentials failed: ${result.stderr || result.stdout}`);
    }
    return { kubeconfigPath };
}
