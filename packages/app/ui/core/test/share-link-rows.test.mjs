// Share dialogs, multi-origin edition.
//
// The first cut put every labeled URL in ONE read-only textarea with one Copy
// button, so a sender who knew the recipient's network still had to hand over
// both links (or hand-select out of a monospace blob). Now each entry point is
// its own labeled box with its own Copy, and a Copy all takes the labeled set.
// Single-origin deployments must stay exactly as they were: one bare box, one
// Copy, no labels and no Copy all to explain.
import test from "node:test";
import assert from "node:assert/strict";
import { buildPortalLinks, formatPortalLinksForCopy } from "../src/portal-links.js";

const ORIGINS = [
    { label: "Corporate", origin: "https://corp.example" },
    { label: "Private/VPN", origin: "https://vpn.example" },
];
const URL_IN = "https://sender.example/?session=abc&view=canvas&slot=1&max=1";

test("each origin yields its own copyable URL, path and query preserved", () => {
    const links = buildPortalLinks(URL_IN, ORIGINS);
    assert.equal(links.length, 2);
    assert.deepEqual(links.map((l) => l.label), ["Corporate", "Private/VPN"]);
    // Every per-box Copy writes ONE bare URL — no label prefix, nothing to trim.
    assert.equal(links[0].url, "https://corp.example/?session=abc&view=canvas&slot=1&max=1");
    assert.equal(links[1].url, "https://vpn.example/?session=abc&view=canvas&slot=1&max=1");
    for (const link of links) assert.ok(!link.url.includes(link.label), "a per-origin URL must not carry its label");
});

test("Copy all writes the labeled set, one line per origin", () => {
    const text = formatPortalLinksForCopy(buildPortalLinks(URL_IN, ORIGINS));
    assert.deepEqual(text.split("\n"), [
        "Corporate: https://corp.example/?session=abc&view=canvas&slot=1&max=1",
        "Private/VPN: https://vpn.example/?session=abc&view=canvas&slot=1&max=1",
    ]);
});

test("single-origin deployments render one unlabeled row and copy a bare URL", () => {
    for (const origins of [[], [{ label: "Only", origin: "https://only.example" }], null]) {
        const links = buildPortalLinks(URL_IN, origins);
        assert.equal(links.length, 1, "fewer than two origins must collapse to one row");
        assert.equal(links[0].label, null, "the lone row carries no label");
        assert.equal(links[0].url, URL_IN, "and keeps the URL as produced");
        // No labeled lines, so nothing for a Copy all to add.
        assert.equal(formatPortalLinksForCopy(links), URL_IN);
    }
});

test("canvas share token links rebase per origin — one token, several doors", () => {
    const tokenUrl = "https://sender.example/?canvasShare=tok_abc123";
    const links = buildPortalLinks(tokenUrl, ORIGINS);
    assert.equal(links.length, 2);
    for (const link of links) {
        assert.match(link.url, /\?canvasShare=tok_abc123$/, "the token must survive rebasing");
    }
});
