// decorateArtifactLinksForChat runs from ~8 call sites and some paths decorate
// the same text twice. Without idempotence the second pass re-decorated the
// artifact:// URI sitting inside the link TARGET the first pass produced,
// yielding a nested link whose href was "[artifact: f](artifact://…". The
// browser resolved that as a RELATIVE url and navigated away from the SPA.
import test from "node:test";
import assert from "node:assert/strict";
import { decorateArtifactLinksForChat } from "../src/formatting.js";

const SESSION = "f88bf993-58d6-4d0a-a83f-29cba375ffa3";
const RAW = `see artifact://${SESSION}/markdown-kitchen-sink.md ok`;

test("decorating twice is identical to decorating once", () => {
    const once = decorateArtifactLinksForChat(RAW);
    assert.equal(decorateArtifactLinksForChat(once), once, "second pass must be a no-op");
    assert.equal(decorateArtifactLinksForChat(decorateArtifactLinksForChat(once)), once, "and a third");
});

test("the produced href is a bare artifact:// uri", () => {
    const once = decorateArtifactLinksForChat(RAW);
    const href = /\]\(([^)]+)\)/.exec(once)?.[1];
    assert.equal(href, `artifact://${SESSION}/markdown-kitchen-sink.md`);
    assert.ok(!href.includes("["), "href must never contain a nested markdown link");
});

test("no nesting survives repeated decoration of multiple artifacts", () => {
    const raw = `a artifact://${SESSION}/one.md b artifact://${SESSION}/two.png c`;
    let text = decorateArtifactLinksForChat(raw);
    for (let i = 0; i < 5; i += 1) text = decorateArtifactLinksForChat(text);
    const hrefs = [...text.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
    assert.equal(hrefs.length, 2, "one href per artifact");
    for (const href of hrefs) {
        assert.match(href, /^artifact:\/\//, `clean href, got ${href}`);
    }
});
