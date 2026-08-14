// PORTAL_LINK_ORIGINS parsing: the one-env-var plug-in surface for
// multi-entry-point deployments (waldemort chk's AFD + VPN pair). Fail-loud
// on anything malformed — a bad config must stop the portal, not ship
// broken links.
import test from "node:test";
import assert from "node:assert/strict";
import { parsePortalLinkOrigins } from "../config.js";

test("the waldemort shape parses: two labeled https origins, order preserved", () => {
    assert.deepEqual(
        parsePortalLinkOrigins("Corporate=https://wdm.example.com,Private/VPN=https://wdm-vpn.example.com"),
        [
            { label: "Corporate", origin: "https://wdm.example.com" },
            { label: "Private/VPN", origin: "https://wdm-vpn.example.com" },
        ],
    );
});

test("absent or empty = feature off", () => {
    assert.deepEqual(parsePortalLinkOrigins(undefined), []);
    assert.deepEqual(parsePortalLinkOrigins(""), []);
    assert.deepEqual(parsePortalLinkOrigins("   "), []);
});

test("exactly one entry is refused — almost certainly a mistake", () => {
    assert.throws(() => parsePortalLinkOrigins("Corp=https://a.test"), /single entry is refused/);
});

test("labels: required, bounded, unique case-insensitively; first = splits label from origin", () => {
    assert.throws(() => parsePortalLinkOrigins("=https://a.test,B=https://b.test"), /must be Label=Origin/);
    assert.throws(() => parsePortalLinkOrigins(`${"x".repeat(41)}=https://a.test,B=https://b.test`), /1-40 characters/);
    assert.throws(() => parsePortalLinkOrigins("Corp=https://a.test,corp=https://b.test"), /duplicated/);
});

test("origins: bare https (http only for localhost), no path/query/credentials, distinct", () => {
    assert.throws(() => parsePortalLinkOrigins("A=http://a.test,B=https://b.test"), /must be https/);
    assert.deepEqual(
        parsePortalLinkOrigins("Local=http://localhost:3001,Edge=https://edge.test")[0],
        { label: "Local", origin: "http://localhost:3001" },
    );
    assert.throws(() => parsePortalLinkOrigins("A=https://a.test/path,B=https://b.test"), /bare origin/);
    assert.throws(() => parsePortalLinkOrigins("A=https://a.test?q=1,B=https://b.test"), /bare origin/);
    assert.throws(() => parsePortalLinkOrigins("A=https://u:p@a.test,B=https://b.test"), /bare origin/);
    assert.throws(() => parsePortalLinkOrigins("A=https://a.test,B=https://a.test"), /duplicated/);
    assert.throws(() => parsePortalLinkOrigins("A=nonsense,B=https://b.test"), /not a valid URL/);
});

test("at most six entries", () => {
    const many = Array.from({ length: 7 }, (_, i) => `L${i}=https://h${i}.test`).join(",");
    assert.throws(() => parsePortalLinkOrigins(many), /at most 6/);
});
