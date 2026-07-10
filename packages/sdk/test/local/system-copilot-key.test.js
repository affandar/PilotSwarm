/**
 * System GitHub Copilot key — the first-class "system" user.
 *
 * Ownerless system sessions cannot use per-user Copilot keys (no owner),
 * so on env-token-less deployments every GHCP model hard-fails for them.
 * An admin can now store a key ON the system user (Admin Console →
 * "Store as System key"); the worker resolves it through the exact same
 * per-user path (`getUserGitHubCopilotKey`) whenever a session has
 * `isSystem` and no owner.
 *
 * Pure unit — fake catalog, no DB, no Copilot.
 */
import { describe, it } from "vitest";
import { PilotSwarmManagementClient } from "../../src/management-client.js";
import { SessionManager } from "../../src/session-manager.js";
import { SYSTEM_USER_PRINCIPAL } from "../../src/cms.js";
import { assert, assertEqual } from "../helpers/assertions.js";

// ── Management surface: set / clear / status ───────────────────────────

function createKeyHarness() {
    const users = new Map(); // "provider/subject" -> { key, settings }
    const userKey = (p) => `${p.provider}/${p.subject}`;
    const catalog = {
        async setUserGitHubCopilotKey(principal, key) {
            const id = userKey(principal);
            const row = users.get(id) || { key: null, settings: {} };
            row.key = typeof key === "string" && key.trim().length > 0 ? key : null;
            users.set(id, row);
            return { provider: principal.provider, subject: principal.subject, githubCopilotKeySet: row.key != null };
        },
        async setUserProfileSettings(principal, settings) {
            const id = userKey(principal);
            const row = users.get(id) || { key: null, settings: {} };
            row.settings = settings || {};
            users.set(id, row);
            return { provider: principal.provider, subject: principal.subject };
        },
        async getUserProfile(principal) {
            const row = users.get(userKey(principal));
            if (!row) return null;
            return {
                provider: principal.provider,
                subject: principal.subject,
                githubCopilotKeySet: row.key != null,
                profileSettings: row.settings,
            };
        },
        async getUserGitHubCopilotKey(principal) {
            return users.get(userKey(principal))?.key ?? null;
        },
    };

    const mgmt = new PilotSwarmManagementClient({ store: "postgres://unused" });
    mgmt._started = true;
    mgmt._catalog = catalog;
    return { mgmt, catalog, users };
}

describe("system GitHub Copilot key management", () => {
    it("stores the key under the SYSTEM principal and records the acting admin for audit", async () => {
        const { mgmt, users } = createKeyHarness();

        const status = await mgmt.setSystemGitHubCopilotKey(
            { provider: "entra", subject: "oid-1", email: "admin@example.com", displayName: "Admin" },
            "ghu_system_key_123",
        );

        const stored = users.get("system/system");
        assert(stored, "key must be written to the system/system user row");
        assertEqual(stored.key, "ghu_system_key_123", "raw key stored on the system user");
        assertEqual(status.configured, true, "status reports configured");
        assertEqual(status.changedBy, "admin@example.com", "audit records the acting admin");
        assert(typeof status.changedAt === "string" && status.changedAt.length > 0, "audit records when");
    });

    it("clears the key and keeps the audit trail pointing at whoever cleared it", async () => {
        const { mgmt } = createKeyHarness();
        await mgmt.setSystemGitHubCopilotKey({ provider: "entra", subject: "a", email: "a@x.com" }, "ghu_k");

        const status = await mgmt.setSystemGitHubCopilotKey({ provider: "entra", subject: "b", email: "b@x.com" }, null);

        assertEqual(status.configured, false, "cleared key reports unconfigured");
        assertEqual(status.changedBy, "b@x.com", "audit points at the clearing admin");
    });

    it("reports unconfigured when the system user has never been created", async () => {
        const { mgmt } = createKeyHarness();
        const status = await mgmt.getSystemGitHubCopilotKeyStatus();
        assertEqual(status.configured, false, "no system user row → not configured");
        assertEqual(status.changedBy, null, "no audit trail yet");
    });

    it("falls back to 'anonymous' as the audit actor on no-auth deployments", async () => {
        const { mgmt } = createKeyHarness();
        const status = await mgmt.setSystemGitHubCopilotKey(null, "ghu_k");
        assertEqual(status.changedBy, "anonymous", "null actor recorded as anonymous");
    });
});

// ── Worker resolution: which principal's key a session runs on ─────────

function resolveWith({ row, keys, providerType = "github" }) {
    const stub = {
        sessionCatalog: {
            async getSession() { return row; },
            async getUserGitHubCopilotKey(principal) {
                return keys[`${principal.provider}/${principal.subject}`] ?? null;
            },
        },
        workerDefaults: {
            modelProviders: { resolve: () => ({ type: providerType }) },
        },
    };
    return SessionManager.prototype._resolveSessionGitHubToken.call(
        stub, row.sessionId, {}, "github-copilot:claude-sonnet-5", row,
    );
}

describe("system session token resolution", () => {
    const KEYS = {
        "entra/user-1": "USER_KEY",
        [`${SYSTEM_USER_PRINCIPAL.provider}/${SYSTEM_USER_PRINCIPAL.subject}`]: "SYSTEM_KEY",
    };

    it("owned sessions still resolve the owner's key (system key never shadows it)", async () => {
        const token = await resolveWith({
            row: { sessionId: "s1", isSystem: false, owner: { provider: "entra", subject: "user-1" } },
            keys: KEYS,
        });
        assertEqual(token, "USER_KEY", "owner key wins for owned sessions");
    });

    it("ownerless system sessions resolve the SYSTEM user's key", async () => {
        const token = await resolveWith({
            row: { sessionId: "s2", isSystem: true, owner: null },
            keys: KEYS,
        });
        assertEqual(token, "SYSTEM_KEY", "system sessions act as the system principal");
    });

    it("System-OWNED non-system sessions resolve the SYSTEM key via the ordinary owner path", async () => {
        // The shape sub-agents of system sessions get since the effective-owner
        // inheritance fix: owner = the System user, is_system = false. They
        // must reach the admin-stored System key exactly like any owned
        // session reaches its owner's key — while staying deletable (no
        // is_system flag).
        const token = await resolveWith({
            row: {
                sessionId: "s6",
                isSystem: false,
                owner: { provider: SYSTEM_USER_PRINCIPAL.provider, subject: SYSTEM_USER_PRINCIPAL.subject },
            },
            keys: KEYS,
        });
        assertEqual(token, "SYSTEM_KEY", "System-owned child resolves the System key without is_system");
    });

    it("ownerless NON-system sessions get no per-user key (worker default applies)", async () => {
        const token = await resolveWith({
            row: { sessionId: "s3", isSystem: false, owner: null },
            keys: KEYS,
        });
        assertEqual(token, undefined, "ownerless non-system sessions do not borrow the system key");
    });

    it("system sessions with no stored system key fall through to the worker default", async () => {
        const token = await resolveWith({
            row: { sessionId: "s4", isSystem: true, owner: null },
            keys: { "entra/user-1": "USER_KEY" },
        });
        assertEqual(token, undefined, "no system key stored → undefined (worker default / loud gate)");
    });

    it("non-github models never resolve per-user keys at all", async () => {
        const token = await resolveWith({
            row: { sessionId: "s5", isSystem: true, owner: null },
            keys: KEYS,
            providerType: "openai",
        });
        assertEqual(token, undefined, "azure/openai models use provider keys, not per-user tokens");
    });
});
