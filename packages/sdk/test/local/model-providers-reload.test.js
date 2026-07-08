/**
 * Model-providers hot-reload (fix for the stale-registry class behind the
 * silent model-substitution incident: the registry was read exactly once at
 * process start, so a ConfigMap rollout left workers on the old catalog
 * until the next pod restart).
 *
 * Pure filesystem unit — no DB, no Copilot.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createModelProvidersReloader, resolveModelProvidersPath } from "../../src/model-providers.ts";

// The registry drops providers whose apiKey env var is unset (credential
// filtering) and then rejects a defaultModel with no credentialed models —
// give the test provider a resolvable key.
process.env.TEST_KEY_UNUSED = "unit-test-key";

const roots = [];
afterEach(() => {
    for (const root of roots.splice(0)) {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    }
});

function writeConfig(file, modelName) {
    fs.writeFileSync(file, JSON.stringify({
        defaultModel: `azure-openai:${modelName}`,
        providers: [{
            id: "azure-openai",
            type: "openai",
            baseUrl: "https://example.invalid/openai/v1",
            apiKey: "env:TEST_KEY_UNUSED",
            models: [{ name: modelName }],
        }],
    }));
}

function bumpMtime(file, offsetMs) {
    const future = new Date(Date.now() + offsetMs);
    fs.utimesSync(file, future, future);
}

describe("model providers hot-reload", () => {
    it("resolves an explicit path and reloads only when the file mtime changes", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-mp-reload-"));
        roots.push(root);
        const file = path.join(root, "model_providers.json");
        writeConfig(file, "gpt-alpha");

        expect(resolveModelProvidersPath(file)).toBe(file);

        const reloader = createModelProvidersReloader(file);
        expect(reloader.path).toBe(file);
        expect(reloader.current?.hasModel("azure-openai:gpt-alpha")).toBe(true);

        // No change → no reload.
        expect(reloader.checkAndReload()).toBe(false);

        // Content + mtime change → reload picks up the new catalog.
        writeConfig(file, "gpt-beta");
        bumpMtime(file, 5_000);
        expect(reloader.checkAndReload()).toBe(true);
        expect(reloader.current?.hasModel("azure-openai:gpt-beta")).toBe(true);
        expect(reloader.current?.hasModel("azure-openai:gpt-alpha")).toBe(false);
    });

    it("keeps the last good registry when the file turns malformed, without hot-looping the parse", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-mp-reload-bad-"));
        roots.push(root);
        const file = path.join(root, "model_providers.json");
        writeConfig(file, "gpt-good");

        const reloader = createModelProvidersReloader(file);
        expect(reloader.current?.hasModel("azure-openai:gpt-good")).toBe(true);

        fs.writeFileSync(file, "{ this is not json");
        bumpMtime(file, 5_000);
        expect(reloader.checkAndReload()).toBe(false);          // parse failed → no swap
        expect(reloader.current?.hasModel("azure-openai:gpt-good")).toBe(true);
        // mtime was recorded up-front: an unchanged broken file is not re-parsed.
        expect(reloader.checkAndReload()).toBe(false);

        // Recovery: a fixed file reloads normally.
        writeConfig(file, "gpt-fixed");
        bumpMtime(file, 10_000);
        expect(reloader.checkAndReload()).toBe(true);
        expect(reloader.current?.hasModel("azure-openai:gpt-fixed")).toBe(true);
    });

    it("reports no path (and never reloads) when no config file exists anywhere", () => {
        // Auto-discovery walks up from CWD (and would find the repo's own
        // .model_providers.json), so sandbox the cwd in an empty temp dir and
        // clear the env overrides for the duration.
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-mp-none-"));
        roots.push(root);
        const prevCwd = process.cwd();
        const prevPsPath = process.env.PS_MODEL_PROVIDERS_PATH;
        const prevMpPath = process.env.MODEL_PROVIDERS_PATH;
        delete process.env.PS_MODEL_PROVIDERS_PATH;
        delete process.env.MODEL_PROVIDERS_PATH;
        try {
            process.chdir(root);
            const reloader = createModelProvidersReloader(path.join(root, "nope.json"));
            expect(reloader.path).toBe(null);
            expect(reloader.checkAndReload()).toBe(false);
        } finally {
            process.chdir(prevCwd);
            if (prevPsPath !== undefined) process.env.PS_MODEL_PROVIDERS_PATH = prevPsPath;
            if (prevMpPath !== undefined) process.env.MODEL_PROVIDERS_PATH = prevMpPath;
        }
    });
});
