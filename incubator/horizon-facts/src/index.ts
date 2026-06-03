// @incubator/horizon-facts — public exports (incubating).
//
// The DB-less core (query-builder, graph-model) and the type contracts are the
// stable, unit-tested surface. The HorizonDB-backed adapter (HorizonFactStore)
// is a drop-in EnhancedFactStore + open-graph crawler, validated by the
// integration suite in test/integration against a real HorizonDB instance.

export * from "./types.js";
export * from "./query-builder.js";
export * from "./graph-model.js";
export * from "./config.js";
export * from "./embedding-client.js";
export * from "./horizon-store.js";
export * from "./agent-tools.js";
export { setupSchema, setupGraph, prepareAgeSession } from "./migrations.js";
export { setupHttpEmbedding } from "./http-embedding.js";
export type { HttpEmbeddingCapability } from "./http-embedding.js";
