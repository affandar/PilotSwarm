/**
 * Facts access-control regression tests (management-client role scoping).
 *
 * The Web API brokers facts reads through PilotSwarmManagementClient.readFacts,
 * which derives visibility from the authenticated principal's role — never from
 * the client. This is the seam an adversarial review found could leak private
 * facts: a non-admin caller must NOT be able to read another session's
 * session-scoped facts, even by explicitly targeting that session's id.
 *
 * The webapi-e2e suite runs the server no-auth (every caller is privileged =
 * admin/unrestricted), so it can only exercise the admin path. These tests drive
 * the management client directly against a real PgFactStore to cover the
 * non-admin path that the no-auth server cannot reach.
 *
 * Run: npx vitest run test/local/facts-access-control.test.js
 */

import { describe, it } from "vitest";
import { PilotSwarmManagementClient } from "../../src/index.ts";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";

const TIMEOUT = 60_000;
const getEnv = useSuiteEnv(import.meta.url);

function uniq(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// A fresh management client per test: useSuiteEnv drops the schemas after every
// test (afterEach → reset), so each test re-runs the fact-store migrations via
// start() to recreate them.
async function withMgmt(fn) {
    const env = getEnv();
    const mgmt = new PilotSwarmManagementClient({
        store: env.store,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
    });
    await mgmt.start();
    try {
        await fn(mgmt);
    } finally {
        await mgmt.stop?.();
    }
}

const keysOf = (result) => result.facts.map((f) => f.key);

describe("facts access control (management client role scoping)", () => {
    it("non-admin reads see shared facts but not another session's private facts", { timeout: TIMEOUT }, async () => {
        await withMgmt(async (mgmt) => {
            const p = uniq("acl");
            const victimSession = uniq("victim-session");
            const sharedKey = `${p}/public`;
            const privateKey = `${p}/secret`;

            await mgmt.storeFact({ key: sharedKey, value: { v: "public" }, shared: true });
            await mgmt.storeFact({ key: privateKey, value: { v: "private" }, shared: false, sessionId: victimSession });

            // Admin (unrestricted) proves BOTH facts exist and the private one is real
            // and retrievable by a privileged caller — so the non-admin exclusion below
            // is a genuine access decision, not a vacuous "nothing was stored".
            const adminView = await mgmt.readFacts({ keyPattern: `${p}/%` }, { admin: true });
            const adminKeys = keysOf(adminView);
            assert(adminKeys.includes(sharedKey), "admin sees the shared fact");
            assert(adminKeys.includes(privateKey), "admin (unrestricted) sees the private fact");

            // Non-admin plain read: shared only.
            const userView = await mgmt.readFacts({ keyPattern: `${p}/%` }, { admin: false });
            const userKeys = keysOf(userView);
            assert(userKeys.includes(sharedKey), "non-admin sees the shared fact");
            assert(!userKeys.includes(privateKey), "non-admin must NOT see the private fact");

            // The escalation attempt: a non-admin explicitly targets the victim's
            // session (and asks for session scope). The server drops the client
            // sessionId and forces scope=shared, so the private fact stays hidden.
            const attackView = await mgmt.readFacts(
                { keyPattern: `${p}/%`, sessionId: victimSession, scope: "session" },
                { admin: false },
            );
            const attackKeys = keysOf(attackView);
            assert(!attackKeys.includes(privateKey), "non-admin cannot reach a private fact by targeting the session");
            assert(attackKeys.includes(sharedKey), "the targeted read still returns shared facts only");
        });
    });

    it("non-admin cannot smuggle an unrestricted access context", { timeout: TIMEOUT }, async () => {
        await withMgmt(async (mgmt) => {
            const p = uniq("acl-smuggle");
            const victimSession = uniq("victim-session");
            await mgmt.storeFact({ key: `${p}/secret`, value: { v: "private" }, shared: false, sessionId: victimSession });

            // A crafted query carrying unrestricted/readerSessionId must be ignored:
            // the non-admin path builds its own {} access context server-side.
            const crafted = await mgmt.readFacts(
                { keyPattern: `${p}/%`, sessionId: victimSession, unrestricted: true, readerSessionId: victimSession },
                { admin: false },
            );
            assertEqual(crafted.count, 0, "no private facts leak through a crafted access context");
        });
    });

    it("deleteFact refuses scope='all' and strips a client unrestricted flag", { timeout: TIMEOUT }, async () => {
        await withMgmt(async (mgmt) => {
            const p = uniq("acl-del");
            await mgmt.storeFact({ key: `${p}/x`, value: { v: 1 }, shared: true });

            // scope="all" would span every session's facts — refused on the Tier-1
            // (non-admin) deleteFact even with unrestricted:true asserted by the client.
            let threw = false;
            try {
                await mgmt.deleteFact({ key: `${p}/%`, pattern: true, scope: "all", unrestricted: true });
            } catch (error) {
                threw = true;
                assertEqual(error?.code, "INVALID_REQUEST", "scope=all rejected with INVALID_REQUEST");
            }
            assert(threw, "scope='all' delete must throw");

            // The shared fact is untouched by the refused delete.
            const after = await mgmt.readFacts({ keyPattern: `${p}/%` }, { admin: true });
            assert(keysOf(after).includes(`${p}/x`), "refused delete left the fact intact");

            // A scoped shared delete still works.
            const del = await mgmt.deleteFact({ key: `${p}/%`, pattern: true, scope: "shared" });
            assert(del.deleted >= 1, "scoped shared delete removes the fact");
        });
    });
});
