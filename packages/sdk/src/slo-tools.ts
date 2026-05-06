import { defineTool } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import type { SessionCatalogProvider } from "./cms.js";
import { DEFAULT_SLO_THRESHOLDS } from "./slo-config.js";
import { evaluateSloHealth, decideSloAction } from "./slo-policy.js";

/**
 * Create SLO monitoring tools bound to the given CMS catalog.
 *
 * Register the returned tools via `worker.registerTools(tools)` and reference
 * them from the slo-monitor system agent's toolNames list.
 */
export function createSloTools(catalog: SessionCatalogProvider): Tool<any>[] {
    const sinceProp = {
        type: "string" as const,
        description: "ISO-8601 timestamp. Only evaluate turns after this time. Defaults to last 1 hour.",
    };

    // ── get_slo_health ────────────────────────────────────────

    const getSloHealth = defineTool("get_slo_health", {
        description:
            "Evaluate current SLO health across all agents and models. " +
            "Returns one health report per (agentId, model) group with status ok/warn/critical and any violations.",
        parameters: {
            type: "object" as const,
            properties: { since: sinceProp },
        },
        handler: async (args: { since?: string }) => {
            const since = args.since ? new Date(args.since) : new Date(Date.now() - 60 * 60 * 1000);
            const rows = await catalog.getFleetTurnAnalytics({ since });
            return rows.map(row => evaluateSloHealth(row, DEFAULT_SLO_THRESHOLDS));
        },
    });

    // ── get_slo_recommendations ───────────────────────────────

    const getSloRecommendations = defineTool("get_slo_recommendations", {
        description:
            "Return actionable recommendations for any active SLO violations. " +
            "Only returns entries where action is 'log' or 'alert' — healthy rows are omitted.",
        parameters: {
            type: "object" as const,
            properties: { since: sinceProp },
        },
        handler: async (args: { since?: string }) => {
            const since = args.since ? new Date(args.since) : new Date(Date.now() - 60 * 60 * 1000);
            const rows = await catalog.getFleetTurnAnalytics({ since });
            return rows
                .map(row => evaluateSloHealth(row, DEFAULT_SLO_THRESHOLDS))
                .map(report => ({ ...report, action: decideSloAction(report) }))
                .filter(r => r.action.action !== "none");
        },
    });

    return [getSloHealth, getSloRecommendations];
}
