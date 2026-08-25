/**
 * The canvas app catalog — pure parts, no database.
 *
 *   manifest `interface` extraction, caps and clipping
 *   the catalog record (the shared fact's value)
 *   publish refusals (no manifest / no interface / bad name / thin description)
 *   find on a BASE store (listing + term-overlap rank) and on an ENHANCED
 *   store (hybrid search pinned to namespace apps, scope shared)
 *
 * Run: node --test test/unit/canvas-app-catalog.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    extractCanvasAppManifest, canvasAppCard, buildCanvasAppCatalogRecord, normalizeCanvasAppInterface,
    CANVAS_APP_NAME_RE, CANVAS_INTERFACE_MAX_BYTES,
} from "../../dist/canvas-app-manifest.js";
import { publishCanvasApp, findCanvasApp, rankCanvasAppHits } from "../../dist/canvas-app-catalog.js";

const IFACE = {
    keys: [
        { key: "app/item/<id>", writer: "both", shape: { title: "x", decision: null }, note: "one per item" },
        { key: "cfg/deadline", writer: "agent", shape: "iso" },
    ],
    requests: [{ op: "store", args: {}, result: { artifact: "x.md" }, note: "owner presses Store" }],
    events: [{ key: "evt/banner", shape: { text: "" } }],
    notes: "Render from app/item/*.",
};
const doc = (manifest) => `<!doctype html>\n<!-- CANVAS-APP-MANIFEST ${JSON.stringify(manifest)} -->\n<html><body>app</body></html>`;

// ─── Manifest ──────────────────────────────────────────────────

test("the interface block rides the manifest and the card, normalized", () => {
    const { manifest, error } = extractCanvasAppManifest(doc({ name: "signoff", interface: { ...IFACE, junk: 1, keys: [...IFACE.keys, { nope: true }] }, tags: ["Release", "release", " approval "] }));
    assert.equal(error, undefined);
    assert.deepEqual(manifest.interface.keys.map((k) => k.key), ["app/item/<id>", "cfg/deadline"], "an entry without a key is dropped");
    assert.equal(manifest.interface.keys[0].writer, "both");
    assert.deepEqual(manifest.interface.keys[0].shape, { title: "x", decision: null });
    assert.equal(manifest.interface.requests[0].op, "store");
    assert.deepEqual(manifest.interface.requests[0].result, { artifact: "x.md" });
    assert.equal(manifest.interface.notes, "Render from app/item/*.");
    assert.equal("junk" in manifest.interface, false);
    assert.deepEqual(manifest.tags, ["release", "approval"], "tags are lowercased, trimmed, deduped");
    const card = canvasAppCard(manifest);
    assert.deepEqual(card.interface, manifest.interface);
    assert.deepEqual(card.tags, ["release", "approval"]);
});

test("interface caps: lists at 32, shapes at 512 bytes, the block at 6 KB (error, not truncation)", () => {
    const many = { keys: Array.from({ length: 40 }, (_, i) => ({ key: `app/k${i}` })) };
    assert.equal(normalizeCanvasAppInterface(many).interface.keys.length, 32);
    const big = normalizeCanvasAppInterface({ keys: [{ key: "app/x", shape: { blob: "y".repeat(2000) } }] });
    assert.ok(typeof big.interface.keys[0].shape === "string" && big.interface.keys[0].shape.endsWith("…"), "an oversize shape is clipped to a string");
    const huge = { keys: Array.from({ length: 32 }, (_, i) => ({ key: `app/k${i}`, note: "n".repeat(390) })) };
    const r = normalizeCanvasAppInterface(huge);
    assert.equal(r.interface, null);
    assert.match(r.error, new RegExp(String(CANVAS_INTERFACE_MAX_BYTES)));
    const { manifest, error } = extractCanvasAppManifest(doc({ name: "x", interface: huge }));
    assert.equal(manifest, null, "an over-cap interface fails the manifest closed");
    assert.match(error, /interface block/);
    assert.equal(normalizeCanvasAppInterface({}).interface, null, "an empty block is no block");
    assert.equal(normalizeCanvasAppInterface("nope").interface, null);
});

test("app names are slugs", () => {
    for (const ok of ["release-signoff", "poll", "a1", "x".repeat(64)]) assert.ok(CANVAS_APP_NAME_RE.test(ok), ok);
    for (const bad of ["Release", "my app", "-lead", "trail-", "x".repeat(65), "", "a/b"]) assert.ok(!CANVAS_APP_NAME_RE.test(bad), bad);
});

test("the catalog record is built from the document's manifest plus the armed contract and source", () => {
    const { manifest } = extractCanvasAppManifest(doc({ name: "signoff", version: "1.2.0", kv: { write: "viewers", shared: ["app/item/*"] }, interface: IFACE, tags: ["release"] }));
    const record = buildCanvasAppCatalogRecord({
        name: "release-signoff", description: "Use when approvers sign off.", manifest,
        responseContract: { actions: { request: { id: "string" } } },
        source: { sessionId: "s1", filename: "app-release-signoff.html", sha256: "abc" },
        publishedBy: "s1", publishedAt: "2026-08-24T00:00:00Z", tags: ["approval", "release"],
    });
    assert.equal(record.name, "release-signoff");
    assert.equal(record.version, "1.2.0");
    assert.deepEqual(record.kv, { write: "viewers", shared: ["app/item/*"] });
    assert.deepEqual(record.tags, ["approval", "release"], "arg tags + manifest tags, deduped");
    assert.deepEqual(record.source, { kind: "artifact", sessionId: "s1", filename: "app-release-signoff.html", sha256: "abc" });
    assert.deepEqual(record.card.interface, manifest.interface);
    assert.deepEqual(record.responseContract, { actions: { request: { id: "string" } } });
});

// ─── Publish ───────────────────────────────────────────────────

function fakeDeps({ html, rev = 1, contract = null } = {}) {
    const uploads = [], facts = [], events = [];
    return {
        uploads, facts, events,
        deps: {
            sessionId: "s1", agentIdentity: "default", workerNodeId: "w1",
            artifactStore: {
                downloadArtifactText: async () => html,
                uploadArtifact: async (sid, filename, body, contentType, opts) => { uploads.push({ sid, filename, bytes: body.length, contentType, opts }); },
            },
            catalog: {
                // The shape latestCanvasEventData reads: a bounded window of
                // canvas_updated rows, newest first.
                getSessionEventsBefore: async (_sid, _before, _limit, types) => {
                    assert.deepEqual(types, ["session.canvas_updated"]);
                    return rev ? [{ eventType: "session.canvas_updated", data: { rev, slot: 1, ...(contract ? { responseContract: contract } : {}) } }] : [];
                },
                recordEvents: async (sid, evs) => { events.push(...evs); },
            },
            factStore: {
                storeFact: async (input) => { facts.push(input); return { key: input.key, shared: true, stored: true }; },
                readFacts: async () => ({ facts: facts.map((f) => ({ key: f.key, value: f.value })), count: facts.length }),
            },
        },
    };
}

test("publish: the shell becomes a pinned artifact and ONE shared fact whose value is the card", async () => {
    const html = doc({ name: "signoff", version: "1.0.0", kv: { write: "viewers" }, interface: IFACE, responseContract: { actions: { request: { id: "string" } } } });
    const f = fakeDeps({ html, contract: { actions: { request: { id: "string" } } } });
    const out = await publishCanvasApp(f.deps, { name: "Release-Signoff", description: "Use when several approvers sign off a release train together.", tags: ["release"], slot: 1, target: "s1" });
    assert.equal(out.error, undefined, JSON.stringify(out));
    assert.equal(out.published, true);
    assert.equal(out.key, "apps/release-signoff", "the name is lowercased");
    assert.equal(f.uploads.length, 1);
    assert.equal(f.uploads[0].filename, "app-release-signoff.html");
    assert.equal(f.uploads[0].opts.pinned, true);
    assert.equal(f.facts.length, 1);
    assert.equal(f.facts[0].shared, true);
    assert.deepEqual(f.facts[0].tags, ["canvas-app", "release"]);
    const value = f.facts[0].value;
    assert.equal(value.source.sha256, createHash("sha256").update(html, "utf8").digest("hex"));
    assert.deepEqual(value.card.interface, IFACE);
    assert.equal(value.publishedBy, "s1");
    assert.equal(f.events[0].eventType, "session.canvas_app_published");
});

test("publish refusals: bad name, thin description, no canvas, no manifest, no interface, broken manifest", async () => {
    const good = "Use when several approvers sign off a release train together.";
    const withIface = doc({ name: "x", interface: IFACE });
    assert.match((await publishCanvasApp(fakeDeps({ html: withIface }).deps, { name: "Bad Name", description: good, slot: 1, target: "s1" })).error, /slug/);
    assert.match((await publishCanvasApp(fakeDeps({ html: withIface }).deps, { name: "ok", description: "board", slot: 1, target: "s1" })).error, /WHEN to use/);
    assert.match((await publishCanvasApp(fakeDeps({ html: withIface, rev: 0 }).deps, { name: "ok", description: good, slot: 1, target: "s1" })).error, /no canvas has been drawn/);
    assert.match((await publishCanvasApp(fakeDeps({ html: "<!doctype html><html><body>plain</body></html>" }).deps, { name: "ok", description: good, slot: 1, target: "s1" })).error, /no CANVAS-APP-MANIFEST/);
    assert.match((await publishCanvasApp(fakeDeps({ html: doc({ name: "x", kv: { write: "viewers" } }) }).deps, { name: "ok", description: good, slot: 1, target: "s1" })).error, /no `interface` block/);
    assert.match((await publishCanvasApp(fakeDeps({ html: "<!doctype html><!-- CANVAS-APP-MANIFEST {broken --><html></html>" }).deps, { name: "ok", description: good, slot: 1, target: "s1" })).error, /broken/);
    assert.match((await publishCanvasApp({ ...fakeDeps({ html: withIface }).deps, factStore: null }, { name: "ok", description: good, slot: 1, target: "s1" })).error, /no fact store/);
});

// ─── Find ──────────────────────────────────────────────────────

const CATALOG = [
    { key: "apps/release-signoff", value: { name: "release-signoff", description: "Use when several approvers sign off a release train together.", tags: ["release", "approval"], kv: { write: "viewers" }, source: { kind: "artifact", sessionId: "s1", filename: "app-release-signoff.html", sha256: "a" } } },
    { key: "apps/pr-review-board", value: { name: "pr-review-board", description: "Use when reviewing a pull request diff with several reviewers.", tags: ["review", "diff"], source: { kind: "artifact" } } },
    { key: "apps/availability-poll", value: JSON.stringify({ name: "availability-poll", description: "Use when a team picks a meeting slot.", tags: ["meeting"] }) },
    { key: "apps/broken", value: "not json" },
];

test("find on a BASE store lists apps/* and ranks by term overlap", async () => {
    const factStore = {
        readFacts: async (q) => { assert.equal(q.keyPattern, "apps/*"); assert.equal(q.scope, "shared"); return { facts: CATALOG, count: CATALOG.length }; },
    };
    const out = await findCanvasApp({ factStore }, { query: "sign off a release" });
    assert.equal(out.error, undefined);
    assert.equal(out.apps[0].name, "release-signoff");
    assert.equal(out.apps[0].score, 1, "every term hit");
    assert.ok(out.apps.every((a) => a.name !== "broken"), "unparseable rows are dropped");
    assert.ok(out.apps[0].source, "the hit carries the draw source");
    const all = await findCanvasApp({ factStore }, { query: "" });
    assert.equal(all.count, 3, "an empty query lists everything parseable");
    const none = await findCanvasApp({ factStore }, { query: "kubernetes" });
    assert.equal(none.count, 0);
    assert.match(out.next, /read_facts/);
});

test("find on an ENHANCED store runs hybrid search pinned to namespace apps, scope shared", async () => {
    let seen = null;
    const factStore = {
        capabilities: { search: true, embedder: false },
        searchFacts: async (query, opts) => { seen = { query, opts }; return { count: 1, facts: [{ key: "apps/release-signoff", value: CATALOG[0].value, score: 0.91 }] }; },
        similarFacts: async () => ({ count: 0, facts: [] }),
        configureEmbedder: async () => ({}), startEmbedder: async () => ({}), stopEmbedder: async () => ({}), embedderStatus: async () => ({}),
        readFacts: async () => { throw new Error("must not fall back to a listing when search is available"); },
    };
    const out = await findCanvasApp({ factStore }, { query: "release sign-off", limit: 5 });
    assert.deepEqual(seen.opts, { mode: "hybrid", namespace: "apps", scope: "shared", limit: 5 });
    assert.equal(out.apps[0].score, 0.91);
});

test("rankCanvasAppHits: ties break by name, limit applies, short words are ignored", () => {
    const hits = CATALOG.slice(0, 2).map((f) => ({ key: f.key, name: f.value.name, description: f.value.description, version: null, tags: f.value.tags, kv: null, source: null }));
    const ranked = rankCanvasAppHits(hits, "use when a", 10);
    assert.deepEqual(ranked.map((h) => h.name), ["pr-review-board", "release-signoff"], "'use' and 'when' hit both; 'a' is ignored; tie → name order");
    assert.equal(rankCanvasAppHits(hits, "review", 1).length, 1);
});
