/**
 * The canvas KV chokepoint — pure rules, no database.
 *
 * Pins interactive-canvas-apps Parts C/D/E/H/I as code:
 *   key grammar and limits; who may write (policy × manifest × relation);
 *   reserved prefixes; author-bound overwrites; the req/* status cap; the
 *   envelope; and the store-status → result mapping (CAS, quota, size).
 *
 * Run: node --test test/unit/canvas-kv.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
    validateCanvasKvKey, canvasKvGlobMatches, resolveCanvasKvViewer, decideCanvasKvWrite,
    readCanvasKv, writeCanvasKv, CANVAS_KV_VALUE_MAX_BYTES,
} from "../../dist/canvas-kv.js";
import { extractCanvasAppManifest, normalizeCanvasKvManifest } from "../../dist/canvas-app-manifest.js";

const ALICE = { kind: "user", provider: "test", subject: "alice", isAdmin: false, label: "Alice" };
const BOB = { kind: "user", provider: "test", subject: "bob", isAdmin: false, label: "Bob" };
const ADA = { kind: "user", provider: "test", subject: "ada", isAdmin: true, label: "Ada" };
const AGENT = { kind: "agent", sessionId: "s1" };
const LINK = { kind: "link", writerId: "w_1", label: "Sam", writeEnabled: false };

const snapshot = (over = {}) => ({
    rootSessionId: "s1", isSystem: false, visibility: "private",
    owner: { provider: "test", subject: "alice" }, viewerIsOwner: false, viewerShareAccess: null, ...over,
});
const VIEWERS = { write: "viewers", shared: ["app/task/*"] };

// ─── Keys and globs ────────────────────────────────────────────

test("key grammar: charset, length, no leading slash, no dot-dot", () => {
    assert.equal(validateCanvasKvKey("app/note/1"), null);
    assert.equal(validateCanvasKvKey("req/7f3a.1_x-y"), null);
    assert.match(validateCanvasKvKey(""), /required/);
    assert.match(validateCanvasKvKey("a".repeat(201)), /200/);
    assert.match(validateCanvasKvKey("app/no spaces"), /letters/);
    assert.match(validateCanvasKvKey("/app"), /start with/);
    assert.match(validateCanvasKvKey("app/../x"), /\.\./);
    assert.match(validateCanvasKvKey(42), /required/);
});

test("globs: prefix star, bare star, exact", () => {
    assert.equal(canvasKvGlobMatches("app/task/*", "app/task/1"), true);
    assert.equal(canvasKvGlobMatches("app/task/*", "app/task/1/sub"), true);
    assert.equal(canvasKvGlobMatches("app/task/*", "app/tasks"), false);
    assert.equal(canvasKvGlobMatches("*", "anything"), true);
    assert.equal(canvasKvGlobMatches("app/x", "app/x"), true);
    assert.equal(canvasKvGlobMatches("app/x", "app/xy"), false);
});

// ─── Who may write ─────────────────────────────────────────────

test("owner, admin, agent and session writers always write; a stranger never does", () => {
    const owner = resolveCanvasKvViewer(ALICE, snapshot({ viewerIsOwner: true }), { kvAccess: "owner", kvManifest: null });
    assert.equal(owner.me.relation, "owner"); assert.equal(owner.me.canWrite, true); assert.equal(owner.privileged, true);
    const admin = resolveCanvasKvViewer(ADA, snapshot(), { kvAccess: "owner", kvManifest: null });
    assert.equal(admin.me.relation, "admin"); assert.equal(admin.me.canWrite, true);
    const agent = resolveCanvasKvViewer(AGENT, null, { kvAccess: "owner", kvManifest: null });
    assert.equal(agent.me.relation, "agent"); assert.equal(agent.me.canWrite, true); assert.equal(agent.me.id, "agent:s1");
    const writer = resolveCanvasKvViewer(BOB, snapshot({ viewerShareAccess: "write" }), { kvAccess: "owner", kvManifest: null });
    assert.equal(writer.me.canWrite, true, "the agent law: session write ⇒ canvas write, whatever the policy");
    const viewer = resolveCanvasKvViewer(BOB, snapshot(), { kvAccess: "readers", kvManifest: VIEWERS });
    assert.equal(viewer.me.relation, "viewer"); assert.equal(viewer.me.canWrite, false, "no session access at all: read-only even under readers");
});

test("a session READER writes only when BOTH switches are on: policy readers|link AND manifest kv.write viewers", () => {
    const reader = (kvAccess, kvManifest) => resolveCanvasKvViewer(BOB, snapshot({ viewerShareAccess: "read" }), { kvAccess, kvManifest });
    assert.equal(reader("owner", VIEWERS).me.canWrite, false, "policy owner");
    assert.equal(reader("readers", null).me.canWrite, false, "app declares no kv");
    assert.equal(reader("readers", { write: "owner" }).me.canWrite, false, "app says owner");
    assert.equal(reader("readers", VIEWERS).me.canWrite, true);
    assert.equal(reader("link", VIEWERS).me.canWrite, true);
    assert.equal(reader("readers", VIEWERS).me.relation, "collaborator");
    assert.equal(reader("readers", VIEWERS).privileged, false);
});

test("deployment-wide visibility counts as the share it grants", () => {
    const sharedRead = resolveCanvasKvViewer(BOB, snapshot({ visibility: "shared_read" }), { kvAccess: "readers", kvManifest: VIEWERS });
    assert.equal(sharedRead.me.canWrite, true);
    assert.equal(sharedRead.privileged, false);
    const sharedWrite = resolveCanvasKvViewer(BOB, snapshot({ visibility: "shared_write" }), { kvAccess: "owner", kvManifest: null });
    assert.equal(sharedWrite.privileged, true);
});

test("a link bearer is read-only until the read/write link door ships", () => {
    const bearer = resolveCanvasKvViewer(LINK, null, { kvAccess: "link", kvManifest: VIEWERS });
    assert.equal(bearer.me.relation, "link");
    assert.equal(bearer.me.canWrite, false);
    const enabled = resolveCanvasKvViewer({ ...LINK, writeEnabled: true }, null, { kvAccess: "link", kvManifest: VIEWERS });
    assert.equal(enabled.me.canWrite, true, "the door decides writeEnabled; the rule is ready for it");
    assert.equal(resolveCanvasKvViewer({ ...LINK, writeEnabled: true }, null, { kvAccess: "readers", kvManifest: VIEWERS }).me.canWrite, false, "readers never admits bearers");
});

// ─── Per-key rules ─────────────────────────────────────────────

const collaborator = resolveCanvasKvViewer(BOB, snapshot({ viewerShareAccess: "read" }), { kvAccess: "readers", kvManifest: VIEWERS });
const owner = resolveCanvasKvViewer(ALICE, snapshot({ viewerIsOwner: true }), { kvAccess: "readers", kvManifest: VIEWERS });
const agent = resolveCanvasKvViewer(AGENT, null, { kvAccess: "readers", kvManifest: VIEWERS });
const put = (key, value, extra = {}) => ({ op: "put", key, value, ...extra });

test("reserved prefixes: cfg/ owner+agent, evt/ owner+agent, ui/<me> only its writer", () => {
    assert.equal(decideCanvasKvWrite(collaborator, put("cfg/role/bob", "admin"), null).ok, false, "cfg self-serve is the hole the lock closes");
    assert.equal(decideCanvasKvWrite(owner, put("cfg/policy", {}), null).ok, true);
    assert.equal(decideCanvasKvWrite(agent, put("cfg/policy", {}), null).ok, true);
    assert.equal(decideCanvasKvWrite(collaborator, put("evt/1", {}), null).ok, false);
    assert.equal(decideCanvasKvWrite(agent, put("evt/1", {}), null).ok, true);
    assert.equal(decideCanvasKvWrite(collaborator, put("ui/test/bob", { typing: true }), null).ok, true);
    assert.equal(decideCanvasKvWrite(collaborator, put("ui/test/alice", { typing: true }), null).ok, false, "someone else's presence row");
    assert.equal(decideCanvasKvWrite(owner, put("ui/test/bob", {}), null).ok, true, "privileged writers may touch any row");
});

test("author-bound: a collaborator overwrites only their own rows, unless the app shares the prefix", () => {
    const aliceRow = { by: { kind: "user", id: "test/alice", label: "Alice" } };
    const bobRow = { by: { kind: "user", id: "test/bob", label: "Bob" } };
    assert.equal(decideCanvasKvWrite(collaborator, put("app/note/1", "x"), aliceRow).ok, false);
    assert.equal(decideCanvasKvWrite(collaborator, put("app/note/1", "x"), bobRow).ok, true);
    assert.equal(decideCanvasKvWrite(collaborator, put("app/note/1", "x"), null).ok, true, "a new row");
    assert.equal(decideCanvasKvWrite(collaborator, put("app/task/9", "x"), aliceRow).ok, true, "shared glob");
    assert.equal(decideCanvasKvWrite(collaborator, { op: "delete", key: "app/note/1" }, aliceRow).ok, false);
    assert.equal(decideCanvasKvWrite(owner, put("app/note/1", "x"), bobRow).ok, true);
});

test("req/*: collaborators SUGGEST, the owner and the agent QUEUE and LAND", () => {
    const d = decideCanvasKvWrite(collaborator, put("req/1", { op: "expand", status: "queued" }), null);
    assert.equal(d.ok, true); assert.equal(d.value.status, "suggested"); assert.equal(d.capped, "suggested");
    const done = decideCanvasKvWrite(collaborator, put("req/1", { status: "done", result: 1 }), null);
    assert.equal(done.value.status, "suggested", "a collaborator cannot land a request either");
    const own = decideCanvasKvWrite(owner, put("req/1", { status: "queued" }), null);
    assert.equal(own.value.status, "queued"); assert.equal(own.capped, undefined);
    const ag = decideCanvasKvWrite(agent, put("req/1", { status: "done" }), null);
    assert.equal(ag.value.status, "done");
    const already = decideCanvasKvWrite(collaborator, put("req/2", { status: "suggested" }), null);
    assert.equal(already.capped, undefined, "already suggested: nothing to cap");
});

test("a viewer with no write may not write anything", () => {
    const viewer = resolveCanvasKvViewer(BOB, snapshot({ viewerShareAccess: "read" }), { kvAccess: "owner", kvManifest: VIEWERS });
    const d = decideCanvasKvWrite(viewer, put("app/x", 1), null);
    assert.equal(d.ok, false); assert.equal(d.code, "FORBIDDEN");
});

// ─── The store-facing surface ──────────────────────────────────

function fakeStore({ policy = "readers", manifest = VIEWERS, rows = new Map(), statuses = [] } = {}) {
    const writes = [];
    return {
        writes,
        rows,
        getSessionAccess: async (_sid, who) => snapshot({ viewerIsOwner: who.subject === "alice", viewerShareAccess: who.subject === "bob" ? "read" : null }),
        getCanvasKvSettings: async () => ({ kvAccess: policy, kvManifest: manifest, latestRev: 1 }),
        canvasKvGet: async (_s, _slot, key) => rows.get(key) ?? null,
        canvasKvList: async (_s, _slot, prefix, limit, after) => [...rows.values()]
            .filter((r) => (!prefix || r.key.startsWith(prefix)) && (!after || r.key > after))
            .sort((a, b) => a.key.localeCompare(b.key)).slice(0, limit),
        canvasKvWrite: async (_s, _slot, key, value, ifMatch, limits) => {
            writes.push({ key, value, ifMatch, limits });
            const forced = statuses.shift();
            if (forced) return forced;
            const prev = rows.get(key);
            const rev = (prev?.rev ?? 0) + 1;
            if (value === null) { rows.delete(key); return { status: prev ? "deleted" : "not_found", rev, sizeBytes: 0 }; }
            rows.set(key, { key, value, rev, updatedAt: "now" });
            return { status: "written", rev, sizeBytes: JSON.stringify(value).length };
        },
    };
}

test("write stamps the envelope server-side and reports each op individually", async () => {
    const store = fakeStore();
    const out = await writeCanvasKv(store, "s1", 1, BOB, [
        put("app/note/1", { text: "hi" }),
        put("bad key", 1),
        put("cfg/x", 1),
        put("req/1", { status: "queued" }),
    ]);
    assert.deepEqual(out.results.map((r) => [r.key, r.ok, r.code ?? null, r.capped ?? null]), [
        ["app/note/1", true, null, null],
        ["bad key", false, "INVALID_KEY", null],
        ["cfg/x", false, "FORBIDDEN", null],
        ["req/1", true, null, "suggested"],
    ]);
    const env = store.writes[0].value;
    assert.deepEqual(env.v, { text: "hi" });
    assert.deepEqual(env.by, { kind: "user", id: "test/bob", label: "Bob" });
    assert.match(env.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(store.writes[0].limits.maxValueBytes, CANVAS_KV_VALUE_MAX_BYTES);
    assert.equal(store.writes[1]?.key, "req/1", "the refused ops never reached the store");
    assert.equal(store.writes[1].value.v.status, "suggested", "the CAPPED value is what got stored");
});

test("unknown ops, malformed ifMatch, and out-of-range slots are refused, never executed", async () => {
    const store = fakeStore();
    const out = await writeCanvasKv(store, "s1", 1, ALICE, [
        { op: "DELETE", key: "app/a" },
        { op: "frob", key: "app/b" },
        { key: "app/c", value: 1 },
        put("app/d", 1, { ifMatch: "abc" }),
        put("app/e", 1, { ifMatch: -1 }),
        put("app/f", 1, { ifMatch: 2.5 }),
        put("app/g", 1, { ifMatch: "3" }),
        put("app/h..i", 1),
    ]);
    assert.deepEqual(out.results.map((r) => [r.key, r.ok, r.code ?? null]), [
        ["app/a", false, "INVALID_REQUEST"], ["app/b", false, "INVALID_REQUEST"], ["app/c", false, "INVALID_REQUEST"],
        ["app/d", false, "INVALID_REQUEST"], ["app/e", false, "INVALID_REQUEST"], ["app/f", false, "INVALID_REQUEST"],
        ["app/g", true, null], ["app/h..i", false, "INVALID_KEY"],
    ]);
    assert.equal(store.writes.length, 1, "only the well-formed op reached the store");
    assert.equal(store.writes[0].ifMatch, 3, "a numeric string ifMatch is accepted as its integer");
    await assert.rejects(readCanvasKv(store, "s1", 6, ALICE), (e) => e.code === "INVALID_REQUEST");
    await assert.rejects(writeCanvasKv(store, "s1", 0, ALICE, [put("app/x", 1)]), (e) => e.code === "INVALID_REQUEST");
    await assert.rejects(writeCanvasKv(store, "s1", "abc", ALICE, [put("app/x", 1)]), (e) => e.code === "INVALID_REQUEST");
});

test("store statuses map to result codes: conflict, too_large, quota", async () => {
    const store = fakeStore({ statuses: [
        { status: "conflict", rev: 4, sizeBytes: null },
        { status: "too_large", rev: 0, sizeBytes: 20000 },
        { status: "quota_keys", rev: 0, sizeBytes: 5 },
        { status: "quota_bytes", rev: 0, sizeBytes: 5 },
        { status: "not_found", rev: 0, sizeBytes: null },
    ] });
    const out = await writeCanvasKv(store, "s1", 1, ALICE, [
        put("app/a", 1, { ifMatch: 3 }), put("app/b", 1), put("app/c", 1), put("app/d", 1), { op: "delete", key: "app/gone" },
    ]);
    assert.deepEqual(out.results.map((r) => [r.ok, r.code ?? null, r.rev ?? null]), [
        [false, "CONFLICT", 4], [false, "TOO_LARGE", null], [false, "QUOTA", null], [false, "QUOTA", null], [true, null, 0],
    ]);
    assert.equal(store.writes[0].ifMatch, 3, "ifMatch reaches the store untouched");
});

test("read returns entries as {key, v, by, at, rev}, me, policy, and a cursor when the page is full", async () => {
    const rows = new Map();
    for (let i = 0; i < 5; i++) rows.set(`app/n/${i}`, { key: `app/n/${i}`, value: { v: i, by: { kind: "user", id: "test/alice", label: "A" }, at: "t" }, rev: 1, updatedAt: "now" });
    rows.set("req/1", { key: "req/1", value: { v: { status: "queued" }, by: { kind: "agent", id: "agent:s1", label: "agent" }, at: "t" }, rev: 2, updatedAt: "now" });
    const store = fakeStore({ rows });
    const page = await readCanvasKv(store, "s1", 1, BOB, { prefix: "app/", limit: 2 });
    assert.deepEqual(page.entries.map((e) => e.key), ["app/n/0", "app/n/1"]);
    assert.equal(page.nextAfter, "app/n/1");
    assert.deepEqual(page.entries[0], { key: "app/n/0", v: 0, by: { kind: "user", id: "test/alice", label: "A" }, at: "t", rev: 1 });
    assert.equal(page.me.relation, "collaborator"); assert.equal(page.me.canWrite, true); assert.equal(page.policy, "readers");
    const rest = await readCanvasKv(store, "s1", 1, BOB, { prefix: "app/", limit: 2, after: "app/n/1" });
    assert.deepEqual(rest.entries.map((e) => e.key), ["app/n/2", "app/n/3"]);
    const one = await readCanvasKv(store, "s1", 1, BOB, { key: "req/1" });
    assert.equal(one.entries[0].by.kind, "agent");
    const none = await readCanvasKv(store, "s1", 1, BOB, { key: "req/9" });
    assert.equal(none.entries.length, 0);
    await assert.rejects(readCanvasKv(store, "s1", 1, BOB, { key: "bad key" }), /letters/);
});

test("a principal with no access is refused before any row is read", async () => {
    const store = fakeStore();
    await assert.rejects(readCanvasKv(store, "s1", 1, { kind: "user", provider: "test", subject: "dave", isAdmin: false }), (e) => e.code === "FORBIDDEN");
    await assert.rejects(writeCanvasKv(store, "s1", 1, { kind: "user", provider: "test", subject: "dave", isAdmin: false }, [put("app/x", 1)]), (e) => e.code === "FORBIDDEN");
    assert.equal(store.writes.length, 0);
});

// ─── Manifest ──────────────────────────────────────────────────

test("the manifest's kv block is normalized and rides the extraction", () => {
    const html = `<!doctype html><!-- CANVAS-APP-MANIFEST {"name":"board","kv":{"write":"viewers","shared":["app/task/*", 42, ""],"junk":1}} --><html></html>`;
    const { manifest } = extractCanvasAppManifest(html);
    assert.deepEqual(manifest.kv, { write: "viewers", shared: ["app/task/*"] });
    assert.deepEqual(normalizeCanvasKvManifest({ write: "nope" }), { write: "owner", shared: [] });
    assert.equal(normalizeCanvasKvManifest("x"), null);
    assert.equal(extractCanvasAppManifest(`<!doctype html><!-- CANVAS-APP-MANIFEST {"name":"plain"} --><html></html>`).manifest.kv, undefined);
});
