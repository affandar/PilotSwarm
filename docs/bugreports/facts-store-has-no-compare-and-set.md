# Gap: the facts store has no compare-and-set, so shared tool state is last-writer-wins

**Status:** Open
**Filed:** 2026-09-02
**Component:** `pilotswarm-sdk` facts store (`storeFact`) and the tool facts accessor (`invocation.facts`, 0.5.57)
**Affected versions:** 0.5.57 and earlier
**Severity:** Medium. Any tool that keeps a shared document under `tools/` can lose a write without noticing.

## Symptom

Two sessions call the same worker tool at the same moment. Each one reads a
shared document with `invocation.facts.read(key, { scope: "shared" })`, adds
its own entry, and writes the whole document back with `store`. Both writes
succeed. One entry is gone.

```
session A: read {}          → write { a: … }
session B: read {}          → write { b: … }
result:                       { b: … }        a is lost, nobody is told
```

Nothing in the API can prevent this today:

- `storeFact` is an unconditional upsert. There is no `ifMatch`, no
  insert-if-absent, and no returned revision.
- `FactRecord` already carries `etag`, and `setFactsCrawled` already does an
  etag compare-and-set for the crawl flag, so the plumbing exists on the read
  side and for one privileged write. It is not exposed for ordinary writes.
- The accessor's `read` returns only the value, so a caller cannot even see
  the revision it read.

The 0.5.57 proposal for the accessor documents the workaround ("re-read after
write and adopt whatever the store holds") and lists conditional writes as out
of scope. That workaround is fine for a binding that is idempotent on its
content. It is not fine for a registry where two different entries must both
survive.

## Workaround in use

Stamp every write with a fresh id, write, read back, and compare:

```
1. doc.writeId = randomUUID()
2. facts.store(key, doc, { scope: "shared" })
3. back = facts.read(key, { scope: "shared" })
4. back.writeId !== doc.writeId  →  report a conflict to the caller and stop
```

This detects a lost update most of the time. It cannot detect the interleaving
where the competing write lands between steps 3 and the caller's next action,
and it costs an extra round trip on every write.

## Proposal

Add conditional writes to the store and surface them through the accessor:

```ts
// facts store
storeFact(input: StoreFactInput & { ifMatch?: number | null }): Promise<StoredFactResult & { rev: number }>
//   ifMatch: null      → insert only; CONFLICT when the key exists
//   ifMatch: <etag>    → replace only when the stored etag matches; CONFLICT otherwise
//   ifMatch: undefined → today's unconditional upsert

// tool facts accessor
read(key, opts):  Promise<{ value: unknown; rev: number } | null>   // or a readWithRev()
store(key, value, opts & { ifMatch?: number | null }): Promise<{ rev: number }>
```

A `CONFLICT` should be a typed error (the canvas KV chokepoint already has a
`CONFLICT` code and an `ifMatch` on its write ops; the same shape would do).

Keeping `read` returning the bare value and adding `readWithRev` would avoid
breaking 0.5.57 callers.

## Acceptance

- `store(key, v, { ifMatch: null })` from two sessions: exactly one succeeds,
  the other gets `CONFLICT`.
- `store(key, v2, { ifMatch: rev })` after another writer bumped the row gets
  `CONFLICT` and leaves the row untouched.
- Unconditional `store` keeps today's behaviour.
- Unit test with two interleaved writers against the same key.
