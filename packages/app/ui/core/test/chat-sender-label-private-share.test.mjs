// A session shared with ONE person (a targeted share, visibility still
// "private") is a shared session. The owner viewing it must see the other
// person's messages under that person's name, not as "You".
//
// Bug this pins (chk, 2026-09-03): the transcript only named speakers when
// the session was deployment-visible or the viewer was not the owner. A
// private session the owner shared with a writer failed both checks, so the
// writer's message rendered as "You:" in the owner's portal.
import test from "node:test";
import assert from "node:assert/strict";
import { selectChatLines } from "../src/index.js";

const SESSION_ID = "s1";
const OWNER = { provider: "entra", subject: "owner-1", displayName: "Affan Dar" };
const WRITER = { kind: "user", provider: "entra", subject: "writer-1", display: "Sasha Nath", relation: "collaborator" };

function makeState({ chat, principal = OWNER, visibility = "private" }) {
    return {
        sessions: {
            activeSessionId: SESSION_ID,
            byId: { [SESSION_ID]: { sessionId: SESSION_ID, owner: OWNER, visibility } },
        },
        history: { bySessionId: new Map([[SESSION_ID, { chat, activity: [], events: [] }]]) },
        ui: {},
        branding: null,
        auth: { principal },
    };
}

const text = (line) => (Array.isArray(line) ? line.map((r) => r?.text || "").join("") : String(line?.text || ""));
const labels = (lines) => lines.map(text).filter((t) => /^(\[[^\]]*\] )?(✓✓ )?[^:]+: /.test(t)).map((t) => t.replace(/^\[[^\]]*\] /, "").replace(/^✓✓ /, "").replace(/:.*$/, ""));

test("owner viewing a privately shared session sees the writer's name, not You", () => {
    const chat = [
        { id: "m1", role: "user", text: "mine", sender: { kind: "user", ...OWNER, display: "Affan Dar", relation: "owner" } },
        { id: "m2", role: "user", text: "theirs", sender: WRITER },
    ];
    const found = labels(selectChatLines(makeState({ chat }), 200));
    assert.deepEqual(found, ["You (owner)", "Sasha Nath"]);
});

test("a solo private session stays plain You", () => {
    const chat = [{ id: "m1", role: "user", text: "mine", sender: { kind: "user", ...OWNER, display: "Affan Dar", relation: "owner" } }];
    const found = labels(selectChatLines(makeState({ chat }), 200));
    assert.deepEqual(found, ["You"]);
});

test("the writer viewing the same session sees the owner named and themselves as You", () => {
    const chat = [
        { id: "m1", role: "user", text: "mine", sender: { kind: "user", ...OWNER, display: "Affan Dar", relation: "owner" } },
        { id: "m2", role: "user", text: "theirs", sender: WRITER },
    ];
    const principal = { provider: "entra", subject: "writer-1", displayName: "Sasha Nath" };
    const found = labels(selectChatLines(makeState({ chat, principal }), 200));
    assert.deepEqual(found, ["Affan Dar (owner)", "You"]);
});
