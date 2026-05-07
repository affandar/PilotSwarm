import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";

export function registerSkillPrompts(server: McpServer, ctx: ServerContext) {
    for (const skill of ctx.skills) {
        server.registerPrompt(
            `skill:${skill.name}`,
            { title: `Skill: ${skill.name}`, description: skill.description },
            async () => ({
                messages: [{
                    role: "user" as const,
                    content: { type: "text" as const, text: skill.prompt },
                }],
            })
        );
    }
}
