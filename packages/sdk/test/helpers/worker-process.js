/**
 * Standalone worker process for multi-process repro test.
 *
 * Spawned by concurrent-sessions-repro.test.js via child_process.fork().
 * Receives config via IPC, starts a PilotSwarmWorker, signals readiness,
 * and stays alive until told to stop.
 */

import { PilotSwarmWorker } from "../../dist/index.js";

process.on("message", async (msg) => {
    if (msg.type === "start") {
        try {
            const worker = new PilotSwarmWorker({
                store: msg.store,
                githubToken: msg.githubToken,
                duroxideSchema: msg.duroxideSchema,
                cmsSchema: msg.cmsSchema,
                factsSchema: msg.factsSchema,
                sessionStateDir: msg.sessionStateDir,
                workerNodeId: msg.workerNodeId,
                disableManagementAgents: true,
                logLevel: msg.logLevel || "warn",
            });
            await worker.start();

            process.send({ type: "ready", workerNodeId: msg.workerNodeId });

            process.on("message", async (stopMsg) => {
                if (stopMsg.type === "stop") {
                    try { await worker.stop(); } catch {}
                    process.exit(0);
                }
            });
        } catch (err) {
            process.send({ type: "error", error: err.message });
            process.exit(1);
        }
    }
});
