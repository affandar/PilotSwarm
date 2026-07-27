// Desktop and mobile keep SEPARATE chat-view preferences. The profile save
// endpoint REPLACES the settings object, so the device that is saving must
// write the other device class's slot back verbatim — otherwise toggling on a
// laptop silently erases the phone's choice.
//
// These mirror the helpers in web-app.js; they encode the contract the save
// path depends on, which is otherwise only expressible in a browser.
import test from "node:test";
import assert from "node:assert/strict";

const isChatViewMode = (v) => v === "summary" || v === "transcript" || v === "rich";
const keyFor = (narrow) => (narrow ? "chatViewModeMobile" : "chatViewMode");
const otherKeyFor = (narrow) => (narrow ? "chatViewMode" : "chatViewModeMobile");

/** What profileSettingsFromViewState builds for one device. */
function buildPayload({ narrow, liveMode, preservedOther }) {
    return {
        [keyFor(narrow)]: liveMode,
        ...(isChatViewMode(preservedOther) ? { [otherKeyFor(narrow)]: preservedOther } : {}),
    };
}

test("desktop save preserves the mobile slot", () => {
    const payload = buildPayload({ narrow: false, liveMode: "rich", preservedOther: "transcript" });
    assert.equal(payload.chatViewMode, "rich");
    assert.equal(payload.chatViewModeMobile, "transcript", "phone preference survives a desktop save");
});

test("mobile save preserves the desktop slot", () => {
    const payload = buildPayload({ narrow: true, liveMode: "transcript", preservedOther: "rich" });
    assert.equal(payload.chatViewModeMobile, "transcript");
    assert.equal(payload.chatViewMode, "rich", "desktop preference survives a mobile save");
});

test("an unknown other slot is omitted, never written as junk", () => {
    const payload = buildPayload({ narrow: false, liveMode: "rich", preservedOther: null });
    assert.equal(Object.prototype.hasOwnProperty.call(payload, "chatViewModeMobile"), false);
    const bogus = buildPayload({ narrow: false, liveMode: "rich", preservedOther: "nonsense" });
    assert.equal(Object.prototype.hasOwnProperty.call(bogus, "chatViewModeMobile"), false);
});

test("each device reads its own slot", () => {
    const stored = { chatViewMode: "rich", chatViewModeMobile: "transcript" };
    assert.equal(stored[keyFor(false)], "rich", "desktop reads chatViewMode");
    assert.equal(stored[keyFor(true)], "transcript", "mobile reads chatViewModeMobile");
});

test("a round trip through both devices loses nothing", () => {
    // desktop saves, then mobile saves reading what desktop wrote
    const afterDesktop = buildPayload({ narrow: false, liveMode: "summary", preservedOther: "transcript" });
    const afterMobile = buildPayload({
        narrow: true,
        liveMode: "rich",
        preservedOther: afterDesktop[otherKeyFor(true)],
    });
    assert.equal(afterMobile.chatViewMode, "summary", "desktop's choice round-tripped");
    assert.equal(afterMobile.chatViewModeMobile, "rich", "mobile's new choice stored");
});
