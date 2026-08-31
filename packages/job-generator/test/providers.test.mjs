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

test("direct IcM evaluator searches MCP pages and returns stable incident keys", async () => {
    const requests = [];
    const scopes = [];
    const sse = (payload, headers = {}) => new Response(
        `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        {
            status: 200,
            headers: {
                "content-type": "text/event-stream",
                ...headers,
            },
        },
    );
    let page = 0;
    const evaluator = new IcmEvaluator({
        direct: true,
        credential: {
            async getToken(scope) {
                scopes.push(scope);
                return { token: "icm-token", expiresOnTimestamp: Date.now() + 60_000 };
            },
        },
        fetch: async (url, init) => {
            requests.push({ url, init });
            if (init.method === "DELETE") return new Response(null, { status: 200 });
            const request = JSON.parse(init.body);
            if (request.method === "initialize") {
                return sse({
                    jsonrpc: "2.0",
                    id: request.id,
                    result: {
                        protocolVersion: "2025-03-26",
                        capabilities: { tools: {} },
                        serverInfo: { name: "IcM", version: "1" },
                    },
                }, { "mcp-session-id": "icm-session-1" });
            }
            if (request.method === "notifications/initialized") {
                return new Response(null, { status: 202 });
            }
            page += 1;
            return sse({
                jsonrpc: "2.0",
                id: request.id,
                result: {
                    content: [],
                    structuredContent: page === 1
                        ? {
                            success: true,
                            value: [{ id: 101, state: "ACTIVE" }],
                            nextPageToken: "page-2",
                        }
                        : {
                            success: true,
                            value: [{ id: 102, state: "MITIGATED" }],
                        },
                },
            });
        },
    });

    const result = await evaluator.evaluate({
        generator: { generatorId: "g1" },
        definition: {
            definitionId: "d1",
            sourceConfig: {
                owningTeamId: 127780,
                states: ["Active", "Mitigated"],
                top: 1,
            },
            guardrails: { maxItemsPerCycle: 10 },
        },
        watermark: null,
    });

    assert.deepEqual(result.discoveries.map(({ key }) => key), ["101", "102"]);
    assert.deepEqual(scopes, ["api://icmmcpapi-prod/.default"]);
    assert.equal(String(requests[0].url), "https://icm-mcp-prod.azure-api.net/v1/");
    assert.equal(new Headers(requests[0].init.headers).get("authorization"), "Bearer ".concat("icm-token"));
    assert.equal(new Headers(requests[1].init.headers).get("mcp-session-id"), "icm-session-1");
    assert.equal(requests.at(-1).init.method, "DELETE");
    const toolCalls = requests
        .filter(({ init }) => init.method === "POST")
        .map(({ init }) => JSON.parse(init.body))
        .filter(({ method }) => method === "tools/call");
    const firstCall = toolCalls[0];
    assert.deepEqual(firstCall.params, {
        name: "search_incidents",
        arguments: {
            incidentAdvancedSearchRequest: {
                owningTeamId: 127780,
                states: ["Active", "Mitigated"],
                top: 1,
            },
        },
    });
    const secondCall = toolCalls[1];
    assert.equal(
        secondCall.params.arguments.incidentAdvancedSearchRequest.nextPageToken,
        "page-2",
    );
});

test("direct IcM evaluator treats an empty search as a healthy result", async () => {
    const evaluator = new IcmEvaluator({
        token: "icm-token",
        direct: true,
        fetch: async (_url, init) => {
            if (init.method === "DELETE") return new Response(null, { status: 200 });
            const request = JSON.parse(init.body);
            if (request.method === "initialize") {
                return new Response(
                    `data: ${JSON.stringify({
                        jsonrpc: "2.0",
                        id: request.id,
                        result: {
                            protocolVersion: "2025-03-26",
                            capabilities: { tools: {} },
                            serverInfo: { name: "IcM", version: "1" },
                        },
                    })}\n\n`,
                    {
                        status: 200,
                        headers: {
                            "content-type": "text/event-stream",
                            "mcp-session-id": "icm-session-empty",
                        },
                    },
                );
            }
            if (request.method === "notifications/initialized") {
                return new Response(null, { status: 202 });
            }
            return new Response(
                `data: ${JSON.stringify({
                    jsonrpc: "2.0",
                    id: request.id,
                    result: {
                        content: [],
                        structuredContent: { success: true, value: [] },
                    },
                })}\n\n`,
                { status: 200, headers: { "content-type": "text/event-stream" } },
            );
        },
    });

    const result = await evaluator.evaluate({
        generator: { generatorId: "g1" },
        definition: {
            definitionId: "d1",
            sourceConfig: { incidentIds: [999] },
            guardrails: {},
        },
        watermark: null,
    });

    assert.deepEqual(result, { discoveries: [] });
});

test("direct IcM evaluator closes a partially initialized MCP session", async () => {
    const methods = [];
    let deleteSignalAborted;
    const evaluator = new IcmEvaluator({
        token: "icm-token",
        direct: true,
        fetch: async (_url, init) => {
            methods.push(init.method);
            if (init.method === "DELETE") {
                deleteSignalAborted = init.signal?.aborted;
                if (deleteSignalAborted) throw new Error("DELETE used an aborted signal");
                return new Response(null, { status: 200 });
            }
            const request = JSON.parse(init.body);
            if (request.method === "initialize") {
                return new Response(
                    `data: ${JSON.stringify({
                        jsonrpc: "2.0",
                        id: request.id,
                        result: {
                            protocolVersion: "2025-03-26",
                            capabilities: { tools: {} },
                            serverInfo: { name: "IcM", version: "1" },
                        },
                    })}\n\n`,
                    {
                        status: 200,
                        headers: {
                            "content-type": "text/event-stream",
                            "mcp-session-id": "partial-session",
                        },
                    },
                );
            }
            return new Response("initialization failed", { status: 500 });
        },
    });

    await assert.rejects(
        evaluator.evaluate({
            generator: { generatorId: "g1" },
            definition: {
                definitionId: "d1",
                sourceConfig: { incidentIds: [123] },
                guardrails: {},
            },
            watermark: null,
        }),
        /initialization failed/,
    );
    assert.equal(methods.at(-1), "DELETE");
    assert.equal(deleteSignalAborted, false);
});

test("direct IcM evaluator bounds pagination and exact guardrail overflow", async () => {
    let toolCalls = 0;
    let returnItem = false;
    const evaluator = new IcmEvaluator({
        token: "icm-token",
        direct: true,
        maxPages: 2,
        fetch: async (_url, init) => {
            if (init.method === "DELETE") return new Response(null, { status: 200 });
            const request = JSON.parse(init.body);
            if (request.method === "initialize") {
                return new Response(
                    `data: ${JSON.stringify({
                        jsonrpc: "2.0",
                        id: request.id,
                        result: {
                            protocolVersion: "2025-03-26",
                            capabilities: { tools: {} },
                            serverInfo: { name: "IcM", version: "1" },
                        },
                    })}\n\n`,
                    {
                        status: 200,
                        headers: {
                            "content-type": "text/event-stream",
                            "mcp-session-id": "bounded-session",
                        },
                    },
                );
            }
            if (request.method === "notifications/initialized") {
                return new Response(null, { status: 202 });
            }
            toolCalls += 1;
            return new Response(
                `data: ${JSON.stringify({
                    jsonrpc: "2.0",
                    id: request.id,
                    result: {
                        content: [],
                        structuredContent: {
                            success: true,
                            value: returnItem ? [{ id: 123 }] : [],
                            nextPageToken: `page-${toolCalls}`,
                        },
                    },
                })}\n\n`,
                { status: 200, headers: { "content-type": "text/event-stream" } },
            );
        },
    });

    await assert.rejects(
        evaluator.evaluate({
            generator: { generatorId: "g1" },
            definition: {
                definitionId: "d1",
                sourceConfig: { owningTeamId: 12345, top: 1 },
                guardrails: {},
            },
            watermark: null,
        }),
        /2-page limit/,
    );
    assert.equal(toolCalls, 2);

    toolCalls = 0;
    returnItem = true;
    await assert.rejects(
        evaluator.evaluate({
            generator: { generatorId: "g1" },
            definition: {
                definitionId: "d1",
                sourceConfig: { owningTeamId: 12345, top: 1 },
                guardrails: { maxItemsPerCycle: 1 },
            },
            watermark: null,
        }),
        /maxItemsPerCycle=1/,
    );
    assert.equal(toolCalls, 1);
});

test("direct IcM evaluator bounds MCP session termination", async () => {
    let cancelCalled = false;
    const evaluator = new IcmEvaluator({
        token: "icm-token",
        direct: true,
        sessionCloseTimeoutMs: 5,
        fetch: async (_url, init) => {
            if (init.method === "DELETE") {
                return new Response(new ReadableStream({
                    cancel() {
                        cancelCalled = true;
                        return new Promise(() => {});
                    },
                }), { status: 200 });
            }
            const request = JSON.parse(init.body);
            if (request.method === "initialize") {
                return new Response(
                    `data: ${JSON.stringify({
                        jsonrpc: "2.0",
                        id: request.id,
                        result: {
                            protocolVersion: "2025-03-26",
                            capabilities: { tools: {} },
                            serverInfo: { name: "IcM", version: "1" },
                        },
                    })}\n\n`,
                    {
                        status: 200,
                        headers: {
                            "content-type": "text/event-stream",
                            "mcp-session-id": "slow-close-session",
                        },
                    },
                );
            }
            if (request.method === "notifications/initialized") {
                return new Response(null, { status: 202 });
            }
            return new Response(
                `data: ${JSON.stringify({
                    jsonrpc: "2.0",
                    id: request.id,
                    result: {
                        content: [],
                        structuredContent: { success: true, value: [] },
                    },
                })}\n\n`,
                { status: 200, headers: { "content-type": "text/event-stream" } },
            );
        },
    });

    await assert.rejects(
        evaluator.evaluate({
            generator: { generatorId: "g1" },
            definition: {
                definitionId: "d1",
                sourceConfig: { incidentIds: [123] },
                guardrails: {},
            },
            watermark: null,
        }),
        /session close timed out/,
    );
    assert.equal(cancelCalled, true);
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

test("provider registry includes native WIQL and IcM plus optional adapters", async () => {
    const nativeEvaluators = createEvaluatorsFromEnv({});
    assert.deepEqual([...nativeEvaluators.keys()], ["ado_wiql", "icm"]);

    const evaluators = createEvaluatorsFromEnv({
        JOBGEN_ICM_ENDPOINT: "https://icm.example/evaluate",
    });
    assert.deepEqual([...evaluators.keys()], ["ado_wiql", "icm"]);
    await assert.rejects(
        new IcmEvaluator({ endpoint: "", direct: false }).evaluate({
            generator: {},
            definition: { sourceConfig: {} },
            watermark: null,
        }),
        /endpoint is required/,
    );
});
