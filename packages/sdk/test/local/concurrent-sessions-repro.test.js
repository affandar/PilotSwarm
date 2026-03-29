/**
 * Repro: concurrent orchestrations on 6 SEPARATE PROCESSES with isolated filesystems.
 *
 * Each worker runs in its own child_process.fork() — matching AKS where each
 * pod is a separate OS process with its own duroxide runtime, its own
 * session-affinity tracking, and its own local filesystem.
 *
 * Run: set -a && source ../../.env && set +a && npx vitest run test/local/concurrent-sessions-repro.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { mkdirSync } from "node:fs";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { PilotSwarmClient } from "../helpers/local-workers.js";
import { assertIncludesAny } from "../helpers/assertions.js";

const TIMEOUT = 180_000;
const WORKER_COUNT = 6;
const getEnv = useSuiteEnv(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORKER_SCRIPT = resolve(__dirname, "../helpers/worker-process.js");
const WORKSPACE_ROOT = resolve(__dirname, "../../../../");

beforeAll(async () => { await preflightChecks(); });

/**
 * Fork N worker child processes, each with its own sessionStateDir.
 * Returns { workers, cleanup }.
 */
function forkWorkers(env, n) {
    const children = [];

    for (let i = 0; i < n; i++) {
        const dir = `${env.sessionStateDir}-proc-w${i}`;
        mkdirSync(dir, { recursive: true });

        const child = fork(WORKER_SCRIPT, [], {
            cwd: WORKSPACE_ROOT,
            env: { ...process.env },
            stdio: ["pipe", "pipe", "pipe", "ipc"],
        });

        // Log child stderr for debugging
        child.stderr.on("data", (data) => {
            const line = data.toString().trim();
            if (line && !line.includes("ExperimentalWarning")) {
                console.log(`    [w${i} stderr] ${line}`);
            }
        });

        children.push({
            child,
            dir,
            nodeId: `proc-w${i}`,
            ready: false,
        });
    }

    return {
        children,
        async startAll() {
            // Start workers one at a time to avoid schema creation races.
            // The first worker creates the duroxide/CMS/facts schemas;
            // subsequent workers just connect.
            for (const w of children) {
                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(
                        () => reject(new Error(`Worker ${w.nodeId} did not start in 30s`)),
                        30_000,
                    );
                    w.child.on("message", function handler(msg) {
                        if (msg.type === "ready") {
                            w.ready = true;
                            clearTimeout(timeout);
                            w.child.removeListener("message", handler);
                            resolve(msg);
                        } else if (msg.type === "error") {
                            clearTimeout(timeout);
                            w.child.removeListener("message", handler);
                            reject(new Error(`Worker ${w.nodeId} failed: ${msg.error}`));
                        }
                    });
                    w.child.on("error", (err) => {
                        clearTimeout(timeout);
                        reject(err);
                    });

                    w.child.send({
                        type: "start",
                        store: env.store,
                        githubToken: process.env.GITHUB_TOKEN,
                        duroxideSchema: env.duroxideSchema,
                        cmsSchema: env.cmsSchema,
                        factsSchema: env.factsSchema,
                        sessionStateDir: w.dir,
                        workerNodeId: w.nodeId,
                        logLevel: process.env.DUROXIDE_LOG_LEVEL || "warn",
                    });
                });
            }
            console.log(`    All ${n} worker processes ready.`);
        },
        async stopAll() {
            for (const w of children) {
                try {
                    w.child.send({ type: "stop" });
                } catch {}
            }
            // Give them a moment to shut down
            await new Promise((r) => setTimeout(r, 2000));
            for (const w of children) {
                try {
                    w.child.kill("SIGTERM");
                } catch {}
            }
        },
    };
}

async function runMultiProcessRound(env, round, sessionCount) {
    console.log(`\n  ── Round ${round}: ${sessionCount} sessions on ${WORKER_COUNT} separate processes ──`);
    let failed = false;
    let failureDetail = "";

    const pool = forkWorkers(env, WORKER_COUNT);

    try {
        await pool.startAll();

        // Client runs in this (parent) process — only talks to DB
        const client = new PilotSwarmClient({
            store: env.store,
            duroxideSchema: env.duroxideSchema,
            cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema,
        });
        await client.start();

        try {
            // Create all sessions concurrently
            const sessions = await Promise.all(
                Array.from({ length: sessionCount }, () =>
                    client.createSession({
                        systemMessage: {
                            mode: "replace",
                            content: "Answer in one word only. No punctuation. No explanation.",
                        },
                    }),
                ),
            );

            for (const [i, s] of sessions.entries()) {
                console.log(`    session[${i}] = ${s.sessionId}`);
            }

            // Turn 0
            const questions1 = [
                "What is the capital of France?",
                "What is the capital of Germany?",
                "What is the capital of Japan?",
                "What is the capital of Italy?",
                "What is the capital of Spain?",
                "What is the capital of Brazil?",
            ].slice(0, sessionCount);

            console.log(`    Sending ${sessionCount} turn-0 prompts concurrently...`);
            const responses1 = await Promise.allSettled(
                sessions.map((s, i) => s.sendAndWait(questions1[i], TIMEOUT)),
            );

            for (const [i, r] of responses1.entries()) {
                if (r.status === "fulfilled") {
                    console.log(`    [${i}] turn 0: "${r.value}"`);
                } else {
                    console.log(`    [${i}] turn 0 FAILED: ${r.reason?.message ?? r.reason}`);
                    failed = true;
                    failureDetail += `Round ${round} session ${i} turn 0: ${r.reason?.message}\n`;
                }
            }

            // Turn 1 — requires resuming Copilot session after continueAsNew
            const questions2 = [
                "What is the capital of Australia?",
                "What is the capital of Canada?",
                "What is the capital of Mexico?",
                "What is the capital of Egypt?",
                "What is the capital of India?",
                "What is the capital of China?",
            ].slice(0, sessionCount);

            console.log(`    Sending ${sessionCount} turn-1 prompts concurrently...`);
            const responses2 = await Promise.allSettled(
                sessions.map((s, i) => s.sendAndWait(questions2[i], TIMEOUT)),
            );

            for (const [i, r] of responses2.entries()) {
                if (r.status === "fulfilled") {
                    console.log(`    [${i}] turn 1: "${r.value}"`);
                } else {
                    console.log(`    [${i}] turn 1 FAILED: ${r.reason?.message ?? r.reason}`);
                    failed = true;
                    failureDetail += `Round ${round} session ${i} turn 1: ${r.reason?.message}\n`;
                }
            }

            // Turn 2 — one more round
            const questions3 = [
                "What is the capital of Russia?",
                "What is the capital of Turkey?",
                "What is the capital of Greece?",
                "What is the capital of Sweden?",
                "What is the capital of Norway?",
                "What is the capital of Finland?",
            ].slice(0, sessionCount);

            console.log(`    Sending ${sessionCount} turn-2 prompts concurrently...`);
            const responses3 = await Promise.allSettled(
                sessions.map((s, i) => s.sendAndWait(questions3[i], TIMEOUT)),
            );

            for (const [i, r] of responses3.entries()) {
                if (r.status === "fulfilled") {
                    console.log(`    [${i}] turn 2: "${r.value}"`);
                } else {
                    console.log(`    [${i}] turn 2 FAILED: ${r.reason?.message ?? r.reason}`);
                    failed = true;
                    failureDetail += `Round ${round} session ${i} turn 2: ${r.reason?.message}\n`;
                }
            }
        } finally {
            await client.stop();
        }
    } finally {
        await pool.stopAll();
    }

    return { failed, failureDetail };
}

describe("Concurrent session repro (6 separate processes)", () => {
    it("4 concurrent sessions × 3 rounds on 6 worker processes", async () => {
        const env = getEnv();
        const allFailures = [];

        for (let round = 1; round <= 3; round++) {
            const result = await runMultiProcessRound(env, round, 4);
            if (result.failed) allFailures.push(result.failureDetail);
            // Reset env between rounds
            await env.reset();
        }

        if (allFailures.length > 0) {
            console.log("\n  ══ FAILURES DETECTED ══");
            for (const f of allFailures) console.log(f);
            // Don't throw — report the failures as findings
            console.log(`\n  ${allFailures.length}/3 rounds had failures.`);
        } else {
            console.log("\n  All 3 rounds passed — no cross-process affinity failures.");
        }
    }, TIMEOUT * 5);
});
