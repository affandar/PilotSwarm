import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { FeatureFlagCache } from "./feature-flag-cache.js";
import type { FeatureOwner } from "./feature-flags.js";

const v2Prompt = readFileSync(new URL("../plugins/system/prompts/base-v2.md", import.meta.url), "utf8").trim();
export interface BaseAgentPolicy {
    version: "v1" | "v2";
    fingerprint: string;
    revision: string | null;
    reason?: string;
}

/** Native access is resolved independently; this switch only selects instructions. */
export function resolveBaseAgentPolicy(cache: FeatureFlagCache | null, owner: FeatureOwner | null,
    nativeEnabled: boolean): BaseAgentPolicy {
    const decision = owner ? cache?.resolve("agents.base_v2", owner, { fallback: false }) : undefined;
    const enabled = decision?.enabled === true && nativeEnabled;
    return {
        version: enabled ? "v2" : "v1",
        fingerprint: enabled ? createHash("sha256").update(v2Prompt).digest("hex") : "v1",
        revision: decision?.revision ?? null,
        ...(!owner ? { reason: "owner_unavailable" }
            : decision?.enabled && !nativeEnabled ? { reason: "Requires Native Copilot tasks" }
                : decision?.reason ? { reason: decision.reason === "requires_native_tasks" ? "Requires Native Copilot tasks" : decision.reason } : {}),
    };
}

export function baseAgentInstructions(policy: BaseAgentPolicy | undefined, legacy: string | undefined): string | undefined {
    return policy?.version === "v2" ? v2Prompt : legacy;
}

export const DURABLE_SPAWN_DESCRIPTION = "Create an independent durable agent session with its own conversation and tools. "
    + "For a named workflow from the static and published agent catalog, pass its exact agent_name from ps_list_agents; task supplies your assignment, while its instructions, tools and startup requirements load automatically. "
    + "Do not override system_message or tool_names for a named agent. For an ad-hoc durable assignment, omit agent_name and supply task. "
    + "Durable children may execute on another worker and do not automatically terminate after a reply. Transfer files using artifacts, and close finite children after validating their outputs. "
    + "A successful spawn does not finish the parent's turn. Continue the workflow or use the appropriate wait tool. "
    + "Worker-managed system agents cannot be spawned. Follow the base and selected workflow instructions to choose direct, native or durable execution.";
