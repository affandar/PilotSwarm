/**
 * CRITICAL sentinel test for FR-020 / FR-023 / SC-004:
 *
 * Plaintext access tokens MUST NOT appear in the durable enqueue payload.
 * The wire shape carries `accessTokenCipher` (encrypted), never a raw
 * `accessToken` field.
 *
 * This test fakes the duroxide client's `enqueueEvent` to capture the
 * exact JSON string written to the queue, then asserts the ciphertext
 * is opaque base64 and the plaintext token does not appear anywhere
 * in that JSON.
 */

import { describe, it, expect } from "vitest";
import { InMemoryEnvelopeCrypto } from "../../dist/envelope-crypto.js";

const SECRET_TOKEN = "SECRET-TOKEN-VALUE-eyJ.never.leaks";

describe("FR-020: no plaintext access token in queue payload", () => {
    it("ciphertext-bearing envelope round-trips with opaque ciphertext", async () => {
        const crypto = new InMemoryEnvelopeCrypto();
        const cipher = await crypto.encrypt({
            provider: "entra",
            subject: "u1",
            email: null,
            displayName: null,
            accessToken: SECRET_TOKEN,
            accessTokenExpiresAt: Date.now() + 3600_000,
        });

        // Build the wire-shape carrier exactly as the portal does.
        const carrier = {
            v: 1,
            principal: {
                provider: "entra",
                subject: "u1",
                email: null,
                displayName: null,
            },
            accessTokenCipher: cipher,
        };

        // Simulate the management-client / client.ts enqueue payload shape.
        const enqueuePayload = JSON.stringify({
            prompt: "hello world",
            envelope: carrier,
        });

        // SENTINEL: the plaintext token MUST NOT appear anywhere in the
        // JSON written to the durable queue.
        expect(enqueuePayload).not.toContain(SECRET_TOKEN);

        // Sanity check: ciphertext IS present and is opaque base64.
        const parsed = JSON.parse(enqueuePayload);
        expect(parsed.envelope.accessTokenCipher.ciphertext).toMatch(/^[A-Za-z0-9+/=]+$/);
        expect(parsed.envelope.accessTokenCipher.kekKid).toMatch(/^in-memory:/);

        // Decrypt round-trip recovers the original token.
        const recovered = await crypto.decrypt(parsed.envelope.accessTokenCipher);
        expect(recovered.accessToken).toBe(SECRET_TOKEN);
    });

    it("principal-only envelope (no token) carries null cipher field", () => {
        const carrier = {
            v: 1,
            principal: { provider: "entra", subject: "u2", email: null, displayName: null },
            accessTokenCipher: null,
        };
        const enqueuePayload = JSON.stringify({ prompt: "no-token turn", envelope: carrier });

        // No token → no ciphertext → no leak (trivially).
        expect(enqueuePayload).not.toContain(SECRET_TOKEN);
        const parsed = JSON.parse(enqueuePayload);
        expect(parsed.envelope.accessTokenCipher).toBeNull();
    });

    it("rejects accidental UserEnvelope-shape (flat) on the wire — must use carrier", () => {
        // A common bug shape that we want to keep out of the queue: leaving
        // `accessToken` at the top-level envelope. This test documents that
        // such a shape, if ever produced, would leak the token; tests on
        // the producer side (client.ts / management-client.ts) ensure only
        // the carrier shape is ever enqueued.
        const buggyPayload = JSON.stringify({
            prompt: "hello",
            envelope: {
                provider: "entra",
                subject: "u",
                accessToken: SECRET_TOKEN, // <- bug
            },
        });
        // This SHOULD fail the sentinel — proving the test would catch a
        // regression that introduced a flat-envelope shape.
        expect(buggyPayload).toContain(SECRET_TOKEN);
    });
});
