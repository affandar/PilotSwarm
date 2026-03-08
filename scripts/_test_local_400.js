#!/usr/bin/env node
// Quick local test: replicate PilotSwarm session via PilotSwarmClient/Worker API.
// Usage: node --env-file=.env scripts/_test_local_400.js
import { PilotSwarmClient, PilotSwarmWorker, defineTool } from "../dist/index.js";

const token = process.env.GITHUB_TOKEN;
if (!token) { console.error("GITHUB_TOKEN required"); process.exit(1); }

const STORE = process.env.DATABASE_URL || "sqlite";

async function main() {
    const worker = new PilotSwarmWorker({ store: STORE, githubToken: token });
    
    worker.registerTools([
        defineTool("get_system_stats", {
            description: "Get runtime statistics",
            parameters: { type: "object", properties: {} },
            handler: async () => JSON.stringify({ total: 3, running: 1, waiting: 2 }),
        }),
    ]);
    
    await worker.start();
    
    const client = new PilotSwarmClient({ store: STORE });
    await client.start();
    
    const session = await client.createSession({
        systemMessage: {
            mode: "replace",
            content: "# PilotSwarm Agent\n\nYou are the PilotSwarm Agent. Be concise and direct.",
        },
        toolNames: ["get_system_stats"],
    });
    
    // Forward tools to co-located worker
    worker.setSessionConfig(session.sessionId, {
        toolNames: ["get_system_stats"],
    });
    
    console.log("Session created:", session.sessionId.slice(0, 8));
    
    session.on("session.error", (ev) => {
        console.log("SESSION ERROR:", JSON.stringify(ev.data).slice(0, 500));
    });

    try {
        const result = await session.sendAndWait("Hello, what are you?", { timeout: 120000 });
        console.log("RESULT:", result?.slice(0, 300));
    } catch (err) {
        console.error("FAILED:", err.message);
    }
    
    await client.stop();
    await worker.stop();
    process.exit(0);
}

main().catch(e => { console.error("MAIN ERR:", e.message); process.exit(1); });
