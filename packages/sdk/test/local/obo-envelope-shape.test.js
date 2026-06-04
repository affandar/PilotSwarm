/**
 * Unit tests for envelope shape normalization (Phase 1).
 *
 * Verifies that null/undefined/missing fields on the wire are normalized
 * consistently into UserContextStore entries.
 */

import { describe, it, expect } from "vitest";
import { UserContextStore } from "../../dist/user-context-store.js";

describe("UserContextStore.setUserContext", () => {
    it("normalizes missing optional fields to null", () => {
        const store = new UserContextStore();
        store.setUserContext("s1", {
            provider: "entra",
            subject: "u1",
            email: undefined,
            displayName: undefined,
            accessToken: undefined,
            accessTokenExpiresAt: undefined,
        });
        const ctx = store.getRaw("s1");
        expect(ctx).not.toBeNull();
        expect(ctx.principal.email).toBeNull();
        expect(ctx.principal.displayName).toBeNull();
        expect(ctx.accessToken).toBeNull();
        expect(ctx.accessTokenExpiresAt).toBeNull();
    });

    it("preserves explicit null fields as null", () => {
        const store = new UserContextStore();
        store.setUserContext("s2", {
            provider: "entra",
            subject: "u2",
            email: null,
            displayName: null,
            accessToken: null,
            accessTokenExpiresAt: null,
        });
        const ctx = store.getRaw("s2");
        expect(ctx.principal.email).toBeNull();
        expect(ctx.accessToken).toBeNull();
    });

    it("preserves explicit values when present", () => {
        const store = new UserContextStore();
        const expiresAt = Date.now() + 3600_000;
        store.setUserContext("s3", {
            provider: "entra",
            subject: "u3",
            email: "e@c.com",
            displayName: "Eng",
            accessToken: "tok",
            accessTokenExpiresAt: expiresAt,
        });
        const ctx = store.getRaw("s3");
        expect(ctx.principal.email).toBe("e@c.com");
        expect(ctx.principal.displayName).toBe("Eng");
        expect(ctx.accessToken).toBe("tok");
        expect(ctx.accessTokenExpiresAt).toBe(expiresAt);
    });

    it("clear() removes the entry idempotently", () => {
        const store = new UserContextStore();
        store.setUserContext("s4", { provider: "entra", subject: "u4", email: null, displayName: null, accessToken: null, accessTokenExpiresAt: null });
        expect(store.size()).toBe(1);
        store.clear("s4");
        expect(store.size()).toBe(0);
        store.clear("s4");
        expect(store.size()).toBe(0);
    });

    it("rejects empty/whitespace sessionId silently (no entry created)", () => {
        const store = new UserContextStore();
        store.setUserContext("", { provider: "entra", subject: "u", email: null, displayName: null, accessToken: null, accessTokenExpiresAt: null });
        store.setUserContext("   ", { provider: "entra", subject: "u", email: null, displayName: null, accessToken: null, accessTokenExpiresAt: null });
        expect(store.size()).toBe(0);
    });

    it("returns null for unknown sessionId", () => {
        const store = new UserContextStore();
        expect(store.getRaw("never-set")).toBeNull();
    });
});
