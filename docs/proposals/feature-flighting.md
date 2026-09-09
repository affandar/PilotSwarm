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

Add a FeatureStore with:

- Cluster rows: feature key, enabled, allow-user-override, revision, actor/time.
- User rows: feature key, CMS user ID, enabled, revision, actor/time.
- Audit rows: scope/target, before/after, authenticated actor, request ID and time;
  include the calling agent session for tool-assisted changes.

Use transactions for setting plus audit, expected revisions for concurrent edits,
and idempotent request IDs for retries. Self-service writes check the target against
the authenticated actor inside the shared service/store boundary. Use immutable
CMS user identities; email is only a directory lookup label. Feature definitions
are not stored as editable database records. Reject unknown keys before mutation;
an older worker must report an unsupported flag instead of trusting a database row
as a new definition. Missing settings use registry defaults; a failed read does not.

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
revision, and whether a saved user preference is currently ignored.

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

## Applying changes

Read CMS policy at turn admission and before every new native task admission.
Resolve in activities/session management, outside deterministic orchestration
code; no orchestration version change is expected for flag resolution alone.
Reuse the existing warm/cold native-mode rebind path.

An enable appears in tool schemas on the next turn. An effective disable blocks
new native admissions after commit, including later calls in an active turn.
Already admitted tasks finish and clean up normally; existing cancellation handles
an urgent stop. Remove native tools/profiles/guidance on the next turn. Chat remains
usable. A failed policy read denies new native work and reports unavailable.

Record applied revisions and the winning scope in session telemetry. Notify the
portal to refresh after changes, with reconnect/fallback refresh for missed
notifications; workers rely on fresh reads for correctness. Scope notifications
to authorized viewers.

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
   transaction. Keep env `off` as the independent runtime cap.

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
- Two workers, missed notifications, ownership/shared viewers, warm/cold sessions,
  durable children and mid-turn disable with existing task cleanup.
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
