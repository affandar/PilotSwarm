import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelProviderRegistry } from "../../src/model-providers.ts";
import { buildRuntimeRegistry, resolveProviderCredential } from "../../src/provider-catalog.ts";
import { SessionManager } from "../../src/session-manager.ts";

const MODEL = "gpt-5.6-terra";

describe("Azure wire routing through the real SessionManager and SDK", () => {
    it.each(["registry", "cms-registry", "cms-direct", "legacy", "completions"])(
        "%s preserves the configured HTTP protocol",
        { timeout: 60_000 },
        async (mode) => {
            const requests = [];
            const server = createServer(async (req, res) => {
                const chunks = [];
                for await (const chunk of req) chunks.push(chunk);
                requests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
                // Stop at the transport boundary: this tests the SDK's actual
                // request, not a fabricated model answer or a live credential.
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { message: "synthetic-wire-capture", type: "invalid_request_error" } }));
            });
            await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
            const root = mkdtempSync(join(tmpdir(), "ps-responses-wire-"));
            const baseUrl = `http://127.0.0.1:${server.address().port}/openai`;
            const provider = {
                id: "azure-type", type: "azure", baseUrl,
                apiKey: "synthetic-key", apiVersion: "2024-10-21",
                ...(mode === "completions" ? {} : { wireApi: "responses" }),
                models: [{ name: MODEL, supportedReasoningEfforts: ["none"], defaultReasoningEffort: "none" }],
            };
            const registry = new ModelProviderRegistry({ providers: [provider] });
            const credential = {
                name: "azure-instance", typeId: "azure-type", class: "shared",
                baseUrl: null, secretRef: { value: "synthetic-instance-key", apiVersion: "2024-10-21" },
            };
            let defaults = { modelProviders: registry };
            let model = `azure-type:${MODEL}`;
            if (mode === "cms-registry") {
                defaults = { modelProviders: buildRuntimeRegistry(registry, [credential]) };
                model = `azure-instance:${MODEL}`;
            } else if (mode === "cms-direct") {
                defaults = { provider: resolveProviderCredential(registry, credential, MODEL).sdkProvider };
                model = MODEL;
            } else if (mode === "legacy") {
                defaults = { provider: {
                    type: "azure", baseUrl, apiKey: "synthetic-key",
                    wireApi: "responses", azure: { apiVersion: "2024-10-21" },
                } };
                model = MODEL;
            }
            const manager = new SessionManager(undefined, null, defaults, root);
            manager.setFactStore({
                readFacts: async () => ({ count: 0, facts: [] }),
                storeFact: async () => ({ stored: true }),
                deleteFact: async () => ({ deleted: true }),
            });
            try {
                const session = await manager.getOrCreate(randomUUID(), { model, reasoningEffort: "none" }, { turnIndex: 0 });
                const result = await session.runTurn("Say hello.");
                expect(result.type).toBe("error");
                expect(result.message).toContain("synthetic-wire-capture");
                expect(requests).toHaveLength(1);
                const request = requests[0];
                expect(request.body.model).toBe(MODEL);
                if (mode === "completions") {
                    expect(request.url).toBe(`/openai/deployments/${MODEL}/chat/completions?api-version=2024-10-21`);
                    expect(request.body.messages).toBeInstanceOf(Array);
                } else {
                    expect(request.url).toBe("/openai/v1/responses");
                    expect(request.body.input).toBeInstanceOf(Array);
                    expect(request.body.reasoning).toEqual({ effort: "none" });
                    expect(Object.hasOwn(request.body, "temperature")).toBe(false);
                    expect(Object.hasOwn(request.body, "snippy")).toBe(false);
                }
            } finally {
                await manager.shutdown();
                server.closeAllConnections();
                await new Promise(resolve => server.close(resolve));
                rmSync(root, { recursive: true, force: true });
            }
        },
    );
});
