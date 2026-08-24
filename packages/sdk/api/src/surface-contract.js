/**
 * Operations intentionally owned outside PilotSwarmManagementClient.
 *
 * Every protocol operation not listed here must have the same-named ergonomic
 * method on both direct and Web management clients. Adding an exception
 * requires naming its owning public abstraction and why management is not it.
 */
export const NON_MANAGEMENT_OPERATION_OWNERS = Object.freeze({
    createSession: { owner: "PilotSwarmClient", file: "packages/sdk/src/client.ts", className: "PilotSwarmClient", method: "createSession", reason: "session creation handle" },
    createSessionForAgent: { owner: "PilotSwarmClient", file: "packages/sdk/src/client.ts", className: "PilotSwarmClient", method: "createSessionForAgent", reason: "agent-bound session creation handle" },
    sendSessionEvent: { owner: "PilotSwarmSession", file: "packages/sdk/src/client.ts", className: "PilotSwarmSession", method: "sendEvent", reason: "session event write" },

    listArtifacts: { owner: "HttpApiTransport", file: "packages/sdk/api/src/http-api-transport.js", className: "HttpApiTransport", method: "listArtifacts", reason: "session artifact data plane" },
    getArtifactMetadata: { owner: "HttpApiTransport", file: "packages/sdk/api/src/http-api-transport.js", className: "HttpApiTransport", method: "getArtifactMetadata", reason: "session artifact data plane" },
    downloadArtifact: { owner: "HttpApiTransport", file: "packages/sdk/api/src/http-api-transport.js", className: "HttpApiTransport", method: "downloadArtifact", reason: "session artifact data plane" },
    uploadArtifact: { owner: "HttpApiTransport", file: "packages/sdk/api/src/http-api-transport.js", className: "HttpApiTransport", method: "uploadArtifactContent", reason: "session artifact data plane" },
    deleteArtifact: { owner: "HttpApiTransport", file: "packages/sdk/api/src/http-api-transport.js", className: "HttpApiTransport", method: "deleteArtifact", reason: "session artifact data plane" },
    readArtifactBase64: { owner: "HttpApiTransport", file: "packages/sdk/api/src/http-api-transport.js", className: "HttpApiTransport", method: "readArtifactBase64", reason: "binary artifact data plane" },
    copyArtifact: { owner: "HttpApiTransport", file: "packages/sdk/api/src/http-api-transport.js", className: "HttpApiTransport", method: "copyArtifact", reason: "cross-session artifact data plane" },
    setArtifactPinned: { owner: "HttpApiTransport", file: "packages/sdk/api/src/http-api-transport.js", className: "HttpApiTransport", method: "setArtifactPinned", reason: "artifact retention data plane" },
    exportExecutionHistory: { owner: "HttpApiTransport", file: "packages/sdk/api/src/http-api-transport.js", className: "HttpApiTransport", method: "exportExecutionHistory", reason: "creates a downloadable artifact" },

    startFactsEmbedder: { owner: "WebEnhancedFactStore", file: "packages/sdk/src/web/web-fact-store.ts", className: "WebEnhancedFactStore", method: "startEmbedder", reason: "fact-store lifecycle" },
    stopFactsEmbedder: { owner: "WebEnhancedFactStore", file: "packages/sdk/src/web/web-fact-store.ts", className: "WebEnhancedFactStore", method: "stopEmbedder", reason: "fact-store lifecycle" },
    listCreatableAgents: { owner: "NodeSdkTransport", file: "packages/app/tui/src/node-sdk-transport.js", className: "NodeSdkTransport", method: "listCreatableAgents", reason: "merged deployment and package catalog" },
    getSessionCreationPolicy: { owner: "NodeSdkTransport", file: "packages/app/tui/src/node-sdk-transport.js", className: "NodeSdkTransport", method: "getSessionCreationPolicy", reason: "session creation policy" },

    getCurrentUserProfile: { owner: "WebPilotSwarmManagementClient", file: "packages/sdk/src/web/web-management-client.ts", className: "WebPilotSwarmManagementClient", method: "getUserProfile", reason: "request principal is server-derived" },
    setCurrentUserProfileSettings: { owner: "WebPilotSwarmManagementClient", file: "packages/sdk/src/web/web-management-client.ts", className: "WebPilotSwarmManagementClient", method: "setUserProfileSettings", reason: "request principal is server-derived" },
    setCurrentUserGitHubCopilotKey: { owner: "WebPilotSwarmManagementClient", file: "packages/sdk/src/web/web-management-client.ts", className: "WebPilotSwarmManagementClient", method: "setUserGitHubCopilotKey", reason: "request principal is server-derived" },
    getLogConfig: { owner: "NodeSdkTransport", file: "packages/app/tui/src/node-sdk-transport.js", className: "NodeSdkTransport", method: "getLogConfig", reason: "deployment log integration" },
    getWorkerCount: { owner: "NodeSdkTransport", file: "packages/app/tui/src/node-sdk-transport.js", className: "NodeSdkTransport", method: "getWorkerCount", reason: "embedded host process count" },
});

export const WEB_MODE_UNSUPPORTED_OPERATION_METHODS = Object.freeze({
    factsCapabilities: {
        alternative: "WebEnhancedFactStore.capabilities / ManagementOps.factsCapabilities()",
        reason: "the direct method is synchronous while the Web capability probe is asynchronous",
    },
});

export function operationRequiresManagementMethod(operationName) {
    return !Object.prototype.hasOwnProperty.call(NON_MANAGEMENT_OPERATION_OWNERS, operationName);
}
