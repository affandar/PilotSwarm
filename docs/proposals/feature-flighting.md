# Fleet, user, and session feature flighting

Status: proposed; no flighting implementation or CHK deployment in this change.

## Policy model

| Scope | Values | Meaning |
| --- | --- | --- |
| Fleet | `on`, `off`, `on-hard`, `off-hard` | Default, or forced value for the whole fleet |
| User | `on`, `off` | Overrides a normal fleet value |
| Session | `on`, `off` | Overrides the user and normal fleet value |

Resolve from fleet → user → session. A fleet `on-hard` or `off-hard` wins over
both lower scopes. There is no separate emergency-disable flag.

An absent user or session entry inherits from the preceding scope. Unset deletes
that entry; it is not another stored mode. An absent fleet entry uses the feature's
registered normal default (`off` for `copilot.native_tasks`). Unsetting the fleet
entry restores that default, including removing any hard mode. Switching a hard
mode to a normal mode makes existing user/session entries effective again; those
entries are retained while overridden.

```text
fleet = configured fleet mode, otherwise registered default
if fleet == on-hard:  return on
if fleet == off-hard: return off
return session override ?? user override ?? fleet
```

Use presence checks, not boolean OR: an explicit `off` must override an `on`.

| Fleet | User | Session | Effective |
| --- | --- | --- | --- |
| off | on | — | on |
| on | off | — | off |
| off | off | on | on |
| on | on | off | off |
| on-hard | off | off | on |
| off-hard | on | on | off |

Hard modes override flight policy. They do not supply missing worker capabilities
or bypass existing permission and system-session restrictions. Expose both the
resolved policy and whether the session can actually use the feature, with the
reason if it cannot. For native tasks, existing deployment `off` remains a runtime
capability cap; a flight of `on` maps to `sync` only on a capable, eligible worker.

## Identity and scope

The user entry is selected by the session's persisted owner, not its viewer, last
sender, or worker identity. The session entry is keyed by the actual session ID.
Shared sessions therefore have one effective policy regardless of who views them.

A session override applies only to that session. Durable children inherit the
owner through the existing spawn ownership path, then resolve their own session
entry; do not copy the parent's session override. Native tasks are part of their
calling session and use that session's decision. Ownerless/system sessions have
no human user entry and retain their existing eligibility restrictions.

## Storage and controls

Keep the registry of known feature keys/defaults in code and the policy in shared
CMS tables read by the portal and every worker:

- Fleet entry: feature key, four-value mode, revision, actor and timestamps.
- User entry: feature key, CMS user ID, on/off, actor and timestamps.
- Session entry: feature key, session ID, on/off, actor and timestamps.
- Audit: operation, scope/target, before/after, authenticated actor, revision,
  request ID and timestamp; include root-system session ID for assisted changes.

Each mutation checks the feature revision and atomically writes policy plus audit.
Use idempotent request IDs for retries. Reject unknown features, ambiguous users,
missing sessions, and hard modes at user/session scope. Resolve users through the
existing identity directory; email is a search label, not the stored identity.

Admin API and root-system tools share three operations:

- `get_feature_flags`: inspect entries and the resolved value/source for a target.
- `set_feature_flag(feature, scope, target, mode, expected_revision)`.
- `unset_feature_flag(feature, scope, target, expected_revision)`.

All changes, including session overrides, require admin authority. The real
worker-provisioned root system session can act on a direct authenticated admin
request; recheck that actor at execution. Names, model text, forwarded messages,
and autonomous wakes do not grant mutation authority. Bind execution to trusted
message provenance or a server-created scoped change intent if needed.

Portal Admin → Features exposes the fleet's four choices, user/session on/off
overrides, and an unset action. Show the effective value and its winning scope;
under hard mode, show lower entries as overridden. Ordinary session viewers can
see their session's effective/applied state without seeing other users' policies.

## Applying changes

Read policy from CMS at turn admission and before every new native task admission,
using both owner and session ID. Keep resolution in activities/session management,
outside deterministic orchestration code. No orchestration version change is
expected for policy resolution alone; assess durable admin provenance separately.

An enable appears in the tool schemas on the next turn. An effective disable
blocks new native calls after commit, including calls later in an existing turn.
Already admitted tasks finish with cleanup intact; existing cancellation handles
an urgent stop. Remove the tools/profiles/guidance on the next turn. Chat remains
usable. A failed policy read denies new native work and reports unavailable.

Record the applied revision and winning scope with session telemetry. Notify the
portal to refresh after mutations, with reconnect/fallback refresh for missed
notifications; workers rely on fresh CMS reads for correctness. Scope notifications
to authorized viewers. Reuse the current warm/cold native-mode rebind path.

## Waldemort CHK rollout

1. Verify the subscription/cluster and requesting user's immutable CMS identity.
2. Persist `copilot.native_tasks`: fleet **off**, this user **on**, no other enabled
   user or session overrides. This also enables their eligible durable children.
3. Deploy feature-aware portal and workers before enabling native runtime
   capability. Old workers interpret env `sync` fleet-wide, so keep it off there.
   Explicitly seed intended policies when migrating existing env-enabled fleets.
4. Check requester on and control user off across two workers; verify actual tool
   admission, shared-session ownership, and durable descendants.
5. Exercise session overrides, unset, both hard modes, warm resume and restart.
   Roll back immediately with fleet **off-hard**; retain env `off` as a runtime cap.

## Implementation tests

- All 36 combinations of four fleet modes × three user states × three session
  states (on/off/absent), plus missing fleet default and unset transitions.
- Hard on defeats lower off, hard off defeats lower on, and returning to normal
  fleet mode restores retained overrides.
- Owner identity, shared viewers, exact session scope, durable children and native
  tasks; capability/permission restrictions still apply under hard on.
- Admin/root authorization, invalid targets/modes, concurrent revisions,
  idempotency and atomic audit writes.
- Two workers, missed notifications, failed policy reads, warm/cold reuse and
  mid-turn disable with an already admitted task completing normally.
- Requester-only CHK acceptance and the existing native/delegation filesystem suite.

## Existing code

- [Native assembly](../../packages/sdk/src/session-manager.ts),
  [admission hooks](../../packages/sdk/src/native-subagents.ts),
  [mode rebind](../../packages/sdk/src/managed-session.ts).
- [Turn admission and ownership](../../packages/sdk/src/session-proxy.ts),
  [CMS migrations](../../packages/sdk/src/cms-migrations.ts),
  [management operations](../../packages/sdk/src/management-client.ts).
- [Admin API](../../packages/app/web/api/router.js),
  [shared protocol](../../packages/sdk/api/src/protocol.js),
  [system-session access](../../packages/sdk/api/src/session-authz.js),
  [root agent](../../packages/sdk/plugins/mgmt/agents/pilotswarm.agent.md).
