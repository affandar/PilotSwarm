export function createNoAuthProvider() {
    return {
        id: "none",
        enabled: false,
        displayName: "No auth",
        async authenticateRequest() {
            return null;
        },
        async getPublicConfig() {
            return {
                enabled: false,
                provider: "none",
                displayName: "No auth",
                client: null,
            };
        },
    };
}
