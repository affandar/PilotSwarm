import { describe, it, expect } from "vitest";
import {
    DEFAULT_DUROXIDE_SCHEMA,
    getDuroxideStorageProvider,
    getRuntimeStorageProvider,
    isEnhancedFactStore,
    resolveStorageConfig,
} from "../../src/index.ts";

const STORE = "postgresql://user:pass@example.test:5432/pilotswarm";

describe("storage config resolver", () => {
    it("defaults to postgres runtime and postgres duroxide with ps_duroxide schema", () => {
        const storage = resolveStorageConfig({ env: {}, options: { store: STORE } });
        expect(storage.runtime.provider).toBe("postgres");
        expect(storage.runtime.url).toBe(STORE);
        expect(storage.runtime.cmsSchema).toBe("copilot_sessions");
        expect(storage.runtime.factsSchema).toBe("pilotswarm_facts");
        expect(storage.duroxide.provider).toBe("postgres");
        expect(storage.duroxide.url).toBe(STORE);
        expect(storage.duroxide.schema).toBe(DEFAULT_DUROXIDE_SCHEMA);
    });

    it("maps legacy enhanced facts options to horizondb facts without moving CMS/duroxide off store", () => {
        const storage = resolveStorageConfig({
            env: {},
            options: {
                store: STORE,
                cmsFactsDatabaseUrl: "postgresql://cms.example.test/db",
                enhancedFactsDatabaseUrl: "postgresql://hdb.example.test/facts",
                enhancedFactsSchema: "hf",
            },
        });
        expect(storage.runtime.provider).toBe("horizondb");
        expect(storage.runtime.url).toBe(STORE);
        expect(storage.runtime.sessionCatalogUrl).toBe("postgresql://cms.example.test/db");
        expect(storage.runtime.factStoreUrl).toBe("postgresql://hdb.example.test/facts");
        expect(storage.runtime.factsSchema).toBe("hf");
        expect(storage.duroxide.url).toBe(STORE);
    });

    it("selects horizondb through new env names and keeps graph nested", () => {
        const storage = resolveStorageConfig({
            env: {
                PILOTSWARM_RUNTIME_PROVIDER: "horizondb",
                PILOTSWARM_RUNTIME_URL: "postgresql://hdb.example.test/runtime",
                PILOTSWARM_FACTSTORE_URL: "postgresql://hdb.example.test/facts",
                PILOTSWARM_GRAPH_ENABLED: "1",
                PILOTSWARM_GRAPH_URL: "postgresql://hdb.example.test/graph",
                PILOTSWARM_GRAPH_SCHEMA: "hg",
                PILOTSWARM_GRAPH_REGISTRY_SCHEMA: "hgr",
                PILOTSWARM_DUROXIDE_URL: "postgresql://pg.example.test/duro",
                PILOTSWARM_DUROXIDE_SCHEMA: "custom_duro",
            },
            options: { store: STORE },
        });
        expect(storage.runtime.provider).toBe("horizondb");
        expect(storage.runtime.url).toBe("postgresql://hdb.example.test/runtime");
        expect(storage.runtime.factStoreUrl).toBe("postgresql://hdb.example.test/facts");
        expect(storage.runtime.graph).toEqual({
            enabled: true,
            url: "postgresql://hdb.example.test/graph",
            schema: "hg",
            registrySchema: "hgr",
        });
        expect(storage.duroxide.url).toBe("postgresql://pg.example.test/duro");
        expect(storage.duroxide.schema).toBe("custom_duro");
    });

    it("accepts legacy factsProvider horizon as horizondb runtime provider", () => {
        const storage = resolveStorageConfig({ env: {}, options: { store: STORE, factsProvider: "horizon" } });
        expect(storage.runtime.provider).toBe("horizondb");
    });

    it("does not let stale HORIZON_DATABASE_URL override explicit postgres runtime provider", () => {
        const storage = resolveStorageConfig({
            env: {
                PILOTSWARM_RUNTIME_PROVIDER: "postgres",
                HORIZON_DATABASE_URL: "postgresql://hdb.example.test/stale",
            },
            options: { store: STORE },
        });
        expect(storage.runtime.provider).toBe("postgres");
        expect(storage.runtime.url).toBe(STORE);
        expect(storage.runtime.factStoreUrl).toBeUndefined();
    });

    it("reads managed-identity env for both runtime and duroxide storage", () => {
        const storage = resolveStorageConfig({
            env: {
                PILOTSWARM_USE_MANAGED_IDENTITY: "true",
                PILOTSWARM_AAD_DB_USER: "uami-display-name",
            },
            options: { store: STORE },
        });
        expect(storage.runtime.useManagedIdentity).toBe(true);
        expect(storage.runtime.aadDbUser).toBe("uami-display-name");
        expect(storage.duroxide.useManagedIdentity).toBe(true);
        expect(storage.duroxide.aadDbUser).toBe("uami-display-name");
    });

    it("maps legacy HORIZON_* env aliases when no new provider id is set", () => {
        const storage = resolveStorageConfig({
            env: {
                HORIZON_DATABASE_URL: "postgresql://hdb.example.test/facts",
                HORIZON_FACTS_SCHEMA: "legacy_horizon_facts",
                HORIZON_GRAPH_DATABASE_URL: "postgresql://hdb.example.test/graph",
                HORIZON_GRAPH_SCHEMA: "legacy_graph",
                HORIZON_GRAPH_REGISTRY_SCHEMA: "legacy_graph_registry",
            },
            options: { store: STORE },
        });
        expect(storage.runtime.provider).toBe("horizondb");
        expect(storage.runtime.url).toBe(STORE);
        expect(storage.duroxide.url).toBe(STORE);
        expect(storage.runtime.sessionCatalogUrl).toBeUndefined();
        expect(storage.runtime.factStoreUrl).toBe("postgresql://hdb.example.test/facts");
        expect(storage.runtime.factsSchema).toBe("legacy_horizon_facts");
        expect(storage.runtime.graph).toMatchObject({
            enabled: true,
            url: "postgresql://hdb.example.test/graph",
            schema: "legacy_graph",
            registrySchema: "legacy_graph_registry",
        });
    });
});

describe("storage provider registries", () => {
    it("resolve canonical provider ids", () => {
        expect(getRuntimeStorageProvider("postgres").id).toBe("postgres");
        expect(getRuntimeStorageProvider("horizondb").id).toBe("horizondb");
        expect(getDuroxideStorageProvider("postgres").id).toBe("postgres");
    });

    it("does not treat a plain fact store as enhanced", () => {
        const fake = {};
        expect(isEnhancedFactStore(fake)).toBe(false);
        expect(getRuntimeStorageProvider("postgres").getEnhancedFactStore?.(fake)).toBeUndefined();
    });

    it("rejects unknown provider ids", () => {
        expect(() => getRuntimeStorageProvider("horizon")).toThrow(/Unknown runtime storage provider/);
        expect(() => getDuroxideStorageProvider("sqlite")).toThrow(/Unknown duroxide storage provider/);
    });
});
