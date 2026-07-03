import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";

export function registerFactsResources(server: McpServer, ctx: ServerContext) {
    // Generic facts query resource (existing)
    server.registerResource(
        "facts-query",
        "pilotswarm://facts",
        {
            title: "Facts Query",
            description: "Query the PilotSwarm facts/knowledge store",
            mimeType: "application/json",
        },
        async (uri) => {
            const params = uri.searchParams;
            const query: Record<string, unknown> = {};

            const pattern = params.get("pattern");
            if (pattern) query.keyPattern = pattern;

            const tags = params.get("tags");
            if (tags) query.tags = tags.split(",");

            const limit = params.get("limit");
            if (limit) query.limit = parseInt(limit, 10);

            const result = await ctx.facts.readFacts(query);
            return {
                contents: [
                    {
                        uri: uri.href,
                        text: JSON.stringify(result, null, 2),
                        mimeType: "application/json",
                    },
                ],
            };
        },
    );

    // Skills — all promoted skills
    server.registerResource(
        "facts-skills",
        "pilotswarm://facts/skills",
        {
            description: "All promoted skills from the PilotSwarm knowledge pipeline",
            mimeType: "application/json",
        },
        async (uri) => {
            const result = await ctx.facts.readFacts({ keyPattern: "skills/%" });
            return {
                contents: [{
                    uri: uri.href,
                    text: JSON.stringify(result, null, 2),
                    mimeType: "application/json",
                }],
            };
        },
    );

    // Single skill by key
    server.registerResource(
        "facts-skill-detail",
        new ResourceTemplate("pilotswarm://facts/skills/{key}", {
            list: undefined,
        }),
        {
            description: "A single promoted skill by key",
            mimeType: "application/json",
        },
        async (uri, variables) => {
            const key = `skills/${String(variables.key)}`;
            const result = await ctx.facts.readFacts({ keyPattern: key, limit: 1 });
            return {
                contents: [{
                    uri: uri.href,
                    text: JSON.stringify(result, null, 2),
                    mimeType: "application/json",
                }],
            };
        },
    );

    // Asks — open asks
    server.registerResource(
        "facts-asks",
        "pilotswarm://facts/asks",
        {
            description: "Open asks — topics the Facts Manager is seeking corroboration on",
            mimeType: "application/json",
        },
        async (uri) => {
            const result = await ctx.facts.readFacts({ keyPattern: "asks/%" });
            return {
                contents: [{
                    uri: uri.href,
                    text: JSON.stringify(result, null, 2),
                    mimeType: "application/json",
                }],
            };
        },
    );

    // Single ask by key
    server.registerResource(
        "facts-ask-detail",
        new ResourceTemplate("pilotswarm://facts/asks/{key}", {
            list: undefined,
        }),
        {
            description: "A single open ask by key",
            mimeType: "application/json",
        },
        async (uri, variables) => {
            const key = `asks/${String(variables.key)}`;
            const result = await ctx.facts.readFacts({ keyPattern: key, limit: 1 });
            return {
                contents: [{
                    uri: uri.href,
                    text: JSON.stringify(result, null, 2),
                    mimeType: "application/json",
                }],
            };
        },
    );

    // Intake — recent raw observations
    server.registerResource(
        "facts-intake",
        "pilotswarm://facts/intake",
        {
            description: "Recent intake observations — raw agent-contributed evidence awaiting curation",
            mimeType: "application/json",
        },
        async (uri) => {
            const result = await ctx.facts.readFacts({ keyPattern: "intake/%", limit: 50 });
            return {
                contents: [{
                    uri: uri.href,
                    text: JSON.stringify(result, null, 2),
                    mimeType: "application/json",
                }],
            };
        },
    );

    // Filtered intake by key pattern
    server.registerResource(
        "facts-intake-filtered",
        new ResourceTemplate("pilotswarm://facts/intake/{keyPattern}", {
            list: undefined,
        }),
        {
            description: "Intake observations filtered by key pattern",
            mimeType: "application/json",
        },
        async (uri, variables) => {
            const pattern = `intake/${String(variables.keyPattern)}`;
            const result = await ctx.facts.readFacts({ keyPattern: pattern, limit: 50 });
            return {
                contents: [{
                    uri: uri.href,
                    text: JSON.stringify(result, null, 2),
                    mimeType: "application/json",
                }],
            };
        },
    );
}
