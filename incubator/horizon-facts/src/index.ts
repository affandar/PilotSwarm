// @incubator/horizon-facts — public exports (incubating).
//
// Spec-conformant EnhancedFactStore provider for HorizonDB. The DB-less core
// (query-builder, graph-model) and the type contracts are the stable,
// unit-tested surface; HorizonFactStore is the live provider validated by the
// integration suite (04-test-spec / 06-provider-test-plan) against a real
// HorizonDB.

export * from "./types.js";
export * from "./query-builder.js";
export * from "./graph-model.js";
export * from "./config.js";
export * from "./embedding-client.js";
export * from "./horizon-store.js";
export * from "./agent-tools.js";
export { GraphQueries, prepareAgeSession } from "./graph-queries.js";
export { loadMigrations, runMigrations, migrationsDir, HORIZON_FACTS_LOCK_SEED } from "./horizon-migrator.js";
export { assertExtensionsAvailable, assertDurableHttpUsable, missingExtensions } from "./preconditions.js";
