/**
 * Integration round-trip test for the OBO envelope plumbing.
 *
 * Exercises: client.send({envelope}) → durable enqueue → orchestration
 * drain → runTurn activity → decrypt → UserContextStore population.
 *
 * Verifies that a tool handler, called during the turn, can resolve the
 * caller's identity via the worker's UserContextStore.getRaw(sessionId).
 *
 * Run: npx vitest run test/local/obo-envelope-roundtrip.test.js
 */

import { describe, it, expect, beforeAll } from "vitest";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { defineTool } from "../../src/index.ts";
import { InMemoryEnvelopeCrypto } from "../../dist/envelope-crypto.js";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

const SECRET = "ROUNDTRIP-TOKEN-eyJ.do.not.leak";

async function testRoundTrip(env) {
    const crypto = new InMemoryEnvelopeCrypto();
    const seenContexts = [];

    const introspectTool = defineTool({
        name: "introspect_user",
        description: "Reads the active session's user context from the worker's store. Always call this exactly once.",
        parameters: { type: "object", properties: {}, required: [] },
        handler: async (_args, toolCtx) => {
            const sessionId = toolCtx.sessionId;
            const ctx = workerRef.worker.sessionManager?.getUserContextStore?.().getRaw(sessionId) ?? null;
            seenContexts.push({ sessionId, ctx });
            return ctx
                ? `principal=${ctx.principal.provider}:${ctx.principal.subject} token=${ctx.accessToken ? "present" : "null"}`
                : "no context";
        },
    });

    const workerRef = {};
    await withClient(env, {
        tools: [introspectTool],
        worker: {
            // Inject the same in-memory crypto into the worker by overriding
            // selectEnvelopeCrypto via the constructor's optional injection.
            // worker reads from selectEnvelopeCrypto(process.env);
            // for tests, we set the per-process env so it picks Plaintext —
            // but we want InMemory for stronger guarantees, so we hand
            // the crypto in via a private hook (set after construction).
        },
    }, async (client, worker) => {
        workerRef.worker = worker;
        // Inject our test crypto into the worker's session manager.
        // The session-manager owns getEnvelopeCrypto(); for tests we
        // patch the manager directly. Production wiring goes through
        // selectEnvelopeCrypto(process.env).
        const sm = worker.sessionManager;
        if (sm && typeof sm.getEnvelopeCrypto === "function") {
            sm.getEnvelopeCrypto = () => crypto;
        }

        const session = await client.createSession({
            tools: [introspectTool],
            systemMessage: "You are a helper. When asked, call introspect_user exactly once and report what it returned.",
        });

        // Build a token-bearing envelope and encrypt the token portion.
        const cipher = await crypto.encrypt({
            provider: "entra",
            subject: "00000000-0000-0000-0000-000000000abc",
            email: "engineer@contoso.com",
            displayName: "Eng Ineer",
            accessToken: SECRET,
            accessTokenExpiresAt: Date.now() + 3600_000,
        });
        const envelope = {
            v: 1,
            principal: {
                provider: "entra",
                subject: "00000000-0000-0000-0000-000000000abc",
                email: "engineer@contoso.com",
                displayName: "Eng Ineer",
            },
            accessTokenCipher: cipher,
        };

        const reply = await session.sendAndWait(
            "Please call the introspect_user tool exactly once and tell me what it returned.",
            TIMEOUT,
            undefined,
            { envelope },
        );

        // Verify the LLM did call our tool.
        expect(seenContexts.length).toBeGreaterThanOrEqual(1);
        const observed = seenContexts[0].ctx;
        expect(observed).not.toBeNull();
        expect(observed.principal.provider).toBe("entra");
        expect(observed.principal.subject).toBe("00000000-0000-0000-0000-000000000abc");
        expect(observed.principal.email).toBe("engineer@contoso.com");
        expect(observed.accessToken).toBe(SECRET);

        // Reply text should reference identity context (sanity).
        expect(typeof reply).toBe("string");
    });
}

async function testPrincipalOnlyRoundTrip(env) {
    // No accessTokenCipher → UserContextStore populated with token=null.
    const seenContexts = [];

    const introspectTool = defineTool({
        name: "introspect_user",
        description: "Reads the active session's user context. Call exactly once.",
        parameters: { type: "object", properties: {}, required: [] },
        handler: async (_args, toolCtx) => {
            const ctx = workerRef.worker.sessionManager?.getUserContextStore?.().getRaw(toolCtx.sessionId) ?? null;
            seenContexts.push(ctx);
            return ctx ? "got-context" : "no-context";
        },
    });

    const workerRef = {};
    await withClient(env, { tools: [introspectTool] }, async (client, worker) => {
        workerRef.worker = worker;
        const session = await client.createSession({
            tools: [introspectTool],
            systemMessage: "You are a helper. Call introspect_user exactly once and report.",
        });

        const envelope = {
            v: 1,
            principal: {
                provider: "entra",
                subject: "principal-only-user",
                email: null,
                displayName: null,
            },
            accessTokenCipher: null,
        };

        await session.sendAndWait(
            "Please call introspect_user exactly once.",
            TIMEOUT,
            undefined,
            { envelope },
        );

        expect(seenContexts.length).toBeGreaterThanOrEqual(1);
        expect(seenContexts[0]).not.toBeNull();
        expect(seenContexts[0].principal.subject).toBe("principal-only-user");
        expect(seenContexts[0].accessToken).toBeNull();
    });
}

describe("OBO Envelope Round-Trip", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("token-bearing envelope decrypts and populates UserContextStore", { timeout: TIMEOUT }, async () => {
        await testRoundTrip(getEnv());
    });
    it("principal-only envelope (no token) populates principal with null token", { timeout: TIMEOUT }, async () => {
        await testPrincipalOnlyRoundTrip(getEnv());
    });
});
