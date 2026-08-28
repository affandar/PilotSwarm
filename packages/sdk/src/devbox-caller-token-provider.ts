import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    PublicClientApplication,
    type AccountInfo,
    type AuthenticationResult,
} from "@azure/msal-node";
import type {
    CallerTokenProvider,
    RequiredAudience,
} from "./mcp-auth-discovery.js";
import {
    CallerAuthConfigurationError,
    CallerReauthRequiredError,
    isCallerReauthRequiredError,
} from "./caller-auth-errors.js";

const AZURE_CLI_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";
const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;

interface RefreshableAccessToken {
    token: string;
    expiresOnTimestamp: number;
}

export type SilentCallerTokenAcquirer = (
    required: RequiredAudience,
) => Promise<RefreshableAccessToken | null>;

export interface RefreshingCallerTokenProviderOptions {
    refreshSkewMs?: number;
    now?: () => number;
}

function isAudienceUnavailableError(error: unknown): boolean {
    const candidate = error as {
        errorCode?: unknown;
        subError?: unknown;
        message?: unknown;
    } | null;
    const text = [
        candidate?.errorCode,
        candidate?.subError,
        candidate?.message,
    ].filter((value): value is string => typeof value === "string")
        .join(" ")
        .toLowerCase();
    return /invalid_scope|consent_required|unauthorized_client|aadsts65001/.test(text);
}

/**
 * Cache delegated tokens per audience, refreshing before expiry and collapsing
 * concurrent refreshes for the same scope into one silent acquisition.
 */
export function createRefreshingCallerTokenProvider(
    acquireToken: SilentCallerTokenAcquirer,
    options: RefreshingCallerTokenProviderOptions = {},
): CallerTokenProvider {
    const refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    const now = options.now ?? Date.now;
    const cache = new Map<string, RefreshableAccessToken>();
    const inFlight = new Map<string, Promise<string | null>>();

    return async (required) => {
        const cached = cache.get(required.scope);
        if (
            cached
            && cached.token
            && now() < cached.expiresOnTimestamp - refreshSkewMs
        ) {
            return cached.token;
        }

        const pending = inFlight.get(required.scope);
        if (pending) return pending;

        const refresh = Promise.resolve().then(async () => {
            try {
                const access = await acquireToken(required);
                if (!access) return null;
                if (!access.token || access.expiresOnTimestamp <= now()) {
                    throw new CallerReauthRequiredError(
                        `Silent delegated credential refresh returned no usable token for scope '${required.scope}'.`,
                    );
                }
                cache.set(required.scope, access);
                return access.token;
            } catch (error: unknown) {
                if (isCallerReauthRequiredError(error)) throw error;
                if (error instanceof CallerAuthConfigurationError) throw error;
                throw new CallerReauthRequiredError(
                    `Silent delegated credential refresh failed for scope '${required.scope}'.`,
                    { cause: error },
                );
            }
        });
        inFlight.set(required.scope, refresh);
        void refresh.then(
            () => inFlight.delete(required.scope),
            () => inFlight.delete(required.scope),
        );
        return refresh;
    };
}

export interface AzureCliCacheCallerTokenProviderOptions
    extends RefreshingCallerTokenProviderOptions {
    configDir?: string;
    username?: string;
}

function cachePath(configDir?: string): string {
    const root = configDir
        || process.env.AZURE_CONFIG_DIR
        || path.join(os.homedir(), ".azure");
    return path.join(root, "msal_token_cache.json");
}

function errorCode(error: unknown): string {
    if (!error || typeof error !== "object") return "unknown";
    const candidate = error as {
        errorCode?: unknown;
        code?: unknown;
        name?: unknown;
    };
    for (const value of [candidate.errorCode, candidate.code, candidate.name]) {
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "unknown";
}

function chooseAccount(
    accounts: AccountInfo[],
    usernameHint?: string,
): AccountInfo {
    const hint = (usernameHint || "").trim().toLowerCase();
    if (hint) {
        const match = accounts.find(
            (account) => (account.username || "").trim().toLowerCase() === hint,
        );
        if (!match) {
            throw new CallerAuthConfigurationError(
                `The portable Azure CLI cache has no account matching CALLER_AUTH_DEVBOX_USERNAME='${usernameHint}'.`,
            );
        }
        return match;
    }

    const usernames = new Set(
        accounts
            .map((account) => (account.username || "").trim().toLowerCase())
            .filter(Boolean),
    );
    if (usernames.size > 1) {
        throw new CallerAuthConfigurationError(
            "The portable Azure CLI cache contains multiple users. Set CALLER_AUTH_DEVBOX_USERNAME to select the session owner.",
        );
    }
    if (!accounts[0]) {
        throw new CallerReauthRequiredError(
            "The portable Azure CLI cache contains no signed-in account.",
        );
    }
    return accounts[0];
}

async function acquireFromAzureCliCache(
    required: RequiredAudience,
    options: AzureCliCacheCallerTokenProviderOptions,
): Promise<RefreshableAccessToken | null> {
    const file = cachePath(options.configDir);
    let serialized: string;
    try {
        serialized = await fs.readFile(file, "utf8");
    } catch (error: unknown) {
        throw new CallerReauthRequiredError(
            `The portable Azure CLI token cache is unavailable at '${file}'.`,
            { cause: error },
        );
    }

    try {
        const cache = JSON.parse(serialized) as {
            RefreshToken?: Record<string, unknown>;
        };
        if (Object.keys(cache.RefreshToken ?? {}).length === 0) {
            throw new CallerReauthRequiredError(
                "The Azure CLI cache has no refresh token. On the devbox, run "
                + "`az config set core.enable_broker_on_windows false` and then "
                + "`az login` with the same AZURE_CONFIG_DIR.",
            );
        }
    } catch (error: unknown) {
        if (isCallerReauthRequiredError(error)) throw error;
        throw new CallerReauthRequiredError(
            `The portable Azure CLI token cache at '${file}' is not valid MSAL JSON.`,
            { cause: error },
        );
    }

    try {
        const probe = new PublicClientApplication({
            auth: {
                clientId: AZURE_CLI_CLIENT_ID,
                authority: "https://login.microsoftonline.com/organizations",
            },
        });
        probe.getTokenCache().deserialize(serialized);
        const account = chooseAccount(
            await probe.getTokenCache().getAllAccounts(),
            options.username || process.env.CALLER_AUTH_DEVBOX_USERNAME,
        );
        const tenant = account.tenantId || "organizations";
        const app = new PublicClientApplication({
            auth: {
                clientId: AZURE_CLI_CLIENT_ID,
                authority: `https://login.microsoftonline.com/${tenant}`,
            },
        });
        app.getTokenCache().deserialize(serialized);
        const tenantAccount = (await app.getTokenCache().getAllAccounts())
            .find((candidate) => candidate.homeAccountId === account.homeAccountId)
            ?? account;
        const result: AuthenticationResult | null = await app.acquireTokenSilent({
            account: tenantAccount,
            scopes: [required.scope],
        });
        const expiresOnTimestamp = result?.expiresOn?.getTime() ?? 0;
        if (!result?.accessToken || expiresOnTimestamp <= Date.now()) {
            throw new CallerReauthRequiredError(
                `Silent delegated credential refresh returned no usable token for scope '${required.scope}'.`,
            );
        }
        return { token: result.accessToken, expiresOnTimestamp };
    } catch (error: unknown) {
        if (isCallerReauthRequiredError(error)) throw error;
        if (error instanceof CallerAuthConfigurationError) throw error;
        if (isAudienceUnavailableError(error)) return null;
        throw new CallerReauthRequiredError(
            `Silent delegated credential refresh requires the developer to sign in again (${errorCode(error)}).`,
            { cause: error },
        );
    }
}

/**
 * Mint caller-delegated tokens from a container-mounted, non-broker Azure CLI
 * MSAL cache. This provider is silent-only and never falls back to managed
 * identity, workload identity, device code, or interactive browser auth.
 */
export function createAzureCliCacheCallerTokenProvider(
    options: AzureCliCacheCallerTokenProviderOptions = {},
): CallerTokenProvider {
    return createRefreshingCallerTokenProvider(
        (required) => acquireFromAzureCliCache(required, options),
        options,
    );
}
