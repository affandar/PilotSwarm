// A duroxide activity retry re-records the SAME queued user message as a
// second durable user.message event (observed live: seq pair 12.4s apart on
// waldemort-chk, 2026-07-22). The transcript must collapse the pair into ONE
// bubble stamped with the LATEST delivery time and marked `redelivered` (the
// selectors render an amber ✓✓↻ instead of the green ✓✓). A user deliberately
// re-sending identical text mints fresh clientMessageIds and must stay two
// bubbles. Also covers day-aware chat timestamps: same-day renders time only,
// older messages carry their date (plus year when it differs).
import test from "node:test";
import assert from "node:assert/strict";
import { buildHistoryModel, dedupeChatMessages, formatTimestamp } from "../src/index.js";

const T0 = Date.UTC(2026, 6, 22, 16, 3, 3);

function userEvt(seq, createdAt, content, clientMessageIds) {
    return {
        sessionId: "s1",
        seq,
        eventType: "user.message",
        data: { content, ...(clientMessageIds ? { clientMessageIds } : {}) },
        createdAt,
    };
}

test("activity-retry redelivery collapses to one bubble with the latest timestamp", () => {
    const history = buildHistoryModel([
        userEvt(100, T0, "just did, check if it worked", ["cm-1"]),
        userEvt(124, T0 + 12_434, "just did, check if it worked", ["cm-1"]),
    ]);
    assert.equal(history.chat.length, 1);
    const message = history.chat[0];
    assert.equal(message.redelivered, true);
    assert.equal(message.createdAt, T0 + 12_434); // latest delivery wins
    assert.equal(message.firstDeliveredAt, T0);
});

test("matching clientMessageIds collapse regardless of retry latency", () => {
    const history = buildHistoryModel([
        userEvt(100, T0, "run the checks", ["cm-9"]),
        userEvt(190, T0 + 95_000, "run the checks", ["cm-9"]),
    ]);
    assert.equal(history.chat.length, 1);
    assert.equal(history.chat[0].redelivered, true);
});

test("a deliberate identical re-send (fresh ids) stays two bubbles", () => {
    const history = buildHistoryModel([
        userEvt(100, T0, "yes", ["cm-1"]),
        userEvt(101, T0 + 4_000, "yes", ["cm-2"]),
    ]);
    assert.equal(history.chat.length, 2);
    assert.ok(!history.chat[0].redelivered);
    assert.ok(!history.chat[1].redelivered);
});

test("id-less duplicates keep the legacy 10s window and gain the redelivered mark", () => {
    const collapsed = buildHistoryModel([
        userEvt(100, T0, "hello"),
        userEvt(101, T0 + 8_000, "hello"),
    ]);
    assert.equal(collapsed.chat.length, 1);
    assert.equal(collapsed.chat[0].redelivered, true);

    const kept = buildHistoryModel([
        userEvt(100, T0, "hello"),
        userEvt(101, T0 + 12_000, "hello"),
    ]);
    assert.equal(kept.chat.length, 2);
});

test("a third redelivery keeps the original firstDeliveredAt", () => {
    const chat = dedupeChatMessages([
        { role: "user", text: "x", createdAt: T0, clientMessageIds: ["cm-1"] },
        { role: "user", text: "x", createdAt: T0 + 10_000, clientMessageIds: ["cm-1"] },
        { role: "user", text: "x", createdAt: T0 + 25_000, clientMessageIds: ["cm-1"] },
    ]);
    assert.equal(chat.length, 1);
    assert.equal(chat[0].createdAt, T0 + 25_000);
    assert.equal(chat[0].firstDeliveredAt, T0);
});

test("chat timestamps: same-day is time-only, older days carry the date", () => {
    const now = new Date(2026, 6, 22, 18, 0, 0); // local 2026-07-22
    const sameDay = new Date(2026, 6, 22, 9, 3, 3);
    const previousDay = new Date(2026, 6, 21, 9, 3, 3);
    const previousYear = new Date(2025, 11, 31, 9, 3, 3);

    assert.match(formatTimestamp(sameDay, now), /^09:03:03$/);
    assert.match(formatTimestamp(previousDay, now), /^21 Jul 09:03:03$/);
    assert.match(formatTimestamp(previousYear, now), /^31 Dec 2025 09:03:03$/);
});
