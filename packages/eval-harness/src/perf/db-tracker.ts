/**
 * DB call tracker — wraps pg_stat_statements snapshots so we can compute
 * deltas across a measured operation. Categorizes queries by schema/table
 * prefix into orchestration / cms / facts / session-store / blob-store /
 * other so perf budgets can be expressed per-subsystem.
 *
 * No long-lived connection: each `snapshot()` opens a one-shot pg.Client
 * and ends it before returning. If pg_stat_statements is not installed
 * the snapshot returns `available: false` with a `unavailableReason` so
 * callers can degrade gracefully.
 */

export type DbCategory =
  | "orchestration"
  | "cms"
  | "facts"
  | "session-store"
  | "blob-store"
  | "other";

export interface DbStatementRow {
  queryHash: string;
  calls: number;
  meanExecTimeMs: number;
  totalExecTimeMs: number;
  queryPreview: string;
}

export interface DbStatementSnapshot {
  available: boolean;
  unavailableReason?: string;
  capturedAt: number;
  totalQueries: number;
  totalExecTimeMs: number;
  topSlow: DbStatementRow[];
  byHash: Record<string, DbStatementRow>;
}

export interface DbCallDelta {
  available: boolean;
  unavailableReason?: string;
  queries: number;
  execTimeMs: number;
  topSlowDelta: DbStatementRow[];
  byCategory: Record<DbCategory, number>;
}

export interface DbTrackerOptions {
  connectionString: string;
  resetStats?: boolean;
  topN?: number;
  /** Test-only injection point for the pg client factory. */
  pgClientFactory?: (connectionString: string) => Promise<PgLikeClient>;
}

export interface PgLikeClient {
  connect(): Promise<void>;
  query<T = unknown>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

/**
 * Category patterns are evaluated in order; the first match wins. Patterns
 * are deliberately written so that schema-qualified PilotSwarm tables (e.g.
 * `"ps_test_cms_xxx".sessions` or `"ps_test_duroxide_xxx".history`) are
 * categorized correctly even when the schema is dynamic.
 *
 * Migration tables (Goose / postgres-migrations / sqlx_migrations) are
 * excluded into a dedicated bucket so they don't inflate "other" or
 * pollute orchestration/cms counts.
 */
const CATEGORY_PATTERNS: Array<{ category: DbCategory; pattern: RegExp }> = [
  // Migration tooling — capture before generic patterns so it doesn't leak
  // into other categories. Maps to "other" in the public DbCategory shape
  // (we don't want migrations to show up as cms/orchestration).
  { category: "other", pattern: /\b(?:goose_db_version|sqlx_migrations|schema_migrations|knex_migrations|__diesel_schema_migrations|migrations_lock)\b/i },

  // Orchestration: duroxide schema and known duroxide tables. The schema is
  // typically `_duroxide_<suite>` in tests and `_duroxide` in prod.
  { category: "orchestration", pattern: /\b_?duroxide\b/i },
  { category: "orchestration", pattern: /\b(?:orchestration_history|orchestration_instances|orchestration_state|orchestration_runtime)\b/i },
  // Real duroxide table names — must be matched even when the surrounding
  // schema isn't visible in the query preview.
  { category: "orchestration", pattern: /\b(?:history|executions|instances|instance_locks|kv_delta|kv_store|orchestrator_queue|worker_queue)\b/i },

  // Facts subsystem
  { category: "facts", pattern: /\bfacts?[._]/i },
  { category: "facts", pattern: /\b(fact_[\w]+|facts_[\w]+)\b/i },

  // Blob store
  { category: "blob-store", pattern: /\bblob[_-]?store|\bblob[._]/i },

  // Session store (durable session snapshots)
  { category: "session-store", pattern: /\bsession[_-]?(store|state|snapshot)\b/i },

  // CMS — explicit schema prefix and known CMS tables. `session_metric_summaries`
  // and `session_titles` etc. were missing from earlier versions; now covered.
  { category: "cms", pattern: /\bcms[._]/i },
  { category: "cms", pattern: /\b(?:sessions|session_events|session_metric_summaries|child_sessions|session_titles|session_tags|events?_log)\b/i },
];

export function categorizeQuery(query: string): DbCategory {
  if (!query) return "other";
  for (const { category, pattern } of CATEGORY_PATTERNS) {
    if (pattern.test(query)) return category;
  }
  return "other";
}

export function emptySnapshot(reason: string): DbStatementSnapshot {
  return {
    available: false,
    unavailableReason: reason,
    capturedAt: Date.now(),
    totalQueries: 0,
    totalExecTimeMs: 0,
    topSlow: [],
    byHash: {},
  };
}

export function diffSnapshots(
  before: DbStatementSnapshot,
  after: DbStatementSnapshot,
  topN = 10,
): DbCallDelta {
  if (!before.available || !after.available) {
    return {
      available: false,
      unavailableReason:
        before.unavailableReason ?? after.unavailableReason ?? "snapshot unavailable",
      queries: 0,
      execTimeMs: 0,
      topSlowDelta: [],
      byCategory: emptyCategoryMap(),
    };
  }
  const byCategory = emptyCategoryMap();
  let queries = 0;
  let execTimeMs = 0;
  const deltaRows: DbStatementRow[] = [];

  for (const [hash, afterRow] of Object.entries(after.byHash)) {
    const beforeRow = before.byHash[hash];
    const callsDelta = afterRow.calls - (beforeRow?.calls ?? 0);
    const timeDelta = afterRow.totalExecTimeMs - (beforeRow?.totalExecTimeMs ?? 0);
    if (callsDelta <= 0 && timeDelta <= 0) continue;
    queries += Math.max(0, callsDelta);
    execTimeMs += Math.max(0, timeDelta);
    const cat = categorizeQuery(afterRow.queryPreview);
    byCategory[cat] += Math.max(0, callsDelta);
    deltaRows.push({
      queryHash: hash,
      calls: Math.max(0, callsDelta),
      meanExecTimeMs:
        callsDelta > 0 ? Math.max(0, timeDelta) / callsDelta : afterRow.meanExecTimeMs,
      totalExecTimeMs: Math.max(0, timeDelta),
      queryPreview: afterRow.queryPreview,
    });
  }
  deltaRows.sort((a, b) => b.totalExecTimeMs - a.totalExecTimeMs);
  return {
    available: true,
    queries,
    execTimeMs,
    topSlowDelta: deltaRows.slice(0, topN),
    byCategory,
  };
}

function emptyCategoryMap(): Record<DbCategory, number> {
  return {
    orchestration: 0,
    cms: 0,
    facts: 0,
    "session-store": 0,
    "blob-store": 0,
    other: 0,
  };
}

async function defaultPgFactory(connectionString: string): Promise<PgLikeClient> {
  const mod: { Client: new (cfg: { connectionString: string }) => PgLikeClient } =
    (await import("pg")) as unknown as {
      Client: new (cfg: { connectionString: string }) => PgLikeClient;
    };
  return new mod.Client({ connectionString });
}

/**
 * Thrown when a caller has opted into strict mode and pg_stat_statements
 * is required but unavailable. Lets LIVE perf gates fail loudly instead
 * of silently passing with no DB signal.
 */
export class PgStatStatementsRequiredError extends Error {
  override readonly name = "PgStatStatementsRequiredError";
  readonly reason: string;
  constructor(reason: string) {
    super(
      `pg_stat_statements is required but unavailable: ${reason}. ` +
        `Enable it in postgresql.conf via ` +
        `shared_preload_libraries=pg_stat_statements and run ` +
        `CREATE EXTENSION pg_stat_statements;`,
    );
    this.reason = reason;
  }
}

export interface PgStatStatementsCheck {
  available: boolean;
  reason?: string;
}

export class DbTracker {
  private opts: DbTrackerOptions;
  private topN: number;

  constructor(opts: DbTrackerOptions) {
    if (!opts.connectionString) {
      throw new Error("DbTracker: connectionString is required");
    }
    this.opts = opts;
    this.topN = opts.topN ?? 10;
  }

  /**
   * Lightweight precheck — opens a one-shot connection, verifies the
   * extension is installed AND that querying it actually works (an extension
   * row can exist while the underlying `pg_stat_statements` view is broken
   * if the library wasn't preloaded). Returns `{ available, reason }` so
   * callers can decide whether to skip, fail, or proceed.
   *
   * Use this from LIVE test setup with `it.skipIf` or convert to a hard
   * failure via `assertPgStatStatementsAvailable()` below.
   */
  async precheckPgStatStatements(): Promise<PgStatStatementsCheck> {
    let client: PgLikeClient | null = null;
    try {
      client = await this.openClient();
      // Step 1: extension row.
      const probe = await client.query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
         ) AS exists`,
      );
      if (probe.rows[0]?.exists !== true) {
        return {
          available: false,
          reason: "extension not installed (CREATE EXTENSION pg_stat_statements)",
        };
      }
      // Step 2: verify the view actually works. If shared_preload_libraries
      // isn't set, the extension row exists but the view raises. We probe
      // with LIMIT 0 to avoid pulling rows.
      try {
        await client.query("SELECT 1 FROM pg_stat_statements LIMIT 0");
      } catch (err) {
        return {
          available: false,
          reason: `view query failed (likely missing shared_preload_libraries=pg_stat_statements): ${errMsg(err)}`,
        };
      }
      return { available: true };
    } catch (err) {
      return { available: false, reason: errMsg(err) };
    } finally {
      if (client) await safeEnd(client);
    }
  }

  /**
   * Throws `PgStatStatementsRequiredError` if the extension is unavailable.
   * Call this from LIVE tests that *must* measure DB calls — silent
   * fallback hides regressions.
   */
  async assertPgStatStatementsAvailable(): Promise<void> {
    const check = await this.precheckPgStatStatements();
    if (!check.available) {
      throw new PgStatStatementsRequiredError(check.reason ?? "unknown");
    }
  }

  /** Resets pg_stat_statements counters. No-op if extension unavailable. */
  async resetStats(): Promise<{ ok: boolean; reason?: string }> {
    const client = await this.openClient();
    try {
      await client.query("SELECT pg_stat_statements_reset()");
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: errMsg(err) };
    } finally {
      await safeEnd(client);
    }
  }

  async snapshot(): Promise<DbStatementSnapshot> {
    let client: PgLikeClient | null = null;
    try {
      client = await this.openClient();
      const probe = await client
        .query<{ exists: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
           ) AS exists`,
        )
        .catch((err) => ({ rows: [], _err: err }) as { rows: { exists: boolean }[]; _err?: unknown });
      const probeErr = (probe as { _err?: unknown })._err;
      if (probeErr) {
        return emptySnapshot(`probe failed: ${errMsg(probeErr)}`);
      }
      const exists = probe.rows[0]?.exists === true;
      if (!exists) {
        return emptySnapshot("pg_stat_statements extension not installed");
      }
      // pg_stat_statements is cluster-wide. Filter by the connected
      // database's dbid so concurrent activity in other databases on
      // the same Postgres server (e.g. another app's write traffic)
      // does not pollute per-turn / per-spawn budget measurements.
      // current_database() resolves at query time so the same tracker
      // can be reused across schemas without rebuilding.
      const res = await client.query<{
        queryid: string | null;
        calls: string;
        total_exec_time: string;
        mean_exec_time: string;
        query: string;
      }>(
        `SELECT queryid::text AS queryid,
                calls::text AS calls,
                COALESCE(total_exec_time, 0)::text AS total_exec_time,
                COALESCE(mean_exec_time, 0)::text AS mean_exec_time,
                LEFT(query, 500) AS query
         FROM pg_stat_statements
         WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
         ORDER BY total_exec_time DESC
         LIMIT 5000`,
      );
      const byHash: Record<string, DbStatementRow> = {};
      let totalQueries = 0;
      let totalExecTimeMs = 0;
      const all: DbStatementRow[] = [];
      for (const row of res.rows) {
        const hash = row.queryid ?? hashFallback(row.query);
        const calls = Number(row.calls) || 0;
        const totalMs = Number(row.total_exec_time) || 0;
        const meanMs = Number(row.mean_exec_time) || 0;
        const r: DbStatementRow = {
          queryHash: hash,
          calls,
          meanExecTimeMs: meanMs,
          totalExecTimeMs: totalMs,
          queryPreview: row.query,
        };
        byHash[hash] = r;
        all.push(r);
        totalQueries += calls;
        totalExecTimeMs += totalMs;
      }
      all.sort((a, b) => b.totalExecTimeMs - a.totalExecTimeMs);
      return {
        available: true,
        capturedAt: Date.now(),
        totalQueries,
        totalExecTimeMs,
        topSlow: all.slice(0, this.topN),
        byHash,
      };
    } catch (err) {
      return emptySnapshot(errMsg(err));
    } finally {
      if (client) await safeEnd(client);
    }
  }

  async measure<T>(fn: () => Promise<T>): Promise<{ result: T; delta: DbCallDelta }> {
    if (this.opts.resetStats) await this.resetStats();
    const before = await this.snapshot();
    const result = await fn();
    const after = await this.snapshot();
    const delta = diffSnapshots(before, after, this.topN);
    return { result, delta };
  }

  private async openClient(): Promise<PgLikeClient> {
    const factory = this.opts.pgClientFactory ?? defaultPgFactory;
    const client = await factory(this.opts.connectionString);
    await client.connect();
    return client;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function safeEnd(client: PgLikeClient): Promise<void> {
  try {
    await client.end();
  } catch {
    /* ignore */
  }
}

function hashFallback(query: string): string {
  let h = 0;
  for (let i = 0; i < query.length; i++) {
    h = (h * 31 + query.charCodeAt(i)) | 0;
  }
  return `fallback:${h.toString(16)}`;
}
