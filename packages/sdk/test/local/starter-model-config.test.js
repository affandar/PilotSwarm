import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

function loadStarterModelConfig() {
    const configPath = path.resolve(process.cwd(), "deploy/config/model_providers.local-docker.json");
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

describe("starter docker model config", () => {
    it("keeps the local starter catalog on the gpt-5.4 family", () => {
        const config = loadStarterModelConfig();
        const provider = config.providers.find((entry) => entry.id === "github-copilot");
        expect(provider).toBeTruthy();

        const names = provider.models.map((model) => typeof model === "string" ? model : model.name);

        expect(config.defaultModel).toBe("github-copilot:claude-sonnet-4.6");
        expect(names).toEqual([
            "claude-sonnet-4.6",
            "gpt-5.4",
            "gpt-5.4-mini",
            "gpt-5.4-nano",
            "claude-opus-4.6",
        ]);
        expect(names).not.toContain("gpt-5-mini");
    });
});
