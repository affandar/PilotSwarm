// @pilotswarm/horizon-store — fail-fast preconditions (01-functional-spec §5.5).
//
// `initialize()` throws ONE precise, ITEMIZED error naming every missing piece
// and its fix. No feature flags, no silent fallbacks: lexical is BM25 via
// pg_textsearch (ts_rank is not a substitute), semantic needs pgvector, the
// graph needs AGE, and the embedder needs pg_durable with df.http granted.

interface Ext { name: string; why: string; fix: string; }

/** Extensions the enhanced FACT provider (HorizonDBFactStore) needs (07 D2):
 *  pgvector + pg_textsearch + pg_durable. NOT age — graph is a separate provider. */
const FACT_REQUIRED: Ext[] = [
    {
        name: "vector",
        why: "semantic kNN over facts.embedding (pgvector)",
        fix: "install pgvector / add 'vector' to the cluster's allow-listed extensions",
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

/** Extensions the GRAPH provider (HorizonDBGraphStore) needs (07 D2): AGE only,
 *  so it can pair with a plain PgFactStore (base-facts + graph tier). */
const GRAPH_REQUIRED: Ext[] = [
    {
        name: "age",
        why: "the open knowledge graph (Apache AGE)",
        fix: "install Apache AGE / add 'age' to shared_preload_libraries and the extension allow-list",
    },
];

/** Union — the full bundled HorizonDB surface (back-compat). */
const REQUIRED: Ext[] = [...FACT_REQUIRED, ...GRAPH_REQUIRED];

async function missingFrom(pool: any, required: Ext[]): Promise<string[]> {
    const { rows } = await pool.query(
        `SELECT name FROM pg_available_extensions WHERE name = ANY($1)`,
        [required.map((r) => r.name)],
    );
    const available = new Set(rows.map((r: any) => r.name));
    return required.filter((r) => !available.has(r.name)).map((r) => r.name);
}

function assertFrom(missing: string[], required: Ext[], surface: string): void {
    if (missing.length === 0) return;
    const lines = missing.map((name) => {
        const r = required.find((x) => x.name === name)!;
        return `  - ${name}: ${r.why}. Fix: ${r.fix}`;
    });
    throw new Error(
        `${surface} preconditions failed — this database is missing ${missing.length} required ` +
        `extension(s):\n${lines.join("\n")}\n` +
        `${surface} requires HorizonDB (or equivalent). There are no fallbacks; ` +
        `point the connection string at a capable cluster.`,
    );
}

/** Pieces missing BEFORE migrations run — full bundled surface (back-compat). */
export async function missingExtensions(pool: any): Promise<string[]> {
    return missingFrom(pool, REQUIRED);
}

/** Fact-provider missing extensions (vector / pg_textsearch / pg_durable). */
export async function missingFactExtensions(pool: any): Promise<string[]> {
    return missingFrom(pool, FACT_REQUIRED);
}

/** Graph-provider missing extensions (age). */
export async function missingGraphExtensions(pool: any): Promise<string[]> {
    return missingFrom(pool, GRAPH_REQUIRED);
}

/** Throw the itemized fail-fast error if any required extension is unavailable
 *  (full bundled surface — back-compat). */
export async function assertExtensionsAvailable(pool: any): Promise<void> {
    assertFrom(await missingExtensions(pool), REQUIRED, "EnhancedFactStore");
}

/** Fail-fast for the enhanced FACT provider (vector / pg_textsearch / pg_durable). */
export async function assertFactExtensions(pool: any): Promise<void> {
    assertFrom(await missingFactExtensions(pool), FACT_REQUIRED, "HorizonDBFactStore");
}

/** Fail-fast for the GRAPH provider (age only). */
export async function assertGraphExtensions(pool: any): Promise<void> {
    assertFrom(await missingGraphExtensions(pool), GRAPH_REQUIRED, "HorizonDBGraphStore");
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
