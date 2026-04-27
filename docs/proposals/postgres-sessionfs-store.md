# Proposal: Postgres-Backed Copilot SessionFs Store

## Status

Draft.

## Context

`@github/copilot` 1.0.36 exposes a `sessionFs` provider through the Copilot SDK. When enabled, the Copilot CLI routes session-scoped filesystem operations through callbacks supplied by the host application instead of writing only to the CLI's default local session directory.

This gives PilotSwarm a chance to replace tarball-based dehydrate/hydrate with a database-backed virtual filesystem. The primary goal is to make Copilot session state immediately available across workers without relying on local disk handoff.

The API surface is filesystem-shaped:

- `readFile(path)`
- `writeFile(path, content, mode?)`
- `appendFile(path, content, mode?)`
- `exists(path)`
- `stat(path)`
- `mkdir(path, recursive?, mode?)`
- `readdir(path)`
- `readdirWithTypes(path)`
- `rm(path, recursive?, force?)`
- `rename(src, dest)`

The provider should assume these calls are on the active session path and can be performance-sensitive. It should not make every small append into a slow cross-region transaction.

## Goals

- Store Copilot session state durably in Postgres.
- Allow any worker to resume a session without downloading/extracting a tarball first.
- Preserve filesystem semantics needed by the Copilot CLI.
- Support efficient append-heavy transcript writes.
- Support explicit session cleanup and retention.
- Make corruption and conflicting writers diagnosable.

## Non-Goals

- General-purpose shared filesystem semantics.
- Multi-writer editing of the same live Copilot session.
- Storing user workspace files. This is only for Copilot session-scoped state.
- Replacing CMS event history. CMS remains the product-level event timeline.

## Recommended Shape

Use a hybrid schema, in its own database schema:

1. All tables, sequences, and functions live in a dedicated Postgres schema **`copilot_sessions_fsstore`**, parallel to `copilot_sessions` (CMS) and `pilotswarm_facts`. This keeps grants, migrations, and `DROP SCHEMA ... CASCADE` reset semantics independent from the rest of the runtime.
2. A normalized filesystem table (`sessionfs_nodes`) for current path state.
3. An append journal (`sessionfs_append_segments`) — the **default** path for every `appendFile` call (see Operation Semantics below).
4. A lightweight per-session lease to prevent two workers from actively writing the same SessionFs.

## Access Pattern: Stored Procedures Only

Following the existing CMS / Facts conventions in this repo, **all reads and writes go through stored procedures** in the `copilot_sessions_fsstore` schema. No inline SQL in the TypeScript provider.

- Provider methods call `SELECT copilot_sessions_fsstore.fs_<verb>(...)` and nothing else.
- Every migration ships an idempotent `CREATE OR REPLACE FUNCTION` definition for the procs it changes, plus a companion diff file in `packages/sdk/src/migrations/NNNN_diff.md` per the [`schema-migration` skill](../../.github/skills/schema-migration/SKILL.md).
- Procs encapsulate the lease check, version bump, and node/segment mutation in a single round-trip and a single transaction. The provider never composes a multi-statement transaction client-side.

Minimum proc surface (names indicative):

- Reads: `fs_read_file`, `fs_stat`, `fs_exists`, `fs_readdir`, `fs_readdir_with_types`.
- Writes: `fs_mkdir`, `fs_write_file`, `fs_append_file`, `fs_rm`, `fs_rename`.
- Lease: `fs_acquire_lease`, `fs_refresh_lease`, `fs_release_lease`.
- Maintenance: `fs_coalesce_segments` (idempotent merge of pending segments into the node row).

## Schema

All tables and procs live in **`copilot_sessions_fsstore`**.

```sql
create schema if not exists copilot_sessions_fsstore;
set search_path to copilot_sessions_fsstore;

create table if not exists sessionfs_sessions (
    session_id text primary key,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz,

    -- The active writer lease is advisory at the app layer. It lets us fail
    -- fast if two workers accidentally attach the same live Copilot session.
    lease_owner text,
    lease_expires_at timestamptz,

    -- Monotonic version bumped by every mutating filesystem operation.
    version bigint not null default 0,

    metadata jsonb not null default '{}'::jsonb
);
```

```sql
create type sessionfs_node_type as enum ('file', 'directory');
```

```sql
create table if not exists sessionfs_nodes (
    session_id text not null references sessionfs_sessions(session_id) on delete cascade,

    -- Canonical POSIX-style path inside SessionFs. Root is '/'.
    path text not null,
    parent_path text not null,
    name text not null,
    node_type sessionfs_node_type not null,

    -- Default to bytea so we can faithfully store anything the Copilot CLI
    -- writes through the provider, including the SQLite session.db /
    -- session.db-wal / session.db-shm files. The SDK's TypeScript
    -- SessionFsHandler types are string-shaped, but the on-disk layout we
    -- replace is binary, and pretending it is UTF-8 risks silent corruption
    -- the first time the CLI hands us non-text bytes. The provider adapter
    -- converts at the boundary (Buffer <-> string) when the SDK API requires
    -- it. TODO: confirm against @github/copilot 1.0.36 source whether any
    -- write path is guaranteed-text; if so we can keep an opportunistic
    -- text projection for human inspection, but bytea remains the storage.
    content bytea,

    mode integer,
    size_bytes bigint not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    primary key (session_id, path),

    constraint sessionfs_file_has_content check (
        (node_type = 'directory' and content is null)
        or node_type = 'file'
    )
);

create index if not exists sessionfs_nodes_parent_idx
    on sessionfs_nodes(session_id, parent_path);
```

```sql
create table if not exists sessionfs_append_segments (
    session_id text not null references sessionfs_sessions(session_id) on delete cascade,
    path text not null,
    segment_no bigserial primary key,
    content bytea not null,
    size_bytes bigint not null,
    created_at timestamptz not null default now(),

    -- The filesystem session version after this segment was appended.
    fs_version bigint not null
);

create index if not exists sessionfs_append_segments_path_idx
    on sessionfs_append_segments(session_id, path, segment_no);
```

> Note: an earlier draft proposed a `sessionfs_operations` audit table. It
> has been **dropped**. Every mutation already bumps `sessionfs_sessions.version`
> and updates `sessionfs_nodes.updated_at`, so per-op forensics offered no
> information that wasn't recoverable from the live state plus runtime logs,
> at the cost of an extra insert and an ever-growing index per session. If
> we later need short-retention forensics for a specific incident class we
> can add a focused, time-bounded `sessionfs_audit` rather than a write-on-
> every-op table.

## Path Rules

The provider should canonicalize every incoming path before touching the database:

- Use POSIX separators.
- Require an absolute path or normalize relative paths under `/`.
- Collapse `.` and repeated separators.
- Reject any path that escapes root after `..` normalization.
- Represent root as `/`.
- Store parent paths canonically, for example parent of `/a/b.txt` is `/a`.

## Operation Semantics

### `mkdir(path, recursive, mode)`

- If `recursive` is true, upsert every missing parent directory.
- If false, require the parent directory to exist.
- If the path exists as a file, fail.
- If the path exists as a directory, succeed.

### `writeFile(path, content, mode)`

- Require parent directory to exist, unless the SDK is observed to depend on implicit parent creation. Prefer strict filesystem semantics first.
- Upsert a file node.
- Replace `content`, `size_bytes`, `mode`, `sha256`, and `updated_at`.
- Delete any uncoalesced append segments for that path because the replace supersedes them.

### `appendFile(path, content, mode)`

**Use the segment strategy by default.**

- Insert one row into `sessionfs_append_segments` (`session_id`, `path`, next `segment_no`, `content`, `size_bytes`, current `fs_version`).
- Bump `sessionfs_sessions.version`.
- Do **not** rewrite the `sessionfs_nodes.content` blob on every append.

Logical content of the file is `nodes.content || concat(segments.content order by segment_no)`. The transcript file `events.jsonl` is the obvious hot path and would otherwise force a full row rewrite per turn.

Coalescing:

- `writeFile` (truncate semantics) deletes all segments for that path.
- `fs_coalesce_segments(session_id, path)` merges segments into `nodes.content` and deletes them. Call it opportunistically when segment count crosses a threshold (e.g. > 64) and during dehydrate so a fresh hydrate does not have to range-scan a large segment list.
- Coalescing is a stored-proc-side operation and is idempotent; the read path tolerates being interleaved with it.

### `readFile(path)`

- Require file node.
- Return `nodes.content` concatenated with segments in `segment_no` order.
- May trigger a coalesce when the segment count is above the threshold; the read result is still the same logical bytes.

### `exists(path)`

- Return true if a node exists and the session is not deleted.

### `stat(path)`

- Return `isFile`, `isDirectory`, `size`, `mtime`, and `birthtime`.
- If using append segments, size should include pending segments.

### `readdir(path)`

- Require directory node.
- Return child names from `sessionfs_nodes where parent_path = path`.

### `readdirWithTypes(path)`

- Same as `readdir`, but include `file` or `directory`.

### `rm(path, recursive, force)`

- If missing and `force`, succeed.
- If missing and not `force`, fail.
- If file, delete the node and append segments.
- If directory and `recursive`, delete all descendants.
- If directory and not recursive, require empty.

### `rename(src, dest)`

- Must be atomic in one transaction.
- If file, move one node and its append segments.
- If directory, update the directory row and every descendant path.
- Require destination parent to exist.

## Lease Protocol

SessionFs is safest as single-writer. A worker should acquire or refresh a lease before creating/resuming a Copilot session:

```sql
update sessionfs_sessions
set lease_owner = $worker_id,
    lease_expires_at = now() + interval '2 minutes',
    updated_at = now()
where session_id = $session_id
  and (
      lease_owner is null
      or lease_owner = $worker_id
      or lease_expires_at < now()
  );
```

Every mutating operation should verify the lease owner. The runtime can refresh the lease periodically while the session is live and release it on dehydrate/close.

This is not a substitute for orchestration affinity. It is a guardrail against accidental double attachment.

## Transaction Pattern

Each mutating stored proc runs in a single transaction internally:

1. Verify or upsert `sessionfs_sessions`.
2. Verify lease.
3. Apply the filesystem mutation (node row update, segment insert, etc.).
4. Increment `sessionfs_sessions.version`.
5. Return the new version (and any read-back fields the provider needs).

There is no per-op audit insert (see schema note about the dropped
`sessionfs_operations` table). `appendFile` is one segment insert + one
version bump.

## Read Model

The provider can use short-lived SQL queries directly. It does not need to mirror the whole SessionFs to local disk.

A small per-session LRU cache is still useful for:

- `stat` and `exists` on hot paths.
- directory listings during session startup.
- coalesced content for files read multiple times in one turn.

Cache invalidation is simple because there is one active writer per session. Invalidate by path prefix on local mutations.

## Retention

SessionFs retention is **tied to the parent PilotSwarm session's retention** — no separate timer, no standalone cleanup job.

- `sessionfs_sessions.session_id` matches the PilotSwarm session id (the same id used in CMS).
- When the PilotSwarm session is deleted (user-initiated delete, sweeper, retention policy on CMS), the same lifecycle hook calls `copilot_sessions_fsstore.fs_drop_session(session_id)`. That proc deletes the row, and `on delete cascade` cleans up `sessionfs_nodes` and `sessionfs_append_segments`.
- We do not invent a SessionFs-specific retention policy. If CMS is keeping the session, SessionFs keeps the bytes. If CMS drops it, SessionFs drops it.
- Soft-delete on the parent (e.g. CMS `deleted_at`) does not immediately drop SessionFs rows; the same soft/hard-delete sweeper that removes the CMS row removes the FS rows in the same step.

## Migration Path

Phase 1: Keep current tarball dehydrate/hydrate. Add a Postgres SessionFs provider behind a feature flag and run it in local/integration tests.

Phase 2: Use Postgres SessionFs as the source of truth for new sessions. Keep tarball snapshotting as a backup export for a few releases.

Phase 3: Remove routine tarball dehydrate/hydrate for sessions using Postgres SessionFs. Dehydrate becomes mostly "release live Copilot session and worker lease"; hydrate becomes "acquire lease and resume with the same SessionFs provider."

## Open Questions

- Confirm against `@github/copilot` 1.0.36 source which paths the CLI writes through `SessionFsHandler` and whether any are guaranteed text. (Current assumption: treat all as binary; default storage is `bytea`.)
- Which paths are append-heavy in practice: `events.jsonl`, SQLite WAL traffic, provider-specific files? Tune the segment-coalesce threshold from real telemetry.
- Does the CLI rely on filesystem-level atomic rename for any critical file? If yes, `fs_rename` must keep its single-transaction guarantee.
- Should very large blobs (e.g. `session.db` past some threshold) be split into chunks or pushed to blob storage with a Postgres pointer? Defer until we measure real session sizes under SessionFs.

## Recommendation

Ship the dedicated `copilot_sessions_fsstore` schema with stored-proc-only access, `bytea` storage, segment-based `appendFile` from day one, no operations table, and retention bound to the parent PilotSwarm session. Keep the tarball dehydrate path as a fallback during phased rollout, then retire it once SessionFs is proven.

## Reviewer Feedback (Critical)

The following items were raised in design review and should be resolved
before (or as part of) implementation. They do not invalidate the shape
above, but they are the highest-leverage corrections.

### Latency / round-trips

A Copilot turn can fan out into dozens of `fs_*` calls (readdir → stat each
file → read `workspace.yaml` → append `events.jsonl` → write `session.db`).
Each call is one DB round-trip; that, not byte volume, is the dominant
cost.

- Add a **bootstrap proc** `fs_load_session_bootstrap(session_id)` that
  returns `workspace.yaml`, the full directory tree (paths + types +
  sizes), and the contents of every small file (e.g. `< 32 KB`) in a
  single round-trip. Eliminates the cold-start hydrate burst.
- Stash `workspace.yaml` directly on `sessionfs_sessions` as a
  `workspace_yaml bytea` column. It is read on every hydrate and is tiny;
  removing one node lookup at the hottest moment is worth the
  duplication.
- Use prepared statements: every `fs_*` call goes through `pg_prepare`
  once per pooled connection. Avoids per-call planner overhead.
- Allow pipelined writes within a turn: the SDK contract is per-path, so
  the provider may issue concurrent `writeFile` / `appendFile` to
  different paths in parallel.

### Storage layout

- Set the bytea columns to `STORAGE EXTERNAL` (no TOAST compression).
  Default `EXTENDED` will burn CPU compressing already-compact binary
  blobs (`session.db`, WAL) for little gain. If we want compression for
  text-heavy paths (`events.jsonl`), do it per-file-kind rather than
  globally.
- Drop `mode integer` unless we observe the CLI relying on POSIX mode
  bits through `SessionFsHandler`. Saves a column write per mutation.
- Drop `metadata jsonb` from `sessionfs_sessions` until we have a
  concrete consumer.
- Materialize size: add `pending_segment_bytes bigint` on
  `sessionfs_nodes`, bumped inside `fs_append_file` and zeroed inside
  `fs_coalesce_segments`. Then `fs_stat` is a single row read instead of
  a `SUM()` over segments.
- Coalesce thresholds should be both **count** *and* **bytes** (e.g. > 64
  segments **or** > 1 MB pending). One huge segment shouldn't have to
  wait for 63 friends.
- Consider a `coalesced bool` on `sessionfs_append_segments` plus a
  partial index `WHERE NOT coalesced` so the read path stays tight even
  after long-lived sessions accumulate history. Or just hard-delete on
  coalesce; either is fine, pick one and document it.

### Concurrency & correctness

- Use `pg_try_advisory_lock(hashtextextended(session_id, 0))` as the
  real per-session writer mutex. Keep `lease_owner` /
  `lease_expires_at` for human-readable diagnostics, but make actual
  exclusion live in PG advisory locks: zero clock skew, auto-released on
  PG connection death, no separate refresh timer needed. Implication:
  the provider must run the active session's writes on a sticky
  connection.
- Have every mutating proc return the new `(session_id, version)` pair.
  Cache invalidation by `(session_id, version)` is then trivial: if the
  cached version equals the latest returned version, entries are still
  good. No path-prefix bookkeeping, no risk of stale reads after a
  remote write through a different worker.
- `fs_read_file` must perform `concat(nodes.content, segments…)` inside a
  single proc query so a concurrent coalesce can't slice the read into
  "node updated, segments not yet deleted." One SELECT, one snapshot.
- Add an idempotency key (client-supplied UUID) on `fs_append_file` and
  `fs_write_file`, stored on the segment / node. Retries after a
  timed-out-but-server-committed RPC won't double-write — cheap
  insurance for the lossy-handoff pathways we just hardened.
- Document the no-batching rule explicitly: SQLite assumes "every write
  is durable when it returns," so each `fs_*` mutation must be its own
  committed transaction. A future "perf optimization" that coalesces
  two appends into one transaction would silently break SQLite
  durability assumptions.

### Operational guardrails

- Per-session size cap, enforced inside `fs_write_file` /
  `fs_append_file` (e.g. 200 MB hard cap, configurable). A runaway
  agent shouldn't be able to fill the cluster.
- `statement_timeout` set inside the proc bodies, not just at the
  connection level, so a stuck CLI cannot pin a row.
- Provide `fs_bulk_load_session(session_id, files[])` so Phase 2 can
  populate fsstore from an existing tarball in a single call rather than
  N `writeFile` RPCs.
- Backup story: with this design a session is recoverable iff Postgres
  is intact. Keep the tarball/blob path alive through Phase 2 as a cold
  backup, and call out that PG PITR is now part of session durability.

### Compatibility / unknowns to verify before building

- Instrument an existing CLI run and log every `SessionFsHandler` call
  (verb, path, byte size). Two days of telemetry settles most sizing
  decisions: chunking, large-blob handling, whether `session.db` is one
  `writeFile` or many partial writes.
- Confirm the CLI never needs `pwrite`-style partial writes (the API
  doesn't expose them, but worth proving).
- Confirm the CLI's SessionFs flow doesn't rely on rename-must-be-
  atomic-across-files. Single-file SQLite WAL mode shouldn't, but verify.

### Smaller nits

- Directory rename is `O(descendants)` because every child row's `path`
  text gets rewritten. Fine for the small trees we'll see; an
  inode-keyed alternative is future work, not v1.
- `sessionfs_node_type` could be a `text CHECK (node_type IN
  ('file','directory'))` instead of an enum if we ever want symlinks /
  sockets / FIFOs. Probably YAGNI.
- `segment_no bigserial` is a globally-shared counter and could become a
  minor write hotspot. If we ever shard by session, switch to
  `(session_id, segment_no)` with a per-session sequence.

## Test Plan

The goal is to prove correctness, durability, and performance against
the **same workloads the Copilot CLI actually generates**, not against a
synthetic filesystem benchmark. Tests live under
`packages/sdk/test/local/sessionfs/` unless noted.

### 1. Schema & migrations

- `sessionfs-migrations.test.js`: applies all migrations from a clean
  database, verifies idempotent re-apply, verifies
  `DROP SCHEMA copilot_sessions_fsstore CASCADE` cleans up everything
  (no orphans in `pg_proc`, `pg_class`, `pg_type`).
- `sessionfs-stored-procs-only.test.js`: greps the provider source for
  any non-`SELECT copilot_sessions_fsstore.fs_*` SQL and fails if found.
  Hard rule, mechanically enforced.

### 2. Per-operation semantics (unit-level, against a real Postgres)

One test file per `fs_*` proc, exercised through the TypeScript
provider, not raw SQL. Each file covers:

- happy path with returned `(version, payload)`
- not-found / wrong-type errors map to the SDK's `SessionFsError` shape
- `mkdir(recursive=false)` with missing parent fails
- `writeFile` truncates pending segments
- `appendFile` segment ordering survives interleaved writes
- `rm(recursive)` cascade vs. `rm(recursive=false)` on non-empty dir
- `rename` of file vs. directory; descendant `path` rewrite is observed

### 3. Read-after-write & snapshot consistency

- `sessionfs-read-during-coalesce.test.js`: pin one connection running a
  long `fs_coalesce_segments` (using an artificial lock or `pg_sleep`
  inside a test-only proc), concurrently call `fs_read_file`. Asserts
  the bytes returned equal `nodes.content || segments` as of one
  consistent snapshot (no torn reads).
- `sessionfs-cache-versioning.test.js`: provider caches `(version,
  bytes)`; after a concurrent write through a second connection bumps
  the version, the next read invalidates and refetches.

### 4. Lease / advisory-lock concurrency

- `sessionfs-lease-handoff.test.js`: worker A holds the lock, worker B
  blocks; kill A's PG connection (close the pool client); worker B's
  acquire returns within < 1s without manual lease cleanup.
- `sessionfs-double-attach.test.js`: two providers attach to the same
  `session_id` simultaneously; the second's first mutation is rejected
  with a clear error, not silent data loss.

### 5. Idempotency

- `sessionfs-idempotent-write.test.js`: call `fs_write_file` /
  `fs_append_file` twice with the same idempotency key; second call is
  a no-op (no new segment row, version unchanged).
- `sessionfs-retry-after-timeout.test.js`: simulate a server-committed
  RPC whose response is dropped (force-close socket between commit and
  return); the client retry must not double-write.

### 6. Coalesce

- `sessionfs-coalesce-threshold.test.js`: append 100 small segments;
  threshold-driven coalesce fires; final state is one node row, zero
  segments, identical bytes.
- `sessionfs-coalesce-concurrent-append.test.js`: appends arrive during
  a coalesce; resulting bytes match the concatenation order of all
  appends (no lost segment, no reordering).

### 7. Quotas & timeouts

- `sessionfs-quota.test.js`: per-session size cap rejects the offending
  write with a typed error and leaves the prior version intact.
- `sessionfs-statement-timeout.test.js`: a stuck transaction (held in a
  test fixture) is killed by `statement_timeout` rather than blocking
  the worker forever.

### 8. Bootstrap & hydrate

- `sessionfs-bootstrap-proc.test.js`: `fs_load_session_bootstrap`
  returns `workspace.yaml`, the full tree, and all small-file contents
  in one call; provider's first turn issues exactly one DB round-trip
  during hydrate.
- `sessionfs-bulk-load.test.js`: `fs_bulk_load_session` repopulates
  fsstore from a tarball-derived files array in one call; resulting
  bytes byte-equal the tarball.

### 9. Retention

- `sessionfs-retention-cascade.test.js`: deleting the parent PilotSwarm
  session (via the existing CMS sweeper) calls `fs_drop_session` and
  cascades to nodes + segments. No standalone retention timer fires.

### 10. End-to-end against the live Copilot SDK

- `sessionfs-e2e-one-turn.test.js`: real CLI turn with the SessionFs
  provider attached; assert the resulting `nodes` rows match the
  `sessionStateDir` produced by the legacy filesystem-only path
  byte-for-byte.
- `sessionfs-e2e-multi-worker.test.js`: turn 1 on worker A, dehydrate,
  turn 2 on worker B with a fresh local disk. Worker B reads zero
  files from local disk and reproduces the conversation.
- `sessionfs-e2e-crash-recovery.test.js`: kill worker A mid-turn; turn
  completes successfully on worker B; no `session.lossy_handoff` event
  is recorded.

### 11. Performance baselines (gated, run on demand)

- `sessionfs-perf-turn.test.js`: measure DB round-trip count and
  cumulative DB time per CLI turn. Fail if round-trips exceed a
  documented budget (initial target: ≤ 1 + 2 × *append count* per
  turn).
- `sessionfs-perf-cold-hydrate.test.js`: measure time-to-first-byte for
  a fresh worker hydrating a 90th-percentile session. Establish a
  baseline before launch; track regressions against it in CI perf
  reports under [perf/reports/](../../perf/reports/).

### 12. Telemetry-first prerequisite (do this before writing tests 8–11)

Before committing to thresholds and round-trip budgets, instrument the
current CLI run with a no-op `SessionFsProvider` shim that logs every
call (verb, path, byte size) for two days of representative traffic.
Decisions on chunking, the small-file inlining cutoff, and the
coalesce threshold should be driven by that data, not by guesses in
this proposal.

