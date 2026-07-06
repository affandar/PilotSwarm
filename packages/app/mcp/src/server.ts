import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListPromptsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ServerContext } from "./context.js";
import { registerSessionTools } from "./tools/sessions.js";
import { registerAgentTools } from "./tools/agents.js";
import { registerFactsTools } from "./tools/facts.js";
import { registerModelTools } from "./tools/models.js";
import { registerCapabilityTools } from "./tools/capabilities.js";
import { registerEnhancedFactTools } from "./tools/facts-enhanced.js";
import { registerGraphTools } from "./tools/graph.js";
import { registerTurnControlTools } from "./tools/turn-control.js";
import { registerArtifactTools } from "./tools/artifacts.js";
import { registerGroupTools } from "./tools/groups.js";
import { registerObservabilityTools } from "./tools/observability.js";
import { registerDebugTools } from "./tools/debug.js";
import { registerSystemTools } from "./tools/system.js";
import { registerSessionResources } from "./resources/sessions.js";
import { registerAgentResources } from "./resources/agents.js";
import { registerFactsResources } from "./resources/facts.js";
import { registerModelsResources } from "./resources/models.js";
import { registerCapabilityResources } from "./resources/capabilities.js";
import { registerGraphResources } from "./resources/graph.js";
import { registerArtifactResources } from "./resources/artifacts.js";
import { registerSkillPrompts } from "./prompts/skills.js";
import { enableResourceSubscriptions } from "./resources/subscriptions.js";

export function createMcpServer(ctx: ServerContext): McpServer {
    const server = new McpServer(
        {
            name: "pilotswarm",
            version: "0.2.0",
        },
        {
            capabilities: {
                tools: { listChanged: true },
                resources: { subscribe: true, listChanged: true },
                prompts: { listChanged: true },
            },
            // Model-facing usage guidance, handed to the client at initialize.
            instructions: [
                "PilotSwarm fleet control plane: manage sessions (agent runs), sub-agent trees, session groups,",
                "artifacts, the shared facts/graph knowledge store, and fleet metrics.",
                "",
                "Start with get_capabilities: it reports mode (web/direct), whether this credential has the admin",
                "role, and enhanced-facts/graph availability. Tools for absent capabilities are not registered.",
                "Then interrogate the AGENT CATALOG — list_registered_agents (or get_system_status include:",
                "['agents']) — to learn what kinds of work this deployment can actually do: each registered agent",
                "definition (name, description, parent constraint) is a capability you can run by creating a",
                "session bound to it (create_session {agent: <name>, prompt: ...}).",
                "Sessions queue durably and run asynchronously: after create_session or send_message, monitor the",
                "session itself — get_session_detail (include: ['status']) for a snapshot, get_session_events",
                "(wait: true) to long-poll for progress. For deep diagnosis of a misbehaving session, use",
                "debug_session (the agent-tuner's read-only evidence bundle: events, metrics, retrieval/graph",
                "usage, orchestration stats, execution history).",
                "",
                "Boundary: this is an EXTERNAL operator surface. It creates/messages/cancels TOP-LEVEL sessions",
                "only; sub-agents are spawned by their parent session's own reasoning loop. Inspect them freely",
                "(list_agents, get_agent_tree, get_session_detail on any session id) but do not expect spawn tools.",
                "",
                "Sessions run asynchronously: send_message returns immediately — follow with get_session_events",
                "(wait=true long-polls) or use send_and_wait for a single blocking turn. Sessions awaiting input",
                "show status input_required; answer with send_answer. stop_turn aborts one turn; abort_session",
                "cancels the whole session; complete_session marks success.",
                "",
                "Destructive tools (delete_session, delete_fact, facts_admin, delete_graph_namespace,",
                "manage_session_group cancel/delete) act immediately — verify targets before calling.",
                "",
                "Reference: https://github.com/affandar/PilotSwarm — docs/user-guide/ (usage guide),",
                "docs/api/reference.md (the Web API this server fronts), packages/app/mcp/README.md (this",
                "server's tool catalog, security model, and client setup).",
            ].join("\n"),
        },
    );

    // Tools — unconditional surface
    registerSessionTools(server, ctx);
    registerAgentTools(server, ctx);
    registerFactsTools(server, ctx);
    registerModelTools(server, ctx);
    registerCapabilityTools(server, ctx);
    registerTurnControlTools(server, ctx);
    registerGroupTools(server, ctx);
    registerObservabilityTools(server, ctx);
    registerDebugTools(server, ctx);
    registerSystemTools(server, ctx);

    // Tools — capability-gated (each register function no-ops when its
    // provider/mode/role gate fails, so absence ⇒ absent from tools/list).
    registerEnhancedFactTools(server, ctx); // iff ctx.enhancedFacts
    registerGraphTools(server, ctx);        // iff ctx.graph ([admin] subset iff ctx.admin)
    registerArtifactTools(server, ctx);     // iff web mode (ctx.api)

    // Resources
    registerSessionResources(server, ctx);
    registerAgentResources(server, ctx);
    registerFactsResources(server, ctx);
    registerModelsResources(server, ctx);
    registerCapabilityResources(server, ctx);
    registerGraphResources(server, ctx);    // iff ctx.graph
    registerArtifactResources(server, ctx); // iff web mode

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
