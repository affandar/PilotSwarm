import { describe, expect, it } from "vitest";
import { ModelProviderRegistry } from "../../src/model-providers.ts";
import { firstConfiguredModel } from "../helpers/fixture-models.js";

const GPT = ["gpt-old", "gpt-older"];
const CLAUDE = ["claude-old"];
const registry = new ModelProviderRegistry({
    providers: [
        { id: "azure-test", type: "azure", baseUrl: "https://example.invalid/openai",
            apiKey: "synthetic-unit-key", models: ["gpt-new", "gpt-old", "gpt-older"] },
        { id: "anthropic-test", type: "anthropic", baseUrl: "https://example.invalid",
            apiKey: "synthetic-unit-key", models: ["claude-new"] },
    ],
    defaultModel: "anthropic-test:claude-new",
});

describe("configured test model discovery", () => {
    it("preserves known candidate priority and bare references", () => {
        expect(firstConfiguredModel(registry, GPT, "gpt-")).toBe("gpt-old");
    });

    it("preserves an explicitly qualified candidate", () => {
        expect(firstConfiguredModel(registry, ["azure-test:gpt-older"], "gpt-"))
            .toBe("azure-test:gpt-older");
    });

    it("discovers a configured GPT outside the preferred candidate list", () => {
        expect(firstConfiguredModel(registry, ["gpt-absent"], "gpt-"))
            .toBe("azure-test:gpt-new");
    });

    it("discovers a configured Claude outside the preferred candidate list", () => {
        expect(firstConfiguredModel(registry, CLAUDE, "claude-"))
            .toBe("anthropic-test:claude-new");
    });

    it("does not substitute the unrelated deployment default for a missing family", () => {
        expect(firstConfiguredModel(registry, ["other-absent"], "other-"))
            .toBe("other-absent");
    });

    it("keeps a missing Claude prerequisite unresolved in a GPT-only registry", () => {
        const single = new ModelProviderRegistry({
            providers: [{ id: "azure-test", type: "azure", baseUrl: "https://example.invalid/openai",
                apiKey: "synthetic-unit-key", models: ["gpt-new"] }],
            defaultModel: "azure-test:gpt-new",
        });
        const selected = firstConfiguredModel(single, CLAUDE, "claude-");
        expect(selected).toBe("claude-old");
        expect(single.normalize(selected)).toBeUndefined();
        expect(firstConfiguredModel(single, ["gpt-absent"], "gpt-"))
            .not.toBe(selected);
    });

    it("preserves legacy selection when no registry is configured", () => {
        expect(firstConfiguredModel(null, GPT, "gpt-")).toBe("gpt-old");
    });

    it("does not replace an explicit unavailable family with an implicit default", () => {
        const empty = new ModelProviderRegistry({ providers: [] });
        expect(firstConfiguredModel(empty, GPT, "gpt-")).toBe("gpt-old");
    });
});
