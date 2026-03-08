/**
 * pilotswarm — A durable execution runtime for GitHub Copilot SDK agents.
 *
 * @example
 * ```typescript
 * import { PilotSwarmClient, PilotSwarmWorker, defineTool } from "pilotswarm";
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
    PilotSwarmManagementClientOptions,
} from "./management-client.js";
export { SessionManager } from "./session-manager.js";
export { ManagedSession } from "./managed-session.js";
export { SessionBlobStore } from "./blob-store.js";
export { PgSessionCatalogProvider } from "./cms.js";
export type { SessionCatalogProvider, SessionRow, SessionRowUpdates, SessionEvent } from "./cms.js";
export type {
    PilotSwarmClientOptions,
    PilotSwarmWorkerOptions,
    ManagedSessionConfig,
    PilotSwarmSessionStatus,
    PilotSwarmSessionInfo,
    TurnResult,
    CapturedEvent,
    UserInputRequest,
    UserInputResponse,
    UserInputHandler,
    CommandMessage,
    CommandResponse,
    OrchestrationInput,
    SubAgentEntry,
} from "./types.js";

// Skills loader
export { loadSkills } from "./skills.js";
export { loadAgentFiles, systemAgentUUID } from "./agent-loader.js";
export { loadMcpConfig } from "./mcp-loader.js";
export type { Skill } from "./skills.js";
// Sweeper Agent tools
export { createSweeperTools } from "./sweeper-tools.js";
// Model providers
export { loadModelProviders, ModelProviderRegistry } from "./model-providers.js";
export type { ModelEntry, ModelDescriptor, ModelProviderConfig, ModelProvidersFile, ResolvedProvider } from "./model-providers.js";

// Debug utilities
export { SessionDumper } from "./session-dumper.js";

// Re-export defineTool from Copilot SDK for convenience
export { defineTool } from "@github/copilot-sdk";
