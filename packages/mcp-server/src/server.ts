import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListPromptsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ServerContext } from "./context.js";
import { registerSessionTools } from "./tools/sessions.js";
import { registerAgentTools } from "./tools/agents.js";
import { registerFactsTools } from "./tools/facts.js";
import { registerModelTools } from "./tools/models.js";
import { registerSessionResources } from "./resources/sessions.js";
import { registerAgentResources } from "./resources/agents.js";
import { registerFactsResources } from "./resources/facts.js";
import { registerModelsResources } from "./resources/models.js";
import { registerSkillPrompts } from "./prompts/skills.js";
import { enableResourceSubscriptions } from "./resources/subscriptions.js";

export function createMcpServer(ctx: ServerContext): McpServer {
    const server = new McpServer(
        {
            name: "pilotswarm",
            version: "0.1.0",
        },
        {
            capabilities: {
                tools: { listChanged: true },
                resources: { subscribe: true, listChanged: true },
                prompts: { listChanged: true },
            },
        },
    );

    // Tools
    registerSessionTools(server, ctx);
    registerAgentTools(server, ctx);
    registerFactsTools(server, ctx);
    registerModelTools(server, ctx);

    // Resources
    registerSessionResources(server, ctx);
    registerAgentResources(server, ctx);
    registerFactsResources(server, ctx);
    registerModelsResources(server, ctx);

    // Prompts
    registerSkillPrompts(server, ctx);

    // We advertise the `prompts` capability unconditionally (see constructor
    // above), so honor `prompts/list` even when zero prompts are registered.
    // The high-level McpServer only installs its own ListPrompts handler the
    // first time `.prompt()` runs; without that, advertising the capability
    // but 404'ing the method violates the contract. Install a low-level
    // fallback that returns an empty list. If `.prompt()` later runs, the
    // SDK's `assertCanSetRequestHandler` would conflict — but that's only
    // invoked from `setPromptRequestHandlers()`, which is gated by the
    // `_promptHandlersInitialized` flag the SDK manages itself; since we're
    // claiming the handler first, register a low-level handler and let the
    // SDK skip its own setup. To keep both paths working, we only install
    // the fallback when no prompts were registered above.
    const lowLevel: any = (server as any).server;
    const sdkPromptsInitialized = (server as any)._promptHandlersInitialized === true;
    if (lowLevel?.setRequestHandler && !sdkPromptsInitialized) {
        lowLevel.setRequestHandler(ListPromptsRequestSchema, async () => ({
            prompts: [],
        }));
    }

    // Resource subscriptions (best-effort push notifications)
    enableResourceSubscriptions(server, ctx);

    return server;
}
