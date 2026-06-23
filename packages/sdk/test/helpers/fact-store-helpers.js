/**
 * Fact-store helpers that build a fact store through the RESOLVED runtime
 * storage provider, so tests exercise the same provider the worker/client use.
 *
 * In baseline mode this is the default PgFactStore; under --with-horizondb it is
 * the HorizonDB enhanced fact store. The durable in-DB embedding loop is
 * intentionally stripped so direct test fact stores stay lean and offline —
 * these helpers are for CRUD/visibility assertions, not semantic search.
 */

import { getRuntimeStorageProvider, resolveStorageConfig } from "../../src/index.ts";

export async function createRuntimeFactStore(env) {
    const storage = resolveStorageConfig({
        options: {
            store: env.store,
            factsSchema: env.factsSchema,
        },
    });
    const runtime = { ...storage.runtime };
    delete runtime.embedding;
    const provider = getRuntimeStorageProvider(runtime.provider);
    const factStore = await provider.createFactStore(runtime);
    await factStore.initialize();
    return factStore;
}

export async function listRuntimeFactRows(factStore) {
    const result = await factStore.readFacts(
        { scope: "accessible", limit: 1000 },
        { unrestricted: true },
    );
    return result.facts
        .map((fact) => ({ key: fact.key, session_id: fact.sessionId, shared: fact.shared }))
        .sort((left, right) => {
            const keyCompare = left.key.localeCompare(right.key);
            if (keyCompare !== 0) return keyCompare;
            return String(left.session_id ?? "").localeCompare(String(right.session_id ?? ""));
        });
}
