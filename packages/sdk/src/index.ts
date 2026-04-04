/**
 * pilotswarm — A durable execution runtime for GitHub Copilot SDK agents.
 *
 * @example
 * ```typescript
 * import { PilotSwarmClient, PilotSwarmWorker, defineTool } from "pilotswarm-sdk";
 *
 * const worker = new PilotSwarmWorker({ store, githubToken });
 * worker.registerTools([myTool]);
 * await worker.start();
 *
 * const client = new PilotSwarmClient({ store });
 * await client.start();
 *
 * const session = await client.createSession({ toolNames: ["myTool"] });
 * const response = await session.sendAndWait("Hello!");
 * ```
 */

export { PilotSwarmClient, PilotSwarmSession } from "./client.js";
export type { SessionEventHandler } from "./client.js";
export { PilotSwarmWorker } from "./worker.js";
export { PilotSwarmManagementClient } from "./management-client.js";
export type {
    PilotSwarmSessionView,
    ModelSummary,
    SessionStatusChange,
    SessionOrchestrationStats,
    PilotSwarmManagementClientOptions,
} from "./management-client.js";
export { SessionManager } from "./session-manager.js";
export { ManagedSession } from "./managed-session.js";
export { SessionBlobStore } from "./blob-store.js";
export { FilesystemSessionStore, FilesystemArtifactStore } from "./session-store.js";
export { PgFactStore, createFactStoreForUrl } from "./facts-store.js";
export { PgSessionCatalogProvider } from "./cms.js";
export type { SessionCatalogProvider, SessionRow, SessionRowUpdates, SessionEvent } from "./cms.js";
export type {
    FactStore,
    FactRecord,
    StoreFactInput,
    ReadFactsQuery,
    DeleteFactInput,
} from "./facts-store.js";
export type { SessionStateStore, SessionMetadata, ArtifactStore } from "./session-store.js";
export type {
    PilotSwarmClientOptions,
    PilotSwarmWorkerOptions,
    ManagedSessionConfig,
    PilotSwarmSessionStatus,
    PilotSwarmSessionInfo,
    SessionContextUsage,
    SessionCompactionSnapshot,
    TurnAction,
    TurnResult,
    CapturedEvent,
    UserInputRequest,
    UserInputResponse,
    UserInputHandler,
    CommandMessage,
    CommandResponse,
    OrchestrationInput,
    SubAgentEntry,
    SessionPolicy,
} from "./types.js";

// Skills loader
export { loadSkills } from "./skills.js";
export { loadAgentFiles, systemAgentUUID, systemChildAgentUUID } from "./agent-loader.js";
export { loadMcpConfig } from "./mcp-loader.js";
export type { Skill } from "./skills.js";
// Sweeper Agent tools
export { createSweeperTools } from "./sweeper-tools.js";
// Fact tools
export { createFactTools } from "./facts-tools.js";
// Resource Manager Agent tools
export { createResourceManagerTools } from "./resourcemgr-tools.js";
// Model providers
export { loadModelProviders, ModelProviderRegistry } from "./model-providers.js";
export type { ModelEntry, ModelDescriptor, ModelProviderConfig, ModelProvidersFile, ResolvedProvider } from "./model-providers.js";
export { composeSystemPrompt, extractPromptContent, mergePromptSections } from "./prompt-layering.js";
export type { PromptLayeringKind } from "./prompt-layering.js";

// Debug utilities
export { SessionDumper } from "./session-dumper.js";

// Re-export defineTool from Copilot SDK for convenience
export { defineTool } from "@github/copilot-sdk";
