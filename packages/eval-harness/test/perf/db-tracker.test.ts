import { describe, it, expect } from "vitest";
import {
  DbTracker,
  categorizeQuery,
  diffSnapshots,
  emptySnapshot,
} from "../../src/perf/db-tracker.js";
import type {
  DbStatementSnapshot,
  PgLikeClient,
} from "../../src/perf/db-tracker.js";

function row(
  hash: string,
  calls: number,
  totalMs: number,
  preview: string,
): DbStatementSnapshot["byHash"][string] {
  return {
    queryHash: hash,
    calls,
    totalExecTimeMs: totalMs,
    meanExecTimeMs: calls > 0 ? totalMs / calls : 0,
    queryPreview: preview,
  };
}

function snap(rows: ReturnType<typeof row>[]): DbStatementSnapshot {
  const byHash: DbStatementSnapshot["byHash"] = {};
  let totalQueries = 0;
  let totalExecTimeMs = 0;
  for (const r of rows) {
    byHash[r.queryHash] = r;
    totalQueries += r.calls;
    totalExecTimeMs += r.totalExecTimeMs;
  }
  return {
    available: true,
    capturedAt: 0,
    totalQueries,
    totalExecTimeMs,
    topSlow: [...rows].sort((a, b) => b.totalExecTimeMs - a.totalExecTimeMs).slice(0, 10),
    byHash,
  };
}

describe("categorizeQuery", () => {
  it("classifies orchestration queries (_duroxide schema)", () => {
    expect(categorizeQuery("SELECT * FROM _duroxide.history")).toBe("orchestration");
    expect(categorizeQuery('INSERT INTO "_duroxide"."history"')).toBe("orchestration");
    expect(categorizeQuery("UPDATE orchestration_instances SET state=$1")).toBe(
      "orchestration",
    );
  });

  it("classifies real duroxide table names without schema prefix (H3)", () => {
    // Even when the query preview lacks the _duroxide schema, the table
    // name itself indicates orchestration.
    expect(categorizeQuery('SELECT * FROM "ps_test_x".history WHERE seq=$1')).toBe(
      "orchestration",
    );
    expect(categorizeQuery('SELECT * FROM "ps_test_x".executions')).toBe("orchestration");
    expect(categorizeQuery('UPDATE "ps_test_x".instances SET state=$1')).toBe(
      "orchestration",
    );
    expect(categorizeQuery('SELECT * FROM "ps_test_x".instance_locks')).toBe(
      "orchestration",
    );
    expect(categorizeQuery('INSERT INTO "ps_test_x".kv_delta VALUES ($1)')).toBe(
      "orchestration",
    );
    expect(categorizeQuery('SELECT * FROM "ps_test_x".kv_store')).toBe("orchestration");
    expect(categorizeQuery('SELECT * FROM "ps_test_x".orchestrator_queue')).toBe(
      "orchestration",
    );
    expect(categorizeQuery('SELECT * FROM "ps_test_x".worker_queue')).toBe(
      "orchestration",
    );
  });

  it("classifies cms queries by schema and table prefix", () => {
    expect(categorizeQuery("SELECT * FROM cms.sessions")).toBe("cms");
    expect(categorizeQuery("INSERT INTO sessions(id) VALUES ($1)")).toBe("cms");
    expect(categorizeQuery("UPDATE session_events SET seen=true")).toBe("cms");
    expect(categorizeQuery("SELECT * FROM child_sessions")).toBe("cms");
  });

  it("classifies session_metric_summaries as cms (H3)", () => {
    expect(
      categorizeQuery('INSERT INTO "ps_test_cms_x".session_metric_summaries VALUES ($1)'),
    ).toBe("cms");
    expect(categorizeQuery("UPDATE session_metric_summaries SET ...")).toBe("cms");
  });

  it("classifies migration tooling tables into other (not cms/orchestration)", () => {
    expect(categorizeQuery("INSERT INTO goose_db_version VALUES ($1)")).toBe("other");
    expect(categorizeQuery("SELECT * FROM sqlx_migrations")).toBe("other");
    expect(categorizeQuery("SELECT * FROM schema_migrations")).toBe("other");
  });

  it("classifies facts queries", () => {
    expect(categorizeQuery("SELECT * FROM facts.foo")).toBe("facts");
    expect(categorizeQuery("INSERT INTO fact_users VALUES ($1)")).toBe("facts");
  });

  it("classifies session-store queries", () => {
    expect(categorizeQuery("SELECT * FROM session_store WHERE id=$1")).toBe(
      "session-store",
    );
    expect(categorizeQuery("INSERT INTO session_state VALUES ($1)")).toBe(
      "session-store",
    );
    expect(categorizeQuery("SELECT * FROM session_snapshot")).toBe("session-store");
  });

  it("classifies blob-store queries", () => {
    expect(categorizeQuery("SELECT * FROM blob.entries")).toBe("blob-store");
    expect(categorizeQuery("INSERT INTO blob_store VALUES ($1)")).toBe("blob-store");
  });

  it("falls back to other for unrecognized queries", () => {
    expect(categorizeQuery("SELECT 1")).toBe("other");
    expect(categorizeQuery("SELECT * FROM pg_catalog.pg_tables")).toBe("other");
    expect(categorizeQuery("")).toBe("other");
  });
});

describe("emptySnapshot / diffSnapshots", () => {
  it("emptySnapshot marks unavailable with reason", () => {
    const s = emptySnapshot("missing extension");
    expect(s.available).toBe(false);
    expect(s.unavailableReason).toBe("missing extension");
    expect(s.totalQueries).toBe(0);
  });

  it("delta is unavailable when either snapshot is unavailable", () => {
    const before = emptySnapshot("x");
    const after = snap([row("a", 1, 1, "SELECT 1")]);
    const d = diffSnapshots(before, after);
    expect(d.available).toBe(false);
    expect(d.unavailableReason).toBe("x");
  });

  it("diffs counts and time for stable queries", () => {
    const before = snap([row("a", 5, 100, "SELECT * FROM cms.sessions")]);
    const after = snap([row("a", 8, 250, "SELECT * FROM cms.sessions")]);
    const d = diffSnapshots(before, after);
    expect(d.available).toBe(true);
    expect(d.queries).toBe(3);
    expect(d.execTimeMs).toBe(150);
    expect(d.byCategory.cms).toBe(3);
  });

  it("includes new queries that didn't exist before", () => {
    const before = snap([]);
    const after = snap([row("a", 4, 80, "SELECT * FROM facts.f")]);
    const d = diffSnapshots(before, after);
    expect(d.queries).toBe(4);
    expect(d.byCategory.facts).toBe(4);
    expect(d.topSlowDelta).toHaveLength(1);
    expect(d.topSlowDelta[0]?.queryHash).toBe("a");
  });

  it("ignores queries with no positive delta", () => {
    const before = snap([row("a", 10, 200, "SELECT 1")]);
    const after = snap([row("a", 10, 200, "SELECT 1")]);
    const d = diffSnapshots(before, after);
    expect(d.queries).toBe(0);
    expect(d.topSlowDelta).toHaveLength(0);
  });

  it("topSlowDelta is sorted by totalExecTimeMs desc", () => {
    const before = snap([]);
    const after = snap([
      row("slow", 1, 500, "SELECT 1"),
      row("med", 1, 100, "SELECT 2"),
      row("fast", 1, 10, "SELECT 3"),
    ]);
    const d = diffSnapshots(before, after, 10);
    expect(d.topSlowDelta.map((r) => r.queryHash)).toEqual(["slow", "med", "fast"]);
  });

  it("respects topN", () => {
    const before = snap([]);
    const after = snap([
      row("a", 1, 30, "SELECT 1"),
      row("b", 1, 20, "SELECT 2"),
      row("c", 1, 10, "SELECT 3"),
    ]);
    const d = diffSnapshots(before, after, 2);
    expect(d.topSlowDelta).toHaveLength(2);
    expect(d.topSlowDelta.map((r) => r.queryHash)).toEqual(["a", "b"]);
  });

  it("aggregates byCategory across multiple categories", () => {
    const before = snap([]);
    const after = snap([
      row("o1", 2, 5, "SELECT * FROM _duroxide.history"),
      row("c1", 3, 5, "SELECT * FROM cms.sessions"),
      row("c2", 4, 5, "INSERT INTO sessions VALUES ($1)"),
      row("x", 1, 5, "SELECT 1"),
    ]);
    const d = diffSnapshots(before, after);
    expect(d.byCategory.orchestration).toBe(2);
    expect(d.byCategory.cms).toBe(7);
    expect(d.byCategory.other).toBe(1);
  });
});

class FakePg implements PgLikeClient {
  private hasExt: boolean;
  private rows: Array<{
    queryid: string | null;
    calls: string;
    total_exec_time: string;
    mean_exec_time: string;
    query: string;
  }>;
  public connectCalls = 0;
  public endCalls = 0;
  public queries: string[] = [];

  constructor(hasExt: boolean, rows: FakePg["rows"] = []) {
    this.hasExt = hasExt;
    this.rows = rows;
  }
  async connect(): Promise<void> {
    this.connectCalls++;
  }
  async end(): Promise<void> {
    this.endCalls++;
  }
  async query<T = unknown>(text: string): Promise<{ rows: T[] }> {
    this.queries.push(text);
    if (text.includes("pg_extension")) {
      return { rows: [{ exists: this.hasExt }] as T[] };
    }
    if (text.includes("pg_stat_statements_reset")) {
      return { rows: [] as T[] };
    }
    if (text.includes("pg_stat_statements")) {
      return { rows: this.rows as T[] };
    }
    return { rows: [] as T[] };
  }
}

describe("DbTracker", () => {
  it("requires connectionString", () => {
    expect(() => new DbTracker({ connectionString: "" })).toThrow(/connectionString/);
  });

  it("snapshot returns unavailable when extension missing", async () => {
    const fake = new FakePg(false);
    const tr = new DbTracker({
      connectionString: "postgres://x",
      pgClientFactory: async () => fake,
    });
    const s = await tr.snapshot();
    expect(s.available).toBe(false);
    expect(s.unavailableReason).toMatch(/pg_stat_statements/);
    expect(fake.endCalls).toBe(1);
  });

  it("snapshot reads pg_stat_statements rows when extension present", async () => {
    const fake = new FakePg(true, [
      {
        queryid: "111",
        calls: "5",
        total_exec_time: "50",
        mean_exec_time: "10",
        query: "SELECT * FROM cms.sessions",
      },
      {
        queryid: "222",
        calls: "2",
        total_exec_time: "30",
        mean_exec_time: "15",
        query: "SELECT * FROM _duroxide.history",
      },
    ]);
    const tr = new DbTracker({
      connectionString: "postgres://x",
      pgClientFactory: async () => fake,
    });
    const s = await tr.snapshot();
    expect(s.available).toBe(true);
    expect(s.totalQueries).toBe(7);
    expect(s.totalExecTimeMs).toBe(80);
    expect(Object.keys(s.byHash)).toEqual(["111", "222"]);
    expect(fake.endCalls).toBe(1);
  });

  it("measure() computes a delta around the wrapped fn", async () => {
    const seq: FakePg["rows"][] = [
      [
        {
          queryid: "1",
          calls: "1",
          total_exec_time: "10",
          mean_exec_time: "10",
          query: "SELECT * FROM cms.sessions",
        },
      ],
      [
        {
          queryid: "1",
          calls: "4",
          total_exec_time: "40",
          mean_exec_time: "10",
          query: "SELECT * FROM cms.sessions",
        },
      ],
    ];
    let i = 0;
    const tr = new DbTracker({
      connectionString: "postgres://x",
      pgClientFactory: async () => new FakePg(true, seq[i++] ?? []),
    });
    const { result, delta } = await tr.measure(async () => 42);
    expect(result).toBe(42);
    expect(delta.available).toBe(true);
    expect(delta.queries).toBe(3);
    expect(delta.byCategory.cms).toBe(3);
  });

  it("ends client even when query throws", async () => {
    class ThrowingPg extends FakePg {
      override async query(): Promise<never> {
        throw new Error("boom");
      }
    }
    const fake = new ThrowingPg(true);
    const tr = new DbTracker({
      connectionString: "postgres://x",
      pgClientFactory: async () => fake,
    });
    const s = await tr.snapshot();
    expect(s.available).toBe(false);
    expect(s.unavailableReason).toMatch(/boom/);
    expect(fake.endCalls).toBe(1);
  });
});

describe("DbTracker.precheckPgStatStatements (B1)", () => {
  it("returns available:true when extension exists and view query succeeds", async () => {
    const fake = new FakePg(true);
    const tr = new DbTracker({
      connectionString: "postgres://x",
      pgClientFactory: async () => fake,
    });
    const r = await tr.precheckPgStatStatements();
    expect(r.available).toBe(true);
    expect(fake.endCalls).toBe(1);
  });

  it("returns available:false with reason when extension missing", async () => {
    const fake = new FakePg(false);
    const tr = new DbTracker({
      connectionString: "postgres://x",
      pgClientFactory: async () => fake,
    });
    const r = await tr.precheckPgStatStatements();
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/extension not installed/);
    expect(fake.endCalls).toBe(1);
  });

  it("returns available:false when view exists but throws (no preload)", async () => {
    // Simulates the local container case: pg_extension row exists but the
    // view query fails because shared_preload_libraries isn't set.
    class HalfBrokenPg extends FakePg {
      override async query<T = unknown>(text: string): Promise<{ rows: T[] }> {
        if (text.includes("pg_extension")) {
          return { rows: [{ exists: true }] as T[] };
        }
        if (text.includes("pg_stat_statements")) {
          throw new Error("pg_stat_statements must be loaded via shared_preload_libraries");
        }
        return { rows: [] as T[] };
      }
    }
    const fake = new HalfBrokenPg(true);
    const tr = new DbTracker({
      connectionString: "postgres://x",
      pgClientFactory: async () => fake,
    });
    const r = await tr.precheckPgStatStatements();
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/shared_preload_libraries/);
    expect(fake.endCalls).toBe(1);
  });
});

describe("DbTracker.assertPgStatStatementsAvailable (B1)", () => {
  it("resolves silently when extension is available", async () => {
    const fake = new FakePg(true);
    const tr = new DbTracker({
      connectionString: "postgres://x",
      pgClientFactory: async () => fake,
    });
    await expect(tr.assertPgStatStatementsAvailable()).resolves.toBeUndefined();
  });

  it("throws PgStatStatementsRequiredError when unavailable", async () => {
    const { PgStatStatementsRequiredError } = await import(
      "../../src/perf/db-tracker.js"
    );
    const fake = new FakePg(false);
    const tr = new DbTracker({
      connectionString: "postgres://x",
      pgClientFactory: async () => fake,
    });
    await expect(tr.assertPgStatStatementsAvailable()).rejects.toBeInstanceOf(
      PgStatStatementsRequiredError,
    );
    await expect(tr.assertPgStatStatementsAvailable()).rejects.toThrow(
      /shared_preload_libraries=pg_stat_statements/,
    );
  });
});
