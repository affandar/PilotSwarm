# Runtime Model Providers, Defaults, and System Routing

Status: PROPOSED (2026-08-22). No implementation is implied by this document.

This specification replaces the credential-bootstrap and default-model portions
of [providers-and-budgets.md](providers-and-budgets.md) and
[providers-and-budgets-plan.md](providers-and-budgets-plan.md). Provider budgets,
usage meters, holds, and allowances remain unchanged.

## 1. Summary

PilotSwarm currently spreads model choice across static catalog configuration,
session creation, provider admission, and worker-side model normalization. A
session can reach durable orchestration with a null or bare model and only later
be mapped to the provider and model that actually execute the turn. Static
provider configuration also mixes three different concerns:

1. Provider types and model capabilities.
2. Runtime provider credentials.
3. Session and system defaults.

The replacement model has four rules:

1. The static model catalog describes provider types and models only.
2. Runtime provider instances own credentials and are managed through APIs.
3. Trusted session creation resolves and persists an exact `provider:model`
   before orchestration starts.
4. Ordinary-session defaults and system-session defaults are separate settings
   with separate management APIs.

A personal BYOK provider remains private to its owner. An administrator may
explicitly enable their own personal provider for system-session use. This does
not make it visible or usable by other users.

## 2. Goals

- Persist the actual qualified model every session will run before its
  orchestration starts.
- Make the worker verify and execute a model decision, never make a second
  model-selection decision.
- Move credentials and defaults out of the static type catalog.
- Support shared cluster providers, personal BYOK providers, and deployments
  with only personal BYOK providers.
- Let administrators use their own personal provider for global system
  sessions without granting it to other users.
- Give ordinary sessions and system sessions independent defaults.
- Preserve per-system-agent model overrides.
- Let a system-default change optionally restart inheriting system sessions
  using Complete, Terminate, or Hard Delete disposition.
- Define deterministic behavior when no explicit default exists.
- Provide safe, idempotent bootstrap choices for test, personal, and shared
  deployments.
- Provide a reversible migration from legacy per-user and synthetic-System
  GitHub Copilot keys.
- Move provider/default management into the Admin Console while leaving the
  budget surface focused on usage policy and spend.

## 3. Non-goals

- Provider failover during a turn.
- Automatically switching an existing ordinary session when a default changes.
- Letting one user consume another user's personal provider.
- Making an administrator's personal provider generally available to cluster
  users.
- Exposing credentials through read APIs, logs, events, or audit payloads.
- Replacing provider budgets, meters, allowances, or holds.
- Choosing a model based on cost, latency, or availability telemetry.

## 4. Terminology

### 4.1 Provider type

A static catalog entry that describes an adapter and the models it can serve:

```jsonc
{
  "id": "azure-openai",
  "type": "openai",
  "models": [
    {
      "name": "gpt-5.4",
      "supportedReasoningEfforts": ["medium", "xhigh"],
      "defaultReasoningEffort": "medium"
    }
  ]
}
```

A provider type has no runtime credential and is not itself spendable.

### 4.2 Provider instance

A runtime row with a unique provider name, one provider type, a credential, an
ownership class, and policy:

```text
azure-prod:gpt-5.4
^^^^^^^^^^ provider instance
           ^^^^^^^ model declared by its provider type
```

Provider instances are either:

- `shared`: administered at cluster scope and usable by ordinary users.
- `personal`: owned by one user and usable only by that user, except for the
  explicit system-use rule in section 8.

### 4.3 Qualified model

The exact stable model identity persisted on a session:

```text
<provider-instance-name>:<model-name>
```

A new executable session never stores null or a bare model alias.

### 4.4 Session default

The model tuple used for new ordinary sessions when the caller does not request
one. There is one cluster setting and an optional override per user.

### 4.5 System model default

The model tuple used for global system sessions that do not have a per-agent
override. It is cluster-scoped and admin-managed.

### 4.6 System-agent override

A persistent model tuple for one deterministic system-agent id. It outranks the
system model default.

### 4.7 System-enabled personal provider

A personal provider owned by an administrator whose `system_use_enabled` flag
was deliberately set. Global system sessions may consume it. Ordinary users
other than its owner may not.

## 5. Core invariants

1. `sessions.model` is a qualified model before orchestration start.
2. The trusted server is the only model-selection authority.
3. A browser or remote SDK may request a model but cannot resolve user/provider
   scope authoritatively.
4. The worker executes the session's stamped model or refuses/waits. It does not
   silently choose another model.
5. Changing a default affects future sessions only, except when
   `setSystemModelDefault` explicitly requests system-session restarts.
6. A configured default that becomes invalid is an error. Automatic fallback is
   used only when no configured default exists.
7. Personal providers never become generally cluster-usable.
8. Enabling personal-provider system use grants execution only to system
   machinery. It does not expose the provider or credential to other users.
9. Existing provider credentials are never returned from an API.
10. Every management mutation is audited without credential material.

## 6. Static catalog contract

The long-term catalog shape contains provider types, models, capabilities, and
optional adapter defaults such as an intrinsic public base URL. It does not
contain:

- `apiKey`
- `githubToken`
- secret references
- `defaultModel`
- system-session defaults
- per-user defaults

Credential and `defaultModel` fields remain accepted during a compatibility
window as a legacy bootstrap source. New deployment templates and docs must not
teach them.

A type remains visible even when no runtime instance exists. This lets the
Admin Console offer "Add an Anthropic provider" before any Anthropic credential
has been supplied.

## 7. Ordinary-session model resolution

### 7.1 Precedence

Trusted `createSession` resolves in this order:

1. Explicit requested model.
2. Current user's configured session default.
3. Configured cluster session default.
4. First model of the first provider usable by the current user.
5. Refuse creation with `NO_USABLE_MODEL_PROVIDER`.

The result includes provider, qualified model, reasoning effort, and context
tier. It is persisted before orchestration start.

### 7.2 Explicit model normalization

The public API may accept:

- Exact `provider:model`.
- A bare model alias only when it maps to exactly one usable provider.

An ambiguous bare alias is rejected and the response lists qualified choices.
An unknown alias is rejected. The server never resolves by "first catalog
match" when two usable providers offer the same model name.

### 7.3 Default tuple resolution

A configured tuple is valid only when:

- The provider exists.
- The caller may use it.
- Its credential is usable.
- Its provider type still declares the model.
- Reasoning effort and context tier are supported.

A missing configured default invokes fallback. An invalid configured default is
reported loudly and does not fall through to another credential.

### 7.4 First-available ordering

Fallback must be deterministic:

1. Provider instances are ordered by `created_at`, then provider name.
2. Only instances usable by the caller participate.
3. Models follow declaration order in the provider type catalog.

The effective fallback is returned by defaults/status APIs with source
`first_available`. Once selected for a session, it is stamped and unaffected by
later ordering or default changes.

### 7.5 Persistence boundary

The authoritative session-create procedure validates provider usability and
inserts the exact tuple atomically. At minimum the session stores:

- `model`: exact qualified model.
- `reasoning_effort`: resolved explicit/default/catalog value.
- `context_tier`: resolved explicit/default/catalog value.

A `session.model_resolved` event records the non-secret resolution source:

```json
{
  "model": "azure-prod:gpt-5.4",
  "source": "user_default"
}
```

Valid sources are `explicit`, `user_default`, `cluster_default`, and
`first_available`.

### 7.6 Worker contract

The worker receives the persisted tuple and performs only execution-time
checks:

- Provider still exists.
- Provider remains usable for the session owner.
- Credential resolves.
- Provider type still declares the model.
- Adapter configuration can be built.

If the provider disappeared, provider admission returns `no_provider` and the
session waits. The worker must not substitute a cluster or personal default.

## 8. Personal BYOK and system use

### 8.1 Personal isolation

A personal provider is usable by its owner for ordinary sessions. No admin role
makes one user's personal provider available to another user.

### 8.2 Enabling system use

A personal provider may be system-enabled only when:

- The caller is an administrator.
- The caller owns the provider.
- The credential is currently usable.

The operation is explicit:

```ts
setProviderSystemUse({
  provider: "my-ghcp",
  enabled: true
})
```

Enabling creates an auditable system execution grant. It does not change the
provider class and does not add it to another user's provider list.

Enabling requires owner plus admin. Disabling may be performed by the owner or a
cluster admin after all system defaults/overrides that depend on it are removed.
This gives operators a way to stop machinery without allowing them to inspect
or rotate another user's credential.

Admin-role loss does not silently revoke an existing system grant. The grant is
durable cluster desired state and remains auditable until explicitly disabled.

### 8.3 Shared providers

Shared providers are system-eligible by default. They remain available to
ordinary users according to the existing shared-provider rules.

## 9. System-session model resolution

### 9.1 Precedence

A deterministic system agent resolves in this order:

1. Persistent override for its agent id.
2. Configured system model default.
3. First model of the first system-eligible provider.
4. Remain blocked with `NO_SYSTEM_MODEL_PROVIDER`.

System-eligible providers are:

- Shared providers.
- Personal providers explicitly enabled for system use.

The exact tuple is stamped when the system session is created or restarted.

### 9.2 Blocked system agents

A deployment may support personal BYOK ordinary sessions while having no
system-eligible provider. In that state:

- Management and provider onboarding remain available.
- Ordinary sessions continue where users have usable providers.
- System agents do not start and do not borrow a user's credential.
- Status surfaces report which agents are blocked and why.
- Adding a system-eligible provider triggers reconciliation.

### 9.3 Persistent per-agent overrides

System-agent overrides are desired state keyed by deterministic `agent_id`.
They survive system-session restart and worker replacement.

Changing an override updates desired state and uses the existing durable model
switch for a live system session. It does not expose a `restartExisting` option.
An operator who wants a fresh session may invoke the existing
`restartSystemSession` operation separately.

## 10. Data model

### 10.1 Provider instances

Extend provider instances with:

```sql
system_use_enabled     boolean not null default false,
system_use_enabled_by  bigint,
system_use_enabled_at  timestamptz
```

The immutable provider name is its only label and the prefix used in
`provider:model` references.

### 10.2 Session defaults

Existing cluster and user default columns remain the ordinary-session defaults:

```text
provider_cluster_settings.default_*
users.default_*
```

They no longer control system sessions.

### 10.3 System default

Add to cluster settings:

```sql
system_default_provider   text,
system_default_model      text,
system_default_reasoning  text,
system_default_context    text,
system_default_updated_by bigint,
system_default_updated_at timestamptz
```

### 10.4 System-agent overrides

Add:

```sql
system_agent_model_overrides (
  agent_id          text primary key,
  provider_name     text not null,
  model_qualified   text not null,
  reasoning_effort  text,
  context_tier      text,
  updated_by        bigint not null,
  updated_at        timestamptz not null default now()
)
```

A stored procedure validates the provider against system eligibility before
insert/update.

### 10.5 Dependency rules

- A personal provider cannot disable system use while a system default or
  override references it.
- A provider referenced by any configured default/override cannot be deleted
  without an explicit dependency-clearing operation.
- Removing a provider never silently retargets existing sessions.
- Defaults that reference removed provider types become invalid and are surfaced
  to operators.

## 11. Management APIs

All operations land first on `PilotSwarmManagementClient`, then Web API, then
MCP/CLI/Admin Console. Direct and Web modes must have parity.

### 11.1 Provider lifecycle

Existing APIs remain:

```ts
createProvider(...)   // shared, admin only
createMyProvider(...) // personal, current user
```

Add:

```ts
setProviderSystemUse({ provider, enabled })
```

Read models never return secret material. Provider rows include:

```ts
{
  name,
  type,
  class,
  mine,
  usableByMe,
  systemUseEnabled,
  systemEligible
}
```

### 11.2 Ordinary-session defaults

```ts
setModelDefault({
  scope: "user" | "cluster",
  provider: string | null,
  model: string | null,
  reasoningEffort?: ReasoningEffort | null,
  contextTier?: ContextTier | null
})
```

Rules:

- `user`: authenticated caller; provider must be usable by that caller.
- `cluster`: admin only; provider must be shared.
- `provider` and `model` are both null to clear the configured default.
- There is no `audience` field.
- There is no `restartExisting` field.

Changing this setting never changes an existing session.

### 11.3 System default

```ts
setSystemModelDefault({
  provider: string | null,
  model: string | null,
  reasoningEffort?: ReasoningEffort | null,
  contextTier?: ContextTier | null,
  restartExisting?: false | {
    disposition: "complete" | "terminate" | "hard_delete"
  }
})
```

Rules:

- Admin only.
- A personal provider must belong to the caller and be system-enabled.
- Null provider/model clears the explicit system default and exposes the
  deterministic system fallback.
- `restartExisting` appears only on this API.

The default is persisted before restarts begin. Only live system sessions that
inherit the system default are restarted. Per-agent overrides are excluded.

The response reports partial outcomes:

```ts
{
  configured,
  effective,
  restart: {
    requested: true,
    disposition: "terminate",
    affected: 4,
    restarted: 3,
    failures: [{ agentId, error }]
  }
}
```

Restart behavior delegates to the existing `restartSystemSession` operation:

- `complete`: Complete & Restart.
- `terminate`: Terminate & Restart.
- `hard_delete`: Hard Delete & Restart.

A partial restart failure does not roll back the new default or completed
restarts. Repeating the operation is safe.

### 11.4 Per-system-agent routing

```ts
setSystemSessionModel({
  agentId: string,
  provider: string,
  model: string,
  reasoningEffort?: ReasoningEffort | null,
  contextTier?: ContextTier | null
})

clearSystemSessionModel({ agentId: string })
```

These operations are admin-only and have no `restartExisting` field. The live
session receives the ordinary durable model-switch command when present. A
separate explicit restart remains available through `restartSystemSession`.

### 11.5 Default/status read

```ts
getModelDefaults()
```

Returns configured and effective ordinary/system defaults, their sources, and
per-agent overrides:

```json
{
  "userSession": {
    "configured": null,
    "effective": "my-provider:model-a",
    "source": "first_available"
  },
  "clusterSession": {
    "configured": "shared-provider:model-b"
  },
  "system": {
    "configured": "shared-provider:model-c",
    "effective": "shared-provider:model-c",
    "source": "system_default"
  },
  "systemOverrides": []
}
```

## 12. Bootstrap options

The process that supplies credentials is responsible for setting defaults. The
static type catalog does not predict which runtime providers will exist.

### 12.1 Option A: post-deploy API provisioning (recommended)

Deployment automation starts the management plane, then calls idempotent admin
APIs:

```text
createProvider
setModelDefault(scope=cluster)       optional
setSystemModelDefault                optional
verify getModelDefaults
start/reconcile workers
```

A deployment helper may expose one transaction-shaped command around these APIs,
but the canonical behavior remains in the management client.

Use idempotency keys or upsert semantics so interrupted deployment can resume.
Credentials must be supplied through the deployment's secret channel and never
written to rendered manifests or logs.

### 12.2 Option B: interactive Admin Console

A personal or small deployment may start with no provider. An administrator:

1. Adds a shared provider or their own personal BYOK provider.
2. Sets the ordinary default if desired.
3. Enables their personal provider for system use if desired.
4. Sets the system default.
5. Starts/reconciles system agents.

### 12.3 Option C: automatic first-available fallback

When providers exist but no default was configured:

- Ordinary sessions select the first usable provider/model.
- System sessions select the first system-eligible provider/model.

The effective choice is shown before session creation and persisted on creation.
This option is suitable for single-provider test and personal deployments.

### 12.4 Option D: BYOK-only deployment

The type catalog exists but no shared provider is provisioned. Each user adds a
personal provider. Ordinary sessions work through explicit choice, user default,
or personal first-available fallback.

System agents remain blocked unless an administrator enables their own personal
provider for system use and selects it, or a shared provider is later added.

### 12.5 Option E: legacy static seed compatibility

During transition, credential references and `defaultModel` in the static catalog
may be consumed once and translated through the same runtime provider/default
APIs. This path must be:

- Explicitly marked legacy.
- Idempotent.
- Audited.
- Disabled in new deployment templates.
- Removed after the compatibility window.

It must not maintain a second long-lived source of truth.

### 12.6 Bootstrap sequencing

System agents must not race provider provisioning:

```text
migrations
-> management API ready
-> provider/default provisioning
-> routing verification
-> worker ready
-> system-agent reconciliation
```

Workers may start before provisioning but system agents remain blocked until
routing resolves. No worker falls back to a credential unknown to the provider
store.

## 13. Deployment scenarios

### 13.1 Offline/unit deployment

No runtime providers. Pure tests run. LLM preflight fails quickly. System agents
remain blocked.

### 13.2 Local integration test

The harness provisions one shared test provider. Defaults may be omitted to test
first-available fallback or explicitly set to test default precedence. Cleanup
removes the isolated schema.

### 13.3 Personal unauthenticated appliance

One shared provider is provisioned for the trusted operator. With no explicit
default, its first model serves ordinary and system sessions. Personal-provider
APIs require a stable user identity and are unavailable in anonymous mode.

### 13.4 Personal authenticated BYOK

The user creates a personal provider and optionally sets a user default. If the
user is an administrator, they may enable that provider for system use and set
the system default. It remains unavailable to other users.

### 13.5 Shared deployment with central credentials

Administrators provision one or more shared providers, then independently set
cluster-session and system defaults. Users may add personal providers and user
defaults.

### 13.6 Shared BYOK-only deployment

No shared provider exists. Users create personal providers. Ordinary sessions
work. System agents remain blocked until an administrator explicitly enables
their own provider for system use.

### 13.7 Shared BYOK with system machinery

An administrator creates a personal provider, enables system use, and sets it as
the system default. Other users cannot list or use it. Per-agent overrides may
still use shared or other system-eligible providers.

### 13.8 Mixed-cost routing

Cluster ordinary sessions use a general shared provider. System sessions use a
cheaper shared or admin-owned provider. High-capability system agents receive
per-agent overrides.

### 13.9 Multiple providers without defaults

The deterministic first-available rules select one provider/model and stamp it.
The defaults read API explains the source. Operators may set explicit defaults
to eliminate ordering dependence.

### 13.10 No system-eligible provider

Ordinary personal sessions continue. System agents report blocked status. Once a
system-eligible provider appears, reconciliation can start them without a data
reset.

## 14. Admin Console UX

Provider lifecycle and model routing move out of Providers & Budgets.

### 14.1 Navigation

```text
Model Providers
  My Providers
  Shared Providers                   admin only

Agent Packages
Workers
```

My Providers contains personal credentials and My Session Default. Shared
Providers contains shared credentials, Cluster/System defaults, and System
Agent Overrides. They are separate pages, not one scrolling form.

The portal and native TUI share controller/reducer/selector behavior. Host-only
rendering differences remain permitted.

### 14.2 Provider onboarding

The GitHub-specific key editor becomes:

```text
Add GitHub Copilot provider
```

Equivalent forms exist for other provider types. Secret inputs remain masked and
are cleared from UI state after submission.

An admin-owned personal provider displays:

```text
[ ] Allow system sessions to use this provider
```

There is no "allow cluster use" control.

### 14.3 Cluster session default

Admin-only. Picker contains shared providers only. No restart controls appear.

### 14.4 User session default

Picker contains shared providers and the caller's personal providers. It does not
show another user's provider.

### 14.5 System default

Admin-only picker contains:

- Shared providers.
- Calling admin's personal providers with system use enabled.

After selection:

```text
Apply to existing inheriting system sessions?

- Future starts only
- Complete & Restart
- Terminate & Restart
- Hard Delete & Restart
```

The dialog previews affected agents and excludes per-agent overrides.

### 14.6 System-agent overrides

A table shows effective routing and source:

```text
Agent          Effective model                  Source
Sweeper        shared-a:model-x                 system default
Tuner          admin-personal:model-y           agent override
```

Changing an override uses durable model switch. Restart is a separate explicit
session action.

### 14.7 Budget surface

Providers & Budgets retains:

- Usage meters.
- Limits.
- Allowances.
- Holds.
- Paused sessions.
- Usage history.

Provider/default badges may remain read-only and link to Admin. Provider create,
delete, credentials, system enablement, and default editing leave this surface.

## 15. Legacy credential migration

### 15.1 Per-user GitHub Copilot keys

For every user with a legacy key:

1. Create one personal provider of the GitHub provider type.
2. Use a deterministic globally unique provider id, not an email address.
3. Use the provider id as its only visible name.
4. Copy the credential inside the database transaction; never return it to the
   migration client.
5. Do not set a user default automatically. Legacy users currently inherit the
   cluster default unless they explicitly choose a GitHub model.
6. Rewrite active legacy qualified references to the new personal provider where
   ownership and model are unambiguous.
7. Retain the legacy key column during a dual-read rollback window.

No migration output contains key text, hashes, or lengths.

### 15.2 Synthetic System key

A synthetic System key has no natural personal owner. It is not automatically
assigned. An administrator explicitly claims it through an admin-only migration
operation:

```ts
adoptLegacySystemGitHubCopilotKey({
  providerName
})
```

The operation:

- Verifies a legacy System key exists.
- Creates a personal provider owned by the calling admin.
- Copies the credential entirely server-side.
- Enables system use.
- Does not make it cluster-usable.
- Records audit provenance.
- Leaves the old key during verification.

The admin then sets the system default/overrides. Only after validation is the
legacy System key cleared.

### 15.3 Existing sessions

- New sessions always stamp new provider-instance identities.
- Active sessions using a legacy type-name reference are rewritten only when an
  owner-specific destination is unambiguous.
- SessionManager's catalog-authoritative reconciliation adopts the rewritten CMS
  model on the next turn.
- Completed session and turn-metric history keeps original model labels.
- A session with no migration target waits rather than silently switching.

### 15.4 Rollback

During the compatibility window:

- Legacy keys remain available for read fallback.
- New provider rows carry a migration marker.
- Defaults/overrides can be restored from a metadata-only snapshot.
- Rollback disables new-provider reads before deleting no data.
- Legacy keys are cleared only in a later, separately approved cleanup release.

## 16. Observability and audit

Record:

- Provider created/deleted.
- System use enabled/disabled.
- Session default changed/cleared.
- System default changed/cleared.
- System-agent override changed/cleared.
- System restart rollout requested and per-agent outcome.
- Legacy key migration/adoption outcome.

Never record credential values or hashes.

Operator status includes:

- Effective user/cluster/system defaults and source.
- Invalid configured defaults.
- Blocked system agents.
- System sessions still using a previous default after a future-only change.
- Providers with system use enabled.

## 17. Test plan

### 17.1 Catalog separation

- Catalog with no credential fields loads every provider type/model.
- Removing `defaultModel` does not prevent provider onboarding.
- Legacy credential/default fields translate through compatibility bootstrap.
- New templates contain no credentials or defaults.
- Provider type removal leaves runtime provider visibly invalid rather than
  silently changing adapter.

### 17.2 Ordinary model resolution

- Exact qualified request is stamped unchanged.
- Unique bare alias resolves and stamps the exact provider.
- Ambiguous bare alias is rejected with qualified alternatives.
- Unknown model is rejected before orchestration start.
- User default overrides cluster default.
- Cluster default applies when user default is absent.
- First usable provider/model applies when both defaults are absent.
- No usable provider refuses creation.
- Invalid user default fails loudly; it does not use cluster fallback.
- Invalid cluster default fails loudly; it does not use first available.
- Personal provider is usable only by its owner.
- Default changes do not affect existing ordinary sessions.
- CMS row contains exact model before `startOrchestrationVersioned` is called.
- Worker uses the stamped model and performs no independent selection.
- Direct and Web API clients produce identical stamped tuples.

### 17.3 Reasoning/context resolution

- Explicit supported value wins.
- Default tuple value applies when explicit value is absent.
- Catalog model default applies when tuple value is absent.
- Unsupported value is rejected before session creation.
- Context capacity metadata follows the selected provider type/model.

### 17.4 Personal BYOK isolation

- User creates and runs their personal provider.
- Another user cannot list, resolve, select, or infer it.
- Admin cannot use another user's personal provider for an ordinary session.
- Credential never appears in read responses/events/logs.
- Credential rotation rebinds warm sessions on next turn.
- Deleting provider reports dependent sessions/defaults.

### 17.5 System-use grant

- Non-admin owner cannot enable system use.
- Admin cannot enable another user's provider.
- Admin owner can enable their provider.
- Enabled provider appears only in system pickers, not other users' pickers.
- System session resolves its credential successfully.
- Disable is refused while defaults/overrides reference it.
- Disable succeeds after dependencies are removed.
- Role loss does not silently revoke an existing grant.
- Audit identifies actor/provider/action without credential data.

### 17.6 Session default API

- User scope accepts caller-owned personal or shared provider.
- User scope rejects another user's provider.
- Cluster scope requires admin.
- Cluster scope rejects personal providers, including caller-owned ones.
- Null tuple clears configured default.
- No `audience` parameter exists.
- No `restartExisting` parameter exists.
- Management client, protocol, Web client, MCP, CLI, and Admin UI stay in parity.

### 17.7 System default API

- Requires admin.
- Accepts shared provider.
- Accepts calling admin's system-enabled personal provider.
- Rejects personal provider without system enablement.
- Rejects another user's personal provider.
- Null tuple clears explicit default and exposes deterministic fallback.
- Future-only change leaves current sessions untouched and reports them.
- `complete` restarts inheriting sessions through Complete & Restart.
- `terminate` restarts inheriting sessions through Terminate & Restart.
- `hard_delete` restarts inheriting sessions through Hard Delete & Restart.
- Per-agent overrides are excluded from global restart.
- Partial restart failure is reported and retry-safe.
- Persisted default survives process/worker restart.

### 17.8 Per-system-agent overrides

- Override outranks system default.
- Clear returns agent to system default/fallback.
- Unknown agent id is rejected.
- Ineligible provider is rejected.
- Live session receives durable model switch.
- Override survives all three explicit restart dispositions.
- API has no `restartExisting` parameter.

### 17.9 System bootstrap

- Shared provider with no default selects first model and starts agents.
- Admin personal provider with system enabled can start agents.
- Personal provider without system enabled cannot start agents.
- No eligible provider leaves agents blocked while management stays usable.
- Provider appearance triggers reconciliation exactly once.
- Concurrent workers start one deterministic session per agent.
- Invalid configured system default blocks loudly instead of falling back.

### 17.10 Bootstrap options

For API provisioning:

- Fresh deployment provisions provider and defaults idempotently.
- Crash after provider create can safely resume defaults.
- Secrets never appear in command output or rendered manifests.
- System reconciliation waits until routing verification.

For interactive bootstrap:

- Empty deployment opens Admin provider onboarding.
- First provider immediately appears in effective fallback.
- System enablement remains explicit.

For legacy static seed:

- First run translates exactly once.
- Concurrent processes claim once.
- Deleted translated provider is not recreated on restart.
- Invalid default does not leave a half-claimed bootstrap.

### 17.11 Legacy key migration

- One personal provider per populated regular-user legacy key.
- Empty keys create no provider.
- Duplicate credential values remain separate personal providers without
  exposing duplication.
- Deterministic naming is collision-safe and idempotent.
- Existing user default is not changed.
- Active legacy GitHub sessions rewrite to their owner's provider.
- Sessions without owner/key are not rewritten.
- Synthetic System key requires explicit admin claimant.
- Claim creates admin-owned, system-enabled personal provider.
- Legacy keys remain during dual-read period.
- Rollback restores old reads without deleting provider rows.
- Final cleanup clears old keys only after explicit gate.

### 17.12 Admin UX

- Provider/default controls no longer appear in budget mutation UI.
- Admin tree exposes My Providers/My Default to users.
- Cluster/system controls render only for admins.
- Secret fields are masked and cleared after save/cancel.
- GHCP copy refers to adding a personal GitHub Copilot model provider.
- System toggle clearly states that other users do not gain access.
- System default picker filters eligibility correctly.
- Restart preview excludes overridden agents.
- All three restart dispositions require confirmation.
- Portal and native TUI selectors/controller behavior match.

### 17.13 Security/adversarial tests

- Forged owner id cannot create provider in another namespace.
- Forged `system_use_enabled` field in create payload is ignored/refused.
- Non-admin cannot call cluster/system mutations over direct or Web API.
- Web API actor is server-derived, never body-derived.
- Another admin cannot read or rotate a personal credential.
- System execution does not make personal provider discoverable to users.
- Deleted/disabled credential fails closed before network call.
- Audit and error text do not disclose whether another user's provider exists.

### 17.14 Concurrency and failure tests

- Provider deletion racing session creation either stamps a valid model or
  returns a clean refusal; it never starts an unstamped session.
- Default change racing session creation yields one complete old/new tuple.
- System default restart racing another worker is idempotent.
- Partial restart can resume without restarting successful agents again.
- Credential rotation during a turn affects the next turn only.
- Database outage during resolution creates no session/orchestration split.

### 17.15 Deployment-scenario matrix

Run explicit end-to-end scenarios for every deployment in section 13:

| Scenario | Required assertions |
|---|---|
| Offline/unit | Fast no-provider failure; no system sessions |
| Local integration | Isolated provider/default bootstrap and cleanup |
| Personal unauthenticated | Shared first-available serves user and system |
| Personal authenticated BYOK | Private use; optional admin system use |
| Shared central credentials | User override beats cluster; system independent |
| Shared BYOK-only | Ordinary users work; system blocked until enabled |
| BYOK plus system | Admin provider powers system, remains private |
| Mixed cost | Separate ordinary/system defaults plus agent override |
| Multiple/no defaults | Deterministic fallback and stamped identity |
| No system provider | Visible block then successful reconciliation |

### 17.16 Release gates

- SDK TypeScript build.
- Management/Web/MCP surface-parity tests.
- Full baseline provider integration suite.
- Full enhanced-provider integration suite.
- Portal Playwright provider/default/restart flows.
- Native TUI admin-console selector/controller tests.
- Package dry-runs include updated docs and generated operation methods.

## 18. Rollout phases

1. Add schema, resolution APIs, and read-only Admin views.
2. Stamp exact models for all new ordinary sessions.
3. Add provider lifecycle and ordinary defaults in Admin.
4. Add system-use grants, system default, and per-agent overrides.
5. Add optional system-default restart rollout.
6. Migrate legacy per-user keys under dual read.
7. Migrate/claim legacy synthetic System keys.
8. Remove provider/default editing from budget surface.
9. Deprecate static credentials/defaults in templates and docs.
10. After a measured compatibility window, clear legacy keys and remove legacy
    static bootstrap.

## 19. Acceptance criteria

- Every newly created session has an exact qualified model before orchestration
  start.
- Worker-side code contains no fallback model-selection branch for a stamped
  session.
- A user can run a personal BYOK-only deployment without static credentials or
  defaults.
- An admin can power system sessions with their own provider without exposing it
  to other users.
- Ordinary and system defaults are independently configurable.
- System-default rollout offers future-only and all three restart dispositions.
- Existing per-agent system routes survive migration.
- Legacy key migration is idempotent, audited, secret-safe, and reversible.
- The full deployment-scenario and provider test matrices pass.
