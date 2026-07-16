// Browser side of the dev auth provider: the "token" is the literal string
// `dev:<persona>`. The chosen persona lives in sessionStorage, which is
// per-tab — two tabs are two users, the core multi-user testing affordance.

const STORAGE_KEY = "pilotswarm.devAuth.persona";

function toAccount(persona) {
    if (!persona) return null;
    return {
        name: persona.displayName || persona.id,
        username: persona.email || `${persona.id}@dev.local`,
    };
}

function readStoredPersona() {
    try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

export function createDevBrowserAuthProvider() {
    let config = null;

    return {
        async initialize(authConfig) {
            config = authConfig || null;
            const persona = readStoredPersona();
            if (!persona) return { account: null, accessToken: null };
            return { account: toAccount(persona), accessToken: `dev:${persona.id}` };
        },
        async signIn(personaId) {
            const users = config?.client?.users || [];
            const persona = users.find((user) => user.id === personaId) || users[0] || null;
            if (!persona) {
                throw new Error("No dev personas configured");
            }
            try {
                sessionStorage.setItem(STORAGE_KEY, JSON.stringify(persona));
            } catch {
                // Session storage unavailable (rare); the returned token still signs in this render.
            }
            return { account: toAccount(persona), accessToken: `dev:${persona.id}` };
        },
        async signOut() {
            try {
                sessionStorage.removeItem(STORAGE_KEY);
            } catch {
                // ignore
            }
            return { account: null, accessToken: null };
        },
        async getAccessToken() {
            const persona = readStoredPersona();
            return persona ? `dev:${persona.id}` : null;
        },
        getAccount() {
            return toAccount(readStoredPersona());
        },
    };
}
