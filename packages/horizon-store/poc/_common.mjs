// poc/_common.mjs — shared helpers for the HorizonDB PoCs.
// Reads HORIZON_DATABASE_URL from the environment (.env is loaded by the npm
// script via --env-file when present; otherwise export it yourself).

import pg from "pg";

export const SCHEMA = "horizon_facts_poc";

export function requireUrl() {
    const url = process.env.HORIZON_DATABASE_URL;
    if (!url) {
        console.error(
            "HORIZON_DATABASE_URL is not set. Copy .env.example to .env and point it\n" +
            "at a HorizonDB (preview) instance, then run with `node --env-file=.env ...`.",
        );
        process.exit(2);
    }
    return url;
}

export async function connect() {
    const client = new pg.Client({ connectionString: requireUrl() });
    await client.connect();
    return client;
}

let pass = 0;
let fail = 0;

export function check(label, condition) {
    if (condition) {
        pass++;
        console.log(`  ✔ ${label}`);
    } else {
        fail++;
        console.error(`  ✖ ${label}`);
    }
}

export function summarize(name) {
    console.log(`\n${name}: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

/** Insert a fact row into the PoC facts table. */
export async function seedFact(client, f) {
    const scopeKey = f.shared ? `shared:${f.key}` : `session:${f.session_id ?? ""}:${f.key}`;
    await client.query(
        `INSERT INTO ${SCHEMA}.facts (scope_key, key, value, agent_id, session_id, shared, tags)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (scope_key) DO UPDATE SET value = EXCLUDED.value`,
        [scopeKey, f.key, JSON.stringify(f.value), f.agent_id ?? null, f.session_id ?? null, !!f.shared, f.tags ?? []],
    );
    return scopeKey;
}
