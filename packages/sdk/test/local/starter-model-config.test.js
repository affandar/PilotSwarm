import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadStarterModelConfig() {
    const configPath = path.resolve(__dirname, "../../../../deploy/config/model_providers.local-docker.json");
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

function readRepoFile(relativePath) {
    return fs.readFileSync(path.resolve(__dirname, "../../../..", relativePath), "utf8");
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
            "claude-opus-4.7",
            "claude-opus-4.6",
        ]);
        expect(names).not.toContain("gpt-5-mini");
        expect(names).not.toContain("gpt-5.4-nano");
        expect(names).not.toContain("gpt-5.1");
    });

    it("persists starter SSH host keys in the data volume", () => {
        const starter = readRepoFile("deploy/bin/start-starter.sh");
        const quickstart = readRepoFile("docs/getting-started-docker-appliance.md");

        expect(starter).toContain("SSH_HOST_KEY_DIR=${PILOTSWARM_SSH_HOST_KEY_DIR:-${DATA_DIR}/ssh}");
        expect(starter).toContain("configure_ssh_host_keys");
        expect(starter).toContain("ensure_ssh_host_key rsa 3072");
        expect(starter).toContain("ln -sf \"${key_path}\" \"${system_key_path}\"");

        expect(quickstart).toContain("StrictHostKeyChecking=accept-new");
        expect(quickstart).toContain("/data/ssh");
        expect(quickstart).toContain("ssh-keygen -R '[localhost]:2222'");
    });
});
