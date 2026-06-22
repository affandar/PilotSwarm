import { defineTool } from "@github/copilot-sdk";

export function registerTools(worker) {
    const fakeTool = defineTool("fixture_fake_tool_a", {
        description: "Fixture tool registered by plugin-with-tools.",
        parameters: { type: "object", properties: {} },
        handler: async () => "ok",
    });
    worker.registerTools([fakeTool]);
}
