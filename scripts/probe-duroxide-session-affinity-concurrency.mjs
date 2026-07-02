#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client, Runtime, SqliteProvider, PostgresProvider } from "duroxide";
import pg from "pg";

const WORKER_COUNT = 6;
const ATTEMPTS = 5;
const ABORT_TIMEOUT_MS = 1_500;
const LONG_HOLD_TIMEOUT_MS = 8_000;
const USE_POSTGRES = process.argv.includes("--postgres");
const WORKER_CONCURRENCY = Number(process.env.PROBE_WORKER_CONCURRENCY || 32);
const ORCHESTRATION_CONCURRENCY = Number(process.env.PROBE_ORCHESTRATION_CONCURRENCY || 16);
const MAX_SESSIONS_PER_RUNTIME = Number(process.env.PROBE_MAX_SESSIONS_PER_RUNTIME || 64);
const SET_STABLE_WORKER_NODE_ID = process.env.PROBE_STABLE_WORKER_NODE_ID !== "0";

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs, label) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const value = predicate();
        if (value) return value;
        await delay(25);
    }
    throw new Error(`Timed out waiting for ${label}`);
}

function withTimeout(promise, timeoutMs) {
    let timeout;
    const timed = new Promise((resolve) => {
        timeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    });
    return Promise.race([
        promise.then((value) => ({ timedOut: false, value })),
        timed,
    ]).finally(() => clearTimeout(timeout));
}

function parseOutput(status) {
    if (status?.output == null) return null;
    return typeof status.output === "string" ? JSON.parse(status.output) : status.output;
}

async function main() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "duroxide-affinity-probe-"));
    const schema = `duroxide_probe_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    let pgClient = null;
    if (USE_POSTGRES && !process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required for --postgres");
    }
    const provider = USE_POSTGRES
        ? await PostgresProvider.connectWithSchema(process.env.DATABASE_URL, schema)
        : await SqliteProvider.open(`sqlite:${path.join(tempDir, "probe.db")}`);
    if (USE_POSTGRES) {
        pgClient = new pg.Client({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.DATABASE_URL.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
        });
        await pgClient.connect();
    }
    const client = new Client(provider);
    const attempts = new Map();
    const runtimeHandles = [];

    function getAttempt(attemptId) {
        let attempt = attempts.get(attemptId);
        if (!attempt) {
            attempt = {
                attemptId,
                longStarted: false,
                longEnded: false,
                releaseLong: false,
                longWorker: null,
                abortWorker: null,
                abortStartedWhileLongActive: null,
                longStartedAt: null,
                abortStartedAt: null,
                longEndedAt: null,
            };
            attempts.set(attemptId, attempt);
        }
        return attempt;
    }

    for (let index = 0; index < WORKER_COUNT; index += 1) {
        const workerId = `worker-${index + 1}`;
        const runtime = new Runtime(provider, {
            workerConcurrency: WORKER_CONCURRENCY,
            orchestrationConcurrency: ORCHESTRATION_CONCURRENCY,
            maxSessionsPerRuntime: MAX_SESSIONS_PER_RUNTIME,
            dispatcherPollIntervalMs: 25,
            ...(SET_STABLE_WORKER_NODE_ID ? { workerNodeId: workerId } : {}),
        });

        runtime.registerActivity("longTurn", async (_ctx, input) => {
            const attempt = getAttempt(input.attemptId);
            attempt.longStarted = true;
            attempt.longWorker = workerId;
            attempt.longStartedAt = Date.now();
            const deadline = Date.now() + LONG_HOLD_TIMEOUT_MS;
            while (!attempt.releaseLong && Date.now() < deadline) {
                await delay(25);
            }
            attempt.longEnded = true;
            attempt.longEndedAt = Date.now();
            return {
                activity: "longTurn",
                workerId,
                released: attempt.releaseLong,
            };
        });

        runtime.registerActivity("abortTurn", async (_ctx, input) => {
            const attempt = getAttempt(input.attemptId);
            attempt.abortWorker = workerId;
            attempt.abortStartedAt = Date.now();
            attempt.abortStartedWhileLongActive = attempt.longStarted && !attempt.longEnded;
            return {
                activity: "abortTurn",
                workerId,
                longWorker: attempt.longWorker,
                startedWhileLongActive: attempt.abortStartedWhileLongActive,
            };
        });

        runtime.registerOrchestration("LongTurnProbe", function* (ctx, input) {
            return yield ctx.scheduleActivityOnSession("longTurn", input, input.affinityKey);
        });

        runtime.registerOrchestration("AbortTurnProbe", function* (ctx, input) {
            return yield ctx.scheduleActivityOnSession("abortTurn", input, input.affinityKey);
        });

        await runtime.start();
        runtimeHandles.push(runtime);
    }

    const results = [];
    try {
        for (let attemptIndex = 0; attemptIndex < ATTEMPTS; attemptIndex += 1) {
            const attemptId = `attempt-${attemptIndex + 1}-${Date.now()}`;
            const affinityKey = `stop-probe-session-${attemptIndex + 1}`;
            const longInstanceId = `long-${attemptId}`;
            const abortInstanceId = `abort-${attemptId}`;

            await client.startOrchestration(longInstanceId, "LongTurnProbe", { attemptId, affinityKey });
            await waitUntil(() => getAttempt(attemptId).longStarted, 5_000, `${attemptId} longTurn start`);
            await client.startOrchestration(abortInstanceId, "AbortTurnProbe", { attemptId, affinityKey });

            const abortBeforeRelease = await withTimeout(
                client.waitForOrchestration(abortInstanceId, ABORT_TIMEOUT_MS),
                ABORT_TIMEOUT_MS,
            );
            const attemptBeforeRelease = { ...getAttempt(attemptId) };
            getAttempt(attemptId).releaseLong = true;
            const longStatus = await client.waitForOrchestration(longInstanceId, 10_000);
            const abortStatus = abortBeforeRelease.timedOut
                ? await client.waitForOrchestration(abortInstanceId, 10_000)
                : abortBeforeRelease.value;
            const attempt = getAttempt(attemptId);

            results.push({
                attemptId,
                affinityKey,
                abortCompletedBeforeLongRelease: !abortBeforeRelease.timedOut,
                sameWorker: attempt.longWorker === attempt.abortWorker,
                longWorker: attempt.longWorker,
                abortWorker: attempt.abortWorker,
                abortStartedWhileLongActive: Boolean(attemptBeforeRelease.abortStartedWhileLongActive),
                abortStartedBeforeLongEnded: Boolean(attempt.abortStartedAt && attempt.longEndedAt && attempt.abortStartedAt < attempt.longEndedAt),
                longOutput: parseOutput(longStatus),
                abortOutput: parseOutput(abortStatus),
            });
        }
    } finally {
        for (const runtime of runtimeHandles.reverse()) {
            await runtime.shutdown(5_000).catch(() => {});
        }
        if (pgClient) {
            await pgClient.query(`drop schema if exists ${schema} cascade`).catch(() => {});
            await pgClient.end().catch(() => {});
        }
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }

    const sameWorkerCount = results.filter((result) => result.sameWorker).length;
    const concurrentCount = results.filter((result) => result.abortCompletedBeforeLongRelease && result.abortStartedWhileLongActive).length;
    const summary = {
        provider: USE_POSTGRES ? "postgres" : "sqlite",
        ...(USE_POSTGRES ? { schema } : {}),
        workerCount: WORKER_COUNT,
        attempts: ATTEMPTS,
        workerConcurrency: WORKER_CONCURRENCY,
        orchestrationConcurrency: ORCHESTRATION_CONCURRENCY,
        maxSessionsPerRuntime: MAX_SESSIONS_PER_RUNTIME,
        stableWorkerNodeId: SET_STABLE_WORKER_NODE_ID,
        sameWorkerCount,
        concurrentCount,
        sameWorkerAllAttempts: sameWorkerCount === ATTEMPTS,
        concurrentAllAttempts: concurrentCount === ATTEMPTS,
        results,
    };

    console.log(JSON.stringify(summary, null, 2));

    if (!summary.sameWorkerAllAttempts) {
        console.error("FAIL: same-affinity activities did not consistently land on the same worker.");
        process.exit(1);
    }
    if (!summary.concurrentAllAttempts) {
        console.error("FAIL: same-affinity abortTurn did not start while longTurn was still executing.");
        process.exit(2);
    }
}

main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
});