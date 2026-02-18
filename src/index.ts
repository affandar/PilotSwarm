/**
 * durable-copilot-sdk — Make Copilot SDK apps durable with zero orchestration code.
 *
 * API mirrors @github/copilot-sdk — CopilotClient becomes DurableCopilotClient,
 * CopilotSession becomes DurableSession. Same methods, same patterns, plus durability.
 *
 * @example
 * ```typescript
 * import { DurableCopilotClient, defineTool } from "durable-copilot-sdk";
 *
 * const client = new DurableCopilotClient({
 *     store: "postgres://localhost:5432/agents",
 *     githubToken: process.env.GITHUB_TOKEN,
 * });
 *
 * const session = await client.createSession({
 *     tools: [getWeather],
 *     systemMessage: "You are a helpful assistant.",
 * });
 *
 * const response = await session.sendAndWait("Check the weather in NYC");
 * ```
 */

export { DurableCopilotClient, DurableSession } from "./agent.js";
export { SessionBlobStore } from "./blob-store.js";
export type {
    DurableCopilotClientOptions,
    DurableSessionConfig,
    DurableSessionStatus,
    DurableSessionInfo,
    UserInputRequest,
    UserInputResponse,
    UserInputHandler,
    TurnResult,
} from "./types.js";

// Re-export defineTool from Copilot SDK for convenience
export { defineTool } from "@github/copilot-sdk";
