// DB-less unit tests for buildPoolConfig — the HorizonDB TLS normalization that
// makes a `?sslmode=require` URL behave here exactly like it does for the SDK's
// CMS/facts pools (which strip sslmode and set ssl:{rejectUnauthorized:false}).
//
// Regression guard: before this helper, the provider built raw pools with the
// URL verbatim, so pg v8 treated `sslmode=require` as verify-full and rejected
// HorizonDB's cert chain ("self-signed certificate in certificate chain") —
// while the identical URL worked for DATABASE_URL. Run: npm test.

import { test } from "vitest";
import assert from "node:assert/strict";

import { buildPoolConfig } from "../dist/src/config.js";

const BASE = "postgresql://u:p@host.example:5432/db";

function parse(cs) {
    return new URL(cs);
}

// ─── the core fix: sslmode=require → encrypt, don't verify ───────────────────

test("bare ?sslmode=require → strips sslmode and sets ssl:{rejectUnauthorized:false}", () => {
    const cfg = buildPoolConfig(`${BASE}?sslmode=require`, 7);
    assert.deepEqual(cfg.ssl, { rejectUnauthorized: false }, "TLS on, CA not verified (libpq require semantics)");
    assert.equal(parse(cfg.connectionString).searchParams.has("sslmode"), false, "sslmode removed so pg does not re-apply verify-full");
    assert.equal(cfg.max, 7, "max passed through");
});

test("all SSL-requiring modes normalize the same way", () => {
    for (const mode of ["require", "prefer", "verify-ca", "verify-full"]) {
        const cfg = buildPoolConfig(`${BASE}?sslmode=${mode}`, 1);
        assert.deepEqual(cfg.ssl, { rejectUnauthorized: false }, `${mode} → ssl config set`);
        assert.equal(parse(cfg.connectionString).searchParams.has("sslmode"), false, `${mode} → sslmode stripped`);
    }
});

// ─── idempotent with the old hand-applied workaround ─────────────────────────

test("?sslmode=require&uselibpqcompat=true → both stripped, ssl set (old workaround still works)", () => {
    const cfg = buildPoolConfig(`${BASE}?sslmode=require&uselibpqcompat=true`, 3);
    assert.deepEqual(cfg.ssl, { rejectUnauthorized: false });
    const sp = parse(cfg.connectionString).searchParams;
    assert.equal(sp.has("sslmode"), false, "sslmode stripped");
    assert.equal(sp.has("uselibpqcompat"), false, "redundant uselibpqcompat stripped once ssl is explicit");
});

// ─── no TLS requested → no ssl config, URL untouched ─────────────────────────

test("no sslmode → no ssl config and connection string unchanged", () => {
    const cfg = buildPoolConfig(BASE, 4);
    assert.equal(cfg.ssl, undefined, "no TLS forced when the URL did not ask for it (matches SDK factory)");
    assert.equal(cfg.connectionString, BASE, "URL passed through verbatim");
    assert.equal(cfg.max, 4);
});

test("sslmode=disable → no ssl config", () => {
    const cfg = buildPoolConfig(`${BASE}?sslmode=disable`, 1);
    assert.equal(cfg.ssl, undefined, "explicit disable is not an SSL-requiring mode");
});

// ─── other query params are preserved ────────────────────────────────────────

test("unrelated query params survive sslmode stripping", () => {
    const cfg = buildPoolConfig(`${BASE}?application_name=harvester&sslmode=require`, 1);
    const sp = parse(cfg.connectionString).searchParams;
    assert.equal(sp.get("application_name"), "harvester", "non-TLS params preserved");
    assert.equal(sp.has("sslmode"), false);
});

// ─── robustness: a non-URL DSN is returned untouched, never throws ───────────

test("unparseable connection string is returned untouched without throwing", () => {
    const garbage = "not a url";
    const cfg = buildPoolConfig(garbage, 2);
    assert.equal(cfg.connectionString, garbage, "left as-is so pg surfaces a clear connect error");
    assert.equal(cfg.ssl, undefined);
    assert.equal(cfg.max, 2);
});
