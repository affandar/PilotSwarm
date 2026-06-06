// Migration-strategy verification against the live HorizonDB.
//
// SAFETY: never touches `duroxide`, `df`, or pg_durable state. Uses throwaway
// schema names (ps_mig_src / ps_mig_dst) and a name-specific guard, then cleans
// up everything it creates. Verifies:
//   1. ALTER SCHEMA ... RENAME inside a tx is atomic + lossless (data survives)
//   2. rename + guard commit together (variant a: event trigger; variant b: tombstone+REVOKE)
//   3. event trigger filtering on object_identity blocks ONLY the retired name
//   4. whether HorizonDB (managed) even ALLOWS CREATE EVENT TRIGGER (superuser?)
//   5. tombstone + REVOKE CREATE blocks table creation for a non-owner role
//
// Run: node scripts/verify-schema-migration.mjs   (with HORIZON_DATABASE_URL set)

import pg from "pg";

const RAW = process.env.HORIZON_DATABASE_URL;
if (!RAW) { console.error("HORIZON_DATABASE_URL not set"); process.exit(1); }
const URL = RAW + (RAW.includes("?") ? "&" : "?") + "uselibpqcompat=true";

const SRC = "ps_mig_src";
const DST = "ps_mig_dst";
const TRIG = "ps_mig_guard";
const FN = "ps_mig_guard_fn";

const results = [];
function rec(name, ok, detail = "") { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`); }

const pool = new pg.Pool({ connectionString: URL, max: 2 });

async function q(c, sql, params) { return c.query(sql, params); }
async function silent(c, sql) { try { await c.query(sql); } catch { /* ignore */ } }

async function cleanup(c) {
    await silent(c, `DROP EVENT TRIGGER IF EXISTS ${TRIG}`);
    await silent(c, `DROP FUNCTION IF EXISTS ${FN}() CASCADE`);
    await silent(c, `DROP SCHEMA IF EXISTS ${SRC} CASCADE`);
    await silent(c, `DROP SCHEMA IF EXISTS ${DST} CASCADE`);
}

const main = async () => {
    const c = await pool.connect();
    try {
        const who = (await q(c, `SELECT current_user, current_database(), session_user`)).rows[0];
        const su = (await q(c, `SELECT rolsuper FROM pg_roles WHERE rolname = current_user`)).rows[0];
        console.log(`connected as ${who.current_user} (super=${su?.rolsuper}) db=${who.current_database}\n`);

        await cleanup(c);

        // ── Seed a fake "old orchestration" schema with data ──────────────────
        await q(c, `CREATE SCHEMA ${SRC}`);
        await q(c, `CREATE TABLE ${SRC}.instances (id text primary key, payload jsonb)`);
        await q(c, `INSERT INTO ${SRC}.instances VALUES ('i1','{"a":1}'),('i2','{"b":2}')`);
        const seeded = (await q(c, `SELECT count(*)::int n FROM ${SRC}.instances`)).rows[0].n;
        rec("seed source schema with 2 rows", seeded === 2, `rows=${seeded}`);

        // ── Test 1: atomic rename inside a transaction, data preserved ────────
        await q(c, "BEGIN");
        await q(c, `SELECT pg_advisory_xact_lock(hashtext('ps-mig-test'))`);
        await q(c, `ALTER SCHEMA ${SRC} RENAME TO ${DST}`);
        await q(c, "COMMIT");
        const moved = (await q(c, `SELECT count(*)::int n FROM ${DST}.instances`)).rows[0].n;
        const srcGone = (await q(c, `SELECT count(*)::int n FROM information_schema.schemata WHERE schema_name=$1`, [SRC])).rows[0].n === 0;
        rec("rename preserves rows (lossless)", moved === 2, `rows=${moved}`);
        rec("source name no longer exists after rename", srcGone);

        // ── Test 2 (variant a): can we CREATE EVENT TRIGGER at all on HorizonDB? ──
        let eventTriggerAllowed = false;
        try {
            await q(c, `CREATE OR REPLACE FUNCTION ${FN}() RETURNS event_trigger LANGUAGE plpgsql AS $$
                DECLARE r record;
                BEGIN
                    FOR r IN SELECT object_identity FROM pg_event_trigger_ddl_commands() LOOP
                        IF r.object_identity = '${SRC}' THEN
                            RAISE EXCEPTION 'schema % is retired; use ${DST}', '${SRC}';
                        END IF;
                    END LOOP;
                END $$;`);
            await q(c, `CREATE EVENT TRIGGER ${TRIG} ON ddl_command_end WHEN TAG IN ('CREATE SCHEMA') EXECUTE FUNCTION ${FN}()`);
            eventTriggerAllowed = true;
            rec("CREATE EVENT TRIGGER permitted on HorizonDB", true);
        } catch (e) {
            rec("CREATE EVENT TRIGGER permitted on HorizonDB", false, e.message.split("\n")[0]);
        }

        // ── Test 3: event-trigger guard blocks ONLY the retired name ──────────
        if (eventTriggerAllowed) {
            let blocked = false;
            try { await q(c, `CREATE SCHEMA ${SRC}`); }
            catch (e) { blocked = /retired/.test(e.message); }
            rec("guard blocks recreation of retired schema", blocked);
            // and that the offending tx rolled back (schema not created)
            const stillGone = (await q(c, `SELECT count(*)::int n FROM information_schema.schemata WHERE schema_name=$1`, [SRC])).rows[0].n === 0;
            rec("blocked CREATE rolled back (no shadow schema)", stillGone);
            // a DIFFERENT schema name must still be creatable (filter is name-specific)
            let otherOk = false;
            try { await q(c, `CREATE SCHEMA ps_mig_other`); await silent(c, `DROP SCHEMA ps_mig_other CASCADE`); otherOk = true; }
            catch { otherOk = false; }
            rec("guard does NOT block other schema names", otherOk);
            await silent(c, `DROP EVENT TRIGGER IF EXISTS ${TRIG}`);
            await silent(c, `DROP FUNCTION IF EXISTS ${FN}() CASCADE`);
        }

        // ── Test 4 (variant b): tombstone schema + REVOKE CREATE (PaaS-friendly) ──
        // Recreate an empty tombstone owned by current role; prove a non-owner
        // role cannot add tables. Use a transient unprivileged role if allowed.
        let tombstoneOk = false, revokeProven = false, roleCreated = false;
        const testRole = "ps_mig_role";
        try {
            await q(c, `CREATE SCHEMA ${SRC}`);          // tombstone (empty)
            await q(c, `REVOKE CREATE ON SCHEMA ${SRC} FROM PUBLIC`);
            tombstoneOk = true;
            try {
                await q(c, `CREATE ROLE ${testRole} NOLOGIN`);
                roleCreated = true;
                await q(c, `GRANT USAGE ON SCHEMA ${SRC} TO ${testRole}`); // usage but NOT create
                await q(c, "BEGIN");
                await q(c, `SET LOCAL ROLE ${testRole}`);
                let denied = false;
                try { await q(c, `CREATE TABLE ${SRC}.shadow (x int)`); }
                catch (e) { denied = /permission denied/i.test(e.message); }
                await q(c, "ROLLBACK");
                revokeProven = denied;
            } catch (e) {
                console.log(`  (role test skipped: ${e.message.split("\n")[0]})`);
            }
        } catch (e) {
            console.log(`  (tombstone test error: ${e.message.split("\n")[0]})`);
        }
        rec("tombstone schema creatable + REVOKE CREATE", tombstoneOk);
        if (roleCreated) rec("REVOKE CREATE denies non-owner table creation", revokeProven);
        else rec("REVOKE CREATE denies non-owner table creation", false, "could not create test role (no CREATEROLE) — variant (b) needs separate role mgmt");

        // cleanup the role
        if (roleCreated) { await silent(c, `REVOKE USAGE ON SCHEMA ${SRC} FROM ${testRole}`); await silent(c, `DROP ROLE ${testRole}`); }

        await cleanup(c);

        const fails = results.filter((r) => !r.ok);
        console.log(`\n${results.length - fails.length}/${results.length} checks passed`);
        process.exitCode = fails.length === 0 ? 0 : 2;
    } finally {
        c.release();
        await pool.end();
    }
};

main().catch((e) => { console.error("FATAL", e.message); process.exit(1); });
