import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApiClient } from "pilotswarm-sdk/api";
import { openUrlInDefaultBrowser } from "../http-transport-host.js";

/**
 * Entra ID sign-in for the TUI's API mode.
 *
 * Default flow: OAuth 2.0 authorization code + PKCE via msal-node's
 * `acquireTokenInteractive`. It opens the system browser to a normal Entra
 * sign-in and captures the code on a loopback (`http://localhost:<port>`)
 * redirect — the same interactive flow `az login`, the GitHub CLI, and the
 * browser portal use. Crucially, it satisfies Conditional Access policies
 * that block the device-code flow (common in hardened corporate tenants;
 * Microsoft's own tenant returns AADSTS53003 for device code).
 *
 * Fallback flow: device code (`useDeviceCode`) for headless hosts with no
 * browser — only usable where the tenant permits it.
 *
 * The TUI never carries tenant/client ids in local config — they are
 * discovered from the deployment's public `GET /api/v1/auth/config`, so
 * app-registration rotation never breaks clients. Tokens are cached per API
 * origin at `~/.config/pilotswarm/auth/<origin>.json` (0600). MSAL owns
 * refresh; `getAccessToken` runs acquireTokenSilent per call.
 */

const AUTH_CACHE_DIR = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "pilotswarm",
    "auth",
);

const BROWSER_RESULT_HTML = (heading, body) => `<!doctype html><html><head><meta charset="utf-8">`
    + `<title>PilotSwarm</title><style>body{font-family:-apple-system,Segoe UI,sans-serif;`
    + `background:#0d1117;color:#e5edf5;display:flex;align-items:center;justify-content:center;`
    + `height:100vh;margin:0}.card{text-align:center;max-width:28rem;padding:2rem}`
    + `h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#8b949e}</style></head>`
    + `<body><div class="card"><h1>${heading}</h1><p>${body}</p></div></body></html>`;

const SUCCESS_TEMPLATE = BROWSER_RESULT_HTML("Signed in to PilotSwarm", "You can close this tab and return to the terminal.");
const ERROR_TEMPLATE = BROWSER_RESULT_HTML("Sign-in failed", "Return to the terminal for details.");

function cacheFileForOrigin(apiUrl) {
    const origin = new URL(apiUrl).origin.replace(/[^\w.-]+/g, "_");
    return path.join(AUTH_CACHE_DIR, `${origin}.json`);
}

function createCachePlugin(cacheFile) {
    return {
        beforeCacheAccess: async (cacheContext) => {
            try {
                cacheContext.tokenCache.deserialize(await fs.promises.readFile(cacheFile, "utf8"));
            } catch {}
        },
        afterCacheAccess: async (cacheContext) => {
            if (!cacheContext.cacheHasChanged) return;
            await fs.promises.mkdir(AUTH_CACHE_DIR, { recursive: true, mode: 0o700 });
            await fs.promises.writeFile(cacheFile, cacheContext.tokenCache.serialize(), { mode: 0o600 });
        },
    };
}

export async function fetchAuthConfig(apiUrl) {
    const api = new ApiClient({ apiUrl });
    return api.getAuthConfig();
}

function requireEntraClientConfig(authConfig, apiUrl) {
    const client = authConfig?.client;
    if (!client?.clientId || !client?.authority) {
        throw new Error(
            `The deployment at ${apiUrl} reports Entra auth but no public client configuration. `
            + "Check PORTAL_AUTH_ENTRA_TENANT_ID / PORTAL_AUTH_ENTRA_CLIENT_ID on the server.",
        );
    }
    return client;
}

async function createPublicClientApp(authConfig, apiUrl) {
    const client = requireEntraClientConfig(authConfig, apiUrl);
    const { PublicClientApplication } = await import("@azure/msal-node");
    const app = new PublicClientApplication({
        auth: {
            clientId: client.clientId,
            authority: client.authority,
        },
        cache: {
            cachePlugin: createCachePlugin(cacheFileForOrigin(apiUrl)),
        },
    });
    return { app, scopes: [`${client.clientId}/.default`] };
}

async function firstCachedAccount(app) {
    const accounts = await app.getTokenCache().getAllAccounts();
    return accounts[0] || null;
}

// MSAL's loopback listener never times out on its own; bound the wait so a
// browser that never opens (headless/SSH, or a failed launch) surfaces an
// actionable error instead of hanging TUI startup forever. Generous enough
// for interactive MFA.
const INTERACTIVE_TIMEOUT_MS = 5 * 60 * 1000;

async function acquireInteractive(app, scopes, apiUrl, output) {
    output("");
    output(`  Opening your browser to sign in to ${apiUrl} …`);
    output("");
    const request = {
        scopes,
        successTemplate: SUCCESS_TEMPLATE,
        errorTemplate: ERROR_TEMPLATE,
        openBrowser: async (url) => {
            // Print the URL too so the user can copy it if the browser does
            // not open on its own (SSH, restricted shells).
            output(`  If your browser does not open, visit:\n    ${url}`);
            output("");
            try {
                await openUrlInDefaultBrowser(url);
            } catch {
                output("  (Could not launch a browser automatically — paste the URL above, or");
                output("   press Ctrl-C and re-run with --device-code on a headless host.)");
                output("");
            }
        },
    };

    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(
                "Browser sign-in timed out. If your browser did not open, paste the printed URL "
                + "into a browser on this machine, or re-run with --device-code.",
            ));
        }, INTERACTIVE_TIMEOUT_MS);
        timer.unref?.();
    });

    let result;
    try {
        result = await Promise.race([app.acquireTokenInteractive(request), timeout]);
    } finally {
        clearTimeout(timer);
    }
    if (!result?.accessToken) {
        throw new Error("Entra sign-in did not produce an access token.");
    }
    return result;
}

async function acquireDeviceCode(app, scopes, apiUrl, output) {
    const result = await app.acquireTokenByDeviceCode({
        scopes,
        deviceCodeCallback: (deviceCode) => {
            output("");
            output(`  Sign in to ${apiUrl}`);
            output(`  Visit ${deviceCode.verificationUri} and enter code ${deviceCode.userCode}`);
            output("");
            openUrlInDefaultBrowser(deviceCode.verificationUri).catch(() => {});
        },
    });
    if (!result?.accessToken) {
        throw new Error("Entra sign-in did not produce an access token.");
    }
    return result;
}

/**
 * Interactive sign-in: silent first, then the browser (auth-code+PKCE) flow —
 * or the device-code flow when `useDeviceCode` is set.
 */
export async function signIn(apiUrl, authConfig, { output = console.error, useDeviceCode = false } = {}) {
    const { app, scopes } = await createPublicClientApp(authConfig, apiUrl);

    const account = await firstCachedAccount(app);
    if (account) {
        try {
            const silent = await app.acquireTokenSilent({ account, scopes });
            if (silent?.accessToken) return silent;
        } catch {}
    }

    return useDeviceCode
        ? acquireDeviceCode(app, scopes, apiUrl, output)
        : acquireInteractive(app, scopes, apiUrl, output);
}

/**
 * Build the `getAccessToken` callback for an Entra deployment. Runs the
 * silent flow per call (MSAL caches in memory); if silent acquisition fails
 * the caller sees null and the server's 401 tells the user to run
 * `pilotswarm auth login`.
 */
export async function createTokenProvider(apiUrl, authConfig) {
    const { app, scopes } = await createPublicClientApp(authConfig, apiUrl);
    return async () => {
        const account = await firstCachedAccount(app);
        if (!account) return null;
        try {
            const result = await app.acquireTokenSilent({ account, scopes });
            return result?.accessToken || null;
        } catch {
            return null;
        }
    };
}

export async function getSignedInAccount(apiUrl, authConfig) {
    const { app } = await createPublicClientApp(authConfig, apiUrl);
    return firstCachedAccount(app);
}

export async function signOut(apiUrl) {
    const cacheFile = cacheFileForOrigin(apiUrl);
    await fs.promises.rm(cacheFile, { force: true });
    return cacheFile;
}
