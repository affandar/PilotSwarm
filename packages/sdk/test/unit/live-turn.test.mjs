import test from "node:test";
import assert from "node:assert/strict";
import { LatestValuePublisher, LiveTurnCoalescer, mergeLiveText } from "../../dist/live-turn.js";

test("mergeLiveText accepts cumulative snapshots without duplicating text", () => {
    assert.equal(mergeLiveText("hel", "hello"), "hello");
    assert.equal(mergeLiveText("hello", "lo"), "hello");
});

test("explicit delta fragments are always appended, even when they repeat", () => {
    const ticks = [];
    const live = new LiveTurnCoalescer((tick) => ticks.push(tick), { intervalMs: 10_000, charThreshold: 2 });
    live.startTurn();
    live.messageDelta({ messageId: "m1", deltaContent: "ha" });
    live.messageDelta({ messageId: "m1", deltaContent: "ha" });
    live.flushLive();
    assert.equal(ticks.at(-1).text, "haha");
    live.dispose();
});

test("empty and metadata-only payloads cannot reset an accumulated live message", () => {
    const ticks = [];
    const live = new LiveTurnCoalescer(tick => ticks.push(tick), { intervalMs: 10_000, charThreshold: 10_000 });
    live.startTurn();
    live.reasoningDelta({ reasoningId: "r1", deltaContent: "Keep this thought" });
    live.messageDelta({ messageId: "m1", deltaContent: "Hello" });
    for (const payload of [{ totalResponseSizeBytes: 20 }, {}, { id: "event-id", deltaContent: "" }, { messageId: "m2", deltaContent: "" }]) {
        live.messageDelta(payload);
    }
    live.reasoningDelta({ reasoningId: "r2", deltaContent: "" });
    live.messageDelta({ messageId: "m1", deltaContent: " world!" });
    live.flushLive();
    live.dispose();
    assert.equal(ticks.length, 1);
    assert.equal(ticks[0].messageId, "m1");
    assert.equal(ticks[0].text, "Hello world!");
    assert.equal(ticks[0].reasoningText, "Keep this thought");
});

test("live turn coalescer flushes at the character threshold", () => {
    const ticks = [];
    const live = new LiveTurnCoalescer((tick) => ticks.push(tick), { intervalMs: 10_000, charThreshold: 4 });
    live.startTurn();
    live.messageDelta({ messageId: "m1", deltaContent: "he" });
    assert.equal(ticks.length, 0);
    live.messageDelta({ messageId: "m1", deltaContent: "llo" });
    assert.equal(ticks.length, 1);
    assert.equal(ticks[0].text, "hello");
    live.dispose();
});

test("live turn coalescer flushes on cadence and combines reasoning", async () => {
    const ticks = [];
    const live = new LiveTurnCoalescer((tick) => ticks.push(tick), { intervalMs: 5, charThreshold: 10_000 });
    live.startTurn();
    live.reasoningDelta({ reasoningId: "r1", deltaContent: "why " });
    live.messageDelta({ messageId: "m1", deltaContent: "answer" });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(ticks.length, 1);
    assert.equal(ticks[0].reasoningText, "why ");
    assert.equal(ticks[0].text, "answer");
    live.dispose();
});

test("message id changes force separate snapshots and finish clears once", () => {
    const ticks = [];
    const live = new LiveTurnCoalescer((tick) => ticks.push(tick), { intervalMs: 10_000, charThreshold: 10_000 });
    live.startTurn();
    live.messageDelta({ messageId: "m1", deltaContent: "one" });
    live.messageDelta({ messageId: "m2", deltaContent: "two" });
    live.finishTurn();
    live.finishTurn();
    assert.deepEqual(ticks.map((tick) => [tick.phase, tick.messageId, tick.text]), [
        ["live", "m1", "one"],
        ["live", "m2", "two"],
        ["idle", null, ""],
    ]);
    live.dispose();
});

test("latest-value publisher drops intermediate waiting values", async () => {
    const published = [];
    let releaseFirst;
    const first = new Promise((resolve) => { releaseFirst = resolve; });
    const publisher = new LatestValuePublisher(async (value) => {
        published.push(value);
        if (published.length === 1) await first;
    });
    publisher.enqueue(1);
    await new Promise((resolve) => setImmediate(resolve));
    for (let value = 2; value <= 10; value += 1) publisher.enqueue(value);
    releaseFirst();
    await publisher.drain();
    assert.deepEqual(published, [1, 10]);
});

test("latest-value publisher reports errors and continues with the newest value", async () => {
    const published = [];
    const errors = [];
    const publisher = new LatestValuePublisher(async (value) => {
        published.push(value);
        if (value === 1) throw new Error("boom");
    }, (error) => errors.push(error.message));
    publisher.enqueue(1);
    publisher.enqueue(2);
    await publisher.drain();
    assert.deepEqual(published, [1, 2]);
    assert.deepEqual(errors, ["boom"]);
});

test("an error observer cannot leak an ephemeral failure into the durable caller", async () => {
    const publisher = new LatestValuePublisher(
        async () => { throw new Error("live store down"); },
        () => { throw new Error("logger down too"); },
    );
    publisher.enqueue(1);
    await assert.doesNotReject(() => publisher.drain());
});

test("bursts stay bounded by cadence after the first threshold flush", (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
    const ticks = [];
    const live = new LiveTurnCoalescer((tick) => ticks.push(tick), { intervalMs: 100, charThreshold: 4 });
    live.startTurn();
    for (let i = 0; i < 100; i++) live.messageDelta({ messageId: "m1", deltaContent: "abcd" });
    assert.equal(ticks.length, 1);
    t.mock.timers.tick(100);
    assert.equal(ticks.length, 2);
    assert.equal(ticks.at(-1).text.length, 400);
    live.dispose();
});

test("stale cumulative prefixes never duplicate and previews are bounded", () => {
    assert.equal(mergeLiveText("hello world", "hello"), "hello world");
    const ticks = [];
    const live = new LiveTurnCoalescer((tick) => ticks.push(tick));
    live.startTurn();
    live.reasoningDelta({ reasoningId: "r1", deltaContent: "\u0001".repeat(100_000) });
    live.messageDelta({ messageId: "m1", deltaContent: "\u0001".repeat(100_000) });
    live.flushLive();
    assert.equal(ticks.at(-1).truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(ticks.at(-1))) < 262_144);
    assert.equal(ticks.at(-1).text.length, 16_384);
    live.dispose();
});

test("a new reasoning id cannot carry the preceding answer into the next model call", () => {
    const ticks = [];
    const live = new LiveTurnCoalescer((tick) => ticks.push(tick));
    live.startTurn();
    live.reasoningDelta({ reasoningId: "r1", deltaContent: "first thought" });
    live.messageDelta({ messageId: "m1", deltaContent: "first answer" });
    live.reasoningDelta({ reasoningId: "r2", deltaContent: "second thought" });
    live.flushLive();
    assert.equal(ticks.at(-1).messageId, null);
    assert.equal(ticks.at(-1).text, "");
    assert.equal(ticks.at(-1).reasoningText, "second thought");
    live.dispose();
});
