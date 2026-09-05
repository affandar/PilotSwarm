import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { ModelProviderRegistry } from "../../src/model-providers.ts";
import { buildRuntimeRegistry, loadProviderTypes } from "../../src/provider-catalog.ts";

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
            "claude-opus-5",
            "claude-opus-4.8",
            "gpt-6-astra",
            "gpt-5.6-sol",
            "gpt-5.6-sol-fast",
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
        for (const name of ["claude-opus-4.8", "gpt-5.6-sol", "gpt-5.6-sol-fast", "gpt-5.6-luna", "gpt-5.6-terra"]) {
            const model = provider.models.find((m) => (typeof m === "string" ? m : m.name) === name);
            expect(model.supportedContextTiers).toEqual(["default", "long_context"]);
            expect(model.defaultContextTier).toBe("default");
        }

        // The 5.6 family takes the FULL effort range GitHub Copilot offers for
        // it — `none` and `max` included. Read from the live Copilot record on
        // 2026-08-29: all four list none/low/medium/high/xhigh/max, default
        // medium. Dropping either end silently removes a choice from the
        // picker, which is how they went missing in the first place.
        for (const name of ["gpt-5.6-sol", "gpt-5.6-sol-fast", "gpt-5.6-luna", "gpt-5.6-terra"]) {
            const model = provider.models.find((m) => m.name === name);
            expect(model.supportedReasoningEfforts).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
            expect(model.defaultReasoningEffort).toBe("medium");
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

describe("GPT-6 Astra provider type catalog", () => {
    const catalogs = [
        ".model_providers.example.json",
        "deploy/config/model_providers.ghcp.json",
        "deploy/config/model_providers.local-docker.json",
        "deploy/gitops/worker/base/model_providers.json",
    ];
    const metadata = {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        defaultReasoningEffort: "medium",
        supportedContextTiers: ["default", "long_context"],
        defaultContextTier: "default",
        contextWindowSizes: { default: 272000, long_context: 872000 },
    };

    it.each(catalogs)("exposes verified Copilot capabilities in %s", (file) => {
        const config = JSON.parse(readRepoFile(file));
        const github = config.providers.find((provider) => provider.id === "github-copilot");
        expect(github.type).toBe("github");
        const astra = github.models.filter((model) => model.name === "gpt-6-astra");
        expect(astra).toHaveLength(1);
        expect(astra[0]).toMatchObject({ name: "gpt-6-astra", ...metadata });
        const types = loadProviderTypes(config);
        expect(types.getDescriptor("github-copilot:gpt-6-astra")).toMatchObject({ modelName: "gpt-6-astra", ...metadata });
        for (const provider of config.providers.filter((entry) => entry.type !== "github")) {
            expect(provider.models.some((model) => (model.name ?? model) === "gpt-6-astra")).toBe(false);
        }
    });

    it("existing personal providers inherit Astra with their own credentials", () => {
        const types = loadProviderTypes(loadStarterModelConfig());
        const instances = ["alice", "bob"].map((name, index) => ({
            name: `${name}-copilot`, typeId: "github-copilot", class: "personal",
            ownerUserId: index + 1, baseUrl: null,
            secretRef: { kind: "githubToken", value: `${name}-test-token` },
        }));
        instances.push({ name: "expired-copilot", typeId: "github-copilot", class: "personal",
            ownerUserId: 3, baseUrl: null, secretRef: {} });
        const original = structuredClone(instances);
        const registry = buildRuntimeRegistry(types, instances);
        for (const name of ["alice", "bob"]) {
            const ref = `${name}-copilot:gpt-6-astra`;
            expect(registry.getDescriptor(ref)).toMatchObject({ modelName: "gpt-6-astra", ...metadata });
            expect(registry.resolve(ref).githubToken).toBe(`${name}-test-token`);
        }
        expect(registry.resolve("expired-copilot:gpt-6-astra")).toBeUndefined();
        expect(instances).toEqual(original);
    });
});
