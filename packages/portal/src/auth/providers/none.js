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
        getAccount() {
            return null;
        },
    };
}

