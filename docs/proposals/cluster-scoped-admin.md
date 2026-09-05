# Cluster-scoped administrators — mini spec and test plan

Status: implemented; full all-provider regression gate passed; deployed and
verified on PilotSwarm AKS. Updated: 2026-09-05. See the
[validation report](../developer/contributing/cluster-admin-validation-2026-09-05.md).

## 1. Intent and setting

**Administrators manage cluster health, cost and configuration. Their role
does not automatically grant access to other users' sessions or agent packages.**

Phase 1 exception: admins retain read/write access to system sessions, and
genuine system sessions retain their current authority. The resulting
system-mediated bypass is explicitly accepted until phase 2 (see section 5).

Introduce one deployment-wide, operator-controlled setting:

```env
AUTHZ_ADMIN_SCOPE=cluster
```

- `cluster`: retain operational administration and fleet-wide accounting;
  apply ordinary ownership/sharing rules to non-system sessions and agent
  packages, with the system-session exception above.
- `unrestricted`: preserve existing admin permissions and auditing. Default
  when unset, for compatibility. This replaces the proposed session-only flag.

Reject unknown values. `cluster` requires authentication and
`AUTHZ_ENFORCE_OWNERSHIP=true`; incompatible configuration must fail validation,
not silently grant access. Show the effective policy read-only in the admin
console/bootstrap response. No portal/API operation lets an admin lift it.

## 2. Permissions in cluster mode

| Area | Admin authority |
|---|---|
| Health | Worker/service health, capacity, sanitized diagnostics and explicit system-agent operational controls such as restart |
| Cost | Every user's token accounting; provider limits, budgets, allowances and holds |
| Configuration | Shared providers/credential rotation, models, defaults and deployment policies; no credential disclosure |
| Own sessions | Ordinary owner permissions |
| Other non-system sessions | Ordinary read/write shares and deployment-shared visibility only; no direct private-session bypass |
| System sessions | Admin read/write access remains, including viewing transcripts and sending prompts; preserve existing system-session permissions and lifecycle restrictions |
| Own packages | Ordinary owner permissions |
| Other private packages | Not listed, readable, downloadable or mutable |
| Shared packages | Read as any user; edit only as owner or explicitly granted editor |
| System/maintenance authority | Genuine system sessions and trusted services retain their current access, including existing cross-user session/package access; admin-directed use of that authority is not restricted in phase 1 |

**Shared is a visibility level, not administrator ownership.** Existing package
editors can publish, republish into the shared copy, pin and enable/disable it.
They cannot delete it, change its scope or manage editor grants. An admin
without ownership/editor rights cannot do any of those mutations. Existing
editor grants apply to shared packages only; this feature adds no new sharing
model for private packages. Built-in deployment components remain operator
managed; a package name or `shared` scope must not confer platform authority.

Operational containment and content ownership are separate. Existing quotas,
provider holds and explicit service controls remain available. If targeted
workload suspension/package quarantine is needed, use a separate, narrowly
scoped, audited operation with a reason and minimal operational metadata.
Do not repurpose session deletion, package editing or `setAgentPackageEnabled`
as an admin escape hatch. New targeted containment APIs are a follow-up, not
a prerequisite for this access-policy change.

## 3. Accounting remains fleet-wide

Admins can inspect **every user's** input/output/cached-token usage, time
series, provider/model breakdowns, allowances and remaining quota. Include
usage from private sessions and private packages, plus an identified system
bucket. Show cost estimates when pricing exists; do not fabricate missing
prices. User attribution is deliberately permitted for cost administration.

Content visibility must never filter away spend. Calculate accounting from
authorized ledger rows, not the caller's visible-session list. Do not expose
private session titles, package/agent names, prompts, responses, source files
or provider secrets through usage rows, grouping labels, exports or tooltips.
Suppress inaccessible content drill-downs; server-side checks still apply.
Provider/model labels and user identities needed for accounting remain visible.

## 4. Enforcement design

Derive distinct capabilities server-side: cluster management, fleet accounting
and user-resource bypass. In `cluster` mode an admin retains the first two,
not a direct bypass for other users' non-system sessions/packages. Preserve
existing admin authorization on system-session targets and existing authority
inside genuine system sessions. Do not globally replace `isAdmin` with false:
that would break cost/configuration controls and system-session access. No
client-supplied capability or owner selector may grant authority.

- **Non-system sessions:** apply normal permissions to list/search/group/
  descendant views, transcripts, live updates, artifacts, canvas/KV, archives
  and session-private facts. Manage/share/destroy remain owner-only; shared read/write access does
  not grant raw archive access. Existing explicit canvas-link capabilities
  still grant only their intended canvas, never the parent session.
- **Packages:** cover lists, version metadata/history, file trees, downloads,
  publishing, pinning, scope changes, enablement, deletion and editor grants.
  Apply effective bypass authority in service pre-checks and atomic catalog
  authorization. Check source and destination independently on copy/republish.
- **All surfaces:** portal, public API (REST and legacy RPC), Web-mode CLI/TUI,
  MCP, package import/export and agent tools must agree. Non-system personal
  and recurring agents act with their owner's effective resource permissions,
  not raw admin status. Genuine system agents, including recurring system
  agents, retain current authority. Recheck authorization when committing
  staged package changes under the applicable caller context.
- **Indirect disclosure:** scope or redact worker installation inventories,
  collision/error messages, audit views and logs. Keep safe operational counts
  and per-user accounting; deny a raw diagnostic stream if it cannot be made
  safe. Non-system session sender attribution reflects owner/collaborator
  permissions, not an elevated admin relationship obtained solely from the
  account role. Preserve existing sender attribution in system sessions.
- **System authority:** service identity comes from trusted runtime context,
  never a package name, manifest claim or prompt. Admins retain read/write
  access to system sessions even when `SESSIONS_SYSTEM_VISIBILITY=admin`.
  Ordinary users' existing system-session visibility and permissions are
  unchanged. Do not introduce new restrictions on system-session prompts,
  tools, transcripts, output or access to user resources in phase 1. Existing
  restrictions on system-session lifecycle operations also remain unchanged;
  this exception does not grant new delete/control permissions.

## 5. Rollout and boundary

Deploy compatible code first; then configure the same policy on all portals
and workers. Treat activation as complete only after old replicas and obsolete
subscriptions/cached decisions granting direct access to other users' private
resources have been retired. A previously open unauthorized non-system view
must clear on reconnect/revalidation, not keep receiving updates. Admin system
views and subscriptions remain authorized. Publish effective policy/version
in health diagnostics to verify parity.
This is an operator rollout setting, not a hot user preference.

Implementation notes:

- CMS migration 0075 adds query functions only; existing tables, procedures and
  ledgers remain compatible with the previous binary. Masking happens before
  grouping/pagination so private spend is never dropped from totals.
- Session WebSocket grants revalidate every five seconds (one check per unique
  subscribed session, at most 64 per connection), not per streaming delta.
  Revocation clears chat/artifact/canvas caches and invalidates late responses.
  Initial subscription refusals and reconnects clear the same cached views.
- Restricted agent listings use SQL-authorized pages (200 rows, at most 20
  pages per tool call); a scan that reaches its work budget reports `truncated`.
  Accounting resolves session visibility once per session, not per token row.
- Ledger agent labels do not carry durable package ACL identity. Cluster-mode
  accounting conservatively groups other users' agent labels, including shared
  packages, while retaining owner/user, provider, model and token dimensions.
- Raw fleet logs/content diagnostics are denied; operational worker counts and
  health stay available. Per-package adoption details are redacted alongside
  private installation inventories. Authorized session diagnostics still work.
- `evaluateArchiveAccess` retains the owner/admin contract for raw snapshots;
  no raw snapshot archive endpoint is currently exposed. Ordinary execution
  history remains a session read, not an ownership-only archive export.

Preserve owners, grants, package versions, sessions and token ledgers. No data
rewrite or orchestration-version change is intended. Any necessary stored
procedure changes use additive versioned migrations. Reverting to unrestricted
access requires an explicit operator action and restores existing auditing.

This is application authorization, not a new tenant sandbox. It does not
protect against Kubernetes/database operators or arbitrary worker code holding
server credentials, and cannot retract previously viewed/downloaded content
or facts already copied into a conversation. Direct-store SDK/MCP mode remains
a trusted operator interface, not a supported restricted-user access path.

### Phase 2: system-mediated bypass

An admin can ask a privileged system agent to read or modify another user's
private session/package and can inspect the result in the system transcript.
Because admin read/write access and system authority are unchanged, **phase 1
does not close this backdoor or guarantee end-to-end isolation from admins**.
It restricts direct user-resource access while accepting this existing route.

Phase 2 will address authority delegation through system sessions and any
resulting content disclosure. Its design is deferred; restricting system
prompts, filtering their output or reducing their resource permissions is
not a phase 1 implementation or release gate.

## 6. Test plan

Use isolated schemas and synthetic identities: two owners, a read collaborator,
a write/editor collaborator, an unrelated admin, an ordinary unrelated user
and the trusted service principal. Run the matrix in both policy modes. Seed
private/shared session trees, artifacts, facts, archived state, same-named
packages in different owner scopes, shared-package editor grants and a ledger
with known token totals. Never use production conversations as fixtures.

| Test group | Required assertions |
|---|---|
| Policy/config unit tests | Unset preserves unrestricted behavior; cluster mode requires auth/enforcement; invalid values fail; management/accounting and admin system-session access stay enabled while direct user-resource bypass is disabled; request fields cannot override policy |
| Non-system session authorization | Owner/read/write/none matrix across lists, pagination, groups, children and direct reads; invisible vs nonexistent IDs are indistinguishable; test send/control/share/delete, archive, artifact copy/download, facts and canvas access |
| Package authorization | Own/shared/editor/foreign-private matrix across every read and mutation; shared does not imply edit; editor cannot grant/delete/unshare; arbitrary owner selectors, IDs, old versions and artifact filenames cannot bypass checks |
| Package lifecycle adversarials | Same-name shadowing, cross-scope republish and identical-content no-op paths preserve authorization; revoke editor after staging and before publish; assert forbidden writes change neither registry nor blobs |
| Accounting correctness | Exact all-user totals and input/output/cache splits across private/shared workloads, models, providers and time windows; changing content permissions does not change spend; normal users retain existing accounting scope; no private labels/content in responses or exports |
| Administrative operations | Restricted admin can change limits, allowances, holds and shared configuration; ordinary user cannot; denials on private content do not disable these controls; operational APIs cannot accept arbitrary session/package mutation payloads |
| Agent/MCP/API parity | Invoke actual handlers as admin-owned non-system personal/recurring agents, including warm/cold clients and staged actions; direct inspect/export/edit calls cannot regain bypass; forged system identity/package names confer nothing; compare REST, RPC and Web-mode MCP outcomes |
| System-session compatibility and accepted bypass | In both modes, admins can list/read/subscribe to system sessions and send prompts; ordinary-user visibility and existing lifecycle restrictions stay unchanged. Genuine system agents retain current cross-user session/package access and maintenance behavior. Characterize the admin-to-system-to-private-resource route with synthetic fixtures as an accepted phase 1 exception, not a test expecting denial |
| Diagnostics | Worker health and adoption counts remain available without private names/files in ordinary diagnostic views; scan direct errors, logs, audit and usage payloads for seeded canary secrets. System-session transcripts/output are explicitly exempt from new phase 1 filtering |
| Live access and cache invalidation | Open a foreign non-system session under unrestricted mode, activate cluster mode across two portal/worker replicas, reconnect and verify no further data; exercise share/editor revocation and stale viewer caches; admin system subscriptions continue to work |
| Portal/TUI UX and performance | Admin controls, system-session chat and per-user accounting remain; inaccessible non-system sessions/packages and edit actions disappear; direct links fail safely; desktop/mobile views clear stale content; paginated lists and ledger queries avoid per-row authorization queries/unbounded fetch-and-filter |

Authorization tests should primarily invoke real public APIs/tool handlers
deterministically, not rely on an LLM choosing to attempt a forbidden action.
Use the repo's schema-isolated integration harness; add no retries or weakened
assertions. Browser stubs validate presentation, not server authorization.
Supplement them with an authenticated multi-user portal/MCP check against an
isolated local or non-production deployment.

### Execution and acceptance

Extend the existing session visibility/portal authz, package registry/editor/
portal, inspect-tool, provider-budget and WebSocket suites. Add focused
`admin-scope` tests for policy wiring, accounting privacy and adversarial paths.
After implementation, from the repository root:

```sh
./scripts/run-tests.sh admin-scope portal-authz session-visibility-shares agent-package inspect-tools provider-budgets
./scripts/run-tests.sh --with-horizondb admin-scope portal-authz session-visibility-shares agent-package inspect-tools provider-budgets
npm run test:e2e --workspace=pilotswarm
./scripts/run-tests.sh --all-providers
```

The final unfiltered run must include both PgFactStore and HorizonDB; a missing
overlay or skipped required phase 1 security test is not an all-provider pass.
These are storage configurations, not model vendors; authorization must not
depend on an LLM provider. Seed accounting fixtures for every supported
provider type.

Accept only when both modes pass the phase 1 security matrix, exact fleet/user
totals reconcile, private canaries do not reach unauthorized direct surfaces,
admin system-session read/write access and current system authority remain
intact, and the final full regression runs pass on one frozen candidate. Record
the known system-mediated bypass separately; do not claim it is closed or
treat it as a phase 1 failure. Record browser/MCP results, query-count/performance
comparisons and all skips. Tests, commits and deployment remain separate steps;
the final validation report records completion, not this rollout plan.

Related: [security model](user-admin-security-model.md),
[package editors](agent-package-editors.md),
[provider budgets](providers-and-budgets.md).
