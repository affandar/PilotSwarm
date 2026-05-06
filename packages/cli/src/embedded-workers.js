import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { PilotSwarmWorker } from "pilotswarm-sdk";

export async function startEmbeddedWorkers({ count, store }) {
    const workers = [];
    if (!count || count <= 0) return workers;

    const defaultPluginDir = path.resolve(process.cwd(), "packages/cli/plugins");
    const pluginDirs = process.env.PLUGIN_DIRS
        ? process.env.PLUGIN_DIRS.split(",").map((value) => value.trim()).filter(Boolean)
        : (fs.existsSync(defaultPluginDir) ? [defaultPluginDir] : []);

    let workerModuleConfig = {};
    if (process.env._TUI_WORKER_MODULE) {
        const imported = await import(process.env._TUI_WORKER_MODULE);
        workerModuleConfig = imported.default || imported;
    }

    const sessionStateDir = process.env.SESSION_STATE_DIR || path.join(os.homedir(), ".copilot", "session-state");
    const originalConsole = {
        log: console.log,
        warn: console.warn,
        error: console.error,
    };

    for (let index = 0; index < count; index++) {
        console.log = () => {};
        console.warn = () => {};
        console.error = () => {};
        try {
            const worker = new PilotSwarmWorker({
                store,
                githubToken: process.env.GITHUB_TOKEN,
                logLevel: process.env.LOG_LEVEL || "error",
                sessionStateDir,
                workerNodeId: `local-${index}`,
                systemMessage: workerModuleConfig.systemMessage || process.env._TUI_SYSTEM_MESSAGE || undefined,
                pluginDirs,
                // Bicep-deploy MI flow (set in worker-env ConfigMap by the
                // overlay .env). Unset for legacy `scripts/deploy-aks.sh`,
                // local Docker, and CI — those keep using the password
                // URL via `store` (and AZURE_STORAGE_CONNECTION_STRING for
                // blobs). See packages/sdk/src/pg-pool-factory.ts.
                useManagedIdentity: ["1", "true", "yes", "on"].includes(
                    (process.env.PILOTSWARM_USE_MANAGED_IDENTITY || "").trim().toLowerCase(),
                ),
                cmsFactsDatabaseUrl: process.env.PILOTSWARM_CMS_FACTS_DATABASE_URL || undefined,
                aadDbUser: process.env.PILOTSWARM_DB_AAD_USER || undefined,
                blobAccountUrl: process.env.AZURE_STORAGE_ACCOUNT_URL || undefined,
                blobConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING || undefined,
                blobContainer: process.env.AZURE_STORAGE_CONTAINER || undefined,
            });

            const workerTools = typeof workerModuleConfig.createTools === "function"
                ? await workerModuleConfig.createTools({ workerNodeId: `local-${index}`, workerIndex: index })
                : workerModuleConfig.tools;
            if (workerTools?.length) {
                worker.registerTools(workerTools);
            }

            await worker.start();
            workers.push(worker);
        } finally {
            console.log = originalConsole.log;
            console.warn = originalConsole.warn;
            console.error = originalConsole.error;
        }
    }

    return workers;
}

export async function stopEmbeddedWorkers(workers) {
    await Promise.allSettled((workers || []).map((worker) => worker.stop()));
}
