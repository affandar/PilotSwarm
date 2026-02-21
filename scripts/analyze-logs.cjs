// Parse worker logs to analyze session affinity and movement
const fs = require("fs");
let raw = fs.readFileSync("/tmp/raw-logs.txt", "utf-8");

// Strip ANSI escape codes
raw = raw.replace(/\x1b\[[0-9;]*m/g, "");

const lines = raw.split("\n");
console.log("Total lines:", lines.length);
const actLines = lines.filter(l => l.includes("[activity]") && l.includes("worker_id="));
console.log("Activity dispatch lines:", actLines.length);

// Extract activity lines: session, worker_id, iteration, execution_id
const activities = [];
for (const line of lines) {
    if (!line.includes("[activity]") || !line.includes("worker_id=")) continue;
    const session = line.match(/session=([0-9a-f-]+)/)?.[1];
    const workerId = line.match(/worker_id=(\S+)/)?.[1];
    const iteration = line.match(/iteration=(\d+)/)?.[1];
    const executionId = line.match(/execution_id=(\d+)/)?.[1];
    const ts = line.match(/^(\S+)/)?.[1];
    if (session && workerId) {
        activities.push({
            session: session.slice(0, 8),
            fullSession: session,
            workerId: workerId.replace(/.*-worker-/, "w:").replace(/-rt-\d+$/, ""),
            workerFull: workerId,
            iteration: parseInt(iteration || "0"),
            executionId: parseInt(executionId || "0"),
            ts,
        });
    }
}

// Group by session
const bySession = {};
for (const a of activities) {
    if (!bySession[a.session]) bySession[a.session] = [];
    bySession[a.session].push(a);
}

console.log(`=== Session Affinity Analysis ===`);
console.log(`Total activity dispatches: ${activities.length}`);
console.log(`Unique sessions: ${Object.keys(bySession).length}\n`);

for (const [session, acts] of Object.entries(bySession)) {
    acts.sort((a, b) => a.iteration - b.iteration);
    const workers = new Set(acts.map((a) => a.workerId));
    const moved = workers.size > 1;

    console.log(
        `Session ${session}: ${acts.length} turns, ${workers.size} worker(s)${moved ? " ⚠️  MOVED" : " ✅ STICKY"}`
    );
    console.log(`  Workers: ${[...workers].join(", ")}`);

    if (moved) {
        // Show the movement pattern
        let prevWorker = "";
        for (const a of acts) {
            const marker = a.workerId !== prevWorker ? " ← SWITCH" : "";
            console.log(
                `    iter=${a.iteration} exec=${a.executionId} worker=${a.workerId}${marker}`
            );
            prevWorker = a.workerId;
        }
    }
    console.log();
}

// Also check hydration/dehydration events
const hydrations = lines.filter(
    (l) => l.includes("hydrat") || l.includes("dehydrat")
);
if (hydrations.length > 0) {
    console.log(`=== Hydration/Dehydration Events ===`);
    for (const h of hydrations) {
        console.log("  " + h.slice(0, 200));
    }
}
