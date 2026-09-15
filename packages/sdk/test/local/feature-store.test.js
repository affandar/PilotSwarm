import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PgSessionCatalog } from "../../src/cms.ts";
import { FEATURE_FLAGS } from "../../src/feature-flags.ts";
import { FeatureFlagCache } from "../../src/feature-flag-cache.ts";

const key = "copilot.native_tasks";
const schema = `ps_test_features_${randomUUID().replaceAll("-", "")}`;
const url = process.env.PS_TEST_DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/pilotswarm";
const pool = new pg.Pool({ connectionString: url, max: 3 });
const alice = { principal: { provider: "test", subject: "alice" }, isAdmin: false };
const bob = { principal: { provider: "test", subject: "bob" }, isAdmin: false };
const admin = { principal: { provider: "test", subject: "admin" }, isAdmin: true };
let catalog, store, aliceId, bobId;
const input = (expectedRevision = "1", extra = {}) => ({ featureKey: key, expectedRevision, requestId: randomUUID(), enabled: true, ...extra });
const flag = view => view.flags.find(candidate => candidate.featureKey === key);
const featureRevision = rows => rows.find(candidate => candidate.featureKey === key);

beforeAll(async () => {
    catalog = await PgSessionCatalog.create(url, schema); await catalog.initialize(); store = catalog.features;
    for (const viewer of [alice, bob, admin]) await catalog.setUserProfileSettings(viewer.principal, {});
    aliceId = (await store.read(alice, "user")).userId; bobId = (await store.read(bob, "user")).userId;
});
beforeEach(async () => {
    await pool.query(`DELETE FROM "${schema}".feature_flag_settings`);
    await pool.query(`UPDATE "${schema}".feature_flags SET revision = 1`);
    await pool.query(`DELETE FROM "${schema}".authz_audit WHERE action LIKE 'feature_flag.%'`);
});
afterAll(async () => { await catalog?.close(); await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end(); });

describe("feature catalog and scoped settings in PostgreSQL", () => {
    it("publishes exactly the code catalog without altering package revisions", async () => {
        const definitions = (await store.snapshot([key])).definitions;
        expect(definitions).toEqual([{ featureKey: key, ...FEATURE_FLAGS[key], revision: "1" }]);
        const before = await catalog.agentRegistryEpoch();
        await store.mutate(admin, "cluster", input("1", { allowUserOverride: true }));
        expect(await catalog.agentRegistryEpoch()).toBe(before);
        const { rows } = await pool.query(`SELECT * FROM "${schema}".fleet_directives WHERE domain = 'feature-flags'`);
        expect(rows).toEqual([]);
    });
    it("enforces self/admin access and preserves ignored user preferences", async () => {
        await expect(store.read({ principal: null, isAdmin: true }, "cluster")).rejects.toMatchObject({ code: "FEATURE_FORBIDDEN" });
        await expect(store.mutate(alice, "cluster", input("1", { allowUserOverride: true }))).rejects.toMatchObject({ status: 403 });
        await expect(store.read(alice, "user", bobId)).rejects.toMatchObject({ status: 403 });
        await expect(store.mutate(alice, "user", input(), false, bobId)).rejects.toMatchObject({ status: 403 });
        await expect(store.changes(alice)).rejects.toMatchObject({ status: 403 });
        await store.mutate(alice, "user", input());
        let mine = flag(await store.read(alice, "user"));
        expect(mine).toMatchObject({ effective: true, userOverrideIgnored: false, user: { enabled: true } });
        await store.mutate(admin, "cluster", input("2", { enabled: false, allowUserOverride: true }));
        expect(flag(await store.read(alice, "user")).effective).toBe(true);
        expect(flag(await store.read(bob, "user")).effective).toBe(false);
        expect(flag(await store.read(admin, "user", aliceId)).effective).toBe(true);
        await store.mutate(admin, "cluster", input("3", { enabled: false, allowUserOverride: false }));
        expect(flag(await store.read(alice, "user"))).toMatchObject({ effective: false, user: { enabled: true }, userOverrideIgnored: true });
        expect(flag(await store.read(bob, "user")).user).toBeNull();
    });
    it("serializes concurrent edits and recognizes identical retries", async () => {
        const a = input("1", { allowUserOverride: true }); const b = input("1", { enabled: false, allowUserOverride: false });
        const results = await Promise.allSettled([store.mutate(admin, "cluster", a), store.mutate(admin, "cluster", b)]);
        expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
        expect(results.find(r => r.status === "rejected").reason).toMatchObject({ status: 409 });
        const winner = results[0].status === "fulfilled" ? a : b;
        const result = results.find(r => r.status === "fulfilled").value;
        expect(await store.mutate(admin, "cluster", winner)).toEqual(result);
        await expect(store.mutate(admin, "cluster", { ...winner, enabled: !winner.enabled })).rejects.toMatchObject({ status: 409 });
        expect(featureRevision(await store.revisions())).toEqual({ featureKey: key, revision: "2" });
        expect(await store.changes(admin)).toHaveLength(1);
    });
    it("coalesces simultaneous identical requests and scopes retry IDs to the actor", async () => {
        const edit = input();
        const [first, retry] = await Promise.all([store.mutate(alice, "user", edit), store.mutate(alice, "user", edit)]);
        expect(first).toEqual(retry);
        expect(await store.changes(admin)).toHaveLength(1);
        const secondActor = await store.mutate(bob, "user", { ...edit, expectedRevision: "2", enabled: false });
        expect(secondActor).toMatchObject({ userId: bobId, revision: "3" });
        expect(await store.mutate(alice, "user", edit)).toEqual(first);
        expect(await store.changes(admin)).toHaveLength(2);
    });
    it("preserves a setting ID when updated, while unset and recreation allocate a new row", async () => {
        const first = await store.mutate(alice, "user", input());
        const updated = await store.mutate(alice, "user", input("2", { enabled: false }));
        expect(updated.setting.settingId).toBe(first.setting.settingId);
        expect(updated.setting).toMatchObject({ enabled: false, revision: "3" });
        await store.mutate(alice, "user", { featureKey: key, expectedRevision: "3", requestId: randomUUID() }, true);
        const recreated = await store.mutate(alice, "user", input("4"));
        expect(recreated.setting.settingId).not.toBe(first.setting.settingId);
    });
    it("keeps the feature user directory admin-only and searches stable user IDs", async () => {
        await expect(store.users(alice)).rejects.toMatchObject({ status: 403 });
        await expect(store.users({ principal: null, isAdmin: true })).rejects.toMatchObject({ status: 403 });
        expect(await store.users(admin, "alice")).toEqual([expect.objectContaining({ userId: aliceId, provider: "test", subject: "alice" })]);
    });
    it("unset bumps the feature revision and prevents stale recreation after receipt expiry", async () => {
        const original = input(); await store.mutate(alice, "user", original);
        const unset = { featureKey: key, expectedRevision: "2", requestId: randomUUID() };
        const cleared = await store.mutate(alice, "user", unset, true);
        expect(cleared).toMatchObject({ revision: "3", setting: null });
        expect(await store.mutate(alice, "user", unset, true)).toEqual(cleared);
        expect(flag(await store.read(alice, "user")).user).toBeNull();
        await pool.query(`DELETE FROM "${schema}".authz_audit WHERE action LIKE 'feature_flag.%'`);
        await expect(store.mutate(alice, "user", original)).rejects.toMatchObject({ status: 409 });
    });
    it("rolls back settings and revision if the audit cannot be written", async () => {
        await pool.query(`CREATE FUNCTION "${schema}".reject_feature_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit unavailable'; END; $$`);
        await pool.query(`CREATE TRIGGER reject_feature_audit BEFORE INSERT ON "${schema}".authz_audit FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_feature_audit()`);
        try {
            await expect(store.mutate(alice, "user", input())).rejects.toThrow(/audit unavailable/);
            expect(featureRevision(await store.revisions())).toEqual({ featureKey: key, revision: "1" });
            expect(flag(await store.read(alice, "user")).user).toBeNull();
        } finally { await pool.query(`DROP TRIGGER reject_feature_audit ON "${schema}".authz_audit`); }
    });
    it("converges real worker caches through user/cluster changes and reset", async () => {
        const a = new FeatureFlagCache(store); const b = new FeatureFlagCache(store);
        const allowed = cache => cache.resolve(key, alice.principal, { fallback: false }).enabled;
        await Promise.all([a.pollRevisionsAndRefresh(), b.pollRevisionsAndRefresh()]); expect(allowed(a)).toBe(false);
        await store.mutate(admin, "cluster", input("1", { enabled: false, allowUserOverride: true }));
        await store.mutate(alice, "user", input("2"));
        await a.pollRevisionsAndRefresh(); expect(allowed(a)).toBe(true); expect(allowed(b)).toBe(false);
        await b.pollRevisionsAndRefresh(); expect(allowed(b)).toBe(true);
        await store.mutate(alice, "user", input("3", { enabled: false }));
        await a.pollRevisionsAndRefresh(); expect(allowed(a)).toBe(false);
        await store.mutate(alice, "user", input("4")); await a.pollRevisionsAndRefresh(); expect(allowed(a)).toBe(true);
        await store.mutate(admin, "cluster", { featureKey: key, expectedRevision: "5", requestId: randomUUID() }, true);
        await Promise.all([a.pollRevisionsAndRefresh(), b.pollRevisionsAndRefresh()]); expect(allowed(a)).toBe(true); expect(allowed(b)).toBe(true);
        await Promise.all([a.stop(), b.stop()]);
    });
    it("adopts an email placeholder preference at first sign-in and refreshes owner caches", async () => {
        const email = `ghost-${randomUUID()}@example.test`;
        const ghost = { principal: { provider: "test", subject: email }, isAdmin: false };
        const real = { principal: { provider: "test", subject: randomUUID() }, isAdmin: false };
        await catalog.setUserProfileSettings(ghost.principal, {});
        const ghostId = (await store.read(ghost, "user")).userId;
        await store.mutate(admin, "cluster", input("1", { enabled: false, allowUserOverride: true }));
        const preference = await store.mutate(admin, "user", input("2"), false, ghostId);
        const caches = [new FeatureFlagCache(store), new FeatureFlagCache(store)];
        await Promise.all(caches.map(cache => cache.pollRevisionsAndRefresh()));
        expect(caches[0].resolve(key, ghost.principal, { required: true }).enabled).toBe(true);
        const epoch = await catalog.agentRegistryEpoch();
        const { rows } = await pool.query(`SELECT "${schema}".cms_register_user($1, $2, $3, $4) AS id`,
            [real.principal.provider, real.principal.subject, email, "Real user"]);
        const realId = Number(rows[0].id);
        expect(realId).not.toBe(ghostId);
        expect(flag(await store.read(real, "user"))).toMatchObject({ effective: true,
            revision: "4", user: { settingId: preference.setting.settingId, userId: realId, revision: "4" } });
        expect((await pool.query(`SELECT user_id FROM "${schema}".users WHERE user_id = $1`, [ghostId])).rows).toEqual([]);
        await Promise.all(caches.map(cache => cache.pollRevisionsAndRefresh()));
        for (const cache of caches) {
            expect(cache.resolve(key, real.principal, { required: true })).toMatchObject({ enabled: true, revision: "4" });
            expect(cache.resolve(key, ghost.principal, { required: true }).enabled).toBe(false);
        }
        expect(await catalog.agentRegistryEpoch()).toBe(epoch);
        expect((await store.changes(admin))[0]).toMatchObject({ action: "feature_flag.user_adopt",
            details: { userId: realId, previousUserId: ghostId, revision: "4" } });
        await Promise.all(caches.map(cache => cache.stop()));
    });
    it("keeps the real user's explicit false when adopting a conflicting ghost preference", async () => {
        const email = `collision-${randomUUID()}@example.test`;
        const ghost = { principal: { provider: "test", subject: email }, isAdmin: false };
        const real = { principal: { provider: "test", subject: randomUUID() }, isAdmin: false };
        for (const viewer of [ghost, real]) await catalog.setUserProfileSettings(viewer.principal, {});
        const ghostId = (await store.read(ghost, "user")).userId;
        const realId = (await store.read(real, "user")).userId;
        await store.mutate(admin, "cluster", input("1", { enabled: false, allowUserOverride: true }));
        await store.mutate(admin, "user", input("2"), false, ghostId);
        const own = await store.mutate(real, "user", input("3", { enabled: false }));
        const cache = new FeatureFlagCache(store); await cache.pollRevisionsAndRefresh();
        await pool.query(`SELECT "${schema}".cms_register_user($1, $2, $3, $4)`,
            [real.principal.provider, real.principal.subject, email, "Real user"]);
        expect(flag(await store.read(real, "user"))).toMatchObject({ effective: false, revision: "5", user: own.setting });
        await cache.pollRevisionsAndRefresh();
        expect(cache.resolve(key, ghost.principal, { required: true }).enabled).toBe(false);
        expect(cache.resolve(key, real.principal, { required: true })).toMatchObject({ enabled: false, revision: "5" });
        expect((await pool.query(`SELECT user_id FROM "${schema}".feature_flag_settings WHERE scope = 'user'`)).rows)
            .toEqual([{ user_id: String(realId) }]);
        await cache.stop();
    });
    it("serializes ghost adoption with an in-flight preference write before deleting the user", async () => {
        const email = `concurrent-${randomUUID()}@example.test`;
        const ghost = { principal: { provider: "test", subject: email }, isAdmin: false };
        const real = { provider: "test", subject: randomUUID() };
        await catalog.setUserProfileSettings(ghost.principal, {});
        const ghostId = (await store.read(ghost, "user")).userId;
        await store.mutate(admin, "cluster", input("1", { enabled: false, allowUserOverride: true }));
        const writer = await pool.connect(); const registrar = await pool.connect();
        let registering;
        try {
            await writer.query("BEGIN");
            await writer.query(`SELECT "${schema}".cms_feature_mutate($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [admin.principal.provider, admin.principal.subject, true, "user", ghostId, key, true, null, false, "2", randomUUID()]);
            const pid = (await registrar.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
            registering = registrar.query(`SELECT "${schema}".cms_register_user($1, $2, $3, $4) AS id`,
                [real.provider, real.subject, email, "Real user"]);
            // Observe the actual lock, not elapsed time, before releasing the edit.
            let blocked = false;
            for (let attempt = 0; attempt < 100; attempt++) {
                const state = (await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1", [pid])).rows[0];
                if (state?.wait_event_type === "Lock") { blocked = true; break; }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            expect(blocked).toBe(true);
            await writer.query("COMMIT");
            const { rows } = await registering;
            expect(flag(await store.read({ principal: real, isAdmin: false }, "user")))
                .toMatchObject({ effective: true, revision: "4", user: { userId: Number(rows[0].id) } });
        } finally {
            await writer.query("ROLLBACK");
            await registering?.catch(() => {});
            writer.release(); registrar.release();
        }
    });
    it("rejects malformed scopes, values, unknown keys, and database duplicates", async () => {
        await expect(store.mutate(admin, "user", input("1", { featureKey: "typo" }))).rejects.toMatchObject({ status: 404 });
        await expect(store.mutate(alice, "user", input("1", { allowUserOverride: true }))).rejects.toMatchObject({ status: 400 });
        await expect(store.mutate(admin, "cluster", input("1", { enabled: "false", allowUserOverride: false }))).rejects.toMatchObject({ status: 400 });
        await store.mutate(admin, "cluster", input("1", { allowUserOverride: true }));
        await expect(pool.query(`INSERT INTO "${schema}".feature_flag_settings(feature_key, scope, enabled, allow_user_override, revision, updated_by)
            VALUES ($1, 'cluster', true, false, 1, 'test')`, [key])).rejects.toMatchObject({ code: "23505" });
        await expect(pool.query(`INSERT INTO "${schema}".feature_flag_settings(feature_key, scope, user_id, enabled, allow_user_override, revision, updated_by)
            VALUES ($1, 'user', $2, true, true, 1, 'test')`, [key, aliceId])).rejects.toMatchObject({ code: "23514" });
    });
});
