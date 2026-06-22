/**
 * Unit tests for the envelope-crypto backends and selectEnvelopeCrypto factory.
 *
 * Covers FR-008 / FR-020 / FR-023:
 *   - InMemoryEnvelopeCrypto round-trip + cross-mode refusal
 *   - PlaintextEnvelopeCrypto refuses production
 *   - selectEnvelopeCrypto rules by env vars
 *
 * Pure unit tests — no live worker / no DB. Safe to run in any environment.
 */

import { describe, it, expect, vi } from "vitest";
import {
    InMemoryEnvelopeCrypto,
    PlaintextEnvelopeCrypto,
    AkvEnvelopeCrypto,
    selectEnvelopeCrypto,
} from "../../dist/envelope-crypto.js";

const SAMPLE_ENVELOPE = {
    provider: "entra",
    subject: "00000000-0000-0000-0000-000000000001",
    email: "engineer@contoso.com",
    displayName: "Eng Ineer",
    accessToken: "eyJ.fake.token",
    accessTokenExpiresAt: Date.now() + 3600_000,
};

describe("InMemoryEnvelopeCrypto", () => {
    it("round-trips a token-bearing envelope", async () => {
        const crypto = new InMemoryEnvelopeCrypto();
        const cipher = await crypto.encrypt(SAMPLE_ENVELOPE);
        expect(cipher).not.toBeNull();
        expect(cipher.kekKid).toMatch(/^in-memory:/);
        expect(cipher.ciphertext).toMatch(/^[A-Za-z0-9+/=]+$/);

        const plain = await crypto.decrypt(cipher);
        expect(plain.accessToken).toBe(SAMPLE_ENVELOPE.accessToken);
        expect(plain.accessTokenExpiresAt).toBe(SAMPLE_ENVELOPE.accessTokenExpiresAt);
    });

    it("returns null when envelope carries no token", async () => {
        const crypto = new InMemoryEnvelopeCrypto();
        const cipher = await crypto.encrypt({
            ...SAMPLE_ENVELOPE,
            accessToken: null,
            accessTokenExpiresAt: null,
        });
        expect(cipher).toBeNull();
    });

    it("refuses to decrypt cross-mode (plaintext-mode) ciphertext", async () => {
        const inmem = new InMemoryEnvelopeCrypto();
        const plain = new PlaintextEnvelopeCrypto();
        const plainCipher = await plain.encrypt(SAMPLE_ENVELOPE);
        await expect(inmem.decrypt(plainCipher)).rejects.toThrow(/cross-mode|kid/i);
    });

    it("refuses to decrypt ciphertext from a different in-memory instance", async () => {
        const a = new InMemoryEnvelopeCrypto();
        const b = new InMemoryEnvelopeCrypto();
        const cipherA = await a.encrypt(SAMPLE_ENVELOPE);
        await expect(b.decrypt(cipherA)).rejects.toThrow(/KEK mismatch/i);
    });
});

describe("PlaintextEnvelopeCrypto", () => {
    it("round-trips a token-bearing envelope", async () => {
        const crypto = new PlaintextEnvelopeCrypto();
        const cipher = await crypto.encrypt(SAMPLE_ENVELOPE);
        expect(cipher).not.toBeNull();
        expect(cipher.kekKid).toBe("plaintext-mode");

        const plain = await crypto.decrypt(cipher);
        expect(plain.accessToken).toBe(SAMPLE_ENVELOPE.accessToken);
    });

    it("refuses to construct when NODE_ENV=production", () => {
        const prev = process.env.NODE_ENV;
        process.env.NODE_ENV = "production";
        try {
            expect(() => new PlaintextEnvelopeCrypto()).toThrow(/production/i);
        } finally {
            process.env.NODE_ENV = prev;
        }
    });

    it("refuses to decrypt in-memory ciphertext", async () => {
        const inmem = new InMemoryEnvelopeCrypto();
        const plain = new PlaintextEnvelopeCrypto();
        const inmemCipher = await inmem.encrypt(SAMPLE_ENVELOPE);
        await expect(plain.decrypt(inmemCipher)).rejects.toThrow(/non-plaintext-mode|cross-mode|kid/i);
    });
});

describe("AkvEnvelopeCrypto", () => {
    it("rejects a kekKid that is not a full AKV key URL", () => {
        expect(() => new AkvEnvelopeCrypto("just-a-kid")).toThrow(/AKV key URL/i);
        expect(() => new AkvEnvelopeCrypto("")).toThrow();
    });

    it("accepts an https AKV key URL", () => {
        const crypto = new AkvEnvelopeCrypto("https://kv.vault.azure.net/keys/obo-kek/abc123");
        expect(crypto.backend).toBe("akv");
        expect(crypto.kekKid).toBe("https://kv.vault.azure.net/keys/obo-kek/abc123");
    });
});

describe("selectEnvelopeCrypto", () => {
    it("returns null when no downstream scope is configured", () => {
        const result = selectEnvelopeCrypto({});
        expect(result).toBeNull();
    });

    it("returns AKV backend when scope + OBO_KEK_KID are set", () => {
        const result = selectEnvelopeCrypto({
            PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE: "api://worker/.default",
            OBO_KEK_KID: "https://kv.vault.azure.net/keys/obo-kek/abc",
        });
        expect(result?.backend).toBe("akv");
    });

    it("returns Plaintext backend when scope + OBO_ENVELOPE_PLAINTEXT_MODE=1 in non-prod", () => {
        const result = selectEnvelopeCrypto({
            PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE: "api://worker/.default",
            OBO_ENVELOPE_PLAINTEXT_MODE: "1",
            NODE_ENV: "development",
        });
        expect(result?.backend).toBe("plaintext");
    });

    it("throws when scope is set but neither KEK nor plaintext-mode is configured", () => {
        expect(() =>
            selectEnvelopeCrypto({
                PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE: "api://worker/.default",
            }),
        ).toThrow(/OBO_KEK_KID|OBO_ENVELOPE_PLAINTEXT_MODE/);
    });

    it("throws when OBO_ENVELOPE_PLAINTEXT_MODE=1 + NODE_ENV=production", () => {
        expect(() =>
            selectEnvelopeCrypto({
                PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE: "api://worker/.default",
                OBO_ENVELOPE_PLAINTEXT_MODE: "1",
                NODE_ENV: "production",
            }),
        ).toThrow(/production/i);
    });
});

describe("selectEnvelopeCrypto plaintext-mode startup warning", () => {
    // Asserts the loud operator-visible warning that fires when a deployment
    // selects PlaintextEnvelopeCrypto via OBO_ENVELOPE_PLAINTEXT_MODE=1.
    // Without this the only signal that a stamp shipped with unencrypted
    // user access tokens on the wire would be the live-tenant smoke check
    // (release-gate, but post-build). This unit test catches a regression
    // that silences the warning at the factory layer (envelope-crypto.ts:321).

    it("emits a console.warn naming plaintext-mode and the NOT-encrypted risk", () => {
        const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const result = selectEnvelopeCrypto({
                PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE: "api://worker/.default",
                OBO_ENVELOPE_PLAINTEXT_MODE: "1",
                NODE_ENV: "development",
            });
            expect(result?.backend).toBe("plaintext");
            expect(spy).toHaveBeenCalledTimes(1);
            const msg = String(spy.mock.calls[0][0] ?? "");
            expect(msg).toMatch(/envelope-crypto/i);
            expect(msg).toMatch(/OBO_ENVELOPE_PLAINTEXT_MODE/);
            expect(msg).toMatch(/NOT encrypted/i);
        } finally {
            spy.mockRestore();
        }
    });

    it("does NOT emit the plaintext warning when AKV backend is selected", () => {
        const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const result = selectEnvelopeCrypto({
                PORTAL_AUTH_ENTRA_DOWNSTREAM_SCOPE: "api://worker/.default",
                OBO_KEK_KID: "https://kv.vault.azure.net/keys/obo-kek/abc",
            });
            expect(result?.backend).toBe("akv");
            const plaintextWarnings = spy.mock.calls
                .map((c) => String(c[0] ?? ""))
                .filter((m) => /OBO_ENVELOPE_PLAINTEXT_MODE/.test(m));
            expect(plaintextWarnings).toEqual([]);
        } finally {
            spy.mockRestore();
        }
    });

    it("does NOT emit the plaintext warning when scope is unset (OBO disabled)", () => {
        const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const result = selectEnvelopeCrypto({});
            expect(result).toBeNull();
            expect(spy).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });
});
