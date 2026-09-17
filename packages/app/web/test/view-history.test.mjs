import { test } from "node:test";
import assert from "node:assert/strict";
import { createViewHistory, cleanView, navigationShortcut, viewKey } from "../src/navigation/view-history.js";
const view = id => cleanView({ mode: "workspace", sessionId: String(id) });

test("history retains ten views, clamps ends, and replaces the forward branch", () => {
    const h = createViewHistory();
    for (let i = 0; i < 15; i++) h.visit(view(i));
    assert.equal(h.entries.length, 10); assert.equal(h.entries[0].sessionId, "5");
    assert.equal(h.move(1), null);
    h.move(-1); h.move(-1); assert.equal(h.current.sessionId, "12");
    h.visit(view("new")); assert.equal(h.destination(1), null);
    assert.equal(h.move(-1).sessionId, "12");
    while (h.move(-1));
    assert.equal(h.current.sessionId, "5"); assert.equal(h.index, 0);
});
test("repeated destinations update context without adding visits or losing Forward", () => {
    const h = createViewHistory(); h.visit(view(1)); h.visit(view(2)); h.move(-1);
    assert.equal(h.visit(view(1)), false); assert.equal(h.destination(1).sessionId, "2");
    const a = cleanView({ mode: "moa", dashboardId: "ops", panelId: "one" });
    const b = cleanView({ ...a, panelId: "two" });
    assert.equal(viewKey(a), viewKey(b)); h.visit(a); h.visit(b);
    assert.equal(h.current.panelId, "two"); assert.equal(h.entries.length, 2);
    assert.notEqual(viewKey(a), viewKey({ ...a, dashboardId: "review" }));
});
test("storage round trips the cursor and references, never arbitrary payloads", () => {
    const h = createViewHistory(); h.visit({ ...view(1), prompt: "secret", history: ["private text"] }); h.visit(view(2)); h.move(-1);
    assert.doesNotMatch(h.serialize(), /secret|private text|prompt/);
    const restored = createViewHistory(h.serialize());
    assert.equal(restored.current.sessionId, "1"); assert.equal(restored.destination(1).sessionId, "2");
    for (const invalid of ["broken", "null", JSON.stringify({ version: 1, entries: [{ mode: "evil" }], index: 0 }), JSON.stringify({version:1,entries:[view(1)],index:9})])
        assert.equal(createViewHistory(invalid).entries.length, 0);
});
test("keyboard supports Option-produced characters and both plus keys without hijacking editing", () => {
    const event = extra => ({ altKey: true, code: "Minus", key: "–", ...extra });
    assert.equal(navigationShortcut(event()), -1);
    for (const code of ["Equal", "NumpadAdd"]) assert.equal(navigationShortcut(event({ code, key: "±", shiftKey: true })), 1);
    for (const extra of [{ altKey: false }, { ctrlKey: true }, { metaKey: true }, { repeat: true }, { isComposing: true }, { getModifierState: () => true }, { target: { isContentEditable: true } }, { target: { closest: () => ({}) } }])
        assert.equal(navigationShortcut(event(extra)), 0);
});
