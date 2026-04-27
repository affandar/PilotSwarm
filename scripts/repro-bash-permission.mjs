#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import {
    PilotSwarmClient,
    PilotSwarmWorker,
} from "../packages/sdk/dist/index.js";
import { approvePermissionForSession } from "../packages/sdk/dist/permissions.js";

const DATABASE_URL = process.env.DATABASE_URL;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const TIMEOUT_MS = Number(process.env.BASH_PERMISSION_REPRO_TIMEOUT_MS || 180_000);
const KEEP_STATE = process.argv.includes("--keep-state");
const COMMAND = "printf 'permission-probe\\n' > permission-probe.txt && cat permission-probe.txt";

if (!DATABASE_URL) {
    console.error("DATABASE_URL not set. Run with: node --env-file=.env scripts/repro-bash-permission.mjs");
    process.exit(1);
}

function sanitizeLabel(value) {
    return String(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 20) || "bash_permission";
}

function createEnv(label) {
    const runId = randomBytes(4).toString("hex");
    const safeLabel = sanitizeLabel(label);
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-bash-permission-"));
    const sessionStateDir = path.join(baseDir, "session-state");
    const workingDirectory = path.join(baseDir, "workdir");
    fs.mkdirSync(sessionStateDir, { recursive: true });
    fs.mkdirSync(workingDirectory, { recursive: true });

    return {
        store: DATABASE_URL,
        duroxideSchema: `ps_repro_drx_${safeLabel}_${runId}`,
        cmsSchema: `ps_repro_cms_${safeLabel}_${runId}`,
        factsSchema: `ps_repro_facts_${safeLabel}_${runId}`,
        baseDir,
        sessionStateDir,
        workingDirectory,
    };
}

async function dropSchemas(env) {
    const client = new pg.Client({ connectionString: DATABASE_URL });
    try {
        await client.connect();
        await client.query(`DROP SCHEMA IF EXISTS "${env.duroxideSchema}" CASCADE`);
        await client.query(`DROP SCHEMA IF EXISTS "${env.cmsSchema}" CASCADE`);
        await client.query(`DROP SCHEMA IF EXISTS "${env.factsSchema}" CASCADE`);
    } finally {
        try { await client.end(); } catch {}
    }
}

async function cleanupEnv(env) {
    if (KEEP_STATE) {
        console.log(`[cleanup] keeping repro state at ${env.baseDir}`);
        console.log(`[cleanup] keeping schemas ${env.duroxideSchema}, ${env.cmsSchema}, ${env.factsSchema}`);
        return;
    }

    try {
        await dropSchemas(env);
    } catch (err) {
        console.warn(`[cleanup] schema drop failed: ${err?.message || err}`);
    }
    try {
        fs.rmSync(env.baseDir, { recursive: true, force: true });
    } catch (err) {
        console.warn(`[cleanup] temp directory removal failed: ${err?.message || err}`);
    }
}

function summarizePermissionRequest(request, invocation, result) {
    return {
        requestKind: request?.kind ?? null,
        toolName: request?.toolName ?? null,
        fullCommandText: request?.fullCommandText ?? null,
        command: request?.command ?? null,
        sessionId: invocation?.sessionId ?? null,
        resultKind: result?.kind ?? null,
        resultApproval: result?.approval ?? null,
    };
}

async function run() {
    const env = createEnv("bash_permission");
    const permissionLog = [];
    const worker = new PilotSwarmWorker({
        store: env.store,
        githubToken: GITHUB_TOKEN,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        sessionStateDir: env.sessionStateDir,
        workerNodeId: "bash-permission-repro-worker",
        disableManagementAgents: true,
        logLevel: process.env.DUROXIDE_LOG_LEVEL || "error",
    });
    const client = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        ...(worker.sessionPolicy ? { sessionPolicy: worker.sessionPolicy } : {}),
        ...(worker.allowedAgentNames?.length ? { allowedAgentNames: worker.allowedAgentNames } : {}),
    });

    try {
        console.log(`[setup] session state: ${env.sessionStateDir}`);
        console.log(`[setup] working directory: ${env.workingDirectory}`);
        await worker.start();
        await client.start();

        const sessionConfig = {
            workingDirectory: env.workingDirectory,
            systemMessage: {
                mode: "append",
                content:
                    "For this diagnostic turn, use the built-in bash tool when asked to run the shell command. " +
                    "Do not use apply_patch, create, edit, or PilotSwarm tools for the diagnostic command.",
            },
            onPermissionRequest: async (request, invocation) => {
                const result = approvePermissionForSession(request);
                const entry = summarizePermissionRequest(request, invocation, result);
                permissionLog.push(entry);
                console.log(`[permission] ${JSON.stringify(entry)}`);
                return result;
            },
        };

        const session = await client.createSession({
            workingDirectory: sessionConfig.workingDirectory,
            systemMessage: sessionConfig.systemMessage,
        });
        worker.setSessionConfig(session.sessionId, sessionConfig);

        const prompt =
            "Call the built-in bash tool exactly once with this command:\n\n" +
            `${COMMAND}\n\n` +
            "After the tool returns, reply with the exact command output and no extra prose.";

        console.log(`[session] ${session.sessionId}`);
        console.log(`[prompt] requesting built-in bash command: ${COMMAND}`);
        const response = await session.sendAndWait(prompt, TIMEOUT_MS);
        const probePath = path.join(env.workingDirectory, "permission-probe.txt");
        const probeExists = fs.existsSync(probePath);
        const probeText = probeExists ? fs.readFileSync(probePath, "utf8") : "";

        console.log(`[response] ${JSON.stringify(response)}`);
        console.log(`[probe-file] exists=${probeExists} text=${JSON.stringify(probeText)}`);
        console.log(`[permission-count] ${permissionLog.length}`);

        if (permissionLog.length === 0) {
            console.error("[result] no permission request was observed; the built-in bash path may not have been exercised");
            process.exitCode = 2;
        } else if (!permissionLog.some((entry) => entry.resultKind === "approve-for-session")) {
            console.error("[result] permission handler did not return the SDK session approval shape");
            process.exitCode = 3;
        } else if (!probeExists) {
            console.error("[result] permission was approved, but the shell command did not create the probe file");
            process.exitCode = 4;
        } else {
            console.log("[result] built-in bash command completed after session-scoped SDK approval");
        }
    } catch (err) {
        console.error(`[error] ${err?.stack || err?.message || err}`);
        if (String(err?.message || err).includes("unexpected user permission response")) {
            console.error("[diagnosis] reproduced the SDK/CLI permission response protocol mismatch");
        }
        if (permissionLog.length > 0) {
            console.error(`[permission-log] ${JSON.stringify(permissionLog, null, 2)}`);
        }
        process.exitCode = 1;
    } finally {
        try { await client.stop(); } catch {}
        try { await worker.stop(); } catch {}
        await cleanupEnv(env);
    }
}

await run();
