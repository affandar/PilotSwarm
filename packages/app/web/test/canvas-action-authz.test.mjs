// Canvas actions are CREATOR-only — stricter than every other session
// capability. A shared WRITER may send chat; an ADMIN may manage the fleet;
// neither may speak through the canvas, because the canvas mutates: two
// viewers can be looking at different revisions of the same surface, and a
// click on a stale form must never masquerade as the creator's answer.
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

test("the sendMessage handler refuses canvas-action prompts from non-creators, fail-closed", () => {
    const caseStart = RUNTIME.indexOf('case "sendMessage": {');
    assert.ok(caseStart >= 0, "sendMessage must be a guarded block");
    const block = RUNTIME.slice(caseStart, RUNTIME.indexOf('case "sendAnswer"', caseStart));
    assert.match(block, /safeParams\.prompt\.startsWith\("\[canvas-action\] "\)/,
        "the guard keys on the canonical wire prefix");
    assert.match(block, /if \(!snapshot\?\.viewerIsOwner\)/,
        "the predicate is viewerIsOwner — NOT relation/admin/share checks");
    assert.match(block, /forbiddenError\("Canvas actions are accepted only from the session's creator/,
        "the refusal says why and points at the chat box");
    assert.match(block, /gate\.snapshot \?\? await this\._getAccessSnapshot/,
        "a missing gate snapshot is re-resolved, and null still fails closed");
});

test("the predicate: creator passes; shared writers, admins, and unresolvable snapshots refuse", () => {
    // This is the exact expression the handler evaluates.
    const refused = (snapshot) => !snapshot?.viewerIsOwner;

    assert.equal(refused({ viewerIsOwner: true }), false, "the creator may act");
    assert.equal(refused({ viewerIsOwner: false, viewerShareAccess: "write" }), true,
        "a shared WRITER may chat but not act — their canvas view may be stale");
    assert.equal(refused({ viewerIsOwner: false, viewerShareAccess: "read" }), true);
    assert.equal(refused({ viewerIsOwner: false }), true, "admin is not creator; admins type in chat like anyone");
    assert.equal(refused(null), true, "no snapshot = fail closed");
    assert.equal(refused(undefined), true);
});
