const fs = require("fs");
const lines = fs.readFileSync("dumps/perf-trace.jsonl", "utf8").split("\n").filter(l => l.startsWith("{"));
const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

console.log(`Total entries: ${entries.length}`);
const tMin = Math.min(...entries.map(e => e.ts));
const tMax = Math.max(...entries.map(e => e.ts));
console.log(`Duration: ${((tMax - tMin) / 1000 / 60).toFixed(1)} minutes\n`);

// Group by op
const byOp = {};
for (const e of entries) {
    if (!byOp[e.op]) byOp[e.op] = { count: 0, totalDur: 0, maxDur: 0, durations: [] };
    byOp[e.op].count++;
    if (e.dur != null) {
        byOp[e.op].totalDur += e.dur;
        byOp[e.op].maxDur = Math.max(byOp[e.op].maxDur, e.dur);
        byOp[e.op].durations.push(e.dur);
    }
}

console.log("=== OPERATION SUMMARY (sorted by total time) ===");
console.log("Op".padEnd(35), "Count".padStart(7), "TotalMs".padStart(10), "AvgMs".padStart(8), "MaxMs".padStart(8), "P95Ms".padStart(8));
console.log("-".repeat(80));
const sorted = Object.entries(byOp).sort((a, b) => b[1].totalDur - a[1].totalDur);
for (const [op, stats] of sorted) {
    const d = stats.durations.sort((a, b) => a - b);
    const avg = d.length ? (stats.totalDur / d.length).toFixed(1) : "-";
    const p95 = d.length ? d[Math.floor(d.length * 0.95)]?.toFixed(1) : "-";
    console.log(op.padEnd(35), String(stats.count).padStart(7), stats.totalDur.toFixed(0).padStart(10), String(avg).padStart(8), stats.maxDur.toFixed(1).padStart(8), String(p95).padStart(8));
}

// screen.render frequency over time (buckets of 30s)
console.log("\n=== SCREEN.RENDER FREQUENCY (per 30s bucket) ===");
const renders = entries.filter(e => e.op === "screen.render");
if (renders.length > 0) {
    const bucketSize = 30000;
    const buckets = {};
    for (const r of renders) {
        const b = Math.floor((r.ts - tMin) / bucketSize);
        if (!buckets[b]) buckets[b] = { count: 0, totalMs: 0, maxMs: 0, avgMs: [] };
        buckets[b].count++;
        buckets[b].totalMs += r.dur || 0;
        buckets[b].maxMs = Math.max(buckets[b].maxMs, r.dur || 0);
        buckets[b].avgMs.push(r.avgMs || 0);
    }
    console.log("Time(s)".padStart(8), "Renders".padStart(8), "TotalMs".padStart(10), "MaxMs".padStart(8), "AvgMs".padStart(8));
    for (const [b, d] of Object.entries(buckets).sort((a, b) => +a[0] - +b[0])) {
        const t = +b * 30;
        const avg = d.avgMs.length ? d.avgMs[d.avgMs.length - 1].toFixed(1) : "-";
        console.log(String(t).padStart(8), String(d.count).padStart(8), d.totalMs.toFixed(0).padStart(10), d.maxMs.toFixed(1).padStart(8), String(avg).padStart(8));
    }
}

// Memory trend
console.log("\n=== MEMORY TREND (periodic_summary) ===");
const summaries = entries.filter(e => e.op === "periodic_summary");
if (summaries.length > 0) {
    console.log("Time".padStart(8), "HeapMB".padStart(8), "RssMB".padStart(8), "Buffers".padStart(8), "BufLines".padStart(9), "BufKB".padStart(8), "SeqEvts".padStart(8), "Obs".padStart(5), "Renders".padStart(8), "RndAvg".padStart(8));
    for (const s of summaries) {
        const t = ((s.ts - tMin) / 1000).toFixed(0);
        console.log(
            String(t).padStart(8),
            String(s.heapUsedMB).padStart(8),
            String(s.rssMB).padStart(8),
            String(s.chatBuffers).padStart(8),
            String(s.chatBufferLines).padStart(9),
            String(s.chatBufferKB).padStart(8),
            String(s.seqEvents).padStart(8),
            String(s.observers).padStart(5),
            String(s.renders).padStart(8),
            String(s.renderAvgMs).padStart(8),
        );
    }
}

// Top 20 slowest operations
console.log("\n=== TOP 20 SLOWEST INDIVIDUAL OPERATIONS ===");
const withDur = entries.filter(e => e.dur != null).sort((a, b) => b.dur - a.dur).slice(0, 20);
for (const e of withDur) {
    const t = ((e.ts - tMin) / 1000).toFixed(0);
    const meta = { ...e };
    delete meta.ts; delete meta.op; delete meta.dur;
    console.log(`  ${e.dur.toFixed(1).padStart(8)}ms  ${e.op.padEnd(30)}  t=${t}s  ${JSON.stringify(meta)}`);
}

// renderMarkdown trend — are individual calls getting slower?
console.log("\n=== RENDER MARKDOWN DURATION TREND ===");
const mdRenders = entries.filter(e => e.op === "renderMarkdown" && e.dur != null);
if (mdRenders.length > 0) {
    const bucketSize = 60000;
    const buckets = {};
    for (const r of mdRenders) {
        const b = Math.floor((r.ts - tMin) / bucketSize);
        if (!buckets[b]) buckets[b] = { count: 0, totalMs: 0, maxMs: 0, maxLen: 0 };
        buckets[b].count++;
        buckets[b].totalMs += r.dur;
        buckets[b].maxMs = Math.max(buckets[b].maxMs, r.dur);
        buckets[b].maxLen = Math.max(buckets[b].maxLen, r.len || 0);
    }
    console.log("Time(s)".padStart(8), "Count".padStart(7), "TotalMs".padStart(10), "MaxMs".padStart(8), "MaxLen".padStart(8));
    for (const [b, d] of Object.entries(buckets).sort((a, b) => +a[0] - +b[0])) {
        console.log(String(+b * 60).padStart(8), String(d.count).padStart(7), d.totalMs.toFixed(0).padStart(10), d.maxMs.toFixed(1).padStart(8), String(d.maxLen).padStart(8));
    }
}

// updateSessionListIcons frequency
console.log("\n=== updateSessionListIcons FREQUENCY (per 30s) ===");
const iconUpdates = entries.filter(e => e.op === "updateSessionListIcons");
if (iconUpdates.length > 0) {
    const bucketSize = 30000;
    const buckets = {};
    for (const r of iconUpdates) {
        const b = Math.floor((r.ts - tMin) / bucketSize);
        if (!buckets[b]) buckets[b] = { count: 0, totalMs: 0 };
        buckets[b].count++;
        buckets[b].totalMs += r.dur || 0;
    }
    console.log("Time(s)".padStart(8), "Calls".padStart(7), "TotalMs".padStart(10));
    for (const [b, d] of Object.entries(buckets).sort((a, b) => +a[0] - +b[0])) {
        console.log(String(+b * 30).padStart(8), String(d.count).padStart(7), d.totalMs.toFixed(0).padStart(10));
    }
}
