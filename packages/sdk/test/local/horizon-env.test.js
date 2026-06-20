/**
 * Unit tests for horizonConfigFromEnv() — the HORIZON_* env → worker-config
 * mapping used by the shipped CLI/portal embedded worker, the standalone K8s
 * worker, and the examples. Pure / DB-less.
 */

import { describe, it, expect } from "vitest";
import { horizonConfigFromEnv } from "../../src/index.ts";

describe("horizonConfigFromEnv", () => {
    it("returns an empty object when no HORIZON_* vars are set", () => {
        expect(horizonConfigFromEnv({})).toEqual({});
        expect(horizonConfigFromEnv({ HORIZON_DATABASE_URL: "  " })).toEqual({});
        // Embed vars without the facts URL ⇒ nothing (embedder belongs to the enhanced store).
        expect(
            horizonConfigFromEnv({
                HORIZON_EMBED_URL: "https://e/embeddings",
                HORIZON_EMBED_MODEL: "m",
                HORIZON_EMBED_DIM: "1536",
            }),
        ).toEqual({});
    });

    it("wires the graph axis independently of the enhanced facts store", () => {
        // Graph URL alone ⇒ graph over a base fact store (graph tools, no search).
        // The enhanced facts store and the graph are orthogonal axes.
        const graphOnly = horizonConfigFromEnv({
            HORIZON_GRAPH_DATABASE_URL: "postgres://h/graph",
            HORIZON_GRAPH_SCHEMA: "mygraph",
        });
        expect(graphOnly).toEqual({ graphDatabaseUrl: "postgres://h/graph", graphSchema: "mygraph" });
        expect(graphOnly.enhancedFactsDatabaseUrl).toBeUndefined();
    });

    it("maps the facts URL alone (lexical-only, no graph)", () => {
        const cfg = horizonConfigFromEnv({ HORIZON_DATABASE_URL: "postgres://h/facts" });
        expect(cfg).toEqual({ enhancedFactsDatabaseUrl: "postgres://h/facts" });
        expect(cfg.horizonEmbed).toBeUndefined();
        expect(cfg.graphDatabaseUrl).toBeUndefined();
    });

    it("maps the optional facts schema", () => {
        const cfg = horizonConfigFromEnv({
            HORIZON_DATABASE_URL: "postgres://h/facts",
            HORIZON_FACTS_SCHEMA: "myfacts",
        });
        expect(cfg.enhancedFactsSchema).toBe("myfacts");
    });

    it("wires the embedder only when url+model+dim are all present", () => {
        const base = { HORIZON_DATABASE_URL: "postgres://h/facts" };

        // Missing dim ⇒ no embedder (degrade to lexical, never crash).
        expect(horizonConfigFromEnv({ ...base, HORIZON_EMBED_URL: "https://e", HORIZON_EMBED_MODEL: "m" }).horizonEmbed).toBeUndefined();
        // Non-numeric / non-positive dim ⇒ no embedder.
        expect(horizonConfigFromEnv({ ...base, HORIZON_EMBED_URL: "https://e", HORIZON_EMBED_MODEL: "m", HORIZON_EMBED_DIM: "abc" }).horizonEmbed).toBeUndefined();
        expect(horizonConfigFromEnv({ ...base, HORIZON_EMBED_URL: "https://e", HORIZON_EMBED_MODEL: "m", HORIZON_EMBED_DIM: "0" }).horizonEmbed).toBeUndefined();

        const cfg = horizonConfigFromEnv({
            ...base,
            HORIZON_EMBED_URL: "https://e/embeddings",
            HORIZON_EMBED_MODEL: "text-embedding-3-small",
            HORIZON_EMBED_DIM: "1536",
        });
        expect(cfg.horizonEmbed).toEqual({ url: "https://e/embeddings", model: "text-embedding-3-small", dim: 1536 });
    });

    it("carries the embedder api key + header", () => {
        const cfg = horizonConfigFromEnv({
            HORIZON_DATABASE_URL: "postgres://h/facts",
            HORIZON_EMBED_URL: "https://e/embeddings",
            HORIZON_EMBED_MODEL: "m",
            HORIZON_EMBED_DIM: "1536",
            HORIZON_EMBED_API_KEY: "secret",
            HORIZON_EMBED_API_KEY_HEADER: "api-key",
        });
        expect(cfg.horizonEmbed?.apiKey).toBe("secret");
        expect(cfg.horizonEmbed?.apiKeyHeader).toBe("api-key");
        // api-key header ⇒ bearer NOT inferred (Azure style).
        expect(cfg.horizonEmbed?.bearer).toBeUndefined();
    });

    it("infers bearer=true for an Authorization header, explicit env wins", () => {
        const base = {
            HORIZON_DATABASE_URL: "postgres://h/facts",
            HORIZON_EMBED_URL: "https://e/embeddings",
            HORIZON_EMBED_MODEL: "m",
            HORIZON_EMBED_DIM: "1536",
            HORIZON_EMBED_API_KEY: "secret",
        };
        // Authorization header ⇒ bearer inferred true (OpenAI style).
        expect(horizonConfigFromEnv({ ...base, HORIZON_EMBED_API_KEY_HEADER: "Authorization" }).horizonEmbed?.bearer).toBe(true);
        // Explicit HORIZON_EMBED_BEARER overrides the inference.
        expect(horizonConfigFromEnv({ ...base, HORIZON_EMBED_API_KEY_HEADER: "Authorization", HORIZON_EMBED_BEARER: "false" }).horizonEmbed?.bearer).toBe(false);
        expect(horizonConfigFromEnv({ ...base, HORIZON_EMBED_BEARER: "true" }).horizonEmbed?.bearer).toBe(true);
    });

    it("wires the opt-in graph only when its own URL is present", () => {
        const withoutGraph = horizonConfigFromEnv({ HORIZON_DATABASE_URL: "postgres://h/facts" });
        expect(withoutGraph.graphDatabaseUrl).toBeUndefined();

        const withGraph = horizonConfigFromEnv({
            HORIZON_DATABASE_URL: "postgres://h/facts",
            HORIZON_GRAPH_DATABASE_URL: "postgres://h/graph",
            HORIZON_GRAPH_SCHEMA: "mygraph",
        });
        expect(withGraph.graphDatabaseUrl).toBe("postgres://h/graph");
        expect(withGraph.graphSchema).toBe("mygraph");
    });

    it("defaults to reading process.env when no arg is passed", () => {
        const keys = [
            "HORIZON_DATABASE_URL",
            "HORIZON_FACTS_SCHEMA",
            "HORIZON_GRAPH_DATABASE_URL",
            "HORIZON_GRAPH_SCHEMA",
            "HORIZON_EMBED_URL",
            "HORIZON_EMBED_MODEL",
            "HORIZON_EMBED_DIM",
            "HORIZON_EMBED_API_KEY",
            "HORIZON_EMBED_API_KEY_HEADER",
            "HORIZON_EMBED_BEARER",
        ];
        const saved = new Map(keys.map((key) => [key, process.env[key]]));
        try {
            for (const key of keys) delete process.env[key];
            expect(horizonConfigFromEnv()).toEqual({});
        } finally {
            for (const key of keys) {
                const value = saved.get(key);
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    });
});
