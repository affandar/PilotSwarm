import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ByokRequestCompatibility, createCopilotClient, needsByokRequestCompatibility } from "../../dist/copilot-client.js";

test("published dependencies pin the tested SDK and CLI, not just the workspace lock", () => {
    const { dependencies } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    assert.equal(dependencies["@github/copilot-sdk"], "1.0.13");
    assert.equal(dependencies["@github/copilot"], "1.0.83");
});

test("only OpenAI/Azure completions clients get the shim; native auth/transports are untouched", () => {
    for (const provider of [undefined, null, { type: "github" }, { type: "anthropic" }, { type: "openai", wireApi: "responses" }, { type: "azure", wireApi: "responses" }]) {
        assert.equal(needsByokRequestCompatibility(provider), false);
        const client = createCopilotClient({ useLoggedInUser: false }, provider);
        assert.equal(client.requestHandler, null);
        assert.equal(client.connectionConfig.kind, "stdio");
    }
    for (const provider of [{}, { type: "openai" }, { type: "azure" }, { type: "openai", wireApi: "completions" }]) {
        assert.equal(needsByokRequestCompatibility(provider), true);
        const client = createCopilotClient({ useLoggedInUser: false }, provider);
        assert.ok(client.requestHandler instanceof ByokRequestCompatibility);
        assert.equal(client.connectionConfig.kind, "stdio");
    }
});

test("removes only top-level snippy, preserves headers/parameters, updates length and streams the response", async t => {
    const body = {
        model: "gpt-5.6-terra", messages: [{ role: "user", content: "snippy" }],
        snippy: { enabled: false }, temperature: 1, reasoning_effort: "medium",
        tools: [{ function: { name: "echo", parameters: { properties: { snippy: { type: "boolean" } } } } }],
        stream: true, stream_options: { include_usage: true }, future_supported_field: { keep: true },
    };
    const input = JSON.stringify(body);
    const request = new Request("https://example.invalid/openai/deployments/model/chat/completions?api-version=test", {
        method: "POST", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(input)), "api-key": "synthetic-secret", "x-test": "preserve" }, body: input,
    });
    let close;
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data: partial\n\n")); close = () => controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
    const signal = new AbortController().signal;
    const fetch = t.mock.method(globalThis, "fetch", async (forwarded, options) => {
        const actual = await forwarded.json();
        const expected = { ...body }; delete expected.snippy;
        assert.deepEqual(actual, expected);
        assert.equal(forwarded.headers.get("api-key"), "synthetic-secret");
        assert.equal(forwarded.headers.get("x-test"), "preserve");
        assert.equal(forwarded.headers.has("content-length"), false);
        assert.equal(forwarded.url, request.url);
        assert.equal(options.signal, signal);
        return response;
    });
    const result = await new ByokRequestCompatibility().sendRequest(request, { signal });
    assert.equal(result, response, "response returned before its stream completes");
    assert.equal(fetch.mock.callCount(), 1, "no retry");
    close();
    assert.match(await result.text(), /partial/);
});

for (const [path, type, body] of [
    ["/responses", "application/json", '{"snippy":false}'],
    ["/messages", "application/json", '{"snippy":false}'],
    ["/chat/completions-other", "application/json", '{"snippy":false}'],
    ["/chat/completions", "text/plain", "snippy"],
    ["/chat/completions", "application/json", "not JSON"],
    ["/chat/completions", "application/json", '[{"snippy":false}]'],
    ["/chat/completions", "application/json", '{"model":"x","future_field":1}'],
]) {
    test(`pass-through remains byte-identical: ${path} ${body}`, async t => {
        const request = new Request("https://example.invalid" + path, { method: "POST", headers: { "content-type": type }, body });
        t.mock.method(globalThis, "fetch", async forwarded => {
            assert.equal(forwarded, request);
            assert.equal(await forwarded.text(), body);
            return new Response("upstream validation error", { status: 400 });
        });
        const result = await new ByokRequestCompatibility().sendRequest(request, { signal: new AbortController().signal });
        assert.equal(result.status, 400);
    });
}

test("cancellation propagates instead of resending the model request", async t => {
    const controller = new AbortController();
    controller.abort(new Error("test cancellation"));
    const fetch = t.mock.method(globalThis, "fetch", async (_request, { signal }) => { throw signal.reason; });
    const request = new Request("https://example.invalid/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: '{"snippy":false}' });
    await assert.rejects(new ByokRequestCompatibility().sendRequest(request, { signal: controller.signal }), /test cancellation/);
    assert.equal(fetch.mock.callCount(), 1);
});
