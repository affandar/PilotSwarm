/**
 * The canvas tools' wiring contract — every quiet failure mode pinned.
 *
 * The model as of multi-canvas: EVERY session has the tools — root,
 * sub-agent, sub-sub-agent — and each draws only its OWN canvases, up to five
 * slots (canvas.html, canvas2..canvas5), each slot with its own revision
 * sequence and an agent-chosen name. There is no root gate any more:
 *
 *   - DECLARATIONS ride sessionConfig.tools for every session.
 *   - HANDLERS are registered every turn and refuse with a clear message when
 *     the bridge is absent (direct mode) — a refusal, never a hang.
 *   - The BRIDGE persists the canvas_updated event itself, awaited, inside a
 *     serialized derive→write→record section, and the generic event persister
 *     lists canvas_updated as already-persisted. One delivery path.
 *   - Revs come from the session_canvases table first (migration 0045), with
 *     a slot-filtered 30-event scan as the durable fallback.
 *
 * Run: node --test test/unit/canvas-tools.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ManagedSession } from "../../dist/managed-session.js";
import { CANVAS_ARTIFACT_FILENAME } from "../../dist/session-proxy.js";

const MS = readFileSync(fileURLToPath(new URL("../../src/managed-session.ts", import.meta.url)), "utf8");
const SP = readFileSync(fileURLToPath(new URL("../../src/session-proxy.ts", import.meta.url)), "utf8");
const SM = readFileSync(fileURLToPath(new URL("../../src/session-manager.ts", import.meta.url)), "utf8");

function declaredTool(name) {
    return ManagedSession.systemToolDefs().find((tool) => tool.name === name) || null;
}

test("both canvas tools are declared to the model", () => {
    const draw = declaredTool("draw_canvas");
    assert.ok(draw, "draw_canvas missing from systemToolDefs()");
    // html is no longer hard-required — fromArtifact is the alternate source
    // and the handler enforces exactly-one (schema XOR is not model-reliable).
    assert.deepEqual(draw.parameters.required, []);
    assert.match(draw.description, /slot 1-5/i, "the model learns about slots from the description");
    assert.match(draw.description, /friendly name/i);
    assert.match(draw.description, /do not paste canvas links/i);
    assert.ok(draw.parameters.properties.slot, "slot param missing");
    assert.ok(draw.parameters.properties.name, "name param missing");

    const read = declaredTool("read_canvas");
    assert.ok(read, "read_canvas missing from systemToolDefs()");
    assert.deepEqual(Object.keys(read.parameters.properties).sort(), ["manifestOnly", "maxBytes", "offset", "slot"]);
});

test("declaration and handler share one spec object, both tools", () => {
    for (const spec of ["DRAW_CANVAS_TOOL_SPEC", "READ_CANVAS_TOOL_SPEC"]) {
        const uses = MS.match(new RegExp(`\\.\\.\\.${spec}|defineTool\\("[a-z_]+", ${spec}\\)`, "g")) || [];
        assert.equal(uses.length, 2, `${spec} must feed both the declaration and the handler`);
    }
});

test("sub-agents are NOT filtered out of the canvas declarations", () => {
    // The root gate is gone by design: children draw their own canvases. The
    // old filter silently un-declaring the tools for child sessions must not
    // return — a child that cannot see the tools cannot draw.
    assert.ok(!/canvasToolNames/.test(SM), "the child declaration filter must stay deleted");
    assert.ok(!/!isChildSession \|\| !canvasToolNames/.test(SM));
});

test("the HANDLER half is registered on every session and refuses instead of hanging", () => {
    // Per-turn registration is unconditional — a declared tool with no
    // handler is a silent drop in the CLI. The refusal is the guard.
    assert.match(MS, /drawCanvasTool,\n\s*updateCanvasTool,\n\s*readCanvasTool,\n\s*showCanvasTool,\n\s*\]\.filter/,
        "canvas tools must be unconditionally in systemToolsForTurn");
    assert.ok(!/\(controlBridge as any\)\?\.drawCanvas \? \[drawCanvasTool/.test(MS),
        "the old bridge-conditional registration must be gone");
    // The refusal names the real condition (no bridge), not a root-only rule
    // that no longer exists.
    assert.match(MS, /the canvas bridge is unavailable on this session/);
    assert.ok(!/only available on root sessions/.test(MS), "root-only wording must be gone");
});

test("the bridge carries the canvas methods for every session", () => {
    // The root gate is deleted on both of its old layers: the spread that
    // withheld the methods from children, and the in-body catalog re-check.
    assert.ok(!/input\.parentSessionId \? \{\} : \{\s*\n\s*drawCanvas/.test(SP),
        "the parent-gated spread must stay deleted");
    assert.ok(!/the canvas is only available on root sessions/.test(SP),
        "the in-body root refusal must stay deleted");
    // Slot validation is the new front door.
    assert.match(SP, /slot must be an integer 1-5/);
    assert.match(SP, /canvasArtifactFilename\(slot\)/);
});

test("draw is atomic: derive→write→record in one awaited, serialized section", () => {
    const block = SP.slice(SP.indexOf("drawCanvas: async"), SP.indexOf("readCanvas: async"));
    const uploadAt = block.indexOf("await artifactStore.uploadArtifact");
    const recordAt = block.indexOf("await catalog.recordEvents");
    assert.ok(uploadAt >= 0 && recordAt >= 0, "bridge must both write bytes and record the event");
    assert.ok(uploadAt < recordAt, "bytes before the event — a failed write must never advertise a rev");
    assert.match(SP, /let canvasDrawChain: Promise<void> = Promise\.resolve\(\)/,
        "parallel same-turn draws must serialize, or they mint duplicate revs");
    assert.match(block, /canvasDrawChain\.then/);
});

test("exactly one persistence path: the generic persister skips canvas_updated", () => {
    const ephemeral = /EPHEMERAL_TYPES = new Set\(\[[\s\S]*?\]\);/.exec(SP)[0];
    assert.match(ephemeral, /"session\.canvas_updated"/,
        "canvas_updated must be in EPHEMERAL_TYPES — the bridge already recorded it");
    assert.match(ephemeral, /"session\.canvas_data"/,
        "canvas_data too — ticks are bridge-recorded the same way");
    // And the handler no longer emits at all — the persisted event IS the
    // live path, the same delivery show_artifact rides.
    const handler = /defineTool\("draw_canvas", \{[\s\S]*?\n        \}\);/.exec(MS)[0];
    assert.ok(!handler.includes("opts.onEvent("), "the handler must not emit a second copy");
});

test("the draw result carries NO artifact link, and the etiquette rides `reminder`, not `note`", () => {
    const handler = /defineTool\("draw_canvas", \{[\s\S]*?\n        \}\);/.exec(MS)[0];
    assert.ok(!handler.includes("artifact://"), "draw_canvas must not return an artifact link");
    assert.match(handler, /reminder: "The canvas updated live/,
        "`note` is the caption argument; echoing different text under that name reads as the caption being replaced");
});

test("the size precheck sits under the store's REAL text cap (1 MiB), not the imagined 2 MB", () => {
    assert.match(MS, /inlineBytes > 900_000/);
    // The same cap guards the bridge-side fetch, where fromArtifact bytes first exist.
    assert.match(SP, /fetchedBytes > 900_000/);
    assert.ok(!/1_500_000/.test(MS), "the old 1.5 MB precheck admitted draws the store then rejected raw");
});

test("every draw pins; there is no first-draw-only pin to be erased by the second", () => {
    // Uploads replace artifact metadata wholesale, so a pin set once at rev 1
    // vanished at rev 2. The pin rides the upload opts on every draw.
    const block = SP.slice(SP.indexOf("drawCanvas: async"), SP.indexOf("readCanvas: async"));
    assert.match(block, /\{ pinned: true \}/);
    assert.ok(!/rev === 1/.test(block), "the fragile rev===1 pin branch must be gone");
    assert.ok(!/setArtifactPinned/.test(block), "pinning is part of the upload, not a separate racy call");
});

test("rev derivation: table first, slot-filtered 30-event scan as the durable fallback", () => {
    assert.match(SP, /async function latestCanvasRev/);
    assert.match(SP, /getSessionCanvases\?\.\(sessionId\)/, "the 0045 table is the fast path");
    assert.match(SP, /Number\.MAX_SAFE_INTEGER, 30, \["session\.canvas_updated"\]/,
        "a WIDE window — five interleaved slots push a slot's latest past five events");
    assert.match(SP, /eventSlot\(row\) !== slot/, "the scan filters by slot");
    assert.match(SP, /Number\.isFinite\(rev\) && rev > latest && Number\.isInteger\(rev\)/);
});

test("read_canvas is log-first: no event means no canvas, whatever bytes exist", () => {
    const block = SP.slice(SP.indexOf("readCanvas: async"), SP.indexOf("} as const;", SP.indexOf("readCanvas: async")));
    // BOTH read paths — manifestOnly and paged text — must consult the event
    // log before touching bytes: orphan bytes from a half-draw read as
    // not-drawn, whichever door you come in through.
    const manifestGate = block.indexOf("latestCanvasEventData");
    const manifestDownload = block.indexOf("downloadArtifactText");
    assert.ok(manifestGate >= 0 && manifestDownload >= 0);
    assert.ok(manifestGate < manifestDownload, "manifestOnly must be log-first too");
    const pagedRegion = block.slice(block.indexOf("const rev = await latestCanvasRev"));
    const pagedDownload = pagedRegion.indexOf("downloadArtifactText");
    assert.ok(pagedDownload > 0, "paged read must fetch only after the rev gate");
    assert.match(block, /if \(rev === 0\) return \{ exists: false \}/);
    assert.match(block, /sizeChars: text\.length/,
        "paging is in UTF-16 code units; sizeChars is what offset reconciles against");
});

test("both tools count as system tool names", () => {
    const set = /const SYSTEM_TOOL_NAMES = new Set\(\[[^\]]*\]\)/.exec(MS)[0];
    assert.match(set, /"draw_canvas"/);
    assert.match(set, /"read_canvas"/);
});

test("the read-only tuner may read the canvas but never draw it, in both filter sets", () => {
    for (const [src, where] of [[MS, "managed-session"], [SM, "session-manager"]]) {
        const set = /mutatingSystemToolNames = new Set\(\[[^\]]*\]\)/.exec(src);
        assert.ok(set, `${where}: tuner filter set not found`);
        assert.match(set[0], /"draw_canvas"/, `${where}: draw_canvas must be tuner-excluded`);
        assert.ok(!/"read_canvas"/.test(set[0]), `${where}: read_canvas must stay tuner-readable`);
    }
});

test("the reserved filename is exported", () => {
    assert.equal(CANVAS_ARTIFACT_FILENAME, "canvas.html");
});

// ── The interactive-canvas response contract (draw-time half) ───────────────

test("draw_canvas declares responseContract and the bridge carries it in the event", async () => {
    const draw = declaredTool("draw_canvas");
    assert.ok(draw.parameters.properties.responseContract, "responseContract must be declared to the model");
    assert.match(draw.parameters.properties.responseContract.description, /canvas-action/);
    // The event now carries the EFFECTIVE contract (explicit arg or embedded
    // manifest, post-normalization) — strictly stronger than echoing the arg.
    assert.match(SP, /\.\.\.\(effectiveContract \? \{ responseContract: effectiveContract \} : \{\}\)/,
        "the bridge must put the contract in canvas_updated event data — clients learn it where they learn the rev");
    // Cleared canvas drops the contract: a blank page must not stay armed.
    assert.match(MS, /const contractResult = html === "" \? \{\} : normalizeCanvasContractShared\(args\?\.responseContract\)/);
});

test("normalizeCanvasResponseContract accepts the canonical grammar and refuses everything else", async () => {
    const { normalizeCanvasResponseContract } = await import("../../dist/managed-session.js");
    const good = normalizeCanvasResponseContract({ actions: { chat: { text: "string" }, approve: { id: "number", note: "string?" } } });
    assert.equal(good.error, undefined);
    assert.deepEqual(good.contract, { actions: { chat: { text: "string" }, approve: { id: "number", note: "string?" } } });
    assert.deepEqual(normalizeCanvasResponseContract(undefined), {}, "omitted contract is simply absent");

    for (const [bad, why] of [
        [[], "array"],
        [{ actions: [] }, "actions array"],
        [{ actions: {} }, "empty actions"],
        [{ actions: { "bad name!": {} } }, "invalid action name"],
        [{ actions: { chat: { text: "object" } } }, "unknown field type"],
        [{ actions: { chat: { "sp ace": "string" } } }, "invalid field name"],
        [{ actions: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`a${i}`, {}])) }, "too many actions"],
    ]) {
        assert.ok(normalizeCanvasResponseContract(bad).error, `must refuse: ${why}`);
    }
});

// ── update_canvas: the in-place data tick ───────────────────────────────────

test("update_canvas is declared, root-gated everywhere, and never interrupts", () => {
    const tool = declaredTool("update_canvas");
    assert.ok(tool, "update_canvas missing from systemToolDefs()");
    assert.deepEqual(tool.parameters.required, ["data"]);
    assert.match(tool.description, /slot 1-5/i);
    assert.match(tool.description, /no view\s+flip/i, "ticks must advertise they never steal the screen");
    assert.match(tool.description, /DO mark the canvas unseen/i, "and that they light the badge");
    assert.ok(tool.parameters.properties.slot, "slot param missing");
    // Tuner may never tick; children never see it.
    for (const src of [MS, SM]) {
        assert.match(/mutatingSystemToolNames = new Set\(\[[^\]]*\]\)/.exec(src)[0], /"update_canvas"/);
    }
});

test("the tick rides its own durable event: chained, payload inline, persister skips it", () => {
    const block = SP.slice(SP.indexOf("updateCanvas: async"), SP.indexOf("readCanvas: async"));
    assert.match(block, /canvasDrawChain\.then/, "ticks serialize with draws — revs must never interleave");
    assert.match(block, /latestCanvasDataRev/, "dataRev derives from the log, windowed like rev");
    assert.match(block, /eventType: "session\.canvas_data"/);
    assert.match(block, /payload: args\.data/, "the payload IS the event — it is the cold-load replay source");
    assert.ok(!/uploadArtifact/.test(block), "no artifact write for a tick");
    assert.match(SP, /"session\.canvas_data",\s*\n\s*\]\);/, "generic persister must skip canvas_data");
    // 32 KB cap enforced at the handler.
    assert.match(MS, /sizeBytes > 32_768/);
});

// ── fromArtifact draws: the wiring pins ─────────────────────────────────────
// (The extractor itself has behavioral tests in canvas-app-manifest.test.mjs;
// these pin the tool/bridge wiring the same way the rest of this file does.)

test("draw_canvas declares fromArtifact and requires exactly one source", () => {
    const draw = declaredTool("draw_canvas");
    assert.ok(draw.parameters.properties.fromArtifact, "fromArtifact param missing");
    assert.deepEqual(draw.parameters.properties.fromArtifact.required, ["filename"]);
    assert.deepEqual(draw.parameters.required, [], "html must no longer be hard-required");
    // The handler enforces exclusivity — schema alone cannot express XOR to every model.
    assert.match(MS, /hasHtml === Boolean\(fromArtifact\)/);
    assert.match(MS, /pass exactly one source/);
});

test("the bridge resolves fromArtifact server-side: fetch, cap, sha precondition, provenance", () => {
    assert.match(SP, /downloadArtifactText\(sourceSessionId, filename\)/, "bytes must come from the store, not the model");
    assert.match(SP, /the canvas cap is 900 KB/);
    assert.match(SP, /SHA_MISMATCH: artifact/);
    assert.match(SP, /source = \{ kind: "artifact", sessionId: sourceSessionId, filename, sha256 \}/);
    assert.match(SP, /\.\.\.\(source \? \{ source \} : \{\}\)/, "provenance must ride the canvas_updated event");
});

test("contract precedence: explicit argument wins, manifest fills, invalid manifest fails an artifact draw closed", () => {
    assert.match(SP, /let effectiveContract = args\.responseContract/);
    assert.match(SP, /if \(!effectiveContract && html\)/);
    assert.match(SP, /the embedded CANVAS-APP-MANIFEST contract is invalid/);
    assert.match(SP, /the artifact's CANVAS-APP-MANIFEST is broken/);
    // The event must carry the EFFECTIVE contract, not the raw argument.
    assert.match(SP, /\.\.\.\(effectiveContract \? \{ responseContract: effectiveContract \} : \{\}\)/);
});

test("the draw tool result is the interface card, never the bytes", () => {
    assert.match(MS, /\.\.\.\(result\.app \? \{ app: result\.app \} : \{\}\)/);
    assert.match(MS, /\.\.\.\(result\.responseContract \? \{ responseContract: result\.responseContract \} : \{\}\)/);
    assert.match(MS, /\.\.\.\(result\.source \? \{ source: result\.source \} : \{\}\)/);
    const drawHandlerRegion = MS.slice(MS.indexOf('const drawCanvasTool = defineTool("draw_canvas", {'), MS.indexOf('const updateCanvasTool'));
    assert.ok(!/result\.html/.test(drawHandlerRegion), "the tool result must never echo the document");
});

test("read_canvas manifestOnly returns the card plus the ARMED contract", () => {
    const read = declaredTool("read_canvas");
    assert.ok(read.parameters.properties.manifestOnly, "manifestOnly param missing");
    assert.match(SP, /latestCanvasEventData\(catalog, input\.sessionId, slot\)/);
    // The armed contract re-passes the normalizer (events are writable
    // unvalidated via send_session_event) before riding into context.
    assert.match(SP, /\.\.\.\(armed\.contract \? \{ responseContract: armed\.contract \} : \{\}\)/);
});

test("empty-artifact draws are refused: clearing stays an explicit inline act", () => {
    assert.match(SP, /artifact \$\{filename\} is empty; to clear the canvas pass html: ""/);
});

test("review fixes: warning on tolerated inline manifests, bounded manifestOnly reads, self-defaulting saves", () => {
    // Finding 4: the inline tolerate branch must SAY so in the tool result.
    assert.match(SP, /manifestWarning = `CANVAS-APP-MANIFEST attempt is broken/);
    assert.match(MS, /\.\.\.\(result\.manifestWarning \? \{ manifestWarning: result\.manifestWarning \} : \{\}\)/);
    // Finding 7e: a malformed html argument errors instead of silently deferring.
    assert.match(MS, /html must be a string \(the complete document; empty string clears\)/);
    // Finding 1: write_artifact's save-as recipe works with only a filename.
    const AT = readFileSync(fileURLToPath(new URL("../../src/artifact-tools.ts", import.meta.url)), "utf8");
    assert.match(AT, /from\.sessionId \|\| sessionId, from\.filename/);
    assert.ok(/required: \["filename"\]/.test(AT), "fromArtifact must require only filename");
    // Finding 3: the manifestOnly read normalizes the contract before returning it.
    assert.match(AT, /const normalized = normalizeCanvasResponseContract\(manifest\.responseContract\)/);
});

test("second-pass review fixes: rev reads fail loud, armed contracts renormalize, ticks need a canvas", () => {
    // A transient catalog failure must FAIL the op, never read as "no canvas"
    // (an empty-coerce minted rev 1 over a live rev-12 canvas).
    const helpers = SP.slice(SP.indexOf("async function latestCanvasEventData"), SP.indexOf("const SESSION_RECOVERY_NOTICE"));
    assert.ok(!helpers.includes("catch(() => [])"), "rev helpers must not coerce failures to empty");
    const dataRevHelper = SP.slice(SP.indexOf("async function latestCanvasDataRev"), SP.indexOf("async function latestCanvasDataRev") + 500);
    assert.ok(!dataRevHelper.includes("catch(() => [])"), "dataRev helper must not coerce failures to empty");
    // The armed contract from the (unvalidated-writable) event log re-passes
    // the normalizer before riding a cheap read into context.
    assert.match(SP, /const armed = normalizeCanvasResponseContract\(latest\.responseContract\)/);
    // Ticks against a never-drawn canvas refuse instead of badging a blank.
    assert.match(SP, /no canvas has been drawn in slot \$\{slot\} — draw_canvas first/);
    // Arrays are not ticks.
    assert.match(MS, /data must be a JSON object .+not an array/);
});

// ─── show_canvas: present without redrawing ──────────────────────

test("show_canvas is declared, slot-aware, and honest about what it does", () => {
    const tool = declaredTool("show_canvas");
    assert.ok(tool, "show_canvas missing from systemToolDefs()");
    assert.ok(tool.parameters.properties.slot, "slot param missing");
    assert.deepEqual(tool.parameters.required, []);
    assert.match(tool.description, /without redrawing/i);
    assert.match(tool.description, /nothing is marked unseen/i);
});

test("the bridge presents only what exists, durably, with no new rev", () => {
    const block = SP.slice(SP.indexOf("showCanvas: async"), SP.indexOf("readCanvas: async"));
    // Refuses an undrawn slot rather than flipping to a blank pane.
    assert.match(block, /nothing has been drawn in slot \$\{slot\}/);
    // Emits the durable presented event with slot + CURRENT rev — no rev mint.
    assert.match(block, /session\.canvas_presented/);
    assert.ok(!/rev \+ 1|rev\+1/.test(block), "presenting must never mint a revision");
    // The generic persister must skip it — the bridge already recorded it.
    const ephemeral = /EPHEMERAL_TYPES = new Set\(\[[\s\S]*?\]\);/.exec(SP)[0];
    assert.match(ephemeral, /"session\.canvas_presented"/);
});

test("presenting is a tuner-blocked mutation and a first-class system tool", () => {
    for (const src of [MS, SM]) {
        assert.match(/mutatingSystemToolNames = new Set\(\[[^\]]*\]\)/.exec(src)[0], /"show_canvas"/);
    }
});
