// @incubator/horizon-facts — public exports (incubating).
//
// Spec-conformant EnhancedFactStore + GraphStore providers for HorizonDB. The
// DB-less core (query-builder, graph-model) and the type contracts are the
// stable, unit-tested surface; HorizonDBFactStore (facts + search + embedder)
// and HorizonDBGraphStore (separate AGE-only graph provider, 07 D2) are the live
// providers validated by the integration suite (04-test-spec /
// 06-provider-test-plan) against a real HorizonDB.

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
export { loadMigrations, runMigrations, migrationsDir, HORIZON_FACTS_LOCK_SEED } from "./horizon-migrator.js";
export {
    assertExtensionsAvailable, assertFactExtensions, assertGraphExtensions,
    assertDurableHttpUsable,
    missingExtensions, missingFactExtensions, missingGraphExtensions,
} from "./preconditions.js";
