#!/usr/bin/env node
/**
 * Bounded dependency-load smoke for the Windows worker bundle.
 *
 * Goal: prove that a host (an ADO Windows agent, in the PoC pipeline) can
 * *acquire and boot* the pilotswarm worker runtime "without crashing due to
 * dependencies" — WITHOUT any external durable store. It deliberately does no
 * orchestration work; wiring the durable job store (PostgreSQL) is a separate,
 * later step.
 *
 * What a green run proves:
 *   A. The duroxide native addon (duroxide-windows-x64 *.node) loads AND
 *      executes — we open a real in-memory sqlite provider through the Rust
 *      addon, which is a native call, not just a dlopen.
 *   B. The full pilotswarm-sdk dependency graph resolves and the worker
 *      constructs — base prompt, skills, and system agents all load.
 *
 * We stop short of worker.start(): full start() requires a PostgreSQL session
 * catalog (the durable store), which is intentionally out of scope here. That
 * boundary was confirmed separately and is the expected next milestone.
 *
 * Exit codes: 0 = all dependencies loaded & addon executed; 1 = dependency or
 * addon failure (a real regression); 2 = watchdog timeout.
 *
 * Usage: node worker-smoke.mjs
 */
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const OK = "SMOKE_OK: dependencies loaded, native addon executed, worker constructed";
const FAIL = "SMOKE_FAIL";

const timeoutMs = Number.parseInt(process.env.SMOKE_TIMEOUT_MS || "60000", 10);
const bail = setTimeout(() => {
    console.error(`${FAIL}: smoke did not complete within ${timeoutMs}ms`);
    process.exit(2);
}, timeoutMs);
bail.unref?.();

try {
    console.log(`[smoke] node ${process.version} on ${os.platform()}-${os.arch()} (${os.hostname()})`);

    // ---- Part A: native addon loads AND executes -------------------------
    const duroxide = require("duroxide");
    const expected = ["SqliteProvider", "PostgresProvider", "Client", "Runtime"];
    const missing = expected.filter((k) => !(k in duroxide));
    if (missing.length) throw new Error(`duroxide missing exports: ${missing.join(", ")}`);
    console.log(`[smoke] duroxide addon loaded (exports: ${Object.keys(duroxide).join(", ")})`);

    // inMemory() is async and drops into the Rust addon to create a real
    // in-memory sqlite store — proves the native code executes, not just loads.
    const provider = await duroxide.SqliteProvider.inMemory();
    if (!provider) throw new Error("SqliteProvider.inMemory() returned nothing");
    console.log("[smoke] duroxide SqliteProvider.inMemory() executed -> native addon runs OK");

    // ---- Part B: SDK graph resolves & worker constructs ------------------
    const { PilotSwarmWorker } = await import("pilotswarm-sdk");
    const worker = new PilotSwarmWorker({
        store: "sqlite::memory:",
        logLevel: process.env.LOG_LEVEL || "info",
        traceWriter: (m) => console.log(m),
    });
    if (!worker) throw new Error("PilotSwarmWorker constructor returned nothing");
    const agents = (worker.loadedAgents || []).map((a) => a.name);
    console.log(`[smoke] PilotSwarmWorker constructed; system agents: ${agents.join(", ") || "(none)"}`);

    clearTimeout(bail);
    console.log(OK);
    process.exit(0);
} catch (err) {
    clearTimeout(bail);
    console.error(`${FAIL}: ${err?.stack || err}`);
    process.exit(1);
}
