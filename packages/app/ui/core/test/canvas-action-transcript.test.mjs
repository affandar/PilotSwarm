// What a canvas button press looks like in the transcript once the runtime
// has finished with it.
//
// A press does not reach history as the bare `[canvas-action] {…}` the browser
// sent. By the time it is an event, two other layers have written on it:
//
//   1. Multi-writer attribution prefixes `[FROM: Ada Admin (admin)]`.
//   2. An interrupted timer appends `[SYSTEM: … timer …]` to the same text.
//   3. The forged-marker neutralizer inserts a ZERO-WIDTH SPACE after `[` in
//      any `[SYSTEM:` when the sender is not the session owner — and it runs
//      AFTER step 2, so it defangs the runtime's OWN notice.
//
// Both bugs this pins were visible at once in a shared session: the press
// printed as an ordinary chat line showing raw JSON, and the timer notice
// printed as prose under it.
import test from "node:test";
import assert from "node:assert/strict";
import { buildHistoryModel } from "../src/history.js";
import { selectChatLines } from "../src/selectors.js";
import { appReducer, createInitialState, createStore, PilotSwarmUiController } from "../src/index.js";

const ZWSP = "​";
const NOTICE = "The above is a message that interrupted your 21600s timer "
    + '(reason: "no provider"). 560s elapsed, 21040s remain. '
    + "Reply to the message. The timer will be automatically resumed after your reply.";

function userEvent(seq, content) {
    return {
        seq,
        sessionId: "s1",
        eventType: "user.message",
        createdAt: new Date("2026-08-24T19:37:00Z").toISOString(),
        data: { content },
    };
}

/** The exact bytes a collaborator's press has by the time it is stored. */
function attributedPress(id, { defanged = true, attributed = true, notice = true } = {}) {
    const marker = defanged ? `[${ZWSP}SYSTEM:` : "[SYSTEM:";
    return [
        attributed ? "[FROM: Ada Admin (admin)]\n" : "",
        `[canvas-action] {"action":"request","data":{"id":"${id}"}}`,
        notice ? `\n\n${marker} ${NOTICE}]` : "",
    ].join("");
}

function chatOf(content) {
    return buildHistoryModel([userEvent(4, content)]).chat;
}

/** A live session carrying one event, rendered the way the portal renders it. */
function linesFor(content, maxWidth = 120) {
    let state = createInitialState();
    state = appReducer(state, { type: "sessions/loaded", sessions: [{ sessionId: "s1", title: "T" }] });
    state = appReducer(state, { type: "sessions/selected", sessionId: "s1" });
    const controller = new PilotSwarmUiController({
        store: createStore(appReducer, state),
        transport: {
            listSessions: async () => [],
            subscribeSession: () => () => {},
            getCurrentUserProfile: async () => ({ provider: "t", subject: "u", profileSettings: {} }),
        },
    });
    controller.mergeSessionEvent("s1", userEvent(9, content));
    return selectChatLines(controller.getState(), maxWidth);
}

// ── classification ──────────────────────────────────────────────────────────

test("an attributed press with a defanged notice is still a canvas action", () => {
    const chat = chatOf(attributedPress("mt820mzl-gt4p"));
    const item = chat.find((m) => m?.kind === "canvas-action");
    assert.ok(item, "the press must classify as canvas-action, not an ordinary message");
    assert.equal(item.action, "request");
    assert.deepEqual(item.data, { id: "mt820mzl-gt4p" });
});

test("the raw JSON payload never reaches the transcript as message text", () => {
    for (const opts of [{}, { defanged: false }, { notice: false }, { attributed: false }]) {
        const chat = chatOf(attributedPress("abc", opts));
        const prose = chat.filter((m) => m?.kind !== "canvas-action").map((m) => m.text || "").join("\n");
        assert.doesNotMatch(prose, /\[canvas-action\]/, `raw JSON leaked with ${JSON.stringify(opts)}`);
        assert.doesNotMatch(prose, /"action":"request"/, `raw payload leaked with ${JSON.stringify(opts)}`);
    }
});

// ── the system notice ───────────────────────────────────────────────────────

test("a defanged system notice is hidden from chat, exactly like a clean one", () => {
    for (const defanged of [true, false]) {
        const chat = chatOf(attributedPress("abc", { defanged }));
        const prose = chat.map((m) => m.text || "").join("\n");
        assert.doesNotMatch(prose, /interrupted your 21600s timer/,
            `the ${defanged ? "defanged" : "clean"} notice must not print as prose`);
        assert.doesNotMatch(prose, /SYSTEM:/, "the marker itself must not print");
    }
});

test("a defanged notice on a PLAIN message is hidden too — not just on canvas actions", () => {
    const chat = chatOf(`[FROM: Ada Admin (admin)]\nship it\n\n[${ZWSP}SYSTEM: ${NOTICE}]`);
    const prose = chat.map((m) => m.text || "").join("\n");
    assert.match(prose, /ship it/, "the human's actual words must survive");
    assert.doesNotMatch(prose, /interrupted your 21600s timer/);
});

test("the hidden notice is kept — it moves to the activity feed, both spellings", () => {
    for (const defanged of [true, false]) {
        const model = buildHistoryModel([userEvent(4, attributedPress("abc", { defanged }))]);
        const activity = model.activity.map((a) => JSON.stringify(a)).join("");
        assert.match(activity, /interrupted your 21600s timer/,
            `the ${defanged ? "defanged" : "clean"} notice must still be recorded in activity`);
    }
});

// ── the rendered line ───────────────────────────────────────────────────────

test("the press renders as a flagged line carrying its name and full payload", () => {
    const lines = linesFor(attributedPress("mt820mzl-gt4p"));
    const line = lines.find((l) => l?.canvasAction);
    assert.ok(line, "the transcript must carry a canvasAction-flagged line");
    assert.equal(line.canvasActionName, "request");
    // The portal opens this row to show the payload, so it must be the whole
    // object — not the 120-char summary the TUI runs are truncated to.
    assert.match(line.canvasActionPayload, /"id": "mt820mzl-gt4p"/);
    assert.doesNotMatch(JSON.stringify(lines), /\[canvas-action\]/,
        "no rendered line may show the raw wire format");
});

test("a long payload stays whole in the body while the one-line summary truncates", () => {
    const note = "x".repeat(400);
    const content = `[FROM: Ada Admin (admin)]\n[canvas-action] ${JSON.stringify({
        action: "store",
        data: { id: "req-9", note, kind: "artifact" },
    })}`;
    const line = linesFor(content).find((l) => l?.canvasAction);
    assert.ok(line);
    // The collapsed row must stay one line…
    assert.ok(line.canvasActionDetail.length <= 120, "the summary detail must be truncated");
    // …but opening it shows every field, or the row is useless for diagnosis.
    assert.match(line.canvasActionPayload, /"kind": "artifact"/);
    assert.ok(line.canvasActionPayload.includes(note), "the full note must survive into the body");
});
