// The "↑ Load older messages" button must appear whenever older history
// exists — not only once a session has grown past the auto-expand soft cap.
//
// WHY: cold-open loads only the newest DEFAULT_HISTORY_EVENT_LIMIT (300) raw
// events, so an ordinary busy session (hundreds of tool/status events across a
// dozen turns) opens showing only the tail. The original prompt and early
// turns sit below that window. The button that advertises "there is more"
// used to be gated on loadedEventCount >= AUTO_HISTORY_EVENT_SOFT_CAP (3000),
// which a 300-event cold load never meets — so for real sessions the affordance
// never rendered and the head was unreachable except by an invisible
// scroll-to-top gesture. Gate it on hasOlderEvents instead, so the head is
// always one discoverable click away.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const webApp = read("../../react/src/web-app.js");

test("the load-older button is gated on hasOlderEvents", () => {
    assert.match(
        webApp,
        /const showLoadOlder = Boolean\(viewState\.activeHistory\?\.hasOlderEvents\)/,
        "the button must render whenever older history exists",
    );
});

test("the load-older gate does not depend on the auto-expand soft cap", () => {
    const gateLine = webApp
        .split("\n")
        .find((line) => line.includes("const showLoadOlder ="));
    assert.ok(gateLine, "expected a showLoadOlder declaration");
    assert.doesNotMatch(
        gateLine,
        /AUTO_HISTORY_EVENT_SOFT_CAP|loadedEventCount/,
        "the visibility gate must not re-introduce the soft-cap / loadedEventCount condition",
    );
});
