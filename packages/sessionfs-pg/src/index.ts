/**
 * Postgres-backed Copilot SessionFs provider.
 *
 * Standalone package — not yet integrated into the PilotSwarm runtime.
 *
 * @example
 * ```ts
 * import { PgSessionFsStore, createPgSessionFsProvider } from "pilotswarm-sessionfs-pg";
 * import { CopilotClient, createSessionFsAdapter } from "@github/copilot-sdk";
 *
 * const store = new PgSessionFsStore({
 *   connectionString: process.env.DATABASE_URL!,
 *   schema: "copilot_sessions_fsstore",
 * });
 * await store.initialize();
 *
 * const client = new CopilotClient({
 *   gitHubToken: process.env.GITHUB_TOKEN!,
 *   sessionFs: { initialCwd: "/", sessionStatePath: "/.session", conventions: "posix" },
 * });
 *
 * const session = await client.createSession({
 *   onPermissionRequest: () => ({ allow: true, level: "always" }),
 *   createSessionFsHandler: (s) => createPgSessionFsProvider({ store, sessionId: s.sessionId }),
 * });
 * ```
 */
export { PgSessionFsStore } from "./store.js";
export type { PgSessionFsStoreOptions } from "./store.js";
export { createPgSessionFsProvider } from "./provider.js";
export type { PgSessionFsProviderOptions } from "./provider.js";
export { createPgSessionFsHandler } from "./handler.js";
export { canonicalizePath } from "./path.js";
export { SESSIONFS_MIGRATIONS } from "./migrations.js";
export { runSessionFsMigrations } from "./migrator.js";
