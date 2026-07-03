import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApiClient } from "pilotswarm-sdk/api";

/**
 * Bearer-token supplier for the MCP server's Web API (`--api-url`) mode.
 *
 * The MCP server is headless (launched by an MCP host), so it cannot run the
 * interactive browser sign-in the TUI uses. Two credential paths, discovered
 * from the deployment's public `GET /api/v1/auth/config`:
 *
 *   - **no-auth deployments** → no token.
 *   - **Entra deployments** →
 *       1. `PILOTSWARM_API_TOKEN` (static bearer — service principal / CI), else
 *       2. the cached user token the TUI writes at
 *          `~/.config/pilotswarm/auth/<origin>.json` — run `pilotswarm auth
 *          login --api-url <url>` once, and the MCP server acquires silently
 *          from that cache (dev convenience).
 */

const AUTH_CACHE_DIR = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "pilotswarm",
    "auth",
);

function cacheFileForOrigin(apiUrl: string): string {
    const origin = new URL(apiUrl).origin.replace(/[^\w.-]+/g, "_");
    return path.join(AUTH_CACHE_DIR, `${origin}.json`);
}

async function silentTokenProviderFromCache(apiUrl: string, client: { clientId: string; authority: string }): Promise<(() => Promise<string | null>) | null> {
    let msal: any;
    try {
        msal = await import("@azure/msal-node");
    } catch {
        return null;
    }
    const cacheFile = cacheFileForOrigin(apiUrl);
    const app = new msal.PublicClientApplication({
        auth: { clientId: client.clientId, authority: client.authority },
        cache: {
            cachePlugin: {
                beforeCacheAccess: async (ctx: any) => {
                    try {
                        ctx.tokenCache.deserialize(await fs.promises.readFile(cacheFile, "utf8"));
                    } catch {}
                },
                afterCacheAccess: async (ctx: any) => {
                    if (!ctx.cacheHasChanged) return;
                    await fs.promises.mkdir(AUTH_CACHE_DIR, { recursive: true, mode: 0o700 });
                    await fs.promises.writeFile(cacheFile, ctx.tokenCache.serialize(), { mode: 0o600 });
                },
            },
        },
    });
    const scopes = [`${client.clientId}/.default`];
    return async () => {
        const accounts = await app.getTokenCache().getAllAccounts();
        const account = accounts[0];
        if (!account) return null;
        try {
            const result = await app.acquireTokenSilent({ account, scopes });
            return result?.accessToken || null;
        } catch {
            return null;
        }
    };
}

/**
 * Resolve a `getAccessToken` callback for a Web API deployment, or null when
 * the deployment needs no auth. Throws with actionable guidance when an Entra
 * deployment has no usable credential.
 */
export async function createApiTokenProvider(apiUrl: string): Promise<(() => Promise<string | null>) | null> {
    const api = new ApiClient({ apiUrl });
    const authConfig: any = await api.getAuthConfig();

    if (!authConfig?.enabled || authConfig?.provider === "none") {
        return null;
    }
    if (authConfig.provider !== "entra") {
        throw new Error(`Unsupported auth provider '${authConfig.provider}' reported by ${apiUrl}.`);
    }

    const staticToken = String(process.env.PILOTSWARM_API_TOKEN || "").trim();
    if (staticToken) {
        return async () => staticToken;
    }

    const client = authConfig.client;
    if (client?.clientId && client?.authority) {
        const provider = await silentTokenProviderFromCache(apiUrl, client);
        if (provider) {
            // Verify the cache actually yields a token; fail fast otherwise.
            const token = await provider();
            if (token) return provider;
        }
    }

    throw new Error(
        `${apiUrl} requires Entra auth but no credential is available. Set PILOTSWARM_API_TOKEN `
        + `(service principal / CI), or run: pilotswarm auth login --api-url ${apiUrl}`,
    );
}
