// User-context store unit tests.
// Covers FR-008, FR-009, FR-021, FR-022 + plan-promised edge cases:
//   - Principal-only entry
//   - Single-source-of-truth chain walk
//   - Intermediate-evicted chain walk (Gemini #1)
//   - System root returns null
//   - Broken chain returns null
//   - Token refresh propagation
//   - Cycle / depth-cap defense
//   - Child becomes its own portal-bound root

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { UserContextStore } from "../../src/user-context-store.ts";

describe("UserContextStore", () => {
    let store;

    beforeEach(() => {
        store = new UserContextStore();
    });

    describe("setUserContext + getRaw round-trip", () => {
        it("populates and reads back a full envelope", () => {
            store.setUserContext("s1", {
                provider: "entra",
                subject: "user-1",
                email: "u1@example.com",
                displayName: "User One",
                accessToken: "tok-1",
                accessTokenExpiresAt: 1_700_000_000_000,
            });
            const got = store.getRaw("s1");
            expect(got).toEqual({
                principal: {
                    provider: "entra",
                    subject: "user-1",
                    email: "u1@example.com",
                    displayName: "User One",
                },
                accessToken: "tok-1",
                accessTokenExpiresAt: 1_700_000_000_000,
            });
        });

        it("returns null for unknown id", () => {
            expect(store.getRaw("nope")).toBeNull();
        });

        it("returns a defensive copy from getRaw (mutation does not leak)", () => {
            store.setUserContext("s1", {
                provider: "entra", subject: "u", accessToken: "t", accessTokenExpiresAt: 1,
            });
            const got = store.getRaw("s1");
            got.accessToken = "TAMPERED";
            const fresh = store.getRaw("s1");
            expect(fresh.accessToken).toBe("t");
        });
    });

    describe("principal-only entry (FR-008 / P1 scenario 2 / A-8)", () => {
        it("succeeds with null token fields and lookup returns null tokens, not null context", () => {
            store.bindParent("s1", { parentSessionId: null, isSystem: false });
            store.setUserContext("s1", {
                provider: "entra",
                subject: "u",
                email: "u@e.com",
                displayName: "U",
                accessToken: null,
                accessTokenExpiresAt: null,
            });
            const got = store.lookup("s1");
            expect(got).not.toBeNull();
            expect(got.principal.subject).toBe("u");
            expect(got.accessToken).toBeNull();
            expect(got.accessTokenExpiresAt).toBeNull();
        });

        it("normalizes undefined email/displayName to null", () => {
            store.setUserContext("s1", { provider: "entra", subject: "u" });
            const got = store.getRaw("s1");
            expect(got.principal.email).toBeNull();
            expect(got.principal.displayName).toBeNull();
            expect(got.accessToken).toBeNull();
            expect(got.accessTokenExpiresAt).toBeNull();
        });
    });

    describe("lookup chain walk (FR-021 single source of truth)", () => {
        it("child without own entry walks to parent's entry", () => {
            store.bindParent("parent", { parentSessionId: null, isSystem: false });
            store.bindParent("child", { parentSessionId: "parent", isSystem: false });
            store.setUserContext("parent", {
                provider: "entra", subject: "u", accessToken: "tok", accessTokenExpiresAt: 1,
            });
            const got = store.lookup("child");
            expect(got.principal.subject).toBe("u");
            expect(got.accessToken).toBe("tok");
            // Critically: the child has NO entry of its own.
            expect(store.getRaw("child")).toBeNull();
        });

        it("walks depth >= 2 to portal-bound root", () => {
            store.bindParent("root", { parentSessionId: null, isSystem: false });
            store.bindParent("mid", { parentSessionId: "root", isSystem: false });
            store.bindParent("leaf", { parentSessionId: "mid", isSystem: false });
            store.setUserContext("root", { provider: "p", subject: "u", accessToken: "t", accessTokenExpiresAt: 1 });
            expect(store.lookup("leaf").accessToken).toBe("t");
        });

        it("intermediate-evicted (Gemini #1): leaf still resolves to root after mid entry cleared", () => {
            store.bindParent("root", { parentSessionId: null, isSystem: false });
            store.bindParent("mid", { parentSessionId: "root", isSystem: false });
            store.bindParent("leaf", { parentSessionId: "mid", isSystem: false });
            store.setUserContext("mid", { provider: "p", subject: "mid-user", accessToken: "mid-tok", accessTokenExpiresAt: 1 });
            store.setUserContext("root", { provider: "p", subject: "root-user", accessToken: "root-tok", accessTokenExpiresAt: 2 });
            // Mid session terminates: its user-context entry is cleared, but
            // parent-map binding persists (per the user-OBO lifecycle).
            store.clear("mid");
            const got = store.lookup("leaf");
            // Mid is gone → walk past it to root.
            expect(got.principal.subject).toBe("root-user");
            expect(got.accessToken).toBe("root-tok");
        });
    });

    describe("FR-009 system root returns null", () => {
        it("chain rooted at isSystem returns null even if entry would otherwise resolve", () => {
            store.bindParent("sysRoot", { parentSessionId: null, isSystem: true });
            store.bindParent("child", { parentSessionId: "sysRoot", isSystem: false });
            // Even if someone illegally populated an entry on the system root:
            store.setUserContext("sysRoot", { provider: "p", subject: "u", accessToken: "t", accessTokenExpiresAt: 1 });
            expect(store.lookup("child")).toBeNull();
            expect(store.lookup("sysRoot")).toBeNull();
        });
    });

    describe("FR-022 fail-safe null", () => {
        it("returns null when parent map is missing for the leaf", () => {
            // No bindParent for "ghost".
            expect(store.lookup("ghost")).toBeNull();
        });

        it("returns null when chain breaks (parent-map missing for ancestor)", () => {
            store.bindParent("leaf", { parentSessionId: "vanished-parent", isSystem: false });
            // No entry on leaf, walk to vanished-parent, no binding → null.
            expect(store.lookup("leaf")).toBeNull();
        });

        it("returns null when root reached with no entry", () => {
            store.bindParent("root", { parentSessionId: null, isSystem: false });
            // No setUserContext on root.
            expect(store.lookup("root")).toBeNull();
        });
    });

    describe("token refresh propagation (FR-021 free refresh)", () => {
        it("updating parent entry is observed by descendant on next lookup", () => {
            store.bindParent("parent", { parentSessionId: null, isSystem: false });
            store.bindParent("child", { parentSessionId: "parent", isSystem: false });
            store.setUserContext("parent", { provider: "p", subject: "u", accessToken: "tok-old", accessTokenExpiresAt: 1 });
            expect(store.lookup("child").accessToken).toBe("tok-old");
            store.setUserContext("parent", { provider: "p", subject: "u", accessToken: "tok-new", accessTokenExpiresAt: 2 });
            expect(store.lookup("child").accessToken).toBe("tok-new");
            expect(store.lookup("child").accessTokenExpiresAt).toBe(2);
        });
    });

    describe("cycle / depth-cap defense", () => {
        it("returns null with a console.warn on cycle exceeding depth cap", () => {
            const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
            // Build a cycle: a→b→a
            store.bindParent("a", { parentSessionId: "b", isSystem: false });
            store.bindParent("b", { parentSessionId: "a", isSystem: false });
            const got = store.lookup("a");
            expect(got).toBeNull();
            expect(warn).toHaveBeenCalled();
            warn.mockRestore();
        });
    });

    describe("child becomes its own portal-bound root", () => {
        it("setUserContext on a previously-chain-walking child stops the walk at that child", () => {
            store.bindParent("parent", { parentSessionId: null, isSystem: false });
            store.bindParent("child", { parentSessionId: "parent", isSystem: false });
            store.bindParent("grand", { parentSessionId: "child", isSystem: false });
            store.setUserContext("parent", { provider: "p", subject: "parent-u", accessToken: "parent-tok", accessTokenExpiresAt: 1 });
            // Initially grand resolves to parent.
            expect(store.lookup("grand").principal.subject).toBe("parent-u");
            // Child later becomes its own portal-bound root.
            store.setUserContext("child", { provider: "p", subject: "child-u", accessToken: "child-tok", accessTokenExpiresAt: 2 });
            // grand now resolves to child, not parent.
            expect(store.lookup("grand").principal.subject).toBe("child-u");
            expect(store.lookup("grand").accessToken).toBe("child-tok");
            // child itself also resolves to child (it has its own entry).
            expect(store.lookup("child").principal.subject).toBe("child-u");
        });
    });

    describe("clear vs clearParent semantics", () => {
        it("clear removes only the user-context entry; parent-map binding persists for descendants", () => {
            store.bindParent("root", { parentSessionId: null, isSystem: false });
            store.bindParent("mid", { parentSessionId: "root", isSystem: false });
            store.bindParent("leaf", { parentSessionId: "mid", isSystem: false });
            store.setUserContext("root", { provider: "p", subject: "u", accessToken: "tok", accessTokenExpiresAt: 1 });
            store.setUserContext("mid", { provider: "p", subject: "mid", accessToken: "mid-tok", accessTokenExpiresAt: 2 });
            store.clear("mid");
            // Mid's entry gone but its parent-map binding survives so leaf can chain past it.
            expect(store.getRaw("mid")).toBeNull();
            expect(store.lookup("leaf").principal.subject).toBe("u");
        });

        it("clearParent removes only the structural binding", () => {
            store.bindParent("a", { parentSessionId: null, isSystem: false });
            store.setUserContext("a", { provider: "p", subject: "u", accessToken: "t", accessTokenExpiresAt: 1 });
            store.clearParent("a");
            // Entry persists if not also cleared.
            expect(store.getRaw("a")).not.toBeNull();
            // But lookup chain walk fails because parent-map binding is gone.
            expect(store.lookup("a")).toBeNull();
        });

        it("clear is idempotent on unknown id", () => {
            expect(() => store.clear("nope")).not.toThrow();
        });
    });

    describe("hasParentBinding", () => {
        it("returns true only after bindParent", () => {
            expect(store.hasParentBinding("x")).toBe(false);
            store.bindParent("x", { parentSessionId: null, isSystem: false });
            expect(store.hasParentBinding("x")).toBe(true);
            store.clearParent("x");
            expect(store.hasParentBinding("x")).toBe(false);
        });
    });

    describe("size accessors", () => {
        it("size reflects entry count; parentSize reflects parent-map count; independent", () => {
            expect(store.size()).toBe(0);
            expect(store.parentSize()).toBe(0);
            store.bindParent("a", { parentSessionId: null, isSystem: false });
            store.bindParent("b", { parentSessionId: "a", isSystem: false });
            expect(store.parentSize()).toBe(2);
            expect(store.size()).toBe(0);
            store.setUserContext("a", { provider: "p", subject: "u", accessToken: "t", accessTokenExpiresAt: 1 });
            expect(store.size()).toBe(1);
        });
    });

    describe("input normalization", () => {
        it("trims sessionId on all APIs and ignores empty", () => {
            store.bindParent("  s1  ", { parentSessionId: null, isSystem: false });
            store.setUserContext("  s1  ", { provider: "p", subject: "u", accessToken: "t", accessTokenExpiresAt: 1 });
            expect(store.lookup("s1")).not.toBeNull();
            expect(store.getRaw("s1")).not.toBeNull();
            expect(store.hasParentBinding("s1")).toBe(true);
            store.bindParent("", { parentSessionId: null, isSystem: false });
            expect(store.hasParentBinding("")).toBe(false);
            store.setUserContext("   ", { provider: "p", subject: "u" });
            expect(store.size()).toBe(1);  // only the s1 one
        });
    });
});
