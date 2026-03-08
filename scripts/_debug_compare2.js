#!/usr/bin/env node
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const pg = require("pg");
async function main() {
    const c = new pg.Client(process.env.DATABASE_URL);
    await c.connect();
    
    const sessions = [
        { name: "pilotswarm", id: "session-ad23bbff-9516-d2f6-dfa0-687d5914d0f5" },
        { name: "sweeper", id: "session-4dcda26a-c9d2-8050-1c63-c51fa06dd159" },
        { name: "resourcemgr", id: "session-9dd58119-a0fd-3d7a-9810-822b388a402c" },
    ];
    
    for (const s of sessions) {
        // Find first ActivityCompleted via SQL JSON extraction
        const r = await c.query(
            "SELECT event_data::text FROM duroxide.history WHERE instance_id = $1 AND event_data::text LIKE '%ActivityCompleted%' ORDER BY event_id ASC LIMIT 1",
            [s.id]
        );
        
        if (r.rows.length === 0) {
            console.log("[" + s.name + "] NO ActivityCompleted found");
            continue;
        }
        
        const data = JSON.parse(r.rows[0].event_data);
        const result = JSON.parse(data.result);
        const usage = (result.events || []).find(function(e) { return e.eventType === "session.usage_info"; });
        const error = (result.events || []).find(function(e) { return e.eventType === "session.error"; });
        console.log("[" + s.name + "] type=" + result.type + ' content="' + (result.content || "").slice(0, 80) + '"');
        if (usage) console.log("  tokens=" + usage.data.currentTokens + " msgs=" + usage.data.messagesLength + " limit=" + usage.data.tokenLimit);
        if (error) console.log("  ERROR: " + (error.data.message || "").slice(0, 200));
    }
    
    await c.end();
}
main().catch(function(e) { console.error("ERR:", e.message); process.exit(1); });
