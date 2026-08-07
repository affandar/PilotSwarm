# Proposal: Session Canvas — a standing visual surface the agent owns

> **Status:** Proposal
> **Date:** 2026-08-07
> **Goal:** Give every root session one persistent, agent-drawn visual surface — a canvas — that is first-class the way summaries are: one tool contract, one storage home, one live-update path, one surface per host.

---

## Summary

Agents can already *show* a file: `show_artifact` opens the artifact reader on
whatever the agent just wrote, and the reader renders HTML as a live sandboxed
page. That is a **preview** model — transient, tied to a filename, gone when
the user closes it or opens something else. It is the right model for "look at
this file", and it stays exactly as it is.

What is missing is a **standing display**: a surface that belongs to the
session, that the agent can draw to and read back across turns, that the user
can flip the right column to and leave there — a dashboard the agent keeps
current, a diagram it refines as the work evolves, a status board for a
long-running watcher. Sessions already have this shape for *text*: the live
summary, updated by `update_session_summary`, stored on the session, rendered
by every host. The canvas is the same contract for *pixels*.

This proposal adds:

- One canvas per **root** session, stored as a reserved artifact
  (`canvas.html`) plus a monotonic revision.
- Two LLM tools on root sessions only: `draw_canvas` (whole-document replace)
  and `read_canvas` (paged read-back).
- A durable `session.canvas_updated` event, riding the same spine
  `session.artifact_presented` already rides — live push, transcript record,
  and replay for free.
- A portal **Canvas mode** for the right column — a persisted toggle like the
  chat's transcript/summary switch — rendering the canvas through the
  existing sandboxed HTML preview (double-buffered reload, zoom, fit-width).
- A mobile Canvas tab, shown once the canvas is non-empty.
- Chat stays quiet in the browser: canvas updates never render as links or
  cards in the portal chat, desktop or mobile — the canvas pane updating IS
  the signal. The TUI, which cannot render the canvas, shows each revision in
  the transcript as an ordinary artifact link instead.

Decided up front (previously open questions):

- **Auto-flip: yes.** The first `canvas_updated` on the active session flips
  the right column to Canvas, under the same guards `show_artifact` uses.
  After the user manually toggles away, the portal never flips again for that
  session — the Canvas button badges instead.
- **One canvas per session.** No named canvases in v1.
- **Root sessions only.** Sub-agents have no canvas and no tools that touch
  the parent's. A parent that wants child work displayed relays it with its
  own `draw_canvas`.
- **`show_artifact` remains the viewer.** Preview and canvas are different
  verbs and both stay.

---

## Problem

A session that produces visual state today has two bad options:

1. **Re-show an artifact every time it changes.** `show_artifact` was built
   for "here is the thing you asked for", and its guards deliberately stop it
   from reorganizing the workspace on replay or for background sessions. Using
   it as a display loop fights those guards: every update is a fresh
   presentation, the user's pane selection is churned, and nothing marks one
   artifact as *the* current display rather than one of many files.

2. **Write files and hope the user watches the Files tab.** No live signal, no
   sense of "current", no read-back contract for the agent to iterate against.

Meanwhile the demand shape is common and growing: watcher agents maintaining
status boards, research agents refining a chart as data lands, ops agents
keeping a live topology sketch. Each of these wants exactly what the summary
already gives text: *replace the standing state, everyone sees it, the agent
can read what it last wrote.*

---

## Goals

- One persistent, revisioned visual surface per root session.
- Whole-document replace semantics — idempotent, schema-checkable, replayable.
- The agent can read its own canvas back, paged, across turns and epochs.
- Live updates in every open portal view of the session, without flashes.
- Survives worker restarts, node migration, and context regeneration.
- Zero database migration; no new hot-table columns.
- The existing artifact reader ("preview" model) is untouched.

## Non-Goals

- Incremental drawing operations (append/patch protocols). Whole-replace is
  the v1 contract, as it is for summaries.
- Named or multiple canvases per session.
- Sub-agent access to any canvas, including the parent's.
- Canvas rendering in the TUI.
- Collaborative human editing of the canvas. The agent draws; humans watch.
- Revision history browsing. Only the current revision is addressable in v1.

---

## Design

### Storage: a reserved artifact plus a revision, not a CMS column

The obvious mirror of `summary_state` is a `canvas_html` column on the
sessions table. It is the wrong mirror:

- Summary state is ~2 KB of JSON; canvas HTML is routinely 100–500 KB. Hot
  rows should not carry that (the 0029 migration incident is the standing
  lesson on touching the sessions table casually).
- Every session detail fetch would pay for bytes it almost never wants.
- The artifact store already provides exactly the needed machinery: the 2 MB
  write path, blob storage, retention and pinning, deep links, regen
  survival (artifacts are documented to survive context regeneration), and —
  decisively — the portal's hardened sandboxed HTML renderer with
  double-buffered reload, artifact-scoped zoom, and fit-width.

So the canvas is the reserved filename **`canvas.html`** on the root session,
written through the ordinary artifact store, listed in Files (pinned, so
retention sweeps never eat it — hiding state from the file list is how
mysteries happen), and rendered by the machinery the reader already uses.

What makes it more than "just a file" is the event contract:

```
session.canvas_updated   { rev: <int>, note?: <string>, sizeBytes: <int> }
```

- `rev` is monotonic per session, starting at 1. Clients compare revs to know
  staleness without fetching bytes. The worker derives the next rev by
  incrementing the last `canvas_updated` event's rev (the event log is the
  source of truth; no counter column).
- The event is durable and rides the same onEvent → CMS → WebSocket spine as
  `session.artifact_presented`, so live push, transcript record, and
  replay-after-reconnect all come free, with the same freshness semantics
  available to guards.

### Synchronization: how a client knows its canvas is current

The client never polls and never diffs metadata against CMS in the steady
state. It keeps two integers per session — `latestRev`, the highest revision
seen in events, and `displayedRev`, what the iframe currently shows — and
"stale" is simply `displayedRev < latestRev`.

Three cases, two of them already solved by existing machinery:

- **Live.** `canvas_updated` arrives on the session WebSocket and merges like
  any event, bumping `latestRev`; a mounted canvas pane refetches through the
  ordinary artifact download route, swaps behind the current frame, and sets
  `displayedRev = rev`. The event delivers the rev; nothing is queried.
- **Reconnect.** WS delivery is an acceleration path; correctness comes from
  the client's existing `afterSeq` event replay against CMS. A missed
  `canvas_updated` arrives in that replay and takes the same merge path. The
  only CMS query involved is the one the client already makes for every
  session.
- **Cold load.** History loading is windowed, so a canvas last drawn long ago
  may predate the loaded event window — the client would not know a canvas
  exists. Snapshot-then-deltas closes this, the same shape session detail
  uses: one snapshot establishes `latestRev`, fired **once per session as
  part of the selection burst** (beside the detail and history fetches the
  controller already makes) — not on pane mount, because the mobile Canvas
  tab and the Canvas button's badge need canvas meta before any pane exists.
  In v1 it is a single filtered query
  (`event_types=["session.canvas_updated"]`, limit 1, an API that already
  exists); in Phase 2 it costs zero extra round trips, riding
  `get_session_detail(include:["canvas"])`, which selection fetches anyway.
  Events carry every delta thereafter.

  The result is memoized per session and never re-queried while event
  coverage is contiguous — live pushes and `afterSeq` replay keep it current
  across reconnects. The one invalidation: if a gap is closed by a windowed
  bulk reload rather than gap-free replay, continuity is broken and the
  snapshot is re-taken on next need. Snapshot + unbroken stream = current;
  break the stream, re-snapshot.

  The snapshot is not a scan of the loaded window — it is an indexed lookup
  against the full durable log, and its result is definitive in both
  directions. Event found: a canvas exists at exactly that rev; fetch the
  bytes. Nothing found: no canvas has ever been drawn; blank state. Bytes
  are only ever fetched on the authority of an event — the client never
  blind-loads `canvas.html` on the assumption that an update was missed.
  (Corollary of write-then-emit: if a worker dies between the store write
  and the emit, orphan bytes can exist while the log says no canvas. The log
  stays the single authority — the portal shows blank, and the next draw
  heals it, since rev derives from the log. A crashed half-draw reading as
  "not drawn" is the right conservative answer.)

**Guard scope, explicitly:** the freshness guard applies to the auto-FLIP
only, never to content. An hour-old `canvas_updated` arriving in a replay
still bumps `latestRev` and still updates a mounted pane. Staleness guards
protect the user's focus from being yanked; they must never stop the data
converging. This deliberately diverges from `session.artifact_presented`,
which drops stale events outright — correct there, because a presentation is
an action, not state.

`rev` is the ordering identity. The artifact store's existing `sha256` meta
remains available as a byte-level check, but write-then-emit ordering makes
it unnecessary in practice.

### Tools

Both tools follow the shared-spec pattern (`SHOW_ARTIFACT_TOOL_SPEC`
precedent): one spec object feeds both the `systemToolDefs()` declaration and
the per-turn handler, so the declaration the model sees and the handler that
runs cannot drift. (A handler with no declaration is invisible to the model;
a declaration with no handler returns "stub" — both failure modes are
documented history in this repo.)

**`draw_canvas(html, note?)`** — replace the canvas with a complete HTML
document.

- Whole-document replace. Idempotent; a retried turn redraws the same thing.
- Writes `canvas.html` via the artifact store, pins it on first write, then
  emits `session.canvas_updated` with the next rev. **Ordering is
  load-bearing:** the event is emitted only after the store write is
  confirmed. Emitting first would let a failed write leave every viewer
  refetching stale bytes labeled with a new rev; the converse failure (write
  lands, emit lost) is benign — the next draw heals it.
- Returns `{ drawn: true, rev, sizeBytes }` — deliberately **no link**. The
  description instructs the opposite of `show_artifact`: *do not paste a
  canvas link into your reply; the canvas updates live on the user's
  screen.* A link per redraw would drown the chat with cards for a surface
  that is already visibly changing. Omitting the link from the result
  removes the temptation as well as the instruction — belt and braces. (The
  canvas remains one click away in Files, and the TUI gets its link from the
  event, below.)
- Does **not** end the turn; the agent keeps talking.
- The description points at the `html-visuals` skill: the canvas renders in
  the same sandbox as artifact previews (self-contained, no network, own
  colors, CSS reflow), so every rule there applies verbatim.
- Root sessions only — see Access below.

**`read_canvas(offset?, maxBytes?)`** — read the current canvas back, paged.

- The "see" half of see-and-draw: iterating on a drawing requires reading
  what is there, especially after context regeneration, where the transcript
  that produced the canvas is gone but the canvas is not.
- Paged with a default cap (64 KB per call), because inlining a 300 KB
  document into context is prompt-bloat the token work exists to prevent.
- Returns `{ rev, sizeBytes, offset, content, truncated }`.

`draw_canvas("")` clears the canvas (rev still increments; the portal shows
the blank state). No separate clear tool.

**Relationship to `show_artifact`:** the descriptions teach the split —
`show_artifact` is "open this file in the viewer, once"; `draw_canvas` is
"update the session's standing display". An agent producing a one-off report
shows it; an agent maintaining a dashboard draws it. The link etiquette
diverges the same way: show says *include the link in your reply* (the
presentation is transient, the link is how it is reopened); draw says *do
not* (the canvas is standing, and its pane is the signal).

### Agent guidance

The canvas is only as good as the judgment around it, so the instruction
layer is part of the design, not an afterthought. Three pieces.

**Triggers — when to draw.** Exactly two:

1. **Commanded.** The user asks for something visual: draw, visualize, chart
   this, graph, keep a dashboard of, sketch the topology.
2. **Judged.** The agent concludes that the outcome it is delivering would be
   *greatly supplemented* by a quick graphic — a trend the numbers bury, a
   dependency graph prose mangles, a status board for work it is watching.
   The bar is deliberately high: "greatly supplements", not "could
   illustrate". Most replies need no drawing.

**Authority — drawing is the flip.** There is no separate switch-the-view
tool. `draw_canvas` brings the canvas into the user's browser (under the
portal's standing guards), and the instructions say so plainly: *drawing
interrupts, so draw when it earns the interruption.* The bar for drawing and
the bar for taking the user's screen are the same bar. The one boundary: if
the user has manually toggled away from the canvas this session, the portal
badges instead of flipping — agent authority ends where an explicit user
choice begins.

**Draft base-prompt section** (lands in `default.agent.md`; final wording at
implementation):

> ## The Canvas: Your Standing Visual Display
>
> Root sessions have one canvas — a persistent visual surface rendered live
> in the user's portal. It starts blank with a standard placeholder until
> you draw.
>
> Draw with `draw_canvas(html, note)` when the user asks for something
> visual, or when an outcome you are delivering would be greatly clarified
> by a quick graphic. Do not draw decoratively, and never redraw on a no-op
> cycle — drawing switches the user's view to the canvas, so draw only when
> that interruption is earned.
>
> The canvas is a full HTML document, replaced whole on every draw. Read it
> back with `read_canvas` before iterating on an existing drawing, and
> after context regeneration — the canvas survives even when your memory of
> drawing it does not. Follow the `html-visuals` skill for anything beyond
> a trivial page.
>
> Do not paste canvas links into your replies; the canvas updates live on
> the user's screen. Keep narrating your work in chat as normal — one
> sentence noting what the canvas now shows is plenty.
>
> `show_artifact` remains the tool for one-off file previews. Canvas is
> your standing display; the viewer is for looking at a particular file.

The tool descriptions carry compressed versions of the same rules (triggers,
interruption bar, no links, whole-replace, read-before-iterate), so an agent
that never loads the base-prompt section still behaves, and the
`html-visuals` pointer rides the description the way `show_artifact`'s
already does.

### Access: root sessions only

Only root (top-level) sessions have a canvas. Sub-agents get neither tool:
gated the same way manager-bundle tools already are — excluded from the
per-turn tool array *and* from declarations, so there is no
exists-but-hidden tool for a child to hallucinate into.

Rationale: a shared drawing surface across a spawn tree is a write-conflict
design problem (interleaved replaces from concurrent children destroy each
other), and the delegation model already has the answer — children report
facts and artifacts; the parent owns presentation. A parent that wants child
output displayed reads it and redraws its own canvas.

### Portal: Canvas mode for the right column

A `Canvas` toggle joins the right column, symmetric with the chat's
transcript/summary switch:

- `ui.rightPaneMode: "panes" | "canvas"`, persisted to profile settings the
  same way `chatViewMode` is (per device class, replace-safe).
- **Canvas mode** replaces the inspector/activity split with one pane
  rendering `canvas.html` through the existing HTML preview panel —
  inheriting the sandbox (`allow-scripts`, no `allow-same-origin`), the
  double-buffered reload (no white flash on redraw), artifact-scoped zoom,
  and fit-width. Its header carries the rev, the note from the latest
  `canvas_updated`, zoom, and the mode toggle back.
- On `session.canvas_updated` for the *viewed* session, the pane refetches
  and swaps behind the current frame. Rev mismatch is the cheap dirtiness
  check (see Synchronization above for where the authoritative rev comes
  from in each case).
- **Blank state** (no canvas yet, or cleared) is a standard message, not an
  empty pane — user-facing wording along the lines of: *"Nothing on the
  canvas yet. Ask the agent to draw — a dashboard, a chart, a diagram — or
  it will draw when it has something worth showing."* It teaches the
  feature at the exact moment the user is looking at its absence.
- The **artifact takeover reader is unchanged**. `show_artifact`, chat cards,
  and deep links keep opening the preview exactly as they do today. If the
  reader opens while in Canvas mode, it takes over as usual and `✕` returns
  to Canvas mode, not to the inspector — restore-what-was-displaced, the rule
  the reader already follows for the collapsed-column case.

**Auto-flip.** On a `canvas_updated` merged from the live stream:

- active session only, fresh (< 2 min) only, live-path only — the exact
  guard set `session.artifact_presented` uses, for the same reasons
  (reconnect bursts must not replay; background sessions must not steal the
  view);
- if the user has not manually left Canvas mode for this session: flip to
  Canvas;
- if they have: badge the Canvas toggle (unseen-rev dot) and stay put. The
  manual-toggle memory is per session, in profile settings.

**Deep link:** `?session=<id>&view=canvas` opens chat + canvas, the same
pattern as `&artifact=…&view=full`, including the sessionStorage stash that
survives the Entra login redirect.

### Mobile

A fourth tab — `Main | Inspector | Activity | Canvas` — appearing only when
the session has a canvas (rev ≥ 1 with non-empty content), so empty sessions
do not grow a dead tab. The pane is the same preview component the artifact
overlay already uses full-viewport. Auto-flip on mobile switches the tab
under the same guards.

### Chat quiet in the browser; artifact link in the TUI

Two paths could leak canvas noise into the chat, and both are closed:

1. **The agent's reply.** The tool description forbids pasting the link, and
   the tool result carries none (above).
2. **The event.** `session.canvas_updated` builds a transcript line flagged
   `canvasUpdate`, carrying the `artifact://canvas.html` href. The portal
   chat renderer — desktop and mobile share it — skips flagged lines
   entirely: no card, no link, nothing. The canvas pane updating (or the
   badge, if the user toggled away) is the whole signal. The portal
   **activity feed** keeps a `[canvas] rev N — note` diagnostic line; chat
   is what stays clean, not the event log.

The TUI renders the same flagged line as an ordinary artifact link — the
usual `[artifact: canvas.html](artifact://…)` affordance, press-`a` and all —
because a host that cannot render the canvas needs the link, and its
transcript is where artifacts have always appeared. Same shared-data,
host-chooses-affordance precedent as the download hint. No TUI pane, no
toggle.

### Durability and lifecycle

- **Worker restarts / node migration:** artifact store is durable; the event
  log is durable; nothing worker-local.
- **Context regeneration:** artifacts survive regen by contract. The regen
  handoff should mention the canvas exists (rev + note) so the rebuilt
  context knows to `read_canvas` before redrawing from scratch.
- **Retention:** the canvas artifact is pinned at first write; sweeps skip
  pinned artifacts.
- **Session deletion:** canvas dies with the session's artifacts, as any
  artifact does.
- **Epochs:** rev continues across epochs (derived from the event log, which
  spans them).

---

## Implementation shape

Phase 1 — core (no migration, no schema change):

1. `SDK` — `DRAW_CANVAS_TOOL_SPEC` / `READ_CANVAS_TOOL_SPEC` shared specs;
   declarations in `systemToolDefs()` gated to root sessions; per-turn
   handlers writing through the artifact store and emitting
   `session.canvas_updated` via `opts.onEvent`. Root-gating follows the
   manager-bundle pattern (both halves gated on one predicate).
2. `ui-core` — `ui.rightPaneMode` state + reducer + profile persistence;
   canvas state (`latestRev` / `displayedRev` / note) with the mount-time
   snapshot query; `canvas_updated` handling in `mergeSessionEvent` — flip
   gated by the artifact-presented guard set plus the manual-toggle memory,
   content convergence ungated; canvas selectors (rev, note, emptiness).
3. `ui-react` — Canvas toggle + pane (reusing `HtmlArtifactPreviewPanel`
   pointed at the reserved name); badge; blank state; mobile tab; reader ✕
   returns to Canvas mode when it displaced it.
4. `history.js` — `canvas_updated` builds the flagged chat line (with the
   artifact href) plus the `[canvas]` activity line; the portal chat
   renderer skips `canvasUpdate`-flagged lines, the TUI renders them as
   artifact links.
5. Base prompt — the Agent guidance section above, essentially verbatim.
   Version bump; the cron-contracts test pins the version string and must
   move with it.
6. Tests — tool spec sync (the `show-artifact-tool` test shape); guard tests
   (the `artifact-presented` test shape); root-only gating in both halves;
   reducer/persistence round-trip.

Phase 2 — polish:

- `get_session_detail(include: ["canvas"])` for MCP/API callers (meta only:
  rev, note, size — bytes stay on the download path).
- TUI notice line with deep link.
- Regen handoff mentions the canvas.

Phase 3 — only if pulled by real use:

- Revision history (keep last N as `canvas.rev-N.html`).
- Named canvases.
- Any incremental drawing protocol.

---

## Risks

- **The binding size limit is the model's output budget, not the 2 MB
  artifact cap.** The HTML arrives inline in the tool call, LLM-generated:
  300 KB of markup is roughly 75–100K output tokens in one call. Practical
  canvases are tens of KB, which makes whole-replace self-limiting; the 2 MB
  store cap is a distant backstop. `html-visuals` already steers agents away
  from embedded rasters, and `draw_canvas` returns `sizeBytes` so the agent
  sees its own budget.
- **Prompt bloat via read-back.** `read_canvas` pages at 64 KB per call by
  default. The tool description says to read selectively, not to round-trip
  the whole document every turn.
- **Redraw churn.** An over-eager watcher could redraw every cycle and spam
  `canvas_updated`. The event is cheap and the portal swap is flash-free, so
  the cost is mostly event-log noise; the tool description says to draw when
  something material changed, mirroring the summary tool's "do not rewrite
  on no-op cycles" language.
- **Model confusion between show and draw.** Mitigated in both tool
  descriptions and the base prompt; the failure is benign (a preview instead
  of a canvas update, or vice versa) and correctable in-conversation.

## Open questions

- Should `draw_canvas` enforce a soft size warning below the hard 2 MB cap
  (e.g. warn in the tool result above 512 KB)?
- Does the Canvas button live in the inspector tab strip or beside the
  column like the resizer chrome? (Pure placement; decide in implementation
  against the real header.)
- Should the mobile tab appear for a *cleared* canvas (rev > 0, empty
  content)? Leaning no — cleared reads as "nothing to show".
