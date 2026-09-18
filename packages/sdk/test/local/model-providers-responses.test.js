// Pure provider resolution/hot-reload regressions; no DB or live endpoint.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelProviderRegistry, createModelProvidersReloader, loadModelProviders } from "../../src/model-providers.ts";
import { buildRuntimeRegistry, resolveProviderCredential } from "../../src/provider-catalog.ts";
import { SessionManager } from "../../src/session-manager.ts";
import { attachWorkloadIdentity } from "../../src/wif-credentials.ts";
import { needsByokRequestCompatibility } from "../../src/copilot-client.ts";

const MODEL = "gpt-5.6-terra";
const ENDPOINT = "https://responses.example.invalid/openai";
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function config(overrides = {}) {
    return { providers: [{ id: "azure-type", type: "azure", baseUrl: ENDPOINT,
        apiKey: "synthetic-type-key", models: [MODEL], ...overrides }] };
}
function credential(overrides = {}) {
    return { name: "cms-azure", typeId: "azure-type", class: "shared", baseUrl: null,
        secretRef: { kind: "apiKey", value: "synthetic-cms-key", apiVersion: "2024-10-21" }, ...overrides };
}
function legacy(provider, model = MODEL) {
    // Execute the actual runtime fallback, without constructing clients or stores.
    return SessionManager.prototype._resolveProviderConfig.call({ workerDefaults: { provider } }, model).provider;
}
function expectResponses(provider, baseUrl = ENDPOINT, apiKey = "synthetic-type-key") {
    expect(provider).toEqual({ type: "azure", baseUrl, apiKey, wireApi: "responses" });
    expect(Object.hasOwn(provider, "azure")).toBe(false);
    expect(provider.baseUrl).not.toContain("/deployments/");
}

describe("explicit Azure Responses v1 routing", () => {
    it.each([undefined, "2024-10-21", "2025-04-01-preview"])("registry ignores dated version %s", (apiVersion) => {
        const registry = new ModelProviderRegistry(config({ wireApi: "responses", apiVersion }));
        const resolved = registry.resolve(`azure-type:${MODEL}`);
        expect(resolved.modelName).toBe(MODEL);
        expectResponses(resolved.sdkProvider);
        expectResponses(attachWorkloadIdentity(resolved));
        expect(needsByokRequestCompatibility(resolved.sdkProvider)).toBe(false);
    });

    it("CMS credential resolution ignores stale row and type versions and uses the row endpoint/key", () => {
        const types = new ModelProviderRegistry(config({ wireApi: "responses", apiVersion: "2025-01-01-preview" }));
        const row = credential({ baseUrl: "https://instance.example.invalid/openai" });
        const before = JSON.stringify(row);
        const resolved = resolveProviderCredential(types, row, MODEL);
        expect(resolved.modelName).toBe(MODEL);
        expect(resolved.providerId).toBe("cms-azure");
        expectResponses(resolved.sdkProvider, row.baseUrl, "synthetic-cms-key");
        expect(JSON.stringify(row)).toBe(before);
        // CMS runtime registry rebuilds must retain the type-level wireApi too.
        expectResponses(buildRuntimeRegistry(types, [row]).resolve(`cms-azure:${MODEL}`).sdkProvider,
            row.baseUrl, "synthetic-cms-key");
    });

    it.each([MODEL, undefined])("legacy SessionManager omits deployment and version with model %s", (model) => {
        const provider = { type: "azure", baseUrl: ENDPOINT, apiKey: "synthetic-type-key",
            wireApi: "responses", azure: { apiVersion: "2024-10-21" } };
        const before = JSON.stringify(provider);
        const result = SessionManager.prototype._resolveProviderConfig.call({ workerDefaults: { provider } }, model).provider;
        expectResponses(result);
        expect(JSON.stringify(provider)).toBe(before);
    });

    it("does not guess another credential when a Responses CMS row has none", () => {
        const types = new ModelProviderRegistry(config({ wireApi: "responses" }));
        expect(resolveProviderCredential(types, credential({ secretRef: {} }), MODEL)).toBe(null);
    });

    it("round-trips JSON and hot-reloads transport in both catalogs without a CMS migration", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-responses-"));
        roots.push(root);
        const file = path.join(root, "providers.json");
        fs.writeFileSync(file, JSON.stringify(config()));
        const reloader = createModelProvidersReloader(file);
        expect(reloader.current.resolve(`azure-type:${MODEL}`).sdkProvider.baseUrl).toContain("/deployments/");
        fs.writeFileSync(file, JSON.stringify(config({ wireApi: "responses", apiVersion: "2024-10-21" })));
        const future = new Date(Date.now() + 5000);
        fs.utimesSync(file, future, future);
        expect(reloader.checkAndReload()).toBe(true);
        expectResponses(loadModelProviders(file).resolve(`azure-type:${MODEL}`).sdkProvider);
        expectResponses(reloader.current.resolve(`azure-type:${MODEL}`).sdkProvider);
        expectResponses(resolveProviderCredential(reloader.types, credential(), MODEL).sdkProvider,
            ENDPOINT, "synthetic-cms-key");
        expectResponses(buildRuntimeRegistry(reloader.types, [credential()]).resolve(`cms-azure:${MODEL}`).sdkProvider,
            ENDPOINT, "synthetic-cms-key");
        expect(reloader.checkAndReload()).toBe(false);
        fs.writeFileSync(file, JSON.stringify(config({ wireApi: "completions" })));
        const later = new Date(Date.now() + 10000);
        fs.utimesSync(file, later, later);
        expect(reloader.checkAndReload()).toBe(true);
        expect(reloader.current.resolve(`azure-type:${MODEL}`).sdkProvider.azure.apiVersion).toBe("2024-10-21");
    });
});

describe("existing completions and non-Azure compatibility", () => {
    it.each([undefined, "completions"])("keeps Azure registry/CMS routing for wireApi=%s", (wireApi) => {
        const types = new ModelProviderRegistry(config({ wireApi }));
        const direct = types.resolve(`azure-type:${MODEL}`).sdkProvider;
        expect(direct.baseUrl).toBe(`${ENDPOINT}/deployments/${MODEL}`);
        expect(direct.azure).toEqual({ apiVersion: "2024-10-21" });
        expect(direct.wireApi).toBe(wireApi);
        const row = credential({ secretRef: { value: "synthetic-cms-key", apiVersion: "2025-04-01-preview" } });
        const cms = resolveProviderCredential(types, row, MODEL).sdkProvider;
        expect(cms.baseUrl).toBe(`${ENDPOINT}/deployments/${MODEL}`);
        expect(cms.azure).toEqual({ apiVersion: "2025-04-01-preview" });
        expect(cms.wireApi).toBe(wireApi);
        expect(needsByokRequestCompatibility(direct)).toBe(true);
    });

    it("keeps configured completions versions and CMS default version", () => {
        const types = new ModelProviderRegistry(config({ apiVersion: "2025-01-01-preview" }));
        expect(types.resolve(`azure-type:${MODEL}`).sdkProvider.azure.apiVersion).toBe("2025-01-01-preview");
        expect(resolveProviderCredential(types, credential({ secretRef: { value: "unit" } }), MODEL).sdkProvider.azure.apiVersion)
            .toBe("2025-01-01-preview");
        const defaults = new ModelProviderRegistry(config());
        expect(resolveProviderCredential(defaults, credential({ secretRef: { value: "unit" } }), MODEL).sdkProvider.azure.apiVersion)
            .toBe("2024-10-21");
    });

    it("retains legacy append/qualified URL semantics for completions", () => {
        const p = { type: "azure", baseUrl: ENDPOINT + "///", azure: { apiVersion: "custom-version" } };
        expect(legacy(p)).toEqual({ ...p, baseUrl: `${ENDPOINT}/deployments/${MODEL}` });
        const qualified = { ...p, baseUrl: `${ENDPOINT}/deployments/existing` };
        expect(legacy(qualified)).toBe(qualified);
        expect(SessionManager.prototype._resolveProviderConfig.call({ workerDefaults: { provider: p } }).provider).toBe(p);
    });

    it.each(["openai", "openai-proxy", "anthropic"])("forwards explicit wireApi without Azure rewrites for %s", (type) => {
        const types = new ModelProviderRegistry(config({ type, wireApi: "responses" }));
        const expectedType = type === "openai-proxy" ? "openai" : type;
        for (const resolved of [types.resolve(`azure-type:${MODEL}`), resolveProviderCredential(types, credential(), MODEL)]) {
            expect(resolved.sdkProvider).toMatchObject({ type: expectedType, baseUrl: ENDPOINT, wireApi: "responses" });
            expect(resolved.sdkProvider.azure).toBeUndefined();
        }
        const p = { type, baseUrl: ENDPOINT, wireApi: "responses" };
        expect(legacy(p)).toBe(p);
    });
});
