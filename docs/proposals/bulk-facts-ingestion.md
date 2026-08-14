# Bulk Fact Ingestion — `bulk_store_facts`

> **Status:** Proposal
> **Date:** 2026-08-13
> **Scope:** one new tool that writes facts from an artifact instead of from tool-call arguments, records per-record failures to a second artifact, and accepts that failure artifact back as input.
> **Origin:** running-issues `TOOLS-20260813-001`, reported by the Argus IcM Incident Harvester.

## Summary

Today a model must retype every fact value as a tool-call argument. There is no path
where fact bytes reach the database without passing through the model. That makes large
applies slow, expensive, and unsafe.

`bulk_store_facts` reads records from an artifact. It writes them one at a time. It
returns the ones that failed as a new artifact, in the same format it accepts. The
caller feeds that artifact back to retry.

## The problem, concretely

A nine-day IcM backfill produced 10,907 validated facts (about 14 MB) for 839 incidents.
Materialization stopped after 215 writes. Two of four writer agents caught real
transcription defects before submitting: one truncated `summary` value, one wrong `tags`
array. All writers stopped rather than risk corrupting canonical facts.

Nothing was wrong with the data. The data was correct in the artifact. It was damaged in
transit, by the model retyping it.

## What we add

One tool, `bulk_store_facts`. The name follows the existing `store_fact`.

```
bulk_store_facts(
  facts:          [{key, value, tags?, shared?}]              # inline, or
  from:           {filename, session_id?, expected_sha256?}   # an artifact
  to_file:        "failed-01.json"                            # where failures go
  key_prefix:     "icm/corpus/v1/"                            # optional guard
  expected_count: 10907                                       # optional guard
)
```

Give it `facts` or `from`, not both. `to_file` names an artifact in the calling session.
`expected_sha256` is checked when supplied. Supply it for canonical applies.
`expected_count` is checked before any write. A mismatch refuses the whole call.

## The contract

`bulk_store_facts` is not atomic. It does not promise the batch lands whole.

It promises accounting: **every input record ends in exactly one place — committed to the
database, or written to the failure artifact with a reason.** No record is left unexplained.

This is a deliberate trade. `store_fact` keeps the all-or-nothing behavior for one fact or
a handful. Bulk work wants 10,906 good records written and 1 bad record handed back, not
10,907 records refused.

## The loop

```
1. write_artifact("apply-01.json", records)          -> returns sha256
2. bulk_store_facts(from=apply-01.json,  to_file=failed-01.json)
     -> committed 10905, failed 2
3. bulk_store_facts(from=failed-01.json, to_file=failed-02.json)
     -> committed 1, failed 1
4. failed_count stopped dropping. Stop. That record has a real defect.
```

The model moves filenames. It never handles a value.

Two things make the loop safe. Re-writing a record that already committed is a harmless
overwrite, because `facts_store_fact` uses `INSERT ... ON CONFLICT (scope_key) DO UPDATE`.
And an empty input file is a success with zero records, not an error, so the last pass
ends cleanly.

Re-writing is cheap as well as safe. The `facts_touch` trigger only bumps `etag` and
re-queues a fact for crawling when `key`, `value`, or `deleted_at` actually change, so
feeding back a record that is already stored costs one row touch and no downstream work.

One behavior to know about: the upsert sets `deleted_at = NULL`. Re-writing a fact that
was soft-deleted between the first call and a retry brings it back.

## The failure artifact is a valid input artifact

This is the point of the design. A failed record is written back unchanged, with one field
added:

```json
[
  {
    "key": "icm/corpus/v1/inc-8842/summary",
    "value": { "...": "the original value, untouched" },
    "tags": ["icm", "summary"],
    "_error": {
      "reason": "db_error",
      "message": "value too long for type character varying"
    }
  }
]
```

`_error` is written, never read. `bulk_store_facts` ignores it on input and regenerates it
on output. So the failure artifact needs no editing before it is fed back. Nothing unpacks
it. Nothing re-serializes it.

The tool keeps no state about a record across calls, and there is no attempt counter. The
caller does not need one. `failed_count` in the receipt is the signal: retry the failure
artifact a few times, and when `failed_count` stops dropping, the records still failing
have real defects. Look at them instead of retrying them.

Record order from the input is preserved in the failure artifact.

## Failure reasons

Checked before the database sees the record:

| reason | meaning |
|---|---|
| `invalid_shape` | not an object, or `key` missing or not a string, or `value` missing |
| `namespace_denied` | key starts with `skills/`, `asks/`, or `config/facts-manager/` |
| `intake_requires_single_write` | key starts with `intake/` — see below |
| `prefix_violation` | `key_prefix` was given and this key does not start with it |
| `duplicate_key` | this scope key already appeared earlier in the same input |
| `missing_session` | a session-scoped fact with no session id |

From the database: `db_error`, carrying the PostgreSQL message.

On `duplicate_key` the first record wins and later ones fail. Order never silently picks
a winner.

### `bulk_store_facts` does not accept intake

An `intake/` key fails as a record. The rest of the call still commits. The message says
what to do instead: write it with `store_fact`, one at a time.

The rule covers every `intake/` key, shared or not. "Banned in bulk, unless it is not
shared" is a rule with an edge case, and an edge case is a thing to get wrong.

Two reasons this is a rule and not an oversight.

A shared `intake/` write wakes the Facts Manager. `store_fact` sends one wake-up per
record, and the Facts Manager handles each wake-up as an LLM turn. Two thousand intake
records in one call would queue two thousand curator turns on a single system agent. The
restriction removes that by construction, so no aggregation or batching of the wake-up is
needed anywhere.

Intake keys are `intake/<topic>/<session-id>`. The session id is the last segment, so one
session writing many observations under one topic overwrites itself. Bulk intake was never
expressible. This writes the existing shape down as a rule.

`bulk_store_facts` is for corpus data. `store_fact` is for observations.

One check is not per record. An `agent-tuner` session is refused at the call level,
because it may not write facts at all. Returning 10,907 identical failures for that would
be noise.

## Receipt

```
{
  accepted_count:   10907,
  committed_count:  10905,
  failed_count:     2,
  failed_artifact:  "failed-01.json",     // null when to_file was not given
  failed_sample:    [{key, reason, message}],   // at most 5, keys only, no values
  source:           "apply-01.json",      // or "inline"
  sha256:           "..."                 // of the bytes actually read
}
```

`accepted_count = committed_count + failed_count`, always.

`committed_count` is the number PostgreSQL returned. `facts_store_fact` already ends in
`SELECT count(*)::int FROM upserted`; the JavaScript currently throws that number away and
substitutes the input length. This proposal uses the real one.

When `to_file` is given the tool always overwrites it, writing `[]` when nothing failed.
That stops a stale file from an earlier run being read as a new failure.

## How it runs

Per record, as far as the caller can tell. Chunked underneath, because 10,907 round trips
to PostgreSQL is minutes of waiting for nothing.

```
split records into chunks of 500
for each chunk:
    try the chunk in one facts_store_fact call
    if it throws:
        rerun that chunk one record at a time, to find which record is bad
```

The result is the same as writing one at a time. The only case where combining records
changes the outcome is a duplicate scope key, and that is caught before the database.
A clean 10,907-record artifact costs 22 round trips. Only a chunk holding a bad record
pays the per-record cost.

We do not loop inside PostgreSQL with `BEGIN ... EXCEPTION` per row. Each of those blocks
is a subtransaction. Ten thousand of them in one statement puts pressure on `pg_subtrans`
and can slow down every other connection to the database, not just this call.

## What does not change

- **`store_fact` is untouched.** Same parameters, same all-or-nothing batch, same
  per-record Facts Manager wake-up. Only its description changes, to point at
  `bulk_store_facts` for large sets.
- No migration. `facts_store_fact` already does the upsert and already returns the count.
- `checkNamespaceWrite` still runs on every key. A file-based path must not become a way
  around the reserved namespaces.
- Session id and agent id still come from the tool context, never from the record.

## One existing defect this fixes

`FactStore.storeFact` discards the row count PostgreSQL returns and reports the length of
the input array instead. Today the two always agree, so nothing is visibly wrong. But it
makes `committed_count` an assertion about the input rather than a result, and
`bulk_store_facts` promises `accepted_count = committed_count + failed_count`. A count
derived from the input compares the input to itself and proves nothing.

`store_fact` sees no change from this. The numbers are equal today by construction, so
its return value is byte-for-byte the same.

## Known, out of scope

The Facts Manager wake-up in `store_fact` fires once per record, and each one calls
`listSessions()` — an uncached read of every session row — before enqueuing the prompt.
At one observation per call, which is what the key schema allows, this is one extra read.
It only became interesting at bulk volume, and barring `intake/` from `bulk_store_facts`
closes that path. Caching the Facts Manager session id would remove the read, whenever
someone wants it.

## Limits

32 MB and 50,000 records per call. Above either, the tool refuses the call rather than
ingest part of a file it cannot parse safely. The producer writes more than one artifact.

## Work

New: the tool, the artifact read and write path, the failure-artifact writer, the chunk
and fallback loop, and passing `artifactStore` into `createFactTools` (SessionManager
already holds it).

Changed: two lines in `FactStore.storeFact` to report the real count, and one line in the
`store_fact` description pointing at this tool for large sets. Nothing else in `store_fact`
moves.

About half a day, including tests for the retry loop running to empty.
