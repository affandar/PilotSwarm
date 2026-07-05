# Postgres as the Artifact + Session-Snapshot Store

Status: proposal (2026-07-04)
Companion: [session-lifecycle-protocol.md](./session-lifecycle-protocol.md) —
the checkpoint/affinity protocol that drives this store. This document covers
only the storage backend: schema, costs, and migration. The store's version +
CAS contract (§schema below) exists to serve that protocol but is useful to
any backend.

## What lives in blob storage today

Two object families share one abstraction pair (`session-store.ts`):

| Family | Interface | Implementations | Shape | Size envelope | Access pattern |
|---|---|---|---|---|---|
| Session snapshots | `SessionStateStore` (dehydrate / hydrate / checkpoint / exists / delete) | `SessionBlobStore` (Azure Blob), `FilesystemSessionStore` (local) | tar of the Copilot SDK session dir | ~0.1–10 MB typical, unbounded today | whole-object write on every dehydrate/checkpoint, whole-object read on every hydrate; cron agents cycle this every wake-up |
| Artifacts | `ArtifactStore` (upload / download / list / delete / exists) | `SessionBlobStore` (Azure Blob), `FilesystemArtifactStore` (local) | agent/user files | capped: 1 MiB text, 10 MiB binary (`session-store.ts`) | rare writes, portal list/download reads |

Both patterns are **whole-object**: nothing range-reads a tar or an artifact.
`downloadArtifact` already returns a fully buffered `Buffer`; hydrate untars a
fully downloaded file. There is no streaming requirement to preserve.

## Why Postgres fits

1. **"Just add a connection string" becomes literally true.** CMS, facts,
   HorizonDB graph, and duroxide state are already Postgres. Blob storage is
   the last non-PG dependency; folding it in removes the Azure Storage
   account, its connection string/MI plumbing, and the whole SAS story from
   every deployment (starter Docker, local dev, new envs).
2. **The size envelope is comfortably sub-TOAST.** Artifacts are capped at
   10 MiB; snapshots run single-digit MB. Postgres handles bytea values in
   this range without ceremony (hard limit 1 GB; practical comfort tens of
   MB per value).
3. **GC becomes transactional and stops leaking.** Today blob deletion is
   best-effort and drifts from CMS truth — `scripts/_purge_blobs.mjs` exists
   precisely because orphaned blobs accumulate. In PG the sweeper's
   `cleanup_session` and `cms_..._system_restart_archive` can delete
   snapshots + artifacts in the same transaction as the session rows.
   The May-31-style "trim events, keep sessions" retention ops also become
   one SQL statement instead of a cross-system reconciliation.
4. **SAS goes away cleanly.** Managed-identity deployments already cannot
   mint SAS URLs (`generateArtifactSasUrl` throws; the portal proxies
   downloads through the Web API). A PG store makes the proxy path the only
   path — which is the path that already works everywhere.
5. **Latency is competitive or better.** Same-region PG round-trip for a
   2 MB value is ~20–50 ms vs ~50–200 ms for Blob; hydrate/dehydrate sit on
   the turn-latency critical path (see
   `docs/bugreports/runturn-activity-start-latency-20260420.md`).

## Schema sketch

Own schema (`pilotswarm_blobs`), own migrator (lock seed pattern from
`pg-migrator.ts`), all access via stored procs per the schema-migration
skill. One row per object; no chunking (nothing needs range reads).

```sql
CREATE TABLE ${s}.session_snapshots (
    session_id   TEXT PRIMARY KEY,
    tar          BYTEA NOT NULL,          -- ALTER ... SET STORAGE EXTERNAL
    version      BIGINT NOT NULL,         -- monotonic; CAS'd on every write
    turn_key     TEXT,                    -- committing turn's key (NULL = legacy write)
    size_bytes   BIGINT NOT NULL,
    content_hash TEXT NOT NULL,           -- sha256 of tar (integrity + no-op elision)
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    meta         JSONB                    -- reason/worker/etc — informational only
);

CREATE TABLE ${s}.artifacts (
    session_id   TEXT NOT NULL,
    filename     TEXT NOT NULL,
    body         BYTEA NOT NULL,          -- STORAGE EXTERNAL
    content_type TEXT NOT NULL,
    is_binary    BOOLEAN NOT NULL,
    source       TEXT NOT NULL,
    size_bytes   BIGINT NOT NULL,
    uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, filename)
);
```

`STORAGE EXTERNAL` skips TOAST's pglz pass — tars should be gzipped at
creation (cheap, better ratio) and double-compression wastes CPU.

### The store contract, as built

The lifecycle protocol shipped (orchestration 1.0.57) with the versioned
CAS contract implemented over the filesystem and Azure Blob backends. A
`PgSessionStateStore` implements the SAME TypeScript interface
(`VersionedSnapshotStore`, `packages/sdk/src/snapshot-protocol.ts`) and
must pass the SAME shared conformance suite
(`packages/sdk/test/helpers/snapshot-conformance.js`) the other two
backends pass. The contract, mapped to SQL:

- `probeSnapshot(sessionId)` — one indexed SELECT of
  `{version, turn_key, content_hash, size_bytes}`; no `tar` bytes touched.
  A row whose `version` is NULL/0 (or predates the column) reports
  `{version: 0, legacy: true}`. This probe is what makes a warm resume
  cost a 64-bit read instead of a multi-MB transfer.
- `commitSnapshot(sessionId, {baseVersion, turnKey})` — one CAS statement:
  `UPDATE ... SET tar=$2, version=version+1, turn_key=$3, ...
  WHERE session_id=$1 AND version=$4`. Zero rows updated → re-read the row:
  stored `version == baseVersion+1 AND turn_key == turnKey` → return
  `{alreadyCommitted: true}` (the caller's racing/prior attempt won —
  idempotent success); anything else → `SnapshotConflictError` carrying the
  stored `{version, turn_key}` (split-brain fence, loud). Missing row with
  `baseVersion > 0` → INSERT at `baseVersion + 1` (store lost data; the
  chain stays monotonic). Legacy row (`turn_key` NULL, version 0) with
  `baseVersion 0` → upgrade to version 1.
- `hydrateSnapshot(sessionId)` — SELECT the row, unpack the tar into a
  temp dir, atomic-rename into place, verify `content_hash` against the
  bytes. Returns `{version, turnKey, contentHash, sizeBytes}`.
- **Legacy fences** (both other backends already enforce this): the legacy
  `dehydrate()`/`checkpoint()` writes must refuse to overwrite a row
  carrying a version — dehydrate degrades to local release, checkpoint to
  a no-op — so a stray ≤1.0.56 writer can never destroy the CAS chain.

One structural simplification the implementation bought: **the committed
turn's result rides INSIDE the tar** (`.ps-turn-commit.json`), so no
result payload lives in store metadata at all — no column, no size cap,
no truncation fallback. Already-committed recovery downloads the tar it
needs anyway and reads the result from it. Version-less legacy writes
(≤1.0.56 dehydrates) are accepted as unconditional writes so old and new
orchestration executions coexist during rollout.

**Object-store construction (Azure Blob).** Blob storage has no server-side
counter, but it has the two primitives the contract needs: every blob
carries an opaque **ETag** that changes on every write, and write
operations accept conditional headers (`If-Match: <etag>` — succeed only if
the blob is unchanged since it was read; `If-None-Match: *` — succeed only
on create). The version is an explicit counter stored in blob **metadata**,
written atomically with the content (Put Blob sets body + metadata in one
operation). The ETag is never the version — it is opaque and changes on
*any* write including metadata-only ones; it serves purely as the
atomicity token that binds a read to the write that follows it.

- Layout (as built): `<id>.tar.gz` with metadata
  `{psver, psturnkey, pssha}` — the turn result rides inside the tar, so
  blob metadata stays tiny and the ~8 KB metadata cap never binds.
- `probeSnapshot`: HEAD → read `psver` + ETag; matching local marker →
  warm start with zero body transfer.
- `commitSnapshot({baseVersion, turnKey})` — an optimistic CAS loop:
  1. HEAD → `{etag E, version v, turnkey k}`.
  2. `v == baseVersion` → single-shot **Put Blob** (new tar + metadata
     `{psver: v+1, psturnkey, pssha}`) with `If-Match: E`. Success =
     committed exactly once. A 412 Precondition Failed means a racing
     write landed between the HEAD and the PUT → re-HEAD, re-evaluate.
  3. `v == baseVersion + 1 && k == turnKey` → the caller's own prior or
     racing attempt already committed → idempotent success, return the
     stored values.
  4. Anything else → split-brain, loud failure.
  The first-ever write uses `If-None-Match: *` (atomic create, version 1).
- Two footguns the implementation must respect: use **single-shot Put
  Blob**, never staged Put Block / Put Block List — the condition is only
  evaluated at the commit step, and concurrent writers staging blocks under
  the same blob name can interleave (the ≤64 MB snapshot cap fits
  single-shot comfortably); and never bump the version via Set Blob
  Metadata — that would decouple the counter from the content it
  describes.
- Legacy version-less writes (1.0.56 dehydrates) run the same loop with
  `expectedVersion := whatever the HEAD returned`, keeping the counter
  monotonic under mixed old/new writers.

Net: the identical contract at two round trips per commit (HEAD +
conditional PUT) plus retries under contention, versus PG's single
conditioned UPDATE with the row returned on mismatch. Both backends
satisfy the protocol; PG is simply where the contract is one statement.

New providers `PgSessionStateStore` / `PgArtifactStore` implement the existing
interfaces (`SessionStateStore` + `VersionedSnapshotStore`, and
`ArtifactStore`); `storage-providers.ts` selects them via explicit config
(`PILOTSWARM_BLOB_BACKEND=postgres`) with the current Azure/filesystem
behavior unchanged by default until a major release flips the default.

## The two real costs, and their mitigations

**1. Write churn → TOAST bloat + WAL volume.** Under today's lifecycle, cron
agents re-dehydrate on every wake. A fleet like waldemort (~15 recurring
sessions × ~48 cycles/day × ~2 MB) rewrites ~1.5 GB/day; every rewrite is
dead TOAST tuples for autovacuum plus full-value WAL (and PITR retention
amplifies it).

- **The companion protocol is the big lever**: checkpoint-hold replaces the
  dehydrate/hydrate cycle, so steady-state traffic drops to one compressed
  write per *turn* (~150 MB/day for the same fleet) and near-zero reads.
- **Content-hash skip-write** covers what the protocol doesn't: legacy
  1.0.56 executions still dehydrating during rollout, and drain-time
  release verifies. If the new tar's sha256 matches `content_hash`, skip
  the UPDATE entirely — an unchanged wake-up costs one SELECT of a 64-char
  column instead of a 2 MB rewrite.
- Aggressive per-table autovacuum settings on the two blob tables.
- Optionally a **separate database on the same server** for the blob schema
  (the config split already exists for CMS/facts URLs), isolating backup and
  WAL policy from the transactional data.
- These tables must stay LOGGED: after dehydrate removes local files, the
  snapshot is the only copy of the session state.

**2. Connection memory + pool occupancy.** node-postgres buffers whole rows;
a transfer holds a pool connection for its duration.

- Enforce a snapshot size cap (e.g. 64 MB, configurable) — Azure mode has no
  cap today, so this is a net win; the cap failure mode is loud (dehydrate
  error) rather than silent.
- Small dedicated pool (2–4 connections) for blob traffic so a burst of
  hydrations cannot starve CMS queries.

## Migration path

1. Ship providers + migration behind `PILOTSWARM_BLOB_BACKEND=postgres`.
2. Dual-read fallback for one release: hydrate/download tries PG, falls back
   to the configured legacy store, and writes-through to PG (lazy migration —
   a session migrates itself on its next dehydrate cycle; artifacts on next
   touch or via a one-shot copy script).
3. Sweeper gains snapshot/artifact deletion in `cleanup_session` (replacing
   the orphan-purge script), plus a `get_system_stats` blob-size readout.
4. After a bake period: flip the starter/docker default to PG, keep Azure as
   opt-in for deployments that want blob-tier economics.

## Prior art: "filesystems on Postgres" and what to take from them

Surveyed categories, none adoptable wholesale:

- **Large Objects (`lo` / `pg_largeobject`)** — built-in streaming file API
  (seek, 4 TB max). Rejected: all objects' pages share one system catalog
  (centralized bloat/vacuum contention vs. per-table autovacuum), orphan
  cleanup needs `vacuumlo` (recreates the blob-leak chore), coarse ACLs,
  `pg_dump` special-casing. Its sole advantage — streaming objects too big
  to buffer — is a non-requirement under our caps. A chunked ordinary table
  strictly dominates.
- **FUSE filesystems over PG** (pgfuse et al.) — abandoned research-ware;
  POSIX-over-SQL is the wrong impedance and we need six methods, not POSIX.
- **Object stores with PG metadata** (Supabase Storage, SeaweedFS filer+PG)
  — well-maintained, but they keep bytes on S3/disk: the second storage
  system is the thing this proposal removes. They do validate PG-for-file-
  metadata as an industry pattern.
- **Tiering extensions** (pg_tier, Timescale tiered storage) — transparent
  cold-partition offload to object storage; a future lever for multi-year
  snapshot retention, premature now.
- **Content-defined chunking + content addressing (restic/borg/git)** — the
  file-world technique that actually fits our pattern (versioned re-upload
  of mostly-identical tars). Phase-2 design if churn math demands it:

  ```sql
  CREATE TABLE ${s}.chunks (
      hash     TEXT PRIMARY KEY,   -- sha256 of body
      body     BYTEA NOT NULL,     -- ~256 KB CDC chunks, compressed per-chunk
      refcount INT NOT NULL DEFAULT 0
  );
  CREATE TABLE ${s}.snapshot_manifests (
      session_id   TEXT PRIMARY KEY,
      chunk_hashes TEXT[] NOT NULL,
      size_bytes   BIGINT NOT NULL,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ```

  Consecutive dehydrates are ~95% identical, so daily churn collapses from
  GBs of rewrites to MBs of new chunks, with cross-session dedup free.
  Gotchas from the file world: tar creation must be deterministic (sorted
  entries, zeroed mtimes) or ordering noise defeats dedup, and compression
  must happen per-chunk after chunking — gzipping the whole tar destroys
  chunk-boundary stability. GC is a transactional refcount decrement — no
  `vacuumlo` analog.

Phase 1 (one row per object + sha256 skip-write) already eliminates the
dominant churn case (unchanged idle wake-ups) for near-zero complexity;
phase 2 slots behind the same interfaces without a config change.

## When this is the wrong tool

- Artifacts meaningfully above ~50 MB (video, large datasets) — keep the
  Azure provider available for those deployments; the cap makes the failure
  explicit.
- Deployments whose PG is small/burstable while their sessions are huge —
  blob storage is cheaper per GB than PG storage + WAL + backups. The
  backend stays configurable for exactly this reason.

## Measured: waldemort as a sample (2026-07-04)

Container inventory (`copilot-sessions`, live account):

| Family | Count | Total | p50 | p90 | Max |
|---|---|---|---|---|---|
| Session tars | 834 | 1,159 MB | 182 KB | 498 KB | **151 MB** |
| Artifacts + misc | 2,032 | 8.5 MB | 3.6 KB | 9.9 KB | 40 KB |

Top-5 tars hold 448 MB (39% of tar bytes) — two ~150 MB whales dominate.

Churn (CMS `session.dehydrated`/`hydrated` events + storage metrics):

| Metric | Steady day | Rollout day |
|---|---|---|
| Dehydrate+hydrate pairs | ~250–320 | ~1.8k–2.9k |
| Blob ingress (writes) | 2.3–6.2 GB/day | ~14 GB/day |
| Blob egress (reads) | 1–3 GB/day | ~7 GB/day |
| Transactions | 1k–3.5k/day (~0.02 avg IOPS) | 17k/day |

Key readings: IOPS are trivial for any PG tier; **bytes are whale-dominated**
(mean dehydrate ≈ 15 MB vs 182 KB median — a handful of sessions cycling
~150 MB tars produce ~99% of traffic). Naive phase-1 would therefore add
~5–15 GB/day of heap+TOAST+WAL device writes and comparable PITR/WAL backup
growth — acceptable IOPS, unacceptable write amplification. The hash
skip-write helps rollout-day mass dehydrates (idle sessions unchanged) but
not active watchers whose workspaces append logs every cycle. Conclusion
for waldemort-class fleets: **CDC chunking is the requirement, not the
optimization** (reduces PG ingress ~30–100× to ~50–200 MB/day and lets
reads stream per-chunk, which also dissolves the whale memory problem) —
*or* whale remediation first: audit why two session workspaces tar to
150 MB (likely repo checkouts/logs that belong in tar excludes); with
whales fixed, phase-1 alone fits comfortably (+~1.2 GB resident on a
3.1 GB database, tens of MB/day churn).

## Lab results (2026-07-04, local starter + HorizonDB)

Method: a real session driven for 21 turns in the 0.4.1 starter container
(gpt-5.4), capturing the actual dehydrated `.tar.gz` after every turn;
CDC chunker (gear hash) + chunk store implemented against a live HorizonDB
instance; production measurements on the waldemort fleet.

- **Correctness (E2)**: all 21 snapshots stored to and restored from
  HorizonDB byte-exact (sha256). Store ~0.55 s, restore ~0.2 s per ~3 MB
  snapshot including WAN; WAL 0.6–2.2 MB per snapshot at 256 KB chunks.
- **Chunk size (E3)**: dedup collapses when chunks exceed the delta
  spacing. Steady-state per-snapshot dedup: 16 KB → **95%**, 64 KB → 90%,
  256 KB → 12–37%, 1 MB → 0%. Use 16–64 KB for session tars; manifest
  overhead at 16 KB is ~90 KB of hashes per 23 MB snapshot.
- **Compression (E4)**: on real `events.jsonl` chunk bodies, brotli-4
  achieves **11.6:1 at 295 MB/s** vs gzip-6's 3.1:1 at 62 MB/s. Brotli-4
  (built into node:zlib) is the codec.
- **Production append-only proof (E5)**: the fastest-cycling waldemort
  watcher (145 dehydrates/day, 23 MB tar) measured across a live cron
  cycle: +100 KB growth, 4 of 911 chunks new (166 KB) → **99.28% dedup**,
  through whatever live compaction/bookkeeping the session performs.
- **Churn forensics**: the 150 MB whales are dormant (blobs unmodified
  since Jun 1). Actual ingress (~3.7 GB/day) comes from three active
  watchers (21.5 MB × 92 + 7.6 MB × 145 + 8.2 MB × 72 cycles/day).
  With 16 KB chunks + brotli-4, that becomes roughly **10–40 MB/day of
  stored bytes** — three orders of magnitude below naive re-upload.

- **End-to-end latency (in-pod, real 23.6 MB watcher tar, medians of 3)**:

  | Path | Dehydrate | Hydrate | Stored/cycle |
  |---|---|---|---|
  | Blob today (gzip-6 + upload) | 763 ms (586 CPU) | 112 ms | 7.91 MB |
  | PG naive (whole-file brotli-4, 1 row) | **140 ms** | **77 ms** | 0.51 MB |
  | PG chunked first store | 1,179 ms | — | 4.64 MB |
  | PG chunked steady state | 385 ms | 293 ms | **0.01 MB** |

  PG naive beats the blob path in BOTH directions (gzip CPU dominates the
  blob dehydrate). Whole-file brotli reached 46:1 on this quiet-watcher
  tar (repetitive JSONL; busy sessions will land nearer 4–10:1). Chunked
  steady-state stores ~50× less again but pays ~300 ms of chunk+hash CPU
  per dehydrate and ~3× hydrate latency — still trivial next to turn
  overhead. Revised phasing: **phase 1 = whole-object rows + whole-file
  brotli-4 + sha skip-write** (simpler AND faster than today, ~15–30×
  byte reduction); **phase 2 = CDC chunking**, triggered by sessions whose
  compressed deltas stay large or by whale-scale streaming-hydrate needs.

Follow-up experiment (planned): hand-compaction of `events.jsonl` —
truncate/rotate the log in the local lab and verify the SDK still resumes
the session, since the log is confirmed append-only and unbounded.

## Test plan

The guiding principle: **the backend is only novel at the store boundary.**
Everything above it — the runTurn preamble/postamble, orchestration 1.0.57,
eviction, drain — is backend-agnostic by construction, proven by the same
suites passing over the filesystem and Azure Blob stores. So the PG suite
buys maximum coverage by being exhaustive AT the boundary and surgical
above it, instead of re-running the ~1 h full suite per backend for near-
zero marginal coverage.

Three tiers, one npm script (`test:local:pg-store`), total budget
**~15 minutes** against the same local Postgres the suite already requires
(isolated `pilotswarm_blobs_test_<ts>` schema per run, dropped in
afterAll — the pattern the blob suite uses with throwaway containers).

### Tier 1 — contract conformance (seconds, exhaustive at the boundary)

- **Snapshot conformance:** register the EXISTING shared suite
  (`registerSnapshotConformanceSuite`) against `PgSessionStateStore` —
  zero new test logic. Covers: create/chain/monotonicity, idempotent
  same-turnKey retry, foreign-writer conflict with stored coordinates,
  byte-exact atomic hydrate, legacy version-0 detection + upgrade,
  chain-restart at base+1, the N-writer CAS race (exactly one winner),
  tar exclusion rules, and the legacy dehydrate/checkpoint fences.
- **PG-specific extras** (the risks unique to this backend, cheap to test
  directly):
  - large-snapshot round-trip (~32 MB bytea) — exercises STORAGE EXTERNAL
    TOAST paths and node-postgres buffering;
  - commit with a poisoned/dropped connection mid-statement → loud
    failure, then a clean retry commits (no torn row — single-statement
    atomicity is the whole point of this backend);
  - 8-way concurrent commits from SEPARATE pool connections (the fs suite
    races promises; PG must race real transactions);
  - snapshot-size cap enforcement (explicit error, not silent truncation);
  - `get_system_stats` / sweeper deletion hooks once wired.
- **Artifact conformance:** factor the existing filesystem/blob artifact
  assertions (upload/download/list/delete/exists, text vs binary, size
  caps, content-type sniff mismatches) into a shared suite the same way
  snapshot conformance is shared, and register `PgArtifactStore` against
  it. This is the one place new shared-suite work is needed.

### Tier 2 — e2e protocol slice (~12 min, the backend under real fire)

Run these EXISTING suites with the worker's session store switched to PG
(a `PILOTSWARM_SESSION_STORE_BACKEND=pg` test-env knob honored by the
worker-process fork helper, mirroring today's `sessionStoreDir`):

- `fault-injection-live.test.js` — all six literal kill scenarios. This is
  the highest-value e2e for a new backend: real process deaths at every
  commit/hydrate boundary, real duroxide re-dispatch, the exactly-v2
  version-chain oracle, and the persistence-counter assertions — all now
  arbitrated by PG transactions instead of fs renames / blob ETags.
- `lifecycle-stats.test.js` — warm commits, cold takeover, counter
  semantics over PG.
- `artifacts-binary.test.js` — artifact e2e through the worker/tool path.
- The two store-sensitive multi-worker cases (`Session Survives Graceful
  Restart`, `Turn 0 Resets Stale Stored Session`) — migration + reset
  semantics against PG.

### Tier 3 — deliberately NOT run per-backend (the optimization)

Commands, sub-agents, CMS paging, knowledge pipeline, session policy, UI
contracts, chaos, cross-session messaging — these exercise orchestration,
CMS, and LLM behavior; their store interactions pass through the exact
activity code paths tier 2 already runs on PG. Re-running them per backend
triples wall-clock for no new store coverage. The full suite keeps running
on the filesystem default; the blob backend keeps its existing dedicated
conformance file.

CI shape: tier 1 on every PR touching `session-store`/`blob-store`/
`snapshot-protocol`/`session-lifecycle`/`pg-*` files; tiers 1+2 nightly and
before any deploy that flips a stamp to `PILOTSWARM_BLOB_BACKEND=postgres`.

## Open questions

- Real snapshot-size distribution in live envs (instrument
  `getSnapshotSizeBytes` into `get_system_stats` first; validates the cap and
  the churn math).
- Checkpoint cadence and write volume are now defined by the companion
  lifecycle protocol (one CAS write per turn commit); its whale-session and
  hold-window questions live there.
- Whether `pilotswarm_blobs` should default to the CMS database or require an
  explicit URL (leaning: default same DB, allow split).
