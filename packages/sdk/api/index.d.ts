/** Typed surface for pilotswarm-sdk/api (implementation is plain ESM JS). */

export declare const API_PREFIX: string;
export declare const API_VERSION: number;
export declare const WS_PATH: string;
export declare const WS_CLIENT_MESSAGES: string[];
export declare const WS_SERVER_MESSAGES: string[];
export declare const WEB_MODE_UNSUPPORTED: string;

export interface OperationParamSpec {
    in: "path" | "query" | "body";
    name?: string;
    type?: "string" | "number" | "boolean" | "json";
}

export interface Operation {
    name: string;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    params?: Record<string, OperationParamSpec>;
    summary: string;
}

export declare const OPERATIONS: Operation[];
export declare function getOperation(name: string): Operation | null;
export declare function buildOperationRequest(name: string, params?: Record<string, unknown>): {
    method: string;
    path: string;
    query: URLSearchParams;
    body: Record<string, unknown> | null;
};
export declare function coerceQueryValue(value: unknown, type?: string): unknown;
export declare function artifactDownloadPath(sessionId: string, filename: string): string;

export declare class ApiError extends Error {
    code: string;
    status: number;
    constructor(message: string, opts?: { code?: string; status?: number });
}

export interface ApiClientOptions {
    apiUrl: string;
    getAccessToken?: () => Promise<string | null>;
    onUnauthorized?: () => void;
    onForbidden?: (message: string) => void;
    fetchImpl?: typeof fetch;
    WebSocketImpl?: unknown;
}

export declare class ApiClient {
    constructor(options: ApiClientOptions);
    apiUrl: string;
    call(name: string, params?: Record<string, unknown>): Promise<any>;
    request(method: string, pathWithQuery: string, opts?: { body?: unknown; headers?: Record<string, string> }): Promise<any>;
    health(): Promise<any>;
    getAuthConfig(): Promise<any>;
    getAuthContext(): Promise<any>;
    getBootstrap(): Promise<any>;
    downloadArtifactResponse(sessionId: string, filename: string): Promise<Response>;
    start(): Promise<void>;
    stop(): Promise<void>;
    subscribeSession(sessionId: string, handler: (event: unknown) => void, onResubscribe?: () => void): () => void;
    subscribeLogs(handler: (entry: unknown) => void): () => void;
}

export interface HttpApiTransportHost {
    saveArtifactDownload?: (transport: HttpApiTransport, sessionId: string, filename: string) => Promise<unknown>;
    uploadArtifactFromPath?: (transport: HttpApiTransport, sessionId: string, filePath: string) => Promise<unknown>;
    openPathInDefaultApp?: (targetPath: string) => Promise<unknown>;
    openUrlInDefaultBrowser?: (targetUrl: string) => Promise<unknown>;
    artifactExportDirectory?: string;
}

export interface HttpApiTransportOptions extends ApiClientOptions {
    api?: ApiClient;
    host?: HttpApiTransportHost;
}

export declare class HttpApiTransport {
    constructor(options: HttpApiTransportOptions);
    api: ApiClient;
    bootstrap: any;
    start(): Promise<void>;
    stop(): Promise<void>;
    [method: string]: any;
}
