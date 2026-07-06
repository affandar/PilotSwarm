import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";

/** Artifact listing resource — web mode only (see tools/artifacts.ts). */
export function registerArtifactResources(server: McpServer, ctx: ServerContext) {
    const api = ctx.api;
    if (!api) return;

    server.registerResource(
        "session-artifacts",
        new ResourceTemplate("pilotswarm://sessions/{id}/artifacts", {
            list: async () => {
                const sessions = await ctx.mgmt.listSessions();
                return {
                    resources: sessions.map((s: any) => ({
                        uri: `pilotswarm://sessions/${s.sessionId}/artifacts`,
                        name: `Artifacts: ${s.title ?? s.sessionId}`,
                        description: `Artifacts for session ${s.sessionId}`,
                        mimeType: "application/json",
                    })),
                };
            },
        }),
        {
            description: "Artifacts (files) produced by or given to a session",
            mimeType: "application/json",
        },
        async (uri, variables) => {
            const id = String(variables.id);
            try {
                const artifacts = await api.call("listArtifacts", { sessionId: id });
                const list = Array.isArray(artifacts) ? artifacts : (artifacts?.artifacts ?? []);
                return {
                    contents: [{ uri: uri.href, text: JSON.stringify(list, null, 2), mimeType: "application/json" }],
                };
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    contents: [{ uri: uri.href, text: JSON.stringify({ error: message }), mimeType: "application/json" }],
                };
            }
        },
    );
}
