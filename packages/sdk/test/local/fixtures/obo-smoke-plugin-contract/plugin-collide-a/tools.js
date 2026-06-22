import { defineTool } from "@github/copilot-sdk";

export function registerTools(worker) {
    worker.registerTools([
        defineTool("fixture_collision_tool", {
            description: "Tool registered by plugin-collide-a.",
            parameters: { type: "object", properties: {} },
            handler: async () => "a",
        }),
    ]);
}
