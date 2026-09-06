/**
 * Provider budgets — the adversarial regressions.
 *
 * Every test here exists because an attack found something the first suite
 * could not see. Four agents with non-overlapping scopes (accounting,
 * security, edges, and the quality of the tests themselves) ran against a
 * live database and reported 27 findings, each with a repro. These pin the
 * fixes, and close the coverage holes the fourth agent found — including
 * several tests that passed against a broken implementation.
 *
 * The lesson worth keeping: the first suite was 81 green tests and the
 * schema still had a lost-update race that let a hard limit stop enforcing.
 * Green is not the same as covered.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { runCmsMigrations } from "../../src/cms-migrator.ts";

const DATABASE_URL = process.env.PS_TEST_DATABASE_URL
    || process.env.TEST_DATABASE_URL
    || "postgresql://postgres:postgres@localhost:5432/pilotswarm";

const SCHEMA = `ps_test_cms_providerbudgetsadv_${randomBytes(4).toString("hex")}`;
let pool;

async function sql(text, params = []) {
    // `@` stands for the test schema, but only where a schema can go: after
    // a boundary and before an identifier. A plain replaceAll also rewrote
    // the one inside 'alice@example.test', which quietly mangled every email
    // in the fixtures until a test asserted on one.
    const q = text.replace(/(^|[^\w"'])@([a-z_])/g, `$1"${SCHEMA}".$2`);
    const r = await pool.query(q, params);
    return r.rows;
}
const one = async (t, p = []) => (await sql(t, p))[0];
async function refusal(text, params = []) {
    try { await sql(text, params); } catch (err) { return String(err.message || ""); }
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
async function makeSession(sessionId, { model = null, userId = null, isSystem = false, state = "idle" } = {}) {
    await sql(`INSERT INTO @sessions (session_id, model, is_system, state)
               VALUES ($1,$2,$3,$4) ON CONFLICT (session_id) DO UPDATE
               SET model = EXCLUDED.model, state = EXCLUDED.state`,
        [sessionId, model, isSystem, state]);
    if (userId !== null) {
        await sql(`INSERT INTO @session_owners (session_id, user_id) VALUES ($1,$2)
                   ON CONFLICT (session_id) DO UPDATE SET user_id = EXCLUDED.user_id`,
            [sessionId, userId]);
    }
}
const check = (sessionId, model = null) =>
    one(`SELECT * FROM @cms_provider_check_turn($1,$2)`, [sessionId, model]);
const settle = (sessionId, turnIndex, o = {}) =>
    one(`SELECT @cms_provider_settle_turn($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS first`,
        [sessionId, turnIndex, o.provider ?? null, o.model ?? null, o.owner ?? null,
            o.chargeClass ?? "user", o.agentId ?? null,
            o.input ?? 0, o.output ?? 0, o.cacheRead ?? 0, o.cacheWrite ?? 0])
        .then((r) => r.first);
const createShared = (name, o = {}) =>
    sql(`SELECT * FROM @cms_provider_create($1,$2,'shared',NULL,$3,NULL,$4,$5)`,
        [name, o.type ?? "azure", JSON.stringify(o.secret ?? { apiKey: "k" }), o.actor ?? null, o.isAdmin ?? true]);
const createPersonal = (name, owner, o = {}) =>
    sql(`SELECT * FROM @cms_provider_create($1,$2,'personal',$3,$4,NULL,$5,$6)`,
        [name, o.type ?? "github", o.declaredOwner === undefined ? owner : o.declaredOwner,
            JSON.stringify({ token: "t" }), o.actor === undefined ? owner : o.actor, o.isAdmin ?? false]);
const setLimit = (name, period, model, tokens, o = {}) =>
    one(`SELECT * FROM @cms_provider_set_limit($1,$2,$3,$4,$5,$6,$7)`,
        [name, period, model, tokens, `r_${randomBytes(6).toString("hex")}`, o.actor ?? null, o.isAdmin ?? true]);

/** One meter: provider, period, scope ('*' for all models), current window. */
async function meter(name, period = "day", scope = "*") {
    const row = await one(
        `SELECT m.used_tokens FROM @provider_meters m
          CROSS JOIN LATERAL @cms_provider_window_bounds($2, now()) wb
          WHERE m.provider_name = $1 AND m.period = $2 AND m.scope = $3
            AND m.window_key_utc = wb.window_key`, [name, period, scope]);
    return row === undefined ? null : Number(row.used_tokens);
}

beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
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
                        @provider_instances, @session_owners, @sessions, @users
               RESTART IDENTITY CASCADE`);
    await sql(`UPDATE @provider_cluster_settings
                  SET default_provider=NULL, default_model=NULL, default_reasoning=NULL,
                      default_context=NULL, bootstrapped_at=NULL WHERE singleton`);
});

// ── accounting ───────────────────────────────────────────────────────

describe("a limit keeps enforcing while the world moves", () => {
    it("saving a limit writes no meter at all — there is nothing left to race", async () => {
        // The critical finding of the first adversarial pass lived HERE:
        // seeding re-derived a counter from the ledger, a read then an
        // ASSIGN, so a turn committing between the two had its charge
        // overwritten. A hard limit stopped enforcing and the two counters
        // disagreed for the rest of the window.
        //
        // It is gone by construction rather than by lock ordering: saving a
        // limit no longer writes a counter, so there is no write to lose.
        const alice = await makeUser("alice");
        await createShared("team");
        await settle("x", 0, { provider: "team", model: "team:gpt", owner: alice, input: 700 });
        const before = await one(
            `SELECT count(*) AS n, sum(used_tokens) AS t, max(updated_at) AS u FROM @provider_meters`);

        await setLimit("team", "day", null, 1000);
        await setLimit("team", "week", "team:gpt", 1000);
        await setLimit("team", "month", null, 1000);

        const after = await one(
            `SELECT count(*) AS n, sum(used_tokens) AS t, max(updated_at) AS u FROM @provider_meters`);
        expect(after.n).toBe(before.n);
        expect(after.t).toBe(before.t);
        expect(after.u.toISOString()).toBe(before.u.toISOString());
    });

    it("a turn settling while a limit is being saved is counted exactly once", async () => {
        // The exact collision the old race lost a charge to, staged so it
        // cannot pass by luck. The meter row already exists and holds 100, so
        // any save that reads a number and then assigns it back would BLOCK
        // on the uncommitted settle, wake up, and write 100 over 877.
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "team:gpt", userId: alice });
        await settle("warm", 0, { provider: "team", model: "team:gpt", owner: alice, input: 100 });

        const client = await pool.connect();
        let saved;
        try {
            await client.query("BEGIN");
            await client.query(
                `SELECT "${SCHEMA}".cms_provider_settle_turn('s1',0,'team','team:gpt',$1,'user',NULL,777,0,0,0)`,
                [alice]);
            saved = setLimit("team", "day", null, 500);
            await new Promise((r) => setTimeout(r, 250));
            await client.query("COMMIT");
        } finally {
            client.release();
        }
        await saved;

        expect(await meter("team")).toBe(877);
        // 877 against a limit of 500: the next turn waits, which is the exact
        // thing the lost update used to break.
        const v = await check("s1");
        expect(v.verdict).toBe("paused");
        expect(Number(v.pause.usedTokens)).toBe(877);
    });

    it("the two meters never disagree", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await settle("x", 0, { provider: "team", model: "team:gpt", owner: alice, input: 700 });
        await setLimit("team", "day", null, 5000);
        const total = await one(`SELECT used_tokens FROM @provider_meters
                                  WHERE period = 'day' AND scope = '*'`);
        const mine = await one(`SELECT used_tokens FROM @provider_meters_user
                                 WHERE period = 'day' AND scope = '*' AND user_id = $1`, [alice]);
        expect(total.used_tokens).toBe(mine.used_tokens);
    });

    it("a re-created name does NOT inherit the spend of the provider that held it", async () => {
        // The documented rescue is to create the name again. The meters
        // reference the provider, so deleting it takes them; a name that
        // comes back starts at zero and releases the session it was meant to.
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "team:gpt", userId: alice });
        await settle("s1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 900 });
        await sql(`SELECT @cms_provider_delete('team', NULL, TRUE)`);

        await createShared("team");
        expect(await sql(`SELECT 1 FROM @provider_meters`)).toHaveLength(0);
        const { seeded_tokens } = await setLimit("team", "day", null, 1000);
        expect(Number(seeded_tokens)).toBe(0);
        expect((await check("s1")).verdict).toBe("clear");
    });

    it("settlement survives a limit being removed at the same moment", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await setLimit("team", "day", null, 1_000_000);
        const results = await Promise.allSettled([
            settle("s1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 100 }),
            sql(`SELECT @cms_provider_remove_limit('team','day',NULL,NULL,TRUE)`),
        ]);
        // Whichever order they land in, the turn is never charged an error.
        expect(results.filter((r) => r.status === "rejected")).toEqual([]);
        expect(await meter("team")).toBe(100);
    });

    it("settlement survives the PROVIDER being deleted at the same moment", async () => {
        // A meter references its provider, so a turn settling against a name
        // that has just gone has nothing to move. It must still record the
        // turn rather than fail on a foreign key — the tokens were spent
        // whether or not the credential still exists.
        const alice = await makeUser("alice");
        await createShared("team");
        const results = await Promise.allSettled([
            settle("s1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 100 }),
            sql(`SELECT @cms_provider_delete('team', NULL, TRUE)`),
        ]);
        expect(results.filter((r) => r.status === "rejected")).toEqual([]);
        expect(await sql(`SELECT 1 FROM @provider_usage_ledger`)).toHaveLength(1);

        // And once it is really gone, a later settle is still accepted.
        expect(await settle("s2", 0, { provider: "team", model: "team:gpt", owner: alice, input: 50 }))
            .toBe(true);
    });

    it("an enormous limit does not overflow the allowance ceiling", async () => {
        // bigint * percentage overflows before the division brings it back,
        // and the error surfaced from the ADMISSION gate — which fails open —
        // and killed the whole status read for every provider at once.
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "team:gpt", userId: alice });
        await setLimit("team", "day", null, "9223372036854775807");
        await sql(`SELECT @cms_provider_set_allowance('team', 50::smallint, NULL, TRUE)`);
        expect((await check("s1")).verdict).toBe("clear");
        const status = await one(`SELECT * FROM @cms_provider_status($1, FALSE, NULL)`, [alice]);
        expect(status.rules[0].ceilingTokens).toBeGreaterThan(0);
    });
});

describe("meters belong to their window", () => {
    it("last window's usage does not block this window", async () => {
        // The suite could not tell a working reset from a limit that never
        // resets: nothing tied window bounds to what admission reads.
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "team:gpt", userId: alice });
        await setLimit("team", "day", null, 100);

        const prev = await one(
            `SELECT * FROM @cms_provider_window_bounds('day', now() - interval '1 day')`);
        await sql(`INSERT INTO @provider_meters
                       (provider_name, period, scope, window_key_utc, used_tokens,
                        window_start_utc, resets_at_utc)
                   VALUES ('team','day','*',$1,$2,$3,$4)`,
            [prev.window_key, 999_999, prev.window_start, prev.resets_at]);

        expect((await check("s1")).verdict).toBe("clear");
    });

    it("this window's usage does block, so the previous test proves a reset", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "team:gpt", userId: alice });
        await setLimit("team", "day", null, 100);
        const now = await one(`SELECT * FROM @cms_provider_window_bounds('day', now())`);
        await sql(`INSERT INTO @provider_meters
                       (provider_name, period, scope, window_key_utc, used_tokens,
                        window_start_utc, resets_at_utc)
                   VALUES ('team','day','*',$1,999999,$2,$3)`,
            [now.window_key, now.window_start, now.resets_at]);
        expect((await check("s1")).verdict).toBe("paused");
    });

    it("a new limit reads this window's meter only", async () => {
        // Usage is no longer re-derived from the ledger, so this is now a
        // fact about the METER: a row belongs to the window it was written
        // in, and last window's row is not what a new limit measures.
        await createShared("team");
        await settle("old", 0, { provider: "team", model: "team:gpt", input: 5000 });
        const prev = await one(
            `SELECT * FROM @cms_provider_window_bounds('day', now() - interval '1 day')`);
        await sql(`UPDATE @provider_meters
                      SET window_key_utc = $1, window_start_utc = $2, resets_at_utc = $3
                    WHERE period = 'day'`,
            [prev.window_key, prev.window_start, prev.resets_at]);

        await settle("new", 0, { provider: "team", model: "team:gpt", input: 70 });
        const { seeded_tokens } = await setLimit("team", "day", null, 1000);
        expect(Number(seeded_tokens)).toBe(70);
        // The week meter never moved windows, so it still holds both turns.
        expect(await meter("team", "week")).toBe(5070);
    });
});

describe("machinery is exempt in a way that can be observed", () => {
    it("a system session runs against a limit that is genuinely exhausted", async () => {
        // The old test never let the limit be reached, so 'never paused' was
        // never actually exercised — an implementation that paused system
        // sessions would have passed it.
        const alice = await makeUser("alice");
        await createShared("team");
        await setLimit("team", "day", null, 100);
        await makeSession("human", { model: "team:gpt", userId: alice });
        await makeSession("sys", { model: "team:gpt", isSystem: true });
        await settle("human", 0, { provider: "team", model: "team:gpt", owner: alice, input: 5000 });

        expect((await check("human")).verdict).toBe("paused");
        const machinery = await check("sys");
        expect(machinery.verdict).toBe("clear");
        expect(machinery.exempt).toBe(true);
    });

    it("system spend moves no meter, so a limit made afterwards still reads zero", async () => {
        // Both halves, or 'never counted against limits' is one-sided: the
        // machinery must be invisible to the running total AND to whatever a
        // limit sees the moment it is created.
        await createShared("team");
        await settle("sys", 0, { provider: "team", model: "team:gpt", chargeClass: "system", input: 50_000 });
        expect(await sql(`SELECT 1 FROM @provider_meters`)).toHaveLength(0);
        const { seeded_tokens } = await setLimit("team", "day", null, 1000);
        expect(Number(seeded_tokens)).toBe(0);

        // The ledger still has it: recorded and shown, just never charged.
        expect(await one(`SELECT tokens_total FROM @provider_usage_ledger`))
            .toEqual({ tokens_total: "50000" });
    });
});

describe("holds", () => {
    it("a hold with a future end pauses, and stops pausing when it passes", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "team:gpt", userId: alice });
        await sql(`SELECT @cms_provider_set_hold('team', now() + interval '1 hour', FALSE, NULL, TRUE)`);
        const held = await check("s1");
        expect(held.verdict).toBe("paused");
        expect(held.pause.kind).toBe("hold");
        expect(held.pause.resetsAtUtc).toBeTruthy();

        await sql(`UPDATE @provider_instances SET hold_until_utc = now() - interval '1 second'`);
        expect((await check("s1")).verdict).toBe("clear");
    });

    it("an indefinite hold reports no end at all", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "team:gpt", userId: alice });
        await sql(`SELECT @cms_provider_set_hold('team', NULL, TRUE, NULL, TRUE)`);
        const v = await check("s1");
        expect(v.pause.resetsAtUtc).toBeNull();
    });

    it("an indefinite hold outranks a past end date", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "team:gpt", userId: alice });
        await sql(`SELECT @cms_provider_set_hold('team', now() - interval '1 day', TRUE, NULL, TRUE)`);
        expect((await check("s1")).verdict).toBe("paused");
    });
});

// ── who may do what ──────────────────────────────────────────────────

describe("a personal provider answers to its owner alone", () => {
    it("nobody can create one in someone else's name", async () => {
        // p_owner is an argument, and an argument is a wish. Honouring it let
        // anyone plant a credential inside another person's namespace, where
        // their sessions would resolve it and spend through it.
        const alice = await makeUser("alice");
        const bob = await makeUser("bob");
        const msg = await refusal(
            `SELECT * FROM @cms_provider_create('sneaky','github','personal',$1,'{"token":"t"}'::jsonb,NULL,$2,FALSE)`,
            [alice, bob]);
        expect(msg).toMatch(/PROVIDER_FORBIDDEN/);
        expect(await sql(`SELECT 1 FROM @provider_instances`)).toHaveLength(0);
    });

    it("an administrator cannot either", async () => {
        const alice = await makeUser("alice");
        const ada = await makeUser("ada");
        await refusal(
            `SELECT * FROM @cms_provider_create('sneaky','github','personal',$1,'{}'::jsonb,NULL,$2,TRUE)`,
            [alice, ada]);
        expect(await sql(`SELECT 1 FROM @provider_instances`)).toHaveLength(0);
    });

    it("an administrator cannot limit, hold or delete another person's provider", async () => {
        // Being an administrator is authority over the cluster's own
        // credentials, not over one somebody brought from home.
        const alice = await makeUser("alice");
        const ada = await makeUser("ada");
        await createPersonal("alice-ghcp", alice);
        for (const call of [
            [`SELECT * FROM @cms_provider_set_limit('alice-ghcp','day',NULL,10,'r1',$1,TRUE)`, [ada]],
            [`SELECT @cms_provider_set_hold('alice-ghcp', NULL, TRUE, $1, TRUE)`, [ada]],
            [`SELECT @cms_provider_delete('alice-ghcp', $1, TRUE)`, [ada]],
            [`SELECT @cms_provider_set_allowance('alice-ghcp', 50::smallint, $1, TRUE)`, [ada]],
        ]) {
            expect(await refusal(call[0], call[1])).toMatch(/PROVIDER_NOT_FOUND/);
        }
        expect(await sql(`SELECT 1 FROM @provider_instances`)).toHaveLength(1);
    });

    it("the owner still can", async () => {
        const alice = await makeUser("alice");
        await createPersonal("alice-ghcp", alice);
        await setLimit("alice-ghcp", "day", null, 5000, { actor: alice, isAdmin: false });
        await sql(`SELECT @cms_provider_set_hold('alice-ghcp', NULL, TRUE, $1, FALSE)`, [alice]);
        expect(Number(await one(`SELECT @cms_provider_delete('alice-ghcp', $1, FALSE) AS w`, [alice])
            .then((r) => r.w))).toBe(0);
    });
});

// ── edges ────────────────────────────────────────────────────────────

describe("references that name no provider", () => {
    for (const [label, model] of [
        ["an unqualified name", "gpt-5.4"],
        ["a leading colon", ":gpt-5.4"],
        ["only a colon", ":"],
        ["an empty model", ""],
        ["no model at all", null],
    ]) {
        it(`${label} answers rather than throwing`, async () => {
            // A RECORD that was never assigned raises when a field is read,
            // and the read sat behind an OR whose short-circuiting Postgres
            // does not promise. A throw here reaches a gate that fails OPEN,
            // so the session would have run unbudgeted.
            const alice = await makeUser("alice");
            await createShared("team");
            await makeSession("s1", { model, userId: alice });
            const v = await check("s1");
            expect(v.verdict).toBe("no_provider");
        });
    }

    it("a model name containing a colon still resolves its provider", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "team:org/model:v2", userId: alice });
        const v = await check("s1");
        expect(v.verdict).toBe("clear");
        expect(v.provider_name).toBe("team");
    });
});

describe("sessions that have finished are not waiting", () => {
    it("a completed session leaves 'paused now' and the wake list", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "team:gpt", userId: alice });
        await setLimit("team", "day", null, 10);
        await settle("s1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 500 });
        await check("s1");
        expect(await sql(`SELECT session_id FROM @cms_provider_list_paused(NULL, TRUE, 100)`))
            .toEqual([{ session_id: "s1" }]);

        await sql(`UPDATE @sessions SET state = 'completed' WHERE session_id = 's1'`);
        expect(await sql(`SELECT session_id FROM @cms_provider_list_paused(NULL, TRUE, 100)`)).toEqual([]);
        expect(await sql(`SELECT session_id FROM @cms_provider_paused_for('team')`)).toEqual([]);
    });

    it("deleting a provider counts only sessions that could still run", async () => {
        await createShared("team");
        await makeSession("live", { model: "team:gpt" });
        await makeSession("done", { model: "team:gpt", state: "completed" });
        await makeSession("failed", { model: "team:gpt", state: "failed" });
        const row = await one(`SELECT @cms_provider_delete('team', NULL, TRUE) AS waiting`);
        expect(Number(row.waiting)).toBe(1);
    });

    it("the wake query is scoped to the provider named in the pause", async () => {
        // The old test had every session paused by the same provider, so a
        // proc that ignored the filter entirely would have passed it.
        const alice = await makeUser("alice");
        await createShared("alpha");
        await createShared("beta");
        await makeSession("a1", { model: "alpha:gpt", userId: alice });
        await makeSession("b1", { model: "beta:gpt", userId: alice });
        await setLimit("alpha", "day", null, 10);
        await setLimit("beta", "day", null, 10);
        await settle("a1", 0, { provider: "alpha", model: "alpha:gpt", owner: alice, input: 500 });
        await settle("b1", 0, { provider: "beta", model: "beta:gpt", owner: alice, input: 500 });
        await check("a1");
        await check("b1");

        expect(await sql(`SELECT session_id FROM @cms_provider_paused_for('alpha')`))
            .toEqual([{ session_id: "a1" }]);
        expect(await sql(`SELECT session_id FROM @cms_provider_paused_for('beta')`))
            .toEqual([{ session_id: "b1" }]);
    });
});

describe("a pause is reported only while its cause still holds", () => {
    // Found live: a hold was released and the session was still reported as
    // held by it. pause_state is a CACHE, written by the gate and cleared by
    // the gate on the session's next turn — so on a session that is slow,
    // stopped, or asleep on its timer, the record outlives the cause, and the
    // very act of releasing the hold looks like it did nothing.
    async function heldSession() {
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "team:gpt", userId: alice, state: "waiting" });
        await sql(`SELECT @cms_provider_set_hold('team', NULL, TRUE, NULL, TRUE)`);
        await check("s1");
        return alice;
    }

    it("a released hold stops being reported, without the session running again", async () => {
        await heldSession();
        expect(await sql(`SELECT session_id FROM @cms_provider_list_paused(NULL, TRUE, 100)`))
            .toEqual([{ session_id: "s1" }]);

        await sql(`SELECT @cms_provider_set_hold('team', NULL, FALSE, NULL, TRUE)`);
        // No turn has run, so the record is untouched — and must no longer be
        // reported, because what it claims is no longer true.
        const stale = await one(`SELECT pause_state FROM @sessions WHERE session_id='s1'`);
        expect(stale.pause_state).toMatchObject({ kind: "hold" });
        expect(await sql(`SELECT session_id FROM @cms_provider_list_paused(NULL, TRUE, 100)`))
            .toEqual([]);
    });

    it("but the WAKE still finds it, or nothing would ever tell the session to look", async () => {
        await heldSession();
        await sql(`SELECT @cms_provider_set_hold('team', NULL, FALSE, NULL, TRUE)`);
        expect(await sql(`SELECT session_id FROM @cms_provider_paused_for('team')`))
            .toEqual([{ session_id: "s1" }]);
    });

    it("a raised limit stops being reported; one that still bites keeps being", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "team:gpt", userId: alice, state: "waiting" });
        await setLimit("team", "day", null, 100);
        await settle("s1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 500 });
        await check("s1");
        expect(await sql(`SELECT session_id FROM @cms_provider_list_paused(NULL, TRUE, 100)`))
            .toEqual([{ session_id: "s1" }]);

        await setLimit("team", "day", null, 200);   // still under 500 spent
        expect(await sql(`SELECT session_id FROM @cms_provider_list_paused(NULL, TRUE, 100)`))
            .toEqual([{ session_id: "s1" }]);

        await setLimit("team", "day", null, 10_000);
        expect(await sql(`SELECT session_id FROM @cms_provider_list_paused(NULL, TRUE, 100)`))
            .toEqual([]);
    });

    it("removing the limit entirely also settles it", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "team:gpt", userId: alice, state: "waiting" });
        await setLimit("team", "day", null, 100);
        await settle("s1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 500 });
        await check("s1");
        await sql(`SELECT @cms_provider_remove_limit('team','day',NULL,NULL,TRUE)`);
        expect(await sql(`SELECT session_id FROM @cms_provider_list_paused(NULL, TRUE, 100)`))
            .toEqual([]);
    });

    it("a widened allowance stops being reported", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "team:gpt", userId: alice, state: "waiting" });
        await setLimit("team", "day", null, 1_000_000);
        await sql(`SELECT @cms_provider_set_allowance('team', 20::smallint, NULL, TRUE)`);
        await settle("s1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 250_000 });
        await check("s1");
        expect(await sql(`SELECT session_id FROM @cms_provider_list_paused(NULL, TRUE, 100)`))
            .toEqual([{ session_id: "s1" }]);

        await sql(`SELECT @cms_provider_set_allowance('team', 90::smallint, NULL, TRUE)`);
        expect(await sql(`SELECT session_id FROM @cms_provider_list_paused(NULL, TRUE, 100)`))
            .toEqual([]);
    });

    it("a name that came back stops being reported as missing", async () => {
        const alice = await makeUser("alice");
        await makeSession("s1", { model: "later:gpt", userId: alice, state: "waiting" });
        await check("s1");
        expect(await sql(`SELECT session_id FROM @cms_provider_list_paused(NULL, TRUE, 100)`))
            .toEqual([{ session_id: "s1" }]);

        await createShared("later");
        expect(await sql(`SELECT session_id FROM @cms_provider_list_paused(NULL, TRUE, 100)`))
            .toEqual([]);
    });

    it("a provider deleted under a paused session keeps it reported — it is still stuck", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await makeSession("s1", { model: "team:gpt", userId: alice, state: "waiting" });
        await setLimit("team", "day", null, 100);
        await settle("s1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 500 });
        await check("s1");
        await sql(`SELECT @cms_provider_delete('team', NULL, TRUE)`);
        expect(await sql(`SELECT session_id FROM @cms_provider_list_paused(NULL, TRUE, 100)`))
            .toEqual([{ session_id: "s1" }]);
    });
});

describe("the bootstrap is loud when the file is wrong", () => {
    it("a default naming a provider that was never seeded rolls the whole seed back", async () => {
        // Swallowing this left a cluster claimed, half-seeded and permanently
        // without a default — with nothing in any log to say why.
        const seed = JSON.stringify([{ name: "azure", typeId: "azure" }]);
        const bad = JSON.stringify({ provider: "typo", model: "typo:gpt" });
        await refusal(`SELECT * FROM @cms_provider_bootstrap($1::jsonb,$2::jsonb)`, [seed, bad]);

        const s = await one(`SELECT bootstrapped_at FROM @provider_cluster_settings`);
        expect(s.bootstrapped_at).toBeNull();
        expect(await sql(`SELECT 1 FROM @provider_instances`)).toHaveLength(0);

        // And the next boot, with the file fixed, succeeds.
        const good = JSON.stringify({ provider: "azure", model: "azure:gpt" });
        const r = await one(`SELECT * FROM @cms_provider_bootstrap($1::jsonb,$2::jsonb)`, [seed, good]);
        expect(r.claimed).toBe(true);
    });
});

// ── defaults ─────────────────────────────────────────────────────────

describe("a scope that could never match is refused, not saved", () => {
    it("a per-model limit must name a model of THIS provider", async () => {
        // A limit scoped to one model matches the QUALIFIED reference a
        // session runs. A bare name matched nothing: it saved, showed in the
        // report as a live cap, and silently never fired.
        await createShared("team");
        const msg = await refusal(
            `SELECT * FROM @cms_provider_set_limit('team','day','gpt-5.4',100,'r1',NULL,TRUE)`);
        expect(msg).toMatch(/PROVIDER_INVALID/);
        expect(msg).toMatch(/team:<model>/);
        expect(await sql(`SELECT 1 FROM @provider_budget_rules`)).toHaveLength(0);

        // Another provider's model is refused for the same reason.
        await createShared("other");
        expect(await refusal(
            `SELECT * FROM @cms_provider_set_limit('team','day','other:gpt',100,'r1',NULL,TRUE)`))
            .toMatch(/PROVIDER_INVALID/);

        // The qualified form saves.
        const ok = await setLimit("team", "day", "team:gpt-5.4", 100);
        expect(ok.rule_id).toBeTruthy();
    });

    it("removing a limit checks the period, instead of reporting nothing was there", async () => {
        await createShared("team");
        await setLimit("team", "day", null, 100);
        expect(await refusal(
            `SELECT @cms_provider_remove_limit('team','daily',NULL,NULL,TRUE)`))
            .toMatch(/PROVIDER_INVALID/);
        // And the limit it meant to remove is still in force.
        expect(await sql(`SELECT 1 FROM @provider_budget_rules`)).toHaveLength(1);
    });

    it("a default's model must belong to the provider beside it", async () => {
        // A session runs the MODEL half, so a tuple naming a shared provider
        // beside somebody's personal model reference would put the machinery
        // on a private credential — through the half nobody checked.
        const alice = await makeUser("alice");
        await createShared("team");
        await createPersonal("alice-ghcp", alice);

        expect(await refusal(
            `SELECT @cms_provider_set_cluster_default('team','alice-ghcp:claude',NULL,NULL,TRUE)`))
            .toMatch(/must belong to "team"/);
        expect(await refusal(
            `SELECT @cms_provider_set_user_default($1,'team','alice-ghcp:claude',NULL,NULL)`, [alice]))
            .toMatch(/must belong to "team"/);

        const d = await one(`SELECT * FROM @cms_provider_get_defaults($1)`, [alice]);
        expect(d.cluster_provider).toBeNull();
        expect(d.my_provider).toBeNull();
    });
});

describe("a default is a whole tuple or nothing", () => {
    it("a provider with no model is refused rather than silently ignored", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        expect(await refusal(
            `SELECT @cms_provider_set_cluster_default('team',NULL,NULL,NULL,TRUE)`))
            .toMatch(/PROVIDER_INVALID/);
        expect(await refusal(
            `SELECT @cms_provider_set_user_default($1,'team',NULL,NULL,NULL)`, [alice]))
            .toMatch(/PROVIDER_INVALID/);
    });
});

// ── reporting ────────────────────────────────────────────────────────

describe("the usage report answers what it is asked", () => {
    async function twoDays() {
        const alice = await makeUser("alice");
        await createShared("alpha");
        await createShared("beta");
        await makeSession("s1", { model: "alpha:gpt", userId: alice, state: "idle" });
        await sql(`UPDATE @sessions SET title = 'A session' WHERE session_id = 's1'`);
        await settle("s1", 0, { provider: "alpha", model: "alpha:gpt", owner: alice, agentId: "crawler", input: 100 });
        await settle("s1", 1, { provider: "beta", model: "beta:mini", owner: alice, agentId: "sweeper", input: 40 });
        await sql(`UPDATE @provider_usage_ledger SET created_at = now() - interval '20 days'
                    WHERE turn_index = 1`);
        return alice;
    }

    it("the date range actually excludes older rows", async () => {
        await twoDays();
        const week = await one(
            `SELECT * FROM @cms_provider_usage_totals(NULL,TRUE,7,NULL,NULL,NULL,NULL,NULL)`);
        const month = await one(
            `SELECT * FROM @cms_provider_usage_totals(NULL,TRUE,30,NULL,NULL,NULL,NULL,NULL)`);
        expect(week.tokens_total).toBe("100");
        expect(month.tokens_total).toBe("140");
    });

    it("every filter narrows what it names", async () => {
        const alice = await twoDays();
        const totals = (args) => one(
            `SELECT * FROM @cms_provider_usage_totals(NULL,TRUE,30,$1,$2,$3,$4,$5)`, args);
        expect((await totals([null, "alpha", null, null, null])).tokens_total).toBe("100");
        expect((await totals([null, null, "beta:mini", null, null])).tokens_total).toBe("40");
        expect((await totals([null, null, null, "s1", null])).tokens_total).toBe("140");
        expect((await totals([alice, null, null, null, null])).tokens_total).toBe("140");
        expect((await totals([null, null, null, null, "system"])).tokens_total).toBe("0");
    });

    it("the daily series has a row per day of usage", async () => {
        await twoDays();
        const days = await sql(
            `SELECT * FROM @cms_provider_usage_daily(NULL,TRUE,30,NULL,NULL,NULL,NULL,NULL)`);
        expect(days).toHaveLength(2);
        expect(days.map((d) => d.tokens_total).sort()).toEqual(["100", "40"]);
    });

    it("every dimension groups, and sessions and people are named not numbered", async () => {
        const alice = await twoDays();
        const dim = (d) => sql(
            `SELECT key, label, tokens_total FROM @cms_provider_usage_breakdown(NULL,TRUE,30,NULL,NULL,NULL,NULL,NULL,$1,40)`,
            [d]);
        expect((await dim("provider")).map((r) => r.key).sort()).toEqual(["alpha", "beta"]);
        expect((await dim("model")).map((r) => r.key).sort()).toEqual(["alpha:gpt", "beta:mini"]);
        expect((await dim("agent")).map((r) => r.key).sort()).toEqual(["crawler", "sweeper"]);

        const bySession = await dim("session");
        expect(bySession[0].key).toBe("s1");
        expect(bySession[0].label).toBe("A session");

        const byUser = await dim("user");
        expect(byUser[0].key).toBe(String(alice));
        expect(byUser[0].label).toBe("alice");
    });

    it("the row cap is honoured", async () => {
        await createShared("team");
        for (let i = 0; i < 5; i++) {
            await settle(`s${i}`, 0, { provider: "team", model: `team:m${i}`, input: 10 + i });
        }
        const rows = await sql(
            `SELECT key FROM @cms_provider_usage_breakdown(NULL,TRUE,7,NULL,NULL,NULL,NULL,NULL,'model',3)`);
        expect(rows).toHaveLength(3);
    });

    it("a shared provider's own total is open to everyone, but not who spent it", async () => {
        const alice = await makeUser("alice");
        const bob = await makeUser("bob");
        await createShared("team");
        await settle("s1", 0, { provider: "team", model: "team:gpt", owner: alice, input: 900 });

        // Bob spent nothing, and can still read what the shared provider has
        // spent — otherwise its limit is a number he cannot plan against.
        const asBob = await one(
            `SELECT * FROM @cms_provider_usage_totals($1,FALSE,7,NULL,'team',NULL,NULL,NULL)`, [bob]);
        expect(asBob.tokens_total).toBe("900");

        // Attribution stays private: the breakdown still shows him his own.
        const whoBob = await sql(
            `SELECT key FROM @cms_provider_usage_breakdown($1,FALSE,7,NULL,'team',NULL,NULL,NULL,'user',40)`,
            [bob]);
        expect(whoBob).toEqual([]);
    });

    it("naming a shared provider opens its TOTAL, never one person's share of it", async () => {
        // The dangerous combination, found by a live audit: a shared
        // provider's total is public, so naming one opened every row — and
        // ownerUserId then narrowed that open set to one person. User ids
        // are small integers, so the whole cluster was enumerable in a loop.
        const alice = await makeUser("alice");
        const bob = await makeUser("bob");
        await createShared("team");
        await settle("sa", 0, { provider: "team", model: "team:gpt", owner: alice, input: 100 });
        await settle("sb", 0, { provider: "team", model: "team:gpt", owner: bob, input: 777_777 });

        const asAlice = (owner, session) => one(
            `SELECT * FROM @cms_provider_usage_totals($1,FALSE,7,$2,'team',NULL,$3,NULL)`,
            [alice, owner, session]);

        // The question she may ask.
        expect((await asAlice(null, null)).tokens_total).toBe("777877");
        // Her own share of it.
        expect((await asAlice(alice, null)).tokens_total).toBe("100");
        // Bob's, by user and by session. Both are attribution, both admin-only.
        expect((await asAlice(bob, null)).tokens_total).toBe("0");
        expect((await asAlice(null, "sb")).tokens_total).toBe("0");

        // The daily series leaks the same thing in a different shape — when
        // somebody worked, and on which days.
        const days = await sql(
            `SELECT * FROM @cms_provider_usage_daily($1,FALSE,7,$2,'team',NULL,NULL,NULL)`,
            [alice, bob]);
        expect(days).toEqual([]);

        // An administrator still gets the real answer.
        expect((await one(
            `SELECT * FROM @cms_provider_usage_totals(NULL,TRUE,7,$1,'team',NULL,NULL,NULL)`,
            [bob])).tokens_total).toBe("777777");
    });

    it("a personal provider's total is not open to anyone else", async () => {
        const alice = await makeUser("alice");
        const bob = await makeUser("bob");
        await createPersonal("alice-ghcp", alice);
        await settle("s1", 0, { provider: "alice-ghcp", model: "alice-ghcp:gpt", owner: alice, input: 900 });
        const asBob = await one(
            `SELECT * FROM @cms_provider_usage_totals($1,FALSE,7,NULL,'alice-ghcp',NULL,NULL,NULL)`, [bob]);
        expect(asBob.tokens_total).toBe("0");
    });
});

describe("the provider list describes each provider truthfully", () => {
    it("its derived columns say what is actually true", async () => {
        const alice = await makeUser("alice");
        await createShared("team", { secret: { apiKey: "env:X" } });
        await createShared("bare", { secret: {} });
        await createPersonal("alice-ghcp", alice);
        await setLimit("team", "day", null, 100);
        await sql(`SELECT @cms_provider_set_cluster_default('team','team:gpt',NULL,NULL,TRUE)`);
        await sql(`SELECT @cms_provider_set_user_default($1,'alice-ghcp','alice-ghcp:x',NULL,NULL)`, [alice]);

        const rows = Object.fromEntries(
            (await sql(`SELECT * FROM @cms_provider_list($1, FALSE)`, [alice])).map((r) => [r.name, r]));

        expect(rows.team.has_credential).toBe(true);
        expect(rows.bare.has_credential).toBe(false);
        expect(Number(rows.team.rule_count)).toBe(1);
        expect(Number(rows.bare.rule_count)).toBe(0);
        expect(rows.team.is_cluster_default).toBe(true);
        expect(rows.bare.is_cluster_default).toBe(false);
        expect(rows["alice-ghcp"].is_my_default).toBe(true);
        expect(rows.team.is_my_default).toBe(false);
        expect(rows["alice-ghcp"].owner_email).toBe("alice@example.test");
        expect(rows.team.owner_email).toBeNull();
    });

    it("a signed-out viewer sees the shared providers and nobody's own", async () => {
        const alice = await makeUser("alice");
        await createShared("team");
        await createPersonal("alice-ghcp", alice);
        const rows = await sql(`SELECT name, usable_by_me FROM @cms_provider_list(NULL, FALSE)`);
        expect(rows).toEqual([{ name: "team", usable_by_me: true }]);
    });
});

// Drive the agent handler through the real SQL authority and admission gate.
describe("agent budget release", () => {
    it("wakes only the authorized pool and still enforces remaining caps before admitting", async () => {
        const { ProviderStore } = await import("../../src/provider-store.ts");
        const { createProviderTools } = await import("../../src/provider-tools.ts");
        const { PROVIDER_BUDGET_WAKE_PROMPT } = await import("../../src/provider-budgets.ts");
        const alice = await makeUser("alice"), bob = await makeUser("bob");
        await createPersonal("alice-pool", alice);
        await createPersonal("bob-pool", bob);
        await createShared("team");
        for (const [id, provider, owner] of [["a", "alice-pool", alice], ["b", "bob-pool", bob], ["t", "team", alice]]) {
            await makeSession(id, { model: `${provider}:opus`, userId: owner });
            await setLimit(provider, "month", `${provider}:opus`, 10, { actor: owner, isAdmin: true });
            await settle(id, 0, { provider, model: `${provider}:opus`, owner, input: 20 });
            expect((await check(id)).verdict).toBe("paused");
        }
        await setLimit("alice-pool", "day", null, 10, { actor: alice });
        const store = new ProviderStore(pool, SCHEMA);
        const wakes = [];
        const tools = new Map(createProviderTools({
            catalog: { providers: store }, resolveViewer: () => ({ userId: alice, isAdmin: false }),
            duroxideClient: { enqueueEvent: async (id, queue, payload) => wakes.push({ id, queue, payload }) },
        }).map((tool) => [tool.name, tool]));
        const remove = (provider, period, model) => tools.get("set_provider_limit").handler({ provider, period, model, tokens: null });
        expect(await remove("bob-pool", "month", "bob-pool:opus")).toMatchObject({ code: "PROVIDER_NOT_FOUND" });
        expect(await remove("team", "month", "team:opus")).toMatchObject({ code: "PROVIDER_FORBIDDEN" });
        expect(wakes).toEqual([]);
        expect(await remove("alice-pool", "month", "alice-pool:opus")).toEqual({ removed: true });
        expect(wakes).toEqual([{ id: "session-a", queue: "messages", payload: JSON.stringify({ prompt: PROVIDER_BUDGET_WAKE_PROMPT }) }]);
        expect((await check("a")).verdict).toBe("paused");
        expect(await remove("alice-pool", "day", undefined)).toEqual({ removed: true });
        expect((await check("a")).verdict).toBe("clear");
        expect((await check("b")).verdict).toBe("paused");
        expect((await check("t")).verdict).toBe("paused");
        expect(wakes).toHaveLength(2);
        await remove("alice-pool", "day", undefined);
        expect(wakes).toHaveLength(2);
    });
});
