# Providers & Budgets — detailed implementation plan

> **STATUS: the pre-build plan, kept for the record.** The build kept
> this plan's shape but renamed most objects and changed three designs
> after it was written: (1) counters were re-keyed as always-on METERS
> (migration 0053) and saving a limit no longer seeds anything; (2) the
> portal shipped as ONE table, not the two-tab surface in §7 — the
> shipped screen is specified in `providers-and-budgets-meters.md`;
> (3) the HTTP surface shipped as 16 operations, including
> `getProviderUsageGrid`. Seven plain-SQL migrations shipped (0049-0055),
> not one steps-shaped one; the proc family is `cms_provider_*`; the
> orchestration shipped as 1.0.70. The shipped truth is
> `providers-and-budgets.md`, `providers-and-budgets-surface.md`,
> `providers-and-budgets-meters.md`, and the code. Where this file and
> the code disagree, the code is right.

The model is `providers-and-budgets.md`. This file says how to build it:
schema, code, API, MCP, agent tools, the two Token Managers, UX, and
tests. Base facts below were verified against `main` (7100f869), which
this branch (`provider-budgets`) sits on.

## 0. Ground rules

- **Base state (verified):** main's migration head is **0048**. Main has
  NO provider tables — providers and models live only in
  `model_providers.json`, read by `packages/sdk/src/model-providers.ts`.
  `session_turn_metrics` exists (migration 0014) with tokens but no
  owner, no provider, no charge class. `users` has no default columns.
  There is no cluster-settings table. The ops table in
  `packages/sdk/api/src/protocol.js` has 124 operations.
  `agent-packages/` machinery IS on main, so the user token manager
  ships as a package.
- **Numbering warning:** the new series starts at **0049**, which the
  PARKED branch also used for a different schema. Any database that
  ever ran the parked branch must be wiped before running this build —
  the version numbers collide by design. Local DBs: wipe. Any deployed
  database that ever ran the parked branch: check `schema_migrations`
  for 0049+; if present, reset the database first.
- **Surface parity is a build rule:** every capability lands on HTTP,
  MCP, and agent tools in the same phase, and
  `ledger-surface-parity.test.mjs` (ported harness, new op list) pins it.
- **Red-first tests:** every test in §9 must be seen to fail before it
  counts (revert the guard, watch it go red).
- **Transplant discipline:** UX and runtime keepers are lifted from
  `parked/token-ledger-v1` by file (`git show token-ledger:<path>`),
  never by cherry-pick.

## 1. Config file design

**The file keeps today's shape.** Its meaning shifts: each
`providers[]` entry is a TYPE — a template saying what an instance of
it provides. Instances are CMS rows, full stop, created through the
same `createProvider` path the UI and API use.

```jsonc
{
  "providers": [
    {
      "id": "azure-openai",         // the type name (as today)
      "type": "azure",              // the adapter (as today)
      "models": [ /* ModelEntry[]: descriptions, cost, reasoning
                     efforts, context tiers, vision — unchanged */ ],
      "apiVersion": "2024-10-21",
      "baseUrl": "https://…",       // default for instances; an
                                    //   instance may override it
      "userInstantiable": true,     // NEW, optional; default true
      "apiKey": "env:AZURE_KEY"     // OPTIONAL: first-boot seed only
    }
  ],
  "defaultModel": "azure-openai:gpt-5.4"   // OPTIONAL: seed only
}
```

- Types are file-truth: loaded at boot, never written to the DB.
  Instances reference the entry's `id` as their `type_id`; an
  instance whose type vanished from the file shows "type missing" in
  its status and refuses new sessions — its existing sessions wait
  like any unresolvable provider.
- **First-boot seed:** the credential fields (`apiKey` /
  `githubToken`) and `defaultModel` are read exactly once. On a
  cluster where `cluster_settings.bootstrapped_at` is NULL, one
  process claims it atomically (`UPDATE … WHERE bootstrapped_at IS
  NULL`; concurrent fresh boots seed exactly once) and creates one
  same-named shared instance per credential-bearing entry, plus the
  default tuple, via the ordinary procs. After that these fields are
  ignored forever: an admin deleting a seeded instance deletes it for
  good, and no restart resurrects it. The CMS is the only truth.
- Consequences: every existing deployment file works unchanged; a
  new-style file simply omits the credential fields and seeds nothing;
  there is no sync and no fingerprint machinery, because nothing
  reconciles at boot.

## 2. Schema design (migrations 0049+)

One migration, `steps:`-shaped (autocommit steps; every step must
converge when re-run — the parked branch's measured discipline).

### Tables

```sql
provider_instances (
    name            TEXT PRIMARY KEY,           -- picker identity; there or not there
    type_id         TEXT NOT NULL,              -- from the config file's types
    class           TEXT NOT NULL CHECK (class IN ('shared','personal')),
    owner_user_id   BIGINT REFERENCES users,    -- NULL iff shared
    secret_ref      JSONB NOT NULL DEFAULT '{}',-- env: refs (bootstrap) or stored creds (runtime)
    base_url        TEXT,                       -- instance override
    allowance_pct   SMALLINT NOT NULL DEFAULT 100 CHECK (allowance_pct BETWEEN 1 AND 100),
    hold_until_utc  TIMESTAMPTZ,                -- manual hold; NULL = none
    hold_indefinite BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- No status column, no soft delete: a provider exists or it does not.
-- Deleting hard-DELETEs the row; rules and counters cascade away.
-- Re-creating the name later is just creating a provider (fresh
-- budget) whose name resolves again — that is the revival.

budget_rules (
    rule_id         TEXT PRIMARY KEY,
    provider_name   TEXT NOT NULL REFERENCES provider_instances(name) ON DELETE CASCADE,
    period          TEXT NOT NULL CHECK (period IN ('day','week','month')),
    model_qualified TEXT,                       -- NULL = all models
    limit_tokens    BIGINT NOT NULL CHECK (limit_tokens > 0),
    created_at / updated_at
);
CREATE UNIQUE INDEX ON budget_rules(provider_name, period, COALESCE(model_qualified,'*'));

quota_counters (          -- ported design, unchanged
    rule_id, window_key_utc, used_tokens, window_start_utc,
    resets_at_utc, updated_at, PK (rule_id, window_key_utc)
);
quota_counters_user (     -- the allowance's per-person mirror
    rule_id, user_id, window_key_utc, used_tokens, window_start_utc,
    resets_at_utc, updated_at, PK (rule_id, user_id, window_key_utc)
);

usage_ledger (            -- exactly-once spine, ported design
    session_id, turn_index,
    provider_name TEXT,           -- a RECORD, not a reference: no FK, so
                                  -- deleting a provider never touches history;
                                  -- reports group by the name string
    model_qualified, owner_user_id,
    charge_class TEXT NOT NULL DEFAULT 'user'
        CHECK (charge_class IN ('user','system','unattributed')),
    tokens_input/output/cache_read/cache_write BIGINT,
    created_at,
    PK (session_id, turn_index)   -- first insert wins; counters ride it
);

cluster_settings (        -- singleton
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    default_provider TEXT, default_model TEXT,
    default_reasoning TEXT, default_context TEXT,
    bootstrapped_at TIMESTAMPTZ   -- one-time seed claim; see §1
);

ALTER users ADD default_provider / default_model / default_reasoning
    / default_context TEXT;      -- columns, not profile_settings: the
                                 -- portal replaces profile_settings
                                 -- wholesale on every save (0074 lesson)

ALTER session_turn_metrics ADD provider_name TEXT, owner_user_id BIGINT,
    charge_class TEXT NOT NULL DEFAULT 'user';

ALTER sessions ADD pause_state JSONB;
-- The STRUCTURED pause record the gate writes:
-- {kind: limit|allowance|hold|no_provider, provider, ruleId?, period?,
--  model?, resetsAtUtc?} — the paused-sessions endpoint reads THIS,
-- never parses waitReason text (retires the old parsing hack).
```

### Stored procedures

House conventions carry over: check live signatures with
`pg_get_function_identity_arguments` before any DROP+CREATE; never
widen a shared proc's RETURNS TABLE (derive extra columns in the outer
query in cms.ts); `LANGUAGE sql` bodies are validated at CREATE, so
order steps accordingly.

| Proc | Signature (essentials) | Semantics |
|---|---|---|
| `cms_bootstrap_providers` | `(p_instances JSONB, p_default JSONB)` | One-time seed: claims `cluster_settings.bootstrapped_at` (NULL → now, atomically; loser no-ops), then creates the declared instances and the default via the ordinary create/set procs. Never runs again; never reconciles. |
| `cms_create_provider` | `(p_actor BIGINT, p_is_admin BOOL, p_name, p_type, p_class, p_secret JSONB, p_base_url)` | Shared requires admin; personal stamps owner=actor. Refuses a living name (42501-style typed error). |
| `cms_delete_provider` | `(p_actor, p_is_admin, p_name)` | Admin deletes shared; owner deletes their own. Hard DELETE — rules and counters cascade; ledger history keeps the name string. Sessions naming it start waiting at their next turn (nothing else to update). |
| `cms_set_provider_limit` | `(p_actor, p_is_admin, p_name, p_period, p_model, p_tokens)` | Admin on shared; owner on personal. Upserts the (period, scope) rule; **seeds the counter from the current window's ledger sum** ("counts from what was already spent"). Per-user counters are always maintained, so no user-side seeding is needed. |
| `cms_remove_provider_limit` | `(p_actor, p_is_admin, p_name, p_period, p_model)` | Removes by natural key. Counters kept for the record. |
| `cms_set_provider_allowance` | `(p_actor, p_is_admin, p_name, p_pct)` | Admin; shared only (personal refused: nothing to divide). |
| `cms_hold_provider` / `cms_release_provider_hold` | `(admin, name, until?)` | Manual hold independent of limits. |
| `cms_set_cluster_default` | `(admin, provider, model, reasoning, context)` | Must name an ACTIVE SHARED instance serving the model. |
| `cms_set_user_default` | `(actor, provider?, model?, …)` | May name shared or own; NULLs clear. |
| `cms_check_turn` | `(p_session_id, p_model)` → one row: `verdict TEXT, provider_name, exempt BOOL, pause JSONB, rules JSONB` | THE admission call, one round trip. Resolves the model ref's provider name **in the session owner's namespace** (shared ∪ owner's personal — someone else's personal instance is simply not found). verdict ∈ `clear \| paused \| no_provider`. System sessions: exempt=true, verdict=clear, provider still resolved for charging. Checks, in order: hold → each applicable rule's pool counter → each rule's allowance ceiling (`floor(limit × pct / 100)`, only when pct<100 and an owner exists). `pause` carries the structured record for `sessions.pause_state`. Never signals denial as empty rules. |
| `cms_settle_turn` | `(p_session_id, p_turn, p_model, p_tokens…, p_charge_class)` | Exactly-once: `INSERT … ON CONFLICT DO NOTHING` into usage_ledger; only a first insert increments `quota_counters` AND `quota_counters_user` and stamps the metrics columns. `charge_class='system'` writes the ledger row but increments NO counters. Unattributed (no resolvable instance): ledger row with NULLs + class, no counters. |
| `cms_provider_status` | `(p_viewer, p_names TEXT[]?)` | Per instance: rules with counters + resets, the viewer's own used/ceiling per rule, hold state. Everyone sees shared totals (open disclosure); personal rows only for their owner (+ admins). |
| `cms_usage_report` | `(p_viewer, p_is_admin, p_days, p_dim, filters…)` | Ported shape: dims session / user (admin) / provider / model / agent; owner clamped to viewer for non-admins; top-40 + truncation flag. |
| `cms_list_paused` | `(p_viewer, p_is_admin)` | Reads `sessions.pause_state` — structured, no text parsing. Row-scoped: admins all, users their own. |
| `cms_paused_for_provider` | `(p_name)` | The wake query: sessions whose pause_state names this provider. |

## 3. Runtime / code design

### Module map

| Module | Status | Notes |
|---|---|---|
| `packages/sdk/src/quota-windows.ts` (+ unit test) | **Port verbatim** | Window math identical; keep the SQL⇄TS parity test pair. |
| `packages/sdk/src/quota-gate.ts` | **Port, re-point** | Calls `cms_check_turn`; shapes `clear` / `wait` from verdict. New pause kinds: `allowance`, `hold`, `no_provider` — all reuse the existing `wait` TurnResult + durable-timer backstop + early-wake pattern. Fail-open on infrastructure errors, exactly as documented in the ported header. |
| `packages/sdk/src/provider-catalog.ts` | **New** | Type loading (file-truth), instance CRUD against the CMS, the one-time bootstrap call, credential resolution: env-refs for bootstrap-declared credentials, stored secrets for runtime-created ones (same storage mechanism as today's GHCP key, generalized). |
| `cms.ts` additions | **New + ported patterns** | `settleTurn` with the `cmsRetryCritical` retry port (5 attempts); cancelled turns still record streamed usage (parked-branch behavior, kept). |
| `SessionManager` credential selection | **Changed** | Consumes the ADMITTED provider name from `cms_check_turn` and uses that provider's credential — one source of truth; the old "accounting names one instance, runtime picks another" gap cannot exist. |
| Orchestration | **1.0.69** | The post-turn re-check (`evaluatePostTurnQuotaPause`) is a durable yield → freeze 1.0.68 **from the release commit** (`git show <release>:packages/sdk/src/orchestration/…` — never from a working tree), register 1.0.69, bump latest, update GOLDEN_SURFACE; port the schedule-fingerprint tests. |
| Worker/portal boot | **Changed** | Load types from the file; attempt the one-time bootstrap (a cheap claimed-already check on every later boot). Nothing heavy ever hangs off `getOrchestrationStats`. |
| Session create path | **Changed** | Server refuses creation when the tuple's provider does not resolve in the caller's namespace or cannot serve the model. Prefill: user tuple → cluster tuple. The stamped tuple is complete (provider, model, reasoning, context) — no NULL-model sessions are ever created. |

### The admission flow (one turn)

```
runTurn activity, before the LLM:
1. cms_check_turn(session, model)
2. exempt → run (system sessions; still charged at settle, class=system)
3. verdict=no_provider → wait, reason "no provider named X",
   pause_state written, durable timer backstop
4. verdict=paused (limit | allowance | hold) → wait with the structured
   reason; stashed prompt behavior as on the parked branch (the message
   is recorded durably BEFORE the pause event)
5. clear → run; SessionManager uses the admitted provider's credential
after the LLM:
6. cms_settle_turn(...) with the observed usage; retries via
   cmsRetryCritical; exactly-once by ledger PK
post-turn:
7. re-check → durable yield decides resume vs continue (1.0.69)
```

### Wakes

`wakeQuotaPausedSessionsForPool` ports as
`wakeQuotaPausedSessionsForProvider`, keyed by provider name, re-asking
`cms_check_turn` before resuming (a raise that is still short wakes
nobody). Trigger sites:

- limit raised / removed → wake that provider
- allowance raised → wake that provider
- hold released → wake that provider
- **instance created** (shared or personal) → wake that NAME — this is
  both the no-provider revival and the "user finally added a key" path
- period reset → the durable timer backstop already re-checks

## 4. API design (HTTP)

New operations in `protocol.js`, house style (`name, access, method,
path, params, summary`). `authed` = any signed-in user; `admin` where
marked; authority inside the proc decides shared-vs-personal cases.
After any change: `npm run generate:web-ops -w packages/sdk` (a unit
test pins the generated client).

| Op | Method & path | Access | Notes |
|---|---|---|---|
| `listProviders` | GET `/providers` | authed | The caller's namespace: every active shared + their personal instances; per entry: type, class, models (from the type), allowancePct, hold, at-limit summary, isClusterDefault/isMyDefault. Feeds picker AND Providers view. |
| `getProviderStatus` | GET `/providers/status?names=` | authed | `cms_provider_status`: rules, counters, resets, your used/ceiling. |
| `createProvider` | POST `/management/providers` | admin | `{name, type, credentials, baseUrl?}` → shared instance. |
| `createMyProvider` | POST `/me/providers` | authed | Same body → personal instance (type must be userInstantiable). |
| `deleteProvider` | DELETE `/management/providers/:name` | admin | Shared; hard delete. |
| `deleteMyProvider` | DELETE `/me/providers/:name` | authed | Own; hard delete. |
| `setProviderLimit` | PUT `/providers/:name/limit` | authed | `{period, model?, tokens}`; proc enforces admin-on-shared / owner-on-personal. |
| `removeProviderLimit` | DELETE `/providers/:name/limit` | authed | `{period, model?}` natural key. |
| `setProviderAllowance` | PUT `/management/providers/:name/allowance` | admin | `{pct}` 1–100; shared only. |
| `holdProvider` | POST `/management/providers/:name/hold` | admin | `{untilUtc?}` — absent = indefinite. |
| `releaseProviderHold` | DELETE `/management/providers/:name/hold` | admin | Wakes. |
| `getDefaults` | GET `/defaults` | authed | `{cluster: tuple, mine: tuple\|null}`. |
| `setClusterDefault` | PUT `/management/defaults` | admin | Full tuple; must name an active shared instance serving the model. |
| `setMyDefault` | PUT `/me/default` | authed | Tuple or null to clear. |
| `getUsageReport` | GET `/usage/report` | authed | Ported shape; dims `session\|user\|provider\|model\|agent`; owner clamped for non-admins. |
| `listPausedSessions` | GET `/usage/paused` | authed | Structured incidents from `pause_state`; row-scoped. |

Reshaped, not new: `listModels` / `getModelsByProvider` /
`getDefaultModel` now read the DB catalog + config types (same
response shapes; `getDefaultModel` returns the cluster tuple's
`provider:model`). Compat alias: `PUT /me/github-copilot-key` becomes a
thin wrapper over `createMyProvider` (type `github-copilot`, generated
name `ghcp-<user>`); kept until clients migrate.

Nothing needs a dispatcher refusal list: the pool/grant operations
never existed on this lineage.

## 5. MCP design

New file `packages/app/mcp/src/tools/providers.ts` (the ported
`token-ledger.ts` shells, trimmed), tools mapping 1:1 onto the ops:

`list_providers`, `get_provider_status`, `manage_provider`
(create/delete, `mine:true` for personal), `set_provider_limit`,
`remove_provider_limit`, `set_provider_allowance`, `provider_hold`
(hold/release), `get_defaults`, `set_default` (scope: cluster|me),
`get_usage_report`, `list_paused_sessions`.

Same schema-checked argument style as the existing tools; errors map
P0001-style proc messages to actionable text (the router already
carries the mapping pattern).

## 6. Agent tools and the two Token Managers

One tool substrate serves both agents: port
`createQuotaTools(resolveViewer)` from the parked branch, re-pointed at
the new ops. **The tool list is the FULL capability set** — the same
operations as HTTP and MCP, per the parity rule and the user's
direction that agents have full access. Authority is decided by the
resolved viewer in the procs, never by trimming the tool list.

Two registration traps, both documented on the parked branch, both
enforced by tests here:

1. A tool needs BOTH a `systemToolDefs()` declaration
   (`managed-session.ts:607`) and a runTurn handler — a handler-only
   tool is invisible to the model.
2. The `.agent.md` tools list is a separate third place and easy to
   forget.

### Token Manager (system agent — the admin's tool)

- `token-manager.agent.md` ported from the parked branch: name,
  description ("manages providers, budgets, allowances and holds;
  reads fleet-wide usage"), full tools list.
- Registered as a permanent system child alongside sweeper/resource
  (`worker.ts` permanent-children path, ~line 1726's family).
- Viewer resolution: `{userId: null, isAdmin: true}` — it acts with
  cluster authority. It can: create/delete shared providers, set
  limits/allowances/holds, set the cluster default, read any report,
  read attribution.

### user-token-manager (published package — the user's tool)

- Package at `agent-packages/user-token-manager/` (agent.md + manifest),
  published shared: `node packages/app/tui/bin/tui.js agents push
  ./agent-packages/user-token-manager --shared` (dev:
  `PILOTSWARM_DEV_USER=ada PILOTSWARM_API_URL=…`).
- The session-manager gate attaches the SAME `createQuotaTools`, with
  `resolveViewer` = the session owner (port of the
  `_resolveQuotaViewer → getUserIdForPrincipal` pattern, keyed on
  agentIdentity `user-token-manager`).
- Same full tool list. What the owner's viewer can actually do: create
  and delete THEIR providers, set limits on them, set their default,
  read shared providers' status and totals, read their own usage and
  ceilings. Admin verbs refuse in the proc — live-verify this exactly
  as the parked branch did (reads own data, refuses admin acts).
- Local dev note: embedded workers install packages
  (`PILOTSWARM_AGENT_PACKAGES=0` opts out), so a locally published
  package is runnable immediately.

## 7. UX design

Voice: the plain product language already landed in `ca7cc09c` on the
parked branch (paused, limits, Daily/Weekly/Monthly, "System
services") — that pass carries with the transplant.

### The Budget modal (portal)

Two tabs, same shell as the parked branch:

- **Usage** (`TokenBudgetModal`, transplant near-verbatim): stat tiles
  (Tokens used · Largest token limit · Limits reached · Available
  providers), daily chart, **Providers** panel (was Pools: per instance
  worst-first rule meters, "You: x / ceiling" where an allowance
  applies), breakdown pivots Sessions · Users(admin) · Providers ·
  Models · Agents, filter row (Sessions / Owner / Provider / Model /
  Date range), the paused band — now fed by `listPausedSessions`
  (structured), with "View <provider>" opening the Providers tab
  focused on the cause.
- **Providers** (was Pools; `BudgetPoolsPane` → `ProvidersPane`):
  - Flat card list, no tree: shared instances first, then "Yours".
    Chips: `your key` (personal), `exempt`-style chip is GONE (no
    system pools) — instead the cluster-default instance shows a
    `cluster default` chip; `your default` chip as before.
  - Detail pane panels: **Limits** (rows `Daily · all models · 20M`,
    Edit/Remove; + Add limit), **Allowance** (one line: "Everyone
    shares the full pool" or "Each person may use up to 20% of each
    limit", Edit for admins), **Sessions** (row-scoped roster;
    paused-by lines from pause_state), **Hold** (admin: place/release,
    with until-time).
  - **Defaults panel** under the list: "Your default" and "Cluster
    default" as full tuples (provider + model + reasoning + context) —
    two labeled selects + the tuple's model picker, replacing the old
    pool dropdowns.
  - Sheets (BudgetSheet shell ported): LimitSheet (near-verbatim —
    period/scope/tokens, immediate-block warning), AllowanceSheet
    (new: Full / percentage, live "Daily 1M → 200K per person" math,
    lower-warning with count of people already past the ceiling),
    CreateProviderSheet (admin: type, name, credentials, baseUrl;
    user variant: same minus allowance), DeleteProviderSheet
    (consequences: "N sessions will wait until this name returns or
    they switch model. Its limits go with it; usage history keeps the
    name."), HoldSheet. GrantSheet does not come over.
- CSS: the `ps-budget-*` block copies verbatim; new elements reuse
  existing classes.

### Everywhere else

- **Model picker / create flow**: entries are provider instances
  (name + type + class badge), each with inline budget context (the
  old `roomFor()` presentation: "42% of its daily limit used", "AT ITS
  DAILY LIMIT — a session here waits"). The separate pool step is
  gone. Zero-entry catalog renders the refusal ("Nothing can pay for
  this yet — add your own provider or ask an admin"), never an
  unfiltered list.
- **Manage session**: the "Paying" section becomes "Provider" — name,
  its worst rule state, hold note; no mover (switch model is the
  mover). Switch-model flow: picking a model implies its instance;
  refusal states surface inline.
- **Session list**: ⏸ + red dot + "quota" label for paused sessions —
  ported unchanged; `pause_state.kind` drives the label text
  (limit/allowance/hold/no provider).
- **Transcript**: `quota_paused` / `quota_resumed` system lines ported;
  no-provider waits use the same rendering with their own words.
- **Admin console**: the usage section reads the same report + status
  endpoints (no separate implementation).

### Vocabulary (binding, from the model doc)

pause → "paused"; rule → "limit"; windows → Daily / Weekly / Monthly;
allowance → "allowance"; machinery spend → "System services";
unattributed → "No provider recorded"; never "pool", never "payer",
never "grant".

## 8. Test plan

Layers, with the concrete cases each must cover. Every case is shown
red first.

**SQL / proc tests** (node --test against pg, parked-branch harness):
- Window math parity: TS `quota-windows` ↔ `cms` bounds agree for
  day/week/month across DST-irrelevant UTC edges (ported test).
- Exactly-once: double `cms_settle_turn` for one (session, turn)
  increments counters once; concurrent settles race safely.
- Seeding: setting a limit mid-window starts its counter at the
  window's ledger sum; editor-visible.
- Overall + per-model rules on one instance both evaluate; the
  blocking rule is the one reported.
- Allowance: ceiling = floor(limit × pct / 100); pct=100 short-circuits
  (no user-counter read); per-model rules get per-person ceilings;
  unowned turns skip allowance; admins are bound.
- Namespace: another user's personal instance resolves as no_provider,
  byte-identical to a never-created name.
- System: exempt verdict + ledger row with class=system + zero counter
  increments. Unattributed: ledger row, no counters.
- Holds: block, expire, release.
- Delete/re-create: delete → next check no_provider; rules and
  counters are gone (cascade); the ledger's history rows survive with
  the name string; re-create the name → resolves fresh with no old
  rules, and reports group old and new under the one name.
- Defaults: cluster tuple must be shared+active+serving; user tuple
  free; clears.
- Bootstrap: concurrent fresh boots seed exactly once; a deleted
  seeded instance stays deleted across restarts; a legacy-shape file
  seeds same-named instances + the default on first boot only.
- Migration: every step converges re-run from any failure point;
  a parked-branch DB is REFUSED (0049 content mismatch detection —
  a guard step asserts no `token_pools` table exists).

**SDK unit (vitest):**
- Gate shaping: verdict → clear/wait mapping; the four pause kinds
  carry structured pause_state; fail-open on CMS error; stashed prompt
  recorded before the pause event.
- Wake: raise-not-enough wakes nobody; instance-created wakes
  no_provider waiters; hold release wakes.
- Settle retry (cmsRetryCritical port); cancelled turn records
  streamed usage.
- Orchestration schedule fingerprint: 1.0.68 frozen surface unchanged;
  1.0.69 registered as latest.
- Surface parity: the op list ↔ MCP tools ↔ agent tools (ported
  harness, new list).
- Workers constructed in tests pass `modelProvidersPath` (the parked
  branch's stray-config lesson).

**Portal ui-core tests (node --test, render):**
- Picker offers exactly the namespace; zero-entry refusal renders.
- Usage tab: sentinel labels ("No provider recorded", "System
  services"); refused report replaces numbers; truncation note at 40.
- Providers view: allowance line states both forms; limit rows;
  paused-by lines read pause_state; defaults tuple round-trips.
- Session list glyphs per pause kind.

**Playwright e2e (ported subset, re-worded):**
- budget-honesty: filters drive the queried params; heading describes
  filters; report survives slow loads.
- a4r ports: chart axes/date ranges; paused band → focuses the causing
  provider; withheld specs are DELETED (no withheld case remains).
- New: create-provider (admin + personal) end-to-end; allowance edit
  warns on lowering past current spenders.

**Live-drive gate (scripted dev portal, personas):**
- The end-to-end arc once per phase 6+: limit → overshoot → pause →
  raise → resume answers the stashed prompt (the parked branch's
  canonical arc), plus the allowance variant, plus the no-provider
  wait/revive variant, plus user-token-manager refusing admin verbs.

**Adversarial campaign (final phase):** non-overlapping scopes
(schema/accounting, surfaces, UX-hands-on), each agent given the live
DB recipe and required to file a repro per finding — the parked
branch's recipe, which found 21 real defects after green suites.

## 9. Sequencing

| Phase | Contents | Gate |
|---|---|---|
| 1. Schema + windows | 0049 migration, procs, quota-windows port | proc tests + parity tests green |
| 2. Runtime | gate port, settle, wakes, pause_state, 1.0.69 freeze | SDK unit + schedule fingerprint green |
| 3. Catalog | provider-catalog.ts, config bridge + sync, credentials, create-path refusals, defaults | proc + unit green; live-drive create/refuse |
| 4. Surfaces | 17 HTTP ops + web-ops regen, MCP tools, agent tools substrate | parity test green |
| 5. Agents | token-manager permanent child; user-token-manager package | live-drive: admin verbs work; user verbs scoped |
| 6. Portal | the transplant per §7 | ui-core + playwright ports green; live-drive arc |
| 7. Campaign | red-first audit of §8 + adversarial pass | all findings fixed with repros pinned |

Estimate: phases 1–2 ≈ 2–3 days (mostly ports), 3–4 ≈ 2–3 days,
5 ≈ 1 day, 6 ≈ 2–3 days, 7 ≈ 1–2 days.

## 10. Deploy notes (when the time comes)

- Fresh-schema rule: any DB that ever ran the parked branch is wiped or
  reset first; the migration guard refuses `token_pools` remnants.
- Old images run zero enforcement (main has no gate) — a mixed fleet
  during rollout simply doesn't enforce on old pods; benign, converges.
- A deployment with BYOK-only Copilot (no shared credential) maps to:
  a github-copilot TYPE with no config instance; users instantiate
  personal providers.
- A fresh runbook is written at deploy time; the parked branch's
  runbook is obsolete and stays parked.
