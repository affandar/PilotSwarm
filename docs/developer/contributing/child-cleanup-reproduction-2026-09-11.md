# Child-cleanup wakeup: before/after reproduction

The same four assertions were run against three source versions. Both old
versions used isolated detached worktrees with **no SDK source edits**. Only
the regression test file was copied in. All three used identical test bytes
(SHA-256 `eefe6b4c6ebd4c2d3a5374acf7484dd01cfc3717550d9e18e6c81cfd356a02a3`).

| Source | Passed | Failed |
| --- | ---: | ---: |
| Released v0.5.64 (`b0306edf`) | 0 | 4 |
| Pre-fix checkpoint (`4c2ce252`) | 0 | 4 |
| Fix (`29a3cde6`) | 4 | 0 |

The three new round-trip cases execute the real durable `complete_agent`,
`cancel_agent`, and `delete_agent` command producer, pass its command into the
real child shutdown handler, then deliver the emitted messages into the full
parent orchestration generator. In both old versions each case reaches a new
parent `runTurn` despite there being no user prompt or scheduled work. The
fixed version records the cleanup audit and leaves the parent blocked for input.

The fourth case is the previously added explicit-wait polling regression: old
code replaces `AUDIT RESULT` with the terminal marker `done`; fixed code retains
the answer. These are expected assertion failures in the old sources, not
module-loading errors or fixture failures. The entire updated batching test
file also passed, 38/38, against the fix without a name filter.

The focused comparison selected these four cases with:

```sh
node node_modules/vitest/vitest.mjs run packages/sdk/test/local/child-update-batching.test.js \
  -t 'parent cleanup round trip|resolves an explicit barrier by polling after cleanup'
```

The other 34 cases were deliberately filtered out in each comparison. Activity
results, storage and clocks are supplied in memory. This proves the unwanted
model-call scheduling and result overwrite. It does **not** reproduce a live
Copilot model spontaneously returning an empty answer, or exercise Duroxide
database replay. That empty-response symptom was observed in production logs;
its provider/model cause remains unproven. No production operations were used,
and the full provider gate remains stopped.

Local logs, JSON results and source/test identity metadata are in
`/tmp/chk-health-20260910/cleanup-ab-{before,release,after}.*` and
`cleanup-ab-metadata.json`. The temporary worktrees are disposable; the commits
and this test file are sufficient to repeat the comparison.
