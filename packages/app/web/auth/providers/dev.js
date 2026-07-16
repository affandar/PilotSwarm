// Development auth provider: authenticates as one of a small roster of
// predefined personas with zero IdP involvement. The "token" is the literal
// string `dev:<persona>` so it rides every existing credential path (Bearer
// header, WebSocket subprotocol, PILOTSWARM_API_TOKEN) unchanged.
//
// This provider exists to exercise the multi-user security model (ownership,
// visibility, sharing) on a laptop — see
// docs/proposals/dev-auth-provider-and-multiuser-test-plan.md. Any holder of
// the string IS that persona, so the guards below are deliberately strict:
// never inferred, explicit second opt-in env, and mutual exclusion with Entra.

const DEV_BANNER = "DEV AUTH — not for production";

const DEFAULT_ROSTER = [
    { id: "ada", displayName: "Ada Admin", role: "admin" },
    { id: "alice", displayName: "Alice Anderson", role: "user" },
    { id: "bob", displayName: "Bob Baker", role: "user" },
    { id: "carol", displayName: "Carol Chen", role: "user" },
    { id: "dave", displayName: "Dave Diaz", role: "user" },
];

function isTruthyEnv(value) {
    return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function titleCase(id) {
    return id.charAt(0).toUpperCase() + id.slice(1);
}

export function parseDevRoster(raw) {
    const trimmed = String(raw || "").trim();
    if (!trimmed) {
        return DEFAULT_ROSTER.map((persona) => ({ ...persona, email: `${persona.id}@dev.local` }));
    }
    const personas = [];
    const seen = new Set();
    for (const entry of trimmed.split(",")) {
        const cleaned = entry.trim();
        if (!cleaned) continue;
        const [rawId, rawRole] = cleaned.split(":").map((part) => String(part || "").trim());
        const id = rawId.toLowerCase();
        const role = String(rawRole || "user").toLowerCase();
        if (!/^[a-z][a-z0-9_-]*$/.test(id)) {
            throw new Error(`[portal-auth:dev] Invalid persona id "${rawId}" in PORTAL_AUTH_DEV_USERS (expected [a-z][a-z0-9_-]*)`);
        }
        if (role !== "admin" && role !== "user") {
            throw new Error(`[portal-auth:dev] Invalid role "${rawRole}" for persona "${id}" in PORTAL_AUTH_DEV_USERS (expected admin|user)`);
        }
        if (seen.has(id)) {
            throw new Error(`[portal-auth:dev] Duplicate persona id "${id}" in PORTAL_AUTH_DEV_USERS`);
        }
        seen.add(id);
        personas.push({
            id,
            displayName: `${titleCase(id)} (dev)`,
            email: `${id}@dev.local`,
            role,
        });
    }
    if (personas.length === 0) {
        throw new Error("[portal-auth:dev] PORTAL_AUTH_DEV_USERS is set but contains no personas");
    }
    return personas;
}

export function createDevAuthProvider({ env = process.env } = {}) {
    const configuredEntraKeys = Object.entries(env)
        .filter(([key, value]) => key.startsWith("PORTAL_AUTH_ENTRA_") && String(value || "").trim())
        .map(([key]) => key);
    if (configuredEntraKeys.length > 0) {
        throw new Error(
            `[portal-auth:dev] Refusing to start: PORTAL_AUTH_ENTRA_* is configured (${configuredEntraKeys.join(", ")}). `
            + "The dev provider performs no real authentication and cannot coexist with a real identity provider.",
        );
    }
    if (!isTruthyEnv(env.PORTAL_AUTH_DEV_ALLOW)) {
        throw new Error(
            "[portal-auth:dev] Refusing to start: the dev auth provider authenticates anyone as any persona. "
            + "Set PORTAL_AUTH_DEV_ALLOW=true to explicitly opt in (local development only).",
        );
    }

    const roster = parseDevRoster(env.PORTAL_AUTH_DEV_USERS);
    const personasById = new Map(roster.map((persona) => [persona.id, persona]));

    return {
        id: "dev",
        enabled: true,
        displayName: "Dev Auth (testing)",
        async authenticateRequest(token) {
            if (typeof token !== "string" || !token.startsWith("dev:")) return null;
            const persona = personasById.get(token.slice(4).trim().toLowerCase());
            if (!persona) return null;
            return {
                provider: "dev",
                subject: persona.id,
                email: persona.email,
                displayName: persona.displayName,
                groups: [],
                // Non-empty roles[] makes the authz engine decide from roles
                // authoritatively — the same decision path Entra app roles use.
                roles: [persona.role],
                tenantId: null,
                rawClaims: { dev: true, persona: persona.id },
            };
        },
        async getPublicConfig() {
            return {
                enabled: true,
                provider: "dev",
                displayName: "Dev Auth (testing)",
                banner: DEV_BANNER,
                client: {
                    users: roster.map(({ id, displayName, email, role }) => ({ id, displayName, email, role })),
                },
            };
        },
    };
}
