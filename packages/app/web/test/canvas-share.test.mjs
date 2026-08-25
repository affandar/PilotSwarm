// Canvas share links: the token doors and their contracts.
//
// CRUD/rotation semantics live in the SDK's live-PG suite; here the door
// behavior is tested against a fake transport (hashing, null-shapes, slot
// filtering) and the security-relevant wiring is pinned at the source.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { PortalRuntime } from "../runtime.js";

const WS = readFileSync(fileURLToPath(new URL("../api/ws.js", import.meta.url)), "utf8");
const SERVER = readFileSync(fileURLToPath(new URL("../server.js", import.meta.url)), "utf8");
const RUNTIME = readFileSync(fileURLToPath(new URL("../runtime.js", import.meta.url)), "utf8");
const APP = readFileSync(fileURLToPath(new URL("../src/App.jsx", import.meta.url)), "utf8");

function runtimeWith(transportOverrides) {
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.transport = {
        resolveCanvasShareTokenHash: async () => null,
        downloadArtifactBinary: async () => { throw new Error("no artifact"); },
        getCanvasLive: async () => [],
        ...transportOverrides,
    };
    return runtime;
}

test("the raw token is hashed BEFORE it reaches the catalog; the scope comes back", async () => {
    const seen = [];
    const runtime = runtimeWith({
        resolveCanvasShareTokenHash: async (hash) => {
            seen.push(hash);
            return { sessionId: "sess-1", slot: 2 };
        },
    });
    const scope = await runtime.resolveCanvasShareToken("my-raw-token");
    assert.deepEqual(scope, { sessionId: "sess-1", slot: 2 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0], createHash("sha256").update("my-raw-token", "utf8").digest("hex"),
        "the catalog only ever sees the sha256, never the raw token");
});

test("empty, oversized, and unknown tokens resolve to null — the only failure shape", async () => {
    const runtime = runtimeWith({});
    assert.equal(await runtime.resolveCanvasShareToken(""), null);
    assert.equal(await runtime.resolveCanvasShareToken("x".repeat(600)), null, "length cap before hashing");
    assert.equal(await runtime.resolveCanvasShareToken("unknown"), null);
    const throwing = runtimeWith({ resolveCanvasShareTokenHash: async () => { throw new Error("db down"); } });
    assert.equal(await throwing.resolveCanvasShareToken("t"), null, "catalog failures leak nothing");
});

test("the doc door serves slot-addressed canvas bytes for a valid token, null otherwise", async () => {
    const runtime = runtimeWith({
        resolveCanvasShareTokenHash: async () => ({ sessionId: "sess-1", slot: 3 }),
        downloadArtifactBinary: async (sessionId, filename) => {
            assert.equal(sessionId, "sess-1");
            assert.equal(filename, "canvas3.html", "slot 3 reads canvas3.html");
            return { body: Buffer.from("<html>dash</html>", "utf8"), contentType: "text/html" };
        },
    });
    const doc = await runtime.getCanvasShareDoc("tok");
    assert.equal(doc.html, "<html>dash</html>");
    assert.equal(doc.slot, 3);

    const missing = runtimeWith({ resolveCanvasShareTokenHash: async () => ({ sessionId: "s", slot: 1 }) });
    assert.equal(await missing.getCanvasShareDoc("tok"), null, "artifact failures are null, not errors");
    const invalid = runtimeWith({});
    assert.equal(await invalid.getCanvasShareDoc("tok"), null);
});

test("the live door returns ONLY the token's slot", async () => {
    const runtime = runtimeWith({
        resolveCanvasShareTokenHash: async () => ({ sessionId: "sess-1", slot: 2 }),
        getCanvasLive: async () => [
            { slot: 1, seq: 9, payload: { other: true } },
            { slot: 2, seq: 4, payload: { mine: true } },
        ],
    });
    const state = await runtime.getCanvasShareLive("tok");
    assert.equal(state.slot, 2);
    assert.deepEqual(state.live.payload, { mine: true });
    assert.equal(state.live.seq, 4);
    // No sessionId in the response — a link bearer learns the canvas, not
    // the session's identity.
    assert.equal("sessionId" in state, false);
});

// ─── Security wiring pins ───────────────────────────────────────────────────

test("share-scoped WS connections may ONLY subscribe to their canvas, slot-filtered", () => {
    assert.match(WS, /canvasShare/, "the token rides the WS URL");
    assert.match(WS, /share connections may only subscribe to their canvas/, "everything else refused");
    assert.match(WS, /Number\(update\?\.slot\) !== shareScope\.slot\) return/, "pings filtered to the token's slot");
    assert.match(WS, /if \(!shareScope && auth\) runtime\.noteSignInRole/, "token bearers never register sign-in roles");
});

test("the doc route renders under CSP sandbox and both routes answer 404 for every failure", () => {
    assert.match(SERVER, /Content-Security-Policy", "sandbox allow-scripts"/, "direct navigation gets an OPAQUE origin");
    assert.match(SERVER, /canvas-share\/doc/, "doc route present");
    assert.match(SERVER, /canvas-share\/live/, "live route present");
    const docRoute = SERVER.slice(SERVER.indexOf("/api/canvas-share/doc"), SERVER.indexOf("/api/canvas-share/live"));
    assert.ok((docRoute.match(/404/g) || []).length >= 2, "missing and thrown both 404 — validity never leaks");
});

test("the share view bypasses auth gates but sandboxes the frame and never forwards canvas actions", () => {
    assert.match(APP, /canvasShareToken/, "token mode detected from the URL");
    assert.match(APP, /sandbox: "allow-scripts"/, "the shared document runs origin-isolated");
    assert.ok(!/CanvasShareView[\s\S]*?canvas-action[\s\S]*?sendMessage/.test(APP.slice(APP.indexOf("function CanvasShareView"), APP.indexOf("export default function App"))),
        "the share view has no postback path at all");
});

test("the runtime hashes tokens itself and fetches doc bytes at the transport level", () => {
    assert.match(RUNTIME, /createHash\("sha256"\)\.update\(token/, "hash at the door");
    assert.match(RUNTIME, /this\.transport\.downloadArtifactBinary\(scope\.sessionId/, "token IS the authorization for the doc fetch");
});

// ─── The share WS handshake, exercised for real ─────────────────────────────
// The adversarial round proved source pins cannot catch a protocol mismatch:
// the client sends no sessionId (it is never told one) and the server used to
// require it — the live feed was structurally dead while every pin passed.
// This drives the REAL connection handler with fake sockets.

import { createConnectionHandler } from "../api/ws.js";
import { EventEmitter } from "node:events";

function fakeSocket() {
    const ws = new EventEmitter();
    ws.readyState = 1;
    ws.OPEN = 1;
    ws.sent = [];
    ws.closed = null;
    ws.send = (raw) => ws.sent.push(JSON.parse(raw));
    ws.close = (code, reason) => { ws.closed = { code, reason }; ws.emit("close"); };
    return ws;
}

function shareHarness({ scope = { sessionId: "sess-9", slot: 2 }, revalidate = scope } = {}) {
    let planeCb = null;
    let resolveCalls = 0;
    const runtime = {
        resolveCanvasShareToken: async () => {
            resolveCalls += 1;
            return resolveCalls === 1 ? scope : revalidate;
        },
        canvasPlane: {
            available: true,
            subscribe: (sessionId, cb) => {
                planeCb = cb;
                return () => { planeCb = null; };
            },
        },
        noteSignInRole: () => { throw new Error("share bearers must never register sign-in roles"); },
    };
    return { runtime, getPlaneCb: () => planeCb };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

test("handshake: a bare subscribeCanvas subscribes the token's canvas and pings flow, slot-filtered", async () => {
    const h = shareHarness({});
    const handle = createConnectionHandler(h.runtime);
    const ws = fakeSocket();
    await handle(ws, { headers: {}, url: "/api/v1/ws?canvasShare=tok-1" });
    assert.equal(ws.closed, null, "token accepted");
    assert.deepEqual(ws.sent[0], { type: "ready" });

    ws.emit("message", JSON.stringify({ type: "subscribeCanvas" }));
    await tick();
    assert.ok(ws.sent.some((m) => m.type === "subscribedCanvas"), "the ack fires without a sessionId");
    assert.ok(h.getPlaneCb(), "plane subscription registered");

    h.getPlaneCb()({ slot: 2, seq: 7, kind: "data", patch: { a: 1 } });
    h.getPlaneCb()({ slot: 1, seq: 9, kind: "data" });
    const live = ws.sent.filter((m) => m.type === "canvasLive");
    assert.equal(live.length, 1, "only the token's slot passes the filter");
    assert.equal(live[0].seq, 7);
});

test("handshake: everything except subscribeCanvas is refused on a share connection", async () => {
    const h = shareHarness({});
    const handle = createConnectionHandler(h.runtime);
    const ws = fakeSocket();
    await handle(ws, { headers: {}, url: "/?canvasShare=tok-1" });
    for (const type of ["subscribeSession", "subscribeLogs", "theme"]) {
        ws.emit("message", JSON.stringify({ type, sessionId: "sess-9" }));
    }
    await tick();
    const errors = ws.sent.filter((m) => m.type === "error" && m.scope === "share");
    assert.equal(errors.length, 3, "each refused loudly");
    assert.ok(!ws.sent.some((m) => m.type === "subscribedSession" || m.type === "subscribedLogs"));
});

test("handshake: a subscribe sent while the token is still being resolved is buffered, not lost", async () => {
    // Browsers send `subscribeCanvas` on `open`, which fires BEFORE the
    // server's async token resolution finishes. Before the early buffer the
    // share view lost its live feed about half the time.
    const h = shareHarness({});
    const handle = createConnectionHandler(h.runtime);
    const ws = fakeSocket();
    const pending = handle(ws, { headers: {}, url: "/?canvasShare=tok-1" });
    ws.emit("message", JSON.stringify({ type: "subscribeCanvas" }));
    await pending;
    await tick();
    await new Promise((r) => setImmediate(r));
    await tick();
    const subscribed = ws.sent.filter((m) => m.type === "subscribedCanvas");
    assert.equal(subscribed.length, 1, "delivered exactly once");
    assert.equal(subscribed[0].sessionId, undefined, "a bearer is never told the session id");
});

test("handshake: a WRONG explicit sessionId is refused; the right one works", async () => {
    const h = shareHarness({});
    const handle = createConnectionHandler(h.runtime);
    const ws = fakeSocket();
    await handle(ws, { headers: {}, url: "/?canvasShare=tok-1" });
    ws.emit("message", JSON.stringify({ type: "subscribeCanvas", sessionId: "some-other-session" }));
    await tick();
    assert.ok(!ws.sent.some((m) => m.type === "subscribedCanvas"), "cross-session subscribe dropped");
    ws.emit("message", JSON.stringify({ type: "subscribeCanvas", sessionId: "sess-9" }));
    await tick();
    assert.ok(ws.sent.some((m) => m.type === "subscribedCanvas"));
});

test("revocation: an open share socket closes within the revalidation interval after reset", async () => {
    process.env.PILOTSWARM_SHARE_REVALIDATE_MS = "30";
    try {
        const h = shareHarness({ revalidate: null }); // second resolve: link is gone
        const handle = createConnectionHandler(h.runtime);
        const ws = fakeSocket();
        await handle(ws, { headers: {}, url: "/?canvasShare=tok-1" });
        assert.equal(ws.closed, null);
        await new Promise((r) => setTimeout(r, 120));
        assert.ok(ws.closed, "revoked link's socket closed");
        assert.equal(ws.closed.code, 4403);
    } finally {
        delete process.env.PILOTSWARM_SHARE_REVALIDATE_MS;
    }
});

test("a bad token still closes with the anonymous 4401", async () => {
    const runtime = { resolveCanvasShareToken: async () => null };
    const handle = createConnectionHandler(runtime);
    const ws = fakeSocket();
    await handle(ws, { headers: {}, url: "/?canvasShare=not-a-link" });
    assert.equal(ws.closed?.code, 4401, "invalid tokens are indistinguishable from missing auth");
});

test("link management ops are session:share — hard-enforced even during the authz dark launch", async () => {
    const { OPERATIONS } = await import("pilotswarm-sdk/api");
    for (const name of ["getCanvasShareLink", "resetCanvasShareLink", "removeCanvasShareLink"]) {
        const op = OPERATIONS.find((o) => o.name === name);
        assert.ok(op, `${name} in the table`);
        assert.equal(op.access, "session:share",
            `${name} must ride the hard-enforced class: a non-owner minting a public token during dark launch would pre-plant a durable, account-free capability`);
    }
});
