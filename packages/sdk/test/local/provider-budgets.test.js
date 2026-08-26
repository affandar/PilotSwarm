/**
 * Provider budgets — the schema and its stored procedures.
 *
 * See docs/proposals/providers-and-budgets.md. These tests are the spec of
 * the SQL: a provider is a credential with a budget policy, a session runs
 * `provider:model` and is charged to that provider, and access is governed
 * by quantity (limits, allowances) rather than by identity.
 *
 * The harness migrates ONE schema for the whole file and truncates between
 * tests, rather than using useSuiteEnv (which drops and re-migrates after
 * every test — correct, but 250ms of migration per assertion).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { runCmsMigrations } from "../../src/cms-migrator.ts";

const DATABASE_URL = process.env.PS_TEST_DATABASE_URL
    || process.env.TEST_DATABASE_URL
    || "postgresql://postgres:postgres@localhost:5432/pilotswarm";

const SCHEMA = `ps_test_cms_providerbudgets_${randomBytes(4).toString("hex")}`;

let pool;

/** `@` in a query stands for the test schema, so the SQL reads like the proc. */
async function sql(text, params = []) {
    // `@` stands for the test schema, but only where a schema can go: after
    // a boundary and before an identifier. A plain replaceAll also rewrote
    // the one inside 'alice@example.test', which quietly mangled every email
    // in the fixtures until a test asserted on one.
    const q = text.replace(/(^|[^\w"'])@([a-z_])/g, `$1"${SCHEMA}".$2`);
    const r = await pool.query(q, params);
    return r.rows;
}
async function one(text, params = []) {
    const rows = await sql(text, params);
    return rows[0];
}
/** Assert a proc refuses, and return the message so the marker can be checked. */
async function refusal(text, params = []) {
    try {
        await sql(text, params);
    } catch (err) {
        return String(err.message || "");
    }
    throw new Error(`expected a refusal from: ${text}`);
}

async function makeUser(subject) {
    const row = await one(
        `INSERT INTO @users (provider, subject, email, display_name)
         VALUES ('test-idp', $1, $1 || '@example.test', $1)
         ON CONFLICT (provider, subject) DO UPDATE SET email = EXCLUDED.email
         RETURNING user_id`, [subject]);
    return Number(row.user_id);
}

async function makeSession(sessionId, { model = null, userId = null, isSystem = false } = {}) {
    await sql(`INSERT INTO @sessions (session_id, model, is_system, state)
               VALUES ($1, $2, $3, 'idle')
               ON CONFLICT (session_id) DO UPDATE SET model = EXCLUDED.model`,
        [sessionId, model, isSystem]);
    if (userId !== null) {
        await sql(`INSERT INTO @session_owners (session_id, user_id) VALUES ($1, $2)
                   ON CONFLICT (session_id) DO UPDATE SET user_id = EXCLUDED.user_id`,
            [sessionId, userId]);
    }
}

/** The admission call, as the runtime makes it. */
const check = (sessionId, model = null) =>
    one(`SELECT * FROM @cms_provider_check_turn($1, $2)`, [sessionId, model]);

/** One settled turn. Returns true when this call was the first for that turn. */
async function settle(sessionId, turnIndex, {
    provider = null, model = null, owner = null, chargeClass = "user",
    agentId = null, input = 0, output = 0, cacheRead = 0, cacheWrite = 0,
} = {}) {
    const row = await one(
        `SELECT @cms_provider_settle_turn($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS first`,
        [sessionId, turnIndex, provider, model, owner, chargeClass, agentId,
            input, output, cacheRead, cacheWrite]);
    return row.first;
}

const createShared = (name, { type = "azure", isAdmin = true, actor = null, secret = { apiKey: "k" } } = {}) =>
    sql(`SELECT * FROM @cms_provider_create($1,$2,'shared',NULL,$3,NULL,$4,$5)`,
        [name, type, JSON.stringify(secret), actor, isAdmin]);

const createPersonal = (name, owner, { type = "github", isAdmin = false } = {}) =>
    sql(`SELECT * FROM @cms_provider_create($1,$2,'personal',$3,$4,NULL,$3,$5)`,
        [name, type, owner, JSON.stringify({ token: "t" }), isAdmin]);

const setLimit = (name, period, model, tokens, { actor = null, isAdmin = true } = {}) =>
    one(`SELECT * FROM @cms_provider_set_limit($1,$2,$3,$4,$5,$6,$7)`,
        [name, period, model, tokens, `rule_${randomBytes(6).toString("hex")}`, actor, isAdmin]);

/**
 * One meter, named the way the schema names it. A meter is keyed by what it
 * measures — provider, period, scope ('*' for all models), window — and
 * exists whether or not any limit does.
 */
async function meter(name, period = "day", scope = "*") {
    const row = await one(
        `SELECT m.used_tokens FROM @provider_meters m
          CROSS JOIN LATERAL @cms_provider_window_bounds($2, now()) wb
          WHERE m.provider_name = $1 AND m.period = $2 AND m.scope = $3
            AND m.window_key_utc = wb.window_key`, [name, period, scope]);
    return row === undefined ? null : Number(row.used_tokens);
}

/** The same meter, for one person. */
async function userMeter(name, userId, period = "day", scope = "*") {
    const row = await one(
        `SELECT m.used_tokens FROM @provider_meters_user m
          CROSS JOIN LATERAL @cms_provider_window_bounds($3, now()) wb
          WHERE m.provider_name = $1 AND m.user_id = $2 AND m.period = $3
            AND m.scope = $4 AND m.window_key_utc = wb.window_key`,
        [name, userId, period, scope]);
    return row === undefined ? null : Number(row.used_tokens);
}

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
                        @system_agent_restart_rollouts,
                        @provider_instances, @session_owners, @sessions, @users
               RESTART IDENTITY CASCADE`);
    await sql(`UPDATE @provider_cluster_settings
                  SET default_provider = NULL, default_model = NULL,
                      default_reasoning = NULL, default_context = NULL,
                      system_default_provider = NULL, system_default_model = NULL,
                      system_default_reasoning = NULL, system_default_context = NULL,
                      bootstrapped_at = NULL
                WHERE singleton`);
});

// ── windows ──────────────────────────────────────────────────────────

describe("windows are plain UTC calendar windows", () => {
    it("a day starts at midnight UTC and resets 24h later", async () => {
        const r = await one(
            `SELECT * FROM @cms_provider_window_bounds('day', '2026-03-14T13:45:00Z'::timestamptz)`);
        expect(r.window_start.toISOString()).toBe("2026-03-14T00:00:00.000Z");
        expect(r.resets_at.toISOString()).toBe("2026-03-15T00:00:00.000Z");
        expect(r.window_key).toBe("2026-03-14T00:00:00.000Z");
    });

    it("a week starts on Monday 00:00 UTC", async () => {
        // 2026-03-14 is a Saturday; its week began Monday the 9th.
        const r = await one(
            `SELECT * FROM @cms_provider_window_bounds('week', '2026-03-14T13:45:00Z'::timestamptz)`);
        expect(r.window_start.toISOString()).toBe("2026-03-09T00:00:00.000Z");
        expect(r.resets_at.toISOString()).toBe("2026-03-16T00:00:00.000Z");
    });

    it("a month starts on the 1st and follows the calendar, not 30 days", async () => {
        const feb = await one(
            `SELECT * FROM @cms_provider_window_bounds('month', '2026-02-20T00:00:00Z'::timestamptz)`);
        expect(feb.window_start.toISOString()).toBe("2026-02-01T00:00:00.000Z");
        expect(feb.resets_at.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    });

    it("the boundary belongs to the window it opens", async () => {
        const r = await one(
            `SELECT * FROM @cms_provider_window_bounds('day', '2026-03-14T00:00:00Z'::timestamptz)`);
        expect(r.window_start.toISOString()).toBe("2026-03-14T00:00:00.000Z");
    });

    it("truncation is UTC even when the session timezone is not", async () => {
        // date_trunc on a timestamptz truncates in the SESSION timezone. If
        // the proc ever stops projecting to UTC first, every boundary moves
        // on a connection like this one.
        const client = await pool.connect();
        try {
            await client.query(`SET TIME ZONE 'Asia/Tokyo'`);
            const r = await client.query(
                `SELECT * FROM "${SCHEMA}".cms_provider_window_bounds('day', '2026-03-14T13:45:00Z'::timestamptz)`);
            expect(r.rows[0].window_key).toBe("2026-03-14T00:00:00.000Z");
        } finally {
            client.release();
        }
    });

    it("an unknown period is refused rather than guessed", async () => {
        const msg = await refusal(
            `SELECT * FROM @cms_provider_window_bounds('fortnight', now())`);
        expect(msg).toMatch(/PROVIDER_INVALID/);
    });
});

// ── providers ────────────────────────────────────────────────────────

describe("creating providers", () => {
    it("only an administrator can add a shared provider", async () => {
        const alice = await makeUser("alice");
        const msg = await refusal(
            `SELECT * FROM @cms_provider_create('team','azure','shared',NULL,'{}'::jsonb,NULL,$1,FALSE)`,
            [alice]);
        expect(msg).toMatch(/PROVIDER_FORBIDDEN/);
        await createShared("team");
        const rows = await sql(`SELECT name, class FROM @provider_instances`);
        expect(rows).toEqual([{ name: "team", class: "shared" }]);
    });

    it("a personal provider belongs to its creator", async () => {
        const alice = await makeUser("alice");
        await createPersonal("alice-ghcp", alice);
        const row = await one(`SELECT class, owner_user_id, allowance_pct FROM @provider_instances`);
        expect(row.class).toBe("personal");
        expect(Number(row.owner_user_id)).toBe(alice);
        expect(row.allowance_pct).toBe(100);
    });

    it("an owner can replace a personal provider credential without replacing the provider", async () => {
        const alice = await makeUser("alice");
        const bob = await makeUser("bob");
        await createPersonal("alice-ghcp", alice);
        const before = await one(`SELECT name, type_id, class, owner_user_id, created_at FROM @provider_instances`);

        const updated = await one(
            `SELECT * FROM @cms_provider_update_personal_credential($1,$2,$3)`,
            ["alice-ghcp", JSON.stringify({ kind: "githubToken", value: "replacement" }), alice]);
        expect(updated).toMatchObject({ name: "alice-ghcp", type_id: "github", class: "personal" });

        const after = await one(
            `SELECT name, type_id, class, owner_user_id, created_at, secret_ref FROM @provider_instances`);
        expect({ ...after, secret_ref: undefined }).toEqual({ ...before, secret_ref: undefined });
        expect(after.secret_ref).toEqual({ kind: "githubToken", value: "replacement" });

        const hidden = await refusal(
            `SELECT * FROM @cms_provider_update_personal_credential($1,$2,$3)`,
            ["alice-ghcp", JSON.stringify({ kind: "githubToken", value: "stolen" }), bob]);
        expect(hidden).toMatch(/PROVIDER_NOT_FOUND/);

        await createShared("shared-ghcp");
        const shared = await refusal(
            `SELECT * FROM @cms_provider_update_personal_credential($1,$2,$3)`,
            ["shared-ghcp", JSON.stringify({ kind: "githubToken", value: "changed" }), alice]);
        expect(shared).toMatch(/PROVIDER_NOT_FOUND/);
    });

    it("replacing the key keeps a pinned apiVersion, and marks the row touched", async () => {
        // The update writes the whole secret_ref blob, and the caller is a
        // credential form: it sends {apiKey} and nothing else. Anything else
        // living in that blob was therefore dropped.
        //
        // apiVersion lives in that blob. provider-catalog reads
        // secret_ref.apiVersion and otherwise falls back to the type default,
        // so an azure provider pinned to a version silently moved off it the
        // first time its owner rotated an expired key — with nothing said in
        // the UI, the response, or the audit row. Delete-and-recreate, the
        // workflow this replaces, never had the problem: create carries the
        // whole credentials object.
        const alice = await makeUser("alice");
        await sql(`SELECT * FROM @cms_provider_create($1,'azure','personal',$2,$3,NULL,$2,false)`,
            ["alice-azure", alice, JSON.stringify({ apiKey: "original", apiVersion: "2026-01-01" })]);

        const before = await one(`SELECT secret_ref, created_at, updated_at FROM @provider_instances WHERE name = 'alice-azure'`);
        expect(before.secret_ref).toMatchObject({ apiVersion: "2026-01-01" });

        await one(`SELECT * FROM @cms_provider_update_personal_credential($1,$2,$3)`,
            ["alice-azure", JSON.stringify({ kind: "apiKey", value: "rotated" }), alice]);

        const after = await one(`SELECT secret_ref, created_at, updated_at FROM @provider_instances WHERE name = 'alice-azure'`);
        expect(after.secret_ref).toEqual({ kind: "apiKey", value: "rotated", apiVersion: "2026-01-01" });
        // Sean's test above selects created_at but not updated_at, which is
        // why the missing stamp survived it: a rotation left the two equal.
        expect(new Date(after.updated_at).getTime()).toBeGreaterThan(new Date(before.updated_at).getTime());
        expect(after.created_at).toEqual(before.created_at);
    });

    it("a caller who states an apiVersion overrides the stored one", async () => {
        // Carrying the old value forward must not make it unchangeable —
        // stating one is how you change it.
        const alice = await makeUser("alice");
        await sql(`SELECT * FROM @cms_provider_create($1,'azure','personal',$2,$3,NULL,$2,false)`,
            ["alice-azure", alice, JSON.stringify({ apiKey: "original", apiVersion: "2026-01-01" })]);

        await one(`SELECT * FROM @cms_provider_update_personal_credential($1,$2,$3)`,
            ["alice-azure", JSON.stringify({ kind: "apiKey", value: "v2", apiVersion: "2030-09-09" }), alice]);

        const after = await one(`SELECT secret_ref FROM @provider_instances WHERE name = 'alice-azure'`);
        expect(after.secret_ref).toEqual({ kind: "apiKey", value: "v2", apiVersion: "2030-09-09" });
    });

    it("no apiVersion is invented for a provider that never had one", async () => {
        // The merge must be a carry-forward, not a default.
        const alice = await makeUser("alice");
        await createPersonal("alice-ghcp", alice);

        await one(`SELECT * FROM @cms_provider_update_personal_credential($1,$2,$3)`,
            ["alice-ghcp", JSON.stringify({ kind: "githubToken", value: "replacement" }), alice]);

        const after = await one(`SELECT secret_ref FROM @provider_instances WHERE name = 'alice-ghcp'`);
        expect(after.secret_ref).toEqual({ kind: "githubToken", value: "replacement" });
        expect("apiVersion" in after.secret_ref).toBe(false);
    });

    it("a name is claimed once, and the refusal says only that", async () => {
        const alice = await makeUser("alice");
        await createShared("acme");
        const msg = await refusal(
            `SELECT * FROM @cms_provider_create('acme','github','personal',$1,'{}'::jsonb,NULL,$1,FALSE)`,
            [alice]);
        expect(msg).toMatch(/PROVIDER_CONFLICT/);
        expect(msg).toMatch(/already taken/);
        // It must not describe what holds the name — not its class, not its
        // owner, not its type.
        expect(msg.replace("acme", "")).not.toMatch(/shared|personal|admin|azure|github/i);
    });

    it("a name cannot contain a colon, which would make model refs ambiguous", async () => {
        const msg = await refusal(
            `SELECT * FROM @cms_provider_create('bad:name','azure','shared',NULL,'{}'::jsonb,NULL,NULL,TRUE)`);
        expect(msg).toMatch(/provider_instances_name_shape|violates check constraint/);
    });

    it("a personal provider cannot carry an allowance", async () => {
        const alice = await makeUser("alice");
        await createPersonal("alice-ghcp", alice);
        const msg = await refusal(
            `SELECT @cms_provider_set_allowance('alice-ghcp', 20::smallint, $1, FALSE)`, [alice]);
        expect(msg).toMatch(/PROVIDER_INVALID/);
        expect(msg).toMatch(/divides a shared budget/);
    });
});

describe("the namespace is the whole access story", () => {
    it("another person's provider is indistinguishable from one that never existed", async () => {
        const alice = await makeUser("alice");
        const bob = await makeUser("bob");
        await createPersonal("alice-ghcp", alice);

        const mine = await sql(`SELECT * FROM @cms_provider_in_namespace('alice-ghcp', $1)`, [alice]);
        expect(mine).toHaveLength(1);

        const theirs = await sql(`SELECT * FROM @cms_provider_in_namespace('alice-ghcp', $1)`, [bob]);
        const absent = await sql(`SELECT * FROM @cms_provider_in_namespace('never-created', $1)`, [bob]);
        expect(theirs).toEqual(absent);
        expect(theirs).toHaveLength(0);
    });

    it("the refusal wording is identical too, so existence cannot be probed", async () => {
        const alice = await makeUser("alice");
        const bob = await makeUser("bob");
        await createPersonal("alice-ghcp", alice);

        const hidden = await refusal(
            `SELECT @cms_provider_delete('alice-ghcp', $1, FALSE)`, [bob]);
        const missing = await refusal(
            `SELECT @cms_provider_delete('never-created', $1, FALSE)`, [bob]);
        expect(hidden.replace("alice-ghcp", "X")).toBe(missing.replace("never-created", "X"));
        expect(hidden).toMatch(/PROVIDER_NOT_FOUND/);
    });

    it("everyone may use a shared provider without being granted anything", async () => {
        const bob = await makeUser("bob");
        await createShared("team");
        const rows = await sql(`SELECT * FROM @cms_provider_in_namespace('team', $1)`, [bob]);
        expect(rows).toHaveLength(1);
    });

    it("a shared provider is visible with no signed-in user at all", async () => {
        await createShared("team");
        const rows = await sql(`SELECT * FROM @cms_provider_in_namespace('team', NULL)`);
        expect(rows).toHaveLength(1);
    });

    it("an administrator sees every provider, but only their own are usable by them", async () => {
        const alice = await makeUser("alice");
        const ada = await makeUser("ada");
        await createShared("team");
        await createPersonal("alice-ghcp", alice);

        const asAdmin = await sql(`SELECT name, usable_by_me FROM @cms_provider_list($1, TRUE)`, [ada]);
        expect(asAdmin.map((r) => r.name).sort()).toEqual(["alice-ghcp", "team"]);
        expect(asAdmin.find((r) => r.name === "alice-ghcp").usable_by_me).toBe(false);
        expect(asAdmin.find((r) => r.name === "team").usable_by_me).toBe(true);

        const asBob = await sql(`SELECT name FROM @cms_provider_list($1, FALSE)`, [await makeUser("bob")]);
        expect(asBob.map((r) => r.name)).toEqual(["team"]);
    });
});

describe("deleting a provider", () => {
    it("is a hard delete that takes its limits and meters with it", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        const { rule_id } = await setLimit("team", "day", null, 1000);
        await settle("s1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 10 });

        await sql(`SELECT @cms_provider_delete('team', NULL, TRUE)`);
        expect(await sql(`SELECT 1 FROM @provider_instances`)).toHaveLength(0);
        expect(await sql(`SELECT 1 FROM @provider_budget_rules WHERE rule_id = $1`, [rule_id])).toHaveLength(0);
        expect(await sql(`SELECT 1 FROM @provider_meters WHERE provider_name = 'team'`)).toHaveLength(0);
        expect(await sql(`SELECT 1 FROM @provider_meters_user WHERE provider_name = 'team'`)).toHaveLength(0);
    });

    it("leaves history intact: the ledger records a name, it does not reference a row", async () => {
        await createShared("team");
        await settle("s1", 0, { provider: "team", model: "team:gpt", input: 500 });
        await sql(`SELECT @cms_provider_delete('team', NULL, TRUE)`);

        const rows = await sql(`SELECT provider_name, tokens_total FROM @provider_usage_ledger`);
        expect(rows).toEqual([{ provider_name: "team", tokens_total: "500" }]);
    });

    it("reports how many sessions will be left waiting on the name", async () => {
        await createShared("team");
        await makeSession("s1", { model: "team:gpt" });
        await makeSession("s2", { model: "team:gpt" });
        await makeSession("s3", { model: "other:gpt" });
        const row = await one(`SELECT @cms_provider_delete('team', NULL, TRUE) AS waiting`);
        expect(Number(row.waiting)).toBe(2);
    });

    it("refuses deletion while a default points at it", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await sql(`SELECT @cms_provider_set_cluster_default('team','team:gpt','medium','standard',TRUE)`);
        await sql(`SELECT @cms_provider_set_user_default($1,'team','team:gpt',NULL,NULL)`, [alice]);

        expect(await refusal(`SELECT @cms_provider_delete('team', NULL, TRUE)`))
            .toMatch(/PROVIDER_IN_USE/);
        await sql(`SELECT @cms_provider_set_user_default($1,NULL,NULL,NULL,NULL)`, [alice]);
        await sql(`SELECT @cms_provider_set_cluster_default(NULL,NULL,NULL,NULL,TRUE)`);
        await sql(`SELECT @cms_provider_delete('team', NULL, TRUE)`);
        expect(await sql(`SELECT 1 FROM @provider_instances WHERE name = 'team'`)).toHaveLength(0);
    });

    it("re-creating the name is a fresh budget, not a resurrection", async () => {
        await createShared("team");
        await setLimit("team", "day", null, 1000);
        await sql(`SELECT @cms_provider_delete('team', NULL, TRUE)`);
        await createShared("team");
        expect(await sql(`SELECT 1 FROM @provider_budget_rules`)).toHaveLength(0);
    });

    it("a re-created name starts from zero, because the meters went with it", async () => {
        // The documented rescue for a session stuck on a missing name is to
        // create that name again. Its usage must start at nothing, or the
        // rescue would pause the very session it was meant to release.
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "team:gpt", userId: alice });
        await settle("s1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 900 });
        expect(await meter("team")).toBe(900);

        await sql(`SELECT @cms_provider_delete('team', NULL, TRUE)`);
        await createShared("team");
        expect(await meter("team")).toBeNull();
        expect(await userMeter("team", alice)).toBeNull();

        // And a limit made now measures the new provider, not the old one.
        const { seeded_tokens } = await setLimit("team", "day", null, 1000);
        expect(Number(seeded_tokens)).toBe(0);
        expect((await check("s1")).verdict).toBe("clear");
    });
});

// ── limits ───────────────────────────────────────────────────────────

describe("limits", () => {
    it("an overall limit and a per-model limit coexist on one provider", async () => {
        await createShared("team");
        await setLimit("team", "day", null, 1_000_000);
        await setLimit("team", "day", "team:gpt-5.4", 100_000);
        const rows = await sql(
            `SELECT period, model_qualified, limit_tokens FROM @provider_budget_rules ORDER BY limit_tokens`);
        expect(rows).toEqual([
            { period: "day", model_qualified: "team:gpt-5.4", limit_tokens: "100000" },
            { period: "day", model_qualified: null, limit_tokens: "1000000" },
        ]);
    });

    it("saving the same period and scope replaces the limit in place", async () => {
        await createShared("team");
        const first = await setLimit("team", "day", null, 1000);
        const second = await setLimit("team", "day", null, 2000);
        expect(second.rule_id).toBe(first.rule_id);
        const rows = await sql(`SELECT limit_tokens FROM @provider_budget_rules`);
        expect(rows).toEqual([{ limit_tokens: "2000" }]);
    });

    it("a new limit counts what this window already spent", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await settle("s1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 700 });
        const { seeded_tokens } = await setLimit("team", "day", null, 1000);
        expect(Number(seeded_tokens)).toBe(700);

        // The per-person meter has been running too, or an allowance set
        // later would believe this person had spent nothing.
        expect(await userMeter("team", alice)).toBe(700);
    });

    it("saving a limit twice cannot inflate a meter", async () => {
        await createShared("team");
        await settle("s1", 0, { provider: "team", model: "team:gpt", input: 700 });
        await setLimit("team", "day", null, 1000);
        await setLimit("team", "day", null, 5000);
        expect(await meter("team")).toBe(700);
    });

    it("a limit must be positive, and its period must be real", async () => {
        await createShared("team");
        expect(await refusal(
            `SELECT * FROM @cms_provider_set_limit('team','day',NULL,0,'r1',NULL,TRUE)`))
            .toMatch(/PROVIDER_INVALID/);
        expect(await refusal(
            `SELECT * FROM @cms_provider_set_limit('team','fortnight',NULL,10,'r1',NULL,TRUE)`))
            .toMatch(/PROVIDER_INVALID/);
    });

    it("an ordinary person cannot set a limit on a shared provider", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        expect(await refusal(
            `SELECT * FROM @cms_provider_set_limit('team','day',NULL,10,'r1',$1,FALSE)`, [alice]))
            .toMatch(/PROVIDER_FORBIDDEN/);
    });

    it("but they can limit their own provider", async () => {
        const alice = await makeUser("alice");
        await createPersonal("alice-ghcp", alice);
        const r = await setLimit("alice-ghcp", "week", null, 5000, { actor: alice, isAdmin: false });
        expect(r.rule_id).toBeTruthy();
    });

    it("removing a limit reports whether there was one", async () => {
        await createShared("team");
        await setLimit("team", "day", null, 1000);
        expect(await one(`SELECT @cms_provider_remove_limit('team','day',NULL,NULL,TRUE) AS gone`))
            .toEqual({ gone: true });
        expect(await one(`SELECT @cms_provider_remove_limit('team','day',NULL,NULL,TRUE) AS gone`))
            .toEqual({ gone: false });
    });
});

// ── admission ────────────────────────────────────────────────────────

describe("admission: the turn boundary", () => {
    it("a session on a provider it can see runs", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "team:gpt-5.4", userId: alice });
        const v = await check("s1");
        expect(v.verdict).toBe("clear");
        expect(v.provider_name).toBe("team");
        expect(v.exempt).toBe(false);
    });

    it("a session naming a provider that does not exist waits, and says which name", async () => {
        const alice = await makeUser("alice");
        await makeSession("s1", { model: "gone:gpt-5.4", userId: alice });
        const v = await check("s1");
        expect(v.verdict).toBe("no_provider");
        expect(v.pause).toMatchObject({ kind: "no_provider", provider: "gone" });
    });

    it("a session naming ANOTHER person's provider gets the same answer as a typo", async () => {
        const alice = await makeUser("alice");
        const bob = await makeUser("bob");
        await createPersonal("alice-ghcp", alice);
        await makeSession("s1", { model: "alice-ghcp:gpt", userId: bob });
        await makeSession("s2", { model: "never-made:gpt", userId: bob });
        const hidden = await check("s1");
        const missing = await check("s2");
        expect(hidden.verdict).toBe("no_provider");
        expect(missing.verdict).toBe("no_provider");
        expect(hidden.pause.kind).toBe(missing.pause.kind);
    });

    it("an unqualified model reference resolves nothing: a session names its payer", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "gpt-5.4", userId: alice });
        const v = await check("s1");
        expect(v.verdict).toBe("no_provider");
        expect(v.pause.provider).toBeNull();
    });

    it("the stamped CMS model cannot be overridden by the activity caller", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "gone:gpt", userId: alice });
        expect((await check("s1")).verdict).toBe("no_provider");
        expect((await check("s1", "team:gpt-5.4")).verdict).toBe("no_provider");
        expect((await check("s1", "team:gpt-5.4")).model_qualified).toBe("gone:gpt");
    });

    it("a hold pauses new turns without any limit being involved", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "team:gpt", userId: alice });
        await sql(`SELECT @cms_provider_set_hold('team', NULL, TRUE, NULL, TRUE)`);
        const v = await check("s1");
        expect(v.verdict).toBe("paused");
        expect(v.pause).toMatchObject({ kind: "hold", provider: "team" });

        await sql(`SELECT @cms_provider_set_hold('team', NULL, FALSE, NULL, TRUE)`);
        expect((await check("s1")).verdict).toBe("clear");
    });

    it("a hold that has already expired does not pause anything", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "team:gpt", userId: alice });
        await sql(`SELECT @cms_provider_set_hold('team', now() - interval '1 hour', FALSE, NULL, TRUE)`);
        expect((await check("s1")).verdict).toBe("clear");
    });

    it("the turn that crosses a limit completes; the NEXT one waits", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "team:gpt", userId: alice });
        await setLimit("team", "day", null, 1000);

        expect((await check("s1")).verdict).toBe("clear");
        // One turn overshoots the limit by a long way — it is still charged.
        await settle("s1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 43_602 });
        const v = await check("s1");
        expect(v.verdict).toBe("paused");
        expect(v.pause).toMatchObject({ kind: "limit", provider: "team", period: "day" });
        expect(Number(v.pause.usedTokens)).toBe(43_602);
    });

    it("a per-model limit stops only that model", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "team:gpt-5.4", userId: alice });
        await makeSession("s2", { model: "team:gpt-mini", userId: alice });
        await setLimit("team", "day", "team:gpt-5.4", 100);
        await settle("s1", 0, { provider: "team", model: "team:gpt-5.4", owner: alice, input: 500 });

        expect((await check("s1")).verdict).toBe("paused");
        expect((await check("s2")).verdict).toBe("clear");
    });

    it("when a limit and an allowance both bite, the limit is what is reported", async () => {
        // Raising the allowance would not help, so naming it would send the
        // reader to the wrong control.
        const alice = await makeUser("alice");
        await createShared("team");
        await sql(`SELECT @cms_provider_set_allowance('team', 50::smallint, NULL, TRUE)`);
        await makeSession("s1", { model: "team:gpt", userId: alice });
        await setLimit("team", "day", null, 1000);
        await settle("s1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 2000 });
        const v = await check("s1");
        expect(v.pause.kind).toBe("limit");
    });

    it("the latest reset among blocking rules is when the session actually resumes", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "team:gpt", userId: alice });
        await setLimit("team", "day", null, 100);
        await setLimit("team", "month", null, 100);
        await settle("s1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 500 });

        const v = await check("s1");
        const monthEnd = await one(
            `SELECT resets_at FROM @cms_provider_window_bounds('month', now())`);
        expect(new Date(v.pause.resetsAtUtc).toISOString())
            .toBe(monthEnd.resets_at.toISOString());
    });

    it("system sessions are exempt, and still resolve a provider so their spend is recorded", async () => {
        await createShared("team");
        await makeSession("sys", { model: "team:gpt", isSystem: true });
        await setLimit("team", "day", null, 10);
        await settle("sys", 0, { provider: "team", model: "team:gpt", chargeClass: "system", input: 99_999 });
        const v = await check("sys");
        expect(v.verdict).toBe("clear");
        expect(v.exempt).toBe(true);
        expect(v.provider_name).toBe("team");
    });

    it("a hold does not pause the machinery either", async () => {
        await createShared("team");
        await makeSession("sys", { model: "team:gpt", isSystem: true });
        await sql(`SELECT @cms_provider_set_hold('team', NULL, TRUE, NULL, TRUE)`);
        expect((await check("sys")).verdict).toBe("clear");
    });

    it("a session with no rules at all is clear and reports no limits", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "team:gpt", userId: alice });
        const v = await check("s1");
        expect(v.verdict).toBe("clear");
        expect(v.rules).toEqual([]);
    });

    it("a missing session fails closed", async () => {
        expect(await refusal(`SELECT * FROM @cms_provider_check_turn('no-such-session',NULL)`))
            .toMatch(/PROVIDER_NOT_FOUND/);
    });

    it("the pause is recorded on the session, and cleared when it stops being true", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "team:gpt", userId: alice });
        await setLimit("team", "day", null, 100);
        await settle("s1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 500 });

        await check("s1");
        const paused = await one(`SELECT pause_state FROM @sessions WHERE session_id = 's1'`);
        expect(paused.pause_state).toMatchObject({ kind: "limit", provider: "team" });

        await sql(`SELECT @cms_provider_set_limit('team','day',NULL,10000,'r2',NULL,TRUE)`);
        await check("s1");
        const cleared = await one(`SELECT pause_state FROM @sessions WHERE session_id = 's1'`);
        expect(cleared.pause_state).toBeNull();
    });
});

// ── allowances ───────────────────────────────────────────────────────

describe("allowances divide a shared budget between people", () => {
    async function twoSpenders() {
        const alice = await makeUser("alice");
        const bob = await makeUser("bob");
        await createShared("team");
        await makeSession("a1", { model: "team:gpt", userId: alice });
        await makeSession("b1", { model: "team:gpt", userId: bob });
        await setLimit("team", "day", null, 1_000_000);
        await sql(`SELECT @cms_provider_set_allowance('team', 20::smallint, NULL, TRUE)`);
        return { alice, bob };
    }

    it("one person hitting their share does not stop anyone else", async () => {
        const { alice, bob } = await twoSpenders();
        await settle("a1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 200_000 });

        const mine = await check("a1");
        expect(mine.verdict).toBe("paused");
        expect(mine.pause).toMatchObject({ kind: "allowance", provider: "team" });
        expect(Number(mine.pause.ceilingTokens)).toBe(200_000);

        expect((await check("b1")).verdict).toBe("clear");
        // And the provider itself is nowhere near its limit.
        expect(await meter("team")).toBe(200_000);
    });

    it("the ceiling is derived live: raising the limit raises every share with it", async () => {
        const { alice } = await twoSpenders();
        await settle("a1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 200_000 });
        expect((await check("a1")).verdict).toBe("paused");

        await sql(`SELECT @cms_provider_set_limit('team','day',NULL,10000000,'r2',NULL,TRUE)`);
        expect((await check("a1")).verdict).toBe("clear");
    });

    it("raising the allowance releases the same session, with no limit change", async () => {
        const { alice } = await twoSpenders();
        await settle("a1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 200_000 });
        expect((await check("a1")).verdict).toBe("paused");
        await sql(`SELECT @cms_provider_set_allowance('team', 50::smallint, NULL, TRUE)`);
        expect((await check("a1")).verdict).toBe("clear");
    });

    it("shares may add up to more than the provider holds — the limit still caps the total", async () => {
        const { alice, bob } = await twoSpenders();
        // 20% each: ten people could claim 200% of the pool. The provider's
        // own limit is what actually stops the room running out.
        await sql(`SELECT @cms_provider_set_limit('team','day',NULL,300000,'r2',NULL,TRUE)`);
        await settle("a1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 59_000 });
        await settle("b1", 0, { provider: "team", model: "team:gpt", owner: bob, input: 250_000 });
        // Alice is under her 60k share, but the provider is over its 300k.
        const v = await check("a1");
        expect(v.verdict).toBe("paused");
        expect(v.pause.kind).toBe("limit");
    });

    it("a full allowance reads nothing per-person and blocks nobody early", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("a1", { model: "team:gpt", userId: alice });
        await setLimit("team", "day", null, 1000);
        await settle("a1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 900 });
        const v = await check("a1");
        expect(v.verdict).toBe("clear");
        expect(v.rules[0].ceilingTokens).toBeNull();
        expect(v.rules[0].yourUsedTokens).toBeNull();
    });

    it("an allowance without any limit has nothing to divide", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await sql(`SELECT @cms_provider_set_allowance('team', 1::smallint, NULL, TRUE)`);
        await makeSession("a1", { model: "team:gpt", userId: alice });
        await settle("a1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 10_000_000 });
        expect((await check("a1")).verdict).toBe("clear");
    });

    it("a tiny share still lets a first turn run", async () => {
        // floor(1 * 1%) is 0, and a zero ceiling would block before any work
        // at all — the one exception to "the crossing turn completes".
        const alice = await makeUser("alice");
        await createShared("team");
        await sql(`SELECT @cms_provider_set_allowance('team', 1::smallint, NULL, TRUE)`);
        await makeSession("a1", { model: "team:gpt", userId: alice });
        await setLimit("team", "day", null, 1);
        expect((await check("a1")).verdict).toBe("clear");
    });

    it("it binds administrators too", async () => {
        const ada = await makeUser("ada");
        await createShared("team");
        await makeSession("ada1", { model: "team:gpt", userId: ada });
        await setLimit("team", "day", null, 1000);
        await sql(`SELECT @cms_provider_set_allowance('team', 10::smallint, NULL, TRUE)`);
        await settle("ada1", 0, { provider: "team", model: "team:gpt", owner: ada, input: 150 });
        const v = await check("ada1");
        expect(v.verdict).toBe("paused");
        expect(v.pause.kind).toBe("allowance");
    });

    it("a turn with no owner is measured against the provider only", async () => {
        await createShared("team");
        await sql(`SELECT @cms_provider_set_allowance('team', 10::smallint, NULL, TRUE)`);
        await makeSession("s1", { model: "team:gpt" });   // no owner
        await setLimit("team", "day", null, 1000);
        await settle("s1", 0, { provider: "team", model: "team:gpt", owner: null, input: 500 });
        const v = await check("s1");
        expect(v.verdict).toBe("clear");
    });
});

// ── settlement ───────────────────────────────────────────────────────

describe("settlement is exactly once", () => {
    it("a retried turn is charged once", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await setLimit("team", "day", null, 1_000_000);

        expect(await settle("s1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 100 })).toBe(true);
        expect(await settle("s1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 100 })).toBe(false);
        expect(await settle("s1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 999 })).toBe(false);

        expect(await meter("team")).toBe(100);
        expect(await userMeter("team", alice)).toBe(100);
        expect(await sql(`SELECT 1 FROM @provider_usage_ledger`)).toHaveLength(1);
    });

    it("concurrent settles of one turn still charge once", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await setLimit("team", "day", null, 1_000_000);
        const results = await Promise.all(Array.from({ length: 8 }, () =>
            settle("s1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 100 })));
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(await meter("team")).toBe(100);
    });

    it("every token kind is counted", async () => {
        await createShared("team");
        await setLimit("team", "day", null, 1_000_000);
        await settle("s1", 0, {
            provider: "team", model: "team:gpt",
            input: 1, output: 2, cacheRead: 4, cacheWrite: 8,
        });
        expect(await meter("team")).toBe(15);
    });

    it("system spend is recorded and shown, but consumes no budget", async () => {
        await createShared("team");
        await setLimit("team", "day", null, 1000);
        await settle("sys", 0, {
            provider: "team", model: "team:gpt", chargeClass: "system", input: 50_000,
        });
        const led = await one(`SELECT charge_class, tokens_total FROM @provider_usage_ledger`);
        expect(led).toEqual({ charge_class: "system", tokens_total: "50000" });
        // 50,000 tokens of machinery moved no meter at all — not the day, not
        // the week, not the month, and not the model it ran.
        expect(await sql(`SELECT 1 FROM @provider_meters`)).toHaveLength(0);
        expect(await sql(`SELECT 1 FROM @provider_meters_user`)).toHaveLength(0);
    });

    it("a turn with no provider is recorded as unattributed", async () => {
        await settle("s1", 0, { provider: null, model: "gone:gpt", input: 10 });
        const led = await one(`SELECT charge_class, provider_name FROM @provider_usage_ledger`);
        expect(led).toEqual({ charge_class: "unattributed", provider_name: null });
    });

    it("a zero-token turn still records the ledger row", async () => {
        await createShared("team");
        await setLimit("team", "day", null, 1000);
        expect(await settle("s1", 0, { provider: "team", model: "team:gpt" })).toBe(true);
        expect(await sql(`SELECT 1 FROM @provider_usage_ledger`)).toHaveLength(1);
    });

    it("a per-model meter is charged only by that model", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await settle("s1", 0, { provider: "team", model: "team:gpt-mini", owner: alice, input: 300 });
        await settle("s2", 0, { provider: "team", model: "team:gpt-5.4", owner: alice, input: 40 });

        // All models sees both turns; each model meter sees only its own.
        expect(await meter("team", "day", "*")).toBe(340);
        expect(await meter("team", "day", "team:gpt-mini")).toBe(300);
        expect(await meter("team", "day", "team:gpt-5.4")).toBe(40);
        expect(await meter("team", "day", "team:never-ran")).toBeNull();
        expect(await userMeter("team", alice, "day", "team:gpt-mini")).toBe(300);

        // And a limit on one model reads that model's meter, not the total.
        expect(Number((await setLimit("team", "day", "team:gpt-5.4", 1000)).seeded_tokens)).toBe(40);
        expect(Number((await setLimit("team", "day", null, 1000)).seeded_tokens)).toBe(340);
    });
});

// ── meters ───────────────────────────────────────────────────────────

describe("a meter is not a limit", () => {
    it("usage is counted for a period nobody has capped", async () => {
        // The whole point. A counter used to exist only because a limit
        // existed, so an uncapped period had no number to show beside its ∞.
        const alice = await makeUser("alice");
        await createShared("team");
        await settle("s1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 4000 });

        expect(await sql(`SELECT 1 FROM @provider_budget_rules`)).toHaveLength(0);
        for (const period of ["day", "week", "month"]) {
            expect(await meter("team", period)).toBe(4000);
            expect(await userMeter("team", alice, period)).toBe(4000);
        }
    });

    it("a limit created later reads that usage immediately, with no seeding step", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "team:gpt", userId: alice });
        await settle("s1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 4000 });

        // Saving the limit writes nothing: it names a number that is already
        // there. The next turn is judged against it at once.
        const before = await one(`SELECT max(updated_at) AS t FROM @provider_meters`);
        const { seeded_tokens } = await setLimit("team", "day", null, 1000);
        const after = await one(`SELECT max(updated_at) AS t FROM @provider_meters`);
        expect(Number(seeded_tokens)).toBe(4000);
        expect(after.t.toISOString()).toBe(before.t.toISOString());

        const v = await check("s1");
        expect(v.verdict).toBe("paused");
        expect(Number(v.pause.usedTokens)).toBe(4000);
    });

    it("one turn moves twelve rows, and settling it twice still moves them once", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        expect(await settle("s1", 0, {
            provider: "team", model: "team:gpt-5.4", owner: alice, input: 100,
        })).toBe(true);

        // Three periods x (all models, the model that ran), for the provider
        // and for the person: six rows in each table.
        const rows = await sql(
            `SELECT period, scope, used_tokens FROM @provider_meters ORDER BY period, scope`);
        expect(rows).toHaveLength(6);
        expect(rows.map((r) => `${r.period}/${r.scope}`)).toEqual([
            "day/*", "day/team:gpt-5.4",
            "month/*", "month/team:gpt-5.4",
            "week/*", "week/team:gpt-5.4",
        ]);
        expect(await sql(`SELECT 1 FROM @provider_meters_user`)).toHaveLength(6);

        // The ledger's (session_id, turn_index) insert is the claim, and the
        // meters move only when it wins.
        expect(await settle("s1", 0, {
            provider: "team", model: "team:gpt-5.4", owner: alice, input: 100,
        })).toBe(false);
        expect(await sql(`SELECT 1 FROM @provider_meters`)).toHaveLength(6);
        expect(rows.every((r) => r.used_tokens === "100")).toBe(true);
        expect(await meter("team")).toBe(100);
        expect(await userMeter("team", alice, "week", "team:gpt-5.4")).toBe(100);
    });

    it("a turn that names no model has one scope, not two", async () => {
        await createShared("team");
        await settle("s1", 0, { provider: "team", model: null, input: 10 });
        const rows = await sql(`SELECT DISTINCT scope FROM @provider_meters`);
        expect(rows).toEqual([{ scope: "*" }]);
        expect(await sql(`SELECT 1 FROM @provider_meters`)).toHaveLength(3);
    });

    it("an unattributed turn moves no meter, because it has no provider to charge", async () => {
        await settle("s1", 0, { provider: null, model: "gone:gpt", input: 10 });
        expect(await sql(`SELECT 1 FROM @provider_meters`)).toHaveLength(0);
    });

    it("the grid draws limited and uncapped metered models from the same meters", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await createPersonal("alice-ghcp", alice);
        await settle("s1", 0, { provider: "team", model: "team:gpt-5.4", owner: alice, input: 300 });
        await settle("s2", 0, { provider: "team", model: "team:mini", owner: alice, input: 100 });
        await setLimit("team", "day", null, 1000);
        await setLimit("team", "day", "team:gpt-5.4", 200);

        const rows = await sql(`SELECT * FROM @cms_provider_usage_grid($1, FALSE)`, [alice]);
        expect(rows.map((r) => [r.provider_name, r.row_kind, r.scope])).toEqual([
            ["team", "provider", "*"],
            ["team", "model", "team:gpt-5.4"],
            ["team", "model", "team:mini"],
            ["alice-ghcp", "provider", "*"],
        ]);

        const team = rows[0];
        expect(team.model_row_count).toBe(2);
        // The day is capped; the week and the month are not, and their usage
        // is still a real number rather than a blank beside an ∞.
        expect(team.periods.day).toMatchObject({ usedTokens: 400, quotaTokens: 1000 });
        expect(team.periods.week).toMatchObject({ usedTokens: 400, quotaTokens: null });
        expect(team.periods.month).toMatchObject({ usedTokens: 400, quotaTokens: null });

        // The model row is read exactly like the provider row above it, and
        // it is over its own cap while the provider still has room.
        expect(rows[1].periods.day).toMatchObject({ usedTokens: 300, quotaTokens: 200 });
        expect(rows[1].model_row_count).toBe(0);

        // A model needs no limit to be visible. Its spend is still metered,
        // and the null quota renders as uncapped.
        expect(rows[2].periods.day).toMatchObject({ usedTokens: 100, quotaTokens: null });
        expect(rows[2].periods.week).toMatchObject({ usedTokens: 100, quotaTokens: null });

        // Nothing ran on the personal provider, and its cells say zero rather
        // than nothing.
        expect(rows[3].periods.day).toMatchObject({ usedTokens: 0, quotaTokens: null });
    });

    it("the grid's two numbers are your share and everyone's, and never the same one twice", async () => {
        const alice = await makeUser("alice");
        const bob = await makeUser("bob");
        await createShared("team");
        await setLimit("team", "day", null, 1000);
        await sql(`SELECT @cms_provider_set_allowance('team', 20::smallint, NULL, TRUE)`);
        await settle("a1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 150 });
        await settle("b1", 0, { provider: "team", model: "team:gpt", owner: bob, input: 600 });

        const asAlice = await one(`SELECT * FROM @cms_provider_usage_grid($1, FALSE)`, [alice]);
        expect(asAlice.allowance_pct).toBe(20);
        expect(asAlice.periods.day).toMatchObject({
            usedTokens: 750, quotaTokens: 1000,
            yourUsedTokens: 150, yourQuotaTokens: 200,
        });

        // A full allowance makes your share the whole limit.
        await sql(`SELECT @cms_provider_set_allowance('team', 100::smallint, NULL, TRUE)`);
        const full = await one(`SELECT * FROM @cms_provider_usage_grid($1, FALSE)`, [alice]);
        expect(full.periods.day).toMatchObject({ yourUsedTokens: 150, yourQuotaTokens: 1000 });

        // Signed out, "your usage" is not a number at all. Reporting zero
        // would be a claim about somebody.
        const anon = await one(`SELECT * FROM @cms_provider_usage_grid(NULL, FALSE)`);
        expect(anon.periods.day).toMatchObject({
            usedTokens: 750, yourUsedTokens: null, yourQuotaTokens: null,
        });
    });

    it("the grid shows a provider its owner alone can see, and the hold on it", async () => {
        const alice = await makeUser("alice");
        const bob = await makeUser("bob");
        await createPersonal("alice-ghcp", alice);
        await sql(`SELECT @cms_provider_set_hold('alice-ghcp', NULL, TRUE, $1, FALSE)`, [alice]);

        expect(await sql(`SELECT * FROM @cms_provider_usage_grid($1, FALSE)`, [bob])).toEqual([]);
        const mine = await one(`SELECT * FROM @cms_provider_usage_grid($1, FALSE)`, [alice]);
        expect(mine.class).toBe("personal");
        expect(mine.hold_indefinite).toBe(true);

        // An administrator sees that it exists, the same set cms_provider_status shows.
        expect(await sql(`SELECT provider_name FROM @cms_provider_usage_grid(NULL, TRUE)`))
            .toEqual([{ provider_name: "alice-ghcp" }]);
    });
});

// ── readers ──────────────────────────────────────────────────────────

describe("what each surface can read", () => {
    it("a shared provider's totals are open to everyone who may spend", async () => {
        const alice = await makeUser("alice");
        const bob = await makeUser("bob");   // never spends; still reads the total
        await createShared("team");
        await setLimit("team", "day", null, 1000);
        await settle("s1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 400 });

        const asBob = await one(`SELECT * FROM @cms_provider_status($1, FALSE, NULL)`, [bob]);
        expect(asBob.rules[0].usedTokens).toBe(400);
        expect(asBob.rules[0].limitTokens).toBe(1000);
        // Bob's own share of it is his own number, and it is zero.
        expect(asBob.rules[0].yourUsedTokens).toBe(0);
    });

    it("status carries the viewer's ceiling only where an allowance applies", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await setLimit("team", "day", null, 1000);
        let s = await one(`SELECT * FROM @cms_provider_status($1, FALSE, NULL)`, [alice]);
        expect(s.rules[0].ceilingTokens).toBeNull();

        await sql(`SELECT @cms_provider_set_allowance('team', 25::smallint, NULL, TRUE)`);
        s = await one(`SELECT * FROM @cms_provider_status($1, FALSE, NULL)`, [alice]);
        expect(s.rules[0].ceilingTokens).toBe(250);
    });

    it("a personal provider stays out of everyone else's status", async () => {
        const alice = await makeUser("alice");
        const bob = await makeUser("bob");
        await createPersonal("alice-ghcp", alice);
        expect(await sql(`SELECT name FROM @cms_provider_status($1, FALSE, NULL)`, [bob])).toEqual([]);
        expect(await sql(`SELECT name FROM @cms_provider_status($1, FALSE, NULL)`, [alice]))
            .toEqual([{ name: "alice-ghcp" }]);
    });

    it("attribution is clamped for a non-administrator", async () => {
        const alice = await makeUser("alice");
        const bob = await makeUser("bob");
        await createShared("team");
        await settle("s1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 100 });
        await settle("s2", 0, { provider: "team", model: "team:gpt", owner: bob, input: 900 });

        const bobSees = await one(
            `SELECT * FROM @cms_provider_usage_totals($1, FALSE, 7, NULL, NULL, NULL, NULL, NULL)`, [bob]);
        expect(bobSees.tokens_total).toBe("900");

        const adminSees = await one(
            `SELECT * FROM @cms_provider_usage_totals(NULL, TRUE, 7, NULL, NULL, NULL, NULL, NULL)`);
        expect(adminSees.tokens_total).toBe("1000");
    });

    it("a non-administrator cannot widen the report by asking for someone else", async () => {
        const alice = await makeUser("alice");
        const bob = await makeUser("bob");
        await createShared("team");
        await settle("s1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 100 });

        const bobAsksForAlice = await one(
            `SELECT * FROM @cms_provider_usage_totals($1, FALSE, 7, $2, NULL, NULL, NULL, NULL)`,
            [bob, alice]);
        expect(bobAsksForAlice.tokens_total).toBe("0");
    });

    it("the breakdown groups by every dimension the report offers", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "team:gpt", userId: alice });
        await settle("s1", 0, { provider: "team", model: "team:gpt", owner: alice, agentId: "crawler", input: 100 });
        await settle("s1", 1, { provider: "team", model: "team:mini", owner: alice, agentId: "crawler", input: 50 });

        const byModel = await sql(
            `SELECT key, tokens_total FROM @cms_provider_usage_breakdown(NULL,TRUE,7,NULL,NULL,NULL,NULL,NULL,'model',40)`);
        expect(byModel).toEqual([
            { key: "team:gpt", tokens_total: "100" },
            { key: "team:mini", tokens_total: "50" },
        ]);

        const byAgent = await sql(
            `SELECT key, tokens_total FROM @cms_provider_usage_breakdown(NULL,TRUE,7,NULL,NULL,NULL,NULL,NULL,'agent',40)`);
        expect(byAgent).toEqual([{ key: "crawler", tokens_total: "150" }]);
    });

    it("system and unowned turns are named in the user breakdown rather than dropped", async () => {
        await createShared("team");
        await settle("sys", 0, { provider: "team", model: "team:gpt", chargeClass: "system", input: 70 });
        await settle("s2", 0, { provider: "team", model: "team:gpt", owner: null, input: 30 });
        const rows = await sql(
            `SELECT key, tokens_total FROM @cms_provider_usage_breakdown(NULL,TRUE,7,NULL,NULL,NULL,NULL,NULL,'user',40)`);
        expect(rows.map((r) => r.key).sort()).toEqual(["(system)", "(unowned)"]);
    });

    it("paused sessions are listed from the structured record, scoped by who owns them", async () => {
        const alice = await makeUser("alice");
        const bob = await makeUser("bob");
        await createShared("team");
        await makeSession("a1", { model: "team:gpt", userId: alice });
        await makeSession("b1", { model: "team:gpt", userId: bob });
        await setLimit("team", "day", null, 100);
        await settle("a1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 500 });
        await check("a1");
        await check("b1");

        const asAlice = await sql(`SELECT session_id FROM @cms_provider_list_paused($1, FALSE, 100)`, [alice]);
        expect(asAlice).toEqual([{ session_id: "a1" }]);

        const asAdmin = await sql(`SELECT session_id FROM @cms_provider_list_paused(NULL, TRUE, 100)`);
        expect(asAdmin.map((r) => r.session_id).sort()).toEqual(["a1", "b1"]);
    });

    it("the wake query finds exactly the sessions waiting on one provider", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await createShared("other");
        await makeSession("a1", { model: "team:gpt", userId: alice });
        await makeSession("a2", { model: "other:gpt", userId: alice });
        await setLimit("team", "day", null, 10);
        await setLimit("other", "day", null, 10);
        await settle("a1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 500 });
        await check("a1");
        await check("a2");

        expect(await sql(`SELECT session_id FROM @cms_provider_paused_for('team')`))
            .toEqual([{ session_id: "a1" }]);
    });

    it("a session waiting on a missing name is woken by that name appearing", async () => {
        const alice = await makeUser("alice");
        await makeSession("a1", { model: "later:gpt", userId: alice });
        await check("a1");
        expect(await sql(`SELECT session_id FROM @cms_provider_paused_for('later')`))
            .toEqual([{ session_id: "a1" }]);

        await createShared("later");
        expect((await check("a1")).verdict).toBe("clear");
    });
});

// ── defaults and bootstrap ───────────────────────────────────────────

describe("defaults", () => {
    it("the cluster default must be a shared provider", async () => {
        const alice = await makeUser("alice");
        await createPersonal("alice-ghcp", alice);
        const msg = await refusal(
            `SELECT @cms_provider_set_cluster_default('alice-ghcp','alice-ghcp:gpt',NULL,NULL,TRUE)`);
        expect(msg).toMatch(/must be a shared provider/);
    });

    it("only an administrator sets it", async () => {
        await createShared("team");
        expect(await refusal(
            `SELECT @cms_provider_set_cluster_default('team','team:gpt',NULL,NULL,FALSE)`))
            .toMatch(/PROVIDER_FORBIDDEN/);
    });

    it("a person's default may be their own provider, and carries the whole tuple", async () => {
        const alice = await makeUser("alice");
        await createPersonal("alice-ghcp", alice);
        await sql(`SELECT @cms_provider_set_user_default($1,'alice-ghcp','alice-ghcp:claude','high','large')`, [alice]);
        const d = await one(`SELECT * FROM @cms_provider_get_defaults($1)`, [alice]);
        expect(d.my_provider).toBe("alice-ghcp");
        expect(d.my_model).toBe("alice-ghcp:claude");
        expect(d.my_reasoning).toBe("high");
        expect(d.my_context).toBe("large");
    });

    it("a person cannot default to a provider they cannot see", async () => {
        const alice = await makeUser("alice");
        const bob = await makeUser("bob");
        await createPersonal("alice-ghcp", alice);
        expect(await refusal(
            `SELECT @cms_provider_set_user_default($1,'alice-ghcp','alice-ghcp:x',NULL,NULL)`, [bob]))
            .toMatch(/PROVIDER_NOT_FOUND/);
    });

    it("clearing a personal default clears the whole tuple", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await sql(`SELECT @cms_provider_set_user_default($1,'team','team:gpt','high','large')`, [alice]);
        await sql(`SELECT @cms_provider_set_user_default($1,NULL,NULL,NULL,NULL)`, [alice]);
        const d = await one(`SELECT * FROM @cms_provider_get_defaults($1)`, [alice]);
        expect([d.my_provider, d.my_model, d.my_reasoning, d.my_context])
            .toEqual([null, null, null, null]);
    });

    it("the cluster default is readable by someone who has no default of their own", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await sql(`SELECT @cms_provider_set_cluster_default('team','team:gpt','medium','standard',TRUE)`);
        const d = await one(`SELECT * FROM @cms_provider_get_defaults($1)`, [alice]);
        expect(d.cluster_provider).toBe("team");
        expect(d.my_provider).toBeNull();
    });

    it("admission resolves a null session model through personal then cluster defaults", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await createPersonal("alice-ghcp", alice);
        await sql(`SELECT @cms_provider_set_cluster_default('team','team:gpt',NULL,NULL,TRUE)`);

        await makeSession("cluster-default", { userId: alice });
        expect(await check("cluster-default")).toMatchObject({
            verdict: "clear",
            provider_name: "team",
            model_qualified: "team:gpt",
        });
        expect(await one(`SELECT model, model_resolution_source FROM @sessions WHERE session_id='cluster-default'`))
            .toEqual({ model: "team:gpt", model_resolution_source: "cluster_default" });

        await sql(`SELECT @cms_provider_set_user_default($1,'alice-ghcp','alice-ghcp:claude',NULL,NULL)`, [alice]);
        await makeSession("personal-default", { userId: alice });
        expect(await check("personal-default")).toMatchObject({
            verdict: "clear",
            provider_name: "alice-ghcp",
            model_qualified: "alice-ghcp:claude",
        });
        expect(await one(`SELECT model, reasoning_effort, context_tier, model_resolution_source
                            FROM @sessions WHERE session_id='personal-default'`))
            .toEqual({
                model: "alice-ghcp:claude",
                reasoning_effort: null,
                context_tier: null,
                model_resolution_source: "user_default",
            });
    });
});

describe("system routing", () => {
    it("only an admin owner may enable a personal provider for system use", async () => {
        const alice = await makeUser("alice");
        const bob = await makeUser("bob");
        await createPersonal("alice-ghcp", alice);

        expect(await refusal(
            `SELECT @cms_provider_set_system_use('alice-ghcp',TRUE,$1,FALSE)`, [alice]))
            .toMatch(/PROVIDER_FORBIDDEN/);
        expect(await refusal(
            `SELECT @cms_provider_set_system_use('alice-ghcp',TRUE,$1,TRUE)`, [bob]))
            .toMatch(/PROVIDER_NOT_FOUND/);
        expect(await one(
            `SELECT @cms_provider_set_system_use('alice-ghcp',TRUE,$1,TRUE) AS enabled`, [alice]))
            .toEqual({ enabled: true });

        const row = await one(
            `SELECT system_use_enabled, system_use_enabled_by, system_use_enabled_at IS NOT NULL AS stamped
               FROM @provider_instances WHERE name = 'alice-ghcp'`);
        expect(row).toEqual({ system_use_enabled: true, system_use_enabled_by: String(alice), stamped: true });
        expect(await one(
            `SELECT @cms_provider_set_system_use('alice-ghcp',FALSE,$1,FALSE) AS enabled`, [alice]))
            .toEqual({ enabled: false });
    });

    it("a system default accepts shared or enabled admin-owned providers", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await createPersonal("alice-ghcp", alice);

        await sql(`SELECT @cms_provider_set_system_default('team','team:gpt','medium','standard',$1,TRUE)`, [alice]);
        let d = await one(`SELECT * FROM @cms_provider_get_defaults($1)`, [alice]);
        expect([d.system_provider, d.system_model, d.system_reasoning, d.system_context])
            .toEqual(["team", "team:gpt", "medium", "standard"]);

        expect(await refusal(
            `SELECT @cms_provider_set_system_default('alice-ghcp','alice-ghcp:claude',NULL,NULL,$1,TRUE)`, [alice]))
            .toMatch(/not enabled for system sessions/);
        await sql(`SELECT @cms_provider_set_system_use('alice-ghcp',TRUE,$1,TRUE)`, [alice]);
        await sql(`SELECT @cms_provider_set_system_default('alice-ghcp','alice-ghcp:claude','high','large',$1,TRUE)`, [alice]);
        d = await one(`SELECT * FROM @cms_provider_get_defaults($1)`, [alice]);
        expect([d.system_provider, d.system_model]).toEqual(["alice-ghcp", "alice-ghcp:claude"]);

        await makeSession("system-personal", { model: "alice-ghcp:claude", isSystem: true });
        expect(await check("system-personal")).toMatchObject({
            verdict: "clear",
            provider_name: "alice-ghcp",
            exempt: true,
        });
        await makeSession("ownerless-ordinary", { model: "alice-ghcp:claude" });
        expect((await check("ownerless-ordinary")).verdict).toBe("no_provider");
    });

    it("system-agent overrides are persistent, listable, and clearable", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await sql(`SELECT @cms_provider_set_system_agent_model('sweeper','team','team:gpt','low','standard',$1,TRUE)`, [alice]);

        expect(await sql(`SELECT agent_id, provider_name, model_qualified, reasoning_effort, context_tier
                            FROM @cms_provider_list_system_agent_models()`))
            .toEqual([{ agent_id: "sweeper", provider_name: "team", model_qualified: "team:gpt", reasoning_effort: "low", context_tier: "standard" }]);
        expect(await one(`SELECT @cms_provider_clear_system_agent_model('sweeper',$1,TRUE) AS cleared`, [alice]))
            .toEqual({ cleared: true });
        expect(await sql(`SELECT 1 FROM @system_agent_model_overrides`)).toHaveLength(0);
    });

    it("system routing dependencies must be cleared before disabling or deleting a provider", async () => {
        const alice = await makeUser("alice");
        await createPersonal("alice-ghcp", alice);
        await sql(`SELECT @cms_provider_set_system_use('alice-ghcp',TRUE,$1,TRUE)`, [alice]);
        await sql(`SELECT @cms_provider_set_system_default('alice-ghcp','alice-ghcp:claude',NULL,NULL,$1,TRUE)`, [alice]);

        expect(await refusal(
            `SELECT @cms_provider_set_system_use('alice-ghcp',FALSE,$1,TRUE)`, [alice]))
            .toMatch(/PROVIDER_IN_USE/);
        expect(await refusal(
            `SELECT @cms_provider_delete('alice-ghcp',$1,TRUE)`, [alice]))
            .toMatch(/PROVIDER_IN_USE/);

        const cleared = await one(
            `SELECT @cms_provider_clear_routing_dependencies('alice-ghcp',$1,TRUE) AS result`, [alice]);
        expect(cleared.result).toMatchObject({ systemDefault: 1 });
        await sql(`SELECT @cms_provider_set_system_use('alice-ghcp',FALSE,$1,TRUE)`, [alice]);
        await sql(`SELECT @cms_provider_delete('alice-ghcp',$1,TRUE)`, [alice]);
        expect(await sql(`SELECT 1 FROM @provider_instances WHERE name = 'alice-ghcp'`)).toHaveLength(0);
    });

    it("provider listings expose system eligibility without widening ordinary access", async () => {
        const alice = await makeUser("alice");
        const bob = await makeUser("bob");
        await createShared("team");
        await createPersonal("alice-ghcp", alice);
        await sql(`SELECT @cms_provider_set_system_use('alice-ghcp',TRUE,$1,TRUE)`, [alice]);

        const mine = await sql(`SELECT name, usable_by_me, system_use_enabled, system_eligible
                                  FROM @cms_provider_list($1,FALSE) ORDER BY name`, [alice]);
        expect(mine).toEqual([
            { name: "alice-ghcp", usable_by_me: true, system_use_enabled: true, system_eligible: true },
            { name: "team", usable_by_me: true, system_use_enabled: false, system_eligible: true },
        ]);
        const theirs = await sql(`SELECT name, usable_by_me FROM @cms_provider_list($1,FALSE) ORDER BY name`, [bob]);
        expect(theirs).toEqual([{ name: "team", usable_by_me: true }]);
    });
});

describe("system restart rollout claims", () => {
    it("serializes concurrent callers and lets a failed operation retry idempotently", async () => {
        const firstClaims = await Promise.all([
            one(`SELECT @cms_provider_claim_system_restart('sweeper','op1','claim1','team:gpt',NULL,NULL,'terminate') AS result`),
            one(`SELECT @cms_provider_claim_system_restart('sweeper','op2','claim2','team:gpt',NULL,NULL,'terminate') AS result`),
        ]);
        expect(firstClaims.map((row) => row.result).sort()).toEqual(["busy", "claimed"]);
        const winningClaim = firstClaims[0].result === "claimed" ? "claim1" : "claim2";
        expect(await one(`SELECT @cms_provider_finish_system_restart('sweeper','claim1','start failed') AS finished`))
            .toEqual({ finished: winningClaim === "claim1" });
        if (winningClaim === "claim2") {
            expect(await one(`SELECT @cms_provider_finish_system_restart('sweeper','claim2','start failed') AS finished`))
                .toEqual({ finished: true });
        }
        expect(await one(`SELECT @cms_provider_claim_system_restart('sweeper','op1','claim3','team:gpt',NULL,NULL,'terminate') AS result`))
            .toEqual({ result: "claimed" });
        expect(await one(`SELECT @cms_provider_finish_system_restart('sweeper','claim3',NULL) AS finished`))
            .toEqual({ finished: true });
        expect(await one(`SELECT @cms_provider_claim_system_restart('sweeper','op1','claim4','team:gpt',NULL,NULL,'terminate') AS result`))
            .toEqual({ result: "complete" });
        expect(await one(`SELECT @cms_provider_claim_system_restart('sweeper','op2','claim5','team:gpt',NULL,NULL,'terminate') AS result`))
            .toEqual({ result: "claimed" });
    });
});

describe("the deployment bootstrap runs once", () => {
    const SEED = JSON.stringify([
        { name: "azure-openai", typeId: "azure-openai", secretRef: { apiKey: "env:AZURE_OAI_KEY" } },
    ]);
    const DEF = JSON.stringify({ provider: "azure-openai", model: "azure-openai:gpt-5.4", reasoning: "medium" });

    it("seeds providers and the default on a fresh cluster", async () => {
        const r = await one(`SELECT * FROM @cms_provider_bootstrap($1::jsonb, $2::jsonb)`, [SEED, DEF]);
        expect(r.claimed).toBe(true);
        expect(r.created).toBe(1);
        const d = await one(`SELECT * FROM @cms_provider_get_defaults(NULL)`);
        expect(d.cluster_provider).toBe("azure-openai");
        expect(d.cluster_model).toBe("azure-openai:gpt-5.4");
    });

    it("never runs twice, so a deleted provider stays deleted across restarts", async () => {
        await sql(`SELECT * FROM @cms_provider_bootstrap($1::jsonb, $2::jsonb)`, [SEED, DEF]);
        await sql(`SELECT @cms_provider_set_cluster_default(NULL,NULL,NULL,NULL,TRUE)`);
        await sql(`SELECT @cms_provider_delete('azure-openai', NULL, TRUE)`);

        const second = await one(`SELECT * FROM @cms_provider_bootstrap($1::jsonb, $2::jsonb)`, [SEED, DEF]);
        expect(second.claimed).toBe(false);
        expect(await sql(`SELECT 1 FROM @provider_instances`)).toHaveLength(0);
    });

    it("several pods booting at once seed exactly once", async () => {
        const results = await Promise.all(Array.from({ length: 6 }, () =>
            one(`SELECT * FROM @cms_provider_bootstrap($1::jsonb, $2::jsonb)`, [SEED, DEF])));
        expect(results.filter((r) => r.claimed)).toHaveLength(1);
        expect(await sql(`SELECT 1 FROM @provider_instances`)).toHaveLength(1);
    });

    it("a malformed entry rolls back the whole seed and leaves it retryable", async () => {
        const mixed = JSON.stringify([
            { name: "bad:name", typeId: "azure-openai" },
            { name: "good", typeId: "azure-openai" },
        ]);
        expect(await refusal(`SELECT * FROM @cms_provider_bootstrap($1::jsonb, NULL)`, [mixed]))
            .toMatch(/PROVIDER_INVALID/);
        expect(await sql(`SELECT name FROM @provider_instances`)).toEqual([]);
        expect(await sql(`SELECT provider_name FROM @provider_bootstrap_receipts`)).toEqual([]);

        const good = JSON.stringify([{ name: "good", typeId: "azure-openai" }]);
        expect(await one(`SELECT * FROM @cms_provider_bootstrap($1::jsonb, NULL)`, [good]))
            .toEqual({ claimed: true, created: 1 });
    });

    it("a later better-provisioned process can seed providers the first process lacked", async () => {
        const first = JSON.stringify([{ name: "azure", typeId: "azure-openai" }]);
        const later = JSON.stringify([
            { name: "azure", typeId: "azure-openai" },
            { name: "github", typeId: "github-copilot" },
        ]);
        expect(await one(`SELECT * FROM @cms_provider_bootstrap($1::jsonb, NULL)`, [first]))
            .toEqual({ claimed: true, created: 1 });
        expect(await one(`SELECT * FROM @cms_provider_bootstrap($1::jsonb, NULL)`, [later]))
            .toEqual({ claimed: true, created: 1 });
        expect((await sql(`SELECT name FROM @provider_instances ORDER BY name`)).map((row) => row.name))
            .toEqual(["azure", "github"]);
    });
});
