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
 * The cure is `client.ops`: the canonical surface, generated from the table,
 * complete by construction. These tests pin the three things that keep it
 * from drifting again:
 *   1. `ops` covers every operation in the table, exactly — no gaps, no
 *      strays.
 *   2. The generated file is in sync with the table — adding an operation
 *      without regenerating fails here rather than at a call site months
 *      later.
 *   3. The hand-written ergonomic layer stays a layer OVER the wire, not a
 *      fork of it.
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
    createManagementOps,
} from "../../dist/web/generated-op-methods.js";

const here = dirname(fileURLToPath(import.meta.url));
const GENERATED_FILE = resolve(here, "../../src/web/generated-op-methods.ts");
const GENERATOR = resolve(here, "../../scripts/generate-web-client-ops.mjs");

function clientWithFakeApi() {
    const client = Object.create(WebPilotSwarmManagementClient.prototype);
    const calls = [];
    client._api = { call: async (name, params) => { calls.push({ name, params }); return "ok"; } };
    // `ops` is normally bound in the constructor; bind it the same way here.
    Object.defineProperty(client, "ops", {
        value: createManagementOps((name, params) => client._api.call(name, params)),
    });
    return { client, calls };
}

test("client.ops covers the protocol table exactly", () => {
    const { client } = clientWithFakeApi();
    const fromTable = [...OPERATIONS.map((op) => op.name)].sort();

    const missing = fromTable.filter((name) => typeof client.ops[name] !== "function");
    assert.deepEqual(missing, [], `operations with no ops method: ${missing.join(", ")}`);

    const extra = Object.keys(client.ops).filter((name) => !fromTable.includes(name)).sort();
    assert.deepEqual(extra, [], `ops methods with no table operation: ${extra.join(", ")}`);

    assert.deepEqual([...GENERATED_OP_NAMES].sort(), fromTable);
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

test("ops methods forward the operation name and params verbatim", async () => {
    const { client, calls } = clientWithFakeApi();

    // grantSessionShare was direct-mode-only before the client was generated.
    const result = await client.ops.grantSessionShare({
        sessionId: "s1",
        user: { provider: "entra", subject: "u1" },
        access: "read",
    });
    assert.equal(result, "ok");

    // A no-params op defaults to an empty object.
    await client.ops.getWorkerCount();

    assert.deepEqual(calls, [
        {
            name: "grantSessionShare",
            params: { sessionId: "s1", user: { provider: "entra", subject: "u1" }, access: "read" },
        },
        { name: "getWorkerCount", params: {} },
    ]);
});

test("the ergonomic layer still rides the same wire with its own signatures", async () => {
    const { client, calls } = clientWithFakeApi();

    // Positional, not a flat params object — this is the signature the MCP
    // server, the TUI and the portal depend on.
    await client.renameSession("s2", "New Title");

    assert.deepEqual(calls, [{ name: "renameSession", params: { sessionId: "s2", title: "New Title" } }]);
});

test("package scope selector never overwrites the Web target scope", async () => {
    const { client, calls } = clientWithFakeApi();
    await client.setAgentPackageScope("pkg", "shared", null, false, { scope: "user" });
    assert.deepEqual(calls, [{
        name: "setAgentPackageScope",
        params: { name: "pkg", scope: "shared" },
    }]);
});
