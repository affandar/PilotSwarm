import { defineTool } from "@github/copilot-sdk";

export function registerTools(worker) {
    const t = defineTool("fixture_claimed_tool", {
        description: "Fixture tool whose name is claimed by this plugin's default.agent.md overlay.",
        parameters: { type: "object", properties: {} },
        handler: async () => "ok",
    });
    worker.registerTools([t]);
}
