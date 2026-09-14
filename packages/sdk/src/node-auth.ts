import {
    DefaultAzureCredential,
    type AccessToken,
    type TokenCredential,
} from "@azure/identity";
import { ApiClient } from "pilotswarm-sdk/api";

export type NodeWebAuthMode = "none" | "configured-token" | "dev" | "identity";
export type CredentialOwnership = "none" | "caller" | "bootstrap";

export interface PublicWebAuthConfig {
    enabled: boolean;
    provider: string;
    client?: {
        clientId?: string;
    } | null;
}

export type NodeAuthErrorCode =
    | "AUTH_CONFIG_FETCH_FAILED"
    | "INVALID_AUTH_CONFIG"
    | "UNSUPPORTED_PROVIDER"
    | "MISSING_DEV_USER"
    | "MISSING_CLIENT_ID"
    | "TOKEN_ACQUISITION_FAILED"
    | "CLOSED";

export class NodeWebAuthError extends Error {
    constructor(
        public readonly code: NodeAuthErrorCode,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = "NodeWebAuthError";
    }
}

type ClosableTokenCredential = TokenCredential & {
    close?: () => void | Promise<void>;
};

export interface NodeWebAuthOptions {
    /** PilotSwarm Web API base URL. */
    apiUrl: string;
    /** Reuse an ApiClient; primarily useful for dependency injection and tests. */
    api?: Pick<ApiClient, "getAuthConfig">;
    /**
     * Static bearer owned by the caller. When this property is present it wins
     * over PILOTSWARM_API_TOKEN; null or blank explicitly disables that env var.
     */
    token?: string | null;
    /**
     * Dev-auth persona. When present it wins over PILOTSWARM_DEV_USER; null or
     * blank explicitly disables that env var.
     */
    devUser?: string | null;
    /**
     * Caller-owned credential for an identity-provider deployment. The
     * bootstrap caches its access tokens but never closes this credential.
     */
    credential?: TokenCredential;
    /**
     * Creates a bootstrap-owned credential. Defaults to DefaultAzureCredential.
     * A close() method, when present, is called by the returned close().
     */
    createCredential?: () => ClosableTokenCredential;
    /** Environment source; defaults to process.env. */
    env?: NodeJS.ProcessEnv;
    /** Refresh before expiry by this margin. Defaults to two minutes. */
    refreshSkewMs?: number;
    /** Injectable clock for hermetic cache tests. */
    now?: () => number;
}

export interface NodeWebAuthBootstrap {
    authConfig: PublicWebAuthConfig;
    mode: NodeWebAuthMode;
    credentialOwnership: CredentialOwnership;
    getAccessToken: () => Promise<string | null>;
    close: () => Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

function configuredValue(
    options: NodeWebAuthOptions,
    option: "token" | "devUser",
    envName: string,
): string | null {
    if (Object.prototype.hasOwnProperty.call(options, option)) {
        return nonEmptyString(options[option]);
    }
    return nonEmptyString((options.env ?? process.env)[envName]);
}

function parseAuthConfig(value: unknown): PublicWebAuthConfig {
    const config = asRecord(value);
    const provider = nonEmptyString(config?.provider);
    if (!config || typeof config.enabled !== "boolean" || !provider) {
        throw new NodeWebAuthError(
            "INVALID_AUTH_CONFIG",
            "The Web API returned an invalid public authentication configuration.",
        );
    }
    const client = config.client === null || config.client === undefined
        ? null
        : asRecord(config.client);
    if (config.client !== null && config.client !== undefined && !client) {
        throw new NodeWebAuthError(
            "INVALID_AUTH_CONFIG",
            "The Web API returned an invalid authentication client configuration.",
        );
    }
    return {
        enabled: config.enabled,
        provider,
        client: client ? { clientId: nonEmptyString(client.clientId) ?? undefined } : null,
    };
}

function staticBootstrap(
    authConfig: PublicWebAuthConfig,
    mode: Exclude<NodeWebAuthMode, "identity">,
    token: string | null,
): NodeWebAuthBootstrap {
    let current = token;
    let closed = false;
    return {
        authConfig,
        mode,
        credentialOwnership: "none",
        async getAccessToken() {
            if (closed) {
                throw new NodeWebAuthError("CLOSED", "The Web authentication bootstrap is closed.");
            }
            return current;
        },
        async close() {
            closed = true;
            current = null;
        },
    };
}

function identityBootstrap(
    authConfig: PublicWebAuthConfig,
    credential: ClosableTokenCredential,
    credentialOwnership: Exclude<CredentialOwnership, "none">,
    scope: string,
    refreshSkewMs: number,
    now: () => number,
): NodeWebAuthBootstrap {
    let cached: AccessToken | null = null;
    let inFlight: Promise<AccessToken> | null = null;
    let closeInFlight: Promise<void> | null = null;
    let closed = false;

    const acquire = async (): Promise<AccessToken> => {
        try {
            const token = await credential.getToken(scope);
            if (!token?.token || !Number.isFinite(token.expiresOnTimestamp)) {
                throw new Error("The credential returned no usable access token.");
            }
            return token;
        } catch (cause) {
            throw new NodeWebAuthError(
                "TOKEN_ACQUISITION_FAILED",
                `Failed to acquire a Web API access token for the configured identity provider.`,
                { cause },
            );
        }
    };

    return {
        authConfig,
        mode: "identity",
        credentialOwnership,
        async getAccessToken() {
            if (closed || closeInFlight) {
                throw new NodeWebAuthError("CLOSED", "The Web authentication bootstrap is closed.");
            }
            if (cached && cached.expiresOnTimestamp - refreshSkewMs > now()) {
                return cached.token;
            }
            if (!inFlight) {
                inFlight = acquire().then((token) => {
                    if (closed || closeInFlight) {
                        throw new NodeWebAuthError("CLOSED", "The Web authentication bootstrap is closed.");
                    }
                    cached = token;
                    return token;
                }).finally(() => {
                    inFlight = null;
                });
            }
            return (await inFlight).token;
        },
        async close() {
            if (closed) return;
            if (closeInFlight) return closeInFlight;
            cached = null;
            if (credentialOwnership !== "bootstrap") {
                closed = true;
                return;
            }
            const attempt = Promise.resolve().then(() => credential.close?.());
            closeInFlight = attempt;
            try {
                await attempt;
                closed = true;
            } finally {
                if (closeInFlight === attempt) {
                    closeInFlight = null;
                }
            }
        },
    };
}

/**
 * Create the Node-only token callback accepted by PilotSwarm Web API clients.
 *
 * Provider selection comes from the deployment's public auth configuration.
 * For an authenticated deployment, precedence is:
 *   1. options.token (including null to suppress environment fallback)
 *   2. PILOTSWARM_API_TOKEN
 *   3. provider-specific configuration (dev persona or TokenCredential)
 *
 * Identity tokens are cached until refreshSkewMs before expiry, and concurrent
 * refreshes share one credential call. Acquisition failures reject explicitly;
 * they are never converted into anonymous access.
 */
export async function createNodeWebAuth(
    options: NodeWebAuthOptions,
): Promise<NodeWebAuthBootstrap> {
    const apiUrl = nonEmptyString(options?.apiUrl);
    if (!apiUrl) throw new TypeError("createNodeWebAuth requires apiUrl.");
    const refreshSkewMs = options.refreshSkewMs ?? 120_000;
    if (!Number.isFinite(refreshSkewMs) || refreshSkewMs < 0) {
        throw new TypeError("refreshSkewMs must be a non-negative finite number.");
    }

    const api = options.api ?? new ApiClient({ apiUrl });
    let rawAuthConfig: unknown;
    try {
        rawAuthConfig = await api.getAuthConfig();
    } catch (cause) {
        throw new NodeWebAuthError(
            "AUTH_CONFIG_FETCH_FAILED",
            `Failed to fetch the public Web API authentication configuration from ${apiUrl}.`,
            { cause },
        );
    }
    const authConfig = parseAuthConfig(rawAuthConfig);
    if (!authConfig.enabled || authConfig.provider === "none") {
        return staticBootstrap(authConfig, "none", null);
    }

    const configuredToken = configuredValue(options, "token", "PILOTSWARM_API_TOKEN");
    if (configuredToken) {
        return staticBootstrap(authConfig, "configured-token", configuredToken);
    }

    if (authConfig.provider === "dev") {
        const persona = configuredValue(options, "devUser", "PILOTSWARM_DEV_USER");
        if (!persona) {
            throw new NodeWebAuthError(
                "MISSING_DEV_USER",
                "The deployment uses dev authentication; configure devUser or PILOTSWARM_DEV_USER.",
            );
        }
        return staticBootstrap(authConfig, "dev", `dev:${persona.toLowerCase()}`);
    }

    if (authConfig.provider !== "entra") {
        throw new NodeWebAuthError(
            "UNSUPPORTED_PROVIDER",
            `Unsupported Web API authentication provider '${authConfig.provider}'.`,
        );
    }

    const clientId = nonEmptyString(authConfig.client?.clientId);
    if (!clientId) {
        throw new NodeWebAuthError(
            "MISSING_CLIENT_ID",
            "The deployment selected identity authentication without a public client ID.",
        );
    }

    const callerCredential = options.credential as ClosableTokenCredential | undefined;
    const credential = callerCredential
        ?? options.createCredential?.()
        ?? new DefaultAzureCredential();
    return identityBootstrap(
        authConfig,
        credential,
        callerCredential ? "caller" : "bootstrap",
        `${clientId}/.default`,
        refreshSkewMs,
        options.now ?? Date.now,
    );
}
