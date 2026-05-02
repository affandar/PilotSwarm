/**
 * Sub-agent test: spawned children inherit the parent's CMS owner.
 *
 * The portal/TUI owner-filter hides sessions that don't match the
 * current user's principal. Before this fix, spawnChildSession created
 * the child with `owner: null`, so a user-owned parent's spawned child
 * disappeared from the user's filtered tree (parent showed a `[+1]`
 * hidden-descendant badge). Children should now inherit the owner of
 * the nearest owned ancestor.
 *
 * Run: npx vitest run test/local/sub-agents/owner-inheritance.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { createTestEnv, preflightChecks, useSuiteEnv } from "../../helpers/local-env.js";
import { withClient } from "../../helpers/local-workers.js";
import { assert, assertGreaterOrEqual, assertEqual } from "../../helpers/assertions.js";
import { createCatalog } from "../../helpers/cms-helpers.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

const PARENT_OWNER = {
    provider: "test",
    subject: "owner-inheritance-user",
    email: "owner@example.com",
    displayName: "Owner Test User",
};

async function testOwnerInheritedFromParent(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client) => {
            const session = await client.createSession({ owner: PARENT_OWNER });

            console.log("  Spawning sub-agent under owned parent...");
            await session.send(
                "Spawn a sub-agent with the task: 'Reply with the single word DONE'",
            );

            // Poll CMS until at least one child appears
            let children = [];
            const deadline = Date.now() + TIMEOUT;
            while (Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 3000));
                const allSessions = await catalog.listSessions();
                children = allSessions.filter(
                    s => s.parentSessionId === session.sessionId,
                );
                if (children.length >= 1) break;
                console.log(`  [poll] children so far: ${children.length}`);
            }
            assertGreaterOrEqual(children.length, 1, "Expected at least 1 child");

            const child = children[0];
            console.log(`  Child sessionId: ${child.sessionId.slice(0, 8)}`);
            console.log(`  Child owner: ${JSON.stringify(child.owner)}`);

            assert(child.owner, "Child must have an inherited owner, not null");
            assertEqual(child.owner.provider, PARENT_OWNER.provider, "Child owner.provider should match parent");
            assertEqual(child.owner.subject, PARENT_OWNER.subject, "Child owner.subject should match parent");
        });
    } finally {
        await catalog.close();
    }
}

describe("Sub-Agent: Owner Inheritance", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("child inherits parent owner so it shows up in the parent's owner-filtered tree", { timeout: TIMEOUT * 2 }, async () => {
        await testOwnerInheritedFromParent(getEnv());
    });
});
