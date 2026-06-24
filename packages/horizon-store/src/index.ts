// @pilotswarm/horizon-store — public exports.
//
// HorizonDB-backed providers implementing the @pilotswarm/sdk fact/graph
// contracts. The DB-less core (query-builder, graph-model) and the re-exported
// type contracts are the stable, unit-tested surface; HorizonDBFactStore (facts
// + search + embedder) and HorizonDBGraphStore (separate AGE-only graph provider,
// 07 D2) are the live providers validated by the integration suite against a real
// HorizonDB.

export * from "./types.js";
export * from "./query-builder.js";
export * from "./graph-model.js";
export * from "./config.js";
export * from "./embedding-client.js";
export * from "./horizon-store.js";
export * from "./graph-store.js";
export * from "./agent-tools.js";
export { isTransientDbError, withDbRetry, setDbRetryHooks } from "./db-retry.js";
export { GraphQueries, prepareAgeSession } from "./graph-queries.js";
export { loadMigrations, runMigrations, migrationsDir, HORIZON_FACTS_LOCK_SEED, GRAPH_OWNED_MIGRATIONS, isGraphOwnedMigration } from "./horizon-migrator.js";
export {
    assertExtensionsAvailable, assertFactExtensions, assertGraphExtensions,
    assertDurableHttpUsable,
    missingExtensions, missingFactExtensions, missingGraphExtensions,
} from "./preconditions.js";
