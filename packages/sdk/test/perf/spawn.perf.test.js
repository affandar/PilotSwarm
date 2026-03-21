/**
 * Spawn performance measurements.
 *
 * This suite is intentionally excluded from the standard local test run:
 * `vitest.config.js` only includes tests under `test/local`.
 *
 * Run:
 *   node --env-file=../../.env ../../node_modules/vitest/vitest.mjs run test/perf/spawn.perf.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { assert, assertGreaterOrEqual, assertNotNull } from "../helpers/assertions.js";
import { createCatalog, getEvents } from "../helpers/cms-helpers.js";

const TIMEOUT = 240_000;
const POLL_INTERVAL_MS = 100;

const MULTI_SPAWN_COORDINATOR_CONFIG = {
    systemMessage: {
        mode: "replace",
        content:
            "You are a coordination agent. " +
            "When the user asks you to spawn multiple sub-agents, you MUST issue exactly one spawn_agent tool call per listed task in the same turn. " +
            "Never merge tasks, never solve the delegated tasks yourself, never ask follow-up questions, and never call wait_for_agents unless the user explicitly asks. " +
            "After the tool calls finish, reply with one short confirmation sentence.",
    },
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function childSessionStarted(row) {
    return Boolean(row.orchestrationId) && row.state !== "pending";
}

async function listChildSessions(catalog, parentSessionId) {
    const sessions = await catalog.listSessions();
    return sessions.filter((session) => session.parentSessionId === parentSessionId);
}

async function waitForNewChildren(
    catalog,
    parentSessionId,
    expectedNewChildren,
    timeoutMs = TIMEOUT,
    pollIntervalMs = POLL_INTERVAL_MS,
) {
    const baselineChildren = await listChildSessions(catalog, parentSessionId);
    const baselineIds = new Set(baselineChildren.map((child) => child.sessionId));
    const startedBaselineIds = new Set(
        baselineChildren.filter(childSessionStarted).map((child) => child.sessionId),
    );
    const deadline = Date.now() + timeoutMs;
    const startedAt = Date.now();
    const visibleAtMs = {};
    const startedAtMs = {};
    const countChanges = [];
    let lastVisibleCount = -1;
    let lastStartedCount = -1;
    let latestChildren = baselineChildren;

    while (Date.now() < deadline) {
        latestChildren = await listChildSessions(catalog, parentSessionId);
        const newChildren = latestChildren.filter((child) => !baselineIds.has(child.sessionId));
        const startedChildren = newChildren.filter(
            (child) => !startedBaselineIds.has(child.sessionId) && childSessionStarted(child),
        );

        if (newChildren.length !== lastVisibleCount) {
            lastVisibleCount = newChildren.length;
            countChanges.push({
                atMs: Date.now() - startedAt,
                visibleCount: newChildren.length,
                startedCount: startedChildren.length,
            });
        } else if (startedChildren.length !== lastStartedCount) {
            countChanges.push({
                atMs: Date.now() - startedAt,
                visibleCount: newChildren.length,
                startedCount: startedChildren.length,
            });
        }
        lastStartedCount = startedChildren.length;

        for (let i = 1; i <= newChildren.length; i++) {
            if (visibleAtMs[i] == null) visibleAtMs[i] = Date.now() - startedAt;
        }
        for (let i = 1; i <= startedChildren.length; i++) {
            if (startedAtMs[i] == null) startedAtMs[i] = Date.now() - startedAt;
        }

        if (newChildren.length >= expectedNewChildren && startedChildren.length >= expectedNewChildren) {
            return {
                allChildren: latestChildren,
                newChildren,
                visibleAtMs,
                startedAtMs,
                countChanges,
            };
        }

        await sleep(pollIntervalMs);
    }

    const finalChildren = await listChildSessions(catalog, parentSessionId);
    const finalNewChildren = finalChildren.filter((child) => !baselineIds.has(child.sessionId));
    throw new Error(
        `Timed out waiting for ${expectedNewChildren} new child session(s). ` +
        `Visible=${finalNewChildren.length}, started=${finalNewChildren.filter(childSessionStarted).length}`,
    );
}

function countSpawnToolCalls(events) {
    return events.filter((event) => {
        if (event.eventType !== "tool.execution_start") return false;
        const data = event.data ?? {};
        return (data.toolName ?? data.name) === "spawn_agent";
    }).length;
}

function formatMilestones(milestones) {
    const entries = Object.entries(milestones)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([count, ms]) => `${count}:${ms}ms`);
    return entries.length > 0 ? entries.join(", ") : "(none)";
}

function formatCountChanges(changes) {
    return changes
        .map((entry) => `+${entry.atMs}ms visible=${entry.visibleCount} started=${entry.startedCount}`)
        .join(" | ");
}

function milestoneGaps(milestones) {
    const values = Object.keys(milestones)
        .sort((a, b) => Number(a) - Number(b))
        .map((key) => milestones[key]);
    if (values.length === 0) return [];
    return values.map((value, index) => index === 0 ? value : value - values[index - 1]);
}

function printPerfSummary(label, metrics, extra = {}) {
    const summary = {
        label,
        turnMs: metrics.turnMs,
        visibleAtMs: metrics.visibleAtMs,
        startedAtMs: metrics.startedAtMs,
        visibleGapsMs: milestoneGaps(metrics.visibleAtMs),
        startedGapsMs: milestoneGaps(metrics.startedAtMs),
        childCountChanges: metrics.countChanges,
        newChildren: metrics.newChildren.length,
        responsePreview: String(metrics.response).slice(0, 160),
        ...extra,
    };
    console.log(`  [perf:${label}] ${JSON.stringify(summary)}`);
}

async function measureSpawnTurn({
    session,
    catalog,
    prompt,
    expectedNewChildren,
    timeoutMs = TIMEOUT,
}) {
    const turnStartedAt = Date.now();
    const turnPromise = session.sendAndWait(prompt, timeoutMs);
    const childPromise = waitForNewChildren(
        catalog,
        session.sessionId,
        expectedNewChildren,
        timeoutMs,
    );
    const [response, childMetrics] = await Promise.all([turnPromise, childPromise]);
    const turnMs = Date.now() - turnStartedAt;

    return {
        response,
        turnMs,
        ...childMetrics,
    };
}

async function measureSingleSpawn(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(MULTI_SPAWN_COORDINATOR_CONFIG);
            assertNotNull(session, "parent session created");

            const metrics = await measureSpawnTurn({
                session,
                catalog,
                prompt:
                    "Spawn exactly one sub-agent right now. " +
                    "Task 1: say the word baseline and nothing else. " +
                    "Use the spawn_agent tool before replying.",
                expectedNewChildren: 1,
            });

            const events = await getEvents(catalog, session.sessionId);
            const spawnToolCalls = countSpawnToolCalls(events);

            printPerfSummary("single", metrics, { spawnToolCalls });
            console.log(`  [single] visible milestones: ${formatMilestones(metrics.visibleAtMs)}`);
            console.log(`  [single] started milestones: ${formatMilestones(metrics.startedAtMs)}`);
            console.log(`  [single] child count changes: ${formatCountChanges(metrics.countChanges)}`);

            assertGreaterOrEqual(metrics.newChildren.length, 1, "single-spawn child count");
            assertGreaterOrEqual(spawnToolCalls, 1, "single-spawn tool call count");
        });
    } finally {
        await catalog.close();
    }
}

async function measureSequentialSpawns(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(MULTI_SPAWN_COORDINATOR_CONFIG);
            assertNotNull(session, "parent session created");

            const prompts = [
                "Spawn exactly one sub-agent right now. Task 1: say alpha and nothing else. Use the spawn_agent tool before replying.",
                "Spawn exactly one sub-agent right now. Task 1: say beta and nothing else. Use the spawn_agent tool before replying.",
                "Spawn exactly one sub-agent right now. Task 1: say gamma and nothing else. Use the spawn_agent tool before replying.",
            ];

            const perTurn = [];
            const startedAt = Date.now();

            for (let i = 0; i < prompts.length; i++) {
                const metrics = await measureSpawnTurn({
                    session,
                    catalog,
                    prompt: prompts[i],
                    expectedNewChildren: 1,
                });
                perTurn.push({
                    turnMs: metrics.turnMs,
                    visibleAtMs: metrics.visibleAtMs,
                    startedAtMs: metrics.startedAtMs,
                });
                printPerfSummary(`sequential-turn-${i + 1}`, metrics);
            }

            const totalMs = Date.now() - startedAt;
            const children = await listChildSessions(catalog, session.sessionId);
            const events = await getEvents(catalog, session.sessionId);
            const spawnToolCalls = countSpawnToolCalls(events);

            console.log(`  [perf:sequential-total] ${JSON.stringify({
                totalMs,
                childCount: children.length,
                spawnToolCalls,
                perTurn,
            })}`);

            assertGreaterOrEqual(children.length, 3, "sequential child count");
            assertGreaterOrEqual(spawnToolCalls, 3, "sequential spawn_agent tool calls");
        });
    } finally {
        await catalog.close();
    }
}

async function measureSameTurnFanout(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession(MULTI_SPAWN_COORDINATOR_CONFIG);
            assertNotNull(session, "parent session created");

            const metrics = await measureSpawnTurn({
                session,
                catalog,
                prompt:
                    "Spawn exactly three sub-agents in this same turn, using three separate spawn_agent tool calls before you reply. " +
                    "Do not merge tasks and do not wait for them. " +
                    "Tasks: " +
                    "1. say red and nothing else. " +
                    "2. say green and nothing else. " +
                    "3. say blue and nothing else.",
                expectedNewChildren: 3,
            });

            const events = await getEvents(catalog, session.sessionId);
            const spawnToolCalls = countSpawnToolCalls(events);

            printPerfSummary("same-turn-fanout", metrics, { spawnToolCalls });
            console.log(`  [same-turn] visible milestones: ${formatMilestones(metrics.visibleAtMs)}`);
            console.log(`  [same-turn] started milestones: ${formatMilestones(metrics.startedAtMs)}`);
            console.log(`  [same-turn] child count changes: ${formatCountChanges(metrics.countChanges)}`);

            assertGreaterOrEqual(metrics.newChildren.length, 3, "same-turn child count");
            assertGreaterOrEqual(spawnToolCalls, 3, "same-turn spawn_agent tool calls");
            assert(
                Object.keys(metrics.visibleAtMs).length >= 3,
                "same-turn child visibility milestones recorded",
            );
        });
    } finally {
        await catalog.close();
    }
}

describe("Perf: Spawn", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Single Spawn", { timeout: TIMEOUT * 2 }, async () => {
        const env = createTestEnv("spawn-perf");
        try { await measureSingleSpawn(env); } finally { await env.cleanup(); }
    });

    it("Sequential Spawns", { timeout: TIMEOUT * 3 }, async () => {
        const env = createTestEnv("spawn-perf");
        try { await measureSequentialSpawns(env); } finally { await env.cleanup(); }
    });

    it("Same-Turn Fanout", { timeout: TIMEOUT * 3 }, async () => {
        const env = createTestEnv("spawn-perf");
        try { await measureSameTurnFanout(env); } finally { await env.cleanup(); }
    });
});
