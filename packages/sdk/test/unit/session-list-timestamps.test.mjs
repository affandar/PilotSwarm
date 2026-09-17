import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createSessionManagerProxy } from "../../dist/session-proxy.js";
import { sessionTimestampMillis, formatSessionTimestamp } from "../../dist/session-list-timestamps.js";

// Snapshot of shipped 1.0.78, with only its own version literal pinned.
// Existing versions never call the new formatter or request timestamps.
const hashes = {
    "agents.ts": "86534cb9ee6083e23abc0a4c4265f4f7180682f6bbc95e2470b7c744049215d7",
    "index.ts": "40b9aa0e77bac8414c057100682688e038b0f1ed27d4b42e8ed401a919649c17",
    "lifecycle.ts": "498dfe9c73253058929cfdd5d14185ca16347920ddba42c26c16dd9548a12d42",
    "queue.ts": "529218aed1877208a144e5cad6acece5b3c4711af5dcc72065231698649c4c3b",
    "runtime.ts": "b73d8644ba2fbdddb971d42c1d07b7bf81e56bf79cceba4edbf3f62f8c796279",
    "state.ts": "6f696822458e8ae1aa9fdf5a6850c911ed9eb1875f252876c9f5f1e0987afdc7",
    "turn.ts": "ff1aea267ac079d9734876572a0ee8cd25999321d545574e8007038262dfe3a8",
    "utils.ts": "4d1cbe7be647e10f728e2c6e29cfea68ec92181e934924c90f7da62114b577e7"
};
for (const [name, expected] of Object.entries(hashes)) {
    test(`frozen 1.0.78 ${name} remains unchanged`, () => {
        const bytes = readFileSync(new URL(`../../src/orchestration_1_0_78/${name}`, import.meta.url));
        assert.equal(createHash("sha256").update(bytes).digest("hex"), expected);
    });
}

test("legacy listSessions proxy inputs are unchanged on the wire", () => {
    const manager = createSessionManagerProxy({
        scheduleActivity: (name, input) => ({ name, input: JSON.stringify(input) }),
    });
    assert.deepEqual(manager.listSessions(), { name: "listSessions", input: "{}" });
    assert.deepEqual(manager.listSessions({ includeSystem: true, ownerQuery: "Alice", ownerKind: undefined }), {
        name: "listSessions", input: '{"includeSystem":true,"ownerQuery":"Alice"}',
    });
    assert.deepEqual(manager.listSessions({ includeTimestamps: true }), {
        name: "listSessions", input: '{"includeTimestamps":true}',
    });
});

test("timestamp conversion uses milliseconds and normalizes ISO offsets to UTC", () => {
    assert.equal(formatSessionTimestamp(1789680000123), "2026-09-17T21:20:00.123Z");
    assert.equal(formatSessionTimestamp(0), "1970-01-01T00:00:00.000Z");
    assert.equal(formatSessionTimestamp("2026-09-17T10:32:04+01:00"), "2026-09-17T09:32:04.000Z");
    assert.equal(sessionTimestampMillis("1970-01-01T00:00:00Z"), 0);
});

test("invalid or absent times cannot invent an epoch or fail an entire result", () => {
    for (const value of [undefined, null, "", "invalid", "0", "123", "2026-09-17T10:32:04", NaN, Infinity, -Infinity, 1e20, {}, true]) {
        assert.equal(formatSessionTimestamp(value), "unknown");
        assert.ok(Number.isNaN(sessionTimestampMillis(value)));
    }
});
