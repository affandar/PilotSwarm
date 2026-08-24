# Interactive Canvas Apps

Status: PROPOSED (2026-08-18). The umbrella spec. Absorbs the canvas KV data
plane, which was drafted separately and is now Part C here.

Builds on shipped work: [architecture/canvas.md](../architecture/canvas.md),
[proposals/canvas-data-plane.md](canvas-data-plane.md) (phases 1–3 shipped),
[proposals/canvas-apps.md](canvas-apps.md) (manifest shipped; packages phase 3
designed, unshipped).
Companion visual: https://claude.ai/code/artifact/60022d4a-349d-4fd8-a77d-5aa33fcdea1c
Worked example with concrete keys and protocol:
[canvas-app-pr-workbench.md](canvas-app-pr-workbench.md) — the PR review
board, modelled end to end against the hand-rolled one already on chk.
Backend options: [canvas-app-backend.md](canvas-app-backend.md) — what it
takes to let a page invoke work without waking the model.

## 1. What this is

A user asks the agent for an app. The agent builds it, live, on the canvas.

```
"give the approvers a board to sign off this release train"
"show me this PR as a review board we can both mark up"
"put the runbook's live state on screen so I can see what is stuck"
"stream the perf sweep results as they land"
```

The result is a real application: it holds state, several people can use it at
once, it can be shared by link, and it can be published so other people's
sessions can find and reuse it.

Four capabilities make that true. Three are new.

| | Today | This spec |
|---|---|---|
| Draw a page on the canvas | shipped | unchanged |
| Page holds shared, durable state | — | **Part C: the KV store** |
| Share it by link, read or read/write | view-only links shipped | **Part D: one access policy** |
| Page and session talk back and forth | one-way actions | **Part E: request/reply** |
| Publish it so others can find it | — | **Part F: the app catalog** |

## 1a. The case this is built from: M66 release sign-off

This is not hypothetical. Session `3e2c1d1f` on the chk cluster — Mad-Eye
Moody, the R2D train watcher, 800 iterations — ran a real M66 release sign-off
on a canvas, and **already built an interactive canvas app to do it**:
`m66-approver-walk` v1.1.1, a 41-item approver walkthrough with a real
`responseContract`. It worked. It also shows exactly what is missing.

Measured from that session's event stream:

| | Measured |
|---|---|
| Redraws of the approver sheet | **62** redraws of one 205 KB document |
| Total canvas versions rendered | 76 draws, **~10 MB** of document versions |
| Incremental updates (`update_canvas` ticks) | **0** |
| How state persisted | the **whole form** — every item's decision and note — round-tripped inside each `submit_batch` action payload |
| Human cadence | median **13 minutes** between redraws, over **5 days** |
| Approvers who could submit | **1** — the session has zero shares, and canvas actions are creator-only |

Read the middle two rows together and the gap is exact. There was no per-key
durable state, so the only way to persist *"item 5502432 = approved"* was to
regenerate the entire sheet and re-ship the entire draft blob. That is the
"never keep a list in one key" anti-pattern from C.6, executed 62 times at
205 KB — not because the agent chose badly, but because the platform offered
nothing else. (`fromArtifact` kept those bytes out of model **context**; the
agent still had to author every version.)

And the last row is the sharper problem: a release sign-off is inherently
**multi-approver**, and exactly one person could submit.

With this spec:

```
BEFORE   draw 205 KB sheet → approver decides → agent rewrites 205 KB sheet
         → redraw → repeat 62×, one approver, whole form in every payload

AFTER    draw the shell once
         each verdict          → kv.put("app/item/5502432", {decision, note})
         every approver sees it live, attributed, ~50 ms
         Moody drains req/* on its next scheduled wake
         the state IS the fact rows read_facts already returns
```

The 10 MB of regenerated documents collapses to a handful of draws plus ~41
small writes, and the single-approver ceiling disappears with policy
`readers` (D.1).

## 2. What exists today

| Piece | State |
|---|---|
| Sandboxed canvas iframe; `parent.postMessage` the only way out | shipped |
| `draw_canvas` / `update_canvas` / `show_canvas` / `read_canvas`, 5 slots | shipped |
| `CANVAS-APP-MANIFEST` self-description + `fromArtifact` server-side draw | shipped |
| Live push to every viewer (`canvas-data`, seq, RFC 7386 patch) | shipped |
| Postgres LISTEN/NOTIFY relay (`canvas-plane.js`) | shipped |
| Public share links, one hashed token per (session, slot) | shipped, **view-only** |
| Canvas-only viewer page (`CanvasShareView`) | shipped |
| Facts table with per-row `etag` and soft delete | shipped |
| Package-shipped apps (`fromPackage`) | designed, unshipped |
| A page reading or writing state | **missing** |
| A link bearer writing anything | **missing, refused by design today** |
| A second person writing the canvas at all | **missing** — actions are creator-only |
| An app catalog anyone can search | **missing** |
| Any canvas signal in the TUI | **missing — and silently so** |

## 3. The life of an app

```
BUILD     user asks → agent draws → iterate on the canvas
   ↓
USE       state lives in the KV; every viewer sees every change live
   ↓
SHARE     owner sets the canvas policy: owner | readers | link
   ↓            readers = named colleagues, no public URL
PUBLISH   owner says "share this with the team"
   ↓            bytes → artifact, card → shared fact
FIND      another session searches the catalog and draws it
```

Parts A–F below take these in order.

---

# Part A — The app itself

## A.1 Self-description

Unchanged from `canvas-apps.md`, plus one key. One comment right after
`<!doctype html>`:

```jsonc
<!-- CANVAS-APP-MANIFEST
{ "manifestVersion": 1, "name": "meeting-notes", "version": "1.0.0",
  "description": "Shared meeting notes. Use when several people take notes in a live meeting.",
  "kv": { "write": "viewers" },
  "responseContract": { "actions": { "request": { "id": "string" } } },
  "notes": "Keys: app/note/<id>, req/<id>, ui/<writerId>." }
-->
```

`description` earns its own rule in Part F: it is the text the catalog ranks
on, so it must name the *situation*, not the mechanics.

## A.2 Fitting the screen

An app is used, not read. The canvas pane is often half a laptop screen or a
whole phone. **Aim for no scrolling; when content genuinely does not fit,
scroll one region, not the page.**

Rules, in order of how often they are got wrong:

1. **Design the shell to the viewport, not to the content.**

   ```css
   html, body { height: 100%; margin: 0; }
   body { display: grid; grid-template-rows: auto 1fr auto; }  /* header, work, footer */
   ```

   The middle row is the only thing that scrolls: `overflow-y: auto;
   min-height: 0`. Without `min-height: 0` a grid or flex child refuses to
   shrink and the whole page scrolls instead — this is the single most common
   cause of a canvas app that scrolls when it should not.

2. **Never `overflow: hidden` on `body` to "stop scrolling".** It kills
   scrolling on mobile entirely, including inside your scroll region.

3. **Let the browser's own scroller do the work.** No custom wheel handlers,
   no scroll hijacking, no `touch-action: none` except on a game surface that
   truly owns the gesture — and then only on that element, never on `body`.

4. **Mobile keyboard.** A focused input on iOS shrinks the visual viewport,
   not the layout viewport, so a bottom-docked composer disappears under the
   keyboard. Size the shell with `100dvh` (dynamic viewport height), not
   `100vh`, and keep the input inside the scrolling region.

5. **Text inputs at `font-size: 16px` minimum.** Anything smaller makes iOS
   Safari zoom the viewport on focus and never zoom back. The page comes out
   cropped and panned for the rest of the session.

6. **Momentum and overscroll.** Put `overscroll-behavior: contain` on the
   scroll region so a flick at the end does not bounce the whole canvas.
   Set the background on `html, body` both — iOS extends the `html` background
   into the rubber-band area.

7. **Test at three sizes before showing it**: a narrow pane (~380 px), a half
   screen (~700 px), and full width. A canvas resize **reflows and never
   reloads**, so a layout computed once at load stays wrong until a redraw.

8. **Long lists get a scrolling region with a sticky header**, not a page that
   grows without bound. A 200-row meeting-notes list should still show the
   composer without scrolling.

---

# Part B — What the platform gives the page

Three lanes, and choosing wrong is the main way these apps go wrong.

| Lane | Who writes | Reaches | Wakes the session | Durable | Costs the agent |
|---|---|---|---|---|---|
| **KV store** (Part C) | any permitted viewer, and the agent | every viewer, ~50 ms | no | yes | tens of tokens per key |
| **Action** | only a viewer with session write | the agent | yes, one turn | as a message | a whole turn |
| **Tick** (`update_canvas`) | the agent only | every viewer, ~50 ms | no | no | patch: tens · data: thousands |

The rule behind it: **the KV is for state, the action is for attention.**
Never put a payload in an action when you can put an id there and the payload
in the KV.

## B.1 Channel economics

Two things are expensive; everything else is free. **Outbound costs output
tokens, inbound costs a turn.** The NOTIFY, the WebSocket fan-out and the
postMessage cost nothing measurable, so the protocol is entirely about what the
model emits and how often it wakes.

Outbound, cheapest first:

| Channel | What the model emits | Cost |
|---|---|---|
| `canvas_kv(op="put")` | one key + value | tens of tokens |
| `update_canvas(patch)` | the changed subtree only | tens of tokens |
| `draw_canvas(fromArtifact)` | a filename | ~10 tokens |
| `update_canvas(data)` | whole state, ≤32 KB | up to ~8K tokens |
| `draw_canvas(html)` | the whole document | up to ~240K tokens |

Inbound, the byte size barely matters — a wake resends the whole context, so
**the turn is the unit**. An 8 KB action and a 20-token action cost nearly the
same. Hence two rules that look like style and are actually economics: the
request contract is a single `{id: "string"}` field (payload lives in the KV),
and one doorbell stands for every queued row.

The third inbound channel has no turn cost at all: `canvas_kv(op="list")` on a
wake the agent was already going to run. That is why the poll/promote split in
Part E is cheap to leave running.

**Where this is taught.** The cost model has to reach the agent at the moment
it is choosing, not only in this document:

| Surface | Carries |
|---|---|
| `update_canvas` tool description | patch-vs-data economics, verbatim |
| `draw_canvas` tool description | `fromArtifact`, and the pointer to tick instead of redraw |
| `default.agent.md` | the tick ladder and the cost table |
| `html-visuals` skill | the patch pattern and the token-courier anti-pattern |
| `canvas-apps` skill | the full five-channel ladder and the decision block |

A cost rule that lives only in a proposal is a cost rule nobody applies.

---

# Part C — Shared state: the KV store

## C.1 Where the bytes live

One fact row per key. Session-scoped, never shared.

```
scope_key = session:<sessionId>:canvas/<slot>/kv/<pageKey>
```

The prefix is stamped by the server; the page supplies only `<pageKey>`. A
page cannot write another slot, another session, or a shared fact. One rule,
enforced in one place.

**One row per key is the load-bearing choice.** Two people editing different
notes never collide. Only two people editing the *same* key collide, and that
is last-writer-wins unless the page passes `ifMatch`.

Reserved prefixes:

```
app/…            the app's shared state — notes, votes, the board
req/<reqId>      a request from the page to the session; a collaborator's
                 lands `suggested` and only the owner promotes it   (Part E)
evt/<n>          a note from the session to the page             (Part E)
ui/<writerId>    one viewer's ephemeral state (presence, drafts)
cfg/…            owner-and-agent writable, everyone readable
```

`cfg/*` must be locked in the chokepoint, by prefix, **in the same phase the
prefix ships**. It sits inside the browser-writable namespace, so without the
lock any writer can set `cfg/role/<themselves>` and any config or role scheme
built on it becomes self-serve.

## C.2 What a row holds

```json
{ "v":  { "text": "Ship the migration Friday", "done": false },
  "by": { "kind": "link", "id": "w_8f3a", "label": "Sam" },
  "at": "2026-08-18T14:02:11.443Z" }
```

- `v` is exactly what the page wrote; the page only ever sees `v`.
- `by.kind` — `user` (signed in, real principal), `link` (bearer, opaque
  per-browser id, **`label` is self-declared and unverified**), or `agent`.
- `at` is server time. Client clocks are not trusted.
- Every row carries `rev`, which is the facts table's existing `etag` — bumped
  by the `facts_touch` trigger from migration 0010. Nothing new is stored.

## C.3 The write path: one chokepoint, three doors

```
packages/sdk/src/canvas-kv.ts
  validateKey / validateValue / checkQuota / resolveWriteRule
  read(sessionId, slot, prefix, limit, cursor)
  write(sessionId, slot, key, value|delete, by, ifMatch?)
     → fact store upsert (or soft delete)
     → cms.notifyCanvasKv({sessionId, slot, key, rev, op, value?})
```

It lives in the SDK, not the portal, because two processes need it: the portal
serves browsers, the worker serves the agent. Same shape
`canvas-app-manifest.ts` already uses — one normalizer, every caller.

```
Door 1 — signed-in browser
  readCanvasKv   GET  /management/sessions/:id/canvas-kv   access canvas:read
  writeCanvasKv  POST /management/sessions/:id/canvas-kv   access canvas:write

  Their OWN access classes, not session:read / session:write. A canvas
  reader may hold neither session class (Part D), so classing these as
  session ops would either break the feature or hand over the session.

Door 2 — link bearer
  beside the existing /doc and /live token doors, outside requireAuth:
    GET  /api/canvas-share/kv?t=<token>
    POST /api/canvas-share/kv?t=<token>    403 unless the link is read/write

Door 3 — the agent
  canvas_kv { op: get|put|list|delete, slot, key, value, sessionId? }
  sessionId targets an ANCESTOR only, matching the other canvas tools.
```

The generic `storeFact` web op is **not** a door: it is not session-scoped, so
any signed-in user with `facts:write` could write any fact through it.

## C.4 The live path

```
writer → chokepoint → facts row (durable)
                    → pg_notify('pilotswarm_canvas_live', {kind:"kv", …})
                            ↓
                    canvas-plane.js LISTEN        (connection reused, NEW branch)
                            ↓
                    WebSocket fan-out by session  (reused unchanged)
                            ↓
                    portal / link view, filtered by slot
                            ↓
                    postMessage {type:"canvas-kv-change"} into the iframe
```

**What is actually reused, and what is new.** The LISTEN connection, its
keepalive and reconnect discipline, the per-session subscriber registry, and
the WebSocket fan-out are all reused as-is. But `canvas-plane.js` today
*projects* every notification into a fixed shape — `{slot, seq, kind}` where
`kind` is coerced to `doc` or `data`, plus an optional `patch`. A KV ping
carries `key`, `rev` and `op`, and every one of those fields would be dropped
on the floor by the current projection.

So the plane grows a third branch, and the client grows a matching one:

| | `data` / `doc` (today) | `kv` (new) |
|---|---|---|
| Ordering | one `seq` per slot, contiguous-or-resync | one `rev` per **key**, max-wins |
| Merge | RFC 7386 over the slot payload | per-key replace; `op: "delete"` drops it |
| Recovery | resync the slot | snapshot the prefix |

They must stay separate dispatch paths. Feeding per-key `rev` values into the
slot-level `seq` chain would make every KV write look like a gap and trigger a
resync storm.

The payload carries `{schema, sessionId, slot, kind:"kv", key, rev, op}` plus
`value` when the envelope is under 2 KB. Larger values are pointer-only and
the browser fetches that one key — Postgres caps a notify payload at 8 KB.

**The writer publishes.** The notify is issued by whoever wrote, on the CMS
connection — not by a facts-table trigger. Facts can live in a different
database from the CMS (the enhanced store runs on HorizonDB), so a facts-side
trigger would need a second LISTEN connection whose target depends on the
deployment.

**Missed pushes self-heal.** No cross-key sequence and none needed: every
connect and reconnect pulls a full snapshot, and a push applies only when its
`rev` beats the client's current `rev` for that key.

Deletes are soft deletes. The row stays as a tombstone, `rev` advances, live
viewers drop the key, and a later joiner simply never sees it.

## C.5 The page API

Nothing is injected into the document — pages stay self-contained bytes the
agent authored and the link door serves verbatim. The skill ships a ~35-line
`CanvasKV()` helper the agent pastes.

```js
const kv = CanvasKV();
const { entries, canWrite, me } = await kv.ready;
renderAll(entries);
kv.onChange(c => applyOne(c));
if (!canWrite) lockTheUI("You can view this board but not edit it.");
```

```
page → host   { type:"canvas-kv",        id, op, key?, value?, prefix?, ifMatch? }
host → page   { type:"canvas-kv-result", id, ok, … }
host → page   { type:"canvas-kv-change", key, value, by, at, rev }
host → page   { type:"canvas-kv-ready",  entries, canWrite, me }
```

`me` describes the viewer:

```js
me: { id,          // stable per person; per browser for a link bearer
      kind,        // "user" | "link"
      label,       // display name — UNVERIFIED for a link bearer
      relation,    // "owner" | "admin" | "collaborator" | "viewer" | "link"
      canWrite }
```

`relation` is a pass-through **for signed-in viewers only** — the portal
already computes it in `getSessionAccess`. A link bearer has no session to
resolve against, so door 2 stamps the constant `"link"` from the token rather
than calling the session-access path at all. Without `relation` a page cannot
tell an owner from a bearer.

Provenance is checked exactly as it is for actions: a message is accepted only
when `event.source` is that slot's live iframe `contentWindow`.

## C.6 Sharing patterns

The craft is choosing keys so simultaneous writers cannot destroy each other's
work.

| Pattern | Key shape | Use for |
|---|---|---|
| One key per item | `app/note/<uuid>` | notes, cards, todos — **the default** |
| One key per person | `app/vote/<me.id>` | votes, RSVPs, availability |
| Claim | `app/claim/<taskId>` + `ifMatch: 0` | assignment, first-writer-wins |
| Presence | `ui/<me.id>` heartbeat, expire on `at` | who is here, who is typing |
| Ordering | `order` string inside the item | agendas, backlogs, drag-to-reorder |

Two things the KV is bad at, and the answers:

- **Counters.** Do not `get, add, put`. Use per-person keys and count them.
- **Free text several people edit.** A key is not a CRDT. Split into
  per-section keys and show `by`/`at`, or say plainly that one person edits at
  a time.

**Never keep a list in one key.** It is the clobbering bug, and it looks fine
until the second person joins.

## C.7 What does not belong here

Every KV write pays a write-ahead-log entry, a revision bump, a notify, and a
fan-out. That is right for state people care about and wrong for state that
changes at frame rate. **Share the outcome and the rules; never share the
frames.**

Working through a shared Tetris:

| Shape | Writes | Verdict |
|---|---|---|
| Leaderboard — everyone plays locally, posts a score | 1 per game | fine |
| Shared seed — one PRNG seed, identical piece order | 1 per round | fine |
| Attacks — garbage lines between players | ~6/min | fine |
| Live spectating — stream the board to watchers | 4/s per player | wrong lane |
| Co-op — two people driving one falling piece | frame-locked | out of scope |

Spectating ten players for ten minutes is ~24,000 writes. They land on ten
rows, so storage is fine; the write volume on a durable table is not. That is
the exact cost the data plane moved ticks to an UNLOGGED table to avoid.

The right home exists and is one method away — `canvas_live` is UNLOGGED,
~50 ms, self-healing, already on the same relay, and agent-write-only today:

```
kv.put(key, value)        → facts row, durable, survives everything
kv.live.put(key, value)   → canvas_live subtree, ephemeral, no WAL
```

Deferred, not rejected: the durable half must land before it can be optimised.

---

# Part D — Access: who may write the canvas

## D.1 The model

The owner sets **one access policy per canvas**. It has three values, and it is
a property of the canvas — not of a share link.

```
"kv-access" on the canvas:

  owner     only the creator writes.                          DEFAULT
  readers   anyone the SESSION is read-shared with may write.  No public URL.
  link      a public read/write link exists; its bearers write too.
```

Resolving a viewer:

```
canvas access for a viewer =
    owner or admin                → write
    has session WRITE access      → write        (forced; see the law below)
    has session READ access       → write if policy is "readers" or "link"
                                    else read
    link bearer                   → write if policy is "link" AND the link
                                    was minted read/write, else read
```

Session writers always get canvas write, and that is not a choice. One law
forces it:

> **Anyone who can talk to the agent transitively holds every capability the
> agent holds.**

The agent can write the KV, so a session writer can always launder a write
through it. "Session write but not canvas write" is a permission that cannot
be enforced, so it must not be offered.

### Why `readers` exists — the mistake it fixes

An earlier draft made the policy a property of the **share link**, so session
readers "inherited the link's level". That is wrong for the primary audience.
It means: **to let five named colleagues mark up a board, the owner must first
mint a public read/write URL** — even though nobody is going to use the URL.
For internal release tooling that is often flatly against policy, and it is a
strictly worse security posture than naming the people.

`readers` removes the coupling and needs **no new table**. The machinery is
already there and already used:

- `grant_session_share(sessionId, {provider, subject}, "read")` — targeted
  grants, already audited, already firing `_notifySessionAccessChanged`.
- `list_known_users` — a directory built precisely to resolve a grantee's
  stable subject from a name or email. The chk deployment has 24 signed-in
  users in it.

So "let Sean and Mayur mark up the sign-off board" is: read-share the session
with them, set the canvas policy to `readers`. No public URL, no session-write,
no new grant table, no new revocation path.

**A `readers` writer still cannot steer the agent.** Read-share grants
`session:read`, not `session:write` — so they can write KV rows and cannot send
messages, cannot ring the doorbell, cannot spend the owner's tokens. That is
exactly the separation Part H wants, and it is why `readers` should be the
default choice for internal work and `link` the exception.

## D.2 Three ways in, one policy

```
                          ┌── owner / session writer ──┐
owner sets the policy ────┼── session READER ──────────┼── one policy decides
                          └── link bearer ─────────────┘
```

- **Session reader** — someone the session was read-shared with. They see the
  session *and* the canvas. Under `readers` or `link` they may write.
  Identity is a real entra subject, so every row is attributable.
- **Link bearer** — opens the link, sees **only the canvas**. No session is
  attached in the UX: no transcript, no chat, no artifact list, no session id.
  This is the existing `CanvasShareView`, which today is read-only and gains
  write. Only reachable under policy `link`.
- Raising the policy to `link` is the deliberate step that admits anonymous
  writers. `readers` never does.

## D.3 The app's half of the switch

The policy grants; the app must also support it. Two switches, both the
owner's, and neither alone opens the door:

```
Switch 1 — the app       "kv": { "write": "owner" }    only the creator (default)
                         "kv": { "write": "viewers" }  anyone the policy admits
                         no kv key at all              the app has no store

Switch 2 — the policy    owner | readers | link
```

An app declaring `viewers` on a canvas whose policy is `owner` is inert — the
app supports collaboration, the owner has not turned it on.

## D.4 Who is writing, and who decides

Nothing inspects a request and *works out* whether it came from the owner or a
link holder. **The door the request arrived at is the identity.** They are two
physically separate routes with two separate credential types, and neither can
be persuaded to be the other.

```
POST /api/v1/management/sessions/:id/canvas-kv        BEHIND requireAuth
     no token parameter exists on this route
     sessionId comes from the path, principal from the auth context
     → by = { kind: "user", id: <provider/subject>, label: <display name> }

POST /api/canvas-share/kv?t=<token>                   OUTSIDE requireAuth
     no auth context is read on this route
     sessionId AND slot come from the TOKEN ROW, never from the request
     → by = { kind: "link", id: <server-issued writer id>, label: <self-declared> }
```

A link holder posting to door 1 has no credential and gets 401. A signed-in
user posting to door 2 is treated as a bearer, which is correct — they
presented a bearer credential.

### The token-wins rule

If a request carries a share token, it is a bearer request. Full stop. No
fallback to portal auth, even when the caller also has a valid session cookie.

This is not fastidiousness. `ws.js` already learned it and says why: **on a
no-auth deployment, anonymous authentication succeeds.** So "is there an auth
context?" is not a safe discriminator everywhere — a fallback would silently
upgrade every link bearer to a full-auth connection. The discriminator is
"was a token presented", and the token always wins.

The HTTP KV doors must copy that rule exactly. It is the same trap.

### `by` is stamped, never accepted

The chokepoint takes `by` as a parameter and each door builds it from its own
authenticated context. It is never read from the request body. If it were, a
link holder could simply claim `by.kind: "user"`.

This is the stance the codebase already takes on `sendMessage`, where the
sender is server-stamped and a client-supplied `options.sender` is overwritten.

The layering that keeps it true: **each door authenticates first and hands the
chokepoint a resolved principal.** The chokepoint never sees a raw token or a
raw cookie, so it cannot be tricked by a malformed one — it does not parse
credentials at all.

```
resolveWriteRule({ sessionId, slot, principal })
  principal = { kind: "user",  provider, subject, isAdmin }
            | { kind: "link",  tokenRow }
            | { kind: "agent", sessionId }
```

### Where the policy is actually read

The canvas policy is read **per write**. For a signed-in caller it is the
canvas's `kv-access` value resolved against their session relation; for a
bearer it is that value plus the `write_enabled` flag on the row the token
resolved to. Never from a query parameter, never from the browser, never from
the app manifest.

Both doors consult it, for different people:

| Door | Who | Policy decides |
|---|---|---|
| 1 | owner, admin | nothing — they always write |
| 1 | session **write** access | nothing — they always write (the agent law, D.1) |
| 1 | session **read** access | **yes** — writes under `readers` or `link`, else reads |
| 2 | link bearer | **yes** — only under `link`, and 403 when the link is read-only |

So the policy lookup belongs in the chokepoint, not in either door. Door 1
resolves a user principal, door 2 resolves a token row, and both call the same
`resolveWriteRule`.

### The writer id, and one hole worth closing

`by.id` for a link holder cannot come from the token — every bearer of one
link shares it, so attribution would collapse to a single name. It also cannot
come from the page, which would make it trivially forgeable.

It is a cookie the share door sets on first contact: a random id, scoped to
the share path. It is a **nickname, not a credential** — it grants nothing and
is never an authorization input.

That last clause matters, because author-bound writes (H.2) compare `by.id`.
A plain cookie is editable in devtools, so a bearer could adopt another
bearer's id and delete their rows. **Sign it**: the server issues
`<id>.<hmac(id)>` and the door verifies the HMAC before stamping `by`. Cheap,
and it closes the forge.

What that still does not give you: one human, one id. A bearer can clear their
cookie and get a fresh id (losing their own author-binding), and two people can
share a browser. Among anonymous bearers, author-binding stops impersonation —
it does not establish identity. For that, sign in.

### Revocation latency

| Change | Write path | Open socket |
|---|---|---|
| Link reset (rotate) | immediate — old token resolves to nothing, 404 | ≤60 s, then close 4403 |
| Read/write → read-only | immediate — next write 403s | connection stays; it was only reading |
| Link removed | immediate — 404 | ≤60 s, then close 4403 |
| Session unshared | immediate — snapshot re-resolves | immediate via `onSessionAccessChanged` |

The write path has no cache: every write re-resolves the token row and the
access snapshot. The 60 s figure is the existing `ws.js` re-validation timer
(`PILOTSWARM_SHARE_REVALIDATE_MS`), which applies only to already-open
subscriptions.

### What structurally cannot happen

- **A bearer writing another slot or session.** Neither is in the request; both
  come from the token row.
- **A bearer claiming to be a user.** `by` is stamped by the door.
- **A read-only bearer writing.** Door 2 checks the row before calling the
  chokepoint, and the chokepoint checks again.
- **A page picking its own identity.** The page never sends `by`; the host
  bridge does not accept one.

## D.5 Link rules

- **Upgrades rotate the token; downgrades do not.** Turning a link read/write
  mints a new token, so a link handed out as view-only never silently becomes
  writable in someone's inbox. Turning it back to read-only leaves the token
  alive.
- **Read/write links expire.** Default 7 days, owner-settable. Read-only links
  keep today's never-expires behaviour.
- **One live token per canvas**, unchanged: reset rotates, remove unlinks.
- **The share dialog must state the consequence in words**: "anyone who can
  see this session will also be able to write this canvas." A policy that
  reaches session readers is not obvious from a dialog that says "link".

## D.6 What this replaces

Two earlier drafts, both corrected:

1. **Per-person `canvas_grant` rows.** Dropped — a whole new table, UI and
   revocation path for something session shares already express.
2. **The policy living on the share link.** Dropped — it coupled "let named
   colleagues write" to "publish a public write URL" (D.1).

What survives is one three-value policy on the canvas, resolved against access
the session already grants.

## D.7 What a canvas-only viewer cannot do

| Action | Link bearer, or a `readers` writer |
|---|---|
| Read or write the KV per the policy | yes |
| Read the transcript, artifacts, events | **no** (link bearer) |
| Send a message to the agent | **no** |
| Ring the doorbell (wake a turn) | **no** |
| Write another slot's KV | **no** |
| Write `cfg/*` | **no** |

---

# Part E — The page/session protocol

The KV moves data between viewers. It does not wake the session. When the app
needs the agent to *do* something:

**The KV carries the payload; the action rings the doorbell.**

```
page                          KV                        agent
 │  put req/<id>               │                         │
 │  {op, args, status:"queued"}│                         │
 ├────────────────────────────►│  (every viewer sees it) │
 │  canvas-action { id }       │                         │
 ├─────────────────────────────┼────────────────────────►│  turn starts
 │                             │  get req/<id>           │
 │                             │◄────────────────────────┤
 │                             │  put {status:"working"} │
 │  (every viewer sees it)     │◄────────────────────────┤
 │                             │  put {status:"done",    │
 │                             │       result:{…}}       │
 │◄────────────────────────────┼─────────────────────────┤
 │  render the answer          │                         │
 │  NO redraw needed           │                         │
```

```jsonc
responseContract: { "actions": { "request": { "id": "string" } } }
```

The action carries an id and nothing else. That buys four things: the 8 KB
action cap stops mattering, every viewer sees the request instead of only the
sender, the request survives a reload because it is a durable row, and the
agent answers by writing the KV so no redraw wipes other people's drafts.

Request rows carry `{op, args, status, result?, error?}` with `status` in
`suggested | queued | working | done | failed`. Who wrote the row decides
whether it starts at `suggested` or `queued` (see below). Two more rules make
it safe:

- **Always land the row.** Never leave a request in `working`; a page cannot
  tell a crash from slowness.
- **Check `status` before working.** Doorbells arrive twice and a session can
  be regenerated mid-request.

## Who may make the agent act

Writing to the KV and *making the agent do something* are different powers, and
`req/*` is where they meet. The rule:

> **Only the owner and the owning agent decide what the agent acts on.**
> Everyone else may *suggest*.

So `req/*` rows carry a status whose entry point depends on who wrote them:

```
suggested   written by a collaborator (readers grantee, link bearer).
            Visible to everyone. The agent will NOT act on it.
queued      written by the owner or a session writer, or promoted from
            "suggested" by the owner. The agent acts on it.
working     the agent has it
done / failed   terminal, always one or the other
```

Two independent enforcements, because one is not enough:

1. **The chokepoint caps the status.** A `req/*` write from anyone who is not
   owner, admin, session-writer or the agent is forced to `suggested`, and the
   result says so — never silently downgraded. `status` is server-controlled on
   this prefix; it is not an ordinary field.
2. **The drain filters on it.** The agent takes rows that are `queued`. A
   `suggested` row is input to a decision, never a trigger.

The owner's promotion is exactly the button in the app: their page writes
`status: "queued"` on a suggested row, which they may do because they are the
owner. That single write is the "act on this" gesture, and it is attributable.

### The doorbell, in its proper place

Ringing the doorbell enqueues a user message, so it needs session write, which
a canvas-only viewer does not have. But the doorbell was never the security
boundary — it only ever controlled *latency*. The status gate above is the
boundary.

- Anyone with canvas write may create a `req/*` row. It lands `suggested`.
- A session writer may ring, collapsing the wait to seconds.
- Nobody rings: `queued` rows still run on the next wake. `suggested` rows wait
  for the owner however long that takes, and the page must say so —
  **"Suggested — waiting for the owner"**, not a spinner.

One doorbell may stand for several requests. Actions are rate limited to 3 per
3 s, so a per-request doorbell would be dropped anyway.

The typed durable input kind (`canvas_request`, the design of record in
`canvas-data-plane.md`) would remove the doorbell entirely. It does not change
the status gate, which is the part that matters.

## The autonomous path: nobody is watching

The doorbell is a **latency optimization for when a human is at the portal**.
It is not the mechanism. For autonomous pipelines — the primary use here — the
mechanism is the agent's own scheduled wake.

```
On every wake (cron, child completion, or any other turn):
    canvas_kv(op="list", prefix="req/")
    take every row with status "queued"          ← never "suggested"
    do the work, land each row in "done" or "failed"
```

This matters because the fleet's long-running agents already run this way. A
release watcher on a recurring schedule, a runbook marshal woken by child
completion, a nightly perf sweep — none of them need a browser open to make
progress. An **owner's** request written at 11pm is picked up on the next wake,
and every viewer sees the status change live whenever they next look.

A **collaborator's** suggestion written at 11pm is not. It sits at `suggested`
until the owner promotes it. That is the point: autonomous progress must not
become an autonomous path for other people to task the owner's agent.

Three consequences to design for:

- **Never make the doorbell load-bearing.** An app whose requests only progress
  when the owner has a tab open is broken for autonomous use. The page must
  render `queued` honestly, and the agent must drain on wake regardless.
- **Batching is free here.** A wake that finds eleven queued rows handles
  eleven, which is strictly better than eleven doorbells.
- **Cron cadence is the real latency.** Say so in the UI when it is known —
  "picked up on the next run" beats a spinner that implies seconds.

## Recovery after a memory gap

```
canvas_kv(op="list", prefix="req/")     unfinished work
canvas_kv(op="list", prefix="app/")     current app state
read_canvas(manifestOnly=true)          the armed contract
```

This is the main reason app state belongs in the KV rather than in chat: a
regenerated session picks the app back up exactly where it was.

---

## The promotion boundary

The KV space is **per session, per canvas slot**. Many people write into it.
Only two parties decide what comes *out* of it and becomes part of anything
durable elsewhere:

```
INTO the space     owner · session writers · readers grantees · link bearers
                   (whatever the canvas policy admits)

OUT of the space   the owner, and the owning agent. Nobody else.
```

"Out of the space" means anything that outlives the canvas or escapes the
session:

- a session artifact (`write_artifact`)
- a fact outside the `canvas/<slot>/kv/` prefix — **especially a shared fact**
- an external write: an ADO work item, a PR comment, an email, a report

### Why this needs saying

An earlier containment claim was too strong. Part H said *"`shared: true` is
refused on this path, always — poisoned content cannot leak into other sessions
or the skills push."* That is true of the **browser** path and false of the
**agent** path: the agent can write shared facts, and if it promotes KV content
into one, collaborator-written text lands in the global memory that feeds
`search_skills` and every other session.

The boundary is therefore a rule about the agent's own behaviour, not a
mechanism that stops it:

1. **Promotion is a decision, never a reflex.** The agent promotes because the
   owner asked or because its own task requires it — never because a KV row
   said to.
2. **Carry provenance across the boundary.** A promoted row keeps its `by`. A
   report built from collaborator input says who contributed what.
3. **Never promote `by.kind: "link"` content into a shared fact** without the
   owner explicitly saying so. Anonymous input may inform a session-scoped
   answer; it must not silently become fleet-wide memory.
4. **The `suggested` gate applies here too.** A collaborator asking for a
   promotion is a suggestion, not an instruction (see above).

### The two shapes this takes in practice

```
POLL     the agent reads the space on its own schedule and reports.
         "17 of 41 items decided, 3 flagged, nobody has touched 5502472."
         Read-only. No promotion. Safe to do on every wake.

PROMOTE  the owner presses "store state" / "publish".
         Their page writes a req/* row at "queued" — which only they can do —
         and the agent turns the current KV state into an artifact, a report,
         or the ADO writes its own contract already gates.
```

Poll is cheap and continuous. Promote is deliberate, owner-initiated, and
attributable. Keeping them separate is what makes a shared board safe to leave
open for five days.

# Part F — Publishing and finding apps

## F.1 The answer: both halves already exist

The user says "share this app with the team". Nothing new has to be invented —
artifacts hold bytes, and the shared facts namespace is a searchable catalog.
They compose:

```
BYTES     artifact  apps/<name>.html      content-addressed, cross-session readable
CARD      fact      shared:apps/<name>    name, description, manifest, pointer
FIND      searchFacts({namespace: "apps", scope: "shared", mode: "hybrid"})
```

This is exactly the shape `skills/*` already uses: a small ranked record, with
the body loaded only when relevant. Two facts confirm it needs no schema work:

- `namespacePrefix("apps")` builds a plain `apps/%` LIKE prefix, so search
  works on any namespace with no migration.
- `facts_namespace_for_key` has a hardcoded allowlist
  (`skills, asks, intake, config`) used **only for stats bucketing**. Apps
  would report under `(other)` until `apps` is added — cosmetic, not blocking.

## F.2 The catalog record

```jsonc
key: apps/<name>              // shared fact
{
  "name": "pr-review-board",
  "description": "Use when reviewing a pull request diff — files, hunks and
                  per-reviewer marks side by side, two people at once.",
  "card": { … the embedded CANVAS-APP-MANIFEST summary … },
  "source": { "kind": "artifact", "sessionId": "…",
              "filename": "apps/pr-review-board.html", "sha256": "…" },
  "kv": { "write": "viewers" },
  "publishedBy": "…", "publishedAt": "…",
  "tags": ["review", "diff", "collaborative"]
}
```

## F.3 One tool, not a recipe

Teaching a two-call recipe (save the artifact, then write the fact) will drift:
agents forget the second call, or hand-write a bad card. One tool instead:

```
publish_canvas_app({ slot?, name, description, tags? })
   → server-side copy canvas.html  → artifact apps/<name>.html
   → extract the embedded manifest → the card
   → upsert shared fact apps/<name>
```

The card is derived from the document, never from the model's memory of it. No
bytes enter context.

## F.4 Finding one

```
find_canvas_app({ query: "review a pull request diff", limit?: 8 })
   → searchFacts({ namespace: "apps", scope: "shared", mode: "hybrid" })
   → ranked [{ key, name, description, score }]
```

About twenty lines — the same shape as `search_skills`, pointed at a different
namespace. On a base fact store (no enhanced search) it degrades to
`read_facts(key_pattern: "apps/*", scope: "shared")`, which is a plain listing
and still answers "what apps exist".

Drawing one is the existing path, unchanged:

```
draw_canvas({ fromArtifact: { sessionId, filename } })   // from the card's source
```

## F.5 What the base agent needs

Four small changes, in the default agent prompt and the skill:

1. **Look before building.** When the user asks for an app, search the catalog
   first. Building a second PR-review board when a good one exists is the
   failure this catalog is for.
2. **Suggest by situation.** When the user is doing something an app fits —
   reading a diff, running a meeting, watching a deploy — search and offer,
   rather than waiting to be asked.
3. **Publish when the user says to share it**, using `publish_canvas_app`.
4. **Write the description for the situation, not the mechanics.** This is the
   ranking text. "Use when reviewing a pull request diff" ranks against a user
   looking at code deltas; "PR board" does not.

## F.6 Two weights of publish

| | Light (this spec) | Heavy (`canvas-apps.md` phase 3) |
|---|---|---|
| Act | "share this with the team" | cut an agent-package release |
| Storage | artifact + shared fact | package `canvas/*.html` |
| Versioning | sha in the card | semver, pinned per session |
| Control | whoever published | package scope and enable/disable |
| Draw with | `fromArtifact` | `fromPackage` |

Both should write the same `apps/*` catalog fact, so there is **one catalog
and two ways into it**. A package publish adds its apps; a light publish adds
one. Discovery does not care which.

## F.6a The authoring mismatch nobody should discover late

Every canvas in the chk fleet today **bakes its data into the document**. The
M66 approver sheet is a fully-rendered 205 KB page: the items, the evidence,
the verdicts, all inlined at author time. That is the natural way to write a
canvas when there is no KV — and it is exactly what cannot be published.

So publishing is **not** free reuse of the canvases that exist now. A reusable
app has to be authored differently, on purpose:

```
BAKED (today)      one document = shell + this train's 41 items
                   → reusable for nothing; publishing it leaks the data

SHELL (publishable) document = layout + behaviour, zero rows
                   → data arrives from the KV (app/item/*) or from ticks
                   → the SAME app serves M66, M67, and every train after
```

The rule from F.7 ("publish the shell, never the data") is therefore not only
a disclosure control — it is the thing that makes an app reusable at all. An
app that reads its rows from the KV gets both properties from one decision.

State the cost honestly: converting a baked canvas into a publishable app is a
rewrite of its data path, not a copy. The upside is that the rewrite is the
same work as adopting the KV, so a team doing Part C is already most of the way
to Part F.

**For this fleet specifically**, reusable apps may fit the existing **package**
mechanism better than a free-floating `apps/*` fact — the r2d agents already
ship as a versioned package (`affan-r2d-private`), and a `canvas/*.html` inside
it inherits that versioning and pinning. F.6 already routes both publish
weights into one catalog namespace, so this is a deployment choice, not a
different design.

## F.7 Publishing is a disclosure

A shared fact is readable by every session, and the artifact bytes are
readable cross-session through the worker-trusted layer. So **publishing makes
the document readable by any session in the deployment.**

The rule that follows: **publish the shell, never the data.** An app that
baked a customer list into a JS literal must not be published. Apps load their
data through the KV or through ticks, both of which stay session-scoped.
`publish_canvas_app` should say this in its description, and the skill should
teach it as a hard rule.

---

# Part G — Surfaces

## G.1 Portal

Unchanged except: the KV bridge, the write affordances when the viewer's
policy allows, and the share dialog gaining the read/write choice with its
consequence stated in words.

## G.2 The link view

`CanvasShareView` today: one canvas, no session, read-only. It gains the KV
bridge and, when the link is read/write, the ability to write. It must stay
the *only* thing a bearer can reach — the restricted WebSocket branch in
`ws.js` already refuses everything except subscribing to its own canvas, and
that stays true.

## G.3 The TUI — fail loudly, stay out of the way

**The TUI has no canvas surface at all.** There is no `draw_canvas` handling in
`packages/app/tui/`; the only canvas reference anywhere in it is
`resetCanvasShareLink` in the transport. So a TUI session that draws a canvas
succeeds server-side and the user sees nothing. That is the worst failure mode:
silent.

Three rules fix it without building a renderer.

**1. Every canvas event prints one explicit line.** Never silent, never a
spinner, never a pretend render:

```
[canvas] rev 3 · "meeting notes" · not viewable in the terminal
         open: https://portal.example/?session=<id>&view=canvas
```

Draw, tick and present each print. The line is copy-pasteable, because that is
the whole remedy.

**2. `show_canvas` tells the agent the truth.** In a session with no portal
viewer, the result says the canvas cannot be presented on this client, so the
agent tells the user instead of assuming a screen changed. `draw_canvas` still
succeeds — building an app to share by link from a terminal is legitimate, and
must keep working.

**3. It stays out of the way.** No new pane, no new keybinding, no startup
cost, no prompt. Output appears only when a session actually draws. A TUI user
who never touches canvases sees nothing new, ever.

A TUI user cannot be a canvas collaborator. That is fine — they have chat, and
they can mint a link for people who do have a browser.

---

# Part H — Security

## H.1 The threat that matters

Anonymous or read-only people writing into a store an LLM later reads is a
prompt-injection surface. This design bounds it; it does not pretend to solve
it.

1. **Namespace.** The browser can write only `canvas/<slot>/kv/`, minus
   `cfg/*`. It cannot reach the agent's facts, another session's facts, or
   shared facts.
2. **Never shared from the browser.** `shared: true` is refused on the write
   path, always — no viewer can put content into global memory. The **agent**
   can, so the promotion boundary (Part E, the promotion boundary) is what governs that direction:
   provenance travels, and link-written content never becomes a shared fact
   without the owner saying so.
3. **No wake-up, and no tasking.** A KV write never enqueues a message and
   never starts a turn. A collaborator's `req/*` row lands `suggested`, which
   the agent's drain skips, so writers can neither choose *when* the agent runs
   nor *what* it acts on. Only the owner promotes a row to `queued`.
4. **Attributed.** `by.kind` distinguishes a verified user from an unverified
   link bearer, at every row.
5. **Bounded.** One canvas, 2 MB, 1000 keys.

State it plainly and never as isolation: *this person can put text on this
board, and cannot direct or time what the agent does with it.*

## H.2 Author-bound writes

Writes and deletes are author-bound by default: you modify and delete rows
whose `by.id` is yours; the owner and the agent modify anything. Apps opt into
shared mutation per prefix:

```jsonc
"kv": { "write": "viewers", "shared": ["app/task/*"] }
```

Default-tight is deliberate. Too tight fails as a visible refusal; too loose
fails as one contributor silently blanking everyone's notes. Facts soft-delete,
so an owner can restore.

The comparison is against the stamped `by.id`, so its integrity is what makes
this a control rather than a convention — see D.4. For signed-in writers it is
the real principal. For link holders it is a **signed** server-issued id: a
bearer cannot adopt another bearer's id, but can discard their own. Among
anonymous bearers, author-binding prevents impersonation; it does not
establish identity.

## H.3 Revocation and audit

- Policy changes and link resets fire `_notifySessionAccessChanged`, the path
  share changes already use, so open sockets re-validate immediately.
- Writes re-resolve the policy per request; an in-flight writer is refused on
  the next write.
- Link mint, reset, remove and policy change all hit `_recordAudit` with
  `decision: "share_change"`, exactly as `setSessionVisibility` does.
- Every KV row carries its writer, so "who wrote this" needs no extra log.

---

# Part I — Limits

| Thing | Cap |
|---|---|
| KV key | 200 chars, `[a-zA-Z0-9._/-]`, no `..`, no leading `/` |
| KV value (serialized envelope) | 16 KB |
| Keys per canvas | 1000 |
| Total per canvas | 2 MB |
| KV writes | 10/s per viewer, 50/s per canvas |
| `list` page | 200 keys, cursor-paged |
| Document | 900 KB (unchanged) |
| Tick | 32 KB merged (unchanged) |
| Action payload | 8 KB, 2048-char strings (unchanged) |
| Contract | 16 actions × 16 fields, 4 KB (unchanged) |

Rate limits live at each door; byte and key budgets live in the chokepoint,
because they are properties of the canvas.

---

# Part J — Phases

Ranked by evidence, not by tidiness. Phase 1 is the critical path to value and
everything else is optional relative to it.

1. **KV core + live fan-out + one write door.** `canvas-kv.ts` chokepoint, key
   layout, envelope, quota, `cfg/*` lock, author-bound writes,
   `notifyCanvasKv`, the `canvas_kv` agent tool, the `kv` manifest key, the
   `kind:"kv"` branch in `canvas-plane.js` and its client dispatch, the host
   postMessage bridge, and **door 1 only** (signed-in). Owner and session
   writers can collaborate. (~3 d)

   **Acceptance is a M66 reprise, not a unit test.** Rebuild the approver walk
   against the KV and compare with the measured baseline in §1a: redraws
   should fall from 62 to single digits, and no action payload should carry
   the whole form. If that does not happen, the design is wrong, not the app.

2. **The `readers` policy.** Canvas `kv-access` (`owner | readers | link`),
   resolution against session read-shares, `me.relation`, and the share-dialog
   control. This is what turns a single-approver board into a multi-approver
   one, and it needs no new table. (~1 d)

3. **Protocol + skill.** `req/*` conventions, the autonomous cron drain,
   doorbell batching, the `CanvasKV()` helper, the layout and scroll rules, and
   a **release sign-off board** reference app. (~1.5 d)

4. **Public read/write links.** Policy value `link`, `write_enabled`,
   upgrade-rotates, TTL, the token KV door, signed writer ids, the link view
   gaining write. Last of the access work because it is the only step that
   admits anonymous writers, and `readers` already covers the internal case.
   (~2 d)

5. **TUI loud failure.** Canvas event lines with the portal URL,
   `show_canvas` honesty. Independent of everything and cheap — but this fleet
   is portal-first, so it is a correctness fix, not a value unlock. (~0.5 d)

6. **Catalog.** `publish_canvas_app`, `find_canvas_app`, base-agent guidance,
   the `apps` namespace stats migration. Deliberately last: it has the thinnest
   evidence, and it only pays off once apps are authored shell-first (F.6a),
   which phases 1–3 are what cause. (~1.5 d)

7. **Optional.** `kv.live.put()` on the UNLOGGED plane (the perf-sweep and
   spectating case); per-person access if `readers` proves too coarse; package
   publishes writing catalog facts; a "who wrote what" panel.

What moved and why: door 2 and the public link dropped from phase 3 to phase 4
because `readers` covers the real internal need without them; the catalog
dropped to last; and phase 1 grew the relay branch it actually needs (C.4).

# Part K — Rejected

- **KV inside the `canvas_live` payload.** Collides with the agent's
  whole-state ticks, which reset the payload on every redraw; and UNLOGGED
  means the notes vanish on a failover.
- **The generic `storeFact` op as a door.** Not session-scoped.
- **A facts-table trigger for the notify.** Pins the relay to wherever facts
  live, and facts can be a different database. Missed notifies self-heal.
- **Injecting a script runtime into canvas documents.** Changes bytes the
  agent authored and the link door serves raw, and one bug breaks every canvas.
- **Per-person canvas grants in v1.** One policy per canvas covers the real
  cases with no new table, UI, or revocation path.
- **CRDT text merge.** The answer to concurrent editing is finer keys.
- **Waking the agent on writes.** Brings back the durable-event flood the data
  plane removed, and hands writers a way to spend the owner's tokens.
- **A canvas renderer in the TUI.** The terminal cannot run the page. A loud
  line and a URL is the honest answer.

# Part L — Open

1. **Read/write link TTL default.** Recommendation: 7 days.
2. **Embedding KV facts.** Recommendation: no by default — ten writes a second
   would thrash the embedder. Opt in per app for "search last month's notes".
3. **Notes outliving the session.** Session facts are swept on delete.
   Recommendation: keep that, and make publish-or-export the explicit way out.
4. **The bulk read channel (`canvas-fetch`).** A canvas cannot see anything
   large: the document caps at 900 KB, KV values at 16 KB, ticks at 32 KB, and
   the sandbox has no network at all. The PR workbench on chk carries **97
   lines of code for three PRs** as a result — an evidence board, not a diff
   viewer. Proposed fix in
   [canvas-app-pr-workbench.md §6](canvas-app-pr-workbench.md): a fourth
   postMessage type, `canvas-fetch`, resolved by the HOST as a read-only
   artifact read, scoped to prefixes the manifest declares (default-closed like
   the response contract). Completes the storage story — KV for small mutable
   shared state, artifacts for large immutable payload, the host bridging both.
   **Recommendation: fold into phase 1.** Every app whose subject is bigger
   than its screen needs it, and it adds no write surface.

5. **Attribution for authenticated link bearers.** A named colleague who must
   see the board but NOT the session transcript has no good option today:
   `readers` gives the transcript, `link` gives anonymity. Fix: an
   authenticated viewer opening a link keeps the link's scope and gains their
   real identity in `by`. Authorization still never falls back to the cookie —
   only attribution does. This is the case the dropped `canvas_grant` existed
   for, solved without the table.

6. **`cfg/policy.autoQueueFrom`.** Whether a collaborator's request auto-queues
   or waits for the owner should be one owner-writable config key, default
   `["owner"]`.

7. **Thread anchoring across revisions.** Threads must carry the SHA they were
   written against and be re-anchored or marked outdated when the subject
   changes — never silently moved. The chk app has no anchoring at all.

8. **Catalog curation.** Anyone can publish `apps/*`. Does it need the
   facts-manager's review, a per-user namespace, or nothing? Recommendation:
   nothing at first; revisit if the catalog gets noisy.
