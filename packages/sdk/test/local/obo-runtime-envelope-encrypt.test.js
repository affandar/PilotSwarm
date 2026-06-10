/**
 * runtime envelope encryption test (FR-020).
 *
 * Asserts:
 *  - When portal/runtime.js receives an authContext whose principal carries a
 *    downstream-scope `accessToken` AND PortalRuntime owns an EnvelopeCrypto,
 *    `buildUserEnvelope` produces a carrier with `accessTokenCipher` populated
 *    (NOT null) — plaintext token never lands on the queue.
 *  - When envelopeCrypto is null (no PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE
 *    configured), the token is dropped and the carrier ships principal-only
 *    with `accessTokenCipher = null`. This is the safe-by-default behavior:
 *    a misconfigured deployment cannot leak plaintext.
 *  - When an authContext has no accessToken at all (legacy principal-only compat),
 *    cipher stays null regardless of envelopeCrypto.
 *  - When encryption throws, the runtime logs and ships principal-only —
 *    NEVER plaintext (FR-020 guard).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PortalRuntime } from "../../../portal/runtime.js";
import { InMemoryEnvelopeCrypto } from "../../src/envelope-crypto.js";

const PRINCIPAL = {
    provider: "entra",
    subject: "00000000-0000-0000-0000-000000000001",
    email: "engineer@contoso.com",
    displayName: "Eng Ineer",
};

function buildRuntime({ envelopeCrypto = null } = {}) {
    const calls = [];
    const transport = new Proxy({}, {
        get(_, prop) {
            if (prop === "start" || prop === "stop") return async () => {};
            return async (...args) => {
                calls.push({ method: prop, args });
                return null;
            };
        },
    });
    const runtime = Object.create(PortalRuntime.prototype);
    runtime.transport = transport;
    runtime.mode = "embedded";
    runtime.started = true;
    runtime.startPromise = null;
    runtime.envelopeCrypto = envelopeCrypto;
    return { runtime, calls };
}

describe("portal runtime envelope encryption", () => {
    let warnSpy;
    beforeEach(() => {
        warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
        warnSpy.mockRestore();
    });

    it("encrypts accessToken when both token and EnvelopeCrypto are present", async () => {
        const crypto = new InMemoryEnvelopeCrypto();
        const { runtime, calls } = buildRuntime({ envelopeCrypto: crypto });
        const authContext = {
            principal: {
                ...PRINCIPAL,
                accessToken: "user-access-token-XYZ",
                accessTokenExpiresAt: Date.now() + 3600_000,
            },
        };
        await runtime.call("sendMessage", { sessionId: "s1", prompt: "hi", options: {} }, authContext);
        const envelope = calls[0].args[2].envelope;
        expect(envelope.v).toBe(1);
        expect(envelope.principal.subject).toBe(PRINCIPAL.subject);
        expect(envelope.accessTokenCipher).not.toBeNull();
        expect(envelope.accessTokenCipher.kekKid).toMatch(/^in-memory:/);
        // Plaintext must not appear anywhere in the envelope.
        const flat = JSON.stringify(envelope);
        expect(flat).not.toContain("user-access-token-XYZ");
    });

    it("decrypted cipher round-trips back to the original token payload", async () => {
        const crypto = new InMemoryEnvelopeCrypto();
        const { runtime, calls } = buildRuntime({ envelopeCrypto: crypto });
        const expiresAt = Date.now() + 1_800_000;
        await runtime.call("sendAnswer", { sessionId: "s1", answer: "ok" }, {
            principal: {
                ...PRINCIPAL,
                accessToken: "round-trip-token",
                accessTokenExpiresAt: expiresAt,
            },
        });
        const cipher = calls[0].args[2].envelope.accessTokenCipher;
        const payload = await crypto.decrypt(cipher);
        expect(payload.accessToken).toBe("round-trip-token");
        expect(payload.accessTokenExpiresAt).toBe(expiresAt);
    });

    it("drops token when no EnvelopeCrypto is configured (safe-by-default)", async () => {
        const { runtime, calls } = buildRuntime({ envelopeCrypto: null });
        await runtime.call("sendMessage", { sessionId: "s1", prompt: "hi", options: {} }, {
            principal: {
                ...PRINCIPAL,
                accessToken: "user-access-token-XYZ",
                accessTokenExpiresAt: Date.now() + 3600_000,
            },
        });
        const envelope = calls[0].args[2].envelope;
        expect(envelope.principal.subject).toBe(PRINCIPAL.subject);
        expect(envelope.accessTokenCipher).toBeNull();
        const flat = JSON.stringify(envelope);
        expect(flat).not.toContain("user-access-token-XYZ");
    });

    it("ships principal-only when authContext has no accessToken (legacy principal-only compat)", async () => {
        const crypto = new InMemoryEnvelopeCrypto();
        const { runtime, calls } = buildRuntime({ envelopeCrypto: crypto });
        await runtime.call("sendMessage", { sessionId: "s1", prompt: "hi", options: {} }, { principal: PRINCIPAL });
        const envelope = calls[0].args[2].envelope;
        expect(envelope.principal.subject).toBe(PRINCIPAL.subject);
        expect(envelope.accessTokenCipher).toBeNull();
    });

    it("falls back to principal-only when encryption throws (no plaintext leak)", async () => {
        const failingCrypto = {
            backend: "in-memory",
            kekKid: "broken",
            async encrypt() { throw new Error("simulated KEK outage"); },
            async decrypt() { throw new Error("nope"); },
        };
        const { runtime, calls } = buildRuntime({ envelopeCrypto: failingCrypto });
        await runtime.call("sendMessage", { sessionId: "s1", prompt: "hi", options: {} }, {
            principal: {
                ...PRINCIPAL,
                accessToken: "secret-must-not-leak",
                accessTokenExpiresAt: Date.now() + 600_000,
            },
        });
        const envelope = calls[0].args[2].envelope;
        expect(envelope.accessTokenCipher).toBeNull();
        const flat = JSON.stringify(envelope);
        expect(flat).not.toContain("secret-must-not-leak");
        expect(warnSpy).toHaveBeenCalled();
    });

    it("createSessionForAgent also encrypts when token + crypto present", async () => {
        const crypto = new InMemoryEnvelopeCrypto();
        const { runtime, calls } = buildRuntime({ envelopeCrypto: crypto });
        await runtime.call("createSessionForAgent", { agentName: "helper" }, {
            principal: {
                ...PRINCIPAL,
                accessToken: "csfa-token",
                accessTokenExpiresAt: Date.now() + 3600_000,
            },
        });
        const envelope = calls[0].args[1].envelope;
        expect(envelope.accessTokenCipher).not.toBeNull();
        const payload = await crypto.decrypt(envelope.accessTokenCipher);
        expect(payload.accessToken).toBe("csfa-token");
    });
});
