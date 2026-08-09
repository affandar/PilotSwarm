---
name: html-visuals
description: How to build a self-contained HTML visual for the session canvas or the portal viewer — the sandbox contract, responsive rules, and the chart/dashboard idioms that survive it.
---

# HTML Visuals

When the user wants to *see* something — a chart, a dashboard, a graph, a
comparison, a timeline, "show me", "visualize this" — build a single
self-contained HTML page. This skill is about the PAGE; where it goes is
decided once, per visual:

- **Root session → the canvas.** `draw_canvas(html, note)` puts it on the
  user's screen live. No artifact, no `show_artifact`, no links — the canvas
  updating IS the delivery, and iterating means redrawing it.
- **A keepable file, or no canvas (sub-agents)** → write it as an artifact and
  open the reader:

      write_artifact(filename="outage-graph.html", content="<!doctype html>…")
      show_artifact(filename="outage-graph.html")

  Include the returned `artifact://` link in your reply in this case only —
  the live push lands if someone is watching; the link works forever.

Never send the same visual to both surfaces; one request, one destination.

## Forms: batch the input

Use this whenever you draw a canvas whose job is to COLLECT input: a release
sign-off, a settings sheet, a triage checklist, a survey. The cardinal rule:

**The page is the scratchpad; you are the database. One user intent = one
action.** A 23-item checklist is NOT 23 canvas actions — the user checks,
unchecks, writes comments, changes their mind, and everything stays in page
state. You hear about it exactly once, when they hit Submit.

## The contract shape

Declare one submit action carrying a single `json` field (the whole form
state), plus at most a couple of coarse verbs:

    draw_canvas(html=..., note="release sign-off",
        responseContract={"actions": {
            "submit": {"decision": "string", "form": "json"},
        }})

`json` fields carry one structured object (bounded at 8 KB serialized — a
checklist of dozens of items with comments fits comfortably; do not ship
essays through it).

## The page pattern

- Keep ALL form state in a plain JS object; every checkbox/input writes to it
  locally. Nothing posts until submit.
- Submit gathers and posts once:

      function submit(decision) {
        parent.postMessage({ type: "canvas-action", action: "submit",
          data: { decision, form: { rev: FORM_REV, items: state.items } } }, "*");
        lockForm("Submitted — waiting for confirmation…");
      }

- **Bake a form revision in.** Set `FORM_REV` to the canvas rev you drew (you
  know it from the draw result) and include it in the payload — if you have
  redrawn since, a submit carrying an older rev tells you the user answered a
  stale form; say so and redraw the current one.
- **Lock on submit** (disable inputs, show a submitted banner). Your
  confirmation is the next redraw; the lock is what stops double-submits and
  makes the seconds of latency legible.
- GO/NO-GO style decisions are two buttons calling the same submit with a
  different `decision` — not two actions.
- On receipt, REDRAW showing what you recorded (received N items, decision,
  the follow-ups you are taking). The redraw is the acknowledgement.

## What NOT to do

- No per-keystroke, per-checkbox, or per-row actions. If you feel the urge to
  know intermediate state, you have designed the form wrong.
- No timers or auto-submit — a form posts on an explicit user gesture only.
- Do not redraw while the form is live except in response to a submit; a
  redraw replaces the document and wipes everything typed so far.
- Do not block the session on the form: keep working where possible, and note
  in chat that the canvas is waiting whenever the user may not be looking.
  Hard approval gates stay on `ask_user`.

## Sharing caveat

Only the session's CREATOR can post canvas actions — shared viewers see the
form, but their clicks are refused by the platform (their view of a mutating
canvas may be stale). If the session is shared, say in the page footer who
the form is addressed to, and let others respond in chat.

## Live data updates (update_canvas)

When the canvas's CONTENT changes but its layout does not — dashboards,
tickers, watchers — draw the shell ONCE, then tick with
`update_canvas(data={...})`. The tick reaches the page as a message; the
platform replays the latest tick into any freshly loaded page, so one
idempotent renderer covers live updates and cold loads alike:

    addEventListener("message", (e) => {
      if (e.data?.type === "canvas-data") applyData(e.data.data);
    });
    function applyData(d) { /* render the WHOLE state from d */ }

- Declare `data: { example: {...} }` in the draw contract; after a memory
  gap, re-read it before ticking so your payload shape never drifts.
- Ticks never flip the view and write no chat line; they light the unseen
  badge until the user looks. Cap: 32 KB.
- Layout change → `draw_canvas`. Content change → `update_canvas`. Never
  redraw to refresh numbers.

## Interactive canvases

A canvas can accept structured responses while a user views it live. Declare
the contract on the draw, then wire controls to `parent.postMessage`:

    draw_canvas(html=..., note="order form",
        responseContract={"actions": {"submit": {"qty": "number", "note": "string?"}}})

    <button onclick="parent.postMessage({ type: 'canvas-action',
        action: 'submit', data: { qty: Number(qty.value) } }, '*')">Submit</button>

Rules that make this work:

- The browser enforces YOUR contract: undeclared actions, wrong types, and
  extra fields are dropped before they reach you. No contract on the current
  revision means nothing is accepted — a display-only canvas stays inert.
- Responses arrive as `[canvas-action] {"action":...,"data":...}` user
  messages, hidden from the portal chat. Answer by REDRAWING with the result
  baked in — the canvas is both the form and the reply.
- Echo input optimistically in the page (append the row, disable the button);
  your redraw arrives seconds later and replaces the document.
- The sandbox has no `allow-forms`: wire click/keydown handlers, never rely on
  real form submission. Enter-to-submit = a keydown listener on the input.
- **Text inputs: `font-size: 16px` minimum.** iOS Safari zooms the whole
  viewport when a smaller input is focused and never zooms back — the page
  comes out cropped and panned after every comment box.
- A page taller than the viewport scrolls in the browser's own scroller —
  set nothing that traps it (`overflow: hidden` on body kills mobile scroll;
  `touch-action` overrides eat pans). Let the default body scroll work.
- Do not redraw a canvas that carries input fields except in response to an
  action — a spontaneous redraw wipes drafts mid-typing.
- Controls only function while someone is watching the portal. Never block on
  a canvas click; chat is the fallback and approval gates stay on ask_user.

Prefer this over pasting a Markdown table when the answer is *shape* —
proportion, trend, flow, overlap, ranking across many rows. Prefer a Markdown
table when the answer is a handful of exact values. A table of 8 numbers does
not need a chart; 200 rows of "who is waiting on what" does.

## The sandbox contract

The page runs in an iframe with `allow-scripts` and **no** `allow-same-origin`.
Your script runs; it just has no world outside the document. Violating any of
these produces a blank or broken page, not an error message:

1. **Self-contained. No network of any kind.** No CDN `<script>` or `<link>`,
   no web fonts, no remote images, no `fetch`. Inline every byte: CSS in
   `<style>`, JS in `<script>`, data in a JS literal, images as `data:` URIs.
   If you need a charting library you cannot inline, hand-write the SVG.
2. **No storage.** `localStorage`, `sessionStorage`, cookies and `parent` property reads all
   throw — `parent.postMessage` is the one allowed call. Keep state in memory.
2b. **Sound: unlock on `touchend`/`click` — never only `touchstart`.** Three
   silent failures, none of which raise an error:
   - `touchstart` does NOT grant user activation (spec: only `touchend`,
     `click`, `keydown`, `mousedown` do), so an AudioContext created or
     resumed there stays suspended on iOS forever — and calling
     `preventDefault()` in `touchstart` also suppresses the synthetic
     `click`, so a page that binds game controls with
     `touchstart`+`preventDefault` never runs a working unlock at all. This
     is why a game sounds fine on desktop and is mute on every phone. Bind
     the unlock to `touchend` (or an un-prevented `click`) as well:
     `el.addEventListener("touchend", unlock)` alongside the touchstart
     game-input handler.
   - Autoplay policy suspends a context created at load. In the unlock, do
     `ctx = ctx || new AudioContext(); ctx.resume()`, keep one context for
     the page's life, and synthesize with oscillators (no files).
   - **iOS mutes Web Audio when the ring/silent switch is on.** In the same
     unlock, run
     `if (navigator.audioSession) navigator.audioSession.type = "playback";`
     (Safari 16.4+; guard it — the API does not exist elsewhere).
   Say so in the page's own UI ("sound needs the ring switch on" beside the
   mute toggle); the user cannot debug what the page never mentions.
2c. **On the session canvas, resizes reflow — they never reload.** The
   canvas never reloads your page for a container resize, so in-memory state
   (game progress, form drafts) survives window drags and rotations there.
   The page's inner window gets real `resize` events; if you draw to a
   `<canvas>` at pixel sizes or measure the viewport once at boot, add a
   resize listener that recomputes — CSS layouts need nothing. The artifact
   READER pane (show_artifact) is different: it reloads when its width
   settles — stateful pages belong on the session canvas.

3. **Set your own colors — on `html`, not only `body`.** iOS extends the
   `html` background into rubber-band overscroll; a body-only background ends
   at the document edge and the bounce reveals whatever sits beneath. Set
   `background` and `color` once on `html, body`. Add
   `html { overscroll-behavior: none }` if the bounce itself is unwanted.
   Dark-on-dark is the usual failure; check both.
4. **Budget.** The canvas caps at 900 KB; text artifacts cap at 1 MiB. A few hundred KB of inlined data
   is fine and normal; a multi-megabyte dump is not — aggregate first.

Links to the outside world are fine (`<a href="https://…" target="_blank">`) —
popups are allowed.

## Responsive, and why it matters here

The reader pane is resizable, and the user *will* resize it. The viewer reloads
the frame once the width settles, so a document that computes its layout only
at load does get corrected — but the reload costs the reader their scroll
position. Layout that reflows on its own never pays that.

- Lay out with CSS grid/flex and `minmax()`, not fixed pixel columns.
- Give every `<svg>` a `viewBox` and `width:100%`, so it scales without script.
- If you must compute geometry in JS (Sankey flows, force layouts, anything
  where positions depend on measured width), add a `resize` listener that
  re-runs the layout. Debounce it.
- Never bake the viewport width into a constant at load time.

## Dashboard shape

A dashboard that reads well is almost always the same three bands:

1. **Header** — what this is, what window it covers, where the data came from.
   Someone opening it a week later must not have to ask.
2. **KPI row** — 4–9 tiles, one number each, in
   `grid-template-columns: repeat(auto-fit, minmax(150px, 1fr))` so it reflows.
   Big value, small uppercase label under it. Color only where it *means*
   something (bad = red, good = green); a rainbow of tiles means nothing.
3. **Sections** — one question per card, with a one-line note under the
   heading saying how to read the picture. Charts do not explain themselves.

## Picking the form

| The question | The form |
|---|---|
| How much, across categories | Horizontal bars, sorted by value |
| How it changed over time | Line; area only if the total matters |
| What flows to what | Sankey / chord, nodes in fixed columns |
| How two measures relate | Scatter, with the outliers labelled |
| Where the mass sits | Histogram or box plot, not an average |
| Exact values, few rows | A table. Not a chart. |

Avoid pie charts beyond three slices, dual y-axes, and 3-D anything.

## Color and legibility

- Encode with position and length first; color is for *categories* and
  *status*, not decoration.
- Keep a small named palette in `:root` and reuse it. Semantic colors
  (`--bad`, `--ok`, `--warn`) must mean the same thing in every section.
- Body text at 13–14px minimum, axis labels no smaller than 11px.
- Never rely on color alone: pair it with a label, shape, or ordering, or a
  red/green reader learns nothing.
- Long category names: truncate with `text-overflow: ellipsis` and put the full
  string in a `<title>` so hover reveals it.

## Interaction

Hover tooltips are worth the code — they are how a dense chart stays readable
without labelling every mark. Keep them cheap: one absolutely-positioned div,
moved on `mousemove`, hidden on `mouseleave`. Skip zoom, pan, and filtering
unless asked; they add a lot of script for something the user did not request.

## Self-check before you show it

- Opens with no console errors and no blank regions.
- **If the page has a start/pause state machine, its initial state must be
  VISIBLE and reachable.** A Start overlay that is `display:none` with nothing
  adding its show-class renders as a frozen page: the board paints once,
  `running` stays false, and every input handler that guards on it silently
  ignores the user. Trace the path from first paint to running with no
  keyboard — touch only.
- Readable at both a narrow reader pane (~500px) and full width.
- Every number on screen is traceable to the data you were given.
- The header says what it is and what window it covers.
- Nothing loads from the network.

## Reusable canvas apps

A canvas worth drawing twice is an app: save it once, redraw it from the store
forever, and never courier the bytes through your own context again.

1. **Self-describe from the first draw.** Put one comment immediately after
   `<!doctype html>`:

   ```html
   <!-- CANVAS-APP-MANIFEST
   { "manifestVersion": 1, "name": "release-signoff", "version": "1.0.0",
     "description": "23-item release checklist; batches checks into one submit.",
     "responseContract": { "actions": { "submit_signoff": { "items": "json", "note": "string?" } } },
     "data": "{items:[{id,state}]} — full replacement, <=32KB",
     "notes": "Send update_canvas ticks to pre-check items; page posts one submit." }
   -->
   ```

   The contract uses the exact draw_canvas grammar; a broken embedded contract
   makes later fromArtifact draws FAIL CLOSED, so keep it valid.

2. **Save = server-side copy, never a re-emit:**
   `write_artifact({fromArtifact: {filename: "canvas.html"}, filename: "apps/<name>.html"})` — the source defaults to this session.

3. **Load = draw_canvas({fromArtifact: {sessionId?, filename}}).** The bytes go
   store→canvas; your tool result is the interface card — manifest summary plus
   the EFFECTIVE responseContract — which is everything needed to interpret
   `[canvas-action]` messages and author update_canvas ticks. NEVER
   read_artifact + draw_canvas(html: <same text>): that is the token-courier
   anti-pattern this mechanism exists to kill.

4. **Re-learn cheaply.** Browsing candidates: `read_artifact({sessionId, filename, manifestOnly: true})`.
   After context regeneration or on an inherited canvas:
   `read_canvas({manifestOnly: true})` returns the card plus the armed contract.
