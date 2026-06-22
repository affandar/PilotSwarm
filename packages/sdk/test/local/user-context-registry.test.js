// Worker registry / public lookup tests.
// Covers AsyncLocalStorage-affine resolution, single-worker fallback,
// multi-worker ambiguity, and defensive-copy semantics on the public
// getUserContextForSession entry point.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    registerSessionManager,
    unregisterSessionManager,
    runWithSessionManager,
    resolveActiveSessionManager,
    getUserContextForSession,
} from "../../src/worker-registry.ts";
import { UserContextStore } from "../../src/user-context-store.ts";

// Minimal SessionManager-shaped stub. The registry only ever calls
// `.getUserContextStore()` on the registered manager.
function makeFakeManager(label) {
    const store = new UserContextStore();
    return {
        label,
        getUserContextStore() { return store; },
        _store: store,
    };
}

// Each test starts with an empty registry (other tests in this file
// must clean up after themselves).
beforeEach(() => {
    // Nothing to do globally; tests register/unregister their own.
});

describe("worker-registry: resolveActiveSessionManager", () => {
    it("returns null with no registered worker", () => {
        expect(resolveActiveSessionManager()).toBeNull();
    });

    it("returns the lone registered worker (single-worker fallback)", () => {
        const sm = makeFakeManager("only");
        registerSessionManager(sm);
        try {
            expect(resolveActiveSessionManager()).toBe(sm);
        } finally {
            unregisterSessionManager(sm);
        }
    });

    it("returns null when multiple workers are registered and ALS is not set", () => {
        const a = makeFakeManager("a");
        const b = makeFakeManager("b");
        registerSessionManager(a);
        registerSessionManager(b);
        try {
            expect(resolveActiveSessionManager()).toBeNull();
        } finally {
            unregisterSessionManager(a);
            unregisterSessionManager(b);
        }
    });

    it("ALS-published manager wins even when multiple workers are registered", async () => {
        const a = makeFakeManager("a");
        const b = makeFakeManager("b");
        registerSessionManager(a);
        registerSessionManager(b);
        try {
            await runWithSessionManager(a, async () => {
                expect(resolveActiveSessionManager()).toBe(a);
            });
            await runWithSessionManager(b, async () => {
                expect(resolveActiveSessionManager()).toBe(b);
            });
        } finally {
            unregisterSessionManager(a);
            unregisterSessionManager(b);
        }
    });

    it("ALS context is restored after async hops within the wrapped fn", async () => {
        const sm = makeFakeManager("only");
        registerSessionManager(sm);
        try {
            await runWithSessionManager(sm, async () => {
                await Promise.resolve();
                await new Promise(r => setTimeout(r, 1));
                expect(resolveActiveSessionManager()).toBe(sm);
            });
        } finally {
            unregisterSessionManager(sm);
        }
    });
});

describe("worker-registry: getUserContextForSession", () => {
    it("returns null with no active worker", () => {
        expect(getUserContextForSession("any")).toBeNull();
    });

    it("resolves through the ALS-published manager's UserContextStore", async () => {
        const sm = makeFakeManager("only");
        sm._store.bindParent("s1", { parentSessionId: null, isSystem: false });
        sm._store.setUserContext("s1", {
            provider: "entra", subject: "u-1", accessToken: "tok-1", accessTokenExpiresAt: 1,
        });
        registerSessionManager(sm);
        try {
            await runWithSessionManager(sm, async () => {
                const got = getUserContextForSession("s1");
                expect(got).not.toBeNull();
                expect(got.principal.subject).toBe("u-1");
                expect(got.accessToken).toBe("tok-1");
            });
        } finally {
            unregisterSessionManager(sm);
        }
    });

    it("returns null on multi-worker ambiguity even if BOTH workers have the session", () => {
        const a = makeFakeManager("a");
        const b = makeFakeManager("b");
        a._store.bindParent("s1", { parentSessionId: null, isSystem: false });
        a._store.setUserContext("s1", { provider: "p", subject: "from-a", accessToken: "tok-a", accessTokenExpiresAt: 1 });
        b._store.bindParent("s1", { parentSessionId: null, isSystem: false });
        b._store.setUserContext("s1", { provider: "p", subject: "from-b", accessToken: "tok-b", accessTokenExpiresAt: 2 });
        registerSessionManager(a);
        registerSessionManager(b);
        try {
            // No ALS context → fallback rejects ambiguity to avoid leak.
            expect(getUserContextForSession("s1")).toBeNull();
        } finally {
            unregisterSessionManager(a);
            unregisterSessionManager(b);
        }
    });

    it("returns a defensive copy that cannot mutate stored state", async () => {
        const sm = makeFakeManager("only");
        sm._store.bindParent("s1", { parentSessionId: null, isSystem: false });
        sm._store.setUserContext("s1", {
            provider: "entra", subject: "u-1", accessToken: "tok-1", accessTokenExpiresAt: 1,
        });
        registerSessionManager(sm);
        try {
            await runWithSessionManager(sm, async () => {
                const got = getUserContextForSession("s1");
                got.accessToken = "OVERWRITE";
                got.principal.subject = "OVERWRITE";
                const fresh = getUserContextForSession("s1");
                expect(fresh.accessToken).toBe("tok-1");
                expect(fresh.principal.subject).toBe("u-1");
            });
        } finally {
            unregisterSessionManager(sm);
        }
    });

    it("returns null for unknown session id on a valid worker", async () => {
        const sm = makeFakeManager("only");
        registerSessionManager(sm);
        try {
            await runWithSessionManager(sm, async () => {
                expect(getUserContextForSession("ghost")).toBeNull();
            });
        } finally {
            unregisterSessionManager(sm);
        }
    });

    it("returns null when SessionManager.getUserContextStore throws", async () => {
        const bad = {
            getUserContextStore() { throw new Error("boom"); },
        };
        registerSessionManager(bad);
        try {
            await runWithSessionManager(bad, async () => {
                expect(getUserContextForSession("s1")).toBeNull();
            });
        } finally {
            unregisterSessionManager(bad);
        }
    });
});

describe("worker-registry: cross-worker isolation under ALS", () => {
    it("tool handler in worker A cannot see worker B's token material", async () => {
        const a = makeFakeManager("a");
        const b = makeFakeManager("b");
        a._store.bindParent("shared-id", { parentSessionId: null, isSystem: false });
        a._store.setUserContext("shared-id", { provider: "p", subject: "from-a", accessToken: "tok-a", accessTokenExpiresAt: 1 });
        b._store.bindParent("shared-id", { parentSessionId: null, isSystem: false });
        b._store.setUserContext("shared-id", { provider: "p", subject: "from-b", accessToken: "tok-b", accessTokenExpiresAt: 2 });
        registerSessionManager(a);
        registerSessionManager(b);
        try {
            await runWithSessionManager(a, async () => {
                const got = getUserContextForSession("shared-id");
                expect(got.accessToken).toBe("tok-a");
                expect(got.accessToken).not.toBe("tok-b");
            });
            await runWithSessionManager(b, async () => {
                const got = getUserContextForSession("shared-id");
                expect(got.accessToken).toBe("tok-b");
                expect(got.accessToken).not.toBe("tok-a");
            });
        } finally {
            unregisterSessionManager(a);
            unregisterSessionManager(b);
        }
    });
});
