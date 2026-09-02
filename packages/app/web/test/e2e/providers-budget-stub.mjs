// Fixtures for the Providers & Budgets surface tests.
//
// The shared stub (stub-server.mjs) answers the portal's boot and session
// routes but knows nothing about the provider operations: they fall through to
// its last-path-segment heuristic and come back as `{ok:true}` with no result,
// so the surface renders as an empty namespace with no usage and nothing
// waiting. That is enough for no test at all.
//
// This WRAPS the shared stub rather than editing it: the provider routes are
// answered here and everything else is proxied to the shared stub over http.
// Nothing in the shared harness changes, so several agents can run their
// suites at once.
//
// The routes answered here (API_PREFIX is /api/v1):
//   GET    /providers/usage-grid                      getProviderUsageGrid
//   GET    /providers                                 listProviders
//   GET    /providers/paused                          listPausedSessions
//   GET    /providers/usage                           getProviderUsage
//   GET    /defaults                                  getDefaults
//   GET    /models                                    listModels
//   POST   /management/providers | /me/providers      create
//   DELETE /management/providers/:n | /me/providers/:n delete
//   PUT    /providers/:name/limit                     setProviderLimit
//   DELETE /providers/:name/limit                     removeProviderLimit
//   PUT    /management/providers/:name/allowance      setProviderAllowance
//   PUT    /management/providers/:name/hold           setProviderHold
//   PUT    /management/defaults | /me/default         set a default
//   GET    /management/sessions, /sessions/:id        sessions on THESE providers
//   GET    /bootstrap                                 the viewer's role
import http from "node:http";
import { startStubServer } from "./stub-server.mjs";

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** The UTC day key the chart draws for `back` days ago — the selector's own. */
const dayKey = (back, nowMs = Date.now()) => new Date(nowMs - (back * DAY)).toISOString().slice(0, 10);

/**
 * One period's cell of the table, as `cms_provider_usage_grid` sends it.
 *
 * Four numbers, and the screen shows two at a time: `used / quota` is what
 * everyone spent against the limit, `yourUsed / yourQuota` is what the viewer
 * spent against their share of it. A null quota is no limit for that period —
 * and the used figure beside it is still real, which is the whole point of
 * keying a meter by what it measures instead of by a limit's id.
 */
// The parts of each used figure (0069, corrected in 0070): used = input +
// output, and the cache figures are parts OF the input — 70% of it served
// from the cache, 5% written to it — so a test can check both identities.
const split = (total, prefix = "") => {
    if (total == null) return {};
    const input = Math.round(total * 0.98);
    const output = total - input;
    const cacheRead = Math.round(input * 0.70);
    const cacheWrite = Math.round(input * 0.05);
    const k = (name) => (prefix ? prefix + name[0].toUpperCase() + name.slice(1) : name);
    return { [k("inputTokens")]: input, [k("outputTokens")]: output, [k("cacheReadTokens")]: cacheRead, [k("cacheWriteTokens")]: cacheWrite };
};
const cell = ({ used, quota = null, yourUsed, yourQuota = null }, resetsAtUtc, windowStartUtc) => ({
    ruleId: quota == null ? null : `rule-${resetsAtUtc}-${quota}`,
    quotaTokens: quota,
    usedTokens: used,
    yourQuotaTokens: yourQuota,
    yourUsedTokens: yourUsed,
    ...split(used),
    ...split(yourUsed, "your"),
    windowStartUtc,
    resetsAtUtc,
});

/**
 * The table, as one read.
 *
 * Four providers and four model rows, chosen so every rule in
 * docs/proposals/providers-and-budgets-meters.md has exactly one row that
 * exercises it:
 *
 *   copilot-shared  shared, no allowance. Its Day is OVER its limit and its
 *                   Week has NO limit at all — 48.0M spent against ∞, which is
 *                   the number the old shape could not hold.
 *   azure-prod      shared, 20% each. The provider's figures and the viewer's
 *                   are deliberately 35× apart (18.0M/20.0M against
 *                   512.0K/4.0M), so a surface that printed one for the other
 *                   would be printing a number nobody could act on. It also
 *                   carries two limited and two uncapped model rows.
 *   paused-vendor   shared, on hold, not one limit anywhere — three ∞ cells
 *                   with real usage beside them.
 *   my-sandbox      the viewer's own. No `shared` mark, because that is the
 *                   ordinary case.
 *
 * The model rows follow azure-prod, in the order the server returns them.
 * `azure-prod:gpt-5.4` is OVER its own daily limit while azure-prod above it
 * still has room — one grid is what makes that visible.
 */
export function gridFixture(nowMs = Date.now()) {
    const dayStart = new Date(nowMs - (21 * HOUR)).toISOString();
    const dayReset = new Date(nowMs + (3 * HOUR)).toISOString();
    const weekStart = new Date(nowMs - (5 * DAY)).toISOString();
    const weekReset = new Date(nowMs + (2 * DAY)).toISOString();
    const monthStart = new Date(nowMs - (20 * DAY)).toISOString();
    const monthReset = new Date(nowMs + (9 * DAY)).toISOString();
    const periods = (day, week, month) => ({
        day: cell(day, dayReset, dayStart),
        week: cell(week, weekReset, weekStart),
        month: cell(month, monthReset, monthStart),
    });
    const base = {
        rowKind: "provider", scope: "*", class: "shared",
        allowancePct: 100, holdUntilUtc: null, holdIndefinite: false, modelRowCount: 0,
        // Whose row it is, and whether the viewer may change it — the two
        // facts cms_provider_usage_grid answers so the screen never arms a
        // control the database will refuse. The default fixture is an ADMIN's
        // view, so every shared row is manageable.
        ownedByMe: true, manageable: true, ownerLabel: null,
    };
    return [
        {
            ...base, providerName: "copilot-shared",
            periods: periods(
                // 102% — the turn that crosses a limit completes and is
                // charged, and only the NEXT one pauses.
                { used: 10_240_000, quota: 10_000_000, yourUsed: 2_400_000, yourQuota: 10_000_000 },
                { used: 48_000_000, yourUsed: 9_600_000 },
                { used: 96_000_000, quota: 200_000_000, yourUsed: 20_000_000, yourQuota: 200_000_000 },
            ),
        },
        {
            ...base, providerName: "azure-prod", allowancePct: 20, modelRowCount: 4,
            periods: periods(
                { used: 18_000_000, quota: 20_000_000, yourUsed: 512_000, yourQuota: 4_000_000 },
                { used: 31_000_000, yourUsed: 1_200_000 },
                { used: 40_000_000, quota: 100_000_000, yourUsed: 3_000_000, yourQuota: 20_000_000 },
            ),
        },
        {
            ...base, providerName: "azure-prod", rowKind: "model", scope: "azure-prod:gpt-5.4",
            allowancePct: 20,
            periods: periods(
                // Over its limit in BOTH readings, while azure-prod above it
                // is at 90% and still has room.
                { used: 5_400_000, quota: 5_000_000, yourUsed: 1_200_000, yourQuota: 1_000_000 },
                { used: 12_000_000, yourUsed: 2_000_000 },
                { used: 20_000_000, quota: 60_000_000, yourUsed: 4_000_000, yourQuota: 12_000_000 },
            ),
        },
        {
            ...base, providerName: "azure-prod", rowKind: "model", scope: "azure-prod:gpt-5.4-mini",
            allowancePct: 20,
            periods: periods(
                { used: 300_000, quota: 2_000_000, yourUsed: 60_000, yourQuota: 400_000 },
                { used: 900_000, yourUsed: 180_000 },
                { used: 4_000_000, yourUsed: 800_000 },
            ),
        },
        {
            ...base, providerName: "azure-prod", rowKind: "model", scope: "azure-prod:gpt-5.6-luna",
            allowancePct: 20,
            periods: periods(
                { used: 2_100_000, yourUsed: 420_000 },
                { used: 6_400_000, yourUsed: 1_280_000 },
                { used: 11_000_000, yourUsed: 2_200_000 },
            ),
        },
        {
            ...base, providerName: "azure-prod", rowKind: "model", scope: "azure-prod:gpt-5.6-sol",
            allowancePct: 20,
            periods: periods(
                { used: 1_400_000, yourUsed: 280_000 },
                { used: 4_100_000, yourUsed: 820_000 },
                { used: 8_000_000, yourUsed: 1_600_000 },
            ),
        },
        {
            ...base, providerName: "paused-vendor", holdIndefinite: true,
            periods: periods(
                { used: 800_000, yourUsed: 120_000 },
                { used: 2_600_000, yourUsed: 400_000 },
                { used: 9_000_000, yourUsed: 1_500_000 },
            ),
        },
        {
            ...base, providerName: "my-sandbox", class: "personal", ownerLabel: "Ada Admin",
            periods: periods(
                { used: 12_000, yourUsed: 12_000 },
                { used: 840_000, quota: 5_000_000, yourUsed: 840_000, yourQuota: 5_000_000 },
                { used: 3_200_000, yourUsed: 3_200_000 },
            ),
        },
    ];
}

/** A hold with an end time, so the countdown spelling has something to print. */
export function timedHoldRow(nowMs = Date.now(), hoursOut = 3) {
    const [row] = gridFixture(nowMs).filter((r) => r.providerName === "paused-vendor");
    return {
        ...row, providerName: "timed-vendor",
        holdIndefinite: false, holdUntilUtc: new Date(nowMs + (hoursOut * HOUR)).toISOString(),
    };
}

/**
 * What `listProviders` sends. The table does not read it; the sheets do, for
 * the provider TYPE each name is an instance of.
 */
export const PROVIDERS = [
    {
        name: "copilot-shared", typeId: "github-copilot", class: "shared",
        ownerUserId: null, baseUrl: null, hasCredential: true, usableByMe: true,
        systemUseEnabled: false, systemEligible: true,
        isClusterDefault: true, isMyDefault: false, isSystemDefault: false,
    },
    {
        name: "azure-prod", typeId: "azure-openai", class: "shared",
        ownerUserId: null, baseUrl: "https://azure-prod.example.invalid",
        hasCredential: true, usableByMe: true, systemUseEnabled: false, systemEligible: true,
        isClusterDefault: false, isMyDefault: false, isSystemDefault: false,
    },
    {
        name: "paused-vendor", typeId: "azure-openai", class: "shared",
        ownerUserId: null, baseUrl: null, hasCredential: true, usableByMe: true,
        systemUseEnabled: false, systemEligible: true,
        isClusterDefault: false, isMyDefault: false, isSystemDefault: false,
    },
    {
        name: "my-sandbox", typeId: "azure-openai", class: "personal",
        ownerUserId: 9189, ownerEmail: "ada@dev.local", ownerDisplayName: "Ada Admin",
        baseUrl: null, hasCredential: true, usableByMe: true,
        systemUseEnabled: true, systemEligible: true,
        isClusterDefault: false, isMyDefault: true, isSystemDefault: true,
    },
];

/**
 * Three waiting sessions under two reasons — two on copilot-shared, one on
 * azure-prod. No single provider accounts for all of them, so the line above
 * the table counts them without naming one: naming one of two causes sends the
 * reader to the wrong row.
 */
export function pausedFixture(nowMs = Date.now()) {
    const resetsAtUtc = new Date(nowMs + (3 * HOUR)).toISOString();
    const limitPause = {
        kind: "limit", provider: "copilot-shared", period: "day", modelQualified: null,
        limitTokens: 10_000_000, usedTokens: 10_240_000, resetsAtUtc,
    };
    return [
        {
            sessionId: "11111110-2222-3333-4444-555555555550", title: "Nightly triage",
            model: "copilot-shared:claude-sonnet-5", ownerUserId: 9189, ownerEmail: "ada@dev.local",
            state: "budget_paused", pause: limitPause, updatedAt: new Date(nowMs - 60_000).toISOString(),
        },
        {
            sessionId: "11111111-2222-3333-4444-555555555551", title: "Release notes",
            model: "copilot-shared:claude-sonnet-5", ownerUserId: 8633, ownerEmail: "bob@dev.local",
            state: "budget_paused", pause: limitPause, updatedAt: new Date(nowMs - 90_000).toISOString(),
        },
        {
            sessionId: "11111112-2222-3333-4444-555555555552", title: "Cost review",
            model: "azure-prod:gpt-5.4", ownerUserId: 9189, ownerEmail: "ada@dev.local",
            state: "budget_paused",
            pause: {
                kind: "allowance", provider: "azure-prod", period: "day",
                ceilingTokens: 4_000_000, yourUsedTokens: 4_100_000, resetsAtUtc,
            },
            updatedAt: new Date(nowMs - 120_000).toISOString(),
        },
    ];
}

/** Only the copilot-shared pair: ONE cause, so the line may name it. */
export function oneCausePausedFixture(nowMs = Date.now()) {
    return pausedFixture(nowMs).filter((row) => row.pause?.provider === "copilot-shared");
}

/** One session waiting on a name that no longer resolves — a different remedy. */
export function noProviderPausedFixture(nowMs = Date.now()) {
    return [{
        sessionId: "11111113-2222-3333-4444-555555555553", title: "Orphaned run",
        model: "retired-vendor:gpt-5.4", ownerUserId: 9189, ownerEmail: "ada@dev.local",
        state: "budget_paused",
        pause: { kind: "no_provider", provider: "retired-vendor", resetsAtUtc: null },
        updatedAt: new Date(nowMs - 30_000).toISOString(),
    }];
}

export const DEFAULTS = {
    cluster: { provider: "copilot-shared", model: "copilot-shared:claude-sonnet-5", reasoning: null, context: null },
    mine: { provider: "my-sandbox", model: "my-sandbox:gpt-5.4", reasoning: null, context: null },
    system: { provider: "my-sandbox", model: "my-sandbox:gpt-5.4", reasoning: null, context: null },
};

export const MODEL_DEFAULTS = {
    userSession: {
        configured: DEFAULTS.mine,
        effective: { provider: "my-sandbox", model: "my-sandbox:gpt-5.4", reasoningEffort: null, contextTier: null, source: "user_default" },
    },
    clusterSession: {
        configured: DEFAULTS.cluster,
        effective: { provider: "copilot-shared", model: "copilot-shared:claude-sonnet-5", reasoningEffort: null, contextTier: null, source: "cluster_default" },
    },
    system: {
        configured: DEFAULTS.system,
        effective: { provider: "my-sandbox", model: "my-sandbox:gpt-5.4", reasoningEffort: null, contextTier: null, source: "system_default" },
    },
    systemOverrides: [{
        agentId: "sweeper", provider: "copilot-shared", model: "copilot-shared:claude-sonnet-5",
        reasoning: null, context: null, updatedBy: 9189, updatedAt: "2026-08-22T00:00:00.000Z",
    }],
};

// listModels is flat on the web transport. `providerId` is the provider TYPE,
// not a provider: a provider is an instance of a type with a name of its own.
export const MODELS = [
    { modelName: "gpt-5.4", providerId: "azure-openai", providerType: "azure-openai" },
    { modelName: "gpt-5.4-mini", providerId: "azure-openai", providerType: "azure-openai" },
    { modelName: "claude-sonnet-5", providerId: "github-copilot", providerType: "github-copilot" },
];

// Sessions whose models name THESE providers. Their ids are the ones
// pausedFixture stops, and their status is "waiting" — which is exactly what
// this deployment publishes on a stopped session. The REASON is not on the
// row: it is only in listPausedSessions, and joining the two is what makes a
// row say "paused · limit" instead of nothing at all.
export const SESSIONS = [
    { index: 0, title: "Nightly triage", model: "copilot-shared:claude-sonnet-5" },
    { index: 1, title: "Release notes", model: "copilot-shared:claude-sonnet-5" },
    { index: 2, title: "Cost review", model: "azure-prod:gpt-5.4" },
].map(({ index, title, model }) => ({
    viewerGroupId: null,
    sessionId: `1111111${index}-2222-3333-4444-55555555555${index}`,
    title,
    status: "waiting",
    model,
    agentId: null,
    isSystem: false,
    owner: { provider: "dev", subject: "ada", email: "ada@dev.local", displayName: "Ada Admin" },
    parentSessionId: null,
    createdAt: 1785000000000,
    updatedAt: 1785000000000 + index,
    contextUsage: { currentTokens: 20_000, tokenLimit: 200_000 },
}));

/**
 * Nine spending days inside the last fourteen, so the chart's window has idle
 * days in it too.
 *
 * my-sandbox is missing on purpose: the report omits a provider that spent
 * nothing in the range, which is what lets the chart tell "spent nothing"
 * apart from "we do not hold the answer".
 */
const DAILY_BY_PROVIDER = {
    "copilot-shared": [84_247, 11_817_116, 1_154_033, 8_411_494, 1_821_316, 3_532_305, 6_493_431, 140_179, 1_711_228],
    "azure-prod": [412_000, 2_900_000, 1_050_000, 3_800_000, 620_000, 2_100_000, 4_400_000, 980_000, 1_240_000],
    "paused-vendor": [40_000, 120_000, 60_000, 210_000, 15_000, 90_000, 130_000, 55_000, 80_000],
};

/**
 * One MODEL's days, which are a fraction of its provider's.
 *
 * Deliberately far from the provider's own numbers, so a chart that ignored
 * the model filter and drew the whole provider is visibly wrong rather than
 * plausibly wrong.
 */
const DAILY_BY_MODEL = {
    "azure-prod:gpt-5.4": [61_000, 240_000, 88_000, 310_000, 52_000, 175_000, 366_000, 81_000, 103_000],
    "azure-prod:gpt-5.4-mini": [9_000, 31_000, 12_000, 44_000, 7_000, 22_000, 48_000, 11_000, 14_000],
    "azure-prod:gpt-5.6-luna": [21_000, 54_000, 80_000, 110_000, 72_000, 95_000, 130_000, 160_000, 190_000],
    "azure-prod:gpt-5.6-sol": [18_000, 37_000, 42_000, 68_000, 55_000, 73_000, 88_000, 104_000, 120_000],
};

/** The day-by-day report for one provider — or one model of it — over `days` days. */
function dailyFixture(provider, days, nowMs, model = null) {
    const spend = model
        ? (DAILY_BY_MODEL[model] || [])
        : (DAILY_BY_PROVIDER[provider] || []);
    if (spend.length === 0) return [];
    const back = [11, 10, 9, 8, 5, 3, 2, 1, 0];
    return back
        .filter((b) => b < days)
        .map((b, i) => ({ dayUtc: dayKey(b, nowMs), tokensTotal: spend[i], turns: 3 + i }));
}

/** The usage report the chart under a selected row reads. */

/**
 * What GET /providers/usage-summary answers. Fixed numbers: 14 days of
 * series (only some days have turns, like the real ledger), three models
 * whose totals sum to the 30-day window, and a windows block whose month is
 * exactly the models' sum. `days` and `providers` are echoed back so a
 * test can see the filter took.
 */
/**
 * What GET /providers/usage-agents answers: three agents over the window,
 * one of them '(none)', each with a per-day series, and the flat day-by-agent
 * rows the stacked chart reads. Enough rows for a test to tick and untick.
 */
function agentsFixture(query, { nowMs }) {
    const today = new Date(nowMs).toISOString().slice(0, 10);
    const dayKey = (back) => new Date(nowMs - back * 86_400_000).toISOString().slice(0, 10);
    const agents = [
        { agent: "sweeper", models: ["gpt-5.4"], turns: 40, sessions: 4, input: 20_000_000, output: 400_000, cacheRead: 4_000_000, cacheWrite: 0, total: 20_400_000, daily: [{ day: dayKey(6), total: 15_000_000 }, { day: dayKey(3), total: 5_400_000 }] },
        { agent: "researcher", models: ["gpt-5.4", "claude-sonnet-5"], turns: 20, sessions: 2, input: 8_000_000, output: 200_000, cacheRead: 1_000_000, cacheWrite: 0, total: 8_200_000, daily: [{ day: dayKey(6), total: 8_200_000 }] },
        { agent: "(none)", models: ["gpt-5.4-nano"], turns: 11, sessions: 3, input: 2_000_000, output: 2_610, cacheRead: 600_000, cacheWrite: 0, total: 2_002_610, daily: [{ day: dayKey(0), total: 2_002_610 }] },
    ];
    const daily = agents.flatMap((a) => a.daily.map((d) => ({ day: d.day, agent: a.agent, total: d.total })));
    return { days: Number(query.days) || 14, today, agents, daily };
}

function summaryFixture(query, { nowMs, admin }) {
    const days = [14, 30, 90].includes(Number(query.days)) ? Number(query.days) : 14;
    const today = new Date(nowMs).toISOString().slice(0, 10);
    const dayKey = (back) => new Date(nowMs - back * 86_400_000).toISOString().slice(0, 10);
    const daily = [
        { day: dayKey(6), input: 25_000_000, output: 640_000, cacheRead: 2_390_000, cacheWrite: 0, total: 25_640_000, turns: 20 },
        { day: dayKey(3), input: 6_540_000, output: 9_000, cacheRead: 3_280_000, cacheWrite: 0, total: 6_549_000, turns: 48 },
        { day: dayKey(0), input: 322_000, output: 610, cacheRead: 63_000, cacheWrite: 0, total: 322_610, turns: 3 },
    ];
    const models = [
        { model: "gpt-5.4", providers: 3, turns: 60, input: 30_000_000, output: 600_000, cacheRead: 5_000_000, cacheWrite: 0, total: 30_600_000, daily: [{ day: dayKey(6), total: 25_640_000 }, { day: dayKey(3), total: 4_960_000 }] },
        { model: "gpt-5.4-nano", providers: 2, turns: 10, input: 2_000_000, output: 2_000, cacheRead: 600_000, cacheWrite: 0, total: 2_002_000, daily: [{ day: dayKey(3), total: 1_589_000 }, { day: dayKey(0), total: 413_000 }] },
        { model: "claude-sonnet-5", providers: 1, turns: 1, input: 40_000, output: 2_610, cacheRead: 0, cacheWrite: 0, total: 42_610, daily: [{ day: dayKey(0), total: 42_610 }] },
    ];
    const sum = (rows, key) => rows.reduce((acc, r) => acc + (r[key] || 0), 0);
    const window = (rows) => ({ input: sum(rows, "input"), output: sum(rows, "output"), cacheRead: sum(rows, "cacheRead"), cacheWrite: 0, total: sum(rows, "total"), turns: sum(rows, "turns"), sessions: rows.length });
    return {
        days,
        today,
        scope: admin ? "cluster" : "mine",
        windows: { day: window(daily.slice(2)), week: window(daily), month: window(daily) },
        daily,
        models,
        classes: [{ chargeClass: "user", total: 30_000_000, turns: 50 }, { chargeClass: "system", total: 8_244_610, turns: 21 }],
    };
}

function usageReport(query, { emptyUsage, nowMs }) {
    const days = Number(query.days) || 14;
    const provider = query.provider ? String(query.provider) : null;
    // The chart asks for ONE model when a per-model limit row is selected.
    const model = query.model ? String(query.model) : null;
    if (query.chargeClass === "system") {
        const breakdown = provider === "azure-prod" ? [
            { key: "azure-prod:gpt-5.6-luna", label: "azure-prod:gpt-5.6-luna", tokensTotal: 760_000, turns: 5 },
            { key: "azure-prod:gpt-5.6-sol", label: "azure-prod:gpt-5.6-sol", tokensTotal: 240_000, turns: 2 },
        ] : [];
        return {
            totals: {
                tokensTotal: breakdown.reduce((sum, row) => sum + row.tokensTotal, 0),
                turns: breakdown.reduce((sum, row) => sum + row.turns, 0),
                sessions: breakdown.length,
            },
            daily: [],
            breakdown,
            dimension: "model",
            truncated: false,
        };
    }
    const daily = emptyUsage ? [] : dailyFixture(provider, days, nowMs, model);
    const tokensTotal = daily.reduce((sum, row) => sum + row.tokensTotal, 0);
    const turns = daily.reduce((sum, row) => sum + row.turns, 0);
    return {
        totals: { tokensTotal, turns, sessions: daily.length },
        daily,
        breakdown: [],
        dimension: String(query.dimension || "provider"),
        truncated: false,
    };
}

/**
 * Start the fixture server.
 *
 * `usageQueries` collects every chart query the surface sent, so a test can
 * assert on what was ASKED FOR and not only on what was drawn. `calls`
 * collects every MUTATION, so "Cancel changes nothing" is a fact about the
 * wire rather than about the screen.
 *
 * `fail` refuses named capabilities: `{ getProviderUsageGrid: "the table is
 * unreadable" }` or `{ getProviderUsageGrid: { status: 503, code:
 * "INTERNAL_ERROR", message: "..." } }`. The message is passed through to the
 * surface unchanged, which is the whole point of the failure tests.
 *
 * Nothing here mutates: a change is recorded and acknowledged, and the next
 * read returns the same fixtures. The tests assert on what was SENT.
 */
export async function startProviderBudgetStub({
    admin = true,
    grid = null,
    providers = PROVIDERS,
    paused = null,
    defaults = DEFAULTS,
    modelDefaults = MODEL_DEFAULTS,
    models = MODELS,
    sessions = SESSIONS,
    emptyUsage = false,
    fail = {},
} = {}) {
    const inner = await startStubServer(0, { admin, sessionCount: 3 });
    const nowMs = Date.now();
    // Mutable, so a test can make a provider disappear BETWEEN two reads —
    // the one way to reach "the row you had selected is gone" without
    // restarting the stub and losing the page.
    let GRID = grid || gridFixture(nowMs);
    const PAUSED = paused || pausedFixture(nowMs);
    const usageQueries = [];
    // Every GET /providers/usage-summary query, in order.
    const summaryQueries = [];
    const calls = [];

    const json = (res, result) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result }));
    };
    // The refusal shape the api client reads: a non-2xx with {error:{code,message}}.
    const refuse = (res, spec) => {
        const detail = typeof spec === "string" ? { message: spec } : (spec || {});
        res.writeHead(detail.status || 400, { "content-type": "application/json" });
        res.end(JSON.stringify({
            ok: false,
            error: { code: detail.code || "PROVIDER_INVALID", message: detail.message || "The request was refused." },
        }));
    };
    /** Answer `op`, or refuse it when this stub was started with it in `fail`. */
    const answer = (res, op, result) => (fail[op] ? refuse(res, fail[op]) : json(res, result));

    const readBody = (req) => new Promise((resolve) => {
        let raw = "";
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
            try { resolve(JSON.parse(raw || "{}")); } catch { resolve({ malformed: raw }); }
        });
    });

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, "http://localhost");
        const p = url.pathname;
        const method = req.method || "GET";
        const query = Object.fromEntries(url.searchParams.entries());

        // The role reaches the store through /api/v1/bootstrap → auth.
        // authorization. The shared stub's own bootstrap entry is keyed
        // without the /v1 prefix, so it never matches and the viewer would
        // read as "not an administrator" — every admin-only rule would then
        // be tested against the wrong person.
        if (/\/bootstrap$/.test(p)) {
            const modelsByProvider = [...new Set(models.map((model) => model.providerId))].map((providerId) => ({
                providerId,
                type: models.find((model) => model.providerId === providerId)?.providerType || providerId,
                models: models.filter((model) => model.providerId === providerId),
            }));
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                ok: true, mode: "remote", workerCount: 1,
                defaultModel: "copilot-shared:claude-sonnet-5",
                modelsByProvider, logConfig: { available: false, availabilityReason: "test" },
                auth: {
                    principal: {
                        provider: "dev", subject: "ada", email: "ada@dev.local",
                        displayName: "Ada Admin", groups: [], roles: admin ? ["admin"] : ["user"],
                    },
                    authorization: {
                        allowed: true, role: admin ? "admin" : "user",
                        reason: "stub", matchedGroups: [],
                    },
                },
            }));
            return;
        }

        // ── the reads ──────────────────────────────────────────────────
        // The whole table, in one call. Checked before /providers so the
        // shorter pattern cannot swallow it.
        if (method === "GET" && /\/providers\/usage-grid$/.test(p)) {
            // `manageable` is the DATABASE's answer, not the fixture's: admin
            // on a shared provider, owner on a personal one. Deriving it here
            // keeps every fixture honest about the viewer it is serving.
            const rows = GRID.map((r) => ({
                ...r,
                manageable: r.manageable === false ? false
                    : (r.class === "shared" ? admin === true : r.ownedByMe !== false),
            }));
            return answer(res, "getProviderUsageGrid", { rows });
        }
        if (method === "GET" && /\/providers$/.test(p) && !/\/(management|me)\/providers$/.test(p)) {
            return answer(res, "listProviders", { providers });
        }
        if (method === "GET" && /\/providers\/paused$/.test(p)) {
            return answer(res, "listPausedSessions", { sessions: PAUSED });
        }
        // The Cluster summary: one deterministic answer, shaped exactly as
        // cms_provider_usage_summary builds it, so a test can check the tab
        // against known arithmetic. The query is recorded so a test can prove
        // what the picker and the range buttons asked for.
        if (method === "GET" && /\/providers\/usage-agents$/.test(p)) {
            return answer(res, "getProviderUsageAgents", agentsFixture(query, { nowMs }));
        }
        if (method === "GET" && /\/providers\/usage-summary$/.test(p)) {
            summaryQueries.push(query);
            return answer(res, "getProviderUsageSummary", summaryFixture(query, { nowMs, admin }));
        }
        if (method === "GET" && /\/providers\/usage$/.test(p)) {
            usageQueries.push(query);
            return answer(res, "getProviderUsage", usageReport(query, { emptyUsage, nowMs }));
        }
        if (method === "GET" && /\/model-defaults$/.test(p)) {
            return answer(res, "getModelDefaults", modelDefaults);
        }
        if (method === "GET" && /\/defaults$/.test(p)) {
            return answer(res, "getDefaults", defaults);
        }
        if (method === "GET" && /\/models\/by-provider$/.test(p)) {
            const groups = [...new Set(models.map((model) => model.providerId))].map((providerId) => ({
                providerId,
                type: models.find((model) => model.providerId === providerId)?.providerType || providerId,
                models: models.filter((model) => model.providerId === providerId),
            }));
            return answer(res, "getModelsByProvider", groups);
        }
        if (method === "GET" && /\/models$/.test(p)) {
            return answer(res, "listModels", models);
        }
        if (method === "GET" && /\/management\/sessions$/.test(p)) {
            return json(res, { sessions, hasMore: false, nextCursor: null });
        }
        const sessionMatch = /\/sessions\/([^/]+)$/.exec(p);
        if (method === "GET" && sessionMatch) {
            const found = sessions.find((s) => s.sessionId === sessionMatch[1]) || sessions[0];
            return json(res, { ...found, messages: [], events: [], pendingMessages: [] });
        }

        // ── the changes ────────────────────────────────────────────────
        const change = (op, name = null) => ({ op, name });
        const limitMatch = /\/providers\/([^/]+)\/limit$/.exec(p);
        const allowanceMatch = /\/management\/providers\/([^/]+)\/allowance$/.exec(p);
        const holdMatch = /\/management\/providers\/([^/]+)\/hold$/.exec(p);
        const systemUseMatch = /\/management\/providers\/([^/]+)\/system-use$/.exec(p);
        const systemAgentModelMatch = /\/management\/system-sessions\/([^/]+)\/model$/.exec(p);
        const deleteSharedMatch = /\/management\/providers\/([^/]+)$/.exec(p);
        const deleteMineMatch = /\/me\/providers\/([^/]+)$/.exec(p);
        const updateCredentialMatch = /\/me\/providers\/([^/]+)\/credential$/.exec(p);
        const updateSharedCredentialMatch = /\/management\/providers\/([^/]+)\/credential$/.exec(p);

        let spec = null;
        let result = {};
        if (method === "POST" && /\/management\/providers$/.test(p)) { spec = change("createProvider"); }
        else if (method === "POST" && /\/me\/providers$/.test(p)) { spec = change("createMyProvider"); }
        else if (method === "PUT" && updateCredentialMatch) {
            spec = change("updateMyProviderCredential", decodeURIComponent(updateCredentialMatch[1]));
        }
        else if (method === "PUT" && updateSharedCredentialMatch) {
            spec = change("updateSharedProviderCredential", decodeURIComponent(updateSharedCredentialMatch[1]));
        }
        else if (method === "DELETE" && deleteSharedMatch) {
            spec = change("deleteProvider", decodeURIComponent(deleteSharedMatch[1]));
            result = { waitingSessions: 2 };
        } else if (method === "DELETE" && deleteMineMatch) {
            spec = change("deleteMyProvider", decodeURIComponent(deleteMineMatch[1]));
            result = { waitingSessions: 0 };
        } else if (method === "PUT" && limitMatch) {
            spec = change("setProviderLimit", decodeURIComponent(limitMatch[1]));
            result = { ruleId: "rule-new", seededTokens: 3_400_000 };
        } else if (method === "DELETE" && limitMatch) {
            spec = change("removeProviderLimit", decodeURIComponent(limitMatch[1]));
            result = { removed: true };
        } else if (method === "PUT" && allowanceMatch) {
            spec = change("setProviderAllowance", decodeURIComponent(allowanceMatch[1]));
        } else if (method === "PUT" && holdMatch) {
            spec = change("setProviderHold", decodeURIComponent(holdMatch[1]));
        } else if (method === "PUT" && systemUseMatch) {
            spec = change("setProviderSystemUse", decodeURIComponent(systemUseMatch[1]));
        } else if (method === "PUT" && /\/model-defaults$/.test(p)) {
            spec = change("setModelDefault");
        } else if (method === "PUT" && /\/management\/system-model-default$/.test(p)) {
            spec = change("setSystemModelDefault");
            result = { configured: modelDefaults.system.configured, effective: modelDefaults.system.effective, restart: null };
        } else if (method === "PUT" && systemAgentModelMatch) {
            spec = change("setSystemSessionModel", decodeURIComponent(systemAgentModelMatch[1]));
        } else if (method === "DELETE" && systemAgentModelMatch) {
            spec = change("clearSystemSessionModel", decodeURIComponent(systemAgentModelMatch[1]));
        } else if (method === "PUT" && /\/management\/defaults$/.test(p)) {
            spec = change("setClusterDefault");
        } else if (method === "PUT" && /\/me\/default$/.test(p)) {
            spec = change("setMyDefault");
        }

        if (spec) {
            const body = method === "GET" || method === "DELETE" ? null : await readBody(req);
            calls.push({ op: spec.op, name: spec.name, method, path: p, query, body });
            if (fail[spec.op]) return refuse(res, fail[spec.op]);
            return json(res, { name: body?.name || spec.name, ...result });
        }

        // Everything else belongs to the shared stub.
        const proxy = http.request({
            host: "127.0.0.1", port: inner.port, path: req.url, method, headers: req.headers,
        }, (up) => {
            res.writeHead(up.statusCode || 200, up.headers);
            up.pipe(res);
        });
        proxy.on("error", () => { res.writeHead(502); res.end("stub proxy failed"); });
        req.pipe(proxy);
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        port: server.address().port,
        usageQueries,
        summaryQueries,
        calls,
        /** What the NEXT read of the table answers with. */
        setGrid: (rows) => { GRID = rows; },
        close: async () => {
            // The browser holds keep-alive sockets open, and so does the proxy
            // agent talking to the inner stub. `close()` alone waits for both
            // to idle out (5s each by Node's default), which turns every
            // teardown into a stall long enough to time the test out.
            server.closeAllConnections?.();
            inner.server.closeAllConnections?.();
            await new Promise((r) => server.close(r));
            await new Promise((r) => inner.server.close(r));
        },
    };
}
