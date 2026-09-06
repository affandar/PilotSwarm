// Canvas actions ring the agent's doorbell. Who may ring is who may WRITE
// the session — the owner, an admin, a write-shared collaborator, or anyone
// on a shared_write session (interactive-canvas-apps Part E: they can
// already send a chat message, so an action is no new power). Read-only
// viewers and link bearers are refused; their requests land in the canvas
// KV as `suggested` and wait for the owner instead.
//
// The wire marker is the `[canvas-action] ` prompt prefix the browser bridge
// stamps on validated actions. It is trivially forgeable by any API caller,
// so enforcement lives in the web runtime's sendMessage handler — these tests
// pin (a) that the guard is wired there, on the exact predicate, and (b) what
// that predicate answers for every persona.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = fs.readFileSync(path.join(__dirname, "..", "runtime.js"), "utf8");

test("the sendMessage handler gates canvas-action prompts on session WRITE, fail-closed", () => {
    const caseStart = RUNTIME.indexOf('case "sendMessage": {');
    assert.ok(caseStart >= 0, "sendMessage must be a guarded block");
    const block = RUNTIME.slice(caseStart, RUNTIME.indexOf('case "sendAnswer"', caseStart));
    assert.match(block, /safeParams\.prompt\.startsWith\("\[canvas-action\] "\)/,
        "the guard keys on the canonical wire prefix");
    assert.match(block, /snapshot\.viewerIsOwner \|\| this\._resourceAdmin\(isAdmin, snapshot\)\s*\|\| snapshot\.viewerShareAccess === "write" \|\| snapshot\.visibility === "shared_write"/,
        "the predicate is session write: owner, resource-authorized admin, write share, or shared_write visibility");
    assert.match(block, /if \(!mayRing\)/);
    assert.match(block, /forbiddenError\("Canvas actions are accepted only from people who can write this session/,
        "the refusal says why and points at the chat box");
    assert.match(block, /gate\.snapshot \?\? await this\._getAccessSnapshot/,
        "a missing gate snapshot is re-resolved, and null still fails closed");
});

test("the predicate: owner, admin and writers pass; readers, strangers and unresolvable snapshots refuse", () => {
    // This is the exact expression the handler evaluates.
    const mayRing = (snapshot, isAdmin = false) => Boolean(snapshot) && (
        snapshot.viewerIsOwner || isAdmin
        || snapshot.viewerShareAccess === "write" || snapshot.visibility === "shared_write");

    assert.equal(mayRing({ viewerIsOwner: true }), true, "the owner may act");
    assert.equal(mayRing({ viewerIsOwner: false, viewerShareAccess: "write" }), true, "a write-shared collaborator may act");
    assert.equal(mayRing({ viewerIsOwner: false, visibility: "shared_write" }), true, "shared_write visibility is session write");
    assert.equal(mayRing({ viewerIsOwner: false }, true), true, "an admin may act");
    assert.equal(mayRing({ viewerIsOwner: false, viewerShareAccess: "read" }), false, "a reader suggests, never rings");
    assert.equal(mayRing({ viewerIsOwner: false, visibility: "shared_read" }), false);
    assert.equal(mayRing({ viewerIsOwner: false }), false, "a stranger");
    assert.equal(mayRing(null), false, "no snapshot = fail closed");
    assert.equal(mayRing(undefined), false);
});

test("the client no longer pre-refuses non-owners: the server decides", () => {
    const CONTROLLER = fs.readFileSync(path.join(__dirname, "..", "..", "ui", "core", "src", "controller.js"), "utf8");
    const start = CONTROLLER.indexOf("submitCanvasAction(sessionId, message, slot = 1)");
    assert.ok(start >= 0);
    const body = CONTROLLER.slice(start, start + 2500);
    assert.doesNotMatch(body, /only the session's creator can use canvas controls/,
        "a write-shared collaborator's click must reach the server");
});
