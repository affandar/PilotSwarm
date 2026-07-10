/**
 * Unit tests: resolveEffectiveSpawnOwner — the single lineage walk both spawn
 * paths (controlBridge.spawnAgent and the spawnChildSession activity) use to
 * decide which owner a spawned sub-agent inherits.
 *
 * Contract:
 *   - nearest ancestor WITH an owner wins (user attribution is preserved);
 *   - a SYSTEM ancestor (ownerless by design) maps to the SYSTEM user
 *     principal, so the child resolves the admin-stored System GHCP key
 *     through the ordinary per-owner path while staying a normal deletable
 *     session (it is NOT marked is_system);
 *   - unresolvable lineage (no owner, no system ancestor, missing rows,
 *     lookup failures, depth exhaustion) → null → child stays ownerless.
 *
 * Run: npx vitest run test/local/spawn-owner-resolution.test.js
 */

import { describe, it } from "vitest";
import { resolveEffectiveSpawnOwner, SYSTEM_USER_PRINCIPAL } from "../../src/cms.ts";
import { assert, assertEqual } from "../helpers/assertions.js";

const USER = { provider: "entra", subject: "user-1", email: "u1@example.com", displayName: "User One" };

function catalogOf(rows) {
    return async (sessionId) => rows[sessionId] ?? null;
}

describe("resolveEffectiveSpawnOwner", () => {
    it("a user-owned parent yields that user", async () => {
        const owner = await resolveEffectiveSpawnOwner(catalogOf({
            parent: { owner: USER, isSystem: false, parentSessionId: null },
        }), "parent");
        assertEqual(owner?.provider, "entra");
        assertEqual(owner?.subject, "user-1");
        assertEqual(owner?.email, "u1@example.com", "owner contact fields carried through");
    });

    it("a SYSTEM parent yields the SYSTEM user principal (not a system flag)", async () => {
        const owner = await resolveEffectiveSpawnOwner(catalogOf({
            parent: { owner: null, isSystem: true, parentSessionId: "root" },
        }), "parent");
        assertEqual(owner?.provider, SYSTEM_USER_PRINCIPAL.provider);
        assertEqual(owner?.subject, SYSTEM_USER_PRINCIPAL.subject);
    });

    it("walks past an ownerless non-system parent to an owned grandparent", async () => {
        const owner = await resolveEffectiveSpawnOwner(catalogOf({
            parent: { owner: null, isSystem: false, parentSessionId: "grandparent" },
            grandparent: { owner: USER, isSystem: false, parentSessionId: null },
        }), "parent");
        assertEqual(owner?.subject, "user-1", "nearest owned ancestor wins");
    });

    it("walks past an ownerless non-system parent to a SYSTEM grandparent", async () => {
        const owner = await resolveEffectiveSpawnOwner(catalogOf({
            parent: { owner: null, isSystem: false, parentSessionId: "facts-manager" },
            "facts-manager": { owner: null, isSystem: true, parentSessionId: "pilotswarm-root" },
        }), "parent");
        assertEqual(owner?.provider, "system", "grandchild of a system agent still inherits the System user");
        assertEqual(owner?.subject, "system");
    });

    it("an ancestor's explicit owner wins over its own system flag", async () => {
        // Defensive: rows should never be owned AND system, but if one is,
        // the concrete owner is the more specific credential identity.
        const owner = await resolveEffectiveSpawnOwner(catalogOf({
            parent: { owner: USER, isSystem: true, parentSessionId: null },
        }), "parent");
        assertEqual(owner?.subject, "user-1", "explicit owner outranks the system mapping");
    });

    it("fully unresolvable lineage yields null (child stays ownerless)", async () => {
        const owner = await resolveEffectiveSpawnOwner(catalogOf({
            parent: { owner: null, isSystem: false, parentSessionId: "gone" },
        }), "parent");
        assertEqual(owner, null, "missing ancestor row terminates the walk with null");
    });

    it("yields null when the start row is missing", async () => {
        assertEqual(await resolveEffectiveSpawnOwner(catalogOf({}), "nope"), null);
    });

    it("yields null when the start id is empty", async () => {
        assertEqual(await resolveEffectiveSpawnOwner(catalogOf({}), null), null);
        assertEqual(await resolveEffectiveSpawnOwner(catalogOf({}), undefined), null);
    });

    it("a throwing lookup degrades to null instead of failing the spawn", async () => {
        const owner = await resolveEffectiveSpawnOwner(async () => { throw new Error("cms down"); }, "parent");
        assertEqual(owner, null, "lookup failure must not break spawning");
    });

    it("caps the walk at maxDepth on deep ownerless chains", async () => {
        const rows = {};
        for (let i = 0; i < 12; i++) {
            rows[`n${i}`] = { owner: null, isSystem: false, parentSessionId: `n${i + 1}` };
        }
        rows.n12 = { owner: USER, isSystem: false, parentSessionId: null };
        const capped = await resolveEffectiveSpawnOwner(catalogOf(rows), "n0", 8);
        assertEqual(capped, null, "owner beyond maxDepth is not reached");
        const deep = await resolveEffectiveSpawnOwner(catalogOf(rows), "n0", 20);
        assertEqual(deep?.subject, "user-1", "raising maxDepth reaches it (cap works, not a bug)");
    });

    it("ignores malformed owners (missing subject) and keeps walking", async () => {
        const owner = await resolveEffectiveSpawnOwner(catalogOf({
            parent: { owner: { provider: "entra" }, isSystem: false, parentSessionId: "sys" },
            sys: { owner: null, isSystem: true, parentSessionId: null },
        }), "parent");
        assertEqual(owner?.provider, "system", "half-formed owner is not a credential identity");
    });

    it("returns a copy of the SYSTEM principal, not the shared constant", async () => {
        const owner = await resolveEffectiveSpawnOwner(catalogOf({
            parent: { owner: null, isSystem: true, parentSessionId: null },
        }), "parent");
        assert(owner !== SYSTEM_USER_PRINCIPAL, "mutating the result must not corrupt the shared constant");
    });
});
