/**
 * Polls pg_stat_activity at a fixed interval to capture connection-count
 * peaks during a measured operation. Uses a dedicated single-connection
 * client; stop() reports samples + peak + per-database mean.
 */

import type { PgLikeClient } from "./db-tracker.js";

export interface ActivitySample {
  capturedAt: number;
  total: number;
  byDatabase: Record<string, number>;
}

export interface PgActivityResult {
  samples: ActivitySample[];
  peak: number;
  meanByDatabase: Record<string, number>;
  peakByDatabase: Record<string, number>;
  durationMs: number;
}

export interface PgActivityPollerOptions {
  connectionString: string;
  intervalMs?: number;
  databases?: string[];
  pgClientFactory?: (connectionString: string) => Promise<PgLikeClient>;
}

async function defaultPgFactory(connectionString: string): Promise<PgLikeClient> {
  const mod: { Client: new (cfg: { connectionString: string }) => PgLikeClient } =
    (await import("pg")) as unknown as {
      Client: new (cfg: { connectionString: string }) => PgLikeClient;
    };
  return new mod.Client({ connectionString });
}

export class PgActivityPoller {
  private opts: PgActivityPollerOptions;
  private intervalMs: number;
  private samples: ActivitySample[] = [];
  private timer: NodeJS.Timeout | null = null;
  private client: PgLikeClient | null = null;
  private startedAt = 0;
  private polling = false;
  private inflight: Promise<void> | null = null;
  private stopped = false;

  constructor(opts: PgActivityPollerOptions) {
    if (!opts.connectionString) {
      throw new Error("PgActivityPoller: connectionString is required");
    }
    this.opts = opts;
    this.intervalMs = Math.max(10, opts.intervalMs ?? 100);
  }

  isRunning(): boolean {
    return this.polling;
  }

  async start(): Promise<void> {
    if (this.polling) throw new Error("PgActivityPoller: already started");
    this.samples = [];
    this.stopped = false;
    const factory = this.opts.pgClientFactory ?? defaultPgFactory;
    // H1 fix: client construction or connect() can fail. Either path must
    // not leak a half-open connection — if connect() rejects, end() the
    // client (best-effort) and re-throw so the caller sees the original
    // error.
    let client: PgLikeClient | null = null;
    try {
      client = await factory(this.opts.connectionString);
      await client.connect();
    } catch (err) {
      if (client) {
        try {
          await client.end();
        } catch {
          /* swallow secondary cleanup failure */
        }
      }
      this.client = null;
      throw err;
    }
    this.client = client;
    this.startedAt = Date.now();
    this.polling = true;
    // Take an immediate sample then schedule the next.
    this.inflight = this.poll();
    this.timer = setInterval(() => {
      if (!this.polling) return;
      if (this.inflight) return; // skip if previous still in flight
      this.inflight = this.poll();
    }, this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  async stop(): Promise<PgActivityResult> {
    if (!this.polling && !this.stopped) {
      // Allow stop without start to return empty result deterministically.
      this.stopped = true;
      return summarize(this.samples, 0);
    }
    this.polling = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inflight) {
      try {
        await this.inflight;
      } catch {
        /* ignore */
      }
      this.inflight = null;
    }
    if (this.client) {
      try {
        await this.client.end();
      } catch {
        /* ignore */
      }
      this.client = null;
    }
    this.stopped = true;
    return summarize(this.samples, Date.now() - this.startedAt);
  }

  private async poll(): Promise<void> {
    if (!this.client || !this.polling) return;
    try {
      const filter = this.opts.databases && this.opts.databases.length > 0;
      const res = await this.client.query<{ datname: string | null; n: string }>(
        filter
          ? `SELECT COALESCE(datname, '') AS datname, COUNT(*)::text AS n
             FROM pg_stat_activity
             WHERE datname = ANY($1::text[])
             GROUP BY datname`
          : `SELECT COALESCE(datname, '') AS datname, COUNT(*)::text AS n
             FROM pg_stat_activity
             GROUP BY datname`,
        filter ? [this.opts.databases] : undefined,
      );
      const byDatabase: Record<string, number> = {};
      let total = 0;
      for (const row of res.rows) {
        const n = Number(row.n) || 0;
        const name = row.datname ?? "";
        byDatabase[name] = n;
        total += n;
      }
      this.samples.push({ capturedAt: Date.now(), total, byDatabase });
    } catch {
      // swallow — poller must not throw
    } finally {
      this.inflight = null;
    }
  }
}

function summarize(samples: ActivitySample[], durationMs: number): PgActivityResult {
  let peak = 0;
  const sumByDb: Record<string, number> = {};
  const countByDb: Record<string, number> = {};
  const peakByDb: Record<string, number> = {};
  for (const s of samples) {
    if (s.total > peak) peak = s.total;
    for (const [db, n] of Object.entries(s.byDatabase)) {
      sumByDb[db] = (sumByDb[db] ?? 0) + n;
      countByDb[db] = (countByDb[db] ?? 0) + 1;
      if (n > (peakByDb[db] ?? 0)) peakByDb[db] = n;
    }
  }
  const meanByDatabase: Record<string, number> = {};
  for (const db of Object.keys(sumByDb)) {
    const c = countByDb[db] ?? 0;
    meanByDatabase[db] = c > 0 ? (sumByDb[db] ?? 0) / c : 0;
  }
  return { samples, peak, meanByDatabase, peakByDatabase: peakByDb, durationMs };
}
