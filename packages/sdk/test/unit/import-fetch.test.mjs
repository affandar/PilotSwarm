/**
 * The guarded import fetch — redirect chains, hostile DNS, and size caps.
 *
 * The policy module decides whether a URL is permitted; this suite covers the
 * places where a correct policy still gets bypassed by the FETCH:
 *
 *   - following a redirect without re-checking it (the default `fetch()`
 *     behaviour, which is why redirects are followed manually);
 *   - trusting DNS for an allowlisted name;
 *   - believing a server's Content-Length.
 *
 * Everything is injected, so none of this touches a network.
 *
 * Run: node --test test/unit/import-fetch.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { loadImportPolicy } from "../../dist/agent-package-import-policy.js";
import { guardedImportFetch, assertHostResolvesPublicly } from "../../dist/agent-package-import-fetch.js";

const POLICY = loadImportPolicy();
const OK_URL = "https://github.com/affandar/pilotswarm/pkg.tar.gz";

const publicDns = { async lookup() { return [{ address: "140.82.121.4" }]; } };
const privateDns = { async lookup() { return [{ address: "169.254.169.254" }]; } };

function bodyOf(text) {
    const bytes = Buffer.from(text);
    return {
        ok: true, status: 200,
        headers: new Map([["content-length", String(bytes.length)]]),
        body: {
            getReader() {
                let sent = false;
                return {
                    async read() {
                        if (sent) return { done: true };
                        sent = true;
                        return { done: false, value: bytes };
                    },
                    async cancel() {},
                };
            },
        },
    };
}

/** Response stub with a Map-like headers object. */
function res(overrides) {
    const headers = new Map(Object.entries(overrides.headers ?? {}));
    return { ok: true, status: 200, ...overrides, headers: { get: (k) => headers.get(k) ?? null }, };
}

function redirectTo(location, status = 302) {
    return res({ ok: false, status, headers: { location }, body: null });
}

function okBody(text) {
    const b = bodyOf(text);
    return res({ ok: true, status: 200, headers: { "content-length": String(Buffer.from(text).length) }, body: b.body });
}

test("a permitted URL is fetched", async () => {
    const result = await guardedImportFetch(OK_URL, POLICY, {
        resolver: publicDns,
        fetchImpl: async () => okBody("PKGBYTES"),
    });
    assert.equal(result.bytes.toString(), "PKGBYTES");
    assert.equal(result.hops.length, 1);
});

test("a disallowed URL never opens a socket", async () => {
    let called = false;
    await assert.rejects(
        () => guardedImportFetch("https://evil.com/x.tar.gz", POLICY, {
            resolver: publicDns,
            fetchImpl: async () => { called = true; return okBody("nope"); },
        }),
        /allowlist/,
    );
    assert.equal(called, false, "the refusal must happen before any fetch");
});

// ── Redirects ─────────────────────────────────────────────────────

test("a redirect OFF the allowlist is refused", async () => {
    // The whole reason redirects are followed manually.
    await assert.rejects(
        () => guardedImportFetch(OK_URL, POLICY, {
            resolver: publicDns,
            fetchImpl: async (url) =>
                url === OK_URL ? redirectTo("https://evil.com/payload.tar.gz") : okBody("PWNED"),
        }),
        /refused after 1 redirect/,
    );
});

test("a redirect to another repo on the SAME allowed host is still refused", async () => {
    // Path prefixes are part of the entry, so an allowed host is not an
    // allowed origin.
    await assert.rejects(
        () => guardedImportFetch(OK_URL, POLICY, {
            resolver: publicDns,
            fetchImpl: async (url) =>
                url === OK_URL ? redirectTo("https://github.com/someone/else/x.tar.gz") : okBody("PWNED"),
        }),
        /refused after 1 redirect/,
    );
});

test("a redirect WITHIN the allowlist is followed", async () => {
    const target = "https://codeload.github.com/affandar/pilotswarm/tar.gz/main";
    const result = await guardedImportFetch(OK_URL, POLICY, {
        resolver: publicDns,
        fetchImpl: async (url) => (url === OK_URL ? redirectTo(target) : okBody("GOOD")),
    });
    assert.equal(result.bytes.toString(), "GOOD");
    assert.equal(result.finalUrl, target);
    assert.deepEqual(result.hops, [OK_URL, target]);
});

test("a relative Location is resolved and then re-checked", async () => {
    // `Location: /someone/else/x` from github.com must be rejected, not
    // treated as unresolvable and skipped.
    await assert.rejects(
        () => guardedImportFetch(OK_URL, POLICY, {
            resolver: publicDns,
            fetchImpl: async (url) =>
                url === OK_URL ? redirectTo("/someone/else/x.tar.gz") : okBody("PWNED"),
        }),
        /refused after 1 redirect/,
    );
});

test("a redirect loop terminates", async () => {
    await assert.rejects(
        () => guardedImportFetch(OK_URL, POLICY, {
            resolver: publicDns,
            fetchImpl: async () => redirectTo(OK_URL),
        }),
        /too many redirects/,
    );
});

test("a redirect with no Location is refused, not retried", async () => {
    await assert.rejects(
        () => guardedImportFetch(OK_URL, POLICY, {
            resolver: publicDns,
            fetchImpl: async () => redirectTo(null),
        }),
        /no Location header/,
    );
});

// ── DNS ───────────────────────────────────────────────────────────

test("an allowlisted host resolving into private space is refused", async () => {
    // The attack an allowlist alone does not stop: DNS is not ours.
    await assert.rejects(
        () => guardedImportFetch(OK_URL, POLICY, {
            resolver: privateDns,
            fetchImpl: async () => okBody("PWNED"),
        }),
        /non-public address/,
    );
});

test("DNS is re-checked on every hop, not just the first", async () => {
    const target = "https://codeload.github.com/affandar/pilotswarm/tar.gz/main";
    const resolver = {
        async lookup(host) {
            return host === "codeload.github.com"
                ? [{ address: "10.0.0.5" }]      // second hop goes private
                : [{ address: "140.82.121.4" }];
        },
    };
    await assert.rejects(
        () => guardedImportFetch(OK_URL, POLICY, {
            resolver,
            fetchImpl: async (url) => (url === OK_URL ? redirectTo(target) : okBody("PWNED")),
        }),
        /non-public address/,
    );
});

test("a split-horizon answer is refused if ANY address is private", async () => {
    // DNS rebinding: we cannot pin which record the socket takes.
    const resolver = {
        async lookup() { return [{ address: "140.82.121.4" }, { address: "127.0.0.1" }]; },
    };
    await assert.rejects(() => assertHostResolvesPublicly("github.com", resolver), /non-public address/);
});

test("an unresolvable host is refused legibly", async () => {
    const resolver = { async lookup() { const e = new Error("nope"); e.code = "ENOTFOUND"; throw e; } };
    await assert.rejects(() => assertHostResolvesPublicly("nope.example", resolver), /could not resolve/);
    const empty = { async lookup() { return []; } };
    await assert.rejects(() => assertHostResolvesPublicly("nope.example", empty), /no addresses/);
});

// ── Size caps ─────────────────────────────────────────────────────

test("a declared Content-Length over the cap is refused before reading", async () => {
    await assert.rejects(
        () => guardedImportFetch(OK_URL, POLICY, {
            resolver: publicDns,
            fetchImpl: async () => res({ ok: true, status: 200, headers: { "content-length": String(50 * 1024 * 1024) }, body: null }),
        }),
        /import cap/,
    );
});

test("a LYING Content-Length is caught while streaming", async () => {
    // The server claims 10 bytes and sends megabytes. Believing the header
    // and calling arrayBuffer() is a worker OOM.
    let cancelled = false;
    const huge = Buffer.alloc(64 * 1024, 0x41);
    const streaming = res({
        ok: true, status: 200,
        headers: { "content-length": "10" },
        body: {
            getReader() {
                return {
                    async read() { return { done: false, value: huge }; },  // never ends
                    async cancel() { cancelled = true; },
                };
            },
        },
    });
    await assert.rejects(
        () => guardedImportFetch(OK_URL, POLICY, { resolver: publicDns, fetchImpl: async () => streaming }),
        /exceeds the .* import cap/,
    );
    assert.equal(cancelled, true, "the stream must be cancelled, not left draining");
});

// ── No body ever reaches an error string ──────────────────────────

test("an error status does not echo the response body", async () => {
    const secret = "SENSITIVE-RESPONSE-BODY";
    try {
        await guardedImportFetch(OK_URL, POLICY, {
            resolver: publicDns,
            fetchImpl: async () => res({
                ok: false, status: 500, headers: {},
                body: bodyOf(secret).body,
                text: async () => secret,
            }),
        });
        assert.fail("should have thrown");
    } catch (error) {
        assert.match(error.message, /HTTP 500/);
        assert.ok(!error.message.includes(secret),
            "an attacker-authored body must never reach the transcript");
    }
});
