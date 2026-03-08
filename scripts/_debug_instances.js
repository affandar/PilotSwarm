#!/usr/bin/env node
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const pg = require("pg");
async function main() {
    const c = new pg.Client(process.env.DATABASE_URL);
    await c.connect();
    
    // List all duroxide instances
    const r = await c.query("SELECT instance_id FROM duroxide.instances");
    console.log("INSTANCES:", r.rows.map(x => x.instance_id));
    
    // List all history events
    const r2 = await c.query("SELECT instance_id, event_id, event_type FROM duroxide.history ORDER BY instance_id, event_id LIMIT 50");
    for (const row of r2.rows) {
        console.log(`  ${row.instance_id} #${row.event_id} ${row.event_type}`);
    }
    
    await c.end();
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
