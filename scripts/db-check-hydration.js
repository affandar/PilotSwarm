#!/usr/bin/env node

/**
 * Check if a session was dehydrated/hydrated.
 * Usage: node --env-file=.env scripts/db-check-hydration.js
 */

import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

try {
    // Check duroxide history for dehydrate/hydrate activity events
    const { rows } = await pool.query(`
        SELECT e.instance_id, e.event_type, e.event_data::text, e.created_at
        FROM duroxide.history e
        WHERE e.event_data::text ILIKE '%dehydrate%' OR e.event_data::text ILIKE '%hydrate%'
        ORDER BY e.created_at DESC
        LIMIT 20
    `);

    console.log("\nDuroxide history (hydrate/dehydrate):");
    if (rows.length === 0) {
        console.log("  (none found — session did NOT dehydrate)");
    }
    for (const r of rows) {
        let label = "";
        try {
            const data = JSON.parse(r.event_data);
            label = data.Name || data.name || JSON.stringify(data).slice(0, 100);
        } catch { label = r.event_data.slice(0, 100); }
        console.log(`  [${r.created_at.toISOString()}] ${r.event_type} — ${label}`);
    }

    // Check orchestration instances
    const { rows: insts } = await pool.query(`
        SELECT i.instance_id, e.status
        FROM duroxide.instances i
        JOIN duroxide.executions e
          ON e.instance_id = i.instance_id
          AND e.execution_id = i.current_execution_id
        ORDER BY i.updated_at DESC
        LIMIT 5
    `);
    console.log("\nOrchestration instances:");
    for (const i of insts) {
        console.log(`  ${i.instance_id} — ${i.status}`);
    }

    // Check CMS session state
    const { rows: sessions } = await pool.query(`
        SELECT session_id, state, current_iteration, updated_at
        FROM copilot_sessions.sessions
        WHERE deleted_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 5
    `);
    console.log("\nCMS sessions:");
    for (const s of sessions) {
        console.log(`  ${s.session_id.slice(0, 8)}… — state=${s.state} iter=${s.current_iteration} updated=${s.updated_at.toISOString()}`);
    }

    console.log("");
} finally {
    await pool.end();
}
