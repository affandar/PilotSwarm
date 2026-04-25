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

Use a hybrid schema:

1. A normalized filesystem table for current path state.
2. An append journal for fast `appendFile` operations and recovery/audit.
3. A lightweight per-session lease to prevent two workers from actively writing the same SessionFs.

For most paths, `writeFile` replaces the row in `sessionfs_nodes`. For known append-heavy files, `appendFile` writes a segment row and optionally coalesces segments into the node content asynchronously or at read time.

## Schema

All table names below assume the existing app schema prefix, for example `copilot_runtime`.

```sql
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

    -- Text content is enough for the current SDK API, which exposes UTF-8
    -- strings. Use bytea only if the SDK later grows binary file operations.
    content text,

    mode integer,
    size_bytes bigint not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    -- Optional content hash for diagnostics and idempotency.
    sha256 text,

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
    content text not null,
    size_bytes bigint not null,
    created_at timestamptz not null default now(),

    -- The filesystem session version after this segment was appended.
    fs_version bigint not null
);

create index if not exists sessionfs_append_segments_path_idx
    on sessionfs_append_segments(session_id, path, segment_no);
```

```sql
create table if not exists sessionfs_operations (
    op_id bigserial primary key,
    session_id text not null references sessionfs_sessions(session_id) on delete cascade,
    operation text not null,
    path text,
    dest_path text,
    size_bytes bigint,
    worker_id text,
    fs_version bigint not null,
    created_at timestamptz not null default now(),
    metadata jsonb not null default '{}'::jsonb
);

create index if not exists sessionfs_operations_session_idx
    on sessionfs_operations(session_id, op_id desc);
```

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

Two viable strategies:

1. **Simple strategy:** lock the file row, concatenate `content`, update the node.
2. **Segment strategy:** insert a row into `sessionfs_append_segments`; read path content as node base content plus ordered segments.

Recommendation: start with the simple strategy unless profiling shows append contention or large transcript costs. The CLI debounces event flushing, so appends should already arrive in batches rather than per token. Keep the segment table available as an optimization path.

### `readFile(path)`

- Require file node.
- Return `content`, plus any uncoalesced append segments if using the segment strategy.
- For segment strategy, optionally coalesce after reading when segment count crosses a threshold.

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

Every mutating operation should:

1. Start a transaction.
2. Verify or create `sessionfs_sessions`.
3. Verify lease if enabled.
4. Apply filesystem mutation.
5. Increment `sessionfs_sessions.version`.
6. Insert a `sessionfs_operations` row.
7. Commit.

For small writes this is enough. If profiling shows too much overhead, `appendFile` can use a lighter segment insert with periodic coalescing.

## Read Model

The provider can use short-lived SQL queries directly. It does not need to mirror the whole SessionFs to local disk.

A small per-session LRU cache is still useful for:

- `stat` and `exists` on hot paths.
- directory listings during session startup.
- coalesced content for files read multiple times in one turn.

Cache invalidation is simple because there is one active writer per session. Invalidate by path prefix on local mutations.

## Retention

SessionFs state can be deleted when:

- The PilotSwarm session is deleted.
- A retention job sees a terminal session older than policy.
- A migration confirms a tar/blob snapshot exists and SessionFs rows are no longer needed.

Suggested query:

```sql
delete from sessionfs_sessions
where deleted_at is not null
  and deleted_at < now() - interval '30 days';
```

`on delete cascade` cleans up nodes, append segments, and operations.

## Migration Path

Phase 1: Keep current tarball dehydrate/hydrate. Add a Postgres SessionFs provider behind a feature flag and run it in local/integration tests.

Phase 2: Use Postgres SessionFs as the source of truth for new sessions. Keep tarball snapshotting as a backup export for a few releases.

Phase 3: Remove routine tarball dehydrate/hydrate for sessions using Postgres SessionFs. Dehydrate becomes mostly "release live Copilot session and worker lease"; hydrate becomes "acquire lease and resume with the same SessionFs provider."

## Open Questions

- Does Copilot ever write binary data through SessionFs, or is UTF-8 text sufficient for all 1.0.36 calls?
- Which paths are append-heavy in practice: `events.jsonl`, `workspace.yaml`, SQLite/WAL files, or provider-specific files?
- Does the CLI require filesystem-level atomic rename behavior for any critical file updates?
- Should `sessionfs_operations` be retained long term, or only kept for recent debugging?
- Should large file content be stored inline in Postgres or split into chunks/blob storage after a threshold?

## Recommendation

Start with the normalized filesystem table plus strict single-writer lease and simple append concatenation. It is the easiest design to validate against the SDK's current behavior. Add append segments only if profiling shows that `appendFile` dominates latency or row rewrite costs.

