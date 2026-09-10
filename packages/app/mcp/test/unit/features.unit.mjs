import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerFeatureTools } from "../../dist/src/tools/features.js";

async function fixture(run, { webMode = false, grant = true } = {}) {
    const envNames = ["PILOTSWARM_MCP_ACTOR_PROVIDER", "PILOTSWARM_MCP_ACTOR_SUBJECT", "PILOTSWARM_MCP_FEATURE_ADMIN"];
    const prior = envNames.map(k => process.env[k]);
    process.env[envNames[0]] = "test"; process.env[envNames[1]] = "alice";
    if (grant) process.env[envNames[2]] = "true"; else delete process.env[envNames[2]];
    const calls = [];
    const mgmt = new Proxy({}, { get: (_, name) => async (...args) => { calls.push({ name, args }); return { revision: "2" }; } });
    const server = new McpServer({ name: "feature-test", version: "1.0.0" });
    registerFeatureTools(server, { mgmt, admin: true, webMode });
    const client = new Client({ name: "feature-client", version: "1.0.0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    try { await server.connect(serverSide); await client.connect(clientSide); await run(client, calls); }
    finally {
        await client.close(); await server.close();
        envNames.forEach((key, i) => { if (prior[i] === undefined) delete process.env[key]; else process.env[key] = prior[i]; });
    }
}

test("MCP feature tools preserve revision, request identity and target-user arity", async () => {
    await fixture(async (client, calls) => {
        const names = (await client.listTools()).tools.map(t => t.name);
        assert.equal(names.length, 12);
        const input = { featureKey: "copilot.native_tasks", expectedRevision: "9007199254740993", requestId: "retry-one", enabled: false, userId: 7 };
        const response = await client.callTool({ name: "set_user_feature_flag", arguments: input });
        assert.ok(!response.isError);
        assert.deepEqual(calls[0], { name: "setUserFeatureFlag", args: [{ principal: { provider: "test", subject: "alice" }, isAdmin: true }, 7, input] });
        const search = await client.callTool({ name: "list_feature_flag_users", arguments: { query: "" } });
        assert.ok(!search.isError); assert.equal(calls[1].args[1], "");
        const unset = { featureKey: input.featureKey, expectedRevision: "3", requestId: "unset-one" };
        await client.callTool({ name: "unset_my_feature_flag", arguments: unset });
        assert.deepEqual(calls[2].args.slice(1), [unset]);
        await client.callTool({ name: "list_feature_flag_changes", arguments: { limit: 10 } });
        assert.equal(calls[3].args[1], 10);
        const invalid = await client.callTool({ name: "set_cluster_feature_flag", arguments: { ...unset, enabled: true } });
        assert.equal(invalid.isError, true); assert.equal(calls.length, 4);
    });
});
for (const options of [{ webMode: false, grant: false }, { webMode: true, grant: true }]) {
    test(`MCP does not manufacture direct admin authority: ${JSON.stringify(options)}`, async () => {
        await fixture(async (client, calls) => {
            await client.callTool({ name: "get_cluster_feature_flags", arguments: {} });
            assert.equal(calls[0].args[0].isAdmin, false);
        }, options);
    });
}
