const { createRequire } = require("module");
const req = createRequire(process.cwd() + "/package.json");
const { PostgresProvider, Client } = req("duroxide");
const { Pool } = require("pg");

(async () => {
    const provider = await PostgresProvider.connect(process.env.DATABASE_URL);
    const client = new Client(provider);
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: true });

    const ids = await client.listAllInstances();
    const sessionIds = ids.filter((i) => i.startsWith("session-"));
    console.log("Total instances:", ids.length, "| Sessions:", sessionIds.length);

    for (const id of sessionIds) {
        const info = await client.getInstanceInfo(id);
        const status = await client.getStatus(id);
        let cs;
        try { cs = JSON.parse(status.customStatus); } catch {}
        console.log("---");
        console.log("Session:", id.slice(8, 16));
        console.log("  Status:", info.status, "| ExecutionId:", info.currentExecutionId);
        console.log("  Created:", new Date(info.createdAt).toISOString());
        console.log("  Updated:", new Date(info.updatedAt).toISOString());
        if (cs) {
            console.log("  CS.status:", cs.status, "| Iteration:", cs.iteration);
            if (cs.waitReason) console.log("  WaitReason:", cs.waitReason);
        }
    }

    // Query activity session assignments
    console.log("\n=== Activity Session Affinity (copilot_sdk.sessions) ===");
    try {
        const res = await pool.query(`
            SELECT table_name FROM information_schema.tables 
            WHERE table_schema = 'copilot_sdk' 
            ORDER BY table_name
        `);
        console.log("Tables in copilot_sdk:", res.rows.map(r => r.table_name).join(", "));
    } catch (e) {
        console.log("Schema query failed:", e.message);
    }

    // Try to find session-to-worker mapping
    try {
        const res = await pool.query(`
            SELECT * FROM copilot_sdk.sessions LIMIT 5
        `);
        console.log("\nSessions table columns:", Object.keys(res.rows[0] || {}));
        for (const row of res.rows) {
            console.log("  ", JSON.stringify(row).slice(0, 200));
        }
    } catch (e) {
        console.log("Sessions table:", e.message);
    }

    // Check activity history for worker routing
    try {
        const res = await pool.query(`
            SELECT * FROM copilot_sdk.activities 
            ORDER BY created_at DESC LIMIT 10
        `);
        if (res.rows.length > 0) {
            console.log("\n=== Recent Activities ===");
            console.log("Columns:", Object.keys(res.rows[0]));
            for (const row of res.rows) {
                const inst = (row.instance_id || "").slice(8, 16);
                console.log(
                    "  inst:", inst,
                    "| task:", (row.task_name || row.name || "?").slice(0, 20),
                    "| session:", (row.session_key || row.session_id || "?").toString().slice(0, 12),
                    "| worker:", (row.worker_id || row.locked_by || "?").toString().slice(-10)
                );
            }
        }
    } catch (e) {
        console.log("Activities table:", e.message);
    }

    // Check worker node registrations
    try {
        const res = await pool.query(`
            SELECT * FROM copilot_sdk.worker_nodes LIMIT 10
        `);
        if (res.rows.length > 0) {
            console.log("\n=== Worker Nodes ===");
            for (const row of res.rows) {
                console.log("  ", JSON.stringify(row).slice(0, 200));
            }
        }
    } catch (e) {
        // Try alternate table names
    }

    // Query the execution history to see continueAsNew with changing affinity keys
    try {
        const res = await pool.query(`
            SELECT instance_id, execution_id, input, created_at
            FROM copilot_sdk.executions
            WHERE instance_id LIKE 'session-%'
            ORDER BY instance_id, execution_id
        `);
        if (res.rows.length > 0) {
            console.log("\n=== Execution History (continueAsNew chain) ===");
            let prevInst = "";
            for (const row of res.rows) {
                const inst = row.instance_id.slice(8, 16);
                if (inst !== prevInst) {
                    console.log(`\n  Session ${inst}:`);
                    prevInst = inst;
                }
                let input;
                try { input = JSON.parse(row.input); } catch { input = {}; }
                const affinityKey = (input.affinityKey || "?").slice(0, 8);
                const needsHydration = input.needsHydration ? "HYDRATE" : "warm";
                const iter = input.iteration || 0;
                const hasPendingTimer = input.pendingTimer ? `timer:${input.pendingTimer.seconds}s` : "";
                const dehydrated = input.pendingTimer?.dehydrated ? " DEHYDRATED" : "";
                console.log(
                    `    exec ${String(row.execution_id).padStart(2)}:`,
                    `affinity=${affinityKey}`,
                    `iter=${iter}`,
                    needsHydration,
                    hasPendingTimer + dehydrated,
                    `| ${new Date(row.created_at).toISOString().slice(11, 19)}`
                );
            }
        }
    } catch (e) {
        console.log("Executions query:", e.message);
    }

    await pool.end();
    process.exit(0);
})();
