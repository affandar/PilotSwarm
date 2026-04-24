import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
    const server = new McpServer({
        name: "pilotswarm",
        version: "0.1.0",
    });

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

    // Resource subscriptions (best-effort push notifications)
    enableResourceSubscriptions(server, ctx);

    return server;
}
