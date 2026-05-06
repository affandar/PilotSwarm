import { describe, it, expect } from "vitest";
import { PgActivityPoller } from "../../src/perf/pg-activity-poller.js";
import type { PgLikeClient } from "../../src/perf/db-tracker.js";

class FakeActivityPg implements PgLikeClient {
  public ended = false;
  public connected = false;
  private script: Array<Array<{ datname: string; n: string }>>;
  private idx = 0;
  constructor(script: Array<Array<{ datname: string; n: string }>>) {
    this.script = script;
  }
  async connect(): Promise<void> {
    this.connected = true;
  }
  async end(): Promise<void> {
    this.ended = true;
  }
  async query<T = unknown>(): Promise<{ rows: T[] }> {
    const rows = this.script[Math.min(this.idx, this.script.length - 1)] ?? [];
    this.idx++;
    return { rows: rows as unknown as T[] };
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("PgActivityPoller", () => {
  it("requires connectionString", () => {
    expect(() => new PgActivityPoller({ connectionString: "" })).toThrow(
      /connectionString/,
    );
  });

  it("start polls immediately and stop returns peak/mean", async () => {
    const pg = new FakeActivityPg([
      [{ datname: "ps", n: "3" }],
      [{ datname: "ps", n: "5" }],
      [{ datname: "ps", n: "4" }],
    ]);
    const poller = new PgActivityPoller({
      connectionString: "postgres://x",
      intervalMs: 20,
      pgClientFactory: async () => pg,
    });
    await poller.start();
    expect(poller.isRunning()).toBe(true);
    await sleep(80);
    const res = await poller.stop();
    expect(poller.isRunning()).toBe(false);
    expect(res.samples.length).toBeGreaterThanOrEqual(1);
    expect(res.peak).toBeGreaterThan(0);
    expect(pg.ended).toBe(true);
  });

  it("stop without start returns empty result deterministically", async () => {
    const poller = new PgActivityPoller({
      connectionString: "postgres://x",
      pgClientFactory: async () => new FakeActivityPg([]),
    });
    const res = await poller.stop();
    expect(res.samples).toEqual([]);
    expect(res.peak).toBe(0);
  });

  it("rejects double-start", async () => {
    const pg = new FakeActivityPg([[{ datname: "ps", n: "1" }]]);
    const poller = new PgActivityPoller({
      connectionString: "postgres://x",
      intervalMs: 50,
      pgClientFactory: async () => pg,
    });
    await poller.start();
    await expect(poller.start()).rejects.toThrow(/already started/);
    await poller.stop();
  });

  it("computes per-database mean and peak", async () => {
    const pg = new FakeActivityPg([
      [
        { datname: "a", n: "2" },
        { datname: "b", n: "3" },
      ],
      [
        { datname: "a", n: "6" },
        { datname: "b", n: "1" },
      ],
    ]);
    const poller = new PgActivityPoller({
      connectionString: "postgres://x",
      intervalMs: 15,
      pgClientFactory: async () => pg,
    });
    await poller.start();
    await sleep(60);
    const res = await poller.stop();
    expect(res.peakByDatabase.a).toBeGreaterThanOrEqual(2);
    expect(Object.keys(res.meanByDatabase).sort()).toEqual(["a", "b"]);
  });

  it("does not throw when poll query fails", async () => {
    class BadPg extends FakeActivityPg {
      override async query(): Promise<never> {
        throw new Error("nope");
      }
    }
    const pg = new BadPg([]);
    const poller = new PgActivityPoller({
      connectionString: "postgres://x",
      intervalMs: 15,
      pgClientFactory: async () => pg,
    });
    await poller.start();
    await sleep(40);
    const res = await poller.stop();
    expect(res.peak).toBe(0);
    expect(pg.ended).toBe(true);
  });

  it("clamps very small intervalMs to a safe minimum", async () => {
    const pg = new FakeActivityPg([[{ datname: "ps", n: "1" }]]);
    const poller = new PgActivityPoller({
      connectionString: "postgres://x",
      intervalMs: 1,
      pgClientFactory: async () => pg,
    });
    await poller.start();
    await sleep(40);
    const res = await poller.stop();
    expect(res.samples.length).toBeGreaterThan(0);
  });

  // H1 fix
  it("does not leak the client when connect() rejects (H1)", async () => {
    let createdClient: FakeActivityPg | null = null;
    class FailingConnectPg extends FakeActivityPg {
      override async connect(): Promise<void> {
        throw new Error("connect refused");
      }
    }
    const poller = new PgActivityPoller({
      connectionString: "postgres://x",
      intervalMs: 50,
      pgClientFactory: async () => {
        createdClient = new FailingConnectPg([]);
        return createdClient;
      },
    });
    await expect(poller.start()).rejects.toThrow(/connect refused/);
    expect(createdClient).not.toBeNull();
    // The poller must have called end() on the created client to release it.
    expect((createdClient as unknown as FakeActivityPg).ended).toBe(true);
    expect(poller.isRunning()).toBe(false);
    // A subsequent stop() (defensive) must not throw and returns empty.
    const res = await poller.stop();
    expect(res.samples).toEqual([]);
  });

  it("does not leak the client when client factory throws after construction", async () => {
    let createdClient: FakeActivityPg | null = null;
    class CtorFailPg extends FakeActivityPg {
      override async connect(): Promise<void> {
        // Factory ran, ctor succeeded, then connect throws — same code path.
        throw new Error("auth failure");
      }
    }
    const poller = new PgActivityPoller({
      connectionString: "postgres://x",
      pgClientFactory: async () => {
        createdClient = new CtorFailPg([]);
        return createdClient;
      },
    });
    await expect(poller.start()).rejects.toThrow(/auth failure/);
    expect((createdClient as unknown as FakeActivityPg).ended).toBe(true);
  });
});
