# Session Canvas

The canvas is a root session's standing visual surface: one live HTML document
per session that the agent draws, updates in place, and reuses — rendered in
the portal beside the chat, surviving reloads, context regeneration, and
worker moves. It replaced the retired session-summary mechanism as the
at-a-glance answer to "what is this session showing me?"

This is the as-built reference. Design history lives in
[proposals/session-canvas.md](../proposals/session-canvas.md) (v1) and
[proposals/canvas-apps.md](../proposals/canvas-apps.md) (reusable apps;
phases 2–3 there are designed but unshipped).

## The spine: one artifact, one event stream

A drawn canvas is exactly two durable facts:

1. **Bytes** — the reserved, always-pinned artifact `canvas.html` on the
   session. Every draw replaces it wholesale (there is no patching of the
   document; in-place *data* updates ride ticks, below).
2. **A `session.canvas_updated` event** carrying `{rev, sizeBytes, note?,
   responseContract?, source?}`. `rev` is monotonic, derived from the latest
   events at draw time. The event is the single authority: bytes without an
   event (a crashed half-draw, a hand-uploaded canvas.html) read as "not
   drawn".

Ordering is bytes-then-event, awaited, inside a per-session serialized draw
chain in the session proxy — a rev is only ever advertised after both halves
exist. The bridge records the event itself; the generic event persister lists
canvas event types as already-persisted so no path can double-insert. Rev
derivation reads fail loud: a transient catalog error fails the draw rather
than reading as "no canvas" (which would mint rev 1 over a live canvas).

Clients — portal, TUI — learn revisions from the same event they'd learn
anything else from: live push and cold snapshot alike, no side channel. The
portal keeps per-session canvas prefs (last viewed rev/dataRev, opt-outs)
merged max-wins across devices.

## Tools

All three are declared on **root sessions only** (see Gating).

### `draw_canvas`

Exactly one source per call:

- `html` — the complete document inline. Empty string clears the canvas
  (a clear drops any contract; a blank page accepts nothing).
- `fromArtifact: {filename, sessionId?, expectedSha256?}` — render a stored
  HTML artifact **server-side**: bytes move store→canvas and never enter the
  model's context. `sessionId` defaults to the calling session. The sha
  precondition refuses without drawing on mismatch. Provenance
  (`source: {kind, sessionId, filename, sha256}`) rides the event and the
  activity feed line (`[canvas] rev N from <file>`).

Optional on either source: `note` (revision caption) and `responseContract`
(interactivity, below).

**The tool result is the interface card** — rev, size, source, the embedded
manifest summary, and the *effective* contract (post-precedence,
post-normalization: exactly what the browser will enforce). Never the HTML.
This is how an agent that drew a stored app without reading it can interpret
incoming actions and author ticks.

### `update_canvas`

A JSON data tick: `{data, note?}` → a durable `session.canvas_data` event
(payload inline, ≤32 KB serialized, monotonic `dataRev`). The page receives
`{type: "canvas-data", data, dataRev}` via postMessage and applies it with an
idempotent `applyData(data)`; the platform replays the latest tick into any
freshly loaded page. Ticks never steal the screen and write no chat line, but
they do mark the canvas unseen (the toggle badges). Ticks against a
never-drawn canvas are refused. Layout change = redraw; content change = tick.

### `read_canvas`

Paged text (`offset`/`maxBytes`) — or `manifestOnly: true` for the interface
card without the bytes: the embedded manifest summary plus the **armed**
contract from the latest draw event (re-validated on the way out). This is the
re-learning path after context regeneration or for an agent that inherited a
canvas it did not draw.

## Interactivity: the response contract

A canvas becomes interactive when the draw carries a `responseContract`:

```jsonc
{ "actions": { "<name>": { "<field>": "string|number|boolean|json" } },  // "?" suffix = optional
  "data": { "example": { } } }   // optional, documents the tick shape (≤1 KB)
```

Caps: 16 actions × 16 fields, 4 KB serialized. The `data` key survives
normalization deliberately — it is what makes "re-read the contract before
ticking so your payload never drifts" a real loop.

The page posts `parent.postMessage({type: "canvas-action", action, data}, "*")`.
The browser then enforces, in order:

1. **Provenance** — the message's source window must be the *live* canvas
   iframe's contentWindow. Staging frames, artifact previews, popups, and
   every other window fail the identity test.
2. **Contract validation, default-closed** — no contract means nothing is
   accepted; unknown actions/fields, wrong types, oversized payloads (8 KB
   serialized, 2048-char strings) are refused. Validation never throws, even
   on structured-clone-legal garbage (cycles, BigInt).
3. **Rate limit** — burst 3 per 3 s per session.
4. **Creator-only, fail-closed** — the server accepts a canvas action only
   from the session creator (`viewerIsOwner`); shared writers and admins are
   refused, and a missing/unloaded snapshot refuses. The client mirrors the
   check for UX; the server is authoritative. Rationale: shared viewers see a
   UI whose state may have mutated — only the creator's view is known to
   correspond to what the agent drew.

Conforming actions arrive as user messages
`[canvas-action] {"action": ..., "data": ...}` — self-labeling, hidden from
the portal chat pane (the redraw is the visible half of the loop), visible to
the agent, and excluded from auto-titling. Agents answer on the canvas, not
in chat.

## Canvas apps: save and reuse

A canvas worth drawing twice is an app. Convention: one comment immediately
after `<!doctype html>` —

```html
<!-- CANVAS-APP-MANIFEST
{ "manifestVersion": 1, "name": "...", "version": "...", "description": "...",
  "responseContract": { "actions": { ... } },
  "data": "tick shape notes", "notes": "usage notes" }
-->
```

- Only a comment that **opens** with the marker is a manifest — prose or
  script text mentioning the convention is ignored, and a broken manifest is
  distinguishable from an absent one.
- The embedded contract passes the **same normalizer** as the tool argument.
  Precedence at draw time: explicit `responseContract` argument → manifest
  contract → none. An invalid embedded contract fails a `fromArtifact` draw
  closed; an inline draw tolerates a broken manifest but warns in the result.
- Prose fields clamp at 400 chars (surrogate-safe) so cards stay cheap.

The lifecycle, with no byte ever entering model context:

```
draw_canvas(html: ...)                                  # build live, manifest embedded
write_artifact({fromArtifact: {filename: "canvas.html"},
                filename: "apps/<name>.html"})          # server-side save-as
read_artifact({sessionId, filename, manifestOnly: true})  # browse candidates
draw_canvas({fromArtifact: {filename: "apps/<name>.html"}})  # reuse; result = interface card
```

Cross-session sources ride the platform's worker-trusted artifact layer, the
same trust `read_artifact`/`write_artifact` already extend — the drawing
agent vouches for what it draws. Package-shipped apps (`fromPackage`) and
portal browse affordances are designed but unshipped (canvas-apps.md
phases 2–3).

## Presentation

The portal renders the canvas in a sandboxed iframe
(`allow-scripts allow-popups allow-popups-to-escape-sandbox`, no
`allow-same-origin`, `allow="autoplay *"` — an opaque origin can never match
the default `'src'` allowlist). New revisions load through a visible
under-stack double buffer and promote by z-order only, so a redraw never
white-flashes and iOS registers the frame for touch scrolling. Frames are
kept alive off-screen (transform-parked, `inert`) to preserve page state
across toggles.

**Resizes reflow; they never reload.** A page that loaded at a real size owns
its layout — the inner window receives genuine resize events. The only
automatic reload rescues documents that loaded against a degenerate box (the
iframe's intrinsic default before layout). In-memory state — game progress,
form drafts — survives window drags and rotations. (The artifact *reader*
pane is different: it reloads on width settles; stateful pages belong on the
canvas.)

Viewed-marking comes only from the frame's own promote receipt while visible
— never from mode transitions — so the unseen badge (draws and ticks both
set it) means what it says.

## Gating and limits

- **Root sessions only, gated in two places**: declarations are filtered in
  session-manager off the catalog row's `parentSessionId` (the authority);
  handlers are registered everywhere and refuse with a clear message when the
  bridge lacks the method — the worst residual case is an error, never a
  hang. Children — including the system agents, which are children of the
  PilotSwarm root — have no canvas and no canvas tools; their delivery path
  is `write_artifact` + `show_artifact`.
- **Caps**: document ≤900 KB (store text cap is 1 MiB); ticks ≤32 KB;
  contract 16×16 fields / 4 KB (+1 KB `data`); action payloads ≤8 KB with
  2048-char strings; card prose 400 chars/field.
- **Authoring rules** (enforced by the sandbox, taught by the `html-visuals`
  skill): fully self-contained, no network, no storage; `parent` property
  reads throw — `parent.postMessage` is the one allowed call; colors on
  `html, body`; 16 px+ inputs; audio unlocks on `touchend`/`click` (never
  `touchstart` alone) plus `navigator.audioSession = "playback"` where
  available.
