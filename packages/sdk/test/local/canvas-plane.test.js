/**
 * The canvas data plane (migration 0047) against a REAL PgSessionCatalog:
 * RFC 7386 merge semantics in the database, concurrent-writer composition on
 * the row lock, the size gate, doc-pointer resets, and NOTIFY delivery.
 *
 * These are the properties the relay and the runtime mirror build on — if
 * any of them drifts, live canvases silently corrupt, so they are pinned
 * here at the SQL layer where they are enforced.
 *
 * Run: npx vitest run test/local/canvas-plane.test.js
 */

import { describe, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { assert, assertEqual } from "../helpers/assertions.js";

const TIMEOUT = 60_000;
const getEnv = useSuiteEnv(import.meta.url);

async function withCatalog(fn) {
    const env = await getEnv();
    const catalog = await createCatalog(env);
    try {
        await fn({ catalog, env });
    } finally {
        await catalog.close();
    }
}

async function freshSession(catalog) {
    const sessionId = randomUUID();
    await catalog.createSession(sessionId, {});
    return sessionId;
}

describe("canvas data plane on live PostgreSQL", () => {
    it("probe reports the plane; unknown sessions read empty", { timeout: TIMEOUT }, async () => {
        await withCatalog(async ({ catalog }) => {
            assertEqual(await catalog.canvasLiveAvailable(), true);
            assertEqual((await catalog.getCanvasLive(randomUUID())).length, 0);
        });
    });

    it("PUT then PATCH: RFC 7386 in the database — deep merge, null deletes, arrays replace", { timeout: TIMEOUT }, async () => {
        await withCatalog(async ({ catalog }) => {
            const sessionId = await freshSession(catalog);
            const put = await catalog.upsertCanvasLiveTick(sessionId, 1, {
                data: { a: { b: 1, c: 2 }, list: [1, 2, 3], s: "keep-me?" },
            }, "writer-1");
            assertEqual(put.seq, 1);

            const patch = await catalog.upsertCanvasLiveTick(sessionId, 1, {
                patch: { a: { b: 9, d: 3 }, list: [7], s: null },
            }, "writer-1");
            assertEqual(patch.seq, 2);
            // The returned payload is the MERGED whole state (the dual-write
            // event rides on it, so old readers must stay whole).
            assertEqual(JSON.stringify(patch.payload), JSON.stringify({ a: { b: 9, c: 2, d: 3 }, list: [7] }));

            const rows = await catalog.getCanvasLive(sessionId);
            assertEqual(rows.length, 1);
            assertEqual(JSON.stringify(rows[0].payload), JSON.stringify({ a: { b: 9, c: 2, d: 3 }, list: [7] }));
            assertEqual(rows[0].updatedBy, "writer-1");
        });
    });

    it("patch against no row merges into {} and strips nulls", { timeout: TIMEOUT }, async () => {
        await withCatalog(async ({ catalog }) => {
            const sessionId = await freshSession(catalog);
            const out = await catalog.upsertCanvasLiveTick(sessionId, 2, {
                patch: { x: { y: 1 }, gone: null },
            }, "w");
            assertEqual(out.seq, 1);
            assertEqual(JSON.stringify(out.payload), JSON.stringify({ x: { y: 1 } }));
        });
    });

    it("concurrent patches to disjoint paths COMPOSE — the row lock serializes the merges", { timeout: TIMEOUT }, async () => {
        await withCatalog(async ({ catalog }) => {
            const sessionId = await freshSession(catalog);
            await catalog.upsertCanvasLiveTick(sessionId, 1, { data: {} }, "seed");

            const writers = 20;
            await Promise.all(Array.from({ length: writers }, (_, i) =>
                catalog.upsertCanvasLiveTick(sessionId, 1, { patch: { [`tile${i}`]: { n: i } } }, `child-${i}`),
            ));

            const [row] = await catalog.getCanvasLive(sessionId);
            assertEqual(row.seq, writers + 1, "every write minted exactly one seq");
            for (let i = 0; i < writers; i++) {
                assertEqual(row.payload[`tile${i}`]?.n, i, `tile${i} survived the concurrent merge`);
            }
        });
    });

    it("the size gate refuses pre-write and leaves the row untouched", { timeout: TIMEOUT }, async () => {
        await withCatalog(async ({ catalog }) => {
            const sessionId = await freshSession(catalog);
            await catalog.upsertCanvasLiveTick(sessionId, 1, { data: { small: true } }, "w");

            const refused = await catalog.upsertCanvasLiveTick(sessionId, 1, {
                patch: { huge: "x".repeat(40_000) },
            }, "w");
            assert(refused.refused === true, "oversized merge refused");
            assert(Number(refused.currentSizeBytes) > 0 && Number(refused.currentSizeBytes) < 100, "reports the CURRENT row size");

            const [row] = await catalog.getCanvasLive(sessionId);
            assertEqual(row.seq, 1, "no seq minted on refusal");
            assertEqual(JSON.stringify(row.payload), JSON.stringify({ small: true }));

            // First write oversized: refused with no current row to report.
            const virgin = await catalog.upsertCanvasLiveTick(sessionId, 3, {
                data: { huge: "x".repeat(40_000) },
            }, "w");
            assert(virgin.refused === true);
            assertEqual(virgin.currentSizeBytes, null);
            assertEqual((await catalog.getCanvasLive(sessionId)).filter((r) => r.slot === 3).length, 0);
        });
    });

    it("a doc pointer resets the data mirror; the next tick starts fresh", { timeout: TIMEOUT }, async () => {
        await withCatalog(async ({ catalog }) => {
            const sessionId = await freshSession(catalog);
            await catalog.upsertCanvasLiveTick(sessionId, 1, { data: { old: "page state" } }, "w");
            const doc = await catalog.upsertCanvasLiveDoc(sessionId, 1, { rev: 4, sha: "abc123" }, "w");
            assertEqual(doc.seq, 2);

            let [row] = await catalog.getCanvasLive(sessionId);
            assertEqual(row.docRev, 4);
            assertEqual(row.docSha, "abc123");
            assertEqual(JSON.stringify(row.payload), "{}", "redraw resets the mirror");

            await catalog.upsertCanvasLiveTick(sessionId, 1, { patch: { fresh: 1 } }, "w");
            [row] = await catalog.getCanvasLive(sessionId);
            assertEqual(row.docRev, 4, "tick leaves the doc pointer alone");
            assertEqual(JSON.stringify(row.payload), JSON.stringify({ fresh: 1 }));
        });
    });

    it("every write NOTIFYs with schema, session, slot, seq, kind", { timeout: TIMEOUT }, async () => {
        await withCatalog(async ({ catalog, env }) => {
            const sessionId = await freshSession(catalog);
            const listener = new pg.Client({ connectionString: env.store });
            await listener.connect();
            try {
                const received = [];
                listener.on("notification", (msg) => {
                    try { received.push(JSON.parse(msg.payload)); } catch { /* ignore */ }
                });
                await listener.query("LISTEN pilotswarm_canvas_live");

                await catalog.upsertCanvasLiveTick(sessionId, 1, { data: { hello: 1 } }, "w");
                await catalog.upsertCanvasLiveDoc(sessionId, 1, { rev: 1, sha: "s" }, "w");

                const deadline = Date.now() + 5_000;
                while (received.length < 2 && Date.now() < deadline) {
                    await new Promise((r) => setTimeout(r, 50));
                }
                assertEqual(received.length, 2, "both writes pinged the channel");
                const mine = received.filter((n) => n.sessionId === sessionId);
                assertEqual(mine.length, 2);
                assertEqual(mine[0].kind, "data");
                assertEqual(mine[0].slot, 1);
                assertEqual(mine[0].seq, 1);
                assertEqual(mine[0].schema, env.cmsSchema, "payload names the schema so suites never cross-talk");
                assertEqual(mine[1].kind, "doc");
                assertEqual(mine[1].seq, 2);
            } finally {
                await listener.end();
            }
        });
    });

    it("a refused write does NOT notify", { timeout: TIMEOUT }, async () => {
        await withCatalog(async ({ catalog, env }) => {
            const sessionId = await freshSession(catalog);
            const listener = new pg.Client({ connectionString: env.store });
            await listener.connect();
            try {
                const received = [];
                listener.on("notification", (msg) => {
                    try {
                        const parsed = JSON.parse(msg.payload);
                        if (parsed.sessionId === sessionId) received.push(parsed);
                    } catch { /* ignore */ }
                });
                await listener.query("LISTEN pilotswarm_canvas_live");
                const refused = await catalog.upsertCanvasLiveTick(sessionId, 1, { data: { big: "x".repeat(40_000) } }, "w");
                assert(refused.refused === true);
                await new Promise((r) => setTimeout(r, 400));
                assertEqual(received.length, 0, "silence on refusal — viewers never hear about a write that did not happen");
            } finally {
                await listener.end();
            }
        });
    });

    it("deleting the session cascades the plane row away", { timeout: TIMEOUT }, async () => {
        await withCatalog(async ({ catalog, env }) => {
            const sessionId = await freshSession(catalog);
            await catalog.upsertCanvasLiveTick(sessionId, 1, { data: { a: 1 } }, "w");
            const raw = new pg.Client({ connectionString: env.store });
            await raw.connect();
            try {
                await raw.query(`DELETE FROM "${env.cmsSchema}".sessions WHERE session_id = $1`, [sessionId]);
            } finally {
                await raw.end();
            }
            assertEqual((await catalog.getCanvasLive(sessionId)).length, 0);
        });
    });
});

describe("canvas plane notify carries the patch when it fits", () => {
    it("small patches ride the ping; PUTs and big patches send a pointer only", { timeout: TIMEOUT }, async () => {
        await withCatalog(async ({ catalog, env }) => {
            const sessionId = await freshSession(catalog);
            const listener = new pg.Client({ connectionString: env.store });
            await listener.connect();
            try {
                const received = [];
                listener.on("notification", (msg) => {
                    try {
                        const parsed = JSON.parse(msg.payload);
                        if (parsed.sessionId === sessionId) received.push(parsed);
                    } catch { /* ignore */ }
                });
                await listener.query("LISTEN pilotswarm_canvas_live");

                await catalog.upsertCanvasLiveTick(sessionId, 1, { data: { base: true } }, "w");
                await catalog.upsertCanvasLiveTick(sessionId, 1, { patch: { gauge: 91 } }, "w");
                await catalog.upsertCanvasLiveTick(sessionId, 1, { patch: { big: "x".repeat(10_000) } }, "w");

                const deadline = Date.now() + 5_000;
                while (received.length < 3 && Date.now() < deadline) {
                    await new Promise((r) => setTimeout(r, 50));
                }
                assertEqual(received.length, 3);
                assertEqual(received[0].patch, undefined, "a PUT never claims to be a patch");
                assertEqual(JSON.stringify(received[1].patch), JSON.stringify({ gauge: 91 }), "small patch rides the ping verbatim");
                assertEqual(received[2].patch, undefined, "oversized patch degrades to a pointer — the relay snapshots instead");
                assertEqual(received[2].seq, 3, "the pointer still carries the seq for gap detection");
            } finally {
                await listener.end();
            }
        });
    });
});

describe("atomic draw-rev minting (multi-writer)", () => {
    it("20 concurrent mints yield 20 unique consecutive revs", { timeout: TIMEOUT }, async () => {
        await withCatalog(async ({ catalog }) => {
            const sessionId = await freshSession(catalog);
            const revs = await Promise.all(Array.from({ length: 20 }, () =>
                catalog.mintCanvasRev(sessionId, 1, 0)));
            const sorted = [...revs].sort((a, b) => a - b);
            assertEqual(new Set(revs).size, 20, "no two writers share a rev");
            assertEqual(sorted[0], 1);
            assertEqual(sorted[19], 20);
        });
    });

    it("the seed floors legacy sessions whose cache row never landed", { timeout: TIMEOUT }, async () => {
        await withCatalog(async ({ catalog }) => {
            const sessionId = await freshSession(catalog);
            // No 0045 row exists; the event scan says rev 12 — the mint must
            // never hand out rev 1 over a live rev-12 canvas.
            assertEqual(await catalog.mintCanvasRev(sessionId, 1, 12), 13);
            // And an existing row beats a stale seed.
            assertEqual(await catalog.mintCanvasRev(sessionId, 1, 3), 14);
        });
    });
});

describe("notify envelope gate (the dense-key band the old gate broke on)", () => {
    it("a patch just under 7000 compact bytes ticks successfully; the ping degrades to a pointer if the envelope would burst", { timeout: TIMEOUT }, async () => {
        await withCatalog(async ({ catalog, env }) => {
            const sessionId = await freshSession(catalog);
            const listener = new pg.Client({ connectionString: env.store });
            await listener.connect();
            try {
                const received = [];
                listener.on("notification", (msg) => {
                    try {
                        const parsed = JSON.parse(msg.payload);
                        if (parsed.sessionId === sessionId) received.push(parsed);
                    } catch { /* ignore */ }
                });
                await listener.query("LISTEN pilotswarm_canvas_live");

                // ~640 dense keys ≈ 6.9 KB compact — passes the OLD raw-text
                // gate but the jsonb re-render + envelope tops 8000, which
                // used to hard-error pg_notify and ROLL BACK the tick.
                const dense = {};
                for (let i = 0; i < 640; i++) dense[`k${String(i).padStart(4, "0")}`] = i;
                const out = await catalog.upsertCanvasLiveTick(sessionId, 1, { patch: dense }, "w");
                assert(!out.refused, "the tick must succeed");
                assertEqual(out.seq, 1, "row written, not rolled back");

                const deadline = Date.now() + 5_000;
                while (received.length < 1 && Date.now() < deadline) {
                    await new Promise((r) => setTimeout(r, 50));
                }
                assertEqual(received.length, 1, "the ping still fired");
                assertEqual(received[0].seq, 1);
                // Whether it carries the patch depends on the FINAL envelope
                // size — the invariant is: ping present, row correct, and if
                // the patch rode along it must be the exact patch.
                if (received[0].patch) {
                    assertEqual(Object.keys(received[0].patch).length, 640);
                }
                const [row] = await catalog.getCanvasLive(sessionId);
                assertEqual(Object.keys(row.payload).length, 640, "all keys merged into the row");
            } finally {
                await listener.end();
            }
        });
    });
});

describe("canvas share links (migration 0048)", () => {
    it("mint, rotate (old token dies instantly), remove, cascade", { timeout: TIMEOUT }, async () => {
        await withCatalog(async ({ catalog, env }) => {
            const sessionId = await freshSession(catalog);
            assertEqual((await catalog.getCanvasShareLinkInfo(sessionId, 1)).exists, false);

            await catalog.setCanvasShareLink(sessionId, 1, "hash-A", "owner-1");
            assertEqual((await catalog.getCanvasShareLinkInfo(sessionId, 1)).exists, true);
            assertEqual(JSON.stringify(await catalog.resolveCanvasShareToken("hash-A")), JSON.stringify({ sessionId, slot: 1 }));

            // Rotate: ONE live token — the old hash stops resolving the
            // moment the new row lands.
            await catalog.setCanvasShareLink(sessionId, 1, "hash-B", "owner-1");
            assertEqual(await catalog.resolveCanvasShareToken("hash-A"), null, "reset kills the old link");
            assertEqual(JSON.stringify(await catalog.resolveCanvasShareToken("hash-B")), JSON.stringify({ sessionId, slot: 1 }));

            // Per-slot independence.
            await catalog.setCanvasShareLink(sessionId, 2, "hash-C", "owner-1");
            assertEqual((await catalog.resolveCanvasShareToken("hash-C")).slot, 2);
            assertEqual((await catalog.resolveCanvasShareToken("hash-B")).slot, 1);

            assertEqual(await catalog.removeCanvasShareLink(sessionId, 1), true);
            assertEqual(await catalog.resolveCanvasShareToken("hash-B"), null, "removed link resolves nothing");
            assertEqual(await catalog.removeCanvasShareLink(sessionId, 1), false, "double remove is honest");

            // Session deletion cascades the links away.
            const raw = new pg.Client({ connectionString: env.store });
            await raw.connect();
            try {
                await raw.query(`DELETE FROM "${env.cmsSchema}".sessions WHERE session_id = $1`, [sessionId]);
            } finally {
                await raw.end();
            }
            assertEqual(await catalog.resolveCanvasShareToken("hash-C"), null, "deleted session leaves no live links");
        });
    });

    it("empty and unknown hashes resolve to nothing", { timeout: TIMEOUT }, async () => {
        await withCatalog(async ({ catalog }) => {
            assertEqual(await catalog.resolveCanvasShareToken(""), null);
            assertEqual(await catalog.resolveCanvasShareToken("no-such-hash"), null);
        });
    });
});
