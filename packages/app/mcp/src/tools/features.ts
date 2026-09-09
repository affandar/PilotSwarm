import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FEATURE_OPERATION_SPECS, featureToolParameters } from "pilotswarm-sdk";
import type { ServerContext } from "../context.js";
import { jsonResult, withToolErrors } from "../util/respond.js";

export function registerFeatureTools(server: McpServer, ctx: ServerContext) {
    // Web mode ignores this value and derives identity from authentication.
    // Direct mode requires an explicitly configured identity/admin grant for
    // feature policy; holding a catalog handle alone does not opt it in.
    const provider = process.env.PILOTSWARM_MCP_ACTOR_PROVIDER;
    const subject = process.env.PILOTSWARM_MCP_ACTOR_SUBJECT;
    const viewer = {
        principal: provider && subject ? { provider, subject } : null,
        isAdmin: !ctx.webMode && ctx.admin && process.env.PILOTSWARM_MCP_FEATURE_ADMIN === "true",
    };
    for (const spec of FEATURE_OPERATION_SPECS) {
        const schema = featureToolParameters(spec);
        const inputSchema: Record<string, z.ZodTypeAny> = {};
        for (const [key, property] of Object.entries(schema.properties)) {
            let field: z.ZodTypeAny = property.type === "boolean" ? z.boolean()
                : property.type === "integer" ? z.number().int().min(property.minimum ?? 0).max(property.maximum ?? Number.MAX_SAFE_INTEGER)
                    : z.string().min(property.minLength ?? 0).max(property.maxLength ?? 1024);
            if (property.description) field = field.describe(property.description);
            inputSchema[key] = schema.required.includes(key) ? field : field.optional();
        }
        server.registerTool(spec.name, { title: spec.name.replaceAll("_", " "), description: spec.description, inputSchema },
            withToolErrors(async (args: Record<string, any>) => {
                const method = ctx.mgmt[spec.method].bind(ctx.mgmt) as (...values: any[]) => Promise<any>;
                const values = spec.kind === "audit" ? [args.limit]
                    : spec.kind === "users" ? [args.query]
                    : spec.kind === "read" ? ("targetUser" in spec ? [args.userId] : [])
                        : "targetUser" in spec ? [args.userId, args] : [args];
                return jsonResult(await method(viewer, ...values));
            }));
    }
}
