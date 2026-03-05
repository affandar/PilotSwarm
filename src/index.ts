/**
 * durable-copilot-runtime — A durable execution runtime for GitHub Copilot SDK agents.
 *
 * @example
 * ```typescript
 * import { DurableCopilotClient, DurableCopilotWorker, defineTool } from "durable-copilot-runtime";
 *
 * const worker = new DurableCopilotWorker({ store, githubToken });
 * worker.registerTools([myTool]);
 * await worker.start();
 *
 * const client = new DurableCopilotClient({ store });
 * await client.start();
 *
 * const session = await client.createSession({ toolNames: ["myTool"] });
 * const response = await session.sendAndWait("Hello!");
 * ```
 */

export { DurableCopilotClient, DurableSession } from "./client.js";
export type { SessionEventHandler } from "./client.js";
export { DurableCopilotWorker } from "./worker.js";
export { SessionManager } from "./session-manager.js";
export { ManagedSession } from "./managed-session.js";
export { SessionBlobStore } from "./blob-store.js";
export { PgSessionCatalogProvider } from "./cms.js";
export type { SessionCatalogProvider, SessionRow, SessionRowUpdates, SessionEvent } from "./cms.js";
export type {
    DurableCopilotClientOptions,
    DurableCopilotWorkerOptions,
    ManagedSessionConfig,
    DurableSessionStatus,
    DurableSessionInfo,
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
export { loadAgentFiles } from "./agent-loader.js";
export { loadMcpConfig } from "./mcp-loader.js";
export type { Skill } from "./skills.js";

// Model providers
export { loadModelProviders, ModelProviderRegistry } from "./model-providers.js";
export type { ModelEntry, ModelDescriptor, ModelProviderConfig, ModelProvidersFile, ResolvedProvider } from "./model-providers.js";

// Re-export defineTool from Copilot SDK for convenience
export { defineTool } from "@github/copilot-sdk";
