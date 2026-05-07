#!/usr/bin/env node
// packages/mcp-server/test-sendCommandAndWait-unit.mjs
//
// Unit test for the `sendCommandAndWait` helper in
// packages/mcp-server/src/util/command.ts.
//
// Covers the three semantics the helper promises to its callers:
//
//   1. Rejection: when the orchestration writes a response with `error`,
//      sendCommandAndWait throws CommandRejectedError carrying the cmd
//      name and surfacing the orch's error message.
//   2. Success: when the orchestration writes a response with `result`,
//      sendCommandAndWait returns the response.
//   3. Timeout: when no response ever shows up, sendCommandAndWait throws
//      CommandTimeoutError after `timeoutMs`.
//
// No DB, no SDK, no GitHub token. Pure mock — `mgmt` is a hand-rolled fake
// with `sendCommand` (no-op) + `getCommandResponse` (programmable). Runs
// in <2s.
//
// Usage:  node packages/mcp-server/test-sendCommandAndWait-unit.mjs

import {
    sendCommandAndWait,
    CommandRejectedError,
    CommandTimeoutError,
} from "./dist/src/util/command.js";

const results = [];

function record(name, ok, detail = "") {
    results.push({ name, ok, detail });
    const icon = ok ? "✅" : "❌";
    console.log(`${icon} ${name.padEnd(48)} ${ok ? "PASS" : "FAIL"}${detail ? ` (${detail})` : ""}`);
}

function makeMgmt(getResponseFn) {
    let captured = null;
    return {
        async sendCommand(_sessionId, payload) {
            captured = payload;
        },
        async getCommandResponse(_sessionId, cmdId) {
            return getResponseFn(cmdId, captured);
        },
        get _captured() {
            return captured;
        },
    };
}

// ── Case 1: bogus command rejection ───────────────────────────────────────
async function caseRejection() {
    const name = "rejection — Unknown command surfaces CommandRejectedError";
    try {
        const mgmt = makeMgmt((cmdId, captured) => ({
            id: cmdId,
            cmd: captured?.cmd ?? "totally_bogus",
            error: `Unknown command: ${captured?.cmd ?? "totally_bogus"}`,
        }));

        let raised = null;
        try {
            await sendCommandAndWait(
                mgmt,
                "session-x",
                "totally_bogus",
                { foo: "bar" },
                { timeoutMs: 1000, pollIntervalMs: 25 },
            );
        } catch (err) {
            raised = err;
        }

        if (!raised) {
            return record(name, false, "no error thrown");
        }
        if (!(raised instanceof CommandRejectedError)) {
            return record(name, false, `wrong error type: ${raised?.constructor?.name}`);
        }
        if (raised.cmd !== "totally_bogus") {
            return record(name, false, `wrong cmd: "${raised.cmd}"`);
        }
        if (!raised.message.toLowerCase().includes("unknown command")) {
            return record(name, false, `message missing "Unknown command": "${raised.message}"`);
        }
        record(name, true, `cmd="${raised.cmd}", message="${raised.message.slice(0, 60)}"`);
    } catch (err) {
        record(name, false, `harness error: ${err?.message ?? err}`);
    }
}

// ── Case 2: success — result returned ─────────────────────────────────────
async function caseSuccess() {
    const name = "success — set_model result returned";
    try {
        const mgmt = makeMgmt((cmdId, captured) => ({
            id: cmdId,
            cmd: captured?.cmd ?? "set_model",
            result: { ok: true, model: "anthropic/claude-3-5-sonnet" },
        }));

        const response = await sendCommandAndWait(
            mgmt,
            "session-x",
            "set_model",
            { model: "anthropic/claude-3-5-sonnet" },
            { timeoutMs: 1000, pollIntervalMs: 25 },
        );

        if (!response) {
            return record(name, false, "no response");
        }
        if (!response.result || response.result.ok !== true) {
            return record(name, false, `unexpected result: ${JSON.stringify(response.result)}`);
        }
        if (response.cmd !== "set_model") {
            return record(name, false, `wrong cmd: "${response.cmd}"`);
        }
        record(name, true, `result=${JSON.stringify(response.result)}`);
    } catch (err) {
        record(name, false, `unexpected throw: ${err?.message ?? err}`);
    }
}

// ── Case 3: timeout ───────────────────────────────────────────────────────
async function caseTimeout() {
    const name = "timeout — no response → CommandTimeoutError";
    try {
        const mgmt = makeMgmt(() => null);

        const start = Date.now();
        let raised = null;
        try {
            await sendCommandAndWait(
                mgmt,
                "session-x",
                "get_info",
                {},
                { timeoutMs: 500, pollIntervalMs: 50 },
            );
        } catch (err) {
            raised = err;
        }
        const elapsed = Date.now() - start;

        if (!raised) {
            return record(name, false, "no error thrown");
        }
        if (!(raised instanceof CommandTimeoutError)) {
            return record(name, false, `wrong error type: ${raised?.constructor?.name} — ${raised?.message}`);
        }
        if (raised.cmd !== "get_info") {
            return record(name, false, `wrong cmd: "${raised.cmd}"`);
        }
        if (raised.timeoutMs !== 500) {
            return record(name, false, `wrong timeoutMs: ${raised.timeoutMs}`);
        }
        // Allow generous wall-clock slack — must be at least near the timeout
        // and not absurdly long.
        if (elapsed < 400 || elapsed > 2500) {
            return record(name, false, `elapsed out of bounds: ${elapsed}ms`);
        }
        record(name, true, `threw after ${elapsed}ms (timeoutMs=500)`);
    } catch (err) {
        record(name, false, `harness error: ${err?.message ?? err}`);
    }
}

async function main() {
    await caseRejection();
    await caseSuccess();
    await caseTimeout();

    const pass = results.filter((r) => r.ok).length;
    const failCount = results.filter((r) => !r.ok).length;
    console.log("");
    console.log(`Summary: ${pass} PASS, ${failCount} FAIL`);
    process.exit(failCount === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error("Unit test crashed:", err);
    process.exit(2);
});
