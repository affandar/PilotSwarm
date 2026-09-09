# Fleet and user feature flighting

Status: proposed; no flighting implementation or CHK deployment in this change.

## Intended behavior

An admin can enable a registered feature by default for a fleet, override it for
specific users, remove an override, or disable it for everyone. The portal and all
workers use the same persisted policy. First feature: `copilot.native_tasks`.
First rollout: native tasks enabled only for the requesting user's sessions in
Waldemort CHK, including their ordinary durable descendants.

Flighting is an eligibility decision, not a prompt preference. A session with
native tasks disabled must have no native tool/profile access even if the model
requests it. Feature flags never confer admin authority or override ownership,
model admission, native tool restrictions, or service-session exclusions.

## Resolution and controls

Use a code-owned registry for known boolean feature keys, their default, display
name, required worker capability, and session eligibility. Start with a false
default for `copilot.native_tasks`; translate the result to existing `off`/`sync`.

| Precedence | Rule | Result |
| --- | --- | --- |
| 1 | Deployment cannot run it, or session is ineligible | Off |
| 2 | Admin emergency disable is active | Off for everyone |
| 3 | Explicit override for session owner | That user's enabled/disabled value |
| 4 | Explicit fleet default | Fleet enabled/disabled value |
| 5 | No configured rule | Registered feature default |

“Fleet default disabled” allows selected test users to be enabled. **“Disable for
everyone”** is a separate emergency control that overrides those exceptions.
Removing a user override means inherit; it does not mean disable. Clearing the
fleet default restores the registered default. Clearing emergency disable restores
the underlying rules. These operations should have distinct UI labels and tool
arguments; avoid an ambiguous bare `clear` operation.

Resolve the **session's persisted owner**, not whoever is viewing it, the last
person who messaged it, or the worker identity. Durable children already inherit
effective ownership through `resolveEffectiveSpawnOwner`; use that same authority.
Shared sessions retain their owner's feature policy. Ownerless/system sessions
get no human user's flight; keep current native exclusions for system agents,
agent-tuner, and regen-distiller. Unknown users get only the fleet/default policy.

## Persistence and concurrency

Add CMS migrations and a typed FeatureStore beside ProviderStore:

- `feature_policies`: feature key, nullable fleet default, emergency-disabled
  boolean, monotonically increasing revision, actor and timestamps.
- `feature_user_overrides`: feature key, numeric CMS user ID, enabled boolean,
  actor and timestamps; primary key `(feature_key, user_id)`.
- A feature-change audit stream: before/after, action, authenticated actor,
  root-system session ID when applicable, reason, request ID, revision, timestamp.

User IDs come from the existing provider/subject identity mapping. Email is a
directory search label, never the authorization key. Reject unknown feature keys,
ambiguous user searches, and synthetic/system targets for a human flight.

Mutations are transactions: lock the feature policy row, check `expectedRevision`,
apply the change, increment revision, write the audit record, then notify. Return
409 on a stale revision with the current policy. Retry a timed-out mutation with
the same idempotency key. Audit failure rolls back the mutation; it must not
silently disappear. Store policy in dedicated tables, not user-editable profile
settings or model-writable facts.

## API, portal, and root system agent

Proposed shared operations, declared once in the API protocol and generated into
clients as existing management operations are:

- Admin: list/read policies and overrides; set/unset fleet default; set/unset
  user override; set/clear emergency disable; inspect effective policy for a user;
  read audit history. Every mutation requires `fleet:admin` at the transport and
  server/store boundary. Actor and privilege are server-derived, never body fields.
- Ordinary user: read their effective flags. A readable session can expose its
  current applied feature snapshot without revealing another user's override list.

Portal Admin → Features: one row per registered feature with fleet default,
emergency state, exception count and revision; a detail view manages user exceptions
and explains the effective result. User selection uses the existing directory and
shows the unambiguous account. The session UI distinguishes configured policy from
the revision actually applied to a running turn; an old worker cannot claim support.

Add root-agent tools from one shared specification: `get_feature_flags`,
`set_feature_flag(scope, user, enabled, expected_revision)`,
`unset_feature_flag(scope, user, expected_revision)`, and an explicit
`set_feature_emergency_disable`. Register both declarations and per-turn handlers.
Only the authenticated management API and the persisted, worker-provisioned
`pilotswarm` root system session receive mutation authority. A custom agent named
“pilotswarm”, its descendants, and native tasks receive none.

For root-assisted changes, require a direct authenticated admin operator request
and re-check that actor's current role when executing the mutation. Use trusted,
durably recorded message provenance; model text, facts, tool arguments, forwarded
child messages, or a self-reported admin identity cannot supply it. Autonomous
wake-ups can inspect policy but cannot mutate it without a scoped admin instruction.
The existing system-session API already restricts non-read operations to admins,
but the agent-tool path needs its own enforcement. If current turn provenance
cannot bind that admin reliably, add a server-created change intent carrying the
exact operation, actor, target and revision; the root may apply only that intent.
Do not fall back to unrestricted system authority merely because provenance is
missing. This binding is an implementation requirement, not an existing guarantee.

## Worker enforcement and propagation

Read the relevant policy from shared CMS on each turn admission and each new
native `task` admission. The workload has few native dispatches; start with fresh
reads rather than building a distributed cache invalidation dependency. Resolve
the policy with owner and eligibility before warm-session reuse in SessionManager.
Reuse the existing native-mode rebind path for changes on warm/cold sessions.
Do not freeze the flag into the child's spawn arguments or trust a client override.

At turn start, record the applied feature revision, owner and effective mode in
session metadata/telemetry. An enable becomes visible in tool schemas at the next
turn. A disable rejects **new native task admissions** once committed, including
later calls in an already-running parent turn. Native tasks admitted before the
disable finish normally; existing cancellation controls handle an urgent stop.
Keep that turn's native cleanup active even if subsequent admissions are denied,
then remove the tool/profile/guidance on the next turn. Ordinary chat remains usable.

Database-read failure denies new native work and reports policy unavailable; it
does not use an indefinitely cached enabled value or overwrite the saved policy.
Keep feature decisions outside deterministic orchestration generators: admission
belongs in activities/session management. No new orchestration version is expected
for that alone; durable provenance changes must be assessed separately if needed.

After a transaction, publish a small CMS-schema-scoped change notification. The
portal invalidates its display cache; refresh on reconnect and use a short bounded
fallback refresh for missed notifications. Worker correctness does not depend on
delivery. The existing live relay is session-scoped; add an explicit admin/user
feature channel rather than inventing a fake session ID or broadcasting user
membership to every browser. A notification is a hint to re-read, never authority.

Keep `PILOTSWARM_NATIVE_SUBAGENTS=off` as a deployment-level hard cap. For this
rollout, `sync` permits capable workers to offer native execution, subject to CMS
policy. Existing deployments that deliberately used env `sync` must be explicitly
seeded with the desired fleet default during migration; do not silently reinterpret
it as enabled for every user or silently turn existing users off.

## Waldemort CHK rollout

1. Verify the subscription/cluster and requesting user's immutable CMS identity.
2. Install the schema and policy API. Persist fleet default **disabled**, no other
   enabled user overrides, and this user's override **enabled**.
3. Roll out the feature-aware build to portal and every relevant worker; enable
   native capability on those workers only after policy enforcement is present.
   Old code interprets env `sync` fleet-wide, so never enable that env on old workers.
4. Verify from the portal and two workers: requester on, control user off;
   descendants inherit the right owner; viewers of shared sessions do not change
   eligibility. Check tool schemas and actual dispatch, not UI badges alone.
5. Exercise user disable/unset, emergency disable/clear, warm resume, and worker
   restart. Retain rollback: emergency disable first; env `off` as an independent
   deployment cap. No existing sessions need deletion.

## Validation required for implementation

- Resolver matrix: defaults, enable/disable/unset, emergency override, unsupported
  worker, unknown owner, system/service exclusions, and shared-session viewers.
- Store: concurrent revisions, transaction/audit atomicity, idempotency, deletion
  of overrides, unknown keys, identity lookup and unauthorized calls.
- Admin API + root tools: forged privilege/identity, nonadmin and demoted admin,
  spoofed root name, forwarded messages and autonomous wakes, native tool attempts.
- Two-worker integration: same user gets same policy, missed notifications do not
  bypass admission, warm/cold sessions lose native access, child ownership is used.
- Mid-turn disable: reject the next native call, let an admitted task settle,
  preserve cancellation and prompt responsiveness, remove schema next turn.
- CHK acceptance with requester and control account; general native test suite and
  both durable/native filesystem tests pass with the flight enabled.

## Existing code this design builds on

- [Native eligibility and SDK assembly](../../packages/sdk/src/session-manager.ts),
  [native policy hooks](../../packages/sdk/src/native-subagents.ts),
  [mode rebind and cleanup](../../packages/sdk/src/managed-session.ts).
- [Turn admission and child ownership](../../packages/sdk/src/session-proxy.ts).
- [Provider store](../../packages/sdk/src/provider-store.ts),
  [CMS schema](../../packages/sdk/src/cms-migrations.ts),
  [management operations/audit](../../packages/sdk/src/management-client.ts).
- [Admin API gate](../../packages/app/web/api/router.js),
  [shared protocol](../../packages/sdk/api/src/protocol.js),
  [system-session access](../../packages/sdk/api/src/session-authz.js).
- [Provider tool specification/viewer pattern](../../packages/sdk/src/provider-tools.ts),
  [root system agent](../../packages/sdk/plugins/mgmt/agents/pilotswarm.agent.md),
  [portal live relay](../../packages/app/web/api/live-plane.js).
