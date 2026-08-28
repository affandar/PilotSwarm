import test from "node:test";
import assert from "node:assert/strict";
import {
    AdoWiqlEvaluator,
    IcmEvaluator,
    createEvaluatorsFromEnv,
    parseAdoWiqlResponse,
    parseIcmResponse,
    parseKustoResponse,
} from "../dist/providers.js";

test("ADO WIQL parser uses the result id as the stable key", () => {
    const result = parseAdoWiqlResponse({
        workItems: [{ id: 42 }],
        watermark: "next",
    });
    assert.deepEqual(result, {
        discoveries: [{ key: "42", payload: { id: 42 } }],
        watermark: "next",
    });
});

test("IcM parser accepts canonical incident identifiers", () => {
    const result = parseIcmResponse({ value: [{ IncidentId: 1234, title: "incident" }] });
    assert.equal(result.discoveries[0].key, "1234");
});

test("Kusto parser maps table columns and configurable stable key", () => {
    const result = parseKustoResponse({
        Tables: [{
            Columns: [{ ColumnName: "WorkId" }, { ColumnName: "Title" }],
            Rows: [["abc", "hello"]],
        }],
    }, "WorkId");
    assert.deepEqual(result.discoveries, [{
        key: "abc",
        payload: { WorkId: "abc", Title: "hello" },
    }]);
});

test("HTTP evaluator posts definition config and bearer token", async () => {
    let request;
    const evaluator = new AdoWiqlEvaluator({
        endpoint: "https://provider.example/evaluate",
        token: "secret",
        fetch: async (url, init) => {
            request = { url, init };
            return new Response(JSON.stringify({ workItems: [{ id: 7 }] }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        },
    });
    const result = await evaluator.evaluate({
        generator: { generatorId: "g1" },
        definition: { definitionId: "d1", sourceConfig: { wiql: "SELECT" } },
        watermark: 5,
    });
    assert.equal(request.url, "https://provider.example/evaluate");
    assert.equal(request.init.headers.authorization, "Bearer secret");
    assert.deepEqual(JSON.parse(request.init.body), {
        generatorId: "g1",
        definitionId: "d1",
        config: { wiql: "SELECT" },
        watermark: 5,
    });
    assert.equal(result.discoveries[0].key, "7");
});

test("direct ADO evaluator posts WIQL in the Azure DevOps REST shape", async () => {
    let request;
    const evaluator = new AdoWiqlEvaluator({
        endpoint: "https://provider.example/query",
        token: "secret",
        direct: true,
        fetch: async (url, init) => {
            request = { url, init };
            return new Response(JSON.stringify({ workItems: [{ id: 42 }] }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        },
    });
    const result = await evaluator.evaluate({
        generator: { generatorId: "g1" },
        definition: {
            definitionId: "d1",
            sourceConfig: {
                wiql: "SELECT [System.Id] FROM WorkItems WHERE [System.Id] = 42",
            },
        },
        watermark: null,
    });
    assert.deepEqual(JSON.parse(request.init.body), {
        query: "SELECT [System.Id] FROM WorkItems WHERE [System.Id] = 42",
    });
    assert.equal(result.discoveries[0].key, "42");
});

test("built-in ADO evaluator constructs its endpoint from the generator definition", async () => {
    let requestedUrl;
    const evaluator = new AdoWiqlEvaluator({
        token: "secret",
        fetch: async (url) => {
            requestedUrl = url;
            return new Response(JSON.stringify({ workItems: [{ id: 42 }] }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        },
    });

    await evaluator.evaluate({
        generator: { generatorId: "g1" },
        definition: {
            definitionId: "d1",
            sourceConfig: {
                organization: "example-org",
                project: "Example Project",
                wiql: "SELECT",
            },
        },
        watermark: null,
    });

    assert.equal(
        requestedUrl,
        "https://dev.azure.com/example-org/Example%20Project/_apis/wit/wiql?api-version=7.1",
    );
});

test("built-in ADO evaluator falls back to devbox organization and project defaults", async () => {
    let requestedUrl;
    const evaluator = new AdoWiqlEvaluator({
        token: "secret",
        defaultsResolver: async () => ({
            organization: "default-org",
            project: "Default Project",
        }),
        fetch: async (url) => {
            requestedUrl = url;
            return new Response(JSON.stringify({ workItems: [{ id: 42 }] }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        },
    });

    await evaluator.evaluate({
        generator: { generatorId: "g1" },
        definition: {
            definitionId: "d1",
            sourceConfig: { wiql: "SELECT" },
        },
        watermark: null,
    });

    assert.equal(
        requestedUrl,
        "https://dev.azure.com/default-org/Default%20Project/_apis/wit/wiql?api-version=7.1",
    );
});

test("direct ADO evaluator refreshes tokens through the devbox credential", async () => {
    const scopes = [];
    const authorization = [];
    let tokenNumber = 0;
    const evaluator = new AdoWiqlEvaluator({
        credential: {
            async getToken(scope) {
                scopes.push(scope);
                tokenNumber += 1;
                return { token: `token-${tokenNumber}`, expiresOnTimestamp: Date.now() + 60_000 };
            },
        },
        fetch: async (_url, init) => {
            authorization.push(init.headers.authorization);
            return new Response(JSON.stringify({ workItems: [{ id: tokenNumber }] }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        },
    });
    const context = {
        generator: { generatorId: "g1" },
        definition: {
            definitionId: "d1",
            sourceConfig: {
                organization: "example-org",
                project: "example-project",
                wiql: "SELECT",
            },
        },
        watermark: null,
    };

    await evaluator.evaluate(context);
    await evaluator.evaluate(context);

    assert.deepEqual(scopes, [
        "499b84ac-1321-427f-aa17-267ca6975798/.default",
        "499b84ac-1321-427f-aa17-267ca6975798/.default",
    ]);
    assert.deepEqual(authorization, ["Bearer token-1", "Bearer token-2"]);
});

test("provider registry always includes native WIQL and enables optional adapters", async () => {
    const evaluators = createEvaluatorsFromEnv({
        JOBGEN_ICM_ENDPOINT: "https://icm.example/evaluate",
    });
    assert.deepEqual([...evaluators.keys()], ["ado_wiql", "icm"]);
    await assert.rejects(
        new IcmEvaluator({ endpoint: "" }).evaluate({
            generator: {},
            definition: { sourceConfig: {} },
            watermark: null,
        }),
        /endpoint is required/,
    );
});
