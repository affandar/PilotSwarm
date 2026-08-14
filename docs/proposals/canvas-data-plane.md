# Canvas data plane — live ticks off the transcript, multi-writer surfaces

Status: phases 1-3 IMPLEMENTED (2026-08-14, adversarially reviewed — 7
findings fixed); share links next; standalone relay + durable-tick flip
deliberately deferred
Companion visual: the "Canvas Data Plane" artifact page (same diagrams, rendered)

## The problem today

Every `update_canvas` tick is a durable event:

```
1. Bridge runs two catalog queries (latestCanvasRev, latestCanvasDataRev)
2. Bridge INSERTs session.canvas_data — payload inline — into the CMS
   events stream. That stream IS the transcript, the replay source,
   the export, the debug bundle.
3. The portal server holds an SDK session handle per subscribed session
   and polls getSessionEvents every 500 ms.
4. Matches fan out over the portal WebSocket to each browser.
```

Costs:
- One 1 Hz dashboard writes ~29,000 durable rows per 8-hour day.
- Median tick latency ~250 ms (the 500 ms poll floor).
- The portal polls the database continuously per viewer-session, even idle.
- Tick events flood the event buffer the sequence/activity views read.
- Writes serialize on a per-execution promise chain (`canvasDrawChain`),
  which is only safe while a canvas has exactly one writer.

## The design principle

`update_canvas` is contractually WHOLE-STATE: the payload replaces the page's
entire data via `applyData`. A missed intermediate tick changes nothing.
So ticks need no history, no replay, no event sourcing. They need a
last-value cache with a wakeup. Postgres has both: an UNLOGGED table and
LISTEN/NOTIFY.

Drawings are different: `draw_canvas` documents are rare, need revisions,
history, promote-to-artifact, and cold load. They stay durable, unchanged.

## The plane

One row per canvas slot:

```
canvas_live (
  session_id, slot,          -- PRIMARY KEY, slots 1-5 as today
  seq,                       -- monotonic; seq = seq + 1 inside the UPSERT
  doc_rev, doc_sha,          -- current document pointer (draws update these
                             -- and RESET payload — the new page starts clean)
  payload,                   -- <= 32 KB JSON, the last MERGED tick
  updated_by,                -- writer session (multi-writer attribution)
  updated_at
) UNLOGGED                   -- kind ('data'|'doc') rides the NOTIFY, not the row
```

The write is one statement plus a ping:

```
UPSERT canvas_live ... seq = canvas_live.seq + 1 RETURNING seq;
pg_notify('canvas_live', '{"s": session, "slot": n, "seq": n}')  -- pointer only
```

- UNLOGGED: no WAL cost, no accretion, survives relay restarts. Lost only on
  a PG failover — and whole-state ticks self-heal on the next tick.
- The atomic `seq + 1` makes concurrent writers safe by construction.
- `draw_canvas` stays durable exactly as today and ADDITIONALLY touches the
  row with `kind: doc, {rev, sha}` so live viewers learn of redraws on the
  plane. Bytes never ride the plane: viewers fetch them over the existing
  artifact HTTP path, cached by sha.
- Rate limit at the bridge: ~10 ticks/s per slot; refuse faster with a hint.
- `read_canvas` gains the current data state in its response:
  `{seq, payload, updated_by}` — one PK row read. (Today "what is the page
  showing" has no first-class read.)

## PUT vs PATCH

The two hops have opposite economics. Agent → row costs OUTPUT TOKENS — a
20 KB dashboard re-emitted to change one gauge is ~5,000 tokens per tick.
Row → browser costs WebSocket bytes — effectively free. So: patch on the
way in, put in the row, whole-state on the way out.

```
update_canvas({ data })   PUT — replace the whole payload (today, unchanged).
                          Use for the first tick and wholesale refreshes.
update_canvas({ patch })  RFC 7386 JSON Merge Patch, applied SERVER-SIDE in
                          the same atomic UPSERT:
                          payload = jsonb_merge_patch(payload, patch)
                          Use for every incremental change.
```

Exactly one of `data`/`patch`. Merge-patch semantics: objects deep-merge,
`null` DELETES a key (the tool description must warn: omit what you are not
touching), arrays and scalars replace wholesale. Rejected: RFC 6902 op
lists — JSON-pointer paths and array indices against state the model
cannot see is the error-prone shape for LLM writers.

The row always holds the MERGED whole state, so every plane property
survives untouched: the LVC burst is one row, failover recovery is
unchanged, resync always has a complete truth to serve.

The patch also rides THE WIRE, end to end. The canvas RUNTIME (the JS the
platform injects into every canvas iframe) keeps a client-side mirror and
merges — page authors change nothing:

```
relay → runtime:
  {kind: "snapshot", slot, seq, payload}   on subscribe, on resync, after a PUT
  {kind: "patch",    slot, seq, patch}     after patch ticks

page registers:  { applyData, applyPatch? }   — applyData is REQUIRED

runtime dispatch (mirror advances only on contiguous seq; else resync):
  snapshot (join, resync, PUT)   → applyData(wholeState)         always
  patch tick, no applyPatch      → applyData(merged, {patch})    fallback
  patch tick, applyPatch present → applyPatch(patch, {state, seq})
  applyPatch THROWS              → applyData(merged)             self-heal
```

- `applyData` stays mandatory because joins and resyncs only speak
  whole-state — the first thing every viewer sees is a snapshot, and the
  recovery from every gap is one. `applyPatch` is the opt-in fast path for
  targeted DOM updates and smooth transitions.
- The two-renderers hazard (incremental vs full drawing drifting apart —
  and these pages are mostly LLM-authored) is contained three ways: the
  runtime never calls applyPatch across a gap, an applyPatch exception
  degrades to correct-but-full applyData, and the equivalence law is
  documented: applyPatch(p) must leave the page as applyData(merge(state, p))
  would.
- Backpressure stays lossless by substitution: the relay may replace any
  run of queued patches with one snapshot.
- Drift protection: same RFC 7386 semantics in SQL and JS; the seq-gap
  resync is the self-healing backstop; optionally the relay attaches a
  short hash of the merged payload per patch and the runtime resyncs on
  mismatch.

Rules: patch is idempotent (retry-safe); patch against an empty row merges
into `{}`; the 32 KB cap applies to the MERGED result and is refused
pre-write with the current size in the error.

## The relay

A small stateless module: ONE `LISTEN` connection to the CMS primary, a
subscription registry keyed (session, slot), WebSockets out.

- On subscribe: authorize (the same session-read predicate as event
  subscriptions; the portal's auth.js / authz.js are importable), then send
  the LVC burst — current doc pointer + last tick per slot. A late joiner or
  reconnect is whole in one round trip. No replay.
- On NOTIFY: hash-lookup the registry; if nobody here watches that canvas,
  drop the ping. Else read the one row and push to local subscribers.
- Slow client: coalesce by SUBSTITUTION — replace any run of queued patches
  for a slot with one snapshot of the latest row. Lossless by construction.

Hosting is a deployment choice, same code:
- Phase: IN-PROCESS — mounted on the portal server at `/api/v1/canvas/ws`.
  Kills the poll and the durable ticks with zero new deployments.
- Phase: STANDALONE — its own environment-scoped deployment (like mcp sits
  beside the portal), N Kubernetes replicas behind one Service. Each replica
  holds its own LISTEN connection; NOTIFY broadcasts to all; no coordination,
  no sticky sessions (any replica serves any viewer — the burst makes every
  connection whole). Canvas liveness then survives portal deploys.
- LISTEN/NOTIFY fires only on a PG PRIMARY. No read replicas today; if the
  CMS ever grows one, the relay stays pointed at the primary.

Workers never talk to the relay; the relay never talks to workers. The
database is the only rendezvous — sessions stay nomadic across workers.

## Multi-writer canvases (sub-agents writing the parent's surface)

The scenario: a parent session owns a dashboard; its sub-agents (and
sub-sub-agents) each keep part of it live.

### Targeting
All four canvas tools gain one optional argument, `session_id`. Omitted =
your own canvas, byte-identical to today. Set = that session's canvas,
allowed only when the target is an ANCESTOR of the caller:

```
sub-sub-agent may target: its parent, the root
sub-agent may target:     the root
never: siblings, children, strangers
```

The check lives in the bridge (worker-trusted, same stance as
`fromArtifact`): walk the caller's parentSessionId chain in the catalog.

### Concurrency
Ticks: already solved by the plane — the atomic `seq + 1` UPSERT admits any
number of writers with no locks and no lost updates.
Draws: rev minting today races across executions. Fix in the durable store:
unique `(session_id, slot, rev)` plus retry-on-conflict. Works on PG and
HorizonDB.

### The clobber problem — solved by patch composition
Whole-state PUTs mean two children writing the SAME slot overwrite each
other. Merge patches dissolve most of it: server-side deep merge means
concurrent patches to DISJOINT paths compose automatically — two children
updating different subtrees of one page cannot clobber each other, no
convention needed. Same-path collisions are last-writer-wins, attributed.
The sanctioned patterns, in order of preference:

1. **Merge patches on one page.** Parent draws the shell once; each child
   patches its own subtree (`patch: {tiles: {a1: {...}}}`). N writers, one
   page, composition by construction. (This subsumes the earlier
   `merge_key` idea — no bespoke argument needed.)
2. **Tile per slot.** Each child owns one slot wholesale. Simple, bounded
   by the 5-slot cap; right when tiles are separate PAGES, not regions.
3. **Parent composes.** Children tick their OWN canvases or write facts;
   the parent aggregates and draws. Today's workaround; still valid for
   heavy aggregation logic.

### Attribution and guards
- `updated_by` rides every row write and every durable draw event; the
  portal shows who drew rev N and who last ticked the state.
- A child's write does NOT auto-flip the parent's canvas into view; the
  existing flip/freshness/opt-out guards keep applying. Unseen-changes
  badging works unchanged (it keys off the target session's events).
- Interactions still route to the SURFACE OWNER (the parent). Children
  contribute pixels, not input handlers.

## Failure modes

| failure | behavior | why it's fine |
|---|---|---|
| relay pod dies | viewers reconnect via LB, get the burst | row lives in PG, relay holds no state |
| PG failover | unlogged rows truncated; shell renders, data blank | next tick repopulates (whole-state) |
| worker killed mid-write | nothing partial | single-statement UPSERT |
| portal deploys | standalone relay keeps ticking | portal left the data path |
| session completes | worker checkpoints the final tick durably | finished sessions replay their last state |
| LISTEN connection dies | keepalive + reconnect + re-read subscribed rows | the dispatcher-freeze lesson, applied |

## Migration (mixed-version safe)

1. Ship readers that PREFER `canvas_live` and fall back to `canvas_data`
   events. Old sessions and old workers keep working.
2. After portals roll, flip workers (env flag) to stop writing durable
   ticks. Two steps, digest-pinned, same discipline as the worker-registry
   rollout. Where the plane is absent (capability probe), the bridge keeps
   today's path.

## Interactions and share links (decided 2026-08-14)

The POSTBACK stays exactly as it is today: the iframe posts to the portal
page, the page validates against the armed contract, and the action rides
`sendMessage` as a `[canvas-action] {...}` user message. The proposed
"canvasAction over the canvas WebSocket" chokepoint is REJECTED: as long
as an action is representable as user text, sendMessage is an equivalent
forgery path — the enqueued bytes are identical and the gates guard only
one of two doors. A chokepoint that closes nothing is complexity.

The design of record for WHEN owner-only postback is needed: a TYPED
durable input kind (`canvas_action` with its own `session.canvas_action`
event type, never a user.message), single gated writer, and the
`[canvas-action]` text prefix reserved (refused by sendMessage). An
addition to the orchestration's input vocabulary, not a semantics change.
Not built now.

Share links ship WITHOUT waiting for that, because view-only already
holds structurally for link bearers:
- "Anyone with session access can view": a deep link
  (?session=<id>&view=canvas&slot=N + full screen). Portal sign-in and
  the existing visibility check do the authz.
- "Anyone with link can view": a canvas-scoped view token in the URL,
  accepted ONLY by the canvas WS subscribe and the canvas-document fetch.
  Token bearers have no authenticated write path AT ALL — no sendMessage,
  no session events, no artifacts — so they can watch and never steer.
  ONE live token per canvas at a time: a random lookup token stored
  HASHED in one CMS row per (session, slot) — none by default, minted on
  demand from the share dialog, RESET rotates the row (the old link dies
  the moment the new one exists), and remove returns the canvas to
  unlinked. Owner-gated mint/reset/remove; validation is a hash lookup.
  The share dialog shows both link types, the copy button, and the Reset
  control with its consequence stated plainly ("the previous link stops
  working").
The residual (an AUTHENTICATED non-owner session-writer forging the text
format) is today's status quo, unchanged by links, and is what the typed
input closes when it lands.

## Phases

1. SDK plane: table migration, bridge UPSERT+NOTIFY, rate limit,
   read_canvas current-data, compat flag. Tests incl. two-writer seq race.
   The COMPLETION CHECKPOINT ships with the durable-tick flag flip (it only
   matters once durable ticks stop), and that flip is blocked on it. (~1.5 d)
2. Relay module in-process + the runtime patch mirror (client-side
   jsonb_merge_patch twin, seq chain, resync) + portal read path with
   fallback + e2e. (~2 d)
3. Multi-writer: ancestor targeting on the four tools, draw-rev uniqueness,
   merge-patch application (jsonb_merge_patch), attribution in the portal. (~1.5 d)
4. Standalone relay deployment + ingress + rollout runbook. (~1 d)
5. Optional: standalone live canvas page `/canvas/:session/:slot` served by
   the relay — a shareable dashboard with no portal UI around it. (~1 d)

Order matters: the plane first, so multi-writer lands on the atomic seq
instead of inheriting the single-writer chain.

## Explicitly rejected

- Direct browser↔worker channels (WebRTC / worker ingress): sessions are
  nomadic and workers get rolled; every migration would re-handshake every
  viewer. The PG-mediated plane keeps workers invisible to browsers.
- Redis / Azure Web PubSub: real pub/sub, but the substrate is deliberately
  PG-only and NOTIFY covers this fleet's scale with headroom. The relay's
  transport interface stays narrow so a broker can slot in later.
- Any per-tick read-back verification: the DB's ack is trusted, same stance
  as bulk_store_facts.
