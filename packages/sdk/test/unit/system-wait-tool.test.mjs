import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ManagedSession } from "../../dist/managed-session.js";

const queueSource = readFileSync(
    fileURLToPath(new URL("../../src/orchestration/queue.ts", import.meta.url)),
    "utf8",
);
const proxySource = readFileSync(
    fileURLToPath(new URL("../../src/session-proxy.ts", import.meta.url)),
    "utf8",
);

test("system_wait is declared as a keyed platform wait", () => {
    const tool = ManagedSession.systemToolDefs().find((candidate) => candidate.name === "system_wait");
    assert.ok(tool);
    assert.deepEqual(tool.parameters.required, ["signal_key", "reason"]);
    assert.match(tool.description, /matching system signal/i);
    assert.match(tool.description, /use ask_user instead/i);
});

test("system_wait only resumes from a matching signal and projects waiting status", () => {
    assert.match(queueSource, /pending\.signalKey !== signalKey/);
    assert.match(queueSource, /session\.system_signal_ignored/);
    assert.match(queueSource, /session\.system_wait_completed/);
    assert.match(proxySource, /result\.type === "system_wait"/);
});
