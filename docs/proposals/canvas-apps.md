# Canvas Apps: reusable canvas documents as artifacts and package content

Status: Phase 1 IMPLEMENTED 2026-08-08 (fromArtifact draws, manifest, interface card, manifestOnly reads); phases 2–3 open
Author: design session 2026-08-08
Depends on: session canvas v1 (shipped), interactive canvas contracts (shipped),
agent packages v1 (shipped), `write_artifact` fromArtifact copy path (shipped)

## 1. Problem

A canvas document is currently born and dies inside one session's chat loop.
Three costs follow:

1. **Token courier tax.** Rendering a previously-stored HTML artifact onto the
   canvas requires `read_artifact` (bytes → model context) followed by
   `draw_canvas(html: <same bytes>)` (context → tool argument). For a 17 KB
   game that is ~10K tokens of pure copying per reuse, and the model can
   corrupt what it copies. `write_artifact` already solved the identical
   problem for artifact→artifact with a server-side `fromArtifact` source;
   artifact→canvas has no equivalent.
2. **The contract is trapped in the conversation.** `responseContract` (what
   an interactive canvas may post back) exists only as a tool argument at draw
   time. A stored HTML file carries no machine-readable statement of its
   inputs (update_canvas tick shape) or outputs (actions), so a later LLM
   must read and reason about the whole script to redraw it correctly.
3. **Apps cannot ship with agents.** An agent package can carry skills and
   prompt files but not a canvas UI. An agent whose job benefits from a
   purpose-built dashboard/form/game has to regenerate it from prose every
   time, with drift on every regeneration.

Goal: an agent can **save** a canvas app once (HTML + embedded contract),
**reuse** it from any session it can read, and **ship** it inside an agent
package where the agent knows which app to load and when — with the model
never couriering the bytes.

## 2. Design at a glance

| Piece | Decision |
|---|---|
| Render from store | `draw_canvas(fromArtifact: {sessionId?, filename, expectedSha256?})`, mutually exclusive with `html`, resolved in the bridge server-side |
| Self-description | One `<!-- CANVAS-APP-MANIFEST {json} -->` comment after `<!doctype html>`; extracted server-side; `manifestOnly` read surface |
| Contract precedence | explicit `responseContract` arg → embedded manifest contract → none; always re-validated by `normalizeCanvasResponseContract` at draw time |
| Saving | no new tool — `write_artifact(fromArtifact: {sessionId: self, filename: "canvas.html"}, filename: "apps/foo.html")` is already a server-side save-as; the skill teaches the recipe |
| Packages | optional `canvas/*.html` files declared in the package manifest, validated at publish, rendered via `draw_canvas(fromPackage: {path})`, advertised to the agent in a generated prompt section |
| Authz | source readability = the worker-trusted artifact layer, same as read_artifact/write_artifact (no per-session gate); creator-only action posting entirely unchanged |

## 3. `draw_canvas(fromArtifact)` — server-side artifact→canvas

### Tool schema

```jsonc
draw_canvas({
  // EXACTLY ONE of:
  html?: string,                  // existing inline path, unchanged
  fromArtifact?: {                // NEW: server-side pull
    sessionId?: string,           // defaults to the calling session
    filename: string,
    expectedSha256?: string,      // precondition; mismatch → SHA_MISMATCH error, no draw
  },
  fromPackage?: {                 // NEW, phase 3: see §6
    path: string,                 // e.g. "canvas/triage-board.html"
    version?: string,             // default: the session's pinned package version
  },

  note?: string,
  responseContract?: object,      // still accepted; see precedence below
})
```

Deliberately mirrors `write_artifact`'s `fromArtifact` shape (`sessionId`,
`filename`, `expectedSha256`) so there is one source grammar to learn and one
authz rule to maintain.

### Resolution (bridge, not model)

`session-proxy.drawCanvas` grows a resolution step ahead of the existing
pipeline:

1. Source access follows the platform's artifact stance exactly: the artifact
   layer is worker-trusted, and `read_artifact`/`write_artifact` already read
   and copy across sessions without a per-session ownership gate. fromArtifact
   deliberately introduces no new policy — the drawing agent vouches for what
   it draws, transport aside (see §5).
2. Fetch bytes from the artifact store; enforce the same 900 KB cap the
   inline path enforces (the store's TEXT cap is 1 MiB; refuse early with the
   existing clear message). Any text artifact is accepted (the store refuses binaries).
3. `expectedSha256` precondition if provided.
4. Extract the embedded manifest (§4) if present.
5. Resolve the contract (precedence in §4), then enter the **unchanged**
   draw pipeline: rev bump, pinned `canvas.html` write, durable
   `session.canvas_updated` event, EPHEMERAL re-persist skip, portal flip.

The event data additionally records provenance:

```jsonc
{ rev, note, responseContract,
  source: { kind: "artifact", sessionId, filename, sha256 } }   // NEW
```

The activity feed line becomes `[canvas] rev N from triage-board.html` —
distinguishable from an inline draw, same non-hacky event-data
pattern the tick/redraw split already uses.

### The tool result is the interface card

The drawing agent must learn the app's interface WITHOUT reading the file —
otherwise the mechanism defeats itself. The server already extracts and
validates the manifest during resolution, so `draw_canvas` returns it in the
tool result (every source, including inline):

```jsonc
{ "rev": 14,
  "source": { "kind": "artifact", "sessionId": "…", "filename": "apps/release-signoff.html", "sha256": "…" },
  "app": {                                  // from the embedded manifest, absent if none
    "name": "release-signoff", "version": "1.2.0",
    "description": "23-item release checklist; batches all checks into one submit.",
    "data": "{items: [{id, state}]} — full replacement, ≤32KB",
    "notes": "Send update_canvas ticks to pre-check items; page posts one submit."
  },
  "responseContract": { "actions": { "submit_signoff": { "items": "json", "note": "string?" } } }
}
```

`responseContract` here is the **effective** contract — post-precedence,
post-normalization, exactly what the browser will enforce — not whatever
string happened to sit in the file. The agent stores this card in context
(a few hundred tokens, bounded by the existing 4 KB contract cap plus a ~1 KB
cap on the extracted description/data/notes) and can now interpret every
later `[canvas-action] {…}` message and author correct `update_canvas` ticks.
The HTML itself is never returned.

Two adjacent channels close the loop:

- **Action messages are self-labeling.** A post arrives as
  `[canvas-action] {"action": "submit_signoff", "values": …}` — paired with
  the stored card, the agent needs nothing else.
- **`read_canvas(manifestOnly: true)`** re-fetches just the card later —
  for a compacted context, a regenerated session, or an agent that inherited
  a canvas it did not draw. Same option name as `read_artifact`'s, same
  extractor, so the "learn the interface cheaply" grammar is identical
  everywhere.

`update_canvas` ticks work identically against an app drawn from an artifact
(the manifest documents the tick shape but the mechanism is untouched).

### Failure modes (all tool-level errors, no partial draw)

missing artifact · unreadable source session · binary/oversized content ·
SHA mismatch · manifest present but invalid contract (see precedence — an
explicit arg can still save the draw; an invalid embedded contract with no
explicit arg fails closed rather than drawing an interactive page whose
actions silently dead-end).

## 4. Self-describing apps: `CANVAS-APP-MANIFEST`

A canvas app is a normal single-file HTML document whose **first HTML
comment** (within the first 4 KB, immediately after `<!doctype html>` by
convention) is:

```html
<!doctype html>
<!-- CANVAS-APP-MANIFEST
{
  "manifestVersion": 1,
  "name": "release-signoff",
  "version": "1.2.0",
  "description": "23-item release checklist; batches all checks into one submit.",
  "responseContract": { "actions": { "submit_signoff": { "items": "json", "note": "string?" } } },
  "data": "tick = {items: [{id, state}]} — full replacement, ≤32KB",
  "notes": "Send update_canvas ticks to pre-check items; page posts one submit."
}
-->
```

- `responseContract` is the **same grammar** the tool argument uses today
  (16 actions / 16 fields / 4 KB, `"?"` optional, string|number|boolean|json)
  and passes through the same `normalizeCanvasResponseContract`. One grammar,
  one validator, both call sites.
- `data` and `notes` are documentation for the *loading LLM*, not enforced.
- Extraction is a small shared SDK util (`extractCanvasAppManifest(html)`)
  used by the draw path, publish validation (§6), and the read surface below.

**Contract precedence at draw time:** explicit `responseContract` argument
wins; otherwise the embedded manifest's contract; otherwise no contract
(actions disabled, exactly today's default-closed behavior). The browser-side
validation, provenance checks, rate limiter, and creator-only posting are
all downstream of the draw event and don't change at all.

**Cheap discovery:** `read_artifact` gains `manifestOnly: true`, returning
just the parsed manifest (or "none") — for browsing candidate apps BEFORE
drawing. (After a draw, the tool result already delivered the effective card;
`read_canvas(manifestOnly: true)` re-fetches it later. Three surfaces, one
extractor, one option name.) The MCP/web `get_artifact` op gains
`include: ["manifest"]` for parity so the portal and operators can see it.

**Saving an app** needs no new tool. The skill teaches the loop:

```
1. draw_canvas(html: ...)                     — build and iterate live
2. write_artifact(fromArtifact: {sessionId: <self>, filename: "canvas.html"},
                  filename: "apps/release-signoff.html")   — server-side save-as
3. later, anywhere readable:
   draw_canvas(fromArtifact: {sessionId: <that session>, filename: "apps/release-signoff.html"})
```

`html-visuals` gains a short **Reusable apps** section: embed the manifest
comment from the first draw; save via the copy recipe; load via fromArtifact;
never round-trip bytes through your own context (`read_artifact` →
`draw_canvas(html)` is explicitly called out as the anti-pattern).

## 5. Trust model (unchanged where it matters)

- **Who can post actions:** only the session creator, enforced fail-closed in
  the web runtime — rendering someone else's stored app does not widen this
  by a single principal. The contract only ever *narrows* what a post may
  look like.
- **Who vouches for the app:** the drawing agent. Drawing a stored app is the
  same trust act as emitting the same HTML inline; `fromArtifact` changes the
  transport, not the trust. A hostile stored app can at worst render UI that
  tricks *the creator* into clicking actions the contract allows — identical
  exposure to today's inline draw, and the reason contract validation stays
  browser-side and default-closed.
- **Cross-session reads** ride the existing worker-trusted artifact layer —
  the same trust the read_artifact/write_artifact tools already extend to
  every session. No new sharing surface and no new policy; if a per-session
  artifact authz gate ever lands, all three fromArtifact consumers inherit it
  at the store boundary together.
- **Package apps** (below) are readable by whoever can run the package —
  consistent with the BYOA trusted-system stance: installing a package is the
  trust decision; its canvas UI is part of what was trusted.

## 6. Canvas apps in agent packages (phase 3)

### Package shape

```
my-agent/
  agent.md
  skills/...
  canvas/
    triage-board.html        # each with an embedded CANVAS-APP-MANIFEST
    release-signoff.html
```

The package manifest gains an optional section (explicit, not inferred — the
publish step should fail loudly, not guess):

```jsonc
"canvasApps": [
  { "path": "canvas/triage-board.html" },
  { "path": "canvas/release-signoff.html" }
]
```

### Publish-time validation

For each declared app: file exists, ≤900 KB, manifest comment present and
parseable, `manifestVersion` known, contract passes
`normalizeCanvasResponseContract`. Bad app → publish fails with the file and
reason. This keeps every runtime path working with already-validated bytes,
and the artifact-store normalization (content-addressed) means shipping the
same app in ten versions costs one blob.

### Rendering: `fromPackage`, not per-session copies

`draw_canvas(fromPackage: {path, version?})` resolves against the **calling
session's pinned package version** by default — deterministic bytes with no
sha bookkeeping (the store is content-addressed at publish). No artifacts are
materialized into sessions; nothing to garbage-collect; `list_artifacts`
stays an honest list of what the session itself produced. Provenance in the
draw event: `source: {kind: "package", package, version, path, sha256}`.

### The agent knows what it has

At session bootstrap, packages with `canvasApps` get a generated prompt
section (same mechanism as the generated tools list — and the same gotcha:
it must be wired in the declaration filter AND the prompt builder, the
two-place pattern):

```
## Canvas apps
- triage-board (canvas/triage-board.html): live incident triage board;
  update_canvas tick = full row set. Draw with
  draw_canvas(fromPackage: {path: "canvas/triage-board.html"}).
- release-signoff (canvas/release-signoff.html): 23-item checklist, one
  batched submit action.
```

Name and description come from the validated manifests, so the section costs
a few dozen tokens and cannot drift from the bytes. The *when* lives in the
description; the agent decides, as with skills.

Agent Manager surfacing: package detail lists canvas apps (name, description,
size) read from the validated manifest — no new storage, it re-parses the
published file via `get_agent_package_file`.

## 7. What is deliberately NOT in scope

- **A canvas app registry/marketplace.** Packages are the distribution unit;
  a separate registry would duplicate scope/versioning/authz for no new power.
- **Multi-file apps.** One HTML file, self-contained, same as the canvas
  itself. Bundling is the author's problem (and the sandbox blocks external
  fetches anyway).
- **Contract enforcement server-side.** Validation stays browser-side and
  default-closed; the server records, the client refuses. Unchanged.
- **Auto-drawing on session start.** An agent *may* draw its app in turn 1 if
  its prompt says so; the platform does not add implicit draws.

## 8. Rollout

**Phase 1 — fromArtifact + manifest (SDK only, one worker roll).**
Tool schema (mutual exclusivity), bridge resolution + authz reuse, manifest
extractor, contract precedence, interface-card tool result (effective
contract, never the bytes), provenance in event + activity line,
`read_artifact` / `read_canvas` `manifestOnly`, skill section. Tests: schema exclusivity;
sha mismatch; contract precedence (arg beats
manifest beats none; invalid manifest + no arg fails closed); tool result
carries the effective contract and never the html; 900 KB cap;
rev/EPHEMERAL pins unchanged; manifest extractor fuzz (no comment, comment
late in file, malformed JSON, oversized).

**Phase 2 — surfaces.** `get_artifact include:["manifest"]` on web/MCP;
portal Files tab badges manifest-bearing HTML artifacts and (creator-only)
offers "draw on canvas" — a convenience wrapper over the same op.

**Phase 3 — packages.** Manifest section + publish validation, `fromPackage`
resolution, generated prompt section (two-place wiring), Agent Manager
package-detail listing. Tests: publish rejection cases; version pinning;
prompt-section generation; root-gating parity with the other canvas tools.

Each phase is independently shippable and back-compatible: existing canvases,
pinned `canvas.html` artifacts, and manifest-less HTML artifacts keep working
untouched; `tetris-game.html`-style artifacts gain a manifest the next time
their author redraws.

## 9. Open questions

1. If a per-session artifact authz gate ever lands at the store boundary,
   all three fromArtifact consumers inherit it together (v1 is worker-trusted
   throughout, matching read_artifact/write_artifact).
2. Does `update_canvas` need a `fromArtifact` analog for large data loads?
   Current stance: no — ticks are ≤32 KB by design; big data belongs in the
   app's next full draw.
3. Package app size budget: is 900 KB per app acceptable inside packages, or
   should publish warn above ~256 KB to keep install payloads lean?
