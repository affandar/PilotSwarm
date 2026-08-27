/**
 * Provider budget tools — the agent surface over providers, limits,
 * allowances, holds and usage.
 *
 * The same capabilities the MCP server registers, under the same names
 * and with the same arguments (docs/proposals/providers-and-budgets-surface.md).
 * A session runs `provider:model` and that provider is charged for every turn
 * it takes; a provider is SHARED (an administrator made it, anyone may spend
 * from it) or PERSONAL (its creator's own credentials, nobody else sees it).
 *
 * AUTHORITY. One tool set, two scopes, decided by `resolveViewer`:
 *   - the Token Manager      → {userId: null, isAdmin: true}: the whole cluster
 *   - a user's Token Manager → the session OWNER's user id, with the role
 *     freshly resolved for that person
 * Nothing below asks whether the caller may do the thing. Every call reaches a
 * `cms_provider_*` procedure carrying the viewer, and the procedure raises
 * PROVIDER_FORBIDDEN / PROVIDER_NOT_FOUND when they may not — which is why an
 * administrator's tools and a user's tools are the same tools. Branching
 * on `isAdmin` here would be a second copy of a rule that already lives in
 * SQL, and the two would eventually disagree.
 *
 * THE TWO-PLACE TRAP. A tool the model can call needs BOTH a declaration in
 * `ManagedSession.systemToolDefs()` and a handler registered for the turn. A
 * handler with no declaration is invisible to the model; a declaration with no
 * handler HANGS the turn, because the CLI drops a call it has no handler for
 * without answering. Both halves are built from the one `PROVIDER_TOOL_SPECS`
 * table below, so a schema is written once and cannot drift.
 *
 * @module
 * @internal
 */
import { defineTool } from "@github/copilot-sdk";
import type { Tool } from "@github/copilot-sdk";
import type { SessionCatalog } from "./cms.js";
import type { ProviderStore, ChargeClass } from "./provider-store.js";
import { ProviderError } from "./provider-store.js";
import type { BudgetPeriod } from "./provider-budgets.js";

/**
 * Agent ids that hold these tools.
 *
 * A tool declaration is resident context on every turn of every session that
 * carries it, so they go only to the two agents whose job this is. The
 * list decides who SEES the tools, never what they may do: `token-manager`
 * runs with cluster authority and `user-token-manager` runs as its owner, and
 * both refusals are made by the database either way.
 */
export const PROVIDER_TOOL_AGENT_IDS = new Set(["token-manager", "user-token-manager"]);

/** Does this agent identity hold the provider budget tools? */
export function holdsProviderTools(agentIdentity?: string | null): boolean {
    return PROVIDER_TOOL_AGENT_IDS.has(String(agentIdentity ?? ""));
}

/** Who the tool call runs as. Numbers, because the procedures take numbers. */
export interface ProviderToolsViewer {
    userId: number | null;
    isAdmin: boolean;
}

/** A caller the deployment cannot identify, which the procedures read as nobody. */
const NO_VIEWER: ProviderToolsViewer = { userId: null, isAdmin: false };

/** What a usage breakdown groups by — the five the usage procedures accept. */
const USAGE_DIMENSIONS = ["session", "user", "provider", "model", "agent"] as const;
type UsageDimension = (typeof USAGE_DIMENSIONS)[number];

const DEFAULT_USAGE_DAYS = 7;
const DEFAULT_BREAKDOWN_LIMIT = 40;
const MAX_BREAKDOWN_LIMIT = 200;

export interface CreateProviderToolsOptions {
    catalog: SessionCatalog;
    /**
     * Resolved per call, never stamped at session start: a session outlives
     * the role that created it, so caching would let a demoted administrator
     * keep cluster reach for as long as their session stayed open.
     */
    resolveViewer: () => ProviderToolsViewer | Promise<ProviderToolsViewer>;
}

interface ProviderToolSpec {
    name: string;
    description: string;
    parameters: {
        type: "object";
        properties: Record<string, unknown>;
        required?: string[];
    };
}

function clampInteger(value: unknown, defaultValue: number, min: number, max: number): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return defaultValue;
    return Math.max(min, Math.min(Math.trunc(n), max));
}

/** An empty string from a model is not a value; it is the field left blank. */
function text(value: unknown): string | null {
    const s = String(value ?? "").trim();
    return s ? s : null;
}

/**
 * A default is one tuple, saved whole. With no provider there is nothing to
 * run, so the other three go with it — a model for a provider that was
 * cleared is half a default, which nobody can act on.
 */
function defaultTuple(args: { provider?: string; model?: string; reasoning?: string; context?: string }) {
    const provider = text(args.provider);
    if (!provider) return { provider: null, model: null, reasoning: null, context: null };
    return {
        provider,
        model: text(args.model),
        reasoning: text(args.reasoning),
        context: text(args.context),
    };
}

/**
 * The schemas, written once. `providerToolDefs()` turns them into the
 * declarations the model is shown, `createProviderTools()` turns them into the
 * handlers that run, and both come from this table so the two can never
 * describe different arguments.
 */
const PROVIDER_TOOL_SPECS: ProviderToolSpec[] = [
    {
        name: "list_providers",
        description:
            "List the providers a session can be run on: every shared provider plus your own personal ones. "
            + "Each row carries its type, class (shared or personal), owner, allowance, any hold, whether it is "
            + "the cluster or your default, and how many limits it has. Admins also see other people's personal "
            + "providers, marked usableByMe:false. For caps, spend and reset times use get_provider_status.",
        parameters: { type: "object", properties: {} },
    },
    {
        name: "get_provider_status",
        description:
            "Budget state for providers you can see — the tool that answers 'how much room is left'. Each limit "
            + "comes back with its period, its scope (every model, or one named model), the cap, what has been "
            + "spent against it, when it resets, and your own ceiling and spend where an allowance applies.",
        parameters: {
            type: "object",
            properties: {
                names: {
                    type: "array",
                    items: { type: "string" },
                    description: "Which providers to report on (default: all of them)",
                },
            },
        },
    },
    {
        name: "get_provider_usage_grid",
        description:
            "Every provider you can see, each followed by models with spend or limits, with what was spent and what "
            + "caps it for day, week and month — yours and everyone's, in one answer. Unlike get_provider_status "
            + "this reports a period with NO limit too: the meter runs whether or not anybody capped it, and the "
            + "quota comes back null to say so. Rows arrive in reading order: shared providers first, then yours.",
        parameters: { type: "object", properties: {} },
    },
    {
        name: "manage_provider",
        description:
            "Create, update the credential on, or delete a provider.\n"
            + "  create — needs a type and the credentials that type requires; the name is cluster-unique and "
            + "cannot be changed afterwards\n"
            + "  delete — sessions naming it are not moved anywhere: they wait until the name exists again, and "
            + "the answer says how many are waiting. Re-creating the name is the intended rescue.\n"
            + "mine:true makes (or removes) a provider of your own, on your own credentials, that nobody else "
            + "sees — anyone may. mine:false is a shared provider the whole cluster may spend from — admins only.",
        parameters: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["create", "update_credential", "delete", "clear_routing"], description: "The operation to perform" },
                name: {
                    type: "string",
                    description: "The provider name — letters, numbers, dot, dash and underscore, never a colon",
                },
                mine: {
                    type: "boolean",
                    description: "true = your own personal provider; false = a shared one everyone may use (admin)",
                },
                type: {
                    type: "string",
                    description: "Provider type from the deployment's model-providers file (create) — the typeId list_providers shows on existing rows",
                },
                credentials: {
                    type: "object",
                    description: "The credentials that type requires, e.g. {\"apiKey\": \"…\"} (create)",
                    additionalProperties: true,
                },
                base_url: { type: "string", description: "Endpoint to use instead of the type's own (create)" },
            },
            required: ["action", "name", "mine"],
        },
    },
    {
        name: "set_provider_limit",
        description:
            "Save or remove one token limit on a provider. A limit is a hard cap for one period — day, week "
            + "(Monday-anchored) or month, all UTC — over every model or one named model. There is one limit per "
            + "period and scope, and saving the same pair replaces what was there. Omit tokens (or pass null) to "
            + "remove that limit instead. A limit counts what the current period has ALREADY spent — seededTokens "
            + "reports it — so setting one never resets anything, and a cap below current spend pauses those "
            + "sessions on their next turn. Admins set limits on shared providers; you set them on your own.",
        parameters: {
            type: "object",
            properties: {
                provider: { type: "string", description: "The provider to cap" },
                period: { type: "string", enum: ["day", "week", "month"], description: "The window the cap applies to, UTC" },
                model: {
                    type: "string",
                    description: "Cap one model (its qualified name); omit to cap every model on the provider",
                },
                tokens: {
                    type: "number",
                    description: "The cap, a whole number of tokens. Omit or pass null to remove this limit.",
                },
            },
            required: ["provider", "period"],
        },
    },
    {
        name: "set_provider_allowance",
        description:
            "Set the share of each of a shared provider's limits that ONE person may use, as a percentage. 100 "
            + "is full: no per-person ceiling, everyone draws on the same total. The ceiling is derived live — "
            + "raise a limit and every person's share rises with it — and it binds everyone, admins included. A "
            + "share of no limit is no limit: on a provider with no limits it changes nothing. Admins only, and "
            + "shared providers only, because a personal provider is shared with nobody.",
        parameters: {
            type: "object",
            properties: {
                provider: { type: "string", description: "The shared provider" },
                pct: { type: "number", description: "Percent of each limit one person may use, 1-100; 100 = full" },
            },
            required: ["provider", "pct"],
        },
    },
    {
        name: "provider_hold",
        description:
            "Stop new turns running against a provider, or let them run again — independent of any limit. "
            + "Sessions already waiting on the hold resume the moment it is released. action 'hold' with until_utc "
            + "lifts itself at that time; without one it holds until somebody releases it. Admins only.",
        parameters: {
            type: "object",
            properties: {
                provider: { type: "string", description: "The provider to hold or release" },
                action: {
                    type: "string",
                    enum: ["hold", "release"],
                    description: "hold stops new turns; release lets them run again",
                },
                until_utc: {
                    type: "string",
                    description: "ISO time the hold lifts by itself (action 'hold'); omit for a hold with no end",
                },
            },
            required: ["provider", "action"],
        },
    },
    {
        name: "get_provider_defaults",
        description:
            "Compatibility view of configured cluster, personal and system model tuples. Use get_model_defaults "
            + "for effective fallbacks and per-system-agent overrides.",
        parameters: { type: "object", properties: {} },
    },
    {
        name: "get_model_defaults",
        description:
            "Configured model defaults plus the persistent per-system-agent override table. The management API "
            + "adds effective first-available fallbacks; this agent view reports the durable configured state.",
        parameters: { type: "object", properties: {} },
    },
    {
        name: "set_provider_default",
        description:
            "Legacy alias for setting an ordinary-session default. scope 'cluster' is admin-only and must name a "
            + "shared provider; scope 'me' sets the caller's own default. It never changes system-session routing.",
        parameters: {
            type: "object",
            properties: {
                scope: { type: "string", enum: ["cluster", "me"], description: "Whose default to set" },
                provider: {
                    type: "string",
                    description: "The provider the tuple names (omit with scope 'me' to clear your default)",
                },
                model: { type: "string", description: "The model on that provider" },
                reasoning: { type: "string", description: "Reasoning effort for that model (e.g. low, medium, high)" },
                context: { type: "string", description: "Context-window tier: 'default' (smaller) or 'long_context'" },
            },
            required: ["scope"],
        },
    },
    {
        name: "set_model_default",
        description:
            "Set an ordinary-session default. scope 'cluster' is admin-only and shared-provider-only; scope 'user' "
            + "sets the caller's own default. Omit provider to clear. Existing sessions never change.",
        parameters: {
            type: "object",
            properties: {
                scope: { type: "string", enum: ["cluster", "user"], description: "Whose ordinary-session default to set" },
                provider: { type: "string", description: "Provider name; omit to clear" },
                model: { type: "string", description: "Model on that provider" },
                reasoning: { type: "string", description: "Reasoning effort" },
                context: { type: "string", description: "Context-window tier" },
            },
            required: ["scope"],
        },
    },
    {
        name: "set_provider_system_use",
        description:
            "Allow or stop system-session use of the calling admin's own personal provider. This does not make "
            + "the provider available to other users.",
        parameters: {
            type: "object",
            properties: {
                provider: { type: "string", description: "Your personal provider" },
                enabled: { type: "boolean", description: "Whether system sessions may use it" },
            },
            required: ["provider", "enabled"],
        },
    },
    {
        name: "get_legacy_provider_migration_status",
        description: "Read aggregate legacy GHCP migration status. Admin only; no credential material is returned.",
        parameters: { type: "object", properties: {} },
    },
    {
        name: "adopt_legacy_system_github_key",
        description:
            "Adopt the legacy synthetic System GHCP key into a private provider owned by the calling admin and "
            + "enable it for system sessions. The credential never leaves the database. Admin only.",
        parameters: {
            type: "object",
            properties: {
                name: { type: "string", description: "Name for the adopted private provider" },
            },
            required: ["name"],
        },
    },
    {
        name: "set_system_model_default",
        description:
            "Set or clear the configured system-session default. Admin only. Agent tools update desired state "
            + "future-first; use the management restart operation for a disposition-controlled restart rollout.",
        parameters: {
            type: "object",
            properties: {
                provider: { type: "string", description: "System-eligible provider; omit to clear" },
                model: { type: "string", description: "Model on that provider" },
                reasoning: { type: "string", description: "Reasoning effort" },
                context: { type: "string", description: "Context-window tier" },
            },
        },
    },
    {
        name: "manage_system_session_model",
        description:
            "Set or clear a persistent model override for one system agent. Admin only. Live switching and "
            + "restart lifecycle are handled by the management API; this tool updates desired state.",
        parameters: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["set", "clear"] },
                agent_id: { type: "string", description: "Deterministic system agent id" },
                provider: { type: "string" },
                model: { type: "string" },
                reasoning: { type: "string" },
                context: { type: "string" },
            },
            required: ["action", "agent_id"],
        },
    },
    {
        name: "get_provider_usage_summary",
        description:
            "The cluster summary from the usage ledger: token totals for today, the last 7 and the last 30 UTC "
            + "days (input, output, cache read, cache write, total, turns, sessions), a per-day series, and the "
            + "per-MODEL pivot — one row per model name across every provider, reasoning effort and context tier, "
            + "each with its own per-day totals. Admins see the whole cluster, system sessions included (the "
            + "provider meters count people's turns only; `classes` shows the split); everyone else sees their "
            + "own turns. One call; never iterate sessions to build this picture.",
        parameters: {
            type: "object",
            properties: {
                days: { type: "number", description: "Days of history for the series and the model table (default 14, max 365)" },
                providers: {
                    type: "array",
                    items: { type: "string" },
                    description: "Only these providers, by name; absent means all",
                },
            },
        },
    },
    {
        name: "get_provider_usage",
        description:
            "Where the tokens went: totals (tokens, turns, sessions), a per-day series, and one breakdown, all "
            + "over the same filters. dimension chooses what the breakdown groups by — session, user, provider, "
            + "model or agent. You see your own spend; admins can widen it to the whole fleet, and the database "
            + "clamps the rows either way. charge_class separates people's sessions from 'system' (the machinery "
            + "PilotSwarm runs for itself, which no limit stops) and 'unattributed' (turns with no provider "
            + "recorded). One call answers the whole question — never iterate sessions to build a usage picture.",
        parameters: {
            type: "object",
            properties: {
                days: { type: "number", description: `How many days back to count (default ${DEFAULT_USAGE_DAYS}, max 365)` },
                owner_user_id: {
                    type: "number",
                    description: "One person's spend (admins; everyone else sees only their own rows)",
                },
                provider: { type: "string", description: "Only this provider" },
                model: { type: "string", description: "Only this model" },
                session_id: { type: "string", description: "Only this session" },
                charge_class: {
                    type: "string",
                    enum: ["user", "system", "unattributed"],
                    description: "Only people's sessions, only system machinery, or only turns with no provider recorded",
                },
                dimension: {
                    type: "string",
                    enum: [...USAGE_DIMENSIONS],
                    description: "What the breakdown groups by (default 'provider')",
                },
                limit: {
                    type: "number",
                    description: `Breakdown rows to return (default ${DEFAULT_BREAKDOWN_LIMIT}, max ${MAX_BREAKDOWN_LIMIT}); the answer reports whether it was truncated`,
                },
            },
        },
    },
    {
        name: "list_paused_sessions",
        description:
            "Sessions waiting on a budget right now, and what holds each one: a limit it reached, an allowance "
            + "used up, a hold, or a provider name that no longer resolves — with the time the wait ends by "
            + "itself where there is one. Your own sessions; fleet-wide for admins.",
        parameters: { type: "object", properties: {} },
    },
];

/** Every provider budget tool name, in the order the specs declare them. */
export const PROVIDER_TOOL_NAMES: readonly string[] = PROVIDER_TOOL_SPECS.map((spec) => spec.name);

type ProviderToolHandler = (args: any, context?: any) => Promise<unknown>;

function buildProviderTools(handlerFor: (spec: ProviderToolSpec) => ProviderToolHandler): Tool<any>[] {
    return PROVIDER_TOOL_SPECS.map((spec) => defineTool(spec.name, {
        description: spec.description,
        parameters: spec.parameters as any,
        handler: handlerFor(spec),
    }));
}

/**
 * The declarations, with no behaviour — what `systemToolDefs()` shows the
 * model at session-create time. The handlers that actually run are registered
 * for the turn; see the two-place trap at the top of this file.
 */
export function providerToolDefs(): Tool<any>[] {
    return buildProviderTools(() => async () => "stub");
}

/**
 * The same tools with nothing behind them, refusing by name.
 *
 * Registered for a turn where the host wired no data layer. A clean refusal
 * is the point: the alternative to a registered handler is no handler, and a
 * call the CLI has no handler for is dropped without a response, which wedges
 * the turn instead of answering it.
 */
export function providerToolsUnavailable(reason: string): Tool<any>[] {
    return buildProviderTools((spec) => async () => ({ error: `${spec.name}: ${reason}` }));
}

export function createProviderTools(opts: CreateProviderToolsOptions): Tool<any>[] {
    const { catalog, resolveViewer } = opts;

    /** Fail closed: an unresolvable viewer reads nothing rather than everything. */
    const viewer = async (): Promise<ProviderToolsViewer> => {
        try {
            const v = await resolveViewer();
            if (!v || typeof v !== "object") return NO_VIEWER;
            return {
                userId: v.userId === null || v.userId === undefined ? null : Number(v.userId),
                isAdmin: v.isAdmin === true,
            };
        } catch {
            return NO_VIEWER;
        }
    };

    /**
     * One entry point for every handler: find the store, resolve the
     * viewer, and turn a refusal into words the model can act on. A
     * `ProviderError` already carries a sentence written for a person, so it
     * is passed through with its code rather than restated.
     */
    async function call(
        toolName: string,
        fn: (store: ProviderStore, v: ProviderToolsViewer) => Promise<unknown>,
    ): Promise<unknown> {
        const store = catalog.providers;
        if (!store) return { error: `${toolName}: this deployment does not run provider budgets.` };
        try {
            return await fn(store, await viewer());
        } catch (err: any) {
            if (err instanceof ProviderError) return { error: err.message, code: err.code };
            return { error: `${toolName}: ${err?.message || String(err)}` };
        }
    }

    const handlers: Record<string, ProviderToolHandler> = {
        list_providers: async () => call("list_providers", async (store, v) => ({
            providers: await store.listProviders(v.userId, v.isAdmin),
        })),

        get_provider_status: async (args: { names?: string[] }) => call("get_provider_status", async (store, v) => ({
            providers: await store.providerStatus(v.userId, v.isAdmin, args?.names ?? null),
        })),

        get_provider_usage_grid: async () => call("get_provider_usage_grid", async (store, v) => ({
            rows: await store.usageGrid(v.userId, v.isAdmin),
        })),

        manage_provider: async (args: {
            action: "create" | "update_credential" | "delete" | "clear_routing";
            name: string;
            mine: boolean;
            type?: string;
            credentials?: Record<string, unknown>;
            base_url?: string;
        }) => call("manage_provider", async (store, v) => {
            if (args.action === "clear_routing") {
                return { name: args.name, ...(await store.clearRoutingDependencies(args.name, v.userId, v.isAdmin)) };
            }
            if (args.action === "update_credential") {
                // mine:false is the SHARED provider, admin-only and enforced in
                // SQL by the same manage gate the other shared mutations use —
                // a non-admin gets PROVIDER_FORBIDDEN, and a personal name
                // reads as absent even to an admin.
                if (!args.mine) {
                    return store.updateSharedCredential(args.name, args.credentials ?? null, v.userId, v.isAdmin);
                }
                // NOT AUDITED. The HTTP route writes an authz_audit row
                // (management-client updateMyProviderCredential); this surface
                // writes none, so a key rotated from inside a session leaves no
                // trace. Same for create/delete just below — the gap is the
                // surface's, not this action's.
                //
                // Deliberately not patched here: ProviderToolsViewer carries
                // only { userId, isAdmin }, so a row written from here would
                // have a null actor — weaker than no row, because it looks like
                // attribution and is not. The real fix is to thread the
                // principal into the viewer and route all four actions through
                // the management client.
                return store.updatePersonalCredential(args.name, args.credentials ?? null, v.userId);
            }
            // Deleting your own and deleting a shared one are the same call:
            // `cms_provider_delete` refuses a name the caller may not touch,
            // so `mine` changes nothing here except what the caller meant.
            if (args.action === "delete") {
                return { name: args.name, waitingSessions: await store.deleteProvider(args.name, v.userId, v.isAdmin) };
            }
            if (!text(args.type)) return { error: "manage_provider: create needs a type." };
            const created = await store.createProvider({
                name: args.name,
                typeId: String(args.type),
                class: args.mine ? "personal" : "shared",
                ownerUserId: args.mine ? v.userId : null,
                secretRef: args.credentials ?? null,
                baseUrl: text(args.base_url),
            }, v.userId, v.isAdmin);
            return created;
        }),

        set_provider_limit: async (args: {
            provider: string;
            period: BudgetPeriod;
            model?: string;
            tokens?: number | null;
        }) => call("set_provider_limit", async (store, v) => {
            const model = text(args.model);
            if (args.tokens === null || args.tokens === undefined) {
                return { removed: await store.removeLimit(args.provider, args.period, model, v.userId, v.isAdmin) };
            }
            return store.setLimit({
                name: args.provider,
                period: args.period,
                modelQualified: model,
                limitTokens: Number(args.tokens),
            }, v.userId, v.isAdmin);
        }),

        set_provider_allowance: async (args: { provider: string; pct: number }) =>
            call("set_provider_allowance", async (store, v) => ({
                name: args.provider,
                allowancePct: await store.setAllowance(args.provider, Number(args.pct), v.userId, v.isAdmin),
            })),

        provider_hold: async (args: { provider: string; action: "hold" | "release"; until_utc?: string }) =>
            call("provider_hold", async (store, v) => {
                const release = args.action === "release";
                const untilUtc = release ? null : text(args.until_utc);
                const indefinite = !release && !untilUtc;
                await store.setHold(args.provider, { untilUtc, indefinite }, v.userId, v.isAdmin);
                return { name: args.provider, holdUntilUtc: untilUtc, holdIndefinite: indefinite };
            }),

        get_provider_defaults: async () => call("get_provider_defaults", async (store, v) =>
            store.getDefaults(v.userId)),

        get_model_defaults: async () => call("get_model_defaults", async (store, v) => ({
            ...(await store.getDefaults(v.userId)),
            systemOverrides: v.isAdmin ? await store.listSystemAgentModels() : [],
        })),

        set_provider_default: async (args: {
            scope: "cluster" | "me";
            provider?: string;
            model?: string;
            reasoning?: string;
            context?: string;
        }) => call("set_provider_default", async (store, v) => {
            const tuple = defaultTuple(args);
            if (args.scope === "cluster") {
                await store.setClusterDefault(tuple, v.isAdmin);
            } else {
                await store.setUserDefault(v.userId, tuple);
            }
            return tuple;
        }),

        set_model_default: async (args: {
            scope: "cluster" | "user";
            provider?: string;
            model?: string;
            reasoning?: string;
            context?: string;
        }) => call("set_model_default", async (store, v) => {
            const tuple = defaultTuple(args);
            if (args.scope === "cluster") await store.setClusterDefault(tuple, v.isAdmin);
            else await store.setUserDefault(v.userId, tuple);
            return tuple;
        }),

        set_provider_system_use: async (args: { provider: string; enabled: boolean }) =>
            call("set_provider_system_use", async (store, v) => ({
                provider: args.provider,
                systemUseEnabled: await store.setSystemUse(args.provider, args.enabled === true, v.userId, v.isAdmin),
            })),

        get_legacy_provider_migration_status: async () =>
            call("get_legacy_provider_migration_status", async (store, v) => {
                if (!v.isAdmin) return { error: "Only an administrator can read legacy provider migration status." };
                return store.getLegacyKeyMigrationStatus();
            }),

        adopt_legacy_system_github_key: async (args: { name: string }) =>
            call("adopt_legacy_system_github_key", async (store, v) => ({
                provider: await store.adoptLegacySystemGitHubKey(
                    args.name, v.userId, v.isAdmin),
                status: await store.getLegacyKeyMigrationStatus(),
            })),

        set_system_model_default: async (args: {
            provider?: string;
            model?: string;
            reasoning?: string;
            context?: string;
        }) => call("set_system_model_default", async (store, v) => {
            const tuple = defaultTuple(args);
            await store.setSystemDefault(v.userId, v.isAdmin, tuple);
            return tuple;
        }),

        manage_system_session_model: async (args: {
            action: "set" | "clear";
            agent_id: string;
            provider?: string;
            model?: string;
            reasoning?: string;
            context?: string;
        }) => call("manage_system_session_model", async (store, v) => {
            if (args.action === "clear") {
                return { agentId: args.agent_id, cleared: await store.clearSystemAgentModel(args.agent_id, v.userId, v.isAdmin) };
            }
            const tuple = defaultTuple(args);
            await store.setSystemAgentModel(args.agent_id, v.userId, v.isAdmin, tuple);
            return { agentId: args.agent_id, ...tuple };
        }),

        get_provider_usage_summary: async (args: {
            days?: number;
            providers?: string[];
        }) => call("get_provider_usage_summary", async (store, v) => {
            const days = clampInteger(args?.days, 14, 1, 365);
            const providers = Array.isArray(args?.providers)
                ? args!.providers.map((p) => text(p)).filter((p): p is string => Boolean(p))
                : null;
            return store.usageSummary(v.userId, v.isAdmin, days, providers);
        }),

        get_provider_usage: async (args: {
            days?: number;
            owner_user_id?: number;
            provider?: string;
            model?: string;
            session_id?: string;
            charge_class?: ChargeClass;
            dimension?: string;
            limit?: number;
        }) => call("get_provider_usage", async (store, v) => {
            // The SQL falls back to `provider` for a dimension it does not
            // know, so the answer reports the dimension actually grouped by
            // rather than echoing what was asked for.
            const dimension: UsageDimension = USAGE_DIMENSIONS.includes(args?.dimension as UsageDimension)
                ? args!.dimension as UsageDimension
                : "provider";
            const limit = clampInteger(args?.limit, DEFAULT_BREAKDOWN_LIMIT, 1, MAX_BREAKDOWN_LIMIT);
            // One filter set for all three reads: a report whose total and
            // whose chart were built from different filters is one nobody can
            // act on.
            const filters = {
                days: clampInteger(args?.days, DEFAULT_USAGE_DAYS, 1, 365),
                ownerUserId: args?.owner_user_id ?? null,
                provider: text(args?.provider),
                model: text(args?.model),
                sessionId: text(args?.session_id),
                chargeClass: args?.charge_class ?? null,
            };
            const [totals, daily, breakdown] = await Promise.all([
                store.usageTotals(v.userId, v.isAdmin, filters),
                store.usageDaily(v.userId, v.isAdmin, filters),
                // One row more than is returned, so `truncated` is measured.
                store.usageBreakdown(v.userId, v.isAdmin, dimension, filters, limit + 1),
            ]);
            return {
                totals,
                daily,
                breakdown: breakdown.slice(0, limit),
                dimension,
                truncated: breakdown.length > limit,
            };
        }),

        list_paused_sessions: async () => call("list_paused_sessions", async (store, v) => ({
            sessions: await store.listPaused(v.userId, v.isAdmin),
        })),
    };

    return buildProviderTools((spec) => {
        const handler = handlers[spec.name];
        // Loud at construction rather than silent at call time: a spec with no
        // handler is the two-place trap happening inside this one file.
        if (!handler) throw new Error(`provider tool ${spec.name} is declared but has no handler`);
        return handler;
    });
}
