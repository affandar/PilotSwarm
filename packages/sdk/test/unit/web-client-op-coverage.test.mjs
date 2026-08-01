/**
 * Every Web API operation is reachable from the web management client (pure,
 * no database, no network).
 *
 * The protocol table is the single source of truth for the portal's routes,
 * `ApiClient`'s request building, and the API reference. The web management
 * client used to be hand-ported one method at a time and drifted badly: 60 of
 * 115 operations implemented, with 30 methods reachable only through the
 * direct (datastore) client — including `grantSessionShare` /
 * `setSessionVisibility` / `getSessionAccess`, the authorization primitives
 * themselves, whose HTTP routes existed the whole time.
 *
 * These tests pin the two things that keep it from drifting again:
 *   1. Every operation in the table is callable on the client.
 *   2. The generated file is in sync with the table — adding an operation
 *      without regenerating fails here rather than at a call site months later.
 *
 * Run: node --test test/unit/web-client-op-coverage.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { OPERATIONS } from "../../api/src/protocol.js";
import { WebPilotSwarmManagementClient } from "../../dist/web/web-management-client.js";
import {
    GENERATED_OP_NAMES,
    HAND_WRITTEN_OP_NAMES,
} from "../../dist/web/generated-op-methods.js";

const here = dirname(fileURLToPath(import.meta.url));
const GENERATED_FILE = resolve(here, "../../src/web/generated-op-methods.ts");
const GENERATOR = resolve(here, "../../scripts/generate-web-client-ops.mjs");

test("every operation in the protocol table is callable on the web client", () => {
    const missing = OPERATIONS
        .map((op) => op.name)
        .filter((name) => typeof WebPilotSwarmManagementClient.prototype[name] !== "function");
    assert.deepEqual(missing, [], `operations with no client method: ${missing.join(", ")}`);
});

test("the generated name list matches the protocol table exactly", () => {
    const fromTable = [...OPERATIONS.map((op) => op.name)].sort();
    assert.deepEqual([...GENERATED_OP_NAMES].sort(), fromTable);
});

test("hand-written operations really are implemented by hand", () => {
    // Each name here is excluded from the generated interface because the class
    // gives it an ergonomic signature. If one disappears from the class, the
    // generator must be re-run so it becomes a generated method instead.
    for (const name of HAND_WRITTEN_OP_NAMES) {
        assert.equal(
            typeof WebPilotSwarmManagementClient.prototype[name],
            "function",
            `${name} is listed as hand-written but the class does not define it`,
        );
    }
});

test("the generated file is up to date with the protocol table", () => {
    // Generate to a temp path: regenerating in place would repair the file as a
    // side effect, so a stale checkout would fail once and pass on retry.
    const probe = resolve(mkdtempSync(join(tmpdir(), "ps-op-gen-")), "generated-op-methods.ts");
    execFileSync(process.execPath, [GENERATOR, probe], { stdio: "pipe" });
    assert.equal(
        readFileSync(GENERATED_FILE, "utf8"),
        readFileSync(probe, "utf8"),
        "generated-op-methods.ts is stale — run `npm run generate:web-ops -w packages/sdk`",
    );
});

test("generated methods forward the operation name and params verbatim", async () => {
    const client = Object.create(WebPilotSwarmManagementClient.prototype);
    const calls = [];
    client._api = { call: async (name, params) => { calls.push({ name, params }); return "ok"; } };

    // grantSessionShare was direct-mode-only before the client was generated.
    const result = await client.grantSessionShare({
        sessionId: "s1",
        user: { provider: "entra", subject: "u1" },
        access: "read",
    });

    assert.equal(result, "ok");
    assert.deepEqual(calls, [{
        name: "grantSessionShare",
        params: { sessionId: "s1", user: { provider: "entra", subject: "u1" }, access: "read" },
    }]);
});

test("generation never clobbers a hand-written ergonomic signature", async () => {
    const client = Object.create(WebPilotSwarmManagementClient.prototype);
    const calls = [];
    client._api = { call: async (name, params) => { calls.push({ name, params }); } };

    // Positional, not a flat params object — this is the signature 55 MCP call
    // sites, the TUI and the portal depend on.
    await client.renameSession("s2", "New Title");

    assert.deepEqual(calls, [{ name: "renameSession", params: { sessionId: "s2", title: "New Title" } }]);
});
