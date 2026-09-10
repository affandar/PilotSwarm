import test from "node:test";
import assert from "node:assert/strict";
import {
    createEvaluatorsFromEnv,
    effectiveJobGeneratorLeaseSeconds,
    normalizeSourceProviderId,
    parseRemoteSourceProviderDefinitions,
    RemoteSourceEvaluator,
} from "../dist/providers.js";

test("source provider ids are opaque but syntax constrained", () => {
    assert.equal(normalizeSourceProviderId("example.provider-v2"), "example.provider-v2");
    for (const invalid of ["", "Uppercase", "../provider", "provider name", "-provider"]) {
        assert.throws(() => normalizeSourceProviderId(invalid), /source provider id/);
    }
});

test("provider timeout validation uses the catalog's effective lease bounds", () => {
    assert.equal(effectiveJobGeneratorLeaseSeconds(1), 30);
    assert.equal(effectiveJobGeneratorLeaseSeconds(5000), 3600);
    assert.throws(
        () => effectiveJobGeneratorLeaseSeconds(0),
        /must be a positive integer/,
    );
    assert.throws(
        () => createEvaluatorsFromEnv({
            JOBGEN_LEASE_SECONDS: "5000",
            JOBGEN_SOURCE_PROVIDER_TIMEOUT_MS: "3600000",
        }),
        /must be shorter than JOBGEN_LEASE_SECONDS/,
    );
});

test("remote provider definitions parse endpoints and token env references", () => {
    assert.deepEqual(
        parseRemoteSourceProviderDefinitions(JSON.stringify([
            {
                id: "external-items",
                endpoint: "http://provider.internal/evaluate",
                tokenEnv: "EXTERNAL_PROVIDER_TOKEN",
            },
        ])),
        [{
            id: "external-items",
            endpoint: "http://provider.internal/evaluate",
            tokenEnv: "EXTERNAL_PROVIDER_TOKEN",
        }],
    );
    assert.throws(
        () => parseRemoteSourceProviderDefinitions("{}"),
        /must be a JSON array/,
    );
    assert.throws(
        () => parseRemoteSourceProviderDefinitions(JSON.stringify([
            { id: "duplicate", endpoint: "https://one.example/evaluate" },
            { id: "duplicate", endpoint: "https://two.example/evaluate" },
        ])),
        /duplicate provider id 'duplicate'/,
    );
    assert.throws(
        () => parseRemoteSourceProviderDefinitions(JSON.stringify([
            { id: "bad-url", endpoint: "file:///tmp/provider" },
        ])),
        /must use http\/https/,
    );
});

test("remote evaluator uses the normalized provider protocol", async () => {
    let request;
    const evaluator = new RemoteSourceEvaluator("external-items", {
        endpoint: "https://provider.example/evaluate",
        token: "secret",
        fetch: async (url, init) => {
            request = { url, init };
            return new Response(JSON.stringify({
                discoveries: [{ key: "item-7", payload: { id: 7 } }],
                watermark: "next",
            }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        },
    });
    const result = await evaluator.evaluate({
        generator: { generatorId: "g1" },
        definition: {
            definitionId: "d1",
            sourceConfig: { filter: "active" },
            guardrails: { maxItemsPerCycle: 25 },
        },
        watermark: "previous",
    });
    assert.equal(request.url, "https://provider.example/evaluate");
    assert.equal(request.init.headers.authorization, "Bearer secret");
    assert.deepEqual(JSON.parse(request.init.body), {
        generatorId: "g1",
        definitionId: "d1",
        config: { filter: "active" },
        watermark: "previous",
        limits: { maxItemsPerCycle: 25 },
    });
    assert.deepEqual(result, {
        discoveries: [{ key: "item-7", payload: { id: 7 } }],
        watermark: "next",
    });
});

test("remote evaluator rejects malformed normalized responses", async () => {
    const missingDiscoveries = new RemoteSourceEvaluator("external-items", {
        endpoint: "https://provider.example/evaluate",
        fetch: async () => new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
        }),
    });
    await assert.rejects(
        missingDiscoveries.evaluate({
            generator: { generatorId: "g1" },
            definition: { definitionId: "d1", sourceConfig: {} },
            watermark: null,
        }),
        /must contain discoveries\[\]/,
    );

    const missingKey = new RemoteSourceEvaluator("external-items", {
        endpoint: "https://provider.example/evaluate",
        fetch: async () => new Response(JSON.stringify({
            discoveries: [{ payload: { id: 1 } }],
        }), {
            status: 200,
            headers: { "content-type": "application/json" },
        }),
    });
    await assert.rejects(
        missingKey.evaluate({
            generator: { generatorId: "g1" },
            definition: { definitionId: "d1", sourceConfig: {} },
            watermark: null,
        }),
        /missing a stable key/,
    );
});

test("remote evaluator bounds stalled requests and propagates cancellation", async () => {
    let timeoutSignal;
    const timedOut = new RemoteSourceEvaluator("external-items", {
        endpoint: "https://provider.example/evaluate",
        requestTimeoutMs: 10,
        fetch: async (_url, init) => {
            timeoutSignal = init.signal;
            return await new Promise((_resolve, reject) => {
                init.signal.addEventListener(
                    "abort",
                    () => reject(init.signal.reason ?? new Error("aborted")),
                    { once: true },
                );
            });
        },
    });
    await assert.rejects(
        timedOut.evaluate({
            generator: { generatorId: "g1" },
            definition: { definitionId: "d1", sourceConfig: {} },
            watermark: null,
        }),
        /timed out after 10ms/,
    );
    assert.equal(timeoutSignal.aborted, true);

    const stalledBody = new RemoteSourceEvaluator("external-items", {
        endpoint: "https://provider.example/evaluate",
        requestTimeoutMs: 10,
        fetch: async (_url, init) => ({
            ok: true,
            async json() {
                return await new Promise((_resolve, reject) => {
                    init.signal.addEventListener(
                        "abort",
                        () => reject(init.signal.reason ?? new Error("aborted")),
                        { once: true },
                    );
                });
            },
        }),
    });
    await assert.rejects(
        stalledBody.evaluate({
            generator: { generatorId: "g1" },
            definition: { definitionId: "d1", sourceConfig: {} },
            watermark: null,
        }),
        /timed out after 10ms/,
    );

    let cancellationSignal;
    const cancelled = new RemoteSourceEvaluator("external-items", {
        endpoint: "https://provider.example/evaluate",
        fetch: async (_url, init) => {
            cancellationSignal = init.signal;
            return await new Promise((_resolve, reject) => {
                init.signal.addEventListener(
                    "abort",
                    () => reject(new Error("controller stopping")),
                    { once: true },
                );
            });
        },
    });
    const abort = new AbortController();
    const evaluation = cancelled.evaluate({
        generator: { generatorId: "g1" },
        definition: { definitionId: "d1", sourceConfig: {} },
        watermark: null,
        signal: abort.signal,
    });
    abort.abort();
    await assert.rejects(evaluation, /controller stopping/);
    assert.equal(cancellationSignal.aborted, true);
});

test("provider registry includes configured remote providers", async () => {
    const evaluators = createEvaluatorsFromEnv({
        JOBGEN_SOURCE_PROVIDERS_JSON: JSON.stringify([
            {
                id: "external-items",
                endpoint: "https://provider.example/evaluate",
                tokenEnv: "EXTERNAL_PROVIDER_TOKEN",
            },
        ]),
        EXTERNAL_PROVIDER_TOKEN: "secret",
    }, async (_url, init) => {
        assert.equal(init.headers.authorization, "Bearer secret");
        return new Response(JSON.stringify({ discoveries: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    });

    assert.deepEqual([...evaluators.keys()], ["external-items"]);
    await evaluators.get("external-items").evaluate({
        generator: { generatorId: "g1" },
        definition: { definitionId: "d1", sourceConfig: {} },
        watermark: null,
    });
});

test("provider registry only includes explicitly configured remote providers", () => {
    assert.deepEqual([...createEvaluatorsFromEnv({}).keys()], []);
    const evaluators = createEvaluatorsFromEnv({
        JOBGEN_SOURCE_PROVIDERS_JSON: JSON.stringify([{
            id: "ado_wiql",
            endpoint: "https://provider.example/evaluate",
        }]),
    });
    assert.deepEqual([...evaluators.keys()], ["ado_wiql"]);
});

test("provider registry rejects missing token env and legacy provider settings", () => {
    assert.throws(
        () => createEvaluatorsFromEnv({
            JOBGEN_SOURCE_PROVIDERS_JSON: JSON.stringify([{
                id: "external-items",
                endpoint: "https://provider.example/evaluate",
                tokenEnv: "MISSING_TOKEN",
            }]),
        }),
        /requires token env MISSING_TOKEN/,
    );
    assert.throws(
        () => createEvaluatorsFromEnv({
            JOBGEN_ADO_WIQL_ENDPOINT: "https://legacy.example/evaluate",
        }),
        /register provider 'ado_wiql' through JOBGEN_SOURCE_PROVIDERS_JSON/,
    );
    assert.doesNotThrow(
        () => createEvaluatorsFromEnv({
            JOBGEN_ADO_WIQL_TOKEN: "legacy-token",
            JOBGEN_SOURCE_PROVIDERS_JSON: JSON.stringify([{
                id: "ado_wiql",
                endpoint: "https://provider.example/evaluate",
            }]),
        }),
    );
    assert.throws(
        () => createEvaluatorsFromEnv({
            JOBGEN_ICM_ENDPOINT: "https://legacy.example/evaluate",
        }),
        /register provider 'icm' through JOBGEN_SOURCE_PROVIDERS_JSON/,
    );
    assert.doesNotThrow(
        () => createEvaluatorsFromEnv({
            JOBGEN_ICM_ENDPOINT: "https://legacy.example/evaluate",
            JOBGEN_SOURCE_PROVIDERS_JSON: JSON.stringify([{
                id: "icm",
                endpoint: "https://provider.example/evaluate",
            }]),
        }),
    );
    assert.throws(
        () => createEvaluatorsFromEnv({
            JOBGEN_KUSTO_ENDPOINT: "https://legacy.example/evaluate",
        }),
        /register provider 'kusto' through JOBGEN_SOURCE_PROVIDERS_JSON/,
    );
    assert.doesNotThrow(
        () => createEvaluatorsFromEnv({
            JOBGEN_KUSTO_TOKEN: "legacy-token",
            JOBGEN_SOURCE_PROVIDERS_JSON: JSON.stringify([{
                id: "kusto",
                endpoint: "https://provider.example/evaluate",
            }]),
        }),
    );
    assert.throws(
        () => createEvaluatorsFromEnv({
            JOBGEN_LEASE_SECONDS: "60",
            JOBGEN_SOURCE_PROVIDER_TIMEOUT_MS: "60000",
        }),
        /must be shorter than JOBGEN_LEASE_SECONDS/,
    );
});
