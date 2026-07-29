/**
 * Delete-cascade tests: deleting a TERMINAL session must soft-delete its
 * whole subtree, not just its own row.
 *
 * Regression coverage for the terminal fast path orphaning descendants
 * (docs/bugreports/delete-agent-terminal-fast-path-orphans-descendants-20260728.md):
 * the descendant cascade used to live only in the delete command handler of a
 * session's own RUNNING orchestration, so every delete of an
 * already-terminal session (delete_agent reaps, portal delete, MCP
 * delete_session) was a single-row soft delete. Because
 * cms_get_descendant_session_ids skips deleted rows at every level of its
 * recursive walk, the subtree below the deleted row became permanently
 * unreachable while its rows stayed live.
 *
 * These tests build trees directly in the CMS (no worker, no LLM turns) and
 * exercise the two client-layer deleteSession entry points that all terminal
 * deletes funnel through:
 *   - PilotSwarmClient.deleteSession        (delete_agent durable + inline paths)
 *   - PilotSwarmManagementClient.deleteSession (portal DELETE + MCP delete_session)
 *
 * Run: npx vitest run test/local/delete-cascade.test.js
 */

import { describe, it } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { PilotSwarmClient, PilotSwarmManagementClient } from "../../src/index.ts";

const getEnv = useSuiteEnv(import.meta.url);

/**
 * Create a chain root -> child -> grandchild -> ... of CMS-only sessions
 * (no orchestration), all in the given terminal state.
 * Returns the session ids, root first.
 */
async function createTerminalChain(catalog, depth, { state = "completed" } = {}) {
    const ids = [];
    for (let i = 0; i < depth; i++) {
        const id = randomUUID();
        await catalog.createSession(id, {
            agentId: i === 0 ? "watcher" : "worker",
            ...(i > 0 ? { parentSessionId: ids[i - 1] } : {}),
        });
        await catalog.updateSession(id, { state });
        ids.push(id);
    }
    return ids;
}

async function assertSubtreeDeleted(catalog, rootId, deletedIds, keptIds) {
    for (const id of deletedIds) {
        const row = await catalog.getSession(id);
        assert(row == null, `Session ${id.slice(0, 8)} should be soft-deleted`);
    }
    for (const id of keptIds) {
        const row = await catalog.getSession(id);
        assert(row != null, `Session ${id.slice(0, 8)} should still exist`);
    }
    const descendants = await catalog.getDescendantSessionIds(rootId);
    for (const id of deletedIds) {
        assert(!descendants.includes(id), `${id.slice(0, 8)} should not appear in ${rootId.slice(0, 8)}'s descendants`);
    }
    // No orphans: every listed session's parent must resolve.
    const listed = await catalog.listSessions();
    const listedIds = new Set(listed.map((s) => s.sessionId));
    for (const row of listed) {
        if (!row.parentSessionId) continue;
        assert(
            listedIds.has(row.parentSessionId),
            `Session ${row.sessionId.slice(0, 8)} is orphaned: parent ${row.parentSessionId.slice(0, 8)} is deleted`,
        );
    }
}

// ─── PilotSwarmClient.deleteSession (delete_agent terminal fast path) ───

async function testClientDeleteCascades(env) {
    const catalog = await createCatalog(env);
    const client = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
    });
    await client.start();

    try {
        // A -> B -> C -> D, all completed. Deleting B must take C and D
        // with it and leave A intact.
        const [a, b, c, d] = await createTerminalChain(catalog, 4);

        const before = await catalog.getDescendantSessionIds(a);
        assertEqual(before.length, 3, "A should see 3 descendants before delete");

        console.log(`  client.deleteSession(${b.slice(0, 8)}) — completed mid-tree node`);
        await client.deleteSession(b);

        await assertSubtreeDeleted(catalog, a, [b, c, d], [a]);
        console.log("  Subtree (B, C, D) soft-deleted; A intact; no orphans");
    } finally {
        await client.stop();
        await catalog.close();
    }
}

async function testClientDeleteLeafStillWorks(env) {
    const catalog = await createCatalog(env);
    const client = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
    });
    await client.start();

    try {
        // Leaf delete (no descendants) must behave exactly as before.
        const [a, b] = await createTerminalChain(catalog, 2);

        console.log(`  client.deleteSession(${b.slice(0, 8)}) — leaf`);
        await client.deleteSession(b);

        await assertSubtreeDeleted(catalog, a, [b], [a]);
        console.log("  Leaf deleted; parent intact");
    } finally {
        await client.stop();
        await catalog.close();
    }
}

async function testClientDeleteSkipsSystemDescendant(env) {
    const catalog = await createCatalog(env);
    const client = new PilotSwarmClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
    });
    await client.start();

    try {
        // B has two children: a system session (undeletable, CMS throws)
        // and a normal one. The refusal must not strand the sibling or
        // abort the delete of B itself.
        const [, b] = await createTerminalChain(catalog, 2);
        const sys = randomUUID();
        await catalog.createSession(sys, { agentId: "svc", parentSessionId: b, isSystem: true });
        const c2 = randomUUID();
        await catalog.createSession(c2, { agentId: "worker", parentSessionId: b });
        await catalog.updateSession(c2, { state: "completed" });

        console.log(`  client.deleteSession(${b.slice(0, 8)}) — with system + normal children`);
        await client.deleteSession(b);

        assert((await catalog.getSession(b)) == null, "B should be deleted");
        assert((await catalog.getSession(c2)) == null, "Normal sibling should be deleted despite system refusal");
        assert((await catalog.getSession(sys)) != null, "System descendant must survive (undeletable)");
        console.log("  System child survived, normal child cascaded, B deleted");
    } finally {
        await client.stop();
        await catalog.close();
    }
}

// ─── PilotSwarmManagementClient.deleteSession (portal / MCP path) ────────

async function testManagementDeleteCascades(env) {
    const catalog = await createCatalog(env);
    const mgmt = new PilotSwarmManagementClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
    });
    await mgmt.start();

    try {
        // No orchestration ever ran for these rows, so orchestrationStatus
        // is Unknown/null — precisely the terminal fast-path predicate.
        const [a, b, c, d] = await createTerminalChain(catalog, 4);

        console.log(`  mgmt.deleteSession(${b.slice(0, 8)}) — completed mid-tree node`);
        await mgmt.deleteSession(b, "reap test");

        await assertSubtreeDeleted(catalog, a, [b, c, d], [a]);
        console.log("  Subtree (B, C, D) soft-deleted; A intact; no orphans");
    } finally {
        await mgmt.stop();
        await catalog.close();
    }
}

async function testManagementDeleteRootCascades(env) {
    const catalog = await createCatalog(env);
    const mgmt = new PilotSwarmManagementClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
    });
    await mgmt.start();

    try {
        // The portal case: deleting a completed ROOT takes the whole tree.
        const [a, b, c] = await createTerminalChain(catalog, 3);

        console.log(`  mgmt.deleteSession(${a.slice(0, 8)}) — completed root`);
        await mgmt.deleteSession(a, "portal delete");

        for (const id of [a, b, c]) {
            assert((await catalog.getSession(id)) == null, `Session ${id.slice(0, 8)} should be soft-deleted`);
        }
        console.log("  Entire tree soft-deleted from the root");
    } finally {
        await mgmt.stop();
        await catalog.close();
    }
}

async function testManagementDeleteFailedAndCancelled(env) {
    const catalog = await createCatalog(env);
    const mgmt = new PilotSwarmManagementClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
    });
    await mgmt.start();

    try {
        // The fast path also triggers for failed/cancelled targets.
        for (const state of ["failed", "cancelled"]) {
            const [a, b, c] = await createTerminalChain(catalog, 3, { state });

            console.log(`  mgmt.deleteSession(${b.slice(0, 8)}) — ${state} mid-tree node`);
            await mgmt.deleteSession(b);

            await assertSubtreeDeleted(catalog, a, [b, c], [a]);
        }
        console.log("  failed + cancelled targets both cascade");
    } finally {
        await mgmt.stop();
        await catalog.close();
    }
}

// ─── Suite ───────────────────────────────────────────────────────────────

describe("delete cascade (terminal fast path)", () => {
    it("PilotSwarmClient.deleteSession cascades to all descendants", async () => {
        await testClientDeleteCascades(getEnv());
    }, 60_000);

    it("PilotSwarmClient.deleteSession still deletes a leaf", async () => {
        await testClientDeleteLeafStillWorks(getEnv());
    }, 60_000);

    it("PilotSwarmClient.deleteSession survives an undeletable system descendant", async () => {
        await testClientDeleteSkipsSystemDescendant(getEnv());
    }, 60_000);

    it("PilotSwarmManagementClient.deleteSession cascades to all descendants", async () => {
        await testManagementDeleteCascades(getEnv());
    }, 60_000);

    it("PilotSwarmManagementClient.deleteSession on a completed root deletes the whole tree", async () => {
        await testManagementDeleteRootCascades(getEnv());
    }, 60_000);

    it("PilotSwarmManagementClient.deleteSession cascades for failed and cancelled targets", async () => {
        await testManagementDeleteFailedAndCancelled(getEnv());
    }, 60_000);
});
