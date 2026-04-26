# pilotswarm-sessionfs-pg

Postgres-backed Copilot `SessionFsProvider`. **Standalone** — not yet wired into the PilotSwarm runtime.

Implements the design in [`docs/proposals/postgres-sessionfs-store.md`](../../docs/proposals/postgres-sessionfs-store.md), with two deviations confirmed empirically while wiring it to a real Copilot CLI:

1. Storage is `text` (not `bytea`). The SDK's [`SessionFsProvider`](../../node_modules/@github/copilot-sdk/dist/sessionFsProvider.d.ts) API is string-typed end-to-end.
2. The package ships its own [`createPgSessionFsHandler`](src/handler.ts), not the SDK's [`createSessionFsAdapter`](../../node_modules/@github/copilot-sdk/dist/cjs/sessionFsProvider.js). `@github/copilot` 1.0.36 calls the handler with **positional path arguments** (`handler.readFile(path)`), not the `{path}` request envelopes the SDK's `generated/rpc.d.ts` documents. The SDK's own adapter destructures `({path})` and ends up handing providers `undefined`. See the e2e test for a worked example.

## Layout

```
src/
  index.ts                   public API
  store.ts                   PgSessionFsStore (pool + schema lifecycle)
  provider.ts                createPgSessionFsProvider — the typed core
  handler.ts                 createPgSessionFsHandler  — Copilot SDK shim
  path.ts                    POSIX canonicalization
  migrations.ts              ordered MigrationEntry list
  migrator.ts                wrapper around the vendored pg-migrator
  _pg-migrator.ts            vendored advisory-lock migrator
  migration_0001_schema.ts   tables, enum, root-dir trigger
  migration_0002_procs.ts    every fs_* stored procedure
test/
  helpers.js                 random schema + auto-drop
  standalone.test.js         every fs_* op, no SDK
  copilot-sdk.test.js        e2e: real Copilot session, all FS in PG
```

## Running tests

```bash
cd packages/sessionfs-pg
npm run build

# standalone (needs DATABASE_URL)
npm run test:standalone

# end-to-end against the real Copilot SDK (needs DATABASE_URL + GITHUB_TOKEN)
npm run test:copilot-sdk
```

Each test gets a freshly randomized schema (`copilot_sessions_fsstore_test_<rand>`) and drops it on teardown, so suites can run in parallel against the same database.

## What's intentionally missing (from the proposal)

- Lease / advisory-lock writer mutex
- Idempotency keys
- `fs_load_session_bootstrap`, `fs_bulk_load_session`
- `fs_coalesce_segments` is implemented but not yet auto-triggered
- Per-session size cap, `statement_timeout` inside procs
- `(session_id, version)` cache layer in the provider
- `STORAGE EXTERNAL` tuning
- Telemetry instrumentation

These are tracked in the proposal under "Reviewer Feedback (Critical)". Add them as separate migrations / refactors once the basic provider is exercised against real Copilot traffic.
