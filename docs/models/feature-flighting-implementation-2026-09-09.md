# Feature flag implementation and test record

Branch: `codex/native-copilot-subagents-spike`. Pre-implementation checkpoint:
`5f03b336`. No Waldemort CHK deployment performed by this implementation.

## Delivered

- Migration **0077** adds exactly `feature_flags` and `feature_flag_settings`.
  It skips upstream's already assigned 0076. Feature catalog revision is the
  convergence/CAS token; package epoch and `fleet_directives` are unchanged.
- Code-defined `copilot.native_tasks`, published default OFF with user overrides
  locked. Explicit lookup `{ fallback: boolean }` or `{ required: true }`.
- Cluster enabled/allowUserOverride and optional user enabled values. Admin can
  manage all scopes; users can manage their own preference. No session settings.
- Management, HTTP/Web transport, MCP, and trusted Resource Manager/root/admin
  Agent Smith tools. Role checks run at each agent tool call. Tool declarations
  rebind on warm admin promotion/demotion; package tools cannot shadow them.
- Browser Settings → Feature flags: personal, cluster and selected-user tabs,
  Inherit/On/Off, cluster reset, directory search, revision and worker adoption.
  Terminal API adapters exist; terminal interactive feature controls are absent.
- Initial worker cache load and existing configuration poll (normally 20s),
  including workers without packages and with package refresh disabled. Complete
  changed-feature snapshots, stale last-good state, bounded reads and shutdown.
- Native admission uses persisted owner, runtime capability and eligibility.
  Missing/unreadable owner fails closed in CMS-backed sessions. No flag DB reads
  occur at turn/task admission. Applied OFF latches for the running turn even if
  ON follows it. Admitted tasks finish; ON is available on the next turn.

New CMS physical connections have a 10-second acquisition/handshake deadline to
prevent an abandoned feature read blocking pool shutdown. Feature operations also
use a 5-second database statement/lock deadline and a 6-second client query
deadline; failures destroy the transaction connection. This changes connection
acquisition behavior for the shared CMS pool, not for the separate facts/runtime
pools. An uncertain mutation is retried using the same request ID and revision.

## Adversarial findings resolved

1. A flag on an email placeholder blocked real-user registration through the FK.
   Migration carries preferences to the actual identity, preserves an existing
   real-user preference, advances revisions, and audits adoption. User/feature
   lock order also handles concurrent writes.
2. Warm role changes left stale declarations or duplicate feature handlers.
   Feature tool names are reserved and declarations are fingerprinted/rebound.
3. An unreadable session owner could accidentally use cluster ON despite user
   OFF. CMS-backed admission now requires a readable persisted owner.
4. Hung reads/handshakes could block startup, polling or shutdown. Deadlines and
   late-result disposal cover these paths; a real stalled TCP handshake test
   verifies catalog shutdown, beyond mocked promise tests.
5. UI metadata could wedge policy controls, stale requests could overwrite another
   user's view, and adoption stayed frozen. Independent bounded reads, identity
   guards, shared worker polling, and mutation retry handling address them.
6. Review identified test false positives: client-side stripping of spoofed fields,
   order-dependent API state, declaration-only re-enable assertions, and mocked
   package concurrency. Tests now send raw HTTP/direct-dispatch requests, reset
   state per test, verify fresh native filesystem evidence, and use the real guard.

## Reproducible verification

Run with `PS_TEST_DATABASE_URL` pointing to a local PostgreSQL test database:

```sh
npm run test:feature-flags
npm run test:native-delegation
npm run test:ui --workspace=pilotswarm
cd packages/app/web
../../../node_modules/.bin/playwright test --config playwright.config.mjs test/e2e/feature-flags.spec.mjs
```

The feature command builds SDK/MCP, checks compile-time lookup contracts, runs all
`feature-*` SDK tests and the real CLI transition suite, then the feature UI and
MCP protocol tests. PostgreSQL tests create/drop randomly named schemas; they do
not clear a deployment CMS schema. Test files cover:

| Layer | Evidence |
| --- | --- |
| Resolver/cache | precedence matrix, required/fallback policies, valid false, missing key/catalog, outage/retry, immutable snapshots, unset, coalescing, no admission I/O |
| PostgreSQL | fresh migration/catalog parity, CAS races, identical retries, stable row IDs, audit rollback, actor separation, constraints, two caches, ghost adoption/concurrent writes |
| HTTP | real router/runtime/management/store, all operations, admin/self denial, literal spoofed identity fields, unknown/invalid/conflict envelopes, reset/unset |
| MCP | real in-memory protocol client/server, schemas, user-ID argument placement, revision strings, explicit direct-admin grant |
| Worker | actual timer/refresh/heartbeat/stop paths, no packages, zero/positive intervals, real package guard during deferred epoch read, in-flight shutdown |
| Copilot CLI | both cluster/user OFF while native A runs, exact denial of B across immediate ON, A's file completion, fresh execution on enabled turns, forced task denial in OFF turn, warm/cold resume and clean task registry |
| Agent authority | warm promotion/demotion, fresh role checks, service-identity spoofing, reserved names, owner lookup failure |
| Browser | real controls in Chromium, self/admin scopes, user search, Off/Inherit, saved versus applied, refresh/drafts, mobile layout and themes |

Independent real-PostgreSQL deadline probe: `pg_sleep(8)` was cancelled after
5.019 seconds, the failed connection was destroyed, and a subsequent query
succeeded. CLI inference is scripted locally: these tests exercise real tool and
filesystem execution but do not claim a live LLM reliably selects delegation.
The two credential-dependent live Terra filesystem evaluations remain opt-in and
were not rerun for this policy feature.

## Verification results

- `npm run test:feature-flags`: **66 SDK tests + 13 UI/MCP tests passed**; SDK/MCP
  builds and compile-time lookup contract passed.
- Native regression: **168 Node tests + 69 SDK tests passed**, two live-model
  cases skipped because they are explicitly opt-in.
- UI core/render suite: **705 passed**. Feature Chromium E2E: **4 passed**.
- API/Web regression: **150 passed**, 22 unrelated database integration cases
  skipped because their separate default Postgres endpoint was unavailable.
  The feature PostgreSQL and HTTP integration tests ran against the local test DB.
- Existing MCP unit suites passed. SDK, MCP and production Web builds passed.
- Independent final reviews report no remaining blockers in the reviewed code
  and tests. Localhost UI visually checked with real API responses: effective
  ON for the local user, cluster OFF, worker **1/1 applied revision 3** with sync
  capability. Existing session history was preserved during restart.

## Local testing and CHK rollout

Local target remains `http://127.0.0.1:3017/`. Preserve existing sessions/database;
configure cluster OFF + allowUserOverride and opt the local testing identity ON.
At CHK rollout, first deploy feature-aware portal/workers with native capability
OFF, seed cluster OFF + override allowed and the requester's user ON, then enable
worker capability and verify adoption. Old workers interpret the env capability
cluster-wide, so they must not run `sync` during mixed-version rollout.

Because users may set their own preferences when overrides are allowed, that
initial configuration is not an exclusive allowlist. A cluster emergency stop is
OFF with allowUserOverride=false, followed by checking worker adoption. Database
outages retain last-good policy and delay convergence; env OFF remains the
independent deployment cap.
