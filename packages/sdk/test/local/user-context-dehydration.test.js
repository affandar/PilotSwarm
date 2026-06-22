// dehydration-exclusion guard.
//
// The UserContextStore lives ONLY in pod memory. It is never persisted
// to the SessionStore (filesystem or blob), never serialized into the
// dehydration blob, never included in the Duroxide activity-input
// history (the cipher path already enforces the cipher path; this test guards
// against an accidental future change that would persist plaintext).
//
// Strategy: instantiate the store, populate it with a sentinel token,
// and assert:
//   (1) No SessionStore-shaped file under packages/sdk/src/ references
//       the UserContextStore by name in a "save"/"serialize" context.
//   (2) JSON.stringify of the store instance yields the empty object
//       (the store has no enumerable persistable state; vitest's
//       structuredClone-able shape is the canonical "what would land
//       in a snapshot" surface).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { UserContextStore } from "../../src/user-context-store.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_SRC = resolve(__dirname, "../../src");

describe("UserContextStore dehydration exclusion", () => {
    it("JSON.stringify-ing a populated store does not expose token material via enumerable state", () => {
        const store = new UserContextStore();
        store.bindParent("s1", { parentSessionId: null, isSystem: false });
        store.setUserContext("s1", {
            provider: "entra",
            subject: "u-1",
            email: "u1@example.com",
            displayName: "User One",
            accessToken: "SENTINEL-TOKEN-SHOULD-NEVER-LEAK",
            accessTokenExpiresAt: 1,
        });
        // Maps are not enumerable via JSON.stringify by default. The
        // store has no enumerable persistable field, so a naive snapshot
        // would never include the token.
        const json = JSON.stringify(store);
        expect(json).not.toContain("SENTINEL-TOKEN-SHOULD-NEVER-LEAK");
        expect(json).not.toContain("u1@example.com");
    });

    it("blob-store.ts does not reference UserContextStore (the dehydration surface excludes it)", () => {
        const blob = readFileSync(resolve(SDK_SRC, "blob-store.ts"), "utf8");
        expect(blob).not.toMatch(/UserContextStore/);
        expect(blob).not.toMatch(/userContextStore/);
    });

    it("session-store.ts does not reference UserContextStore", () => {
        const ss = readFileSync(resolve(SDK_SRC, "session-store.ts"), "utf8");
        expect(ss).not.toMatch(/UserContextStore/);
        expect(ss).not.toMatch(/userContextStore/);
    });
});
