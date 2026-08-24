// Migration 0061 regressions (2026-08-24 campaign).
//
// 1. A recycled provider NAME must not inherit the previous holder's spend
//    in ANY section of the usage report. The bound existed on `daily` only,
//    so one response contradicted itself.
// 2. cms_provider_next_turn_index seeds a restarted system session's fresh
//    orchestration past the ledger rows its earlier lifetimes wrote —
//    without it, settle's exactly-once claim silently dropped the spend.
//
// Verified red against the pre-0061 schema (bound absent, function absent).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { runCmsMigrations } from "../../src/cms-migrator.ts";

const DATABASE_URL = process.env.PS_TEST_DATABASE_URL
    || process.env.TEST_DATABASE_URL
    || "postgresql://postgres:postgres@localhost:5432/pilotswarm";

const SCHEMA = `ps_test_cms_provider0061_${randomBytes(4).toString("hex")}`;

let pool;

async function sql(text, params = []) {
    const q = text.replace(/(^|[^\w"'])@([a-z_])/g, `$1"${SCHEMA}".$2`);
    const r = await pool.query(q, params);
    return r.rows;
}
async function one(text, params = []) {
    const rows = await sql(text, params);
    return rows[0];
}

async function makeUser(subject) {
    const row = await one(
        `INSERT INTO @users (provider, subject, email, display_name)
         VALUES ('test-idp', $1, $1 || '@example.test', $1)
         ON CONFLICT (provider, subject) DO UPDATE SET email = EXCLUDED.email
         RETURNING user_id`, [subject]);
    return Number(row.user_id);
}

async function settle(sessionId, turnIndex, { provider = null, model = null, owner = null } = {}) {
    const row = await one(
        `SELECT @cms_provider_settle_turn($1,$2,$3,$4,$5,'user',NULL,$6,$7,0,0) AS first`,
        [sessionId, turnIndex, provider, model, owner, 100, 100]);
    return row.first;
}

const createShared = (name) =>
    sql(`SELECT * FROM @cms_provider_create($1,'azure','shared',NULL,$2,NULL,NULL,TRUE)`,
        [name, JSON.stringify({ apiKey: "k" })]);

const totals = (provider) =>
    one(`SELECT * FROM @cms_provider_usage_totals(NULL, TRUE, 7, NULL, $1, NULL, NULL, NULL)`, [provider]);
const daily = (provider) =>
    sql(`SELECT * FROM @cms_provider_usage_daily(NULL, TRUE, 7, NULL, $1, NULL, NULL, NULL)`, [provider]);
const breakdown = (provider) =>
    sql(`SELECT * FROM @cms_provider_usage_breakdown(NULL, TRUE, 7, NULL, $1, NULL, NULL, NULL, 'model', 40)`, [provider]);

beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await runCmsMigrations(pool, SCHEMA);
}, 180_000);

afterAll(async () => {
    if (pool) {
        await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
        await pool.end();
    }
});

beforeEach(async () => {
    await sql(`TRUNCATE @provider_usage_ledger, @provider_meters,
                        @provider_meters_user, @provider_budget_rules,
                        @provider_bootstrap_receipts,
                        @provider_instances, @session_owners, @sessions, @users
               RESTART IDENTITY CASCADE`);
});

describe("a recycled provider name owns none of its predecessor's history", () => {
    it("totals, daily, and breakdown all exclude spend from before the current instance", async () => {
        const owner = await makeUser("alice");
        await sql(`INSERT INTO @sessions (session_id, model, state) VALUES ('s-old', 'recycled:gpt', 'idle')`);

        // The previous holder's spend: ledger rows deliberately survive
        // provider deletion (history outlives the row), backdated an hour
        // so they clearly predate the re-created instance.
        await settle("s-old", 0, { provider: "recycled", model: "recycled:gpt", owner });
        await settle("s-old", 1, { provider: "recycled", model: "recycled:gpt", owner });
        await sql(`UPDATE @provider_usage_ledger SET created_at = now() - interval '1 hour'`);

        await createShared("recycled");

        // The fresh instance answers zero everywhere, in the SAME response
        // shape the API serves.
        const t0 = await totals("recycled");
        expect(Number(t0.tokens_total)).toBe(0);
        expect(Number(t0.turns)).toBe(0);
        expect(await daily("recycled")).toEqual([]);
        expect(await breakdown("recycled")).toEqual([]);

        // New spend on the new instance shows up in all three.
        await settle("s-old", 10, { provider: "recycled", model: "recycled:gpt", owner });
        const t1 = await totals("recycled");
        expect(Number(t1.tokens_total)).toBe(200);
        expect(Number(t1.turns)).toBe(1);
        expect((await daily("recycled")).length).toBe(1);
        const b1 = await breakdown("recycled");
        expect(b1.length).toBe(1);
        expect(Number(b1[0].tokens_total)).toBe(200);

        // The unfiltered report still carries the whole history — that is
        // where history belongs.
        const all = await totals(null);
        expect(Number(all.tokens_total)).toBe(600);
        expect(Number(all.turns)).toBe(3);
    });
});

describe("a retained session id survives a fresh lifetime (0062 ledger base)", () => {
    it("bumping the base makes a zero-counting new lifetime settle on fresh keys", async () => {
        const owner = await makeUser("carol");
        await sql(`INSERT INTO @sessions (session_id, model, state) VALUES ('s-restart', 'team:gpt', 'idle')`);
        await createShared("team");

        // Old lifetime: turns 0 and 1.
        expect(await settle("s-restart", 0, { provider: "team", model: "team:gpt", owner })).toBe(true);
        expect(await settle("s-restart", 1, { provider: "team", model: "team:gpt", owner })).toBe(true);

        // Without the bump, the new lifetime's turn 0 is swallowed as a
        // replay — the shipped blocker.
        // With it, the same call lands on a fresh key.
        const bumped = await one(`SELECT @cms_provider_bump_ledger_base('s-restart') AS base`);
        expect(Number(bumped.base)).toBe(2);

        expect(await settle("s-restart", 0, { provider: "team", model: "team:gpt", owner })).toBe(true);
        expect(await settle("s-restart", 1, { provider: "team", model: "team:gpt", owner })).toBe(true);
        // A replay WITHIN the new lifetime still no-ops (exactly-once holds).
        expect(await settle("s-restart", 0, { provider: "team", model: "team:gpt", owner })).toBe(false);

        const rows = await sql(
            `SELECT turn_index FROM @provider_usage_ledger WHERE session_id='s-restart' ORDER BY turn_index`);
        expect(rows.map((r) => Number(r.turn_index))).toEqual([0, 1, 2, 3]);

        // Nothing was dropped: four turns, four counted.
        const t = await one(`SELECT * FROM @cms_provider_usage_totals(NULL, TRUE, 7, NULL, 'team', NULL, NULL, NULL)`);
        expect(Number(t.turns)).toBe(4);

        // A second restart with no new spend computes the same base again.
        const again = await one(`SELECT @cms_provider_bump_ledger_base('s-restart') AS base`);
        expect(Number(again.base)).toBe(4);
    });
});

describe("cms_provider_next_turn_index", () => {
    it("answers 0 for a session with no spend, and max+1 across every lifetime", async () => {
        const owner = await makeUser("bob");
        await sql(`INSERT INTO @sessions (session_id, model, state) VALUES ('s-sys', 'team:gpt', 'idle')`);
        await createShared("team");

        const empty = await one(`SELECT @cms_provider_next_turn_index('s-sys') AS next`);
        expect(Number(empty.next)).toBe(0);

        await settle("s-sys", 0, { provider: "team", model: "team:gpt", owner });
        await settle("s-sys", 1, { provider: "team", model: "team:gpt", owner });
        await settle("s-sys", 5, { provider: "team", model: "team:gpt", owner });

        const seeded = await one(`SELECT @cms_provider_next_turn_index('s-sys') AS next`);
        expect(Number(seeded.next)).toBe(6);

        // The point of the seed: a new lifetime starting THERE settles as a
        // first write, not a swallowed replay.
        expect(await settle("s-sys", Number(seeded.next), { provider: "team", model: "team:gpt", owner })).toBe(true);
        // While the collision the bug shipped on is still a no-op replay.
        expect(await settle("s-sys", 0, { provider: "team", model: "team:gpt", owner })).toBe(false);
    });
});
