# Provider budgets — the surface contract

The one list every surface implements. Model: `providers-and-budgets.md`.
Data layer: `packages/sdk/src/provider-store.ts` (`ProviderStore`, reachable
as `catalog.providers`).

**Parity is the rule**, and it is pinned:
`packages/sdk/test/unit/provider-surface-parity.test.mjs` drives every
capability through all three surfaces for real — the protocol table's own
rows, the MCP tools registered into a recording server, the agent tools
run against a recording store — and fails on any drift, including a
grouped tool that drops one of its branches. Every capability below
exists on the HTTP API, the
MCP server, and the agent tools. Authority is NOT part of parity: every
caller gets the same operations and the DATABASE decides what they may do.
A user's Token Manager and an admin's Token Manager are the same tools with
different viewers.

## Vocabulary

- `provider` — a name. Cluster-unique, immutable, no colon.
- `class` — `shared` (admin-made, anyone may spend) or `personal` (yours).
- `period` — `day` | `week` | `month`.
- `tuple` — `{provider, model, reasoning, context}`. A default is a tuple.
- `chargeClass` — `user` | `system` | `unattributed`.
- Never say pool, payer, grant, quota rule, or bind mode.

## The operations

| # | Capability | Who | Notes |
|---|---|---|---|
| 1 | `listProviders` | anyone | The caller's namespace: every shared provider + their own. Admins additionally see other people's personal providers with `usableByMe:false`. |
| 2 | `getProviderStatus(names?)` | anyone | Limits, usage against them, resets, and the caller's own ceiling/usage where an allowance applies. |
| 3 | `createProvider({name,type,credentials,baseUrl?})` | admin | Makes a SHARED provider. |
| 4 | `createMyProvider({name,type,credentials,baseUrl?})` | anyone | Makes a PERSONAL provider owned by the caller. |
| 5 | `deleteProvider(name)` | admin | Shared. Returns how many sessions are left waiting on the name. |
| 6 | `deleteMyProvider(name)` | anyone | Own. Same return. |
| 7 | `setProviderLimit({provider,period,model?,tokens})` | admin on shared, owner on personal | Upserts one limit per (period, scope). `model` is the QUALIFIED reference (`provider:model`); a bare model name is refused with PROVIDER_INVALID, because it would save, show as a live cap, and silently never fire. Returns `{ruleId, seededTokens}` — `seededTokens` is a READ: what the meter for this window has already counted. Setting a limit writes nothing and resets nothing. |
| 8 | `removeProviderLimit({provider,period,model?})` | same | Returns whether one was there. |
| 9 | `setProviderAllowance({provider,pct})` | admin | Shared only, 1..100. 100 = full. |
| 10 | `setProviderHold({provider,untilUtc?,release?})` | admin | No `untilUtc` and no `release` = indefinite. |
| 11 | `getDefaults()` | anyone | `{cluster: tuple, mine: tuple}`. |
| 12 | `setClusterDefault(tuple)` | admin | Must name an existing SHARED provider. |
| 13 | `setMyDefault(tuple\|null)` | anyone | Null clears. |
| 14 | `getProviderUsage(filters)` | anyone | `{totals, daily[], breakdown[]}`. Non-admins are clamped to their own rows by the database. |
| 15 | `listPausedSessions()` | anyone | Structured pause records. Row-scoped: admins fleet-wide, others their own. |
| 16 | `getProviderUsageGrid()` | anyone | Every provider in the caller's namespace, each followed by its model-scoped limits, with used and quota for day, week and month — the caller's own and everyone's. Reports a period with NO limit too (`quotaTokens: null`), which #2 cannot: it lists limits. Rows come back in reading order; a null `yourUsedTokens` means nobody is signed in, which is not zero. |

`filters` = `{days=7 (max 365), mine?, ownerUserId?, provider?, model?,
sessionId?, chargeClass?, dimension='provider', limit=40 (max 200)}`.
`mine: true` is resolved to the caller on the server and beats
`ownerUserId` — it carries no id, so it cannot name anybody else. It
exists on the HTTP operation only; the MCP and agent tools have no
`mine`, because there the viewer is already implicit.
`dimension` ∈ `session | user | provider | model | agent`.

## HTTP (packages/sdk/api/src/protocol.js)

House style: `{ name, access, method, path, params, summary }`. Use
`path()`, `body()`, `query()` helpers. `access: "authed"` unless the table
says admin, in which case use `access: "fleet:admin"`, the value the file already uses
for fleet admin operations.

```
listProviders          GET    /providers
getProviderStatus      GET    /providers/status          ?names=a,b
getProviderUsageGrid   GET    /providers/usage-grid
createProvider         POST   /management/providers
deleteProvider         DELETE /management/providers/:name
createMyProvider       POST   /me/providers
deleteMyProvider       DELETE /me/providers/:name
setProviderLimit       PUT    /providers/:name/limit
removeProviderLimit    DELETE /providers/:name/limit
setProviderAllowance   PUT    /management/providers/:name/allowance
setProviderHold        PUT    /management/providers/:name/hold
getDefaults            GET    /defaults
setClusterDefault      PUT    /management/defaults
setMyDefault           PUT    /me/default
getProviderUsage       GET    /providers/usage
listPausedSessions     GET    /providers/paused
```

After ANY change to the table run `npm run generate:web-ops -w packages/sdk`
— a unit test pins the generated client to it.

Errors: `ProviderStore` throws `ProviderError` with `.code` ∈
`PROVIDER_NOT_FOUND | PROVIDER_FORBIDDEN | PROVIDER_CONFLICT |
PROVIDER_INVALID`. Map them to 404 / 403 / 409 / 400. The message is
already written for a person — pass it through rather than replacing it.

## MCP (packages/app/mcp/src/tools/providers.ts)

Snake_case tools, registered like the existing tool
files. Group the small mutations rather than shipping fifteen near-identical
tools:

```
list_providers            (1)
get_provider_status       (2)
get_provider_usage_grid   (16)
manage_provider           (3,4,5,6)   action: create|delete, mine: bool
set_provider_limit        (7,8)       tokens omitted or null = remove
set_provider_allowance    (9)
provider_hold             (10)        action: hold|release
get_provider_defaults     (11)
set_provider_default      (12,13)     scope: cluster|me
get_provider_usage        (14)
list_paused_sessions      (15)
```

Web mode loads no local registry (`ctx.models` is null unless the caller
explicitly passed `--model-providers`): provider tools always go through
`ctx.mgmt`.

## Agent tools (packages/sdk/src/provider-tools.ts)

`createProviderTools({ catalog, resolveViewer })` returns the SAME set as
MCP, same names. `resolveViewer` yields `{userId, isAdmin}`:

- the system Token Manager passes `{userId: null, isAdmin: true}`
- the user Token Manager resolves the SESSION OWNER, `isAdmin` from their role

Both get the full tool list. The database refuses what the viewer may not
do. Only sessions of the two Token Manager agents are SHOWN these tools —
a declaration is resident context on every turn, so ordinary sessions
never carry them (`PROVIDER_TOOL_AGENT_IDS` in provider-tools.ts). That
list decides who sees the tools, never what a call may do.

**The two-place trap.** A tool needs BOTH a declaration in
`ManagedSession.systemToolDefs()` AND a handler in the runTurn tool list.
A handler-only tool is invisible to the model; a declaration-only tool is
worse — the CLI drops the call without answering and the turn HANGS. The
agent's `.agent.md`
tools list is a third place.

## Response shapes

Camel-case, exactly what `ProviderStore` returns. Do not reshape per
surface — the portal, the MCP client and an agent should see the same JSON.

```jsonc
// listProviders
{ "providers": [ { "name","typeId","class","ownerUserId","ownerEmail",
                   "ownerDisplayName","baseUrl","allowancePct","holdUntilUtc",
                   "holdIndefinite","hasCredential","usableByMe",
                   "isClusterDefault","isMyDefault","ruleCount","createdAt" } ] }
// getProviderStatus
{ "providers": [ { "name","class","allowancePct","holdUntilUtc","holdIndefinite",
                   "rules": [ { "ruleId","providerName","period","modelQualified",
                                "limitTokens","usedTokens","ceilingTokens",
                                "yourUsedTokens","windowStartUtc","resetsAtUtc" } ] } ] }
// getProviderUsage
{ "totals": {"tokensTotal","turns","sessions"},
  "daily": [{"dayUtc","tokensTotal","turns"}],
  "breakdown": [{"key","label","tokensTotal","turns"}],
  "dimension": "provider", "truncated": false }
// listPausedSessions
{ "sessions": [ { "sessionId","title","model","ownerUserId","ownerEmail",
                  "state","pause","updatedAt" } ] }

// getProviderUsageGrid
{ "rows": [ { "providerName", "rowKind",          // 'provider' | 'model'
              "scope",                            // '*' or provider:model
              "class", "allowancePct",
              "holdUntilUtc", "holdIndefinite", "modelRowCount",
              "ownedByMe",    // false = somebody else's personal provider
                              //         (only admins ever see those rows)
              "manageable",   // yours to CHANGE: admin on shared, owner on
                              // personal — the cms_provider_assert_manage rule
              "ownerLabel",   // who owns it; null on a shared provider
              "periods": { "day" | "week" | "month": {
                  "ruleId", "quotaTokens", "usedTokens",
                  "yourQuotaTokens", "yourUsedTokens",
                  "windowStartUtc", "resetsAtUtc" } } } ] }
```

`pause` is `{kind: limit|allowance|hold|no_provider, provider, resetsAtUtc?, ...}`.
