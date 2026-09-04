// Owner badge colours: one per PERSON in a list, stable across reloads and
// panes.
//
// WHY THIS EXISTS: the colour is what tells owners apart (initials collide),
// and the bare hash put three people on near-identical colours — which is
// exactly what a portal screenshot showed. The list-wide assignment walks a
// colliding person to the next free colour, in sorted-key order, so the same
// set of people always gets the same colours.
import test from "node:test";
import assert from "node:assert/strict";
import { assignOwnerBadgeHues, ownerBadgeFor, ownerBadgeHue, ownerHueMapForSessions, OWNER_BADGE_HUES } from "../src/selectors.js";

const people = (n) => Array.from({ length: n }, (_, i) => `person${i}@example.com`);

test("up to a palette's worth of people never share a colour", () => {
    const keys = people(OWNER_BADGE_HUES);
    const hues = [...assignOwnerBadgeHues(keys).values()];
    assert.equal(new Set(hues).size, OWNER_BADGE_HUES, `12 people, 12 colours (got ${hues.join(",")})`);
    // The bare hash does collide on this set — otherwise the test proves nothing.
    const raw = new Set(keys.map(ownerBadgeHue));
    assert.ok(raw.size < OWNER_BADGE_HUES, "the fixture must contain a raw-hash collision to be a real detector");
});

test("the assignment depends only on who is in the list, not on order", () => {
    const a = assignOwnerBadgeHues(["carol@x", "alice@x", "bob@x"]);
    const b = assignOwnerBadgeHues(["bob@x", "carol@x", "alice@x", "ALICE@x"]);
    assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort());
});

test("a person keeps their hash colour unless it is taken; a newcomer takes a free one", () => {
    const solo = assignOwnerBadgeHues(["alice@x"]);
    assert.equal(solo.get("alice@x"), ownerBadgeHue("alice@x"));
    const keys = people(OWNER_BADGE_HUES + 3);
    const hues = assignOwnerBadgeHues(keys);
    assert.equal(hues.size, keys.length, "past the palette everyone still gets a colour");
});

test("session rows and package rows draw the same person in the same colour", () => {
    const owner = (subject, displayName, email) => ({ provider: "github", subject, displayName, email });
    const byId = {
        s1: { sessionId: "s1", owner: owner("a", "Affan Dar", "a@x") },
        s2: { sessionId: "s2", owner: owner("k", "Kingsley Shacklebolt", "k@x") },
        s3: { sessionId: "s3", owner: owner("s", "Sateesh P", "s@x") },
        sys: { sessionId: "sys", isSystem: true, owner: owner("system", "System", "") },
    };
    const map = ownerHueMapForSessions(byId);
    assert.equal(map.size, 3, "system rows do not take a colour");
    assert.equal(ownerHueMapForSessions(byId), map, "memoised on the catalog identity");
    const fromSession = ownerBadgeFor(byId.s2.owner, { hueByKey: map });
    const fromPackage = ownerBadgeFor({ displayName: "Kingsley Shacklebolt", email: "k@x" }, { hueByKey: map });
    assert.equal(fromSession.hue, fromPackage.hue);
    assert.equal(fromSession.name, "Kingsley Shacklebolt", "the tooltip carries the full name");
    assert.equal(new Set([...map.values()]).size, 3, "three people, three colours");
});
