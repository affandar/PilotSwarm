/**
 * Local worker helpers for integration tests.
 *
 * Provides utilities for starting/stopping one or two PilotSwarmWorker
 * instances with isolated schemas and shared session-state directories.
 */

import { PilotSwarmClient, PilotSwarmWorker, PilotSwarmManagementClient, defineTool, composeSystemPrompt } from "../../dist/index.js";

// ─── Single Worker + Client ──────────────────────────────────────

/**
 * Create and start a co-located worker + client pair using isolated schemas.
 *
 * @param {object} env      - Test environment from createTestEnv()
 * @param {object} [opts]   - Additional worker/client options
 * @param {Function} fn     - async (client, worker) => { ... }
 */
export async function withClient(env, opts, fn) {
    if (typeof opts === "function") {
        fn = opts;
        opts = {};
    }

    const worker = new PilotSwarmWorker({
        store: env.store,
        githubToken: process.env.GITHUB_TOKEN,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        sessionStateDir: env.sessionStateDir,
        workerNodeId: opts.workerNodeId || "test-worker-a",
        disableManagementAgents: true,
        logLevel: process.env.DUROXIDE_LOG_LEVEL || "error",
        ...(opts.worker || {}),
    });

    if (opts.tools) worker.registerTools(opts.tools);
    await worker.start();

    const client = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        // Auto-forward policy + agent names from co-located worker
        ...(worker.sessionPolicy ? { sessionPolicy: worker.sessionPolicy } : {}),
        ...(worker.allowedAgentNames?.length ? { allowedAgentNames: worker.allowedAgentNames } : {}),
        ...(opts.client || {}),
    });
    await client.start();

    // Auto-forward tools/hooks to co-located worker
    const origCreate = client.createSession.bind(client);
    client.createSession = async (config) => {
        const session = await origCreate(config);
        if (config) worker.setSessionConfig(session.sessionId, config);
        return session;
    };

    try {
        await fn(client, worker);
    } finally {
        await client.stop();
        await worker.stop();
    }
}

// ─── Two Workers + Client ────────────────────────────────────────

/**
 * Create and start two workers + one client, all sharing the same database
 * and session-state directory.
 *
 * @param {object} env    - Test environment from createTestEnv()
 * @param {object} [opts] - Additional options
 * @param {Function} fn   - async (client, workerA, workerB) => { ... }
 */
export async function withTwoWorkers(env, opts, fn) {
    if (typeof opts === "function") {
        fn = opts;
        opts = {};
    }

    const commonWorkerOpts = {
        store: env.store,
        githubToken: process.env.GITHUB_TOKEN,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        sessionStateDir: env.sessionStateDir,
    };

    const workerA = new PilotSwarmWorker({
        ...commonWorkerOpts,
        workerNodeId: "local-a",
        disableManagementAgents: true,
        ...(opts.workerA || {}),
    });

    const workerB = new PilotSwarmWorker({
        ...commonWorkerOpts,
        workerNodeId: "local-b",
        disableManagementAgents: true,
        ...(opts.workerB || {}),
    });

    if (opts.tools) {
        workerA.registerTools(opts.tools);
        workerB.registerTools(opts.tools);
    }

    await workerA.start();
    await workerB.start();

    const client = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        ...(opts.client || {}),
    });
    await client.start();

    try {
        await fn(client, workerA, workerB);
    } finally {
        await client.stop();
        await workerB.stop();
        await workerA.stop();
    }
}

// ─── Management Client ──────────────────────────────────────────

/**
 * Create and start a management client with the same schemas as the test env.
 */
export async function createManagementClient(env) {
    const mgmt = new PilotSwarmManagementClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
    });
    await mgmt.start();
    return mgmt;
}

// ─── Re-exports ─────────────────────────────────────────────────

export { PilotSwarmClient, PilotSwarmWorker, PilotSwarmManagementClient, defineTool, composeSystemPrompt };
