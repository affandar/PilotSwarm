# Cluster and user feature flags

Status: proposed; no feature-flag implementation or CHK deployment in this change.

## Definitions and resolution

Feature flags are authored **only in code** and published into a `feature_flags`
catalog table by versioned CMS migrations. The code-owned manifest specifies each
key, label, description, default enabled value, default `allowUserOverride`, and
required runtime capability. The table is the persisted catalog of those released
definitions; it is not an admin-editable registry. Administrators and agents change
only rows in `feature_flag_settings`. First key: `copilot.native_tasks`, with
code-authored defaults `enabled: false, allowUserOverride: false`.

| Scope | Stored setting | Who can change it |
| --- | --- | --- |
| Cluster | `enabled: boolean`, `allowUserOverride: boolean` | Admin |
| User | `enabled: boolean`; absent means inherit | Admin for any user; user for themselves |

There are no per-session settings or hard modes. Resolution is:

```text
cluster = saved cluster settings, otherwise defaults from the published catalog
if cluster.allowUserOverride and user setting exists:
    return user.enabled
return cluster.enabled
```

Use presence checks: a saved `false` overrides a cluster `true`. Unsetting a user
entry restores inheritance. Resetting a cluster entry restores both code defaults.
Turning `allowUserOverride` off preserves user entries but ignores them, including
entries set by an admin. Turning it back on makes those entries effective again.
Users may save/reset their own preference while overrides are disabled; the result
must clearly say that cluster policy still determines the effective value.

| Cluster enabled | Allow user override | User setting | Effective |
| --- | --- | --- | --- |
| off | false | on | off |
| on | false | off | on |
| off | true | on | on |
| on | true | off | off |
| off | true | inherit | off |

The effective flag does not supply missing worker capabilities or bypass existing
permissions and system-session restrictions. For native tasks, deployment
`PILOTSWARM_NATIVE_SUBAGENTS=off` remains a runtime cap; enabled maps to `sync` on
capable, eligible workers. Return effective policy separately from runtime
availability, with a reason when unavailable.

## Identity and storage

Each cluster stores its settings in its shared CMS namespace. The portal, MCP,
management client and every worker use the same store. Separate clusters must not
share settings merely because a person has the same identity in both.

Resolve the user from the session's persisted owner, not its viewer, last sender,
or worker identity. Durable children inherit that owner through the existing
spawn ownership path. Native tasks use their calling session's decision. Sessions
store only observations of the applied policy, never configurable flag overrides.
Ownerless/system sessions have no human user entry and retain their eligibility
restrictions.

## Overall schema changes

**Two new tables:** `feature_flags` for the code-published catalog, and
`feature_flag_settings` for all cluster/user values. Reuse existing `authz_audit`
for history and `fleet_directives` for the polling epoch. No separate cluster,
user, change-history, or session-settings tables.

```sql
CREATE TABLE feature_flags (
    feature_key                 TEXT PRIMARY KEY,
    display_name                TEXT NOT NULL,
    description                 TEXT NOT NULL,
    default_enabled             BOOLEAN NOT NULL,
    default_allow_user_override  BOOLEAN NOT NULL,
    required_capability         TEXT
);

CREATE TABLE feature_flag_settings (
    setting_id           BIGSERIAL PRIMARY KEY,
    feature_key          TEXT NOT NULL REFERENCES feature_flags(feature_key),
    scope                TEXT NOT NULL CHECK (scope IN ('cluster', 'user')),
    user_id              BIGINT REFERENCES users(user_id),
    enabled              BOOLEAN NOT NULL,
    allow_user_override  BOOLEAN,
    revision             BIGINT NOT NULL,
    updated_by           TEXT NOT NULL,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (scope = 'cluster' AND user_id IS NULL
                           AND allow_user_override IS NOT NULL)
        OR
        (scope = 'user' AND user_id IS NOT NULL
                       AND allow_user_override IS NULL)
    )
);

CREATE UNIQUE INDEX feature_flag_settings_cluster
    ON feature_flag_settings(feature_key) WHERE scope = 'cluster';
CREATE UNIQUE INDEX feature_flag_settings_user
    ON feature_flag_settings(feature_key, user_id) WHERE scope = 'user';
CREATE INDEX feature_flag_settings_by_user
    ON feature_flag_settings(user_id) WHERE scope = 'user';
```

The real migration qualifies tables with the cluster's CMS schema. Separate partial
unique indexes avoid the nullable-user uniqueness trap for cluster rows. The check
constraint prevents a user setting from supplying its own override permission.
Foreign keys reject nonexistent flags/users; deletions use an explicit controlled
path rather than silent cascading settings away without an epoch change.

Example rows in `feature_flag_settings`:

| Feature | Scope | User ID | Enabled | Allow user override |
| --- | --- | --- | --- | --- |
| copilot.native_tasks | cluster | NULL | false | true |
| copilot.native_tasks | user | 42 (illustrative) | true | NULL |

Deleting a user row means inherit. Deleting a cluster row restores that flag's
published defaults. There is no need to materialize a row for every flag/user pair.

### Publishing the catalog from code

Versioned migrations insert/update catalog rows from the code manifest; contract
tests check that the manifest and migration output match. Catalog changes bump the
same feature epoch as setting changes. They do not overwrite settings. There is
no create/update/delete-definition API or tool, and workers never upsert their
compiled catalog at startup: an older worker must not roll back newer metadata.

Snapshots include the published catalog and settings, so every worker uses the same
deployed defaults even during a rolling update. A worker evaluates only keys and
capabilities implemented by its build; unknown flags are reported as unsupported.
A required catalog row missing from CMS means incomplete deployment, not implicit
permission to enable the feature. Native tasks remain off until that is resolved.
Reset returns to code-authored, migration-published defaults, not potentially
older defaults baked into whichever worker happened to receive the session.

### Change propagation and audit

Keep the existing physical name `fleet_directives`; public feature APIs and UI use
**cluster**. Seed its global `feature-flags` row with epoch 1, worker actuation and
an empty desired payload. Constrain this domain to `pool='*', worker_node_id='*'`:
feature policy has cluster/user scope, never per-pool or per-worker policy. Flag
changes bump only this domain, not the package epoch.

Each successful setting mutation is one transaction: resolve/check actor and
published/supported key, lock the feature directive, recognize an identical retry,
check `expectedEpoch`, update/delete the scoped setting, bump epoch, and append an
`authz_audit` event. Row `revision` is the resulting epoch; return 409 on a stale
expected epoch. Reset/unset also bumps the epoch, so worker caches remove entries.
One epoch serializes the initial low-volume settings writes and handles reset races
without a tombstone table.

Use audit actions `feature_flag.set` / `feature_flag.unset`; keep scope, feature key,
target user, before/after, epoch, canonical request hash and returned result in
`details`. Existing actor/session/time fields identify who made the change.
`updated_by` and audit actors are server-derived, never caller-claimed authority.
The service calls the audit insert inside its transaction, not through the existing
fire-and-forget management wrapper. An audit failure rolls back the setting.

For retry receipts, add a partial unique expression index on existing audit
`details` `(actorKey, requestId)` for successful feature-flag setting events. The
mutation path always populates both from a trusted actor and supplied request ID;
validate the request hash before returning a previous result. Different input with
the same ID fails. After audit retention removes a receipt, the original
`expectedEpoch` still prevents an old retry from replaying its write; return a
conflict and let the client read current state. No third feature table is needed.

The internal read returns **epoch + catalog + scoped settings in one consistent
database snapshot**, including stable owner lookup keys so runtime resolution adds
no identity lookup. Split scoped rows into immutable cluster/user maps in memory.
Full snapshots on changed epochs cover deletes and missed polls; public reads stay
caller-scoped. Failed snapshot reads leave the last good cache intact.

## One API contract across all surfaces

Expose the complete operation set through the direct management client, Web API
and client/transport adapters, and MCP tools. Reuse one service/store implementation
for validation, authorization, resolution and audit; no surface has a privileged
shortcut. MCP direct mode requires a trusted configured admin context for admin
operations; self operations require an actual user principal. Web mode derives the
principal from authentication, never from a claimed body field.

| Operation | Access |
| --- | --- |
| List registered flags and read cluster/effective settings | Authenticated; other users' settings require admin |
| Set/reset cluster flag (`enabled`, `allowUserOverride`) | Admin |
| Read/set/unset my user flag | Authenticated user, target derived from identity |
| Read/set/unset a selected user's flag | Admin |
| Read change audit | Admin |

Suggested shared methods: `listFeatureFlags`, `getClusterFeatureFlags`,
`setClusterFeatureFlag`, `resetClusterFeatureFlag`, `getMyFeatureFlags`,
`setMyFeatureFlag`, `unsetMyFeatureFlag`, `getUserFeatureFlags`,
`setUserFeatureFlag`, `unsetUserFeatureFlag`, `listFeatureFlagChanges`.
Proposed Web routes below are relative to `/api/v1`:

| Method and route | Operation |
| --- | --- |
| GET `/management/features/catalog` | List code-published definitions |
| GET `/management/features/cluster` | Read cluster settings/defaults |
| PUT / DELETE `/management/features/cluster/:featureKey` | Set / reset cluster settings (admin) |
| GET `/management/users/me/features` | Read my preferences and effective values |
| PUT / DELETE `/management/users/me/features/:featureKey` | Set / unset my preference |
| GET `/management/users/:userId/features` | Read a selected user's flags (admin) |
| PUT / DELETE `/management/users/:userId/features/:featureKey` | Set / unset a selected user's preference (admin) |
| GET `/management/features/changes` | Read feature-setting audit (admin) |

Register literal `me` ahead of user ID routes. MCP and agent tools use the shared
method names in snake case with equivalent arguments/results. Direct management
and Web adapters expose the same method set. Cluster updates save both booleans
atomically; mutations require request ID and expected epoch.
Responses include configured cluster/user values, effective value, winning scope,
configuration epoch, and whether a saved user preference is currently ignored.
Mutations return the committed epoch; worker adoption is reported separately.

## Admin and personal UX

Add **Feature flags** as another tab in each user's detail view in the Admin UX.
An admin can select any user; a regular user sees the same component for themselves
in Settings. Each registered flag gets a row with its description, cluster value,
allow-user-override state, user preference (**Inherit / On / Off**), and effective
value. Inherit deletes the user entry; it is not a third stored boolean value.
When overrides are disabled, show **Controlled by cluster** and make clear that a
saved preference is inactive. Do not expose another user's settings to nonadmins.

Add **Cluster → Feature flags** for admins, with an On/Off control and an
**Allow user override** checkbox for each code-defined flag. Include reset to code
defaults. No UI for adding or deleting flag definitions. Use the existing shared
Admin/Settings controller and selectors so Web and terminal views share state.

## Agent tools

Build declarations and per-turn handlers from one feature-tool specification, as
provider tools do. Register the same operations for:

- The real worker-provisioned **Resource Manager** (`resourcemgr`), using its
  trusted cluster-management identity.
- Admin-owned **Agent Smith / Agent Manager** (`agent-manager`) sessions, acting
  as their persisted owner, with the owner's current admin role checked per call.
- The main root system session for the previously requested admin-assisted control,
  using its existing authenticated admin request/delegation path.

These tools change settings only for registry-defined flags. Agent names alone do
not grant authority; validate the persisted service identity or actual user owner.
Demoting an Agent Manager's owner revokes cross-user/cluster mutations immediately,
including on a warm session. Nonadmin Agent Manager sessions do not receive this
admin tool bundle. Native tasks and arbitrary descendants receive no feature
management authority. Direct callers still have ordinary self-service APIs.

## Worker polling and cache

The existing worker package loop defaults to **20 seconds**. It checks the package
epoch and reports a worker heartbeat; the heartbeat already returns effective
versioned directives from `fleet_directives`. The worker currently discards those
returned directives. Reuse this loop and returned directive set for feature flags.

1. At startup, load an initial feature snapshot before allowing enabled native
   work. If this fails, keep native tasks off and retry on the regular poll.
2. Each existing poll reports actual worker state and receives desired epochs for
   `agent-packages` and `feature-flags`. Unchanged flags cost no snapshot read.
3. On a changed feature epoch, fetch the consistent catalog/settings snapshot, validate
   it, build new maps, and swap one immutable cache reference. Mark only the epoch
   actually loaded, not an epoch observed earlier in a separate poll.
4. Package and feature refreshes have independent in-flight guards and error state.
   A slow or broken package download must not block subsequent feature polls.
   Do not hold a shared refresh lock while installing packages.
5. Turns and native admission hooks resolve flags **only from memory**. There are
   no feature-policy database reads, cache-miss fetches, or forced refreshes per turn
   or per task. Reads of owner identity already needed for session admission remain.

Refactor the current package-only timer into a common worker configuration poll.
Preserve its configured positive interval; default to 20 seconds. Run it for every
CMS-backed worker even if package installation is unconfigured or its refresh is
set to zero. Zero continues to disable package refresh only; it must not silently
disable flag convergence. Stop the common timer and settle/discard in-flight
refreshes during worker shutdown. Existing package epoch APIs remain compatible.

Use the existing worker heartbeat JSON, with no new worker columns:

```text
workers.info.consumes += 'feature-flags'
workers.state['feature-flags'] = {
  epoch, supportedKeys, protocolVersion: 1, lastCheckedAt, lastLoadedAt, lastError
}
```

Use the refreshed state for capability/adoption checks: `workers.info` is written
once, so it can describe an older build when a worker ID is reused. An epoch alone
does not prove that an older build understands a newly defined flag.

A failed poll preserves the last good snapshot and reports stale/error state;
workers without any successful snapshot keep native tasks off. Subsequent polls
retry, including a failed snapshot load when the desired epoch is unchanged. No
claim of immediate cluster-wide revocation: normal propagation is one poll interval
plus reload time; an outage delays it further. The UI shows committed policy versus
worker adoption. Existing native cancellations and deployment capability controls
remain available for operational intervention.

Portal/API setting reads may query CMS when requested and return newly committed
settings immediately. They do not imply that workers have applied them. Reuse the
existing admin refresh path to show adoption from worker heartbeat state; feature
correctness does not need a new push channel.

## Code changes sketch

| Area | Changes |
| --- | --- |
| `feature-flags.ts` (new) | Code-owned manifest and supported keys, pure resolver using published defaults, result/source types |
| `feature-store.ts` (new), CMS migration/catalog | Code-published flag catalog plus one scoped settings table; authorized mutations using existing audit/epoch infrastructure; consistent snapshot and caller-scoped reads |
| `feature-flag-cache.ts` (new) | Published definitions and immutable cluster/user maps, initialization/error state, one epoch-based refresh; synchronous `resolve(key, owner)` |
| `worker.ts` | Consume heartbeat directives in the existing polling loop, refresh package/feature domains independently, inject cache resolver, publish applied feature epoch |
| Management client, shared API protocol, Web adapters/router, MCP | Same list/read/set/reset/unset/audit operations and actor checks across surfaces; mutation result includes committed epoch |
| `feature-tools.ts` (new), tool registration/agent manifests | Shared schemas and handlers for Resource Manager, admin Agent Manager/Smith and root management path; authority checked for each mutation |
| Shared UI controller/selectors and Admin/Settings views | Cluster controls, per-user Feature flags tab and personal view; effective value and worker adoption |
| `session-manager.ts`, `native-subagents.ts`, `managed-session.ts` | Memory-only native eligibility, live cached admission guard, next-turn rebind, unchanged in-flight cleanup |

Illustrative worker flow (each refresh owns its guard and catches/reports errors):

```ts
async function pollWorkerConfiguration() {
  const directives = await reportWorkerState(); // existing heartbeat round-trip
  void featureCache.refreshIfChanged(epochFor(directives, 'feature-flags'));
  void refreshAgentPackagesIfChanged(epochFor(directives, 'agent-packages'));
}

function nativeAllowed(owner, sessionEligibility) {
  return nativeCapability === 'sync'
    && sessionEligibility
    && featureCache.resolve('copilot.native_tasks', owner).enabled;
}

function admitNativeTask(turn) {
  return turn.startedWithNative && !turn.nativeRevoked
    && nativeAllowed(turn.owner, turn.sessionEligibility);
}
// On a cache swap, latch nativeRevoked on any active turn now resolved OFF.
// Clear the latch only for a new turn; never alter in-flight task cleanup mode.
```

The polling request itself must not overlap without a bound; release its guard
before either asynchronous reload. A failed/absent directive response is not a
request to reset the cache. Startup explicitly awaits the initial feature load.
A cache reload swaps only a complete consistent snapshot and never downgrades to
an older epoch. Feature mutations still authorize against live identity/role state;
polling caches settings, not administrator privileges.

## Plan: move copilot.native_tasks onto feature flags

1. **Land catalog and scoped settings.** Define `copilot.native_tasks` in code with
   both defaults false, then publish it through the CMS migration. Add the two
   tables, directive seed/constraint and audit retry index; implement transactional
   scoped mutations and snapshot loading. Verify catalog/manifest parity, scope
   constraints, resolution's 12 combinations, authz, retries and reset races.
2. **Wire worker convergence.** Generalize the existing polling/heartbeat loop and
   inject the cache resolver into SessionManager. Test unchanged-epoch cost, startup,
   atomic swap, snapshot races, failed reload/retry, package failure independence,
   package-disabled workers and shutdown. Assert no flag DB reads on turn/task paths.
3. **Expose control surfaces.** Add management/Web/MCP parity, shared agent tools,
   cluster controls and user tab. Admins manage cluster/any user, users themselves;
   Agent Smith's admin status is rechecked. Test registration, permissions and UI.
4. **Gate the existing native spike.** In SessionManager combine deployment
   capability + existing session exclusions + the owner's cached flag decision.
   Reuse existing swarm profiles, named-agent restrictions, model inheritance,
   sync-only policy, inline task UI and event handling. The flag adds no new native
   executor and does not change durable `spawn_agent` availability.
5. **Handle running/warm sessions.** Native admission uses the live cache plus
   that turn's admitted mode and a local revocation latch. After a disabling
   snapshot is applied, reject new native admissions for the rest of the turn,
   even if a later snapshot re-enables the flag. Cache-swap notification must latch
   affected active turns even when no task call occurs during the OFF interval.
   Previously admitted natives finish with cleanup intact; do not mutate the turn's
   cleanup mode. The next turn clears the latch and uses the latest cached decision;
   existing mode-change rebind adds/removes schemas, profiles and guidance.
   An enable becomes callable on that next turn after the worker has refreshed.
6. **Validate locally with two workers.** Run the existing native/delegation suite,
   extend on/off new/warm/cold tests to cluster/user decisions, and run both actual
   durable/native filesystem smokes. Exercise changes during a turn, owner inheritance,
   background denial, cache lag and eventual adoption across workers. Use adversarial
   review for cache races, permissions and old-worker behavior.
7. **Stage CHK.** Apply schema, then deploy flag-aware code with native capability
   off. Configure the cluster/user values below. Verify all relevant workers report
   support and adoption before permitting native capability. Check requester/control
   behavior and rollback after polling; keep the rollout separate from this design.

The current prompt already explains native versus durable work. Flag enablement
selects the existing guidance; OFF must not advertise an available native tool.
Any required Agent Manager/Resource Manager tool-list or prompt edits get their
normal agent version bumps. Feature decisions stay outside deterministic
orchestrations; no orchestration version or session schema change is expected.

## Waldemort CHK rollout

1. Verify the actual cluster/subscription and requesting user's CMS identity.
2. Set `copilot.native_tasks` to cluster `enabled: false,
   allowUserOverride: true`; set the requesting user's preference to on. Leave
   other user entries absent. Eligible durable descendants use the same owner.
3. Deploy feature-aware portal and workers before enabling native runtime
   capability. Old workers interpret env `sync` cluster-wide, so keep it off there.
   Seed intended policies explicitly when migrating existing enabled deployments.
4. Check requester on and untouched control user off across two workers, plus
   actual tool admission, durable descendants and self-service changes.
5. For a cluster-wide stop, save `enabled: false, allowUserOverride: false` in one
   transaction, then verify worker epochs converge on subsequent polls. Keep env
   `off` as the independent runtime cap; an API success means saved, not applied.

This initializes only the requesting user as enabled, but it is **not an exclusive
allowlist**: any user may opt in while `allowUserOverride` is true. This follows
from the requested self-service model. Setting it false also ignores the requesting
user's override; an admin-set user entry has no special precedence.

## In-flight transition contract and test status

**Status: the feature-flag catalog, APIs, polling cache and transition tests below
are not implemented yet.** Existing committed native tests cover:

- `native-subagents-runtime.test.js`: OFF on new/warm/cold sessions with durable
  delegation preserved; saved ON→OFF cold resume rejects even a fabricated `task`
  call and removes native profiles/guidance; stopping a parent terminates its native
  child shell; ON sessions keep working through warm/cold reuse.
- `native-subagents.test.js`: mode-change rebind detection and cleanup/stop races,
  including a late timed-out cleanup result not cancelling a later turn's tasks.

Those do not establish live cluster/user flag propagation or OFF→ON execution.
The new implementation must pass this additional matrix before CHK rollout:

| Transition/test | Required result |
| --- | --- |
| ON→OFF while native A is executing | After the worker applies OFF, A finishes and its real process/tasks are cleaned up; new task B is rejected, parent turn continues |
| OFF→ON while a parent turn is executing | Current turn keeps its original OFF tool surface; next turn on the same session has native schemas/profiles/guidance and successfully executes native work |
| ON→OFF→ON with each epoch applied during one turn | OFF revokes further native admissions for that turn, even if no call was attempted while OFF; re-enable works on the next turn; no leftover tasks or duplicate profiles/guidance |
| ON/OFF round trips between turns | Execute successful native work, disable and prove denial, re-enable and execute again on the same warm session; repeat after eviction/cold resume |
| User On/Off/Inherit | Only that owner's sessions change; Inherit follows cluster; durable descendants use the owner, not a shared-session viewer |
| allowUserOverride false→true→false | Locked cluster values win; saved user preferences become active then inactive again without being deleted; test both cluster enabled values |
| Several writes before one poll | Worker applies the latest snapshot; intermediate values need not be observed. A transient OFF entirely between polls is not a guaranteed stop |
| Two workers at different polling points | Each follows its applied epoch; both converge after refresh. UI shows saved epoch, worker-applied epoch and next-turn activation accurately |
| Failed/stale/overlapping refresh | Last good cache survives; old completion cannot replace newer snapshot; failed load retries. Slow package install does not block flags |
| Prompt/stop during transitions | Existing message queue and stop behavior work; no stuck turn, lost input, implicit interruption or forced cancellation solely from a flag change |

Use real SDK/CLI execution with deterministic local inference and explicit barriers
(native A started, mutation committed, epoch applied, task B attempted), rather than
sleeping 20 seconds and hoping the race occurs. Drive the real poll callback with a
testable clock; instrument the store to prove zero feature DB reads on turn/task
paths. Add a two-worker CMS integration case for actual propagation and browser
checks for pending/effective state and self/admin editing.

The revocation latch is temporary execution state, not a session setting or database
column. It makes re-enable consistently take effect at a turn boundary while
allowing disable to take effect after a poll during a running turn.

## Implementation tests

- All 12 combinations: two cluster enabled states × two allow-user-override states
  × three user states (on/off/absent), plus defaults and reset/unset transitions.
- Preserved preferences when overrides are disabled/re-enabled; admin-written and
  self-written user entries resolve identically; no session override is accepted.
- Catalog/manifest parity, migration-only publication, unknown keys and blocked
  runtime definition creation; older workers never overwrite catalog metadata;
  published defaults during rolling updates and missing-catalog/read failures.
- Unified settings constraints: unique cluster row with NULL user, unique user row,
  cluster requires override permission, user forbids it, and valid foreign keys.
- Permission matrix on MCP, Web and direct management APIs: self versus another
  user, forged actor, admin cluster access, resource-manager identity, admin-owned
  Agent Manager and demotion. Read and audit privacy checks.
- Contract/tool registration parity across every surface, including both tool
  declarations and handlers; concurrent epochs, transactional existing-audit writes,
  duplicate request IDs and expired audit retry receipts.
- User Feature flags tab, personal Settings, cluster controls, inheritance,
  inactive-preference explanation and effective state after remote updates.
- Two workers, polling lag/failure/retry, package installation failure/disabled mode,
  atomic snapshot reload, no per-turn/task flag reads, ownership/shared viewers,
  warm/cold sessions, durable children and mid-turn disable after cache refresh.
- Independent feature/package epochs, ignored unknown directive domains, unchanged
  package epoch on flag mutations, and no feature scope outside cluster/user.
- CHK initial requester/control check and explicit control-user self opt-in;
  existing native/delegation filesystem suite.

## Existing code to extend

- [API protocol](../../packages/sdk/api/src/protocol.js),
  [Web router](../../packages/app/web/api/router.js),
  [management client](../../packages/sdk/src/management-client.ts),
  [Web management adapter](../../packages/sdk/src/web/web-management-client.ts),
  [MCP provider-tools pattern](../../packages/app/mcp/src/tools/providers.ts).
- [Admin and Settings UI](../../packages/app/ui/react/src/web-app.js),
  [controller](../../packages/app/ui/core/src/controller.js),
  [selectors](../../packages/app/ui/core/src/selectors.js).
- [Provider tool declarations/handlers](../../packages/sdk/src/provider-tools.ts),
  [Resource Manager tools](../../packages/sdk/src/resourcemgr-tools.ts),
  [Agent Manager tools](../../packages/sdk/src/agent-manager-tools.ts),
  [Agent Smith package](../../agent-packages/agent-manager/agents/agent-manager.agent.md).
- [Native assembly](../../packages/sdk/src/session-manager.ts),
  [native hooks](../../packages/sdk/src/native-subagents.ts),
  [mode rebind](../../packages/sdk/src/managed-session.ts),
  [owner inheritance](../../packages/sdk/src/session-proxy.ts),
  [CMS migrations](../../packages/sdk/src/cms-migrations.ts).
