import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import { duroxideVersion, processIdentity, logPoisonOnce } from "../../dist/diagnostics.js";

// logPoisonOnce keeps a module-level "already logged" set, so every test uses a
// fresh session id to stay independent of order and of earlier tests.
let _seq = 0;
const uniqueSession = () => `sess-${process.pid}-${Date.now()}-${_seq++}`;

// Capture whatever the code under test writes to console.warn for the duration
// of fn, restoring the original afterwards.
function captureWarn(fn) {
    const original = console.warn;
    const lines = [];
    console.warn = (...args) => lines.push(args.join(" "));
    try {
        fn();
    } finally {
        console.warn = original;
    }
    return lines;
}

test("duroxideVersion returns a stable, non-empty string and never throws", () => {
    const version = duroxideVersion();
    assert.equal(typeof version, "string");
    assert.ok(version.length > 0);
    // Memoized: the value is stable for the lifetime of the process.
    assert.equal(duroxideVersion(), version);
});

test("processIdentity stamps pid, host and duroxide version", () => {
    const identity = processIdentity();
    assert.equal(identity.pid, process.pid);
    assert.equal(identity.host, os.hostname());
    assert.equal(identity.duroxideVersion, duroxideVersion());
});

test("processIdentity merges caller-provided context onto the base identity", () => {
    const identity = processIdentity({ session: "abc", error: "boom" });
    assert.equal(identity.session, "abc");
    assert.equal(identity.error, "boom");
    // Base identity fields are still present alongside the extra context.
    assert.equal(identity.pid, process.pid);
    assert.equal(identity.host, os.hostname());
});

test("logPoisonOnce ignores empty and non-poison failure messages", () => {
    const session = uniqueSession();
    const lines = captureWarn(() => {
        logPoisonOnce(session, null, "test");
        logPoisonOnce(session, undefined, "test");
        logPoisonOnce(session, "", "test");
        logPoisonOnce(session, "a routine transient error", "test");
    });
    assert.deepEqual(lines, []);
});

test("logPoisonOnce emits an identity-stamped breadcrumb for poison messages", () => {
    const session = uniqueSession();
    const lines = captureWarn(() => {
        logPoisonOnce(session, "session is poison", "client");
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[client\] session surfaced as POISONED /);

    const payload = JSON.parse(lines[0].slice(lines[0].indexOf("{")));
    assert.equal(payload.session, session);
    assert.equal(payload.error, "session is poison");
    assert.equal(payload.pid, process.pid);
    assert.equal(payload.host, os.hostname());
    assert.equal(payload.duroxideVersion, duroxideVersion());
});

test("logPoisonOnce also recognizes the redelivery-attempts exhaustion message", () => {
    const session = uniqueSession();
    const lines = captureWarn(() => {
        logPoisonOnce(session, "snapshot commit exceeded 5 attempts", "worker");
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[worker\] session surfaced as POISONED /);
    assert.match(lines[0], /exceeded 5 attempts/);
});

test("logPoisonOnce logs at most once per session but re-logs for a new session", () => {
    const first = uniqueSession();
    const second = uniqueSession();
    const lines = captureWarn(() => {
        logPoisonOnce(first, "poison", "client");
        logPoisonOnce(first, "poison", "client"); // suppressed — same session
        logPoisonOnce(second, "poison", "client"); // new session — logs again
    });
    assert.equal(lines.length, 2);
});
