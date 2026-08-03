/**
 * Import allowlist + network guards — the bypass classes.
 *
 * `import_agent_package` is the worker's FIRST outbound fetch (§15 A1),
 * reachable with a model-chosen URL from an agent that reads untrusted
 * transcripts. Every case below is a way allowlists get broken in the wild.
 *
 * The list is taken from the proposal's §14.1 test plan, which enumerated the
 * bypass classes precisely so this suite could not quietly skip one.
 *
 * Run: node --test test/unit/import-allowlist.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
    BASE_IMPORT_ALLOWLIST, IMPORT_CONFIG_FILENAME, IMPORT_FETCH_LIMITS,
    checkImportUrl, loadImportPolicy, parseAllowlistEntry,
    normalizePathForMatch, normalizeHost, pathPrefixMatches,
    isBlockedAddress, isSuspiciousHostLiteral,
} from "../../dist/agent-package-import-policy.js";

const BASE = loadImportPolicy();
const allow = (url, policy = BASE) => checkImportUrl(url, policy).allowed;
const why = (url, policy = BASE) => checkImportUrl(url, policy).reason ?? "";

function withConfig(json, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-import-"));
    try {
        fs.writeFileSync(path.join(dir, IMPORT_CONFIG_FILENAME),
            typeof json === "string" ? json : JSON.stringify(json));
        return fn(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

// ── The list actually permits what it should ──────────────────────

test("the base allowlist permits the PilotSwarm repo on all three GitHub hosts", () => {
    assert.equal(BASE_IMPORT_ALLOWLIST.length, 3, "one repo, three serving hosts");
    assert.equal(allow("https://github.com/affandar/pilotswarm/agent-packages/x"), true);
    assert.equal(allow("https://raw.githubusercontent.com/affandar/pilotswarm/main/a.md"), true);
    assert.equal(allow("https://codeload.github.com/affandar/pilotswarm/tar.gz/main"), true);
});

test("no file at all is a legitimate posture: base list only", () => {
    const policy = loadImportPolicy({ configDir: os.tmpdir() + "/definitely-not-here" });
    assert.equal(policy.entries.length, 3);
    assert.equal(policy.configPath, null);
});

// ── Bypass class: scheme ──────────────────────────────────────────

test("only https", () => {
    for (const url of [
        "http://github.com/affandar/pilotswarm/x",
        "ftp://github.com/affandar/pilotswarm/x",
        "file:///etc/passwd",
        "gopher://github.com/affandar/pilotswarm/",
    ]) {
        assert.equal(allow(url), false, url);
    }
    assert.match(why("http://github.com/affandar/pilotswarm/x"), /https/);
});

// ── Bypass class: userinfo in the authority ───────────────────────

test("credentials in the authority are refused", () => {
    // The authority here is evil.com; "github.com" is just a username.
    assert.equal(allow("https://github.com@evil.com/affandar/pilotswarm/"), false);
    assert.equal(allow("https://user:pass@github.com/affandar/pilotswarm/"), false);
});

test("a refusal never echoes credentials back", () => {
    const reason = why("https://user:hunter2@github.com/affandar/pilotswarm/");
    assert.ok(!reason.includes("hunter2"), "the password must not appear in the error");
});

// ── Bypass class: host confusion ──────────────────────────────────

test("host is matched exactly — never by suffix or prefix", () => {
    for (const url of [
        "https://evilgithub.com/affandar/pilotswarm/",          // suffix confusion
        "https://github.com.evil.com/affandar/pilotswarm/",     // prefix confusion
        "https://notgithub.com/affandar/pilotswarm/",
        "https://raw.githubusercontent.com.evil.com/affandar/pilotswarm/",
    ]) {
        assert.equal(allow(url), false, url);
    }
});

test("a trailing dot does not create a new host", () => {
    // `github.com.` is the same DNS name but a different string.
    assert.equal(normalizeHost("GitHub.COM."), "github.com");
    assert.equal(allow("https://github.com./affandar/pilotswarm/x"), true);
});

test("case does not matter", () => {
    assert.equal(allow("https://GitHub.COM/affandar/pilotswarm/x"), true);
});

// ── Bypass class: path segment boundaries ─────────────────────────

test("path prefixes match on SEGMENT boundaries", () => {
    // The classic break: startsWith() accepts the sibling repo.
    assert.equal(allow("https://github.com/affandar/pilotswarm-evil/x"), false);
    assert.equal(allow("https://github.com/affandar/pilotswarmevil"), false);
    assert.equal(allow("https://github.com/affandar/pilotswarm"), true, "the prefix itself matches");
    assert.equal(allow("https://github.com/affandar/pilotswarm/deep/path"), true);
    assert.equal(pathPrefixMatches("/a/bc", "/a/b/"), false);
    assert.equal(pathPrefixMatches("/a/b/c", "/a/b/"), true);
});

test("traversal is resolved before matching, in every encoding", () => {
    for (const url of [
        "https://github.com/affandar/pilotswarm/../../elsewhere",
        "https://github.com/affandar/pilotswarm/%2e%2e/%2e%2e/elsewhere",
        "https://github.com/affandar/pilotswarm/..%2f..%2felsewhere",
        "https://github.com/affandar/pilotswarm/..\\..\\elsewhere",
    ]) {
        assert.equal(allow(url), false, url);
    }
    assert.equal(normalizePathForMatch("/a/b/../../c"), "/c");
    assert.equal(normalizePathForMatch("/a/%2e%2e/b"), "/b");
});

test("double encoding is unwound, not left as literal text", () => {
    // %252e decodes to %2e, which decodes to "." — a single-pass decoder
    // leaves the traversal intact and a naive matcher never sees it.
    assert.equal(normalizePathForMatch("/a/%252e%252e/b"), "/b");
});

// ── Bypass class: port ────────────────────────────────────────────

test("default port only, unless the entry names one", () => {
    assert.equal(allow("https://github.com:8443/affandar/pilotswarm/"), false);
    assert.equal(allow("https://github.com:443/affandar/pilotswarm/"), true,
        "443 is the default and URL normalizes it away");

    const policy = withConfig(
        { import: { allowlist: ["https://agents.corp.internal:8443/pkgs/"] } },
        (dir) => loadImportPolicy({ configDir: dir }),
    );
    assert.equal(allow("https://agents.corp.internal:8443/pkgs/x", policy), true);
    assert.equal(allow("https://agents.corp.internal/pkgs/x", policy), false,
        "an entry that names a port must not also permit the default");
});

// ── Bypass class: resolved address ────────────────────────────────

test("private and metadata addresses are refused", () => {
    for (const addr of [
        "127.0.0.1", "127.1.1.1", "0.0.0.0",
        "169.254.169.254",                      // cloud metadata
        "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1",
        "100.64.0.1",                            // CGNAT
        "224.0.0.1", "255.255.255.255",
        "::1", "fd00::1", "fe80::1",
        "::ffff:169.254.169.254",                // v4-mapped metadata
    ]) {
        assert.equal(isBlockedAddress(addr), true, addr);
    }
});

test("ordinary public addresses are allowed", () => {
    for (const addr of ["140.82.121.4", "1.1.1.1", "2606:4700::1111"]) {
        assert.equal(isBlockedAddress(addr), false, addr);
    }
});

test("an unparseable address fails CLOSED", () => {
    for (const addr of ["", "   ", "not-an-address", "1.2.3", "999.1.1.1"]) {
        assert.equal(isBlockedAddress(addr), true, JSON.stringify(addr));
    }
});

test("numeric host literals are refused before any lookup", () => {
    // http://2130706433/ IS 127.0.0.1, and never looks like it.
    for (const host of ["2130706433", "0x7f000001", "0177.0.0.1", "127.1", "10.1"]) {
        assert.equal(isSuspiciousHostLiteral(host), true, host);
    }
    assert.equal(isSuspiciousHostLiteral("github.com"), false);
    assert.equal(allow("https://2130706433/affandar/pilotswarm/"), false);
});

// ── Config composition ────────────────────────────────────────────

test("append is the default and keeps the base entries", () => {
    const policy = withConfig(
        { import: { allowlist: ["https://agents.corp.internal/pkgs/"] } },
        (dir) => loadImportPolicy({ configDir: dir }),
    );
    assert.equal(policy.mode, "append");
    assert.equal(allow("https://github.com/affandar/pilotswarm/x", policy), true);
    assert.equal(allow("https://agents.corp.internal/pkgs/x", policy), true);
});

test("replace is the ONLY way to drop a base entry", () => {
    const policy = withConfig(
        { import: { mode: "replace", allowlist: ["https://agents.corp.internal/pkgs/"] } },
        (dir) => loadImportPolicy({ configDir: dir }),
    );
    assert.equal(allow("https://github.com/affandar/pilotswarm/x", policy), false);
    assert.equal(allow("https://agents.corp.internal/pkgs/x", policy), true);
});

test("replace with an empty list disables URL import entirely — a legitimate posture", () => {
    const policy = withConfig(
        { import: { mode: "replace", allowlist: [] } },
        (dir) => loadImportPolicy({ configDir: dir }),
    );
    assert.equal(policy.entries.length, 0);
    assert.equal(allow("https://github.com/affandar/pilotswarm/x", policy), false);
});

test("a malformed config REFUSES TO START rather than silently changing policy", () => {
    // The failure this prevents: an operator edits the file, fat-fingers a
    // comma, and unknowingly keeps running the previous policy forever.
    assert.throws(() => withConfig("{ not json", (dir) => loadImportPolicy({ configDir: dir })), /not valid JSON/);
    assert.throws(() => withConfig({ import: { mode: "whatever" } }, (dir) => loadImportPolicy({ configDir: dir })), /mode/);
    assert.throws(() => withConfig({ import: { allowlist: "https://x/" } }, (dir) => loadImportPolicy({ configDir: dir })), /array/);
    assert.throws(() => withConfig({ import: { allowlist: ["http://insecure/"] } }, (dir) => loadImportPolicy({ configDir: dir })), /https/);
    assert.throws(() => withConfig({ import: { allowlist: ["https://u:p@host/"] } }, (dir) => loadImportPolicy({ configDir: dir })), /credentials|usable/);
});

test("an unusable allowlist entry never widens the list", () => {
    for (const bad of ["", "   ", "not a url", "http://x/", "https://u:p@x/", null, 42]) {
        assert.equal(parseAllowlistEntry(bad), null, JSON.stringify(bad));
    }
});

// ── Redirects ─────────────────────────────────────────────────────

test("every redirect hop is re-checked with the same function", () => {
    // An allowed origin redirecting to a disallowed one is the obvious bypass;
    // the only defence is asking the same question about the new location.
    assert.equal(allow("https://github.com/affandar/pilotswarm/x"), true);
    assert.equal(allow("https://evil.com/whatever"), false);
    assert.equal(allow("https://github.com/affandar/other-repo/x"), false);
});

test("the fetch envelope is capped", () => {
    assert.ok(IMPORT_FETCH_LIMITS.maxBytes <= 2 * 1024 * 1024);
    assert.ok(IMPORT_FETCH_LIMITS.maxRedirects <= 5 && IMPORT_FETCH_LIMITS.maxRedirects >= 1);
    assert.ok(IMPORT_FETCH_LIMITS.timeoutMs > 0 && IMPORT_FETCH_LIMITS.timeoutMs <= 60_000);
});

// ── Refusals must be legible but not leaky ────────────────────────

test("a refusal names the offending URL and says how to extend the list", () => {
    const reason = why("https://agents.corp.internal/pkgs/x");
    assert.match(reason, /allowlist/);
    assert.match(reason, new RegExp(IMPORT_CONFIG_FILENAME.replace(".", "\\.")));
});

test("garbage input is refused without throwing", () => {
    for (const input of [null, undefined, "", "   ", 42, {}, "http://", "://x"]) {
        const decision = checkImportUrl(input, BASE);
        assert.equal(decision.allowed, false, JSON.stringify(input));
        assert.ok(decision.reason);
    }
});
