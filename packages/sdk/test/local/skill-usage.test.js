/**
 * Skill Usage Stats — CMS provider, read_facts interception, and aggregation.
 *
 * Verifies migration 0005 stored procs and the learned_skill.read event
 * emitted by the read_facts tool wrapper. We exercise the catalog
 * directly (no LLM) so the test is fast and deterministic.
 *
 * Run: npx vitest run test/local/skill-usage.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createFactTools, PgFactStore } from "../../src/index.ts";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import {
    assert,
    assertEqual,
    assertGreaterOrEqual,
    assertNotNull,
} from "../helpers/assertions.js";

const TIMEOUT = 60_000;
const getEnv = useSuiteEnv(import.meta.url);

beforeAll(async () => {
    await preflightChecks();
});

function staticSkillEvent(name, pluginName = "pilotswarm", pluginVersion = "0.1.19") {
    return {
        eventType: "skill.invoked",
        data: { name, path: `/plugins/${pluginName}/skills/${name}/SKILL.md`, pluginName, pluginVersion },
    };
}

function learnedSkillEvent(name, matchCount = 1, callerAgentId = "alpha") {
    return {
        eventType: "learned_skill.read",
        data: { name, scope: "shared", matchCount, limit: 50, callerSessionId: "x", callerAgentId },
    };
}

async function seedSession(catalog, sessionId, opts = {}) {
    await catalog.createSession(sessionId, opts);
    await catalog.updateSession(sessionId, { state: "running" });
}

describe("Skill Usage Stats", () => {
    it("aggregates static and learned skill events for a single session", async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        try {
            const sid = `sess-${Math.random().toString(36).slice(2, 10)}`;
            await seedSession(catalog, sid, { agentId: "alpha" });

            await catalog.recordEvents(sid, [
                staticSkillEvent("tui-architecture"),
                staticSkillEvent("tui-architecture"),  // 2x same skill
                staticSkillEvent("debug-orchestration"),
                learnedSkillEvent("skills/tui/refactor-insights", 1),
                learnedSkillEvent("skills/%", 7),       // wide read
                learnedSkillEvent("skills/%", 3),       // 2nd wide read; same pattern
            ]);

            const usage = await catalog.getSessionSkillUsage(sid);
            console.log("  rows:", usage.map(u => `${u.kind}/${u.name}=${u.invocations}`).join(", "));

            assertEqual(usage.length, 4, "expect 4 distinct (kind, name) groups");

            const tui = usage.find(u => u.kind === "static" && u.name === "tui-architecture");
            assertNotNull(tui, "static tui-architecture row");
            assertEqual(tui.invocations, 2, "tui-architecture invoked twice");
            assertEqual(tui.pluginName, "pilotswarm", "plugin metadata preserved for static");

            const debug = usage.find(u => u.kind === "static" && u.name === "debug-orchestration");
            assertEqual(debug.invocations, 1, "debug-orchestration invoked once");

            const refactor = usage.find(u => u.kind === "learned" && u.name === "skills/tui/refactor-insights");
            assertNotNull(refactor, "learned refactor-insights row");
            assertEqual(refactor.invocations, 1);
            assertEqual(refactor.pluginName, null, "learned skills have no plugin metadata");

            const wide = usage.find(u => u.kind === "learned" && u.name === "skills/%");
            assertEqual(wide.invocations, 2, "two reads against same pattern fold into one row");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("rolls up tree skill usage across parent + children", async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        try {
            const parent = `sess-${Math.random().toString(36).slice(2, 10)}`;
            const child = `sess-${Math.random().toString(36).slice(2, 10)}`;
            await seedSession(catalog, parent, { agentId: "coordinator" });
            await seedSession(catalog, child, { agentId: "alpha", parentSessionId: parent });

            await catalog.recordEvents(parent, [
                staticSkillEvent("planning-mode"),
                learnedSkillEvent("skills/planning/%", 4, "coordinator"),
            ]);
            await catalog.recordEvents(child, [
                staticSkillEvent("planning-mode"),  // same skill, different session
                staticSkillEvent("tui-architecture"),
            ]);

            const tree = await catalog.getSessionTreeSkillUsage(parent);
            console.log("  tree rolledUp:", tree.rolledUp.map(u => `${u.kind}/${u.name}=${u.invocations}`).join(", "));
            console.log("  tree perSession sids:", tree.perSession.map(p => `${p.sessionId.slice(0,4)}(${p.agentId})`).join(", "));

            assertEqual(tree.rootSessionId, parent);
            assertEqual(tree.perSession.length, 2, "parent + 1 child");
            assertEqual(tree.totalInvocations, 4, "1+1+1+1 = 4 invocations");

            const planning = tree.rolledUp.find(u => u.kind === "static" && u.name === "planning-mode");
            assertEqual(planning.invocations, 2, "planning-mode rolled up across parent+child");

            const learned = tree.rolledUp.find(u => u.kind === "learned" && u.name === "skills/planning/%");
            assertEqual(learned.invocations, 1, "learned read only happened once");

            const childBucket = tree.perSession.find(p => p.sessionId === child);
            assertEqual(childBucket.agentId, "alpha", "tree query carries agent_id per session");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("groups fleet skill usage by agent and respects since cutoff", async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        try {
            const a1 = `sess-${Math.random().toString(36).slice(2, 10)}`;
            const a2 = `sess-${Math.random().toString(36).slice(2, 10)}`;
            const b = `sess-${Math.random().toString(36).slice(2, 10)}`;
            await seedSession(catalog, a1, { agentId: "alpha" });
            await seedSession(catalog, a2, { agentId: "alpha" });
            await seedSession(catalog, b, { agentId: "beta" });

            await catalog.recordEvents(a1, [staticSkillEvent("tui-architecture")]);
            await catalog.recordEvents(a2, [staticSkillEvent("tui-architecture")]);
            await catalog.recordEvents(b,  [staticSkillEvent("tui-architecture"), learnedSkillEvent("skills/x", 1, "beta")]);

            const fleet = await catalog.getFleetSkillUsage();
            console.log("  fleet rows:", fleet.rows.map(r => `${r.agentId}/${r.kind}/${r.name}=${r.invocations}/sc=${r.sessionCount}`).join(", "));

            const alphaTui = fleet.rows.find(r => r.agentId === "alpha" && r.kind === "static" && r.name === "tui-architecture");
            assertEqual(alphaTui.invocations, 2, "2 alpha sessions invoked");
            assertEqual(alphaTui.sessionCount, 2, "session_count distinct");

            const betaLearned = fleet.rows.find(r => r.agentId === "beta" && r.kind === "learned");
            assertNotNull(betaLearned, "beta learned read present");
            assertEqual(betaLearned.invocations, 1);

            // since cutoff 1 hour in the future filters everything out
            const future = new Date(Date.now() + 3600_000);
            const empty = await catalog.getFleetSkillUsage({ since: future });
            assertEqual(empty.rows.length, 0, "since cutoff in the future returns no rows");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);

    it("read_facts handler emits learned_skill.read for skills/* patterns and not for others", async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        const factStore = await PgFactStore.create(env.store, env.factsSchema);
        await factStore.initialize();
        try {
            const sid = `sess-${Math.random().toString(36).slice(2, 10)}`;
            await seedSession(catalog, sid, { agentId: "alpha" });

            // Seed a curated skill fact (Facts Manager would do this normally)
            await factStore.storeFact({
                key: "skills/tui/refactor-insights",
                value: { name: "refactor-insights", description: "test fact" },
                shared: true,
                sessionId: null,
                agentId: "facts-manager",
            });

            // Build read-only fact tools with the recordEvent callback wired
            // through the catalog, mirroring SessionManager wiring.
            const tools = createFactTools({
                factStore,
                agentIdentity: "alpha",
                recordEvent: async (s, et, d) => {
                    await catalog.recordEvents(s, [{ eventType: et, data: d }]);
                },
            });
            const readFacts = tools.find(t => t.name === "read_facts");
            assertNotNull(readFacts, "read_facts tool defined");

            // 1) Read under skills/ — should emit one learned_skill.read.
            await readFacts.handler({ key_pattern: "skills/%" }, { sessionId: sid });
            // 2) Read under a non-skills key — should NOT emit.
            await readFacts.handler({ key_pattern: "config/%" }, { sessionId: sid });
            // 3) Another skills read with glob syntax (* not %).
            await readFacts.handler({ key_pattern: "skills/tui/*" }, { sessionId: sid });

            // Wait briefly for fire-and-forget recordEvent callbacks to flush.
            await new Promise(r => setTimeout(r, 250));

            const events = await catalog.getSessionEvents(sid, undefined, 100);
            const learned = events.filter(e => e.eventType === "learned_skill.read");
            console.log("  learned_skill.read events:", learned.length, "patterns:", learned.map(e => e.data?.name).join(", "));

            assertEqual(learned.length, 2, "skills/% and skills/tui/* each emit one event");
            assert(learned.some(e => e.data?.name === "skills/%"), "wide pattern recorded");
            assert(learned.some(e => e.data?.name === "skills/tui/*"), "glob pattern recorded literally");
            assert(learned.every(e => e.data?.callerAgentId === "alpha"), "callerAgentId carried through");
            assert(learned.every(e => typeof e.data?.matchCount === "number"), "matchCount present");
        } finally {
            await factStore.close();
            await catalog.close();
        }
    }, TIMEOUT);

    it("management API and CMS aggregations agree", async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        try {
            const sid = `sess-${Math.random().toString(36).slice(2, 10)}`;
            await seedSession(catalog, sid, { agentId: "alpha" });
            await catalog.recordEvents(sid, [
                staticSkillEvent("foo"),
                staticSkillEvent("foo"),
                staticSkillEvent("bar"),
                learnedSkillEvent("skills/baz", 2),
            ]);

            const usage = await catalog.getSessionSkillUsage(sid);
            const total = usage.reduce((acc, u) => acc + u.invocations, 0);
            assertEqual(total, 4, "static foo*2 + static bar + learned skills/baz = 4 invocations");

            const tree = await catalog.getSessionTreeSkillUsage(sid);
            assertEqual(tree.totalInvocations, 4, "tree totalInvocations matches per-session sum");
            assertGreaterOrEqual(tree.rolledUp.length, 1, "tree rolled-up rows present");
        } finally {
            await catalog.close();
        }
    }, TIMEOUT);
});
