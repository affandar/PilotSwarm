export {
    API_PREFIX,
    API_VERSION,
    WS_PATH,
    WS_CLIENT_MESSAGES,
    WS_SERVER_MESSAGES,
    WEB_MODE_UNSUPPORTED,
    OPERATIONS,
    getOperation,
    buildOperationRequest,
    coerceQueryValue,
    artifactDownloadPath,
    ApiError,
} from "./src/protocol.js";
export {
    SESSION_VISIBILITY_VALUES,
    normalizeVisibility,
    systemSessionsReadable,
    relationFor,
    evaluateSessionAccess,
    evaluateArchiveAccess,
} from "./src/session-authz.js";
export { ApiClient } from "./src/api-client.js";
export { ADMIN_SCOPE_POLICY_VERSION, ADMIN_SCOPES, loadAdminScope, validateAdminScope, adminCanAccessResource, adminCapabilities } from "./src/admin-scope.js";
export * from "./src/admin-diagnostics.js";
export { createCanvasLiveMirror, jsonMergePatch } from "./src/canvas-live-mirror.js";
export { HttpApiTransport } from "./src/http-api-transport.js";
export {
    NON_MANAGEMENT_OPERATION_OWNERS,
    WEB_MODE_UNSUPPORTED_OPERATION_METHODS,
    operationRequiresManagementMethod,
} from "./src/surface-contract.js";
