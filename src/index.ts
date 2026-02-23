/**
 * durable-copilot-sdk — Make Copilot SDK apps durable with zero orchestration code.
 *
 * @example
 * ```typescript
 * import { DurableCopilotClient, DurableCopilotWorker, defineTool } from "durable-copilot-sdk";
 *
 * const worker = new DurableCopilotWorker({ store, githubToken });
 * await worker.start();
 *
 * const client = new DurableCopilotClient({
 *     store,
 *     provider: worker.provider,
 *     catalog: worker.catalog,
 * });
 * await client.start();
 *
 * const session = await client.createSession();
 * const response = await session.sendAndWait("Hello!");
 * ```
 */

export * from "./v2/index.js";
