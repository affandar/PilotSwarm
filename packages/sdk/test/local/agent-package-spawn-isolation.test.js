/**
 * Package privacy at agent RESOLUTION — the `spawn_agent` bypass.
 *
 * The hole this covers, confirmed in the pre-fix code:
 *
 *   Workers install EVERY enabled agent package, user-scope ones included
 *   ("workers are trusted infrastructure — no viewer filter here by design",
 *   cms_get_agent_packages_install_manifest). Their agents all land in one
 *   flat `userAgents` list with no tenancy attached.
 *
 *   The Web API does filter them — `_authorizePackageAgentCreate` refuses a
 *   foreign user-scope agent at session creation. But `spawn_agent` does not
 *   go through the Web API. It reaches the `resolveAgentConfig` ACTIVITY
 *   directly, which used to take `{ agentName }` and nothing else, and match
 *   purely on the normalized name.
 *
 *   So Bob's session could say "spawn alice-triager" and get Alice's private
 *   agent — including its full prompt, which merely by being returned is
 *   written into Bob's orchestration history.
 *
 * That is why the check lives at resolution and not at spawn: by spawn time
 * the prompt has already crossed the boundary.
 *
 * These assertions were confirmed RED against the pre-fix activity.
 *
 * Run: node --env-file=../../.env ../../node_modules/vitest/vitest.mjs run test/local/agent-package-spawn-isolation.test.js
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { PgSessionCatalog } from "../../dist/cms.js";
import { registerActivities } from "../../dist/session-proxy.js";

const DATABASE_URL = process.env.DATABASE_URL;
const SCHEMA = `tspawniso_${Date.now().toString(36)}`;

const ALICE = { provider: "dev", subject: "alice", email: "alice@dev.local", displayName: "Alice" };
const BOB = { provider: "dev", subject: "bob", email: "bob@dev.local", displayName: "Bob" };

/** Minimal runtime that just captures activity handlers by name. */
function captureRuntime() {
    const handlers = new Map();
    return {
        handlers,
        registerActivity(name, fn) { handlers.set(name, fn); },
        registerOrchestration() {},
        registerOrchestrationVersioned() {},
    };
}

describe.skipIf(!DATABASE_URL)("agent package privacy at resolution", () => {
    let catalog;
    let resolveAgentConfig;
    let aliceSession, bobSession, ownerlessSession;

    beforeAll(async () => {
        catalog = await PgSessionCatalog.create(DATABASE_URL, SCHEMA);
        await catalog.initialize();

        aliceSession = `sess-alice-${Date.now()}`;
        bobSession = `sess-bob-${Date.now()}`;
        ownerlessSession = `sess-none-${Date.now()}`;
        await catalog.createSession(aliceSession, { model: "m", owner: ALICE });
        await catalog.createSession(bobSession, { model: "m", owner: BOB });
        await catalog.createSession(ownerlessSession, { model: "m" });

        // Three agents, exactly as the worker would have loaded them:
        //  - one from ALICE's user-scope package
        //  - one from a SHARED package (no owner stamp)
        //  - one from a plain deployment plugin dir (no package at all)
        const userAgents = [
            {
                name: "alice-triager", prompt: "ALICE PRIVATE PROMPT", namespace: "triage",
                packageScope: "user", packageOwner: { provider: ALICE.provider, subject: ALICE.subject },
            },
            { name: "shared-helper", prompt: "shared prompt", namespace: "helpers" },
            { name: "deployment-agent", prompt: "deployment prompt", namespace: "builtin" },
        ];

        const runtime = captureRuntime();
        registerActivities(
            runtime,
            /* sessionManager */ {},
            /* sessionStore   */ null,
            /* githubToken    */ undefined,
            /* catalog        */ catalog,
            /* provider       */ undefined,
            /* storeUrl       */ DATABASE_URL,
            /* cmsSchema      */ SCHEMA,
            /* clientConfig   */ {},
            /* systemAgents   */ [],
            /* workerPolicy   */ null,
            /* allowedNames   */ [],
            /* userAgents     */ userAgents,
        );
        resolveAgentConfig = runtime.handlers.get("resolveAgentConfig");
        expect(resolveAgentConfig, "resolveAgentConfig activity must be registered").toBeTypeOf("function");
    });

    afterAll(async () => {
        try {
            const { default: pg } = await import("pg");
            const p = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
            await p.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
            await p.end();
        } catch { /* best effort */ }
        await catalog?.close?.();
    });

    const resolve = (agentName, callerSessionId) =>
        resolveAgentConfig({}, { agentName, callerSessionId });

    // ── The vulnerability itself ──────────────────────────────────

    it("a foreign session cannot resolve an agent from a private package", async () => {
        const got = await resolve("alice-triager", bobSession);
        expect(got, "Bob must not reach Alice's user-scope package agent").toBe(null);
    });

    it("the private prompt never crosses the boundary", async () => {
        // Belt and braces: the refusal must be a null, not a redacted object
        // that still carries the prompt. Returning ANYTHING shaped like the
        // agent writes it into the caller's orchestration history.
        const got = await resolve("alice-triager", bobSession);
        expect(JSON.stringify(got ?? null)).not.toContain("ALICE PRIVATE PROMPT");
    });

    it("the owner still gets their own private agent", async () => {
        const got = await resolve("alice-triager", aliceSession);
        expect(got?.name).toBe("alice-triager");
        expect(got?.prompt).toBe("ALICE PRIVATE PROMPT");
    });

    // ── Fail closed ───────────────────────────────────────────────

    it("an ownerless caller gets no private agents", async () => {
        expect(await resolve("alice-triager", ownerlessSession)).toBe(null);
    });

    it("a missing or unknown caller session gets no private agents", async () => {
        // An unresolvable caller must not be treated as "no restriction".
        expect(await resolve("alice-triager", undefined)).toBe(null);
        expect(await resolve("alice-triager", "no-such-session")).toBe(null);
    });

    // ── The privacy check must not break ordinary resolution ──────

    it("shared-package and deployment agents stay public", async () => {
        for (const caller of [aliceSession, bobSession, ownerlessSession]) {
            expect((await resolve("shared-helper", caller))?.name).toBe("shared-helper");
            expect((await resolve("deployment-agent", caller))?.name).toBe("deployment-agent");
        }
    });

    it("fuzzy and namespace-qualified lookups are filtered too", async () => {
        // The resolver accepts "Alice Triager agent" and "triage:alice-triager".
        // A privacy check that only covered the exact-name path would be
        // trivially bypassed by asking a slightly different way.
        for (const alias of ["Alice Triager", "alice triager agent", "triage:alice-triager"]) {
            expect(await resolve(alias, bobSession), `alias ${alias}`).toBe(null);
        }
        expect((await resolve("triage:alice-triager", aliceSession))?.name).toBe("alice-triager");
    });

    it("a private agent does not mask a public one of the same name", async () => {
        // If Bob is refused Alice's copy, resolution must CONTINUE and find a
        // visible agent with the same name rather than stopping at the first
        // match. Otherwise anyone could hide a shared agent from everyone else
        // just by publishing a private package that shadows its name.
        const userAgents = [
            {
                name: "dup", prompt: "ALICE PRIVATE DUP", namespace: "a",
                packageScope: "user", packageOwner: { provider: ALICE.provider, subject: ALICE.subject },
            },
            { name: "dup", prompt: "public dup", namespace: "b" },
        ];
        const runtime = captureRuntime();
        registerActivities(
            runtime, {}, null, undefined, catalog, undefined, DATABASE_URL, SCHEMA, {},
            [], null, [], userAgents,
        );
        const resolveDup = runtime.handlers.get("resolveAgentConfig");
        const forBob = await resolveDup({}, { agentName: "dup", callerSessionId: bobSession });
        expect(forBob?.prompt).toBe("public dup");
        const forAlice = await resolveDup({}, { agentName: "dup", callerSessionId: aliceSession });
        expect(forAlice?.prompt).toBe("ALICE PRIVATE DUP");
    });

    // ── Shadowing and the __shared: escape hatch (§9) ─────────────

    describe("shadowing", () => {
        let resolveShadow;

        beforeAll(() => {
            // The canonical shape: a shared package everyone gets, and Alice's
            // own copy of the same name.
            const userAgents = [
                { name: "navigator", prompt: "SHARED NAVIGATOR", namespace: "nav" },
                {
                    name: "navigator", prompt: "ALICE NAVIGATOR", namespace: "nav",
                    packageScope: "user", packageOwner: { provider: ALICE.provider, subject: ALICE.subject },
                },
            ];
            const runtime = captureRuntime();
            registerActivities(
                runtime, {}, null, undefined, catalog, undefined, DATABASE_URL, SCHEMA, {},
                [], null, [], userAgents,
            );
            resolveShadow = runtime.handlers.get("resolveAgentConfig");
        });

        const res = (agentName, callerSessionId) => resolveShadow({}, { agentName, callerSessionId });

        it("your own enabled copy shadows the shared one", async () => {
            // Order matters even though BOTH are visible to Alice — the list
            // order in `userAgents` deliberately puts shared first, so a
            // first-match resolver would pick the wrong one.
            expect((await res("navigator", aliceSession))?.prompt).toBe("ALICE NAVIGATOR");
        });

        it("everyone else gets the shared one", async () => {
            expect((await res("navigator", bobSession))?.prompt).toBe("SHARED NAVIGATOR");
            expect((await res("navigator", ownerlessSession))?.prompt).toBe("SHARED NAVIGATOR");
        });

        it("__shared: reaches past your own copy", async () => {
            // The one capability bare-name precedence otherwise takes away.
            expect((await res("__shared:navigator", aliceSession))?.prompt).toBe("SHARED NAVIGATOR");
        });

        it("__shared: never exposes a private copy to anyone", async () => {
            // Including its owner: `__shared:` means the deployment's copy, so
            // it must not fall back to a user-scope agent when none exists.
            const only = [{
                name: "solo", prompt: "ALICE SOLO", namespace: "nav",
                packageScope: "user", packageOwner: { provider: ALICE.provider, subject: ALICE.subject },
            }];
            const runtime = captureRuntime();
            registerActivities(
                runtime, {}, null, undefined, catalog, undefined, DATABASE_URL, SCHEMA, {},
                [], null, [], only,
            );
            const r = runtime.handlers.get("resolveAgentConfig");
            expect(await r({}, { agentName: "__shared:solo", callerSessionId: aliceSession })).toBe(null);
            expect(await r({}, { agentName: "__shared:solo", callerSessionId: bobSession })).toBe(null);
        });

        it("a reserved prefix other than __shared resolves to nothing", async () => {
            // `__system:sweeper` was considered and rejected by the design. It
            // must not quietly fall through to a namespace lookup named
            // "__system", which would make the sentinel space forgeable.
            expect(await res("__system:navigator", aliceSession)).toBe(null);
            expect(await res("__anything:navigator", aliceSession)).toBe(null);
        });

        it("namespace-qualified names keep their original meaning", async () => {
            // `nav:navigator` predates FQNs and must still mean
            // namespace:agent, not owner:package.
            expect((await res("nav:navigator", aliceSession))?.name).toBe("navigator");
            expect((await res("nav:navigator", bobSession))?.prompt).toBe("SHARED NAVIGATOR");
        });
    });
});
