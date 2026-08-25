/**
 * The canvas KV store against a real Postgres (migration 0064) — procs +
 * chokepoint end to end, no LLM turns.
 *
 * Covers: CAS (claim, rev mismatch), tombstones, quotas, prefix paging, the
 * policy × manifest × relation matrix through real session shares, the
 * req/* status cap, author binding, and the NOTIFY the live path rides on.
 *
 * Run: npx vitest run test/local/canvas-kv.test.js
 */

import { describe, it } from "vitest";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { readCanvasKv, writeCanvasKv, CANVAS_KV_VALUE_MAX_BYTES } from "../../dist/canvas-kv.js";

const TIMEOUT = 120_000;
const getEnv = useSuiteEnv(import.meta.url);

const ALICE = { provider: "test", subject: "kv-alice", email: "alice@test", displayName: "Alice" };
const BOB = { provider: "test", subject: "kv-bob", email: "bob@test", displayName: "Bob" };
const CAROL = { provider: "test", subject: "kv-carol", email: "carol@test", displayName: "Carol" };
const DAVE = { provider: "test", subject: "kv-dave", email: "dave@test", displayName: "Dave" };
const user = (p, isAdmin = false) => ({ kind: "user", provider: p.provider, subject: p.subject, isAdmin, label: p.displayName });
const put = (key, value, extra = {}) => ({ op: "put", key, value, ...extra });

async function setup(catalog, env) {
    const sid = `kv-${env.runId}`;
    await catalog.createSession(sid, { model: "m", owner: ALICE });
    await catalog.grantSessionShare(sid, BOB, "read");
    await catalog.grantSessionShare(sid, CAROL, "write");
    return sid;
}

describe("canvas KV store", () => {
    it("CAS, tombstones, paging and quotas at the proc level", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const sid = await setup(catalog, env);
            const limits = { maxKeys: 3, maxBytes: 100_000, maxValueBytes: 200 };
            const env1 = { v: 1, by: { kind: "user", id: "x", label: null }, at: "t" };

            let r = await catalog.canvasKvWrite(sid, 1, "app/a", env1, 0, limits);
            assertEqual(r.status, "written"); assertEqual(r.rev, 1);
            r = await catalog.canvasKvWrite(sid, 1, "app/a", env1, 0, limits);
            assertEqual(r.status, "conflict", "a claim on a live key conflicts");
            r = await catalog.canvasKvWrite(sid, 1, "app/a", env1, 1, limits);
            assertEqual(r.status, "written"); assertEqual(r.rev, 2);
            r = await catalog.canvasKvWrite(sid, 1, "app/a", env1, 1, limits);
            assertEqual(r.status, "conflict", "stale rev"); assertEqual(r.rev, 2, "the current rev is reported");
            r = await catalog.canvasKvWrite(sid, 1, "app/a", env1, null, limits);
            assertEqual(r.status, "written"); assertEqual(r.rev, 3, "no CAS: last writer wins");

            // Tombstone: the key vanishes from reads, the rev still advances,
            // and a later claim (ifMatch 0) resurrects it.
            r = await catalog.canvasKvWrite(sid, 1, "app/a", null, null, limits);
            assertEqual(r.status, "deleted"); assertEqual(r.rev, 4);
            assertEqual(await catalog.canvasKvGet(sid, 1, "app/a"), null);
            r = await catalog.canvasKvWrite(sid, 1, "app/a", null, null, limits);
            assertEqual(r.status, "not_found", "deleting a tombstone is not_found");
            r = await catalog.canvasKvWrite(sid, 1, "app/a", env1, 0, limits);
            assertEqual(r.status, "written"); assertEqual(r.rev, 5, "resurrected, rev continues");

            // Quotas: 3 keys max (other keys counted, this key excluded), 200 bytes per value.
            await catalog.canvasKvWrite(sid, 1, "app/b", env1, null, limits);
            await catalog.canvasKvWrite(sid, 1, "app/c", env1, null, limits);
            r = await catalog.canvasKvWrite(sid, 1, "app/d", env1, null, limits);
            assertEqual(r.status, "quota_keys");
            r = await catalog.canvasKvWrite(sid, 1, "app/c", env1, null, limits);
            assertEqual(r.status, "written", "rewriting an existing key is not a new key");
            r = await catalog.canvasKvWrite(sid, 1, "app/c", { ...env1, v: "x".repeat(300) }, null, limits);
            assertEqual(r.status, "too_large");
            r = await catalog.canvasKvWrite(sid, 1, "app/c", env1, null, { ...limits, maxBytes: 100 });
            assertEqual(r.status, "quota_bytes");
            const stats = await catalog.canvasKvStats(sid, 1);
            assertEqual(stats.keys, 3);

            // Paging by prefix and cursor; slots are independent.
            await catalog.canvasKvWrite(sid, 2, "app/z", env1, null, limits);
            const page1 = await catalog.canvasKvList(sid, 1, "app/", 2, null);
            assertEqual(page1.map((x) => x.key).join(","), "app/a,app/b");
            const page2 = await catalog.canvasKvList(sid, 1, "app/", 2, "app/b");
            assertEqual(page2.map((x) => x.key).join(","), "app/c");
            assertEqual((await catalog.canvasKvList(sid, 2, null, 10, null)).length, 1);
            assertEqual((await catalog.canvasKvList(sid, 1, "req/", 10, null)).length, 0);
        } finally {
            await catalog.close?.();
        }
    });

    it("policy × manifest × relation through real shares; the req/* cap; author binding", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        try {
            const sid = await setup(catalog, env);
            const store = catalog;

            // Default policy (owner), no manifest: only alice, carol (write share) and the agent write.
            let out = await writeCanvasKv(store, sid, 1, user(ALICE), [put("app/owner", 1), put("cfg/policy", { x: 1 })]);
            assert(out.results.every((r) => r.ok), JSON.stringify(out.results));
            out = await writeCanvasKv(store, sid, 1, user(BOB), [put("app/bob", 1)]);
            assertEqual(out.results[0].code, "FORBIDDEN");
            out = await writeCanvasKv(store, sid, 1, user(CAROL), [put("app/carol", 1)]);
            assertEqual(out.results[0].ok, true, "session write ⇒ canvas write");
            out = await writeCanvasKv(store, sid, 1, { kind: "agent", sessionId: sid }, [put("evt/1", { note: "hi" })]);
            assertEqual(out.results[0].ok, true);
            let failed = false;
            try { await readCanvasKv(store, sid, 1, user(DAVE)); } catch (e) { failed = e.code === "FORBIDDEN"; }
            assert(failed, "a stranger cannot even read a private session's canvas");

            // Flip both switches: policy readers + manifest kv.write viewers (shared app/task/*).
            await catalog.setCanvasKvAccess(sid, 1, "readers");
            await catalog.setCanvasKvManifest(sid, 1, { write: "viewers", shared: ["app/task/*"] });
            const bobView = await readCanvasKv(store, sid, 1, user(BOB));
            assertEqual(bobView.me.relation, "collaborator"); assertEqual(bobView.me.canWrite, true); assertEqual(bobView.policy, "readers");

            out = await writeCanvasKv(store, sid, 1, user(BOB), [
                put("app/bob", { text: "mine" }),
                put("app/owner", { text: "hijack" }),        // alice's row, not shared → refused
                put("app/task/1", { text: "shared" }),        // shared glob, new row
                put("cfg/role/bob", "admin"),                 // locked
                put("req/1", { op: "expand", status: "queued" }), // capped
                put("ui/test/kv-bob/presence", { here: true }),
                put("ui/test/kv-alice/presence", { here: true }),
            ]);
            assertEqual(out.results.map((r) => `${r.key}:${r.ok ? "ok" : r.code}${r.capped ? "+capped" : ""}`).join(" "),
                "app/bob:ok app/owner:FORBIDDEN app/task/1:ok cfg/role/bob:FORBIDDEN req/1:ok+capped ui/test/kv-bob/presence:ok ui/test/kv-alice/presence:FORBIDDEN");
            const req = await readCanvasKv(store, sid, 1, user(ALICE), { key: "req/1" });
            assertEqual(req.entries[0].v.status, "suggested", "stored as suggested, whatever the page sent");
            assertEqual(req.entries[0].by.id, "test/kv-bob");

            // The owner promotes; bob cannot un-land or overwrite alice's shared-task edit.
            out = await writeCanvasKv(store, sid, 1, user(ALICE), [put("req/1", { op: "expand", status: "queued" }), put("app/task/1", { text: "owner edit" })]);
            assert(out.results.every((r) => r.ok && !r.capped));
            out = await writeCanvasKv(store, sid, 1, user(BOB), [put("app/task/1", { text: "bob again" })]);
            assertEqual(out.results[0].ok, true, "shared prefix: bob may overwrite alice's row");
            out = await writeCanvasKv(store, sid, 1, user(BOB), [{ op: "delete", key: "app/owner" }]);
            assertEqual(out.results[0].code, "FORBIDDEN", "author-bound delete");

            // Demote the policy: bob is read-only again, and his existing rows stay.
            await catalog.setCanvasKvAccess(sid, 1, "owner");
            out = await writeCanvasKv(store, sid, 1, user(BOB), [put("app/bob", 2)]);
            assertEqual(out.results[0].code, "FORBIDDEN");
            const still = await readCanvasKv(store, sid, 1, user(BOB), { key: "app/bob" });
            assertEqual(still.entries[0].v.text, "mine");

            // Value cap through the chokepoint's limits.
            out = await writeCanvasKv(store, sid, 1, user(ALICE), [put("app/big", "x".repeat(CANVAS_KV_VALUE_MAX_BYTES))]);
            assertEqual(out.results[0].code, "TOO_LARGE");
        } finally {
            await catalog.close?.();
        }
    });

    it("every write fires one NOTIFY on the canvas plane channel, kind kv, with the value when small", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const catalog = await createCatalog(env);
        const listener = new pg.Client({ connectionString: env.store });
        try {
            const sid = await setup(catalog, env);
            await listener.connect();
            await listener.query("LISTEN pilotswarm_canvas_live");
            const pings = [];
            listener.on("notification", (msg) => { try { const p = JSON.parse(msg.payload); if (p.schema === env.cmsSchema && p.sessionId === sid) pings.push(p); } catch { /* not ours */ } });

            await writeCanvasKv(catalog, sid, 1, user(ALICE), [put("app/small", { n: 1 })]);
            await writeCanvasKv(catalog, sid, 1, user(ALICE), [put("app/large", "x".repeat(9000))]);
            await writeCanvasKv(catalog, sid, 1, user(ALICE), [{ op: "delete", key: "app/small" }]);
            const deadline = Date.now() + 5000;
            while (pings.length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
            assertEqual(pings.length, 3, `expected 3 pings, got ${JSON.stringify(pings)}`);
            assertEqual(pings[0].kind, "kv"); assertEqual(pings[0].key, "app/small"); assertEqual(pings[0].op, "put");
            assertEqual(pings[0].value.v.n, 1, "a small envelope rides the ping");
            assertEqual(pings[0].value.by.id, "test/kv-alice");
            assertEqual(pings[1].key, "app/large"); assertEqual(pings[1].value, undefined, "a big envelope ships a pointer");
            assertEqual(pings[2].op, "delete"); assertEqual(pings[2].rev, 2);
        } finally {
            await listener.end().catch(() => {});
            await catalog.close?.();
        }
    });
});
