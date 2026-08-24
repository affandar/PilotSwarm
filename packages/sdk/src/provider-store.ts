/**
 * Provider budgets — the data access layer.
 *
 * One class over the `cms_provider_*` stored procedures from migrations
 * 0049-0053. It is deliberately thin: every rule about who may do what, and
 * every counter decision, lives in SQL (see the migration headers for why),
 * so nothing here re-implements a policy. What it does add is shape — the
 * database's snake_case rows become the objects the API, the MCP server, the
 * agent tools and the portal all share — and a typed error, so a refusal
 * arrives at the caller as a code rather than a string to grep.
 */
import type { Pool } from "pg";
import type { BudgetPeriod, BudgetRuleState, TurnAdmission } from "./provider-budgets.js";
import { toTurnAdmission } from "./provider-budgets.js";

export type ProviderClass = "shared" | "personal";
export type ChargeClass = "user" | "system" | "unattributed";

/** A refusal from the database, with the marker turned into a code. */
export class ProviderError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.name = "ProviderError";
        this.code = code;
    }
}

const PROVIDER_ERROR = /^(PROVIDER_[A-Z_]+):\s*(.*)$/s;

/**
 * Stored-procedure refusals arrive as `PROVIDER_FORBIDDEN: ...`. Everything
 * else — a dropped connection, a constraint the procs did not anticipate —
 * is passed through untouched, so a real fault is never mistaken for a
 * policy decision.
 */
function rethrow(err: any): never {
    const raw = String(err?.message ?? "");
    const m = PROVIDER_ERROR.exec(raw);
    if (m) throw new ProviderError(m[1], m[2].trim());
    // A check constraint is the schema refusing the same class of thing the
    // procs refuse in words; name it so callers do not have to read pg codes.
    if (err?.code === "23514" && /provider_instances_name_shape/.test(raw)) {
        throw new ProviderError("PROVIDER_INVALID",
            "A provider name may use letters, numbers, dot, dash and underscore, and may not contain a colon.");
    }
    throw err;
}

export interface ProviderRow {
    name: string;
    typeId: string;
    class: ProviderClass;
    ownerUserId: number | null;
    ownerEmail: string | null;
    ownerDisplayName: string | null;
    baseUrl: string | null;
    allowancePct: number;
    holdUntilUtc: string | null;
    holdIndefinite: boolean;
    hasCredential: boolean;
    /** False for another person's provider, which an admin can see but not run. */
    usableByMe: boolean;
    systemUseEnabled: boolean;
    systemEligible: boolean;
    isClusterDefault: boolean;
    isMyDefault: boolean;
    isSystemDefault: boolean;
    ruleCount: number;
    createdAt: string;
}

export interface ProviderStatusRow {
    name: string;
    class: ProviderClass;
    allowancePct: number;
    holdUntilUtc: string | null;
    holdIndefinite: boolean;
    rules: BudgetRuleState[];
}

/**
 * One period's cell on the provider table, for one row.
 *
 * Four numbers, because the screen shows two of them at a time and must never
 * mix them up: `usedTokens / quotaTokens` is what everyone spent against the
 * limit, `yourUsedTokens / yourQuotaTokens` is what you spent against your
 * share of it.
 *
 * A null quota means no limit for that period. The used number beside it is
 * still real — the meter runs whether or not anybody capped it. A null
 * `yourUsedTokens` means nobody is signed in, which is not zero.
 */
export interface UsageGridCell {
    /** The limit that set this quota, or null when the period is uncapped. */
    ruleId: string | null;
    quotaTokens: number | null;
    usedTokens: number;
    yourQuotaTokens: number | null;
    yourUsedTokens: number | null;
    windowStartUtc: string;
    resetsAtUtc: string;
}

/**
 * One line of the provider table: a provider, or one model it has a limit on.
 * Both kinds carry the same three cells, so a model limit reads exactly like
 * the provider above it.
 */
export interface UsageGridRow {
    providerName: string;
    rowKind: "provider" | "model";
    /** '*' on a provider row; the qualified model reference on a model row. */
    scope: string;
    class: ProviderClass;
    allowancePct: number;
    holdUntilUtc: string | null;
    holdIndefinite: boolean;
    /** How many model rows follow this provider. Always 0 on a model row. */
    modelRowCount: number;
    /**
     * Yours to read as your own — your provider, or a shared one, which is
     * everyone's. False is somebody ELSE's personal provider, which only an
     * administrator ever sees: it has no share for you, so its `yourQuota`
     * cells are null rather than a headroom figure you cannot spend.
     */
    ownedByMe: boolean;
    /**
     * Yours to CHANGE: admin on a shared provider, owner on a personal one —
     * the same rule `cms_provider_assert_manage` enforces. The screen greys
     * out what this refuses instead of arming a control the server will
     * reject after the form is filled in.
     */
    manageable: boolean;
    /**
     * Whose provider this is, written out — the display name, or the email,
     * or "user <id>" for a sparse row. Null on a shared provider, which is
     * everybody's and has no owner to name.
     */
    ownerLabel: string | null;
    periods: { day: UsageGridCell; week: UsageGridCell; month: UsageGridCell };
}

export interface DefaultTuple {
    provider: string | null;
    model: string | null;
    reasoning: string | null;
    context: string | null;
}

export interface SystemAgentModelOverride extends DefaultTuple {
    agentId: string;
    updatedBy: number;
    updatedAt: string;
}

export interface ProviderDefaults {
    cluster: DefaultTuple;
    mine: DefaultTuple;
    system: DefaultTuple;
    systemUpdatedBy: number | null;
    systemUpdatedAt: string | null;
}

export interface LegacyProviderMigrationStatus {
    regularKeys: number;
    migratedRegularKeys: number;
    systemKeyPresent: boolean;
    systemKeyAdopted: boolean;
}

export interface SystemRestartRolloutState {
    agentId: string;
    operationId: string;
    targetModel: string;
    targetReasoning: string | null;
    targetContext: string | null;
    disposition: "complete" | "terminate" | "hard_delete";
    status: "in_progress" | "failed" | "complete";
    claimedAt: string;
    completedAt: string | null;
    lastError: string | null;
}

export interface PausedSessionRow {
    sessionId: string;
    title: string | null;
    model: string | null;
    ownerUserId: number | null;
    ownerEmail: string | null;
    state: string;
    pause: Record<string, unknown> | null;
    updatedAt: string;
}

export interface UsageFilters {
    days?: number;
    ownerUserId?: number | null;
    provider?: string | null;
    model?: string | null;
    sessionId?: string | null;
    chargeClass?: ChargeClass | null;
}

export interface SettleTurnInput {
    sessionId: string;
    turnIndex: number;
    providerName: string | null;
    modelQualified: string | null;
    ownerUserId: number | null;
    chargeClass: ChargeClass;
    agentId?: string | null;
    tokensInput?: number;
    tokensOutput?: number;
    tokensCacheRead?: number;
    tokensCacheWrite?: number;
}

/** What the runtime needs to actually talk to a provider's backend. */
export interface ProviderCredential {
    name: string;
    typeId: string;
    class: ProviderClass;
    ownerUserId: number | null;
    baseUrl: string | null;
    secretRef: Record<string, unknown>;
    systemUseEnabled?: boolean;
}

/**
 * What a caller may put in a credential, and what they may not.
 *
 * A credential that arrives in a request is a VALUE. The deployment's config
 * file may store a POINTER instead (`env:AZURE_KEY`, resolved against the
 * worker's own environment), and that indirection is safe only because the
 * deployment wrote it. Honouring it on a request let anyone with an account
 * name a variable — the cluster's API key, the database URL, anything the
 * worker holds — pair it with a base URL of their own, and have the worker
 * post that secret to them.
 *
 * So: one shape in, one shape stored. Every friendly spelling people
 * actually send (`{apiKey}`, `{githubToken}`, `{token}`, a bare string) is
 * accepted and stored as a literal under `value`. `ref` and `source` are
 * dropped, and a literal that looks like a pointer is refused outright
 * rather than silently stored as something that will never resolve.
 */
export function normalizeCallerSecret(
    input: Record<string, unknown> | string | null | undefined,
): Record<string, unknown> {
    const raw = typeof input === "string" ? { value: input } : (input ?? {});

    const isGithub = typeof raw.githubToken === "string" || raw.kind === "githubToken";
    const candidate = [raw.value, raw.apiKey, raw.githubToken, raw.token, raw.key]
        .find((v) => typeof v === "string" && v.length > 0);

    if (typeof candidate !== "string") {
        // A provider with no credential cannot run a single turn, and there
        // is no way to add one afterwards. Refusing here beats creating a
        // name that resolves to nothing and waits for ever.
        throw new ProviderError(
            "PROVIDER_INVALID",
            "A provider needs a credential: send the key itself, as apiKey for an API provider or githubToken for GitHub Copilot.",
        );
    }

    // Compared on a TRIMMED, case-folded copy: " Env:AZURE_KEY" is the same
    // pointer with a space in front of it, and a guard that misses it stores
    // a value that later resolves against the worker's own environment.
    if (candidate.trim().toLowerCase().startsWith("env:")) {
        throw new ProviderError(
            "PROVIDER_INVALID",
            "A credential must be the key itself, not a reference to one. Only the deployment's own configuration may point at an environment variable.",
        );
    }

    const apiVersion = typeof raw.apiVersion === "string" ? { apiVersion: raw.apiVersion } : {};
    return { kind: isGithub ? "githubToken" : "apiKey", value: candidate, ...apiVersion };
}

const iso = (v: any): string | null =>
    v === null || v === undefined ? null : (v instanceof Date ? v.toISOString() : String(v));

export class ProviderStore {
    constructor(private readonly pool: Pool, private readonly schema: string) {}

    private fn(name: string): string {
        return `"${this.schema}".${name}`;
    }

    private async call(sql: string, params: any[] = []): Promise<any[]> {
        try {
            const { rows } = await this.pool.query(sql, params);
            return rows;
        } catch (err) {
            return rethrow(err);
        }
    }

    // ── identity ─────────────────────────────────────────────────────

    /**
     * Principal → user id, WITHOUT creating the row. Everything here takes a
     * numeric actor; this is the only translation point, and it deliberately
     * returns null for someone who has never signed in rather than minting a
     * user as a side effect of a read.
     */
    async lookupUserId(principal: { provider: string; subject: string } | null | undefined): Promise<number | null> {
        if (!principal?.provider || !principal?.subject) return null;
        const rows = await this.call(
            `SELECT ${this.fn("cms_provider_user_id")}($1, $2) AS user_id`,
            [principal.provider, principal.subject]);
        const id = rows[0]?.user_id;
        return id === null || id === undefined ? null : Number(id);
    }

    /**
     * Who owns this session, and is it machinery? Settlement needs both, and
     * the turn activity carries neither — it knows a session id and a model
     * reference, nothing about people. Reading them here keeps the two facts
     * in the one place that already decides charging, rather than threading
     * a principal through the whole turn path so it can be re-derived.
     */
    async sessionChargeFacts(
        sessionId: string,
    ): Promise<{ ownerUserId: number | null; isSystem: boolean }> {
        const rows = await this.call(
            `SELECT so.user_id AS owner_user_id, COALESCE(ss.is_system, FALSE) AS is_system
               FROM "${this.schema}".sessions ss
               LEFT JOIN "${this.schema}".session_owners so ON so.session_id = ss.session_id
              WHERE ss.session_id = $1`,
            [sessionId]);
        const r = rows[0];
        return {
            ownerUserId: r?.owner_user_id === null || r?.owner_user_id === undefined
                ? null : Number(r.owner_user_id),
            isSystem: r?.is_system === true,
        };
    }

    // ── the runtime pair ─────────────────────────────────────────────

    /** The admission call. One round trip, made once per turn. */
    async checkTurn(sessionId: string, model?: string | null): Promise<TurnAdmission> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_check_turn")}($1, $2)`,
            [sessionId, model ?? null]);
        return toTurnAdmission(rows[0] ?? {});
    }

    /**
     * The next free settlement index for a session, across every lifetime
     * the ledger has seen. The ledger PK (session_id, turn_index) is the
     * exactly-once claim; a fresh orchestration for a RETAINED session id
     * (system restart) must count from here or settle silently drops its
     * spend as "already settled".
     */
    async nextLedgerTurnIndex(sessionId: string): Promise<number> {
        const rows = await this.call(
            `SELECT ${this.fn("cms_provider_next_turn_index")}($1) AS next`, [sessionId]);
        return Number(rows[0]?.next ?? 0);
    }

    /**
     * Advance the session's ledger base past every row the session id has,
     * so a fresh orchestration lifetime (system restart) settles on new
     * keys instead of silently colliding with the old lifetime's.
     */
    async bumpLedgerBase(sessionId: string): Promise<number> {
        const rows = await this.call(
            `SELECT ${this.fn("cms_provider_bump_ledger_base")}($1) AS base`, [sessionId]);
        return Number(rows[0]?.base ?? 0);
    }

    /** Settlement. Returns false when this turn was already settled. */
    async settleTurn(input: SettleTurnInput): Promise<boolean> {
        const rows = await this.call(
            `SELECT ${this.fn("cms_provider_settle_turn")}($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS first`,
            [
                input.sessionId, input.turnIndex, input.providerName ?? null,
                input.modelQualified ?? null, input.ownerUserId ?? null,
                input.chargeClass ?? "user", input.agentId ?? null,
                Math.max(0, Math.trunc(input.tokensInput ?? 0)),
                Math.max(0, Math.trunc(input.tokensOutput ?? 0)),
                Math.max(0, Math.trunc(input.tokensCacheRead ?? 0)),
                Math.max(0, Math.trunc(input.tokensCacheWrite ?? 0)),
            ]);
        return rows[0]?.first === true;
    }

    // ── reads ────────────────────────────────────────────────────────

    async listProviders(viewer: number | null, isAdmin: boolean): Promise<ProviderRow[]> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_list")}($1, $2)`, [viewer, isAdmin]);
        return rows.map((r) => ({
            name: r.name,
            typeId: r.type_id,
            class: r.class as ProviderClass,
            ownerUserId: r.owner_user_id === null ? null : Number(r.owner_user_id),
            ownerEmail: r.owner_email ?? null,
            ownerDisplayName: r.owner_display_name ?? null,
            baseUrl: r.base_url ?? null,
            allowancePct: Number(r.allowance_pct ?? 100),
            holdUntilUtc: iso(r.hold_until_utc),
            holdIndefinite: r.hold_indefinite === true,
            hasCredential: r.has_credential === true,
            usableByMe: r.usable_by_me === true,
            systemUseEnabled: r.system_use_enabled === true,
            systemEligible: r.system_eligible === true,
            isClusterDefault: r.is_cluster_default === true,
            isMyDefault: r.is_my_default === true,
            isSystemDefault: r.is_system_default === true,
            ruleCount: Number(r.rule_count ?? 0),
            createdAt: iso(r.created_at) ?? "",
        }));
    }

    async providerStatus(
        viewer: number | null, isAdmin: boolean, names?: string[] | null,
    ): Promise<ProviderStatusRow[]> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_status")}($1, $2, $3)`,
            [viewer, isAdmin, names && names.length ? names : null]);
        return rows.map((r) => ({
            name: r.name,
            class: r.class as ProviderClass,
            allowancePct: Number(r.allowance_pct ?? 100),
            holdUntilUtc: iso(r.hold_until_utc),
            holdIndefinite: r.hold_indefinite === true,
            rules: (Array.isArray(r.rules) ? r.rules : []).map((x: any) => ({
                ruleId: String(x.ruleId),
                providerName: r.name,
                period: x.period as BudgetPeriod,
                modelQualified: x.modelQualified ?? null,
                limitTokens: Number(x.limitTokens ?? 0),
                usedTokens: Number(x.usedTokens ?? 0),
                ceilingTokens: x.ceilingTokens === null || x.ceilingTokens === undefined
                    ? null : Number(x.ceilingTokens),
                yourUsedTokens: x.yourUsedTokens === null || x.yourUsedTokens === undefined
                    ? null : Number(x.yourUsedTokens),
                windowStartUtc: String(x.windowStartUtc),
                resetsAtUtc: String(x.resetsAtUtc),
            })),
        }));
    }

    /**
     * Everything the provider table draws, in one call.
     *
     * Rows arrive in the order the table renders them: shared providers
     * first, then your own, each immediately followed by its model rows. The
     * caller does not sort and does not make a second call per provider.
     */
    async usageGrid(viewer: number | null, isAdmin: boolean): Promise<UsageGridRow[]> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_usage_grid")}($1, $2)`, [viewer, isAdmin]);
        const cell = (x: any): UsageGridCell => ({
            ruleId: x?.ruleId ?? null,
            quotaTokens: x?.quotaTokens === null || x?.quotaTokens === undefined
                ? null : Number(x.quotaTokens),
            usedTokens: Number(x?.usedTokens ?? 0),
            yourQuotaTokens: x?.yourQuotaTokens === null || x?.yourQuotaTokens === undefined
                ? null : Number(x.yourQuotaTokens),
            // Null stays null. Nobody signed in is not the same fact as zero
            // spent, and the table says the two differently.
            yourUsedTokens: x?.yourUsedTokens === null || x?.yourUsedTokens === undefined
                ? null : Number(x.yourUsedTokens),
            windowStartUtc: String(x?.windowStartUtc ?? ""),
            resetsAtUtc: String(x?.resetsAtUtc ?? ""),
        });
        return rows.map((r) => ({
            providerName: r.provider_name,
            rowKind: r.row_kind as "provider" | "model",
            scope: r.scope,
            class: r.class as ProviderClass,
            allowancePct: Number(r.allowance_pct ?? 100),
            holdUntilUtc: iso(r.hold_until_utc),
            holdIndefinite: r.hold_indefinite === true,
            modelRowCount: Number(r.model_row_count ?? 0),
            ownedByMe: r.owned_by_me !== false,
            manageable: r.manageable === true,
            ownerLabel: r.owner_label ?? null,
            periods: {
                day: cell(r.periods?.day),
                week: cell(r.periods?.week),
                month: cell(r.periods?.month),
            },
        }));
    }

    /**
     * The credential the runtime should use, resolved by NAME in the session
     * owner's namespace — the same resolution the gate made, so accounting
     * and the actual API call can never name different credentials.
     */
    /**
     * Every provider with its credential, for the worker's own runtime
     * catalog. Not a viewer-scoped read and never shown to anyone: a worker
     * runs turns for everybody, and what a person may spend from is settled
     * by the admission gate long before a credential is reached for.
     */
    async allCredentials(): Promise<ProviderCredential[]> {
        const rows = await this.call(
                `SELECT name, type_id, class, owner_user_id, base_url, secret_ref, system_use_enabled
                    FROM "${this.schema}".provider_instances ORDER BY created_at, name`);
        return rows.map((r) => ({
            name: r.name,
            typeId: r.type_id,
            class: r.class as ProviderClass,
            ownerUserId: r.owner_user_id === null ? null : Number(r.owner_user_id),
            baseUrl: r.base_url ?? null,
            secretRef: (r.secret_ref ?? {}) as Record<string, unknown>,
            systemUseEnabled: r.system_use_enabled === true,
        }));
    }

    async getCredential(name: string, viewer: number | null): Promise<ProviderCredential | null> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_in_namespace")}($1, $2)`, [name, viewer]);
        const r = rows[0];
        if (!r) return null;
        return {
            name: r.name,
            typeId: r.type_id,
            class: r.class as ProviderClass,
            ownerUserId: r.owner_user_id === null ? null : Number(r.owner_user_id),
            baseUrl: r.base_url ?? null,
            secretRef: (r.secret_ref ?? {}) as Record<string, unknown>,
        };
    }

    async getSystemCredential(name: string): Promise<ProviderCredential | null> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_for_system")}($1)`, [name]);
        const r = rows[0];
        if (!r) return null;
        return {
            name: r.name,
            typeId: r.type_id,
            class: r.class as ProviderClass,
            ownerUserId: r.owner_user_id === null ? null : Number(r.owner_user_id),
            baseUrl: r.base_url ?? null,
            secretRef: (r.secret_ref ?? {}) as Record<string, unknown>,
            systemUseEnabled: true,
        };
    }

    async getDefaults(actor: number | null): Promise<ProviderDefaults> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_get_defaults")}($1)`, [actor]);
        const r = rows[0] ?? {};
        return {
            cluster: {
                provider: r.cluster_provider ?? null, model: r.cluster_model ?? null,
                reasoning: r.cluster_reasoning ?? null, context: r.cluster_context ?? null,
            },
            mine: {
                provider: r.my_provider ?? null, model: r.my_model ?? null,
                reasoning: r.my_reasoning ?? null, context: r.my_context ?? null,
            },
            system: {
                provider: r.system_provider ?? null, model: r.system_model ?? null,
                reasoning: r.system_reasoning ?? null, context: r.system_context ?? null,
            },
            systemUpdatedBy: r.system_updated_by === null || r.system_updated_by === undefined
                ? null : Number(r.system_updated_by),
            systemUpdatedAt: iso(r.system_updated_at),
        };
    }

    async listSystemAgentModels(): Promise<SystemAgentModelOverride[]> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_list_system_agent_models")}()`);
        return rows.map((r) => ({
            agentId: r.agent_id,
            provider: r.provider_name,
            model: r.model_qualified,
            reasoning: r.reasoning_effort ?? null,
            context: r.context_tier ?? null,
            updatedBy: Number(r.updated_by),
            updatedAt: iso(r.updated_at) ?? "",
        }));
    }

    async listPaused(viewer: number | null, isAdmin: boolean, limit = 100): Promise<PausedSessionRow[]> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_list_paused")}($1, $2, $3)`, [viewer, isAdmin, limit]);
        return rows.map((r) => ({
            sessionId: r.session_id,
            title: r.title ?? null,
            model: r.model ?? null,
            ownerUserId: r.owner_user_id === null ? null : Number(r.owner_user_id),
            ownerEmail: r.owner_email ?? null,
            state: r.state,
            pause: r.pause_state ?? null,
            updatedAt: iso(r.updated_at) ?? "",
        }));
    }

    /** Which sessions are waiting on this provider — the wake query. */
    async pausedFor(name: string): Promise<string[]> {
        const rows = await this.call(
            `SELECT session_id FROM ${this.fn("cms_provider_paused_for")}($1)`, [name]);
        return rows.map((r) => r.session_id);
    }

    // ── usage reporting ──────────────────────────────────────────────

    private usageArgs(viewer: number | null, isAdmin: boolean, f: UsageFilters): any[] {
        return [
            viewer, isAdmin, f.days ?? 7, f.ownerUserId ?? null, f.provider ?? null,
            f.model ?? null, f.sessionId ?? null, f.chargeClass ?? null,
        ];
    }

    async usageTotals(viewer: number | null, isAdmin: boolean, f: UsageFilters = {}) {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_usage_totals")}($1,$2,$3,$4,$5,$6,$7,$8)`,
            this.usageArgs(viewer, isAdmin, f));
        const r = rows[0] ?? {};
        return {
            tokensTotal: Number(r.tokens_total ?? 0),
            turns: Number(r.turns ?? 0),
            sessions: Number(r.sessions ?? 0),
        };
    }

    async usageDaily(viewer: number | null, isAdmin: boolean, f: UsageFilters = {}) {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_usage_daily")}($1,$2,$3,$4,$5,$6,$7,$8)`,
            this.usageArgs(viewer, isAdmin, f));
        return rows.map((r) => ({
            dayUtc: iso(r.day_utc)?.slice(0, 10) ?? "",
            tokensTotal: Number(r.tokens_total ?? 0),
            turns: Number(r.turns ?? 0),
        }));
    }

    async usageBreakdown(
        viewer: number | null, isAdmin: boolean,
        dimension: "session" | "user" | "provider" | "model" | "agent",
        f: UsageFilters = {}, limit = 40,
    ) {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_usage_breakdown")}($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [...this.usageArgs(viewer, isAdmin, f), dimension, limit]);
        return rows.map((r) => ({
            key: r.key,
            label: r.label,
            tokensTotal: Number(r.tokens_total ?? 0),
            turns: Number(r.turns ?? 0),
        }));
    }

    // ── management ───────────────────────────────────────────────────

    async createProvider(input: {
        name: string; typeId: string; class: ProviderClass;
        ownerUserId?: number | null; secretRef?: Record<string, unknown> | null; baseUrl?: string | null;
    }, actor: number | null, isAdmin: boolean): Promise<{ name: string; typeId: string; class: ProviderClass }> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_create")}($1,$2,$3,$4,$5,$6,$7,$8)`,
            [input.name, input.typeId, input.class, input.ownerUserId ?? null,
                JSON.stringify(normalizeCallerSecret(input.secretRef)),
                input.baseUrl ?? null, actor, isAdmin]);
        const r = rows[0] ?? {};
        return { name: r.name, typeId: r.type_id, class: r.class };
    }

    /** Returns how many sessions now name a provider that no longer exists. */
    async deleteProvider(name: string, actor: number | null, isAdmin: boolean): Promise<number> {
        const rows = await this.call(
            `SELECT ${this.fn("cms_provider_delete")}($1,$2,$3) AS waiting`, [name, actor, isAdmin]);
        return Number(rows[0]?.waiting ?? 0);
    }

    async clearRoutingDependencies(
        name: string, actor: number | null, isAdmin: boolean,
    ): Promise<{ clusterDefault: number; systemDefault: number; userDefaults: number; systemOverrides: number }> {
        const rows = await this.call(
            `SELECT ${this.fn("cms_provider_clear_routing_dependencies")}($1,$2,$3) AS result`,
            [name, actor, isAdmin]);
        const result = rows[0]?.result ?? {};
        return {
            clusterDefault: Number(result.clusterDefault ?? 0),
            systemDefault: Number(result.systemDefault ?? 0),
            userDefaults: Number(result.userDefaults ?? 0),
            systemOverrides: Number(result.systemOverrides ?? 0),
        };
    }

    async claimSystemRestart(input: {
        agentId: string; operationId: string; claimId: string;
        model: string; reasoning?: string | null; context?: string | null;
        disposition: "complete" | "terminate" | "hard_delete";
    }): Promise<"claimed" | "busy" | "complete"> {
        const rows = await this.call(
            `SELECT ${this.fn("cms_provider_claim_system_restart")}($1,$2,$3,$4,$5,$6,$7) AS result`,
            [input.agentId, input.operationId, input.claimId, input.model,
                input.reasoning ?? null, input.context ?? null, input.disposition]);
        return rows[0]?.result;
    }

    async finishSystemRestart(agentId: string, claimId: string, error?: string | null): Promise<boolean> {
        const rows = await this.call(
            `SELECT ${this.fn("cms_provider_finish_system_restart")}($1,$2,$3) AS finished`,
            [agentId, claimId, error ?? null]);
        return rows[0]?.finished === true;
    }

    async getSystemRestart(agentId: string): Promise<SystemRestartRolloutState | null> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_get_system_restart")}($1)`, [agentId]);
        const row = rows[0];
        if (!row) return null;
        return {
            agentId: row.agent_id,
            operationId: row.operation_id,
            targetModel: row.target_model,
            targetReasoning: row.target_reasoning ?? null,
            targetContext: row.target_context ?? null,
            disposition: row.disposition,
            status: row.status,
            claimedAt: iso(row.claimed_at) ?? "",
            completedAt: iso(row.completed_at),
            lastError: row.last_error ?? null,
        };
    }

    async setSystemUse(
        name: string, enabled: boolean, actor: number | null, isAdmin: boolean,
    ): Promise<boolean> {
        const rows = await this.call(
            `SELECT ${this.fn("cms_provider_set_system_use")}($1,$2,$3,$4) AS enabled`,
            [name, enabled, actor, isAdmin]);
        return rows[0]?.enabled === true;
    }

    /**
     * Save a limit. Nothing is seeded and nothing is reset — the meter this
     * limit reads has been counting since the provider's first turn.
     *
     * `seededTokens` is what the new limit ALREADY counts in the current
     * period: a read of that meter, so the editor can warn that sessions will
     * pause on their next turn. The name is the old one, kept because four
     * other surfaces send it over the wire.
     */
    async setLimit(input: {
        name: string; period: BudgetPeriod; modelQualified?: string | null; limitTokens: number;
    }, actor: number | null, isAdmin: boolean): Promise<{ ruleId: string; seededTokens: number }> {
        const ruleId = `pbr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_set_limit")}($1,$2,$3,$4,$5,$6,$7)`,
            [input.name, input.period, input.modelQualified ?? null, input.limitTokens, ruleId, actor, isAdmin]);
        const r = rows[0] ?? {};
        return { ruleId: r.rule_id, seededTokens: Number(r.seeded_tokens ?? 0) };
    }

    async removeLimit(
        name: string, period: BudgetPeriod, modelQualified: string | null,
        actor: number | null, isAdmin: boolean,
    ): Promise<boolean> {
        const rows = await this.call(
            `SELECT ${this.fn("cms_provider_remove_limit")}($1,$2,$3,$4,$5) AS removed`,
            [name, period, modelQualified ?? null, actor, isAdmin]);
        return rows[0]?.removed === true;
    }

    async setAllowance(name: string, pct: number, actor: number | null, isAdmin: boolean): Promise<number> {
        const rows = await this.call(
            `SELECT ${this.fn("cms_provider_set_allowance")}($1,$2::smallint,$3,$4) AS pct`,
            [name, pct, actor, isAdmin]);
        return Number(rows[0]?.pct ?? pct);
    }

    async setHold(
        name: string, opts: { untilUtc?: string | null; indefinite?: boolean },
        actor: number | null, isAdmin: boolean,
    ): Promise<void> {
        await this.call(
            `SELECT ${this.fn("cms_provider_set_hold")}($1,$2,$3,$4,$5)`,
            [name, opts.untilUtc ?? null, opts.indefinite === true, actor, isAdmin]);
    }

    async setClusterDefault(t: DefaultTuple, isAdmin: boolean): Promise<void> {
        await this.call(
            `SELECT ${this.fn("cms_provider_set_cluster_default")}($1,$2,$3,$4,$5)`,
            [t.provider, t.model, t.reasoning ?? null, t.context ?? null, isAdmin]);
    }

    async setUserDefault(actor: number | null, t: DefaultTuple): Promise<void> {
        await this.call(
            `SELECT ${this.fn("cms_provider_set_user_default")}($1,$2,$3,$4,$5)`,
            [actor, t.provider, t.model, t.reasoning ?? null, t.context ?? null]);
    }

    async setSystemDefault(
        actor: number | null, isAdmin: boolean, t: DefaultTuple,
    ): Promise<void> {
        await this.call(
            `SELECT ${this.fn("cms_provider_set_system_default")}($1,$2,$3,$4,$5,$6)`,
            [t.provider, t.model, t.reasoning ?? null, t.context ?? null, actor, isAdmin]);
    }

    async setSystemAgentModel(
        agentId: string, actor: number | null, isAdmin: boolean, t: DefaultTuple,
    ): Promise<void> {
        await this.call(
            `SELECT ${this.fn("cms_provider_set_system_agent_model")}($1,$2,$3,$4,$5,$6,$7)`,
            [agentId, t.provider, t.model, t.reasoning ?? null, t.context ?? null, actor, isAdmin]);
    }

    async clearSystemAgentModel(
        agentId: string, actor: number | null, isAdmin: boolean,
    ): Promise<boolean> {
        const rows = await this.call(
            `SELECT ${this.fn("cms_provider_clear_system_agent_model")}($1,$2,$3) AS cleared`,
            [agentId, actor, isAdmin]);
        return rows[0]?.cleared === true;
    }

    async adoptLegacySystemGitHubKey(
        name: string, actor: number | null, isAdmin: boolean,
    ): Promise<{ name: string; typeId: string; class: ProviderClass; ownerUserId: number | null }> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_adopt_system_github_key")}($1,$2,$3,$4)`,
            [name, name, actor, isAdmin]);
        const row = rows[0] ?? {};
        return {
            name: row.name,
            typeId: row.type_id,
            class: row.class as ProviderClass,
            ownerUserId: row.owner_user_id === null || row.owner_user_id === undefined
                ? null : Number(row.owner_user_id),
        };
    }

    async getLegacyKeyMigrationStatus(): Promise<LegacyProviderMigrationStatus> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_legacy_key_migration_status")}()`);
        const row = rows[0] ?? {};
        return {
            regularKeys: Number(row.regular_keys ?? 0),
            migratedRegularKeys: Number(row.migrated_regular_keys ?? 0),
            systemKeyPresent: row.system_key_present === true,
            systemKeyAdopted: row.system_key_adopted === true,
        };
    }

    /**
     * The deployment seed. Safe to call on every boot: the claim is atomic
     * and only the first caller on a fresh cluster does anything.
     */
    async bootstrap(
        instances: Array<{ name: string; typeId: string; secretRef?: Record<string, unknown>; baseUrl?: string | null }>,
        defaults: DefaultTuple | null,
    ): Promise<{ claimed: boolean; created: number }> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_provider_bootstrap")}($1::jsonb, $2::jsonb)`,
            [JSON.stringify(instances ?? []), defaults ? JSON.stringify(defaults) : null]);
        const r = rows[0] ?? {};
        return { claimed: r.claimed === true, created: Number(r.created ?? 0) };
    }
}
