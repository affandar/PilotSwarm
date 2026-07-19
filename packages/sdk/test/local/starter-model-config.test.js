import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { ModelProviderRegistry } from "../../src/model-providers.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadStarterModelConfig() {
    const configPath = path.resolve(__dirname, "../../../../deploy/config/model_providers.local-docker.json");
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function readRepoFile(relativePath) {
    return fs.readFileSync(path.resolve(__dirname, "../../../..", relativePath), "utf8");
}

describe("starter docker model config", () => {
    it("keeps the local starter catalog on the current GHCP model family", () => {
        const config = loadStarterModelConfig();
        const provider = config.providers.find((entry) => entry.id === "github-copilot");
        expect(provider).toBeTruthy();

        const names = provider.models.map((model) => typeof model === "string" ? model : model.name);

        expect(config.defaultModel).toBe("github-copilot:claude-sonnet-5");
        expect(names).toEqual([
            "claude-sonnet-5",
            "gpt-5.4",
            "gpt-5.4-mini",
            "claude-opus-4.8",
            "gpt-5.6-sol",
            "gpt-5.6-luna",
            "gpt-5.6-terra",
        ]);
        // Retired from the catalog.
        expect(names).not.toContain("claude-opus-4.7");
        expect(names).not.toContain("claude-opus-4.6");
        expect(names).not.toContain("claude-sonnet-4.6");
        expect(names).not.toContain("gpt-5.5");
        expect(names).not.toContain("gpt-5-mini");
        expect(names).not.toContain("gpt-5.4-nano");
        expect(names).not.toContain("gpt-5.1");

        // Context-window tiers are declared on the models that support them,
        // and always default to the smaller ("default") window.
        for (const name of ["claude-opus-4.8", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"]) {
            const model = provider.models.find((m) => (typeof m === "string" ? m : m.name) === name);
            expect(model.supportedContextTiers).toEqual(["default", "long_context"]);
            expect(model.defaultContextTier).toBe("default");
        }

        const opus = provider.models.find((model) => model.name === "claude-opus-4.8");
        expect(opus.supportedReasoningEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
        expect(opus.contextWindowSizes).toEqual({ default: 200_000, long_context: 936_000 });

        const descriptor = new ModelProviderRegistry(config).getDescriptor("github-copilot:claude-opus-4.8");
        expect(descriptor.supportedReasoningEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    });

    it("persists starter SSH host keys in the data volume", () => {
        const starter = readRepoFile("deploy/bin/start-starter.sh");
        const quickstart = readRepoFile("docs/quickstart/docker.md");

        expect(starter).toContain("SSH_HOST_KEY_DIR=${PILOTSWARM_SSH_HOST_KEY_DIR:-${DATA_DIR}/ssh}");
        expect(starter).toContain("configure_ssh_host_keys");
        expect(starter).toContain("ensure_ssh_host_key rsa 3072");
        expect(starter).toContain("ln -sf \"${key_path}\" \"${system_key_path}\"");

        expect(quickstart).toContain("StrictHostKeyChecking=accept-new");
        expect(quickstart).toContain("/data/ssh");
        expect(quickstart).toContain("ssh-keygen -R '[localhost]:2222'");
    });
});
