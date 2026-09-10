import assert from "node:assert/strict";
import test from "node:test";

import {
    JOB_GENERATOR_PROVIDER_API_VERSION,
    closeProviders,
    createProviderHostServer,
    loadProviderPlugins,
    parseProviderPluginDefinitions,
    shutdownProviderHost,
} from "../dist/index.js";

const AUTH_TOKEN = "provider-host-test-token";

function authorizedHeaders(token = AUTH_TOKEN) {
    return {
        authorization: "Bearer " + token,
        "content-type": "application/json",
    };
}

function plugin(id = "example-items") {
    return {
        apiVersion: JOB_GENERATOR_PROVIDER_API_VERSION,
        id,
        createProvider() {
            return {
                id,
                async evaluate(request) {
                    return {
                        discoveries: [{
                            key: `${request.generatorId}-1`,
                            payload: { filter: request.config.filter ?? null },
                        }],
                        watermark: { cursor: "next" },
                    };
                },
            };
        },
    };
}

async function startServer(providers, options = {}) {
    const server = createProviderHostServer({
        providers,
        authToken: AUTH_TOKEN,
        logger: { info() {}, warn() {}, error() {} },
        ...options,
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    return {
        server,
        url: `http://127.0.0.1:${address.port}`,
    };
}

async function stopServer(server) {
    await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
}

function requestBody(overrides = {}) {
    return JSON.stringify({
        generatorId: "g1",
        definitionId: "d1",
        config: {},
        watermark: null,
        ...overrides,
    });
}

test("plugin definitions and factories load without provider-specific knowledge", async () => {
    const definitions = parseProviderPluginDefinitions(JSON.stringify([{
        id: "example-items",
        module: "example-module",
        config: { audience: "example" },
    }]));
    const providers = await loadProviderPlugins(definitions, {
        importModule: async (specifier) => {
            assert.equal(specifier, "example-module");
            return { default: plugin() };
        },
    });
    assert.deepEqual([...providers.keys()], ["example-items"]);

    await assert.rejects(
        loadProviderPlugins([{
            id: "other-items",
            module: "example-module",
            config: {},
        }], {
            importModule: async () => ({ default: plugin() }),
        }),
        /does not match registration/,
    );

    let closed = false;
    await assert.rejects(
        loadProviderPlugins([{
            id: "example-items",
            module: "example-module",
            config: {},
        }], {
            importModule: async () => ({
                default: {
                    ...plugin(),
                    createProvider() {
                        return {
                            id: "wrong-items",
                            async evaluate() {
                                return { discoveries: [] };
                            },
                            async close() {
                                closed = true;
                            },
                        };
                    },
                },
            }),
        }),
        /does not match registration/,
    );
    assert.equal(closed, true);
});

test("provider host authenticates and invokes registered modules", async (t) => {
    const providers = new Map([[
        "example-items",
        await plugin().createProvider(),
    ]]);
    const { server, url } = await startServer(providers);
    t.after(() => stopServer(server));

    const unauthorized = await fetch(
        `${url}/providers/example-items/evaluate`,
        {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
        },
    );
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${url}/providers/example-items/evaluate`, {
        method: "POST",
        headers: authorizedHeaders(),
        body: requestBody({
            generatorId: "generator-1",
            config: { filter: "active" },
            limits: { maxItemsPerCycle: 10 },
        }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        discoveries: [{
            key: "generator-1-1",
            payload: { filter: "active" },
        }],
        watermark: { cursor: "next" },
    });
});

test("provider host validates requests and provider responses", async (t) => {
    const providers = new Map([["bad-provider", {
        id: "bad-provider",
        async evaluate() {
            return { discoveries: [{ key: "1", payload: "not-an-object" }] };
        },
    }]]);
    const { server, url } = await startServer(providers);
    t.after(() => stopServer(server));

    const invalidLimit = await fetch(`${url}/providers/bad-provider/evaluate`, {
        method: "POST",
        headers: authorizedHeaders(),
        body: requestBody({ limits: { maxItemsPerCycle: 0 } }),
    });
    assert.equal(invalidLimit.status, 400);

    const invalidResponse = await fetch(
        `${url}/providers/bad-provider/evaluate`,
        {
            method: "POST",
            headers: authorizedHeaders(),
            body: requestBody(),
        },
    );
    assert.equal(invalidResponse.status, 502);
    assert.deepEqual(await invalidResponse.json(), {
        error: {
            code: "invalid_provider_response",
            message: "provider 'bad-provider' discovery payload must be an object",
        },
    });
});

test("provider host rejects non-JSON provider payload values", async (t) => {
    const providers = new Map([["bad-json", {
        id: "bad-json",
        async evaluate() {
            return {
                discoveries: [{
                    key: "1",
                    payload: { missing: undefined, notFinite: Number.NaN },
                }],
            };
        },
    }]]);
    const { server, url } = await startServer(providers);
    t.after(() => stopServer(server));
    const response = await fetch(`${url}/providers/bad-json/evaluate`, {
        method: "POST",
        headers: authorizedHeaders(),
        body: requestBody(),
    });
    assert.equal(response.status, 502);
    assert.equal(
        (await response.json()).error.code,
        "invalid_provider_response",
    );
});

test("provider host supports current and previous auth tokens", async (t) => {
    const providers = new Map([["example-items", await plugin().createProvider()]]);
    const { server, url } = await startServer(providers, {
        previousAuthToken: "previous-token",
    });
    t.after(() => stopServer(server));
    for (const token of [AUTH_TOKEN, "previous-token"]) {
        const response = await fetch(`${url}/providers/example-items/evaluate`, {
            method: "POST",
            headers: authorizedHeaders(token),
            body: requestBody(),
        });
        assert.equal(response.status, 200);
    }
});

test("provider host bounds evaluations and aborts the plugin signal", async (t) => {
    let aborted = false;
    const providers = new Map([["slow-provider", {
        id: "slow-provider",
        async evaluate(_request, { signal }) {
            await new Promise((resolve) => {
                signal.addEventListener("abort", () => {
                    aborted = true;
                    resolve();
                }, { once: true });
            });
            return { discoveries: [] };
        },
    }]]);
    const { server, url } = await startServer(providers, {
        evaluateTimeoutMs: 10,
    });
    t.after(() => stopServer(server));
    const response = await fetch(`${url}/providers/slow-provider/evaluate`, {
        method: "POST",
        headers: authorizedHeaders(),
        body: requestBody(),
    });
    assert.equal(response.status, 504);
    assert.equal((await response.json()).error.code, "provider_timeout");
    assert.equal(aborted, true);
});

test("shutdown awaits provider cleanup after an evaluation timeout", async () => {
    let evaluationFinished = false;
    let closeObservedFinishedEvaluation = false;
    const providers = new Map([["slow-cleanup-provider", {
        id: "slow-cleanup-provider",
        async evaluate(_request, { signal }) {
            await new Promise((resolve) => {
                signal.addEventListener("abort", resolve, { once: true });
            });
            await new Promise((resolve) => setTimeout(resolve, 50));
            evaluationFinished = true;
            throw new Error("evaluation cancelled");
        },
        async close() {
            closeObservedFinishedEvaluation = evaluationFinished;
        },
    }]]);
    const { server, url } = await startServer(providers, {
        evaluateTimeoutMs: 10,
    });
    const response = await fetch(
        `${url}/providers/slow-cleanup-provider/evaluate`,
        {
            method: "POST",
            headers: authorizedHeaders(),
            body: requestBody(),
        },
    );
    assert.equal(response.status, 504);

    await shutdownProviderHost(server, providers.values(), 300);

    assert.equal(evaluationFinished, true);
    assert.equal(closeObservedFinishedEvaluation, true);
});

test("forced shutdown does not close providers while evaluation cleanup is active", async () => {
    let releaseCleanup;
    const cleanupGate = new Promise((resolve) => {
        releaseCleanup = resolve;
    });
    let markEvaluationFinished;
    const evaluationFinished = new Promise((resolve) => {
        markEvaluationFinished = resolve;
    });
    let closeCalled = false;
    const providers = new Map([["stuck-cleanup-provider", {
        id: "stuck-cleanup-provider",
        async evaluate(_request, { signal }) {
            await new Promise((resolve) => {
                signal.addEventListener("abort", resolve, { once: true });
            });
            await cleanupGate;
            markEvaluationFinished();
            throw new Error("evaluation cancelled");
        },
        async close() {
            closeCalled = true;
        },
    }]]);
    const { server, url } = await startServer(providers, {
        evaluateTimeoutMs: 10,
    });
    const response = await fetch(
        `${url}/providers/stuck-cleanup-provider/evaluate`,
        {
            method: "POST",
            headers: authorizedHeaders(),
            body: requestBody(),
        },
    );
    assert.equal(response.status, 504);

    await assert.rejects(
        shutdownProviderHost(server, providers.values(), 60),
        /provider host shutdown failed/,
    );
    assert.equal(closeCalled, false);

    releaseCleanup();
    await evaluationFinished;
});

test("provider host independently enforces maxItemsPerCycle", async (t) => {
    const providers = new Map([["unbounded-provider", {
        id: "unbounded-provider",
        async evaluate() {
            return {
                discoveries: [
                    { key: "1", payload: {} },
                    { key: "2", payload: {} },
                ],
            };
        },
    }]]);
    const { server, url } = await startServer(providers);
    t.after(() => stopServer(server));
    const response = await fetch(
        `${url}/providers/unbounded-provider/evaluate`,
        {
            method: "POST",
            headers: authorizedHeaders(),
            body: requestBody({ limits: { maxItemsPerCycle: 1 } }),
        },
    );
    assert.equal(response.status, 502);
    assert.equal(
        (await response.json()).error.code,
        "invalid_provider_response",
    );
});

test("provider host exposes health and rejects invalid HTTP requests", async (t) => {
    const providers = new Map([["example-items", await plugin().createProvider()]]);
    const { server, url } = await startServer(providers, {
        bodyLimitBytes: 32,
    });
    t.after(() => stopServer(server));

    const health = await fetch(`${url}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
        status: "ok",
        providers: ["example-items"],
    });

    const unknown = await fetch(`${url}/providers/missing/evaluate`, {
        method: "POST",
        headers: authorizedHeaders(),
        body: requestBody(),
    });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, "provider_not_found");

    const wrongContentType = await fetch(
        `${url}/providers/example-items/evaluate`,
        {
            method: "POST",
            headers: { authorization: `Bearer ${AUTH_TOKEN}` },
            body: requestBody(),
        },
    );
    assert.equal(wrongContentType.status, 415);

    const oversized = await fetch(
        `${url}/providers/example-items/evaluate`,
        {
            method: "POST",
            headers: authorizedHeaders(),
            body: requestBody(),
        },
    );
    assert.equal(oversized.status, 413);
});

test("provider shutdown is bounded even when close does not settle", async () => {
    const startedAt = Date.now();
    await assert.rejects(
        closeProviders([{
            id: "slow-close",
            async evaluate() {
                return { discoveries: [] };
            },
            async close() {
                await new Promise((resolve) => setTimeout(resolve, 1_000));
            },
        }], Date.now() + 10),
        /provider shutdown timed out/,
    );
    assert.ok(Date.now() - startedAt < 500);
});

test("host shutdown aborts and awaits active provider evaluations before close", async () => {
    let markStarted;
    const started = new Promise((resolve) => {
        markStarted = resolve;
    });
    let evaluationFinished = false;
    let closeObservedFinishedEvaluation = false;
    const providers = new Map([["shutdown-provider", {
        id: "shutdown-provider",
        async evaluate(_request, { signal }) {
            markStarted();
            await new Promise((resolve) => {
                signal.addEventListener("abort", resolve, { once: true });
            });
            await new Promise((resolve) => setTimeout(resolve, 20));
            evaluationFinished = true;
            throw new Error("evaluation cancelled");
        },
        async close() {
            closeObservedFinishedEvaluation = evaluationFinished;
        },
    }]]);
    const { server, url } = await startServer(providers);
    const request = fetch(`${url}/providers/shutdown-provider/evaluate`, {
        method: "POST",
        headers: authorizedHeaders(),
        body: requestBody(),
    });
    await started;

    await shutdownProviderHost(server, providers.values(), 300);
    const response = await request;

    assert.equal(response.status, 502);
    assert.equal(evaluationFinished, true);
    assert.equal(closeObservedFinishedEvaluation, true);
});
