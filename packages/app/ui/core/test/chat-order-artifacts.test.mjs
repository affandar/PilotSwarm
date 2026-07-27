// Stepping through a chat-opened preview follows the CONVERSATION order, not
// the Files list order (which is sorted for browsing). Two distinct sequences;
// neither can be derived from the other.
import test from "node:test";
import assert from "node:assert/strict";
import { selectChatOrderedArtifactIds } from "../src/selectors.js";

const S = "aaaaaaaa-1111-2222-3333-444444444444";
const ev = (content) => ({ eventType: "assistant.message", data: { content } });

const stateWith = (events) => ({
    sessions: { activeSessionId: S, byId: { [S]: { sessionId: S } }, flat: [{ sessionId: S }] },
    history: { bySessionId: new Map([[S, { events }]]) },
});

test("returns artifacts in transcript order, not alphabetical", () => {
    const ids = selectChatOrderedArtifactIds(stateWith([
        ev(`see artifact://${S}/zebra.md here`),
        ev(`then artifact://${S}/alpha.md`),
    ]));
    assert.deepEqual(ids, [`${S}/zebra.md`, `${S}/alpha.md`], "conversation order wins");
});

test("de-duplicates repeated references, keeping first mention", () => {
    const ids = selectChatOrderedArtifactIds(stateWith([
        ev(`artifact://${S}/a.md`),
        ev(`artifact://${S}/b.md`),
        ev(`again artifact://${S}/a.md`),
    ]));
    assert.deepEqual(ids, [`${S}/a.md`, `${S}/b.md`]);
});

test("handles several artifacts in one message", () => {
    const ids = selectChatOrderedArtifactIds(stateWith([
        ev(`artifact://${S}/one.diff and artifact://${S}/two.diff`),
    ]));
    assert.deepEqual(ids, [`${S}/one.diff`, `${S}/two.diff`]);
});

test("no active session or no references yields nothing", () => {
    assert.deepEqual(selectChatOrderedArtifactIds({ sessions: {}, history: { bySessionId: new Map() } }), []);
    assert.deepEqual(selectChatOrderedArtifactIds(stateWith([ev("no artifacts here")])), []);
});
