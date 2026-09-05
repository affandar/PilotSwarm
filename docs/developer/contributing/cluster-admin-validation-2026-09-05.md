# Cluster-scoped admin and Copilot upgrade validation

Date: 2026-09-05. Status: implementation and full validation complete;
**deployed and verified on PilotSwarm AKS at 15:21 PDT (22:21 UTC)**.

## Candidate and scope

This is an unreleased PilotSwarm 0.5.58 working-tree candidate based on
`eee596b7fb91c2d81b281a48567305011ff25188`. No commit, push, tag, npm publication
or GitHub Release is part of this task. Deployment is authorized for
**PilotSwarm AKS only**, not Waldemort CHK.

**Release follow-up:** the operator subsequently authorized PilotSwarm 0.5.59
publication and a separate CHK upgrade. The dated candidate/deployment record
below is historical. Its full successful test pass is reused with permission;
release preparation changes version metadata and documentation only.

The candidate combines the previously prepared Copilot SDK/CLI and portal UX
fixes with [cluster-scoped administration](../../proposals/cluster-scoped-admin.md).
Copilot dependencies are exactly pinned to SDK **1.0.13** and CLI **1.0.83**,
the latest stable versions verified during migration preparation.

Runtime source fingerprint:
`67f6fd4070f67cdb7f1f4c3355b1ef056382aa2c78ce5640138644b9b1188714`.
It covers 927 sorted tracked/untracked regular source files, hashing each path,
a NUL separator, its bytes and another NUL. Documentation, `.github`, test and
test-result directories are excluded so test-generated fixtures cannot alter
the deployment identity. Image labels include this fingerprint, the base
revision with a `-dirty` suffix, and both Copilot versions.

## Delivered behavior

- `AUTHZ_ADMIN_SCOPE=cluster` retains operational administration, shared
  configuration and every user's token accounting. It removes the raw admin
  bypass for private non-system sessions and agent packages. Unset remains
  `unrestricted` for compatibility; invalid values or missing authentication/
  ownership enforcement fail validation.
- Session owners and explicit read/write collaborators keep their normal
  permissions. Package owners and shared-package editors keep their respective
  existing permissions. Shared visibility is not edit authority.
- Admins retain read/write access to system sessions. Genuine system/service
  sessions retain existing cross-user authority and lifecycle restrictions.
  A package name such as `token-manager` does not establish system identity.
- REST/RPC, Web-mode MCP, session tools, package staging/publishing, diagnostics,
  accounting and portal/TUI capability presentation use the same server policy.
  Direct-store SDK/MCP remains a trusted operator interface.
- Accounting retains exact all-user spend, including private workloads, while
  masking inaccessible session references and other users' agent labels.
  Health/count diagnostics remain; raw fleet content/log streams are denied
  when they cannot safely be projected.
- Existing WebSocket subscriptions revalidate every five seconds. Revocation
  clears chat, canvas, artifact and package caches and invalidates late HTTP or
  live-snapshot responses. System-session subscriptions remain authorized.
- CMS migration 0075 adds query functions only. No table rewrite, ledger
  mutation, session reset or orchestration-version change is required.

### Deliberately retained limitation

An admin can still direct a privileged system agent to read or modify private
resources and read its output. This **accepted phase-1 backdoor is not closed**.
The change limits direct content access; it does not provide end-to-end
isolation from admins, database/Kubernetes operators or arbitrary trusted
worker code. Phase 2 is explicitly deferred.

Ledger rows do not carry durable package ACL identity. To avoid disclosure,
cluster accounting conservatively groups other users' agent names, including
shared-package names, while keeping user, provider, model and token dimensions.

## Adversarial review outcomes

Review and regression tests addressed these concrete paths before the frozen
final run:

1. Raw administrator status leaking into owner-scoped tools, package operations,
   sender attribution, private facts, group views and diagnostic responses.
2. Forged system privilege through an agent/package name; classification now
   comes from the trusted session record.
3. Editor revocation after staging and stale unrestricted owner selection during
   publication. Authorization is rechecked before catalog or blob mutation.
4. Same-named packages under different owners retaining a stale private detail
   view after the visible package list changes.
5. Revoked session content surviving when its sidebar row has already gone,
   or being restored by an outstanding HTTP response.
6. A live-only subscriber's in-flight gap snapshot surviving access revocation.
   Revocation now follows the normal unavailable-state invalidation path, and
   an actual APIClient race regression covers the late snapshot.
7. Per-row authorization work on large lists/accounting queries. Restricted
   listings use SQL-authorized pages; ledger visibility is materialized once
   per session rather than queried for every token row.

The Copilot migration additionally fixes client-pool namespace decoding for
vision catalog lookup/cold resume. Its `snippy` workaround removes only that
top-level field from OpenAI/Azure-compatible BYOK chat-completions requests;
upgrading the dependency alone does not fix the upstream request regression.
See the [migration evidence](copilot-sdk-migration-1.0.13.md).

## Validation

### Focused security and presentation coverage

| Check | Result |
|---|---|
| Focused authz/package/accounting suites, PgFactStore | 267 passed, no skips |
| Same focused suites, HorizonDB | 267 passed, no skips |
| New real-catalog/runtime admin-scope integration suite | 11 passed |
| New SDK authorization/client unit suite, including final late-snapshot race | 66 passed |
| Full browser suite on final source | 113 passed |

The integration tests use isolated schemas and synthetic users/content. They
exercise actual session/package/catalog handlers, authenticated Express REST
and a Web-mode MCP stdio client, not an LLM's willingness to attempt access.
The MCP client is kept warm across policy changes. Browser tests use controlled
server fixtures for desktop/mobile presentation and WebSocket revocation; they
are not represented as production multi-user authorization tests.

The matrix covers guessed and missing private IDs, child sessions, shares,
read/write distinctions, facts, canvas/artifacts, groups, package CRUD/source
selection/editor revocation, forged system identity, stale owner selectors,
accounting and ordinary-user denial of administrative controls. Forbidden
package publication checks assert no blob uploads. The accepted system-to-
private-resource path is explicitly characterized with synthetic data.

Ledger fixtures span six provider labels and reconcile **715 tokens in seven
turns across two sessions**: input 650, output 65, cache-read 180 and cache-write
30. Permission changes preserve spend while private canary labels disappear.

Performance assertions establish one authorized SQL query for a restricted
list page and one batched visibility query, not one query per result. Lists are
bounded to 200-row pages, 20 pages per tool call and 500 returned records, with
`truncated` reporting. WebSocket leases check each unique subscribed session
once per interval, cap connections at 64 sessions, and do not add authorization
queries for each streaming delta. This is bounded-work verification, not a
production latency/load benchmark.

### Initial full regression gate (before cleanup)

Command: `./scripts/run-tests.sh --all-providers`, without filters or skip flags.
Log: `/tmp/pilotswarm-admin-scope.at1Xgm/all-providers-final.log`.
SDK JSON directory:
`/var/folders/t5/g455x6ns77d7cydlz_1qst240000gn/T/pilotswarm-run-tests-all-providers.F7CaLf`.

| Suite | Result |
|---|---|
| PgFactStore full SDK | 1,597 passed; 14 skipped |
| HorizonDB store integration | 146 passed; 3 failed (embedder outcome timeouts) |
| HorizonDB-backed full SDK | Not reached: storage integration gate failed |
| Combined wrapper | FAIL: one provider phase passed, one failed |
| Isolated embedder rerun | 7 passed; 1 failed (edited-fact re-embedding timeout) |
| SDK units | 778 passed |
| UI core units | 633 passed |
| Web units under full harness | 133 passed; no skips |
| TUI units | 21 passed |
| Deployment/configuration units | 250 passed |
| Browser suite (separate command) | 113 passed |

Baseline skips comprise 13 HorizonDB-only cases and the existing
`dehydrate-no-fallback` case. No required admin-security test is skipped.
The model-switch integration suite also logs prerequisite-based early exits
where a cross-provider live target is absent; those are not Vitest skips and
must not be described as live cross-vendor switch validation.

An earlier combined run was intentionally stopped after the final APIClient
race was found. Its baseline and HorizonDB storage checks had passed, but that
abandoned wrapper is not an all-provider PASS. The table above refers only to
the first restarted, frozen run before the approved cleanup.

The final HorizonDB storage failures were `E5 edited fact is re-embedded after
vector reset`, `E13 mid-flight edits converge`, and `oversized embedding failure
is isolated by batch failure -> single-row retry`. Their existing outcome
deadlines were 120, 120 and 360 seconds, respectively. The other 146 tests
passed; the file took 941.9 seconds overall. No assertions or timeouts were
relaxed. The isolated rerun passed seven tests but reproduced the E5
edited-fact re-embedding timeout (120 seconds); the file completed in 722.6
seconds. Mid-flight edit convergence and failed-batch recovery passed on this
rerun. Evidence:
`/tmp/pilotswarm-admin-scope.at1Xgm/embedder-isolated.log`.

Read-only diagnostics found the service reachable and an active
`HorizonDB_Storage_Read` wait. Durable-node metadata for this run's synthetic
embedder showed continued progress with tens-of-seconds steps, rather than an
SDK authorization rejection. Older active loops also exist in the shared test
database. Ten loops were positively traced to this task's abandoned 13:54–13:56
SDK run using exact schema IDs and local run timestamps; only those ten were
cancelled as test cleanup. Their schemas/data were retained. Older loops whose
ownership was not established were not modified. This supports a scheduling/
storage-delay hypothesis, not a proven upstream root cause. Deployment remains
remained gated at that point. This run was not an all-provider pass or a
confirmed parallel-only flake.

### Approved cleanup and final full regression gate

The operator approved the broader test-only cleanup. At 14:42 PDT, 26 exact
stale job IDs were revalidated against test-only labels and creation timestamps,
then cancelled using `df.cancel`. All 13 corresponding schemas were preserved;
no schemas or data were deleted. No matching old test embedder loops remained.
The ten active loops with non-test/unknown-purpose labels were left untouched.
Evidence: `/tmp/pilotswarm-admin-scope.at1Xgm/approved-test-loop-cleanup.log`.
The unchanged isolated suite **passed all eight tests in 164.4 seconds**, versus
722.6 seconds with one failure before cleanup. All original deadlines and
assertions remained intact. Evidence:
`/tmp/pilotswarm-admin-scope.at1Xgm/embedder-after-cleanup.log`.
A fresh full combined run started at 14:45 PDT, recorded in
`/tmp/pilotswarm-admin-scope.at1Xgm/all-providers-after-cleanup.log`.
Its baseline passed 1,597 tests (14 existing skips), and its complete HorizonDB
storage suite passed all 149 tests without skips in 168.4 seconds. The
HorizonDB-backed full SDK passed 1,610 tests with one existing skip in 1,044.3
seconds. The combined wrapper **PASS** completed at **15:14:07 PDT**, exit 0:
two provider phases passed, zero failed.

Final SDK JSON directory:
`/var/folders/t5/g455x6ns77d7cydlz_1qst240000gn/T/pilotswarm-run-tests-all-providers.utH4Hs`.

| Final full gate | Result |
|---|---|
| PgFactStore SDK | 1,597 passed; 14 existing skips; zero failures |
| HorizonDB storage | 149 passed; no skips or failures |
| HorizonDB-backed SDK | 1,610 passed; one existing skip; zero failures |
| Combined wrapper | PASS, exit 0; no filters or skip flags |

The unit and browser totals listed above also passed on this frozen source.

1. Cleanup and the unchanged isolated rerun are complete. No production jobs or
   service configuration changed. The improvement strongly supports stale test
   loop load as the contributor; it does not pinpoint an upstream scheduler
   implementation defect.
2. The isolated outcome deadlines now pass. Retain the failure evidence and
   unchanged assertions rather than describing the earlier failure as a pass.
3. The clean complete `./scripts/run-tests.sh --all-providers` is now complete
   on the frozen candidate, including the HorizonDB-backed SDK.
4. Candidate image smoke checks and the two-stage PilotSwarm AKS rollout are
   complete. Effective policy, all image IDs, portal assets, readiness and
   MCP capabilities were verified as recorded below.

No Waldemort deployment or production session data has been modified. Local
protected environment/catalog files are unchanged. A future canonical deployment must explicitly carry
`AUTHZ_ADMIN_SCOPE=cluster` to retain that policy; do not assume an unset saved
environment will preserve a manually activated setting.

`--all-providers` means the two **storage configurations**, not every live LLM
vendor. Real SDK/CLI protocol fixtures cover GitHub isolation plus OpenAI,
Azure, OpenAI proxy, Anthropic and Anthropic WIF paths. Previous credentialed
migration probes passed GitHub Copilot Astra/Terra/Sonnet, Azure OpenAI and an
isolated CHK Anthropic-WIF probe; they are separately documented, not claimed
as rerun production probes for this admin change. No CHK changes are made here.

## Deployment record

Completed after the complete regression gate passed. Target:
`pilotswarm-aks`, namespace `copilot-runtime`.
Portal: <https://pilotswarm-portal.westus3.cloudapp.azure.com>.

Both candidates were built on Linux/amd64 in ACR using public npm with lockfile
integrity checks. The build context contains no private `.env` or model catalog;
it uses the checked-in deployment catalog. Immutable digests:

- Worker: `pilotswarmacr.azurecr.io/copilot-runtime-worker@sha256:f8a222c951884047af9319eb6325bf7068011a354dc17b648ade87069c9904c0`
- Portal/MCP: `pilotswarmacr.azurecr.io/pilotswarm-portal@sha256:b05fd83c68d012d0cebd799c103a9c74388b059f514dab0332ed893f51ede99f`

The rollout preserved live credentials, provider configuration, replica counts
and MCP keys. It first introduced compatible worker/portal binaries in
unrestricted mode, then activated cluster scope consistently, retired every
old worker and updated MCP after the portal reported the new policy. Only
`AUTHZ_ADMIN_SCOPE` was added to the shared runtime secret. The ACR pull token
was refreshed without deleting its secret. Canonical scripts were not run
because they delete/recreate shared environment/MCP secrets; the manual rollout
preserved those live credentials and used the exact tested image digests.
No database reset, package publication or `latest` retagging occurred.

### Verified live state

| Check | Result |
|---|---|
| Workloads | Eight workers, one portal and one MCP ready; zero restarts; no old/terminating replicas |
| Image identity | Every container uses the immutable digest recorded above |
| SDK/CLI | 1.0.13 / 1.0.83 in all ten running containers; no CLI-path override |
| Executable smoke | Both Linux/x64 images started the SDK's CLI, returned runtime 1.0.83/protocol 3 and a valid ping response |
| Worker/portal policy | All nine processes have cluster scope and ownership enforcement enabled |
| Public health | `ok=true`, `started=true`, `adminScope=cluster`, `policyVersion=1`, `ownershipEnforced=true` |
| Web-mode MCP | Admin identity, cluster scope, ownership enforced, `user_resource_bypass=false`, `system_session_admin=true` |
| CMS | Migration 0075 recorded; all six new authorization/accounting projection functions present |
| UI asset | Public portal and pod both serve `assets/index-roZtypKf.js` (previously `index-C0QHCdGe.js`); asset HTTP 200 |
| Model catalog | All ten containers match checked-in deploy catalog SHA-256 `3a3baf2e9502f53a7f9532d97162a4f5c9623226a547f49f22e061ab435a16b3` |
| Networking | Public DNS/ingress IP matched; HTTPS health and assets passed without disabling TLS verification |
| Startup logs | No error/fatal, CLI-resolution, snippy-rejection or database-failure matches in the ten new pods' available startup logs |
| MCP credentials | Both MCP secret UIDs and resource versions unchanged |
| Test-data retention | All 13 schemas associated with the approved cancellation still exist; no data deletion |

MCP obtains policy from the portal in Web mode; it does not need a local
`AUTHZ_ADMIN_SCOPE` override. Its read-only initialize/get-capabilities smoke
did not create an application session or send an LLM prompt. The temporary
MCP protocol session was explicitly closed.

Evidence under `/tmp/pilotswarm-admin-scope.at1Xgm`:
`image-smoke-final.log`, `deployed-pods.log`, `deployed-mcp.log`,
`deployed-migration.log`, `deployed-log-scan.log`,
`mcp-secrets-preserved.log`, and `preserved-schemas-final.log`.
The first temporary image probe incorrectly expected an exact echo rather
than the CLI's `pong: image-smoke` response. After correcting that probe-only
assertion and validating its timestamp, both image checks passed. No
application source, assertion in the regression suites or timeout was changed.

The two temporary image-check Jobs and the generated 27 MB build context were
removed. Logs, reproducible source, registry images and rollback digests remain.
The pre-existing local Postgres container was left as found; no local portal
was started. Waldemort CHK was not deployed or reconfigured.

This is an unreleased working-tree deployment: changes are **not committed or
pushed**, and no new release was cut. The accepted phase-1 system-session
backdoor remains. Live smoke checks establish deployment identity and policy;
the synthetic multi-user/browser suites supply the authorization matrix, not
new attempts to read real users' private production data.

### Rollback record

Previous worker digest:
`sha256:f1e5d5ba20e901ecf0b81f1d5e5603c5b7b23fd2b6edf573d34692796183dcff`.
Previous portal/MCP digest:
`sha256:6427ea51d74bf02c4571d919c4945f55c5a8b9edc1ebba7d0d174cdf23eed3a5`.
The previous deployment had no `AUTHZ_ADMIN_SCOPE` override (unrestricted).

An operator can restore unrestricted mode and restart the current compatible
binaries to roll back the policy independently. Restoring the old image digests
also restores their old admin semantics; that is a deliberate permission
expansion, not an invisible fallback. Keep additive CMS functions in place; do
not drop schemas, reset sessions or downgrade the durability engine/database.
Image rollback also restores the previous SDK/CLI behavior and its known
`snippy` compatibility risk.
