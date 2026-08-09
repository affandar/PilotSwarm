/**
 * CANVAS-APP-MANIFEST extraction + the shared contract grammar.
 *
 * The extractor feeds three surfaces (draw_canvas fromArtifact resolution,
 * read_canvas manifestOnly, read_artifact manifestOnly), so its edge cases
 * are platform behavior, not implementation detail: a broken manifest must be
 * DISTINGUISHABLE from an absent one (fail-closed vs plain document), and
 * prose fields must stay clamped so the interface card cannot bloat context.
 *
 * Run: node --test test/unit/canvas-app-manifest.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
    extractCanvasAppManifest,
    canvasAppCard,
    normalizeCanvasResponseContract,
} from "../../dist/canvas-app-manifest.js";

const APP = (manifestJson) => `<!doctype html>
<!-- CANVAS-APP-MANIFEST
${manifestJson}
-->
<html><body><h1>app</h1></body></html>`;

test("a well-formed manifest extracts with every card field", () => {
    const { manifest, error } = extractCanvasAppManifest(APP(JSON.stringify({
        manifestVersion: 1,
        name: "release-signoff",
        version: "1.2.0",
        description: "23-item checklist",
        data: "{items:[{id,state}]}",
        notes: "tick to pre-check",
        responseContract: { actions: { submit: { items: "json", note: "string?" } } },
    })));
    assert.equal(error, undefined);
    assert.equal(manifest.name, "release-signoff");
    assert.equal(manifest.version, "1.2.0");
    assert.equal(manifest.manifestVersion, 1);
    assert.deepEqual(manifest.responseContract, { actions: { submit: { items: "json", note: "string?" } } });
    const card = canvasAppCard(manifest);
    assert.deepEqual(Object.keys(card).sort(), ["data", "description", "name", "notes", "version"]);
});

test("no manifest is a plain document — null, no error", () => {
    const { manifest, error } = extractCanvasAppManifest("<!doctype html><html><body>hi</body></html>");
    assert.equal(manifest, null);
    assert.equal(error, undefined);
    assert.equal(canvasAppCard(null), undefined);
});

test("malformed JSON is an ATTEMPTED manifest: null plus an error", () => {
    const { manifest, error } = extractCanvasAppManifest(APP("{ not json"));
    assert.equal(manifest, null);
    assert.match(error, /not valid JSON/);
});

test("an unclosed manifest comment reports the missing terminator", () => {
    const html = `<!doctype html>\n<!-- CANVAS-APP-MANIFEST\n{"name":"x"}`;
    const { manifest, error } = extractCanvasAppManifest(html);
    assert.equal(manifest, null);
    assert.match(error, /never closed/);
});

test("a manifest that is not a JSON object is refused", () => {
    assert.match(extractCanvasAppManifest(APP("[1,2,3]")).error, /must be a JSON object/);
    assert.match(extractCanvasAppManifest(APP('"just a string"')).error, /must be a JSON object/);
});

test("a marker beyond the 4KB scan window is ignored, not an error", () => {
    const padding = `<!doctype html><html><body>${"x".repeat(5000)}`;
    const html = `${padding}<!-- CANVAS-APP-MANIFEST {"name":"late"} --></body></html>`;
    const { manifest, error } = extractCanvasAppManifest(html);
    assert.equal(manifest, null);
    assert.equal(error, undefined);
});

test("prose fields are clamped so the card stays cheap", () => {
    const long = "y".repeat(2000);
    const { manifest } = extractCanvasAppManifest(APP(JSON.stringify({ name: "n", description: long })));
    assert.ok(manifest.description.length <= 400);
    assert.ok(manifest.description.endsWith("…"));
});

test("empty and whitespace-only prose fields are dropped, not kept as empty strings", () => {
    const { manifest } = extractCanvasAppManifest(APP(JSON.stringify({ name: "  ", description: "", notes: "real" })));
    assert.equal(manifest.name, undefined);
    assert.equal(manifest.description, undefined);
    assert.equal(manifest.notes, "real");
});

test("the manifest's contract passes through the SAME normalizer as the tool argument", () => {
    const { manifest } = extractCanvasAppManifest(APP(JSON.stringify({
        responseContract: { actions: { go: { speed: "number" } } },
    })));
    const normalized = normalizeCanvasResponseContract(manifest.responseContract);
    assert.deepEqual(normalized.contract, { actions: { go: { speed: "number" } } });
    const bad = extractCanvasAppManifest(APP(JSON.stringify({
        responseContract: { actions: { go: { speed: "warp" } } },
    })));
    assert.ok(normalizeCanvasResponseContract(bad.manifest.responseContract).error, "invalid types must still be refused downstream");
});

test("the normalizer re-export from managed-session survives the module split", async () => {
    const managed = await import("../../dist/managed-session.js");
    assert.equal(typeof managed.normalizeCanvasResponseContract, "function");
    const direct = await import("../../dist/canvas-app-manifest.js");
    assert.equal(managed.normalizeCanvasResponseContract, direct.normalizeCanvasResponseContract);
});

test("a marker OUTSIDE any open comment is a plain document, never a broken attempt", () => {
    const html = `<!doctype html>\n<!-- theme: dark -->\n<p>All about CANVAS-APP-MANIFEST conventions</p>`;
    const { manifest, error } = extractCanvasAppManifest(html);
    assert.equal(manifest, null);
    assert.equal(error, undefined, "prose mentioning the marker must not fail fromArtifact draws closed");
    const inScript = `<!doctype html>\n<!-- header -->\n<script>const M = "CANVAS-APP-MANIFEST";</` + `script>`;
    assert.equal(extractCanvasAppManifest(inScript).error, undefined);
});

test("a header comment MENTIONING the convention cannot shadow the real manifest below it", () => {
    const html = `<!doctype html>\n<!-- built with CANVAS-APP-MANIFEST support -->\n<!-- CANVAS-APP-MANIFEST\n{"name":"real-app","responseContract":{"actions":{"go":{"x":"number"}}}}\n-->\n<body></body>`;
    const { manifest, error } = extractCanvasAppManifest(html);
    assert.equal(error, undefined, "the mention must not be misread as a broken manifest");
    assert.equal(manifest.name, "real-app");
});

test("the prose clamp never splits a surrogate pair", () => {
    const description = "x".repeat(398) + "\u{1F600}" + "y".repeat(50);
    const { manifest } = extractCanvasAppManifest(APP(JSON.stringify({ description })));
    assert.ok(manifest.description.isWellFormed(), "a lone surrogate is not well-formed JSON text");
    assert.ok(manifest.description.endsWith("…"));
});

test("the contract's data key (tick-shape example) survives normalization, bounded", () => {
    const ok = normalizeCanvasResponseContract({ actions: { go: { x: "number" } }, data: { example: { items: [1, 2] } } });
    assert.deepEqual(ok.contract.data, { example: { items: [1, 2] } }, "the documented re-read-before-ticking loop depends on this surviving");
    const big = normalizeCanvasResponseContract({ actions: { go: { x: "number" } }, data: { example: "z".repeat(2000) } });
    assert.match(big.error, /shape EXAMPLE, not a payload/);
});
