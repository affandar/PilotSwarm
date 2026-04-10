export function createNoAuthProvider({ pluginAuthConfig } = {}) {
    const displayName = String(
        pluginAuthConfig?.providers?.none?.displayName
        || pluginAuthConfig?.displayName
        || "No auth",
    ).trim() || "No auth";

    return {
        id: "none",
        enabled: false,
        displayName,
        async authenticateRequest() {
            return null;
        },
        async getPublicConfig() {
            return {
                enabled: false,
                provider: "none",
                displayName,
                client: null,
            };
        },
    };
}
