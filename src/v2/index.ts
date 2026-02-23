/**
 * durable-copilot-sdk v2 — SessionProxy architecture.
 */

export { DurableCopilotClient, DurableSession } from "./client.js";
export { DurableCopilotWorker } from "./worker.js";
export { SessionManager } from "./session-manager.js";
export { ManagedSession } from "./managed-session.js";
export { SessionBlobStore } from "../blob-store.js";
export { PgSessionCatalogProvider } from "./cms.js";
export type { SessionCatalogProvider, SessionRow, SessionRowUpdates } from "./cms.js";
export type {
    DurableCopilotClientOptions,
    DurableCopilotWorkerOptions,
    ManagedSessionConfig,
    DurableSessionStatus,
    DurableSessionInfo,
    TurnResult,
    UserInputRequest,
    UserInputResponse,
    UserInputHandler,
    CommandMessage,
    CommandResponse,
    OrchestrationInput,
} from "./types.js";

// Re-export defineTool from Copilot SDK for convenience
export { defineTool } from "@github/copilot-sdk";
