# Cluster and user feature flags

Status: proposed; no feature-flag implementation or CHK deployment in this change.

## Definitions and resolution

Feature flags are defined **only in code**. A typed registry owns each key, label,
description, default enabled value, default `allowUserOverride`, and required
runtime capability. Administrators and agents can change settings for registered
flags; they cannot create, rename, delete, or redefine flags through APIs, the UI,
facts, or agent packages. First key: `copilot.native_tasks`, with code defaults
`enabled: false, allowUserOverride: false`.

| Scope | Stored setting | Who can change it |
| --- | --- | --- |
| Cluster | `enabled: boolean`, `allowUserOverride: boolean` | Admin |
| User | `enabled: boolean`; absent means inherit | Admin for any user; user for themselves |

There are no per-session settings or hard modes. Resolution is:

```text
cluster = saved cluster settings, otherwise code defaults
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

One additive CMS migration: **three new tables**, one seeded directive row, and
an added constraint on the existing directive table. No session/owner table changes
and no editable flag-definition table. Keep the existing physical table name
`fleet_directives`; the new public feature APIs and UI use **cluster**.

| Table | Columns and constraints |
| --- | --- |
| `feature_cluster_settings` | `feature_key TEXT PRIMARY KEY`, `enabled BOOLEAN NOT NULL`, `allow_user_override BOOLEAN NOT NULL`, `revision BIGINT NOT NULL`, `updated_by TEXT NOT NULL`, `updated_at TIMESTAMPTZ NOT NULL` |
| `feature_user_settings` | `feature_key TEXT`, `user_id BIGINT REFERENCES users(user_id)`, `enabled BOOLEAN NOT NULL`, `revision BIGINT NOT NULL`, `updated_by TEXT NOT NULL`, `updated_at TIMESTAMPTZ NOT NULL`; primary key `(feature_key, user_id)`, index on `user_id` |
| `feature_flag_changes` | `change_id BIGSERIAL PRIMARY KEY`, `epoch BIGINT UNIQUE NOT NULL`, `request_id UUID NOT NULL`, `request_hash TEXT NOT NULL`, `actor_key TEXT NOT NULL`, optional `actor_session_id TEXT`, `scope TEXT NOT NULL CHECK (scope IN ('cluster','user'))`, `feature_key TEXT NOT NULL`, nullable `target_user_id BIGINT`, `action TEXT NOT NULL CHECK (action IN ('set','unset'))`, `before JSONB`, `after JSONB`, `created_at TIMESTAMPTZ NOT NULL`; unique `(actor_key, request_id)`, target present iff scope is user |

`updated_by` and `actor_key` are server-derived identities, including trusted
service actors; never accept them as caller-supplied authority. Audit targets and
actor session references survive deletion of the referenced user/session. User
setting deletion, including user removal if supported, must use the same mutation
path so it cannot leave a worker's cache unrefreshed.

Seed an existing worker-registry directive:

```text
fleet_directives:
  domain = 'feature-flags'
  pool = '*'
  worker_node_id = '*'
  actuation = 'worker'
  desired = {}
  epoch = 1
```

This row is a change counter, not a flag registry or a place to store overrides.
Constrain this domain to the global `*/*` scope, worker actuation and empty desired
payload. Feature policy has only cluster and user scope, even though the generic
worker registry supports pool/worker directives. Do not bump `agent-packages` for
a flag change: that would cause unnecessary package installation.

Each successful setting mutation is one transaction: resolve/check actor and
known key, recognize an identical idempotent retry, lock/check the feature directive
against `expectedEpoch`, update/delete the setting, increment the feature epoch,
and insert audit. Row `revision` is the resulting epoch. Return 409 on a stale
expected epoch; an idempotent retry returns its original result, while reusing its
request ID for different input fails. Reset/unset also bumps the epoch, so cached
entries are removed. For the initial low-write-volume settings service, one epoch
serializes writes and avoids lost resets without tombstone tables.

The internal snapshot read returns **epoch + all cluster settings + all sparse user
settings from one consistent database snapshot**. Include the stable owner lookup
keys needed by workers, so resolving an existing session owner adds no user lookup.
A full snapshot per changed epoch handles deletes and missed polls; no event replay
or delta protocol is needed initially. Public reads remain caller-scoped.

Feature definitions stay in code. Reject unknown keys before mutation; older code
ignores unsupported keys in a snapshot and reports them as unsupported rather than
letting database rows create new flags. Missing settings use registry defaults;
failed snapshot reads leave the cache state intact.

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
Web routes use `/management/features` and `/management/users/{me|userId}/features`;
register literal `me` ahead of user ID routes. MCP and agent tools use equivalent
snake-case names and arguments. Cluster updates save both booleans atomically.
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
3. On a changed feature epoch, fetch the consistent full feature snapshot, validate
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
| `feature-flags.ts` (new) | Code-owned typed registry, pure cluster/user resolver, result/source types |
| `feature-store.ts` (new), CMS migration/catalog | Authorized setting operations, atomic mutation/audit/epoch bump, consistent internal snapshot and caller-scoped public reads |
| `feature-flag-cache.ts` (new) | Immutable cluster/user maps, initialization/error state, epoch-based refresh with one in-flight load; synchronous `resolve(key, owner)` |
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
```

The polling request itself must not overlap without a bound; release its guard
before either asynchronous reload. A failed/absent directive response is not a
request to reset the cache. Startup explicitly awaits the initial feature load.
A cache reload swaps only a complete consistent snapshot and never downgrades to
an older epoch. Feature mutations still authorize against live identity/role state;
polling caches settings, not administrator privileges.

## Plan: move copilot.native_tasks onto feature flags

1. **Land registry and persistence.** Define `copilot.native_tasks` in code with
   both defaults false. Add the three tables, directive seed/constraint, transactional
   operations and snapshot read. Verify resolution's 12 combinations, authz,
   unknown keys, idempotency, concurrent updates and reset/delete convergence.
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
5. **Handle running/warm sessions.** Give the native `task` hook a callback to the
   live cache. After a disabling snapshot is applied, reject new native admissions,
   including later calls in a running parent turn. Previously admitted natives
   finish with cleanup intact; do not mutate that turn's cleanup mode. On the next
   turn, existing mode-change rebind removes/adds schemas, profiles and guidance.
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

## Implementation tests

- All 12 combinations: two cluster enabled states × two allow-user-override states
  × three user states (on/off/absent), plus defaults and reset/unset transitions.
- Preserved preferences when overrides are disabled/re-enabled; admin-written and
  self-written user entries resolve identically; no session override is accepted.
- Registry only: reject unknown keys and runtime definition creation; unsupported
  keys on older workers; code defaults versus database-read failure.
- Permission matrix on MCP, Web and direct management APIs: self versus another
  user, forged actor, admin cluster access, resource-manager identity, admin-owned
  Agent Manager and demotion. Read and audit privacy checks.
- Contract/tool registration parity across every surface, including both tool
  declarations and handlers; concurrent revisions and atomic audit writes.
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
