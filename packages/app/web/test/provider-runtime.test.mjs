import test from "node:test";
import assert from "node:assert/strict";

import { PortalRuntime } from "../runtime.js";

test("portal runtime routes personal provider credential updates with the authenticated viewer", async () => {
    const calls = [];
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.transport = {
        mgmt: {
            updateMyProviderCredential: async (viewer, input) => {
                calls.push({ viewer, input });
                return { name: input.name, typeId: "github-copilot", class: "personal" };
            },
        },
    };

    const authContext = {
        principal: { provider: "entra", subject: "user-1" },
        authorization: { role: "user" },
    };
    const result = await runtime.call("updateMyProviderCredential", {
        name: "my-ghcp",
        credentials: { githubToken: "replacement-token" },
    }, authContext);

    assert.deepEqual(calls, [{
        viewer: {
            principal: { ...authContext.principal, email: null, displayName: null },
            isAdmin: false,
            adminScope: "unrestricted",
        },
        input: { name: "my-ghcp", credentials: { githubToken: "replacement-token" } },
    }]);
    assert.deepEqual(result, { name: "my-ghcp", typeId: "github-copilot", class: "personal" });
    // NOT a credential-leak guard, despite reading like one: `result` comes
    // wholly from the stub above, which is hardcoded to {name,typeId,class},
    // and runtime.call returns the mgmt result verbatim. Nothing in the store,
    // the management client or the SQL could turn it red — and the deepEqual
    // on the line above already pins the exact value. The real guard is that
    // the store never puts a secret in what it returns; see
    // provider-credential-update.test.mjs, which asserts against the shape the
    // store actually produces.
    //
    // Kept as a cheap tripwire on the STUB's own shape only.
    assert.equal(JSON.stringify(result).includes("replacement-token"), false);
});
