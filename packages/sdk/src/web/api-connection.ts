import { ApiClient, WEB_MODE_UNSUPPORTED } from "pilotswarm-sdk/api";

/**
 * Options for the supported (web) SDK mode: the client talks to a PilotSwarm
 * deployment's Web API and needs no database or storage credentials.
 */
export interface PilotSwarmWebOptions {
    /** Base URL of the PilotSwarm Web API host (the portal server). */
    apiUrl: string;
    /** Bearer-token supplier for authenticated deployments; omit for no-auth. */
    getAccessToken?: () => Promise<string | null>;
    /** Invoked on HTTP 401 / WS 4401. */
    onUnauthorized?: () => void;
    /** Invoked on HTTP 403 / WS 4403 with the server's reason. */
    onForbidden?: (message: string) => void;
}

export function isWebOptions(options: unknown): options is PilotSwarmWebOptions {
    return Boolean(options && typeof options === "object" && typeof (options as any).apiUrl === "string" && (options as any).apiUrl.trim());
}

export function assertUnambiguousProvider(options: any, className: string): void {
    if (options?.apiUrl && options?.store) {
        throw new Error(
            `${className} options are ambiguous: pass either apiUrl (web mode, supported) or store (direct mode, internal), not both.`,
        );
    }
}

export function createApiClientFromOptions(options: PilotSwarmWebOptions): ApiClient {
    return new ApiClient({
        apiUrl: options.apiUrl,
        getAccessToken: options.getAccessToken,
        onUnauthorized: options.onUnauthorized,
        onForbidden: options.onForbidden,
    });
}

export function webModeUnsupported(method: string, hint?: string): Error {
    const error = new Error(
        `${method} is not available over the Web API${hint ? ` — ${hint}` : ""}.`,
    );
    (error as any).code = WEB_MODE_UNSUPPORTED;
    return error;
}
