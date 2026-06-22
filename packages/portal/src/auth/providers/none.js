export function createNoBrowserAuthProvider() {
    return {
        async initialize() {
            return { account: null, accessToken: null };
        },
        async signIn() {
            return { account: null, accessToken: null };
        },
        async signOut() {
            return { account: null, accessToken: null };
        },
        async getAccessToken() {
            return null;
        },
        // User OBO: the "none" provider has no IdP and no downstream
        // scope, so always returns null. Worker-side OBO is disabled.
        async getDownstreamToken() {
            return null;
        },
        getAccount() {
            return null;
        },
    };
}

