#!/usr/bin/env node
// Drain report for the frozen-orchestration cohort.
//
// Sessions still on a frozen orchestration version behave badly under budget
// pauses: the wake delivers their queued prompt (verified live), but the
// frozen schedule then RE-ARMS a stale wait whose label describes a
// restriction that no longer exists. A session only leaves the cohort by
// continuing-as-new at its own history boundary — there is no forced
// upgrade. So the operational moves are:
//
//   1. know the census (this report),
//   2. complete long-idle cohort sessions so they can never hit the gate
//      (--complete-idle-days, explicit and admin-authorized),
//   3. hold every limit/hold/allowance until the census is clean
//      (the Phase-6 hard gate in providers-and-budgets-chk-plan.md).
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/drain-orchestration-versions.mjs
//       [--cms-schema copilot_sessions] [--duroxide-schema ps_duroxide]
//       [--complete-idle-days N --api-url http://... ]
//
// Completion goes through the Web API (PILOTSWARM_API_TOKEN must carry the
// admin role) so the orchestration ends properly — never through SQL.

import pg from "pg";

const args = process.argv.slice(2);
function argValue(name, fallback = null) {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(1);
}
const CMS = argValue("--cms-schema", "copilot_sessions");
const DUROXIDE = argValue("--duroxide-schema", "ps_duroxide");
const completeIdleDays = argValue("--complete-idle-days");
const apiUrl = argValue("--api-url");

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
try {
    const census = await pool.query(
        `SELECT orchestration_version, count(*)::int AS n
           FROM "${DUROXIDE}".instances GROUP BY 1 ORDER BY 1 DESC`);
    const latest = census.rows[0]?.orchestration_version ?? "(none)";
    console.log("orchestration census (latest first):");
    for (const row of census.rows) {
        console.log(`  ${row.orchestration_version}  ${row.n}`);
    }

    const cohort = await pool.query(
        `SELECT ss.session_id, ss.state, ss.is_system, ss.model,
                i.orchestration_version,
                COALESCE(ss.last_active_at, ss.updated_at) AS last_active,
                (ss.pause_state IS NOT NULL) AS paused
           FROM "${DUROXIDE}".instances i
           JOIN "${CMS}".sessions ss
             ON i.instance_id = 'session-' || ss.session_id
          WHERE i.orchestration_version <> $1
            AND ss.deleted_at IS NULL
            AND ss.state NOT IN ('completed', 'failed', 'cancelled')
          ORDER BY last_active DESC`, [latest]);

    console.log(`\ncohort behind ${latest}: ${cohort.rows.length} live session(s)`);
    for (const row of cohort.rows) {
        const age = Math.round((Date.now() - new Date(row.last_active).getTime()) / 86_400_000);
        console.log(`  ${row.session_id.slice(0, 8)}  ${row.orchestration_version}`
            + `  ${row.state}${row.paused ? " PAUSED" : ""}${row.is_system ? " SYSTEM" : ""}`
            + `  idle ${age}d  ${row.model ?? ""}`);
    }
    if (cohort.rows.length === 0) {
        console.log("\ncensus clean: limits, holds and allowances are safe to set.");
        process.exit(0);
    }
    console.log(
        "\nwhile any cohort session is live, budget pauses on it deliver the"
        + "\nqueued prompt but re-arm a stale wait afterwards. Hold limits until"
        + "\nthis list is empty (they drain by running turns, or by completion).");

    if (completeIdleDays !== null) {
        if (!apiUrl || !process.env.PILOTSWARM_API_TOKEN) {
            console.error("\n--complete-idle-days needs --api-url and PILOTSWARM_API_TOKEN (admin)");
            process.exit(1);
        }
        const cutoffMs = Number(completeIdleDays) * 86_400_000;
        const targets = cohort.rows.filter((row) =>
            !row.is_system
            && Date.now() - new Date(row.last_active).getTime() >= cutoffMs);
        console.log(`\ncompleting ${targets.length} non-system session(s) idle >= ${completeIdleDays}d:`);
        for (const row of targets) {
            const response = await fetch(
                `${apiUrl}/api/v1/management/sessions/${row.session_id}/complete`,
                {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        authorization: `Bearer ${process.env.PILOTSWARM_API_TOKEN}`,
                    },
                    body: JSON.stringify({ reason: `orchestration-version drain (idle >= ${completeIdleDays}d)` }),
                },
            ).catch((err) => ({ ok: false, status: String(err) }));
            console.log(`  ${row.session_id.slice(0, 8)}  ${response.ok ? "completed" : `FAILED ${response.status}`}`);
        }
    }
} finally {
    await pool.end();
}
