import { z } from "zod";

/**
 * Session capability override input shape (capability-profiles Phases 3/4).
 *
 * Mirrors the SDK's `SessionCapabilityOverride` wire shape verbatim (same
 * precedent as the list_sessions cursor: nested payloads keep the wire's
 * camelCase keys): three axes — mcpServers, skills, tools — each an
 * enable/disable delta over the bound agent's profile. Strict objects so a
 * typo'd axis or key is rejected instead of silently dropped.
 *
 * Names must come from the deployment capability catalog
 * (get_capabilities → capability_catalog). Tools entries may be individual
 * tool names OR tool-GROUP names — groups expand to their member tools and
 * an individual entry overrides its group; disable wins over enable at
 * equal specificity.
 */

function axisShape(what: string) {
    return z
        .object({
            enable: z.array(z.string().min(1)).optional().describe(`${what} to enable on top of the agent's profile`),
            disable: z.array(z.string().min(1)).optional().describe(`${what} to disable (disable wins over enable)`),
        })
        .strict();
}

/** Zod schema for a capabilities override parameter (chain `.optional()`/`.nullable()`/`.describe(...)` at use sites). */
export function capabilityOverrideShape() {
    return z
        .object({
            mcpServers: axisShape("MCP server names from the deployment catalog").optional(),
            skills: axisShape("Skill names from the deployment catalog").optional(),
            tools: axisShape(
                "Tool names or tool-GROUP names from the deployment catalog (a group expands to its member tools; an individual tool entry overrides its group)",
            ).optional(),
        })
        .strict();
}
