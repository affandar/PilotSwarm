---
name: html-visuals
description: How to build a visual as a self-contained HTML artifact and open it in the user's portal viewer — the sandbox contract, responsive rules, and the chart/dashboard idioms that survive it.
---

# HTML Visuals

When the user wants to *see* something — a chart, a dashboard, a graph, a
comparison, a timeline, "show me", "visualize this" — build a single
self-contained HTML file, write it as an artifact, and call `show_artifact`.
The portal renders it as a real page and switches the user's reader pane to it
while they watch.

    write_artifact(filename="outage-graph.html", content="<!doctype html>…")
    show_artifact(filename="outage-graph.html")

Include the returned `artifact://` link in your reply too. The live push only
lands if someone is watching; the link works forever.

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
2. **No storage.** `localStorage`, `sessionStorage`, cookies and `parent` all
   throw. Keep state in memory.
3. **Set your own colors.** The frame paints white underneath, so a page that
   sets no `background` is read as black-on-white regardless of the user's
   theme. Always set both on `body`. Dark-on-dark is the usual failure.
4. **Budget.** Artifact uploads cap at 2 MB. A few hundred KB of inlined data
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
- Readable at both a narrow reader pane (~500px) and full width.
- Every number on screen is traceable to the data you were given.
- The header says what it is and what window it covers.
- Nothing loads from the network.
