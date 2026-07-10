/**
 * Sub-agent integration test (real spawn path): a child spawned by a SYSTEM
 * session inherits the SYSTEM user as its OWNER — it is NOT itself a system
 * session, so it stays deletable and manageable.
 *
 * Why this shape: system sessions are ownerless by design, and the
 * admin-stored System GitHub Copilot key is resolved per-owner. Marking
 * children is_system (the 0.5.8 approach) reached the key but made every
 * spawned child undeletable ("Cannot delete system session") and pinned it
 * into the system tree. Instead the spawn paths now resolve the lineage's
 * EFFECTIVE owner (resolveEffectiveSpawnOwner): nearest owned ancestor's
 * user, or the SYSTEM user principal for a system lineage. The child then
 * resolves the System key through the ordinary per-owner credential path
 * (covered by system-copilot-key.test.js) while remaining an ordinary
 * session.
 *
 * This exercises the REAL path end to end: the session is created by the
 * test client but the co-located worker runs the turns and performs the
 * spawn via controlBridge.spawnAgent — the exact boundary where both the
 * 0.5.7 (wrong path) and pre-0.5.8 (no owner at all) regressions lived.
 *
 * Run: npx vitest run test/local/sub-agents/system-inheritance.test.js
 */

import { describe, it, beforeAll } from "vitest";
import { preflightChecks, useSuiteEnv } from "../../helpers/local-env.js";
import { withClient } from "../../helpers/local-workers.js";
import { assert, assertGreaterOrEqual, assertEqual } from "../../helpers/assertions.js";
import { createCatalog } from "../../helpers/cms-helpers.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

async function testSystemChildInheritsSystemOwner(env) {
    const catalog = await createCatalog(env);

    try {
        await withClient(env, async (client) => {
            const system = await client.createSystemSession({
                systemMessage: "You are a system session. When asked, spawn a sub-agent.",
            });

            console.log("  Spawning sub-agent under a SYSTEM (ownerless) parent...");
            await system.send(
                "Spawn a sub-agent with the task: 'Reply with the single word DONE'",
            );

            let children = [];
            const deadline = Date.now() + TIMEOUT;
            while (Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 3000));
                const allSessions = await catalog.listSessions();
                children = allSessions.filter(
                    s => s.parentSessionId === system.sessionId,
                );
                if (children.length >= 1) break;
                console.log(`  [poll] children so far: ${children.length}`);
            }
            assertGreaterOrEqual(children.length, 1, "Expected at least 1 child");

            const child = children[0];
            console.log(`  Child ${child.sessionId.slice(0, 8)} isSystem=${child.isSystem} owner=${JSON.stringify(child.owner)}`);

            // 1. NOT a system session — ordinary, manageable.
            assertEqual(
                Boolean(child.isSystem),
                false,
                "Child of a system session must NOT be a system session (that would make it undeletable)",
            );

            // 2. Owned by the SYSTEM user — the credential identity that
            //    resolves the admin-stored System GHCP key per-owner.
            assert(child.owner, "Child must carry the inherited System owner, not be ownerless");
            assertEqual(child.owner.provider, "system", "owner.provider is the System user");
            assertEqual(child.owner.subject, "system", "owner.subject is the System user");

            // 3. Deletable — the exact capability the is_system approach broke.
            //    (Both the client guard and the CMS soft-delete refuse system
            //    sessions, so success proves the child is a normal session.)
            await client.deleteSession(child.sessionId);
            const afterDelete = await catalog.listSessions();
            assert(
                !afterDelete.some(s => s.sessionId === child.sessionId),
                "Deleted child must no longer appear in the session list",
            );
            console.log("  Child deleted cleanly ✓");

            // 4. Boundary check: the system PARENT itself stays protected.
            let parentDeleteError = null;
            try {
                await client.deleteSession(system.sessionId);
            } catch (err) {
                parentDeleteError = err;
            }
            assert(
                parentDeleteError && /system/i.test(String(parentDeleteError.message)),
                "The system parent must still refuse deletion",
            );
        });
    } finally {
        await catalog.close();
    }
}

describe("Sub-Agent: System Owner Inheritance", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("child of a system session is System-OWNED, non-system, and deletable", { timeout: TIMEOUT * 2 }, async () => {
        await testSystemChildInheritsSystemOwner(getEnv());
    });
});
