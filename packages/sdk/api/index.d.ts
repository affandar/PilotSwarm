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
    candidates?: string[];
    constructor(message: string, opts?: { code?: string; status?: number; candidates?: string[] });
}

export interface NonManagementOperationOwner {
    owner: string;
    file: string;
    className: string;
    method: string;
    reason: string;
}
export declare const NON_MANAGEMENT_OPERATION_OWNERS: Readonly<Record<string, NonManagementOperationOwner>>;
export declare const WEB_MODE_UNSUPPORTED_OPERATION_METHODS: Readonly<Record<string, {
    alternative: string;
    reason: string;
}>>;
export declare function operationRequiresManagementMethod(operationName: string): boolean;

export interface ApiClientOptions {
    apiUrl: string;
    getAccessToken?: () => Promise<string | null>;
    onUnauthorized?: () => void;
    onForbidden?: (message: string) => void;
    fetchImpl?: typeof fetch;
    WebSocketImpl?: unknown;
}

/** Generic ephemeral topic delivery; never a durable replay event. */
export type LiveUpdate = {
    sessionId: string;
    topic: string;
    updatedAt?: string;
} & ({ kind: "snapshot" | "patch"; seq: number; data: Record<string, unknown> }
    | { kind: "signal"; seq?: number | null }
    | { kind: "unavailable" });

export interface LiveStateRow {
    topic: string;
    seq: number;
    payload: Record<string, unknown>;
    updatedBy: string;
    updatedAt: string;
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
    downloadAgentPackageResponse(name: string, options?: {
        semver?: string;
        scope?: string;
        ownerProvider?: string;
        ownerSubject?: string;
    }): Promise<Response>;
    start(): Promise<void>;
    stop(): Promise<void>;
    subscribeSession(sessionId: string, handler: (event: unknown) => void, onResubscribe?: () => void): () => void;
    subscribeLive(sessionId: string, topic: string, handler: (update: LiveUpdate) => void): () => void;
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

export { AdminScope, ADMIN_SCOPE_POLICY_VERSION, ADMIN_SCOPES, loadAdminScope, validateAdminScope, adminCanAccessResource, adminCapabilities } from "./src/admin-scope.js";
export * from "./src/admin-diagnostics.js";

export declare class HttpApiTransport {
    constructor(options: HttpApiTransportOptions);
    api: ApiClient;
    bootstrap: any;
    start(): Promise<void>;
    stop(): Promise<void>;
    getLive(sessionId: string, topics?: string[]): Promise<LiveStateRow[]>;
    [method: string]: any;
}

// ── Session-tree access predicate (src/session-authz.js) ──────────
// Pure; shared by the portal runtime and the worker's agent tools so the
// "may this principal touch this session?" answer has ONE implementation.

export interface SessionAccessSnapshot {
    rootSessionId: string;
    isSystem: boolean;
    visibility: "private" | "shared_read" | "shared_write";
    owner: { displayName?: string | null; email?: string | null; subject?: string | null } | null;
    viewerIsOwner: boolean;
    viewerShareAccess: "read" | "write" | null;
}

export interface SessionAccessDecision {
    allowed: boolean;
    /** Report NOT_FOUND rather than FORBIDDEN: an admitted caller must not be able to probe which session ids exist. */
    notFound?: boolean;
    reason?: string;
    /** An admin reached something a plain user in the same position could not see. Audit it. */
    breakGlass?: boolean;
}

export type SessionAccessClass =
    | "session:read" | "session:write" | "session:manage" | "session:destroy" | "session:share";

export declare const SESSION_VISIBILITY_VALUES: readonly string[];
export declare function normalizeVisibility(value: unknown, fallback: string): string;
export declare function systemSessionsReadable(env?: Record<string, string | undefined>): boolean;
export declare function relationFor(snapshot: SessionAccessSnapshot | null, opts?: { isAdmin?: boolean; adminScope?: import("./src/admin-scope.js").AdminScope }): "owner" | "admin" | "collaborator";
export declare function evaluateSessionAccess(
    accessClass: SessionAccessClass,
    snapshot: SessionAccessSnapshot | null,
    opts?: { isAdmin?: boolean; systemReadable?: boolean; adminScope?: import("./src/admin-scope.js").AdminScope },
): SessionAccessDecision;
/** Archive reads are owner-or-admin ONLY — never a share. See proposal §15 A3. */
export declare function evaluateArchiveAccess(
    snapshot: SessionAccessSnapshot | null,
    opts?: { isAdmin?: boolean; adminScope?: import("./src/admin-scope.js").AdminScope },
): SessionAccessDecision;
