import { describe, expect, it } from "vitest";
import { selectNativeCriticModel } from "../../src/native-critic-model.ts";

const GPT = "gpt-5.6-terra";
const CLAUDE = "claude-sonnet-4.6";
const available = (...ids) => ids.map(id => ({ id, policy: { state: "enabled" } }));
const permitted = (modelName, extra = {}) => ({ providerId: "github-owner", providerType: "github", modelName, ...extra });
const choose = extra => selectNativeCriticModel({ parentModel: GPT, availableModels: available(CLAUDE), ...extra });

describe("native critic model selection", () => {
    it("selects opposite families in either direction from the actual standalone catalog", () => {
        expect(choose()).toBe(CLAUDE);
        expect(choose({ parentModel: CLAUDE, availableModels: available(GPT) })).toBe(GPT);
        expect(choose({ availableModels: available(GPT, "gpt-5.6-sol") })).toBeUndefined();
        expect(choose({ parentModel: CLAUDE, availableModels: available(CLAUDE, "claude-opus-4.6") })).toBeUndefined();
    });

    it.each(["o3", "gemini-3-pro", "github-owner:gpt-5.6-terra", "openai/gpt-5.6-terra", "GPT-5.6-terra", "gpt-", " gpt-5.6-terra", ""])(
        "does not infer a family or provider from unknown/qualified parent ID %s", parentModel => {
            expect(choose({ parentModel })).toBeUndefined();
        });

    it("fails closed for missing catalog, lookup failures, and unknown IDs without inventing a fallback", () => {
        for (const availableModels of [[], undefined, null]) expect(choose({ availableModels })).toBeUndefined();
        for (const id of ["other:claude-sonnet-4.6", "anthropic/claude-sonnet-4.6", "gemini-3-pro", "CLAUDE-sonnet-4.6", "claude-", ""]) {
            expect(choose({ availableModels: available(id) })).toBeUndefined();
        }
    });

    it("intersects the permitted registry and token catalog for the exact parent provider", () => {
        const registry = {
            parentProviderId: "github-owner", parentProviderType: "github",
            permittedModels: [permitted(CLAUDE), permitted("claude-sonnet-9.0"), permitted("claude-opus-4.6", { providerId: "other-owner" })],
            availableModels: available(CLAUDE, "claude-opus-4.6", "claude-sonnet-8.0"),
        };
        expect(choose(registry)).toBe(CLAUDE);
        expect(choose({ ...registry, permittedModels: [] })).toBeUndefined();
        expect(choose({ ...registry, permittedModels: [permitted("claude-sonnet-9.0")] })).toBeUndefined();
        expect(choose({ ...registry, availableModels: available("claude-sonnet-8.0") })).toBeUndefined();
        expect(choose({ ...registry, permittedModels: [permitted(CLAUDE, { providerId: "other-owner" })] })).toBeUndefined();
        expect(choose({ ...registry, permittedModels: [permitted(CLAUDE, { providerType: "anthropic" })] })).toBeUndefined();
    });

    it.each([
        { parentProviderId: "github-owner", parentProviderType: "anthropic" },
        { parentProviderId: "github-owner", parentProviderType: "openai" },
        { parentProviderId: "github-owner" },
        { parentProviderType: "github" },
        {},
    ])("registry mode requires an explicit GitHub parent identity: %j", context => {
        expect(choose({ ...context, permittedModels: [permitted(CLAUDE)] })).toBeUndefined();
    });

    it("does not treat a BYOK or ambiguous parent as a standalone GitHub token session", () => {
        expect(choose({ parentProviderType: "anthropic" })).toBeUndefined();
        expect(choose({ parentProviderId: "ambiguous" })).toBeUndefined();
        expect(choose({ parentProviderType: "github" })).toBe(CLAUDE);
        expect(choose({ parentProviderId: "github-owner", parentProviderType: "github" })).toBe(CLAUDE);
    });

    it.each(["disabled", "unconfigured", "unknown", "", undefined])("rejects supplied catalog policy state %s", state => {
        expect(choose({ availableModels: [{ id: CLAUDE, policy: { state } }] })).toBeUndefined();
    });

    it("accepts catalog entries without optional policy metadata but rejects contradictory duplicates", () => {
        expect(choose({ availableModels: [{ id: CLAUDE }] })).toBe(CLAUDE);
        expect(choose({ availableModels: [{ id: CLAUDE, policy: null }] })).toBeUndefined();
        for (const entries of [
            [{ id: CLAUDE }, { id: CLAUDE, policy: { state: "disabled" } }],
            [{ id: CLAUDE, policy: { state: "disabled" } }, { id: CLAUDE }],
        ]) expect(choose({ availableModels: entries })).toBeUndefined();
    });

    it("prefers balanced Claude models over newer premium and small variants", () => {
        expect(choose({ availableModels: available("claude-opus-9.0", "claude-haiku-9.0", "claude-sonnet-4.5", CLAUDE) })).toBe(CLAUDE);
        expect(choose({ availableModels: available("claude-haiku-9.0", "claude-opus-4.6") })).toBe("claude-opus-4.6");
        expect(choose({ availableModels: available("claude-haiku-4.5") })).toBe("claude-haiku-4.5");
    });

    it("prefers balanced GPT models over newer premium and small variants", () => {
        expect(choose({ parentModel: CLAUDE, availableModels: available("gpt-5.9-astra", "gpt-5.9-mini", "gpt-5.9-nano", "gpt-5.9-luna", "gpt-5.5", GPT) })).toBe(GPT);
        expect(choose({ parentModel: CLAUDE, availableModels: available("gpt-5.6-astra", "gpt-5.7-mini") })).toBe("gpt-5.6-astra");
    });

    it("orders generations numerically and does not mistake dated Claude IDs for newer versions", () => {
        expect(choose({ availableModels: available("claude-sonnet-4.9", "claude-sonnet-4.10") })).toBe("claude-sonnet-4.10");
        expect(choose({ availableModels: available("claude-3-5-sonnet-20251001", CLAUDE) })).toBe(CLAUDE);
        expect(choose({ parentModel: CLAUDE, availableModels: available("gpt-5.9-sol", "gpt-5.10-terra") })).toBe("gpt-5.10-terra");
    });

    it("uses cost and lexical IDs only after tier and generation, without mutating inputs", () => {
        const options = {
            parentModel: CLAUDE, parentProviderId: "github-owner", parentProviderType: "github",
            permittedModels: [permitted("gpt-5.6-sol", { cost: "high" }), permitted(GPT, { cost: "medium" }), permitted("gpt-5.9-nano", { cost: "low" })],
            availableModels: available("gpt-5.6-sol", GPT, "gpt-5.9-nano"),
        };
        const before = JSON.stringify(options);
        expect(selectNativeCriticModel(options)).toBe(GPT);
        expect(JSON.stringify(options)).toBe(before);
        expect(choose({ parentModel: CLAUDE, availableModels: available(GPT, "gpt-5.6-sol") })).toBe("gpt-5.6-sol");
    });

    it("selection is stable under shuffled catalogs and duplicated registry entries", () => {
        const ids = ["gpt-5.6-astra", "gpt-5.7-mini", "gpt-5.6-sol", GPT, "gpt-5.5"];
        const models = ids.map(id => permitted(id, { cost: "medium" }));
        models.push(permitted(GPT, { cost: "high" }));
        for (let offset = 0; offset < ids.length; offset++) {
            const shuffled = [...ids.slice(offset), ...ids.slice(0, offset)];
            for (const permittedModels of [models, [...models].reverse()]) {
                expect(choose({ parentModel: CLAUDE, parentProviderId: "github-owner", parentProviderType: "github",
                    permittedModels, availableModels: available(...shuffled) })).toBe("gpt-5.6-sol");
            }
        }
    });
});
