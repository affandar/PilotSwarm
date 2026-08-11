/**
 * A BYOK model must declare its context window as `max_prompt_tokens`.
 *
 * The Copilot runtime has no catalog entry for a bring-your-own-key model, so
 * it falls back to a 128000 token limit. That limit is what the child process
 * divides by to decide when to compact, so a 1M-window model was compacting at
 * roughly 102K and losing history it did not need to lose.
 *
 * Measured against @github/copilot-sdk 1.0.9, kimi-k3, one message per arm,
 * reading session.usage_info.tokenLimit:
 *
 *   max_context_window_tokens alone -> 128000    (the runtime default)
 *   max_prompt_tokens alone         -> 1048576
 *   both                            -> 1048576
 *
 * So `max_context_window_tokens` on its own is inert. Dropping
 * `max_prompt_tokens` would leave the declaration looking correct while
 * changing nothing — the exact silent failure this test exists to catch.
 *
 * Run: node --test test/unit/byok-context-window.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildByokModelCapabilities } from "../../dist/session-manager.js";

const kimi = {
    modelName: "kimi-k3",
    contextWindowSizes: { default: 128000, long_context: 1048576 },
    supportedContextTiers: ["default", "long_context"],
    defaultContextTier: "default",
    supportedReasoningEfforts: ["low", "medium", "high"],
    vision: { maxImages: 4, maxImageBytes: 5242880 },
};

test("max_prompt_tokens is set, not just max_context_window_tokens", () => {
    const caps = buildByokModelCapabilities(kimi, "long_context");
    assert.equal(caps.limits.max_prompt_tokens, 1048576,
        "without max_prompt_tokens the runtime keeps its 128000 default");
    assert.equal(caps.limits.max_context_window_tokens, 1048576);
});

test("the declared window follows the session's tier", () => {
    assert.equal(buildByokModelCapabilities(kimi, "default").limits.max_prompt_tokens, 128000);
    assert.equal(buildByokModelCapabilities(kimi, "long_context").limits.max_prompt_tokens, 1048576);
});

test("an unknown or missing tier declares the largest window", () => {
    // Callers resolve the tier first; this is the belt-and-braces path. Claiming
    // the largest is the safer error — a too-small claim compacts early, which
    // is the bug being fixed.
    assert.equal(buildByokModelCapabilities(kimi, undefined).limits.max_prompt_tokens, 1048576);
    assert.equal(buildByokModelCapabilities(kimi, "no_such_tier").limits.max_prompt_tokens, 1048576);
});

test("a model with a single window needs no tier", () => {
    const foundry = { modelName: "gpt-5.6-terra", contextWindowSizes: { default: 128000 } };
    const caps = buildByokModelCapabilities(foundry, "default");
    assert.equal(caps.limits.max_prompt_tokens, 128000);
});

test("reasoning and vision support are declared from the catalog", () => {
    const caps = buildByokModelCapabilities(kimi, "default");
    // True information, and it costs nothing. It does NOT make the runtime put
    // reasoning_effort on the wire for a BYOK provider — that still needs
    // applyReasoningEffortToModelName plus a stripping proxy.
    assert.equal(caps.supports.reasoningEffort, true);
    assert.equal(caps.supports.vision, true);
    assert.equal(caps.limits.vision.max_prompt_images, 4);
    assert.equal(caps.limits.vision.max_prompt_image_size, 5242880);
});

test("a text-only model claims neither vision nor reasoning", () => {
    // An empty override would assert "cannot see, cannot reason" rather than
    // "unknown", so absent fields must stay absent.
    const deepseek = { modelName: "deepseek-v4-flash", contextWindowSizes: { default: 1048576 } };
    const caps = buildByokModelCapabilities(deepseek, "default");
    assert.equal(caps.supports, undefined);
    assert.equal(caps.limits.vision, undefined);
});

test("no descriptor means no declaration at all", () => {
    assert.equal(buildByokModelCapabilities(undefined, "default"), undefined);
    assert.equal(buildByokModelCapabilities({ modelName: "bare" }, "default"), undefined);
});

test("a model with efforts but no window gets no declaration at all", () => {
    // The blast-radius guard. This is the shape of every non-github model in
    // the waldemort deployment: supportedReasoningEfforts declared, no
    // contextWindowSizes. Without this, 8 of its 14 models would each start
    // receiving {supports:{reasoningEffort:true}} — which buys nothing,
    // because declaring supports.reasoningEffort does not make the runtime
    // send reasoning_effort for a BYOK provider, and still overrides runtime
    // state. limits is the only part that does real work.
    const waldemortShape = { modelName: "gpt-5.4", supportedReasoningEfforts: ["medium", "xhigh"] };
    assert.equal(buildByokModelCapabilities(waldemortShape, undefined), undefined);
    assert.equal(buildByokModelCapabilities(waldemortShape, "default"), undefined);
});

test("a vision model with no window still declares, via limits.vision", () => {
    // Dropping supports-only blocks must not drop vision: a real vision
    // declaration always produces limits.vision, so it survives the guard.
    const seer = { modelName: "kimi-k2p6", vision: { maxImages: 4, maxImageBytes: 100 } };
    const caps = buildByokModelCapabilities(seer, undefined);
    assert.equal(caps.supports.vision, true);
    assert.equal(caps.limits.vision.max_prompt_images, 4);
});
