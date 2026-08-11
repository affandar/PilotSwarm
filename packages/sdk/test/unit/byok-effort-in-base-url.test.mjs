/**
 * A reasoning effort rides on the provider baseUrl — for `openai-proxy` only.
 *
 * PilotSwarm passes a per-session reasoning effort to `@github/copilot-sdk` as
 * `config.reasoningEffort`. The SDK spawns the `@github/copilot` binary and
 * THAT child process builds the HTTP request; it only emits `reasoning_effort`
 * for provider `type: github`. For a BYOK provider the field is dropped and the
 * outbound body carries `model` and `tools` only. So the effort is appended to
 * the provider baseUrl as `/x-reasoning-effort/<level>` and a proxy at that
 * baseUrl strips it back off (grimfanda deploy/openai-compat-proxy.mjs).
 *
 * It used to ride in the model NAME, as `kimi-k3::effort=high`. @github/copilot
 * 1.0.79 parses `model:key=value` as its own model-options syntax and rejects
 * unknown keys, so every turn with an effort set died with
 * "Unknown model option key: effort". The url path is opaque to the runtime —
 * verified end to end: baseUrl `http://127.0.0.1:8787/x-reasoning-effort/high`
 * arrived at the proxy as `POST /x-reasoning-effort/high/chat/completions`.
 *
 * That only works when something IS stripping it, so it is opt-in: a provider
 * declares `type: "openai-proxy"` to promise that its endpoint does. The
 * property these tests exist to protect is that `github`, `openai`, `azure` and
 * `anthropic` are byte-identical to before — a deployment with a plain
 * `openai` provider and no proxy must keep working, and would otherwise send
 * every request to a path its provider does not serve.
 *
 * Run: node --test test/unit/byok-effort-in-base-url.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
    REASONING_EFFORT_PATH_PREFIX,
    ModelProviderRegistry,
    applyReasoningEffortToProviderConfig,
    decodeReasoningEffortFromBaseUrl,
    encodeReasoningEffortInBaseUrl,
} from "../../dist/model-providers.js";

const EFFORTS = ["low", "medium", "high"];
const BASE = "https://example.invalid/v1";

/** A one-model registry, so the descriptors are the real ones the runtime uses. */
function registryFor({ type, name, efforts = EFFORTS }) {
    const provider = type === "github"
        ? { id: "p", type, githubToken: "t", models: [{ name, supportedReasoningEfforts: efforts }] }
        : { id: "p", type, baseUrl: BASE, apiKey: "k", models: [{ name, supportedReasoningEfforts: efforts }] };
    return new ModelProviderRegistry({ providers: [provider] });
}

function descriptorFor(spec) {
    return registryFor(spec).getDescriptor(`p:${spec.name}`);
}

const cfg = (baseUrl = BASE) => ({ type: "openai", baseUrl, apiKey: "k" });

// ─── Only openai-proxy opts in ───────────────────────────────────

test("an openai-proxy provider carries the effort on its baseUrl", () => {
    const d = descriptorFor({ type: "openai-proxy", name: "kimi-k3" });
    const out = applyReasoningEffortToProviderConfig(cfg(), d, "high");
    assert.equal(out.baseUrl, `${BASE}/x-reasoning-effort/high`);
    // Everything else about the provider is carried through untouched.
    assert.equal(out.type, "openai");
    assert.equal(out.apiKey, "k");
});

test("every other provider type is byte-identical, at every effort", () => {
    // The safety property. A deployment on a plain `openai` provider has no
    // proxy stripping anything, so the extra path would 404 on every request.
    for (const type of ["github", "openai", "azure", "anthropic"]) {
        const d = descriptorFor({ type, name: "some-model" });
        assert.equal(d.providerType, type);
        for (const effort of EFFORTS) {
            const input = cfg();
            assert.equal(
                applyReasoningEffortToProviderConfig(input, d, effort),
                input,
                `type: ${type} must not be rewritten`,
            );
        }
    }
});

test("the model name is never touched", () => {
    // The whole point of the move. Any colon in a model name is now parsed by
    // @github/copilot as its own `model:key=value` option syntax.
    const d = descriptorFor({ type: "openai-proxy", name: "kimi-k3" });
    const out = applyReasoningEffortToProviderConfig(cfg(), d, "high");
    assert.equal("model" in out, false);
    assert.equal(out.baseUrl.includes("::"), false);
});

// ─── openai-proxy is an OpenAI endpoint on the wire ──────────────

test("the SDK never sees the openai-proxy value", () => {
    // @github/copilot-sdk's provider union is openai | azure | anthropic. A new
    // value leaking into sdkProvider.type would be rejected by the SDK.
    const resolved = registryFor({ type: "openai-proxy", name: "kimi-k3" }).resolve("p:kimi-k3");
    assert.equal(resolved.type, "openai-proxy");        // the declaration survives here
    assert.equal(resolved.sdkProvider.type, "openai");  // ...and nowhere else
    assert.equal(resolved.sdkProvider.baseUrl, BASE);
    assert.equal(resolved.sdkProvider.apiKey, "k");
    assert.equal("azure" in resolved.sdkProvider, false);
});

// ─── Inert when there is nothing to say ──────────────────────────

test("no effort set — the config is untouched, by identity", () => {
    const d = descriptorFor({ type: "openai-proxy", name: "kimi-k3" });
    for (const effort of [undefined, null, ""]) {
        const input = cfg();
        assert.equal(applyReasoningEffortToProviderConfig(input, d, effort), input);
    }
});

test("a model the registry has never heard of is untouched", () => {
    // No descriptor means no declaration, and no declaration means no promise
    // that anything downstream would strip a prefix.
    const input = cfg();
    assert.equal(applyReasoningEffortToProviderConfig(input, undefined, "high"), input);
});

test("a provider with no baseUrl is untouched", () => {
    const d = descriptorFor({ type: "openai-proxy", name: "kimi-k3" });
    const input = { type: "openai", apiKey: "k" };
    assert.equal(applyReasoningEffortToProviderConfig(input, d, "high"), input);
    assert.equal(applyReasoningEffortToProviderConfig(undefined, d, "high"), undefined);
});

test("an effort the model does not declare is not encoded", () => {
    // deepseek-v4-flash declares none at all: encoding "high" here would hand
    // the provider a level it never advertised, which is the 400 this avoids.
    const none = descriptorFor({ type: "openai-proxy", name: "deepseek-v4-flash", efforts: [] });
    const a = cfg();
    assert.equal(applyReasoningEffortToProviderConfig(a, none, "high"), a);

    const partial = descriptorFor({ type: "openai-proxy", name: "kimi-k3", efforts: ["low", "medium"] });
    const b = cfg();
    assert.equal(applyReasoningEffortToProviderConfig(b, partial, "high"), b);
});

// ─── Real base urls survive ──────────────────────────────────────

test("base urls full of delimiter-ish characters round-trip intact", () => {
    const urls = [
        "http://127.0.0.1:8787",
        "https://api.fireworks.ai/inference/v1",
        "https://grimfanda-foundry.cognitiveservices.azure.com/openai/v1",
        "https://example.invalid/v1/x-reasoning",          // prefix-ish, but not the prefix
        "https://example.invalid/x-reasoning-effort",      // no level
        "https://example.invalid/x-reasoning-effort/",     // empty level
        "http://host/effort=high",
    ];
    for (const url of urls) {
        assert.deepEqual(
            decodeReasoningEffortFromBaseUrl(url),
            { baseUrl: url, reasoningEffort: null },
            `${url} must decode to itself`,
        );
        assert.equal(
            decodeReasoningEffortFromBaseUrl(encodeReasoningEffortInBaseUrl(url, "high")).baseUrl,
            url.replace(/\/+$/, ""),
            `${url} must survive an encode/decode round trip`,
        );
    }
});

test("encode/decode round-trips every effort level", () => {
    for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
        const encoded = encodeReasoningEffortInBaseUrl(BASE, effort);
        assert.equal(encoded, `${BASE}${REASONING_EFFORT_PATH_PREFIX}/${effort}`);
        assert.deepEqual(decodeReasoningEffortFromBaseUrl(encoded), { baseUrl: BASE, reasoningEffort: effort });
    }
});

test("a trailing slash does not produce a doubled slash", () => {
    // `https://host/v1//x-reasoning-effort/high` would not match the proxy's
    // front-of-path check, so the effort would be silently lost.
    assert.equal(encodeReasoningEffortInBaseUrl(`${BASE}/`, "high"), `${BASE}/x-reasoning-effort/high`);
    assert.equal(encodeReasoningEffortInBaseUrl(`${BASE}///`, "high"), `${BASE}/x-reasoning-effort/high`);
});

test("an unknown level is not encoded, and a near-miss path is not decoded", () => {
    assert.equal(encodeReasoningEffortInBaseUrl(BASE, "turbo"), BASE);
    // Not a level the runtime knows, so this is a real baseUrl as far as
    // anyone here can tell — truncating it would be worse.
    assert.deepEqual(
        decodeReasoningEffortFromBaseUrl(`${BASE}/x-reasoning-effort/turbo`),
        { baseUrl: `${BASE}/x-reasoning-effort/turbo`, reasoningEffort: null },
    );
});

test("encoding twice does not stack prefixes", () => {
    const once = encodeReasoningEffortInBaseUrl(BASE, "high");
    assert.equal(encodeReasoningEffortInBaseUrl(once, "low"), once);
});
