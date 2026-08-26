import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../context.js";
import { jsonResult, errorResult, withToolErrors } from "../util/respond.js";

/**
 * Provider and budget tools (docs/proposals/providers-and-budgets.md).
 *
 * A session runs `provider:model`, and that provider is charged for every
 * turn it takes. A provider is SHARED (an administrator made it; anyone may
 * spend from it) or PERSONAL (you made it on your own credentials; only you
 * see it). A budget is limits — a hard token cap per period — plus an
 * allowance, the share of each limit that one person may use.
 *
 * Every tool here registers for every caller. Authority is not a property of
 * this surface: each call carries the viewer and the database refuses what
 * that viewer may not do, so an administrator's tools and a user's tools are
 * the same tools.
 */
export function registerProviderTools(server: McpServer, ctx: ServerContext) {
    // Direct mode holds DATABASE_URL and carries no request principal, so it
    // asks as an administrator who is nobody in particular. Web mode ignores
    // this argument: the server stamps the viewer from the credential that
    // made the request, because an identity a client gets to claim is not one.
    const viewer = { principal: null, isAdmin: ctx.admin };

    server.registerTool(
        "list_providers",
        {
            title: "List Providers",
            description:
                "List the providers a session can be run on: every shared provider plus your own personal ones. "
                + "Each row carries its type, class (shared or personal), owner, allowance, any hold, whether it is "
                + "the cluster or your default, and how many limits it has. Admins also see other people's personal "
                + "providers, marked usableByMe:false. For caps, spend and reset times use get_provider_status.",
            inputSchema: {},
        },
        withToolErrors(async () => jsonResult(await ctx.mgmt.listProviders(viewer))),
    );

    server.registerTool(
        "get_provider_status",
        {
            title: "Get Provider Status",
            description:
                "Budget state for providers you can see — the tool that answers 'how much room is left'. Each limit "
                + "comes back with its period, its scope (every model, or one named model), the cap, what has been "
                + "spent against it, when it resets, and your own ceiling and spend where an allowance applies.",
            inputSchema: {
                names: z.array(z.string().min(1)).optional().describe("Which providers to report on (default: all of them)"),
            },
        },
        withToolErrors(async ({ names }) => jsonResult(await ctx.mgmt.getProviderStatus(viewer, names ?? null))),
    );

    server.registerTool(
        "get_provider_usage_grid",
        {
            title: "Get Provider Usage Grid",
            description:
                "Every provider you can see, each followed by models with spend or limits, with what was spent and "
                + "what caps it for day, week and month — yours and everyone's, in one answer. Unlike "
                + "get_provider_status this reports a period with NO limit too: the meter runs whether or not "
                + "anybody capped it, and the quota comes back null to say so. Rows arrive in reading order: "
                + "shared providers first, then yours.",
            inputSchema: {},
        },
        withToolErrors(async () => jsonResult(await ctx.mgmt.getProviderUsageGrid(viewer))),
    );

    server.registerTool(
        "manage_provider",
        {
            title: "Manage Provider",
            description:
                "Create, update the credential on, or delete a provider.\n"
                + "  create — needs a type and the credentials that type requires; the name is cluster-unique and "
                + "cannot be changed afterwards\n"
                + "  update_credential — replaces the key on your OWN personal provider (mine:true) and changes "
                + "nothing else: the name, type, base URL, defaults, system-session routing and usage history all "
                + "stay. Use this to rotate an expired key rather than deleting and re-creating.\n"
                + "  delete — sessions naming it are not moved anywhere: they wait until the name exists again, and "
                + "waitingSessions says how many. Re-creating the name is the intended rescue.\n"
                + "mine:true makes (or removes) a provider of your own, on your own credentials, that nobody else "
                + "sees — anyone may. mine:false is a shared provider the whole cluster may spend from — admins only.",
            inputSchema: {
                action: z.enum(["create", "update_credential", "delete", "clear_routing"]).describe("The operation to perform"),
                name: z.string().min(1).describe("The provider name — letters, numbers, dot, dash and underscore, never a colon"),
                mine: z.boolean().describe("true = your own personal provider; false = a shared one everyone may use (admin)"),
                type: z.string().min(1).optional().describe("Provider type from the deployment's model-providers file (create) — the typeId list_providers shows on existing rows"),
                credentials: z.record(z.string(), z.any()).optional().describe("The credentials that type requires, e.g. {\"apiKey\": \"…\"} (create, update_credential)"),
                base_url: z.string().optional().describe("Endpoint to use instead of the type's own (create)"),
            },
        },
        withToolErrors(async ({ action, name, mine, type, credentials, base_url }) => {
            if (action === "clear_routing") {
                return jsonResult(await ctx.mgmt.clearProviderRoutingDependencies(viewer, name));
            }
            if (action === "update_credential") {
                if (!mine) return errorResult("update_credential is available only for your own personal provider", { name });
                return jsonResult(await ctx.mgmt.updateMyProviderCredential(viewer, { name, credentials: credentials ?? null }));
            }
            if (action === "delete") {
                return jsonResult(mine
                    ? await ctx.mgmt.deleteMyProvider(viewer, name)
                    : await ctx.mgmt.deleteProvider(viewer, name));
            }
            if (!type) return errorResult("create requires type", { name });
            const input = { name, type, credentials: credentials ?? null, baseUrl: base_url ?? null };
            return jsonResult(mine
                ? await ctx.mgmt.createMyProvider(viewer, input)
                : await ctx.mgmt.createProvider(viewer, input));
        }),
    );

    server.registerTool(
        "set_provider_limit",
        {
            title: "Set Provider Limit",
            description:
                "Save or remove one token limit on a provider. A limit is a hard cap for one period — day, week "
                + "(Monday-anchored) or month, all UTC — over every model or one named model. There is one limit per "
                + "period and scope, and saving the same pair replaces what was there. Omit tokens (or pass null) to "
                + "remove that limit instead. A limit counts what the current period has ALREADY spent — seededTokens "
                + "reports it — so setting one never resets anything, and a cap below current spend pauses those "
                + "sessions on their next turn. Admins set limits on shared providers; you set them on your own.",
            inputSchema: {
                provider: z.string().min(1).describe("The provider to cap"),
                period: z.enum(["day", "week", "month"]).describe("The window the cap applies to, UTC"),
                model: z.string().optional().describe("Cap one model (its qualified name); omit to cap every model on the provider"),
                tokens: z.number().int().positive().nullish().describe("The cap, a whole number of tokens. Omit or pass null to remove this limit."),
            },
        },
        withToolErrors(async ({ provider, period, model, tokens }) => {
            const ref = { provider, period, model: model ?? null };
            return jsonResult(tokens == null
                ? await ctx.mgmt.removeProviderLimit(viewer, ref)
                : await ctx.mgmt.setProviderLimit(viewer, { ...ref, tokens }));
        }),
    );

    server.registerTool(
        "set_provider_allowance",
        {
            title: "Set Provider Allowance",
            description:
                "Set the share of each of a shared provider's limits that ONE person may use, as a percentage. 100 "
                + "is full: no per-person ceiling, everyone draws on the same total. The ceiling is derived live — "
                + "raise a limit and every person's share rises with it — and it binds everyone, admins included. A "
                + "share of no limit is no limit: on a provider with no limits it changes nothing. Admins only, and "
                + "shared providers only, because a personal provider is shared with nobody.",
            inputSchema: {
                provider: z.string().min(1).describe("The shared provider"),
                pct: z.number().int().min(1).max(100).describe("Percent of each limit one person may use; 100 = full"),
            },
        },
        withToolErrors(async ({ provider, pct }) => jsonResult(await ctx.mgmt.setProviderAllowance(viewer, { provider, pct }))),
    );

    server.registerTool(
        "provider_hold",
        {
            title: "Hold Provider",
            description:
                "Stop new turns running against a provider, or let them run again — independent of any limit. "
                + "Sessions already waiting on the hold resume the moment it is released. action 'hold' with until_utc "
                + "lifts itself at that time; without one it holds until somebody releases it. Admins only.",
            inputSchema: {
                provider: z.string().min(1).describe("The provider to hold or release"),
                action: z.enum(["hold", "release"]).describe("hold stops new turns; release lets them run again"),
                until_utc: z.string().optional().describe("ISO time the hold lifts by itself (action 'hold'); omit for a hold with no end"),
            },
        },
        withToolErrors(async ({ provider, action, until_utc }) => jsonResult(
            await ctx.mgmt.setProviderHold(viewer, action === "release"
                ? { provider, release: true }
                : { provider, untilUtc: until_utc ?? null }),
        )),
    );

    server.registerTool(
        "get_provider_defaults",
        {
            title: "Get Provider Defaults",
            description:
                "The two default tuples — provider, model, reasoning effort, context tier. The cluster's is what "
                + "system sessions run on, and what anyone who set no default of their own gets; the other is yours. "
                + "A default prefills session creation and nothing else: it never decides who pays for a running session.",
            inputSchema: {},
        },
        withToolErrors(async () => jsonResult(await ctx.mgmt.getDefaults(viewer))),
    );

    server.registerTool(
        "get_model_defaults",
        {
            title: "Get Model Defaults",
            description:
                "Read configured and effective ordinary-session defaults. Administrators also receive the system "
                + "default and per-system-agent overrides. Effective values include deterministic first-available fallbacks.",
            inputSchema: {},
        },
        withToolErrors(async () => jsonResult(await ctx.mgmt.getModelDefaults(viewer))),
    );

    server.registerTool(
        "set_provider_default",
        {
            title: "Set Provider Default",
            description:
                "Set which provider and model new sessions start with. scope 'cluster' sets the deployment's tuple — "
                + "what system sessions run on, and what anyone with no default of their own gets; it must name a "
                + "shared provider, and it is admins only. scope 'me' sets your own, which may name a shared provider "
                + "or one of yours; omit provider to clear it and fall back to the cluster's.",
            inputSchema: {
                scope: z.enum(["cluster", "me"]).describe("Whose default to set"),
                provider: z.string().optional().describe("The provider the tuple names (omit with scope 'me' to clear your default)"),
                model: z.string().optional().describe("The model on that provider"),
                reasoning: z.string().optional().describe("Reasoning effort for that model (e.g. low, medium, high)"),
                context: z.string().optional().describe("Context-window tier: 'default' (smaller) or 'long_context'"),
            },
        },
        withToolErrors(async ({ scope, provider, model, reasoning, context }) => {
            const tuple = {
                provider: provider ?? null,
                model: model ?? null,
                reasoning: reasoning ?? null,
                context: context ?? null,
            };
            return jsonResult(scope === "cluster"
                ? await ctx.mgmt.setClusterDefault(viewer, tuple)
                : await ctx.mgmt.setMyDefault(viewer, tuple));
        }),
    );

    server.registerTool(
        "set_model_default",
        {
            title: "Set Model Default",
            description:
                "Set or clear an ordinary-session default. scope 'cluster' is admin-only and shared-provider-only; "
                + "scope 'user' changes only your future sessions.",
            inputSchema: {
                scope: z.enum(["cluster", "user"]),
                provider: z.string().nullish(),
                model: z.string().nullish(),
                reasoning: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).nullish(),
                context: z.enum(["default", "long_context"]).nullish(),
            },
        },
        withToolErrors(async ({ scope, provider, model, reasoning, context }) => jsonResult(
            await ctx.mgmt.setModelDefault(viewer, {
                scope,
                provider: provider ?? null,
                model: model ?? null,
                reasoningEffort: reasoning ?? null,
                contextTier: context ?? null,
            }),
        )),
    );

    server.registerTool(
        "set_provider_system_use",
        {
            title: "Set Provider System Use",
            description:
                "Allow or stop global system sessions from using one of your personal providers. Admin owner only. "
                + "This never makes the provider visible or usable by other users.",
            inputSchema: {
                provider: z.string().min(1),
                enabled: z.boolean(),
            },
        },
        withToolErrors(async ({ provider, enabled }) => jsonResult(
            await ctx.mgmt.setProviderSystemUse(viewer, { provider, enabled }),
        )),
    );

    server.registerTool(
        "get_legacy_provider_migration_status",
        {
            title: "Get Legacy Provider Migration Status",
            description: "Aggregate legacy GHCP migration counts and booleans. Admin only; never returns credential material.",
            inputSchema: {},
        },
        withToolErrors(async () => jsonResult(await ctx.mgmt.getLegacyProviderMigrationStatus(viewer))),
    );

    server.registerTool(
        "adopt_legacy_system_github_key",
        {
            title: "Adopt Legacy System GitHub Key",
            description:
                "Copy the legacy synthetic System GHCP key server-side into a private provider owned by the calling "
                + "admin and enable it for system sessions. The key is never returned. Admin only.",
            inputSchema: {
                name: z.string().min(1),
            },
        },
        withToolErrors(async ({ name }) => jsonResult(
            await ctx.mgmt.adoptLegacySystemGitHubCopilotKey(viewer, { name }),
        )),
    );

    server.registerTool(
        "set_system_model_default",
        {
            title: "Set System Model Default",
            description:
                "Set or clear the default model for system sessions. Admin only. Optionally restart inheriting "
                + "system sessions using complete, terminate, or hard_delete; per-agent overrides are excluded.",
            inputSchema: {
                provider: z.string().nullish(),
                model: z.string().nullish(),
                reasoning: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).nullish(),
                context: z.enum(["default", "long_context"]).nullish(),
                restart_disposition: z.enum(["complete", "terminate", "hard_delete"]).optional(),
            },
        },
        withToolErrors(async ({ provider, model, reasoning, context, restart_disposition }) => jsonResult(
            await ctx.mgmt.setSystemModelDefault(viewer, {
                provider: provider ?? null,
                model: model ?? null,
                reasoningEffort: reasoning ?? null,
                contextTier: context ?? null,
                restartExisting: restart_disposition ? { disposition: restart_disposition } : false,
            }),
        )),
    );

    server.registerTool(
        "manage_system_session_model",
        {
            title: "Manage System Session Model",
            description:
                "Set or clear a persistent model override for one system agent. Admin only. A live session switches "
                + "at its next turn boundary; use restart_system_session separately when a fresh session is required.",
            inputSchema: {
                action: z.enum(["set", "clear"]),
                agent_id: z.string().min(1),
                provider: z.string().optional(),
                model: z.string().optional(),
                reasoning: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
                context: z.enum(["default", "long_context"]).optional(),
            },
        },
        withToolErrors(async ({ action, agent_id, provider, model, reasoning, context }) => {
            if (action === "clear") {
                return jsonResult(await ctx.mgmt.clearSystemSessionModel(viewer, agent_id));
            }
            if (!provider || !model) return errorResult("set requires provider and model", { agent_id });
            return jsonResult(await ctx.mgmt.setSystemSessionModel(viewer, {
                agentId: agent_id,
                provider,
                model,
                reasoningEffort: reasoning ?? null,
                contextTier: context ?? null,
            }));
        }),
    );

    server.registerTool(
        "get_provider_usage",
        {
            title: "Get Provider Usage",
            description:
                "Where the tokens went: totals (tokens, turns, sessions), a per-day series, and one breakdown, all "
                + "over the same filters. dimension chooses what the breakdown groups by — session, user, provider, "
                + "model or agent. You see your own spend; admins can widen it to the whole fleet, and the database "
                + "clamps the rows either way. charge_class separates people's sessions from 'system' (the machinery "
                + "PilotSwarm runs for itself, which no limit stops) and 'unattributed' (turns with no provider "
                + "recorded).",
            inputSchema: {
                days: z.number().int().min(1).max(365).optional().describe("How many days back to count (default 7)"),
                owner_user_id: z.number().int().optional().describe("One person's spend (admins; everyone else sees only their own rows)"),
                provider: z.string().optional().describe("Only this provider"),
                model: z.string().optional().describe("Only this model"),
                session_id: z.string().optional().describe("Only this session"),
                charge_class: z.enum(["user", "system", "unattributed"]).optional().describe("Only people's sessions, only system machinery, or only turns with no provider recorded"),
                dimension: z.enum(["session", "user", "provider", "model", "agent"]).optional().describe("What the breakdown groups by (default 'provider')"),
                limit: z.number().int().min(1).max(200).optional().describe("Breakdown rows to return (default 40); the answer reports whether it was truncated"),
            },
        },
        withToolErrors(async ({ days, owner_user_id, provider, model, session_id, charge_class, dimension, limit }) =>
            jsonResult(await ctx.mgmt.getProviderUsage(viewer, {
                days,
                ownerUserId: owner_user_id,
                provider,
                model,
                sessionId: session_id,
                chargeClass: charge_class,
                dimension,
                limit,
            }))),
    );

    server.registerTool(
        "list_paused_sessions",
        {
            title: "List Paused Sessions",
            description:
                "Sessions waiting on a budget right now, and what holds each one: a limit it reached, an allowance "
                + "used up, a hold, or a provider name that no longer resolves — with the time the wait ends by "
                + "itself where there is one. Your own sessions; fleet-wide for admins.",
            inputSchema: {},
        },
        withToolErrors(async () => jsonResult(await ctx.mgmt.listPausedSessions(viewer))),
    );
}
