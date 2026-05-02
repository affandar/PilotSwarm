// User profile + per-user GitHub Copilot key tests.
//
// These exercise the CMS migration 0010 surface end-to-end: profile
// settings round-trip, the public profile read masks the key, the
// internal key read returns the raw text, and clearing reverts to NULL.
// Together with the management/transport tests in management.test.js
// this covers the full "Admin Console saves a user a key" pipeline at
// the schema layer.

import { beforeAll, describe, it } from "vitest";
import { PgSessionCatalogProvider, PilotSwarmManagementClient } from "../../src/index.ts";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";

const TIMEOUT = 60_000;
const getEnv = useSuiteEnv(import.meta.url);

function uniqueSubject(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("user profile + github copilot key", () => {
    beforeAll(async () => {
        // Touch the env so schemas are created before the first it() runs.
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();
        await catalog.close();
    });

    it("returns null for unknown principals without writing a row", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();
        try {
            const principal = { provider: "test", subject: uniqueSubject("missing") };
            const profile = await catalog.getUserProfile(principal);
            assertEqual(profile, null, "missing user should resolve to null");
            const key = await catalog.getUserGitHubCopilotKey(principal);
            assertEqual(key, null, "missing user should have no key");
        } finally {
            await catalog.close();
        }
    });

    it("creates the user lazily on first profile-settings write", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();
        try {
            const principal = {
                provider: "test",
                subject: uniqueSubject("first-write"),
                email: "person@example.com",
                displayName: "Person",
            };
            const settings = { theme: "midnight", layout: { paneAdjust: 4 } };
            const written = await catalog.setUserProfileSettings(principal, settings);
            assertEqual(written.provider, "test");
            assertEqual(written.subject, principal.subject);
            assertEqual(written.email, "person@example.com");
            assertEqual(written.displayName, "Person");
            assertEqual(written.githubCopilotKeySet, false, "no key set yet");
            assertEqual(written.profileSettings?.theme, "midnight", "settings round-trip");
            assertEqual(written.profileSettings?.layout?.paneAdjust, 4, "nested settings round-trip");

            const reread = await catalog.getUserProfile(principal);
            assert(reread != null, "profile should be readable after write");
            assertEqual(reread.profileSettings?.theme, "midnight");
        } finally {
            await catalog.close();
        }
    });

    it("public profile read never exposes the raw github copilot key", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();
        try {
            const principal = {
                provider: "test",
                subject: uniqueSubject("masked-key"),
                email: null,
                displayName: null,
            };
            const rawKey = "ghp_test_secret_value_should_never_leak";
            await catalog.setUserGitHubCopilotKey(principal, rawKey);

            const profile = await catalog.getUserProfile(principal);
            assert(profile != null, "profile should exist");
            assertEqual(profile.githubCopilotKeySet, true, "flag should reflect that a key is configured");

            // Belt-and-braces: the public UserProfile interface only carries
            // the boolean flag. Verify no field of the returned object
            // contains the raw secret.
            const serialized = JSON.stringify(profile);
            assert(!serialized.includes(rawKey), "raw key must not appear in the public profile object");

            // Internal accessor returns the raw value (worker resolver uses this).
            const internal = await catalog.getUserGitHubCopilotKey(principal);
            assertEqual(internal, rawKey, "internal accessor returns raw key");
        } finally {
            await catalog.close();
        }
    });

    it("clears the github copilot key when set to null or whitespace", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();
        try {
            const principal = { provider: "test", subject: uniqueSubject("clear-key") };
            await catalog.setUserGitHubCopilotKey(principal, "ghp_initial");
            assertEqual(await catalog.getUserGitHubCopilotKey(principal), "ghp_initial");

            // null clears
            const cleared = await catalog.setUserGitHubCopilotKey(principal, null);
            assertEqual(cleared.githubCopilotKeySet, false);
            assertEqual(await catalog.getUserGitHubCopilotKey(principal), null);

            // whitespace also clears (the proc trims and treats empty as NULL)
            await catalog.setUserGitHubCopilotKey(principal, "ghp_back_again");
            const trimmedCleared = await catalog.setUserGitHubCopilotKey(principal, "   \n\t  ");
            assertEqual(trimmedCleared.githubCopilotKeySet, false, "whitespace key clears the override");
            assertEqual(await catalog.getUserGitHubCopilotKey(principal), null);
        } finally {
            await catalog.close();
        }
    });

    it("setting a key does not clobber unrelated profile settings", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();
        try {
            const principal = { provider: "test", subject: uniqueSubject("preserve-settings") };
            await catalog.setUserProfileSettings(principal, { theme: "ocean" });
            await catalog.setUserGitHubCopilotKey(principal, "ghp_x");
            const profile = await catalog.getUserProfile(principal);
            assertEqual(profile?.profileSettings?.theme, "ocean", "settings survive a key write");
            assertEqual(profile?.githubCopilotKeySet, true);
        } finally {
            await catalog.close();
        }
    });

    it("rejects writes without a usable provider/subject", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
        await catalog.initialize();
        try {
            let threw = false;
            try {
                await catalog.setUserProfileSettings({ provider: "", subject: "" }, {});
            } catch {
                threw = true;
            }
            assert(threw, "empty principal should throw on setUserProfileSettings");

            threw = false;
            try {
                await catalog.setUserGitHubCopilotKey({ provider: "test", subject: "" }, "key");
            } catch {
                threw = true;
            }
            assert(threw, "empty subject should throw on setUserGitHubCopilotKey");
        } finally {
            await catalog.close();
        }
    });

    it("management client routes profile + key calls through to the CMS", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const mgmt = new PilotSwarmManagementClient({
            store: env.store,
            duroxideSchema: env.duroxideSchema,
            cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema,
        });
        await mgmt.start();
        try {
            const principal = {
                provider: "test",
                subject: uniqueSubject("mgmt"),
                email: "mgmt@example.com",
                displayName: "Mgmt User",
            };

            // Initially missing → null.
            assertEqual(await mgmt.getUserProfile(principal), null);

            // Save settings.
            const written = await mgmt.setUserProfileSettings(principal, { theme: "hacker-x" });
            assertEqual(written.profileSettings?.theme, "hacker-x");
            assertEqual(written.githubCopilotKeySet, false);

            // Save and clear key through the management client.
            const withKey = await mgmt.setUserGitHubCopilotKey(principal, "ghp_via_mgmt");
            assertEqual(withKey.githubCopilotKeySet, true);
            const cleared = await mgmt.setUserGitHubCopilotKey(principal, null);
            assertEqual(cleared.githubCopilotKeySet, false);

            // Settings should still be there after the key churn.
            const reread = await mgmt.getUserProfile(principal);
            assertEqual(reread?.profileSettings?.theme, "hacker-x");
        } finally {
            await mgmt.stop().catch(() => {});
        }
    });
});
