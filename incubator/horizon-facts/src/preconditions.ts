// @incubator/horizon-facts — fail-fast preconditions (01-functional-spec §5.5).
//
// `initialize()` throws ONE precise, ITEMIZED error naming every missing piece
// and its fix. No feature flags, no silent fallbacks: lexical is BM25 via
// pg_textsearch (ts_rank is not a substitute), semantic needs pgvector, the
// graph needs AGE, and the embedder needs pg_durable with df.http granted.

const REQUIRED: { name: string; why: string; fix: string }[] = [
    {
        name: "vector",
        why: "semantic kNN over facts.embedding (pgvector)",
        fix: "install pgvector / add 'vector' to the cluster's allow-listed extensions",
    },
    {
        name: "age",
        why: "the open knowledge graph (Apache AGE)",
        fix: "install Apache AGE / add 'age' to shared_preload_libraries and the extension allow-list",
    },
    {
        name: "pg_textsearch",
        why: "BM25 lexical ranking (ts_rank is not an acceptable fallback)",
        fix: "add 'pg_textsearch' to the cluster's allow-listed extensions",
    },
    {
        name: "pg_durable",
        why: "the durable in-database embedding loop (df.loop/df.http)",
        fix: "add 'pg_durable' to shared_preload_libraries and the extension allow-list",
    },
];

/** Pieces missing BEFORE migrations run (extension availability). */
export async function missingExtensions(pool: any): Promise<string[]> {
    const { rows } = await pool.query(
        `SELECT name FROM pg_available_extensions WHERE name = ANY($1)`,
        [REQUIRED.map((r) => r.name)],
    );
    const available = new Set(rows.map((r: any) => r.name));
    return REQUIRED.filter((r) => !available.has(r.name)).map((r) => r.name);
}

/** Throw the itemized fail-fast error if any required extension is unavailable. */
export async function assertExtensionsAvailable(pool: any): Promise<void> {
    const missing = await missingExtensions(pool);
    if (missing.length === 0) return;
    const lines = missing.map((name) => {
        const r = REQUIRED.find((x) => x.name === name)!;
        return `  - ${name}: ${r.why}. Fix: ${r.fix}`;
    });
    throw new Error(
        `EnhancedFactStore preconditions failed — this database is missing ${missing.length} required ` +
        `extension(s):\n${lines.join("\n")}\n` +
        `The EnhancedFactStore requires HorizonDB (or equivalent). There are no fallbacks; ` +
        `point enhancedFactsDatabaseUrl at a capable cluster.`,
    );
}

/** Post-migration checks: df.http present and usable by this role. */
export async function assertDurableHttpUsable(pool: any): Promise<void> {
    const { rows } = await pool.query(`
        SELECT EXISTS (
            SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'df' AND p.proname = 'http'
        ) AS has_http`);
    if (!rows[0]?.has_http) {
        throw new Error(
            "EnhancedFactStore preconditions failed — pg_durable is installed but df.http() is absent. " +
            "Fix: ensure pg_durable is in shared_preload_libraries (restart required) and re-run CREATE EXTENSION pg_durable.",
        );
    }
    try {
        await pool.query(`SELECT df.getvar('__hz_precondition_probe')`);
    } catch (err: any) {
        throw new Error(
            "EnhancedFactStore preconditions failed — this role cannot use the df schema. " +
            `Fix: have an admin run SELECT df.grant_usage('<role>', true, false). Underlying error: ${err?.message ?? err}`,
        );
    }
}
