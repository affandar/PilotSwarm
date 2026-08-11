/**
 * A BYOK model can declare vision, because no catalog will ever report it.
 *
 * getModelVisionInfo resolves capability from the Copilot model catalog. An
 * OpenAI-compatible provider is not in that catalog, so before this the lookup
 * always returned `vision: false` and the attachment gate dropped every image
 * as `no_vision_support` — no BYOK model could receive one, whatever it
 * actually supported.
 *
 * Run: node --test test/unit/byok-vision-declaration.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ModelProviderRegistry } from "../../dist/model-providers.js";

const registry = (models) => new ModelProviderRegistry({
    providers: [{ id: "fireworks", type: "openai", baseUrl: "https://example.invalid/v1", apiKey: "x", models }],
    defaultModel: `fireworks:${models[0].name ?? models[0]}`,
});

test("a declared vision block reaches the descriptor", () => {
    const r = registry([{ name: "kimi-k3", vision: { maxImages: 4, maxImageBytes: 5242880 } }]);
    const d = r.getDescriptor("fireworks:kimi-k3");
    assert.deepEqual(d.vision, { maxImages: 4, maxImageBytes: 5242880 });
});

test("a model without one carries no vision field at all", () => {
    // Absence must stay absent rather than becoming `vision: {}` — the lookup
    // branches on truthiness, so an empty object would claim vision falsely.
    const r = registry([{ name: "deepseek-v4-flash" }]);
    assert.equal("vision" in r.getDescriptor("fireworks:deepseek-v4-flash"), false);
});

test("limits are optional; the declaration alone is the claim", () => {
    const r = registry([{ name: "kimi-k3", vision: {} }]);
    // `vision: {}` is still a deliberate statement that the model can see;
    // the gate then falls back to its own ATTACHMENT_MAX_BYTES ceiling.
    assert.deepEqual(r.getDescriptor("fireworks:kimi-k3").vision, {});
});

test("media types survive the round trip", () => {
    const r = registry([{ name: "kimi-k3", vision: { supportedMediaTypes: ["image/png"] } }]);
    assert.deepEqual(r.getDescriptor("fireworks:kimi-k3").vision.supportedMediaTypes, ["image/png"]);
});
